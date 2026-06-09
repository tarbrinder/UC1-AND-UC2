// ─── External enrichment RUNNER (live, debug) ─────────────────────────────────
// Orchestrates the buyer's OUTSIDE-world pull from a seed (mobile/company/GST/name):
//   • Befisc Profile-Advance  (mobile → identity / company)        [Tier-2 · observed]
//   • Sign3                    (mobile → identity / social)         [Tier-2 · observed]
//   • World / OSINT web search (company/GST/website → business)     [Tier-1 → Verified]
// The mobile→GST→HSN chain is DEFERRED on purpose (Part C endpoint codes) — not run here.
//
// ── THE ANTI-BOGUS RULE (the whole point of the web step) ─────────────────────
// A web search only runs when the seed has a HIGH-CONFIDENCE anchor — a GSTIN, a
// website, or a real company name (optionally + city). A bare mobile or a common
// first name is NOT enough: searching it returns the WRONG company/person, so the
// OSINT step is SKIPPED with status 'skipped_low_confidence' instead of guessing.
// "such that bogus data is not returned."
//
// Befisc/Sign3 need a server-side proxy + keys (CORS + key secrecy → Part C). Until
// configured, each is reported as 'creds_pending' — the path is fully wired and runs
// the moment the keys/endpoints land. NOTHING here blocks the form; it only adds to
// the debug ledger + (Tier-1 only) the Coverage Registry via window.__ebi.

import type { WorldOsint, ExternalEvidenceEntry } from './worldEnrichment';
import { osintMatchConfidence } from './worldEnrichment';

export type ExtStatus =
  | 'ok' // returned a record
  | 'no_record' // ran, nothing found
  | 'failed' // network/parse error
  | 'creds_pending' // path wired, keys/endpoint not configured yet (Part C)
  | 'skipped_low_confidence' // anti-bogus gate: no strong anchor to search on
  | 'not_run' // not attempted (e.g. no search provider wired)
  | 'blocked'; // creds present but rejected (auth/quota)

export interface ExtSourceResult {
  source: 'Befisc' | 'Sign3' | 'World';
  tier: 'observed' | 'verified';
  status: ExtStatus;
  ms: number;
  anchor?: string; // what key the lookup hinged on (mobile / company_name / GSTIN…)
  detail?: string; // human reason / note
  value?: Record<string, unknown>;
  confidence?: number;
}
export interface ExternalSeed {
  mobile?: string;
  companyName?: string;
  gstin?: string;
  website?: string;
  name?: string;
  city?: string;
  glid?: string;
}
// The ledger feeds the dossier + the registry bridge; only TIER-1 (OSINT/GST/…) entries
// there are recorded as 'Verified'. `value_summary` is what those consumers read.
export type LedgerEntry = ExternalEvidenceEntry & { value_summary?: string };
export interface ExternalRunResult {
  sources: ExtSourceResult[];
  externalEvidenceLedger: LedgerEntry[]; // shape consumed by RFQModalV3 + the registry bridge
  ranAt: string;
  seed: ExternalSeed;
  gate: { osintEligible: boolean; strongest: string; reason: string };
}

export interface ExternalConfig {
  befiscAuthkey?: string;
  befiscProfileEndpoint?: string; // smartauth code, e.g. 'C9S1' (Profile-Advance)
  sign3Endpoint?: string; // full URL or path under proxyBase
  sign3Bearer?: string;
  proxyBase?: string; // e.g. '/api/smartauth' — same-origin dev proxy to dodge CORS + hide keys
}

// Creds/endpoints come from env (Vite) — NEVER hardcoded in source. Part C wires these.
export function getExternalConfig(): ExternalConfig {
  const e = ((import.meta as unknown as { env?: Record<string, string> }).env) || {};
  return {
    befiscAuthkey: e.VITE_BEFISC_AUTHKEY,
    befiscProfileEndpoint: e.VITE_BEFISC_PROFILE_ENDPOINT,
    sign3Endpoint: e.VITE_SIGN3_ENDPOINT,
    sign3Bearer: e.VITE_SIGN3_BEARER,
    proxyBase: e.VITE_EXTERNAL_PROXY_BASE || '/api/smartauth',
  };
}

// THE gate. A web search needs a UNIQUE business anchor or it returns the wrong entity.
export function anchorStrength(seed: ExternalSeed): { osintEligible: boolean; strongest: string; reason: string } {
  if (seed.gstin && /^[0-9A-Z]{15}$/i.test(seed.gstin.trim()))
    return { osintEligible: true, strongest: 'GSTIN', reason: 'GSTIN is a unique business identifier' };
  if (seed.website && /\./.test(seed.website))
    return { osintEligible: true, strongest: 'website', reason: 'a website resolves to exactly one business' };
  // A company name ALONE is too generic ("M Enterprises" → dozens of cities) — require company + city
  // before the open web is searched, else a match is likely the WRONG business. GSTIN/website above
  // are unique anchors and don't need a city.
  if (seed.companyName && seed.companyName.trim().length >= 4 && seed.city && seed.city.trim())
    return { osintEligible: true, strongest: 'company_name', reason: 'company name + city is specific enough' };
  const have = [seed.mobile && 'mobile', seed.name && 'name', seed.companyName && 'company(no city)', seed.city && 'city'].filter(Boolean).join('+') || 'nothing';
  return {
    osintEligible: false,
    strongest: have,
    reason: seed.companyName
      ? 'company name without a city is too generic — could match the wrong business'
      : 'only a mobile/first-name — too weak to search the open web without returning the wrong company',
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);

// One Befisc/smartauth POST through the same-origin proxy (keys stay server-side once
// the proxy injects them; here we send the authkey header only if we have it client-side
// for a debug run). Never throws.
async function befiscCall(
  cfg: ExternalConfig,
  code: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<{ status: ExtStatus; data?: Record<string, unknown>; ms: number }> {
  const t0 = now();
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.befiscAuthkey) headers.authkey = cfg.befiscAuthkey;
    const r = await fetchImpl(`${cfg.proxyBase}/${code}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ consent: 'Y', ...body }),
    });
    const ms = Math.round(now() - t0);
    if (r.status === 401 || r.status === 402 || r.status === 403) return { status: 'blocked', ms };
    if (!r.ok) return { status: 'failed', ms };
    const j = (await r.json()) as { status?: number; result?: Record<string, unknown>; data?: Record<string, unknown> };
    const sc = Number(j?.status);
    if (sc === 2 || sc === 3) return { status: 'no_record', ms };
    const data = (j.result || j.data || j) as Record<string, unknown>;
    return { status: 'ok', data, ms };
  } catch {
    return { status: 'failed', ms: Math.round(now() - t0) };
  }
}

async function sign3Call(
  cfg: ExternalConfig,
  mobile: string,
  fetchImpl: typeof fetch
): Promise<{ status: ExtStatus; data?: Record<string, unknown>; ms: number }> {
  const t0 = now();
  try {
    const r = await fetchImpl(cfg.sign3Endpoint!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.sign3Bearer}` },
      body: JSON.stringify({ mobile }),
    });
    const ms = Math.round(now() - t0);
    if (r.status === 401 || r.status === 403) return { status: 'blocked', ms };
    if (!r.ok) return { status: 'failed', ms };
    const data = (await r.json()) as Record<string, unknown>;
    return { status: data && Object.keys(data).length ? 'ok' : 'no_record', data, ms };
  } catch {
    return { status: 'failed', ms: Math.round(now() - t0) };
  }
}

// Orchestrate the three pulls. `osintFn` is INJECTED (Claude/WebSearch-backed in the
// demo, a backend search in prod) so this module stays I/O-agnostic. The gate decides
// whether OSINT is even attempted.
export async function runExternal(
  seed: ExternalSeed,
  opts: { config?: ExternalConfig; osintFn?: (seed: ExternalSeed) => Promise<WorldOsint>; nowIso: string; fetchImpl?: typeof fetch } = { nowIso: '' }
): Promise<ExternalRunResult> {
  const cfg = opts.config || getExternalConfig();
  const fetchImpl = opts.fetchImpl || fetch;
  const gate = anchorStrength(seed);
  const sources: ExtSourceResult[] = [];
  const ledger: LedgerEntry[] = [];

  // 1) Befisc Profile-Advance (mobile → identity/company) — Tier-2 observed.
  if (!seed.mobile) {
    sources.push({ source: 'Befisc', tier: 'observed', status: 'not_run', ms: 0, detail: 'no mobile in the seed' });
  } else if (!(cfg.befiscAuthkey && cfg.befiscProfileEndpoint)) {
    sources.push({ source: 'Befisc', tier: 'observed', status: 'creds_pending', ms: 0, anchor: 'mobile', detail: 'set VITE_BEFISC_AUTHKEY + VITE_BEFISC_PROFILE_ENDPOINT (Part C)' });
  } else {
    const r = await befiscCall(cfg, cfg.befiscProfileEndpoint, { mobile: seed.mobile }, fetchImpl);
    // Identity is Tier-2 OBSERVED — surfaced in the panel only, NEVER pushed to the
    // ledger/registry (the bridge would never record it anyway, but we keep it out by design).
    sources.push({ source: 'Befisc', tier: 'observed', status: r.status, ms: r.ms, anchor: 'mobile', value: r.data });
  }

  // 2) Sign3 (mobile → identity/social) — Tier-2 observed.
  if (!seed.mobile) {
    sources.push({ source: 'Sign3', tier: 'observed', status: 'not_run', ms: 0, detail: 'no mobile in the seed' });
  } else if (!(cfg.sign3Bearer && cfg.sign3Endpoint)) {
    sources.push({ source: 'Sign3', tier: 'observed', status: 'creds_pending', ms: 0, anchor: 'mobile', detail: 'set VITE_SIGN3_ENDPOINT + VITE_SIGN3_BEARER (Part C)' });
  } else {
    const r = await sign3Call(cfg, seed.mobile, fetchImpl);
    sources.push({ source: 'Sign3', tier: 'observed', status: r.status, ms: r.ms, anchor: 'mobile', value: r.data });
  }

  // 3) World / OSINT web search — Tier-1 → Verified. GATED on a strong anchor.
  if (!gate.osintEligible) {
    sources.push({ source: 'World', tier: 'verified', status: 'skipped_low_confidence', ms: 0, anchor: gate.strongest, detail: gate.reason });
  } else if (!opts.osintFn) {
    sources.push({ source: 'World', tier: 'verified', status: 'not_run', ms: 0, anchor: gate.strongest, detail: 'eligible — no web-search provider wired (Claude/sandbox injects osintFn)' });
  } else {
    const t0 = now();
    try {
      const o = await opts.osintFn(seed);
      const ms = Math.round(now() - t0);
      const matchBasis = o.match_basis || (gate.strongest === 'GSTIN' ? ['gst'] : gate.strongest === 'website' ? ['website'] : seed.city ? ['company_name', 'location'] : ['company_name']);
      const conf = typeof o.confidence === 'number' ? o.confidence : osintMatchConfidence(matchBasis);
      const found = !!(o.summary || (o.productLines && o.productLines.length) || (o.sourceUrls && o.sourceUrls.length));
      sources.push({ source: 'World', tier: 'verified', status: found ? 'ok' : 'no_record', ms, anchor: gate.strongest, value: o as Record<string, unknown>, confidence: conf });
      if (found) ledger.push({ source: 'OSINT', key_used: gate.strongest, confidence: conf, fetched_at: opts.nowIso, raw_value: o.summary, value_summary: o.summary });
    } catch {
      sources.push({ source: 'World', tier: 'verified', status: 'failed', ms: Math.round(now() - t0), anchor: gate.strongest });
    }
  }

  return { sources, externalEvidenceLedger: ledger, ranAt: opts.nowIso, seed, gate };
}

// ── DEMO / synthetic OSINT provider ─────────────────────────────────────────
// Lets you SEE the World→Verified→Twin stitch end-to-end WITHOUT a real web-search backend and
// WITHOUT compiling any real person's footprint. It returns a representative BUSINESS profile from
// the seed's company anchor only (clearly tagged [DEMO]); it never fabricates a specific company.
// It mirrors the anti-bogus bar — a weak anchor (no company / <4 chars) returns nothing, exactly as
// a real provider should. For LIVE data, set window.__osintProvider to a real WebSearch/backend
// provider of the same (seed) => WorldOsint shape; runExternal consumes it identically.
export async function osintDemoProvider(seed: ExternalSeed): Promise<WorldOsint> {
  const co = (seed.companyName || '').trim();
  if (co.length < 4) return {}; // anti-bogus: never guess off a weak anchor
  const city = (seed.city || '').trim();
  const matchBasis = ['company_name', seed.city ? 'city' : ''].filter(Boolean);
  return {
    summary: `[DEMO] ${co}${city ? `, ${city}` : ''} — registered business; representative public profile (synthetic OSINT — wire window.__osintProvider to a real backend for live data).`,
    productLines: ['[DEMO] representative product line'],
    isAlsoSeller: false,
    sourceUrls: [`demo://osint/${encodeURIComponent(co)}`],
    match_basis: matchBasis,
    confidence: osintMatchConfidence(matchBasis),
  };
}
