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
  udyam?: string; // Udyam / Udyog Aadhaar — a unique MSME business id (strong OSINT anchor)
  website?: string;
  name?: string;
  city?: string;
  industry?: string; // the product / mcat the buyer is sourcing — an extra disambiguating anchor
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
  crossValidation: CrossValidation; // P4 — the 1/2/3-source agreement ladder
}

// ── P4: Cross-validation (the agreement ladder) ───────────────────────────────
// THE confidence mechanism for observed sources. The same fact seen across MORE independent
// providers is MORE trustworthy — agreement IS the confidence. A fact corroborated by enough
// sources GRADUATES from observed → Verified (this is how World/OSINT earns its way off the
// observed-only bench without us hand-waving a score). Tiers: 1 source = observed, 2 =
// corroborated, 3+ = verified. Strict value match (no fuzzy) so a "verified" claim is honest.
export interface CrossFact {
  key: string;          // canonical attribute: name | company | city | email | pan
  value: string;        // the agreed display value
  sources: string[];    // independent providers asserting it (incl. 'first_party' seed)
  agreement: number;    // sources.length — this IS the confidence basis
  tier: 'observed' | 'corroborated' | 'verified';
  confidence: number;   // agreement-derived: 1→55 · 2→78 · 3+→92
}
export interface CrossValidation {
  facts: CrossFact[];
  verifiedFacts: CrossFact[]; // tier === 'verified' (≥3 independent sources agree)
  summary: string;
}

const xslug = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Field-name aliases each provider might use for the same attribute (defensive — providers differ).
const FACT_ALIASES: Record<string, string[]> = {
  name: ['name', 'full_name', 'fullName', 'customer_name', 'customerName'],
  company: ['company', 'company_name', 'companyName', 'business_name', 'businessName', 'firm', 'firm_name'],
  city: ['city', 'district'],
  email: ['email', 'email_id', 'emailId'],
  pan: ['pan', 'pan_number', 'panNumber'],
};
// Read a scalar by key from an object, looking one level into nested objects (Befisc `result`,
// Sign3 `phone_data`). Returns '' if absent or non-scalar.
function deepGet(obj: unknown, key: string): string {
  if (!obj || typeof obj !== 'object') return '';
  const o = obj as Record<string, unknown>;
  if (o[key] != null && typeof o[key] !== 'object') return String(o[key]);
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') {
      const inner = (v as Record<string, unknown>)[key];
      if (inner != null && typeof inner !== 'object') return String(inner);
    }
  }
  return '';
}
function extractFacts(source: ExtSourceResult, seed: ExternalSeed): Record<string, string> {
  const out: Record<string, string> = {};
  // World/OSINT independently CONFIRMS the business it was matched on (the seed company anchor).
  if (source.source === 'World') {
    if (source.status === 'ok' && seed.companyName) out.company = seed.companyName.trim();
    return out;
  }
  const v = source.value || {};
  for (const [key, aliases] of Object.entries(FACT_ALIASES)) {
    for (const a of aliases) {
      const got = deepGet(v, a).trim();
      if (got) { out[key] = got; break; }
    }
  }
  return out;
}

// Cross-validate the run's sources against each other AND against the first-party seed.
export function crossValidateExternal(sources: ExtSourceResult[], seed: ExternalSeed): CrossValidation {
  const providers: Array<{ provider: string; facts: Record<string, string> }> = [];
  // The first-party GLID profile is itself a provider (the anchor every external claim is checked against).
  const seedFacts: Record<string, string> = {};
  if (seed.name) seedFacts.name = seed.name.trim();
  if (seed.companyName) seedFacts.company = seed.companyName.trim();
  if (seed.city) seedFacts.city = seed.city.trim();
  providers.push({ provider: 'first_party', facts: seedFacts });
  for (const s of sources) {
    if (s.status !== 'ok') continue; // only sources that actually returned a record can corroborate
    providers.push({ provider: s.source, facts: extractFacts(s, seed) });
  }
  const map = new Map<string, { key: string; value: string; sources: Set<string> }>();
  const nameToks = (v: string) => v.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  for (const { provider, facts } of providers) {
    for (const [key, value] of Object.entries(facts)) {
      const nv = xslug(value);
      if (!nv) continue;
      // NAMES: variants that share a ≥3-char token are the SAME person (mirrors identity.ts N6) —
      // "Ashraffunnisa" ≡ "Ashraffunnisa Late Abdul". Merge into an existing name entry that shares a
      // token (it CORROBORATES, not duplicates), keeping the first (usually cleanest, first-party) label.
      if (key === 'name') {
        const toks = nameToks(value);
        let merged = false;
        for (const entry of map.values()) {
          if (entry.key !== 'name') continue;
          if (toks.some((t) => nameToks(entry.value).includes(t))) { entry.sources.add(provider); merged = true; break; }
        }
        if (!merged) map.set(`name::${nv}`, { key, value, sources: new Set([provider]) });
        continue;
      }
      const id = `${key}::${nv}`;
      if (!map.has(id)) map.set(id, { key, value, sources: new Set() });
      map.get(id)!.sources.add(provider);
    }
  }
  const facts: CrossFact[] = [...map.values()]
    .map((f) => {
      const agreement = f.sources.size;
      const tier: CrossFact['tier'] = agreement >= 3 ? 'verified' : agreement === 2 ? 'corroborated' : 'observed';
      const confidence = agreement >= 3 ? 92 : agreement === 2 ? 78 : 55;
      return { key: f.key, value: f.value, sources: [...f.sources], agreement, tier, confidence };
    })
    .sort((a, b) => b.agreement - a.agreement);
  const verifiedFacts = facts.filter((f) => f.tier === 'verified');
  const summary = facts.length ? facts.map((f) => `${f.key}=${f.value} [${f.agreement}× ${f.tier}]`).join(' · ') : 'no cross-source facts';
  return { facts, verifiedFacts, summary };
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

// THE gate. A web search needs a BUSINESS-SPECIFIC anchor set or it returns the WRONG entity.
// Rule (per the directive — "name + location is too broad" → it returns namesakes):
//   • a UNIQUE business id (GSTIN / Udyam / website) → eligible alone.
//   • otherwise eligible only with a BUSINESS SPECIFIER (company OR industry) PLUS a 2nd anchor —
//     so company+city, company+industry, name+industry, name+industry+city all qualify.
//   • name + location ALONE → NOT eligible (too broad — namesakes). A single anchor → NOT eligible.
//   • mobile is a contact, never a search anchor.
export function anchorStrength(seed: ExternalSeed): { osintEligible: boolean; strongest: string; reason: string } {
  if (seed.gstin && /^[0-9A-Z]{15}$/i.test(seed.gstin.trim()))
    return { osintEligible: true, strongest: 'GSTIN', reason: 'GSTIN is a unique business identifier' };
  if (seed.udyam && seed.udyam.trim().length >= 6)
    return { osintEligible: true, strongest: 'Udyam', reason: 'Udyam / Udyog-Aadhaar is a unique MSME identifier' };
  if (seed.website && /\./.test(seed.website))
    return { osintEligible: true, strongest: 'website', reason: 'a website resolves to exactly one business' };
  const has = {
    company: !!(seed.companyName && seed.companyName.trim().length >= 4),
    name: !!(seed.name && seed.name.trim().length >= 3),
    location: !!(seed.city && seed.city.trim().length >= 2),
    industry: !!(seed.industry && seed.industry.trim().length >= 3),
  };
  const anchors = (Object.keys(has) as Array<keyof typeof has>).filter((k) => has[k]);
  const hasSpecifier = has.company || has.industry; // a real business specifier — not bare name/location
  if (hasSpecifier && anchors.length >= 2)
    return { osintEligible: true, strongest: anchors.join('+'), reason: `${anchors.join(' + ')} together are specific enough to disambiguate` };
  const have = [...anchors, seed.mobile && 'mobile(contact-only)'].filter(Boolean).join('+') || 'nothing';
  return {
    osintEligible: false,
    strongest: have,
    reason: !hasSpecifier && has.name && has.location
      ? 'name + location alone is too broad (returns namesakes) — need a company / industry / GST / Udyam / website anchor'
      : anchors.length === 1
        ? `only one anchor (${anchors[0]}) — too thin to search without the wrong match`
        : 'only a mobile/first-name — too weak to search the open web without returning the wrong entity',
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);

// Befisc requires an explicit consent flag + text on every Profile-Advance call.
const BEFISC_CONSENT_TEXT =
  'We confirm obtaining valid customer consent to access/process their mobile data. Consent remains valid, informed, and unwithdrawn.';
// India mobile → last 10 digits (drops +91 / 0 / spaces) so the lookup APIs get a clean number.
const last10 = (m?: string): string => (m || '').replace(/\D/g, '').slice(-10);

// One Befisc/smartauth POST through the same-origin proxy (keys stay server-side once
// the proxy injects them; here we send the authkey header only if we have it client-side
// for a debug run). Never throws.
async function befiscCall(
  cfg: ExternalConfig,
  code: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<{ status: ExtStatus; data?: Record<string, unknown>; ms: number; detail?: string }> {
  const t0 = now();
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.befiscAuthkey) headers.authkey = cfg.befiscAuthkey;
    const r = await fetchImpl(`${cfg.proxyBase}/${code}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ consent: 'Y', consent_text: BEFISC_CONSENT_TEXT, ...body }),
    });
    const ms = Math.round(now() - t0);
    if (r.status === 401 || r.status === 402 || r.status === 403) return { status: 'blocked', ms };
    if (!r.ok) return { status: 'failed', ms };
    const j = (await r.json()) as { status?: number; message?: string; result?: Record<string, unknown> };
    // Befisc body status: 1=success · 2=no record · 3=invalid format · 4=name not found ·
    // 301=internal error · 302="Source down" · 401/402/403=auth/privilege/limit. ONLY 1 carries a
    // real record — everything else is a miss/outage, not "ok" (a 302 source-down was showing green).
    const sc = Number(j?.status);
    const msg = String(j?.message || '').trim();
    if (sc === 1) return { status: 'ok', data: (j.result as Record<string, unknown>) || {}, ms, detail: msg };
    if (sc === 2 || sc === 4) return { status: 'no_record', ms, detail: msg || (sc === 4 ? 'name not found' : 'no record found') };
    if (sc === 401 || sc === 402 || sc === 403) return { status: 'blocked', ms, detail: msg };
    return { status: 'failed', ms, detail: msg || `status ${sc}` }; // 3 / 301 / 302 source-down / unknown
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Send the Bearer only if we have it client-side (debug); otherwise the same-origin proxy injects it.
    if (cfg.sign3Bearer) headers.Authorization = `Bearer ${cfg.sign3Bearer}`;
    const r = await fetchImpl(cfg.sign3Endpoint!, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: mobile }), // Sign3 expects "phone", not "mobile"
    });
    const ms = Math.round(now() - t0);
    if (r.status === 401 || r.status === 403) return { status: 'blocked', ms };
    if (!r.ok) return { status: 'failed', ms };
    const data = (await r.json()) as Record<string, unknown>;
    // Sign3 success carries status:'SUCCESS' / status_code:2000 + a phone_data object.
    const ok = data?.status === 'SUCCESS' || Number(data?.status_code) === 2000 || !!data?.phone_data;
    return { status: ok ? 'ok' : 'no_record', data, ms };
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
  const sources: ExtSourceResult[] = [];
  const ledger: LedgerEntry[] = [];

  const mob10 = last10(seed.mobile); // from glusr_phone — last 10 digits

  // 1) Befisc Profile-Advance (mobile → identity/company) — Tier-2 observed. The authkey is
  // injected by the same-origin proxy (server-side), so we gate on the endpoint code only.
  if (mob10.length < 10) {
    sources.push({ source: 'Befisc', tier: 'observed', status: 'not_run', ms: 0, detail: seed.mobile ? 'mobile is not a 10-digit number' : 'no mobile in the seed' });
  } else if (!cfg.befiscProfileEndpoint) {
    sources.push({ source: 'Befisc', tier: 'observed', status: 'creds_pending', ms: 0, anchor: 'mobile', detail: 'set VITE_BEFISC_PROFILE_ENDPOINT (the proxy injects the authkey)' });
  } else {
    const r = await befiscCall(cfg, cfg.befiscProfileEndpoint, { mobile: mob10 }, fetchImpl);
    // Identity is Tier-2 OBSERVED — surfaced in the panel only, NEVER pushed to the
    // ledger/registry (the bridge would never record it anyway, but we keep it out by design).
    sources.push({ source: 'Befisc', tier: 'observed', status: r.status, ms: r.ms, anchor: `mobile ${mob10}`, value: r.data, detail: r.detail });
  }

  // 2) Sign3 Persona (mobile → digital footprint / social presence / breaches) — Tier-2 observed.
  // Bearer injected by the proxy server-side → gate on the endpoint only.
  if (mob10.length < 10) {
    sources.push({ source: 'Sign3', tier: 'observed', status: 'not_run', ms: 0, detail: seed.mobile ? 'mobile is not a 10-digit number' : 'no mobile in the seed' });
  } else if (!cfg.sign3Endpoint) {
    sources.push({ source: 'Sign3', tier: 'observed', status: 'creds_pending', ms: 0, anchor: 'mobile', detail: 'set VITE_SIGN3_ENDPOINT (the proxy injects the bearer)' });
  } else {
    const r = await sign3Call(cfg, mob10, fetchImpl);
    sources.push({ source: 'Sign3', tier: 'observed', status: r.status, ms: r.ms, anchor: `mobile ${mob10}`, value: r.data });
  }

  // 3) World / OSINT web search — Tier-1 → Verified. GATED on the permutation rule. We RE-GATE here
  // using anchors Befisc just gave us (name/city often arrive ONLY from Befisc) + the product industry,
  // so a buyer who looked too thin at pull-time becomes searchable once enriched.
  const befiscVal = (sources.find((s) => s.source === 'Befisc' && s.status === 'ok')?.value || {}) as Record<string, unknown>;
  const pi = (befiscVal.personal_information || {}) as Record<string, unknown>;
  const befName = String(befiscVal.name || befiscVal.full_name || pi.name || pi.full_name || '').trim();
  // Befisc `address` is an array of { detailed_address, state(code), city, pincode } — the full state
  // NAME lives inside detailed_address. Concatenate them and pull the state name; fall back to city.
  const addrArr = Array.isArray(befiscVal.address) ? (befiscVal.address as Array<Record<string, unknown>>) : [];
  const addrStr = addrArr.map((a) => String((a || {}).detailed_address || '')).join(' ') || String(befiscVal.address || '');
  const stateM = addrStr.match(/\b(Andhra Pradesh|Arunachal Pradesh|Assam|Bihar|Chhattisgarh|Goa|Gujarat|Haryana|Himachal Pradesh|Jharkhand|Karnataka|Kerala|Madhya Pradesh|Maharashtra|Manipur|Meghalaya|Mizoram|Nagaland|Odisha|Punjab|Rajasthan|Sikkim|Tamil Nadu|Telangana|Tripura|Uttar Pradesh|Uttarakhand|West Bengal|Delhi|Jammu|Ladakh|Puducherry|Chandigarh)\b/i);
  const befCity = (addrArr.map((a) => String((a || {}).city || '').trim()).find(Boolean)) || (stateM ? stateM[1] : '');
  const worldSeed: ExternalSeed = { ...seed, name: seed.name || befName || undefined, city: seed.city || befCity || undefined };
  const gateW = anchorStrength(worldSeed);
  if (!gateW.osintEligible) {
    sources.push({ source: 'World', tier: 'verified', status: 'skipped_low_confidence', ms: 0, anchor: gateW.strongest, detail: gateW.reason });
  } else if (!opts.osintFn) {
    sources.push({ source: 'World', tier: 'verified', status: 'not_run', ms: 0, anchor: gateW.strongest, detail: 'eligible — no web-search provider wired (Claude/sandbox injects osintFn)' });
  } else {
    const t0 = now();
    try {
      const o = await opts.osintFn(worldSeed);
      const ms = Math.round(now() - t0);
      const matchBasis = o.match_basis || (gateW.strongest === 'GSTIN' ? ['gst'] : gateW.strongest === 'website' ? ['website'] : worldSeed.city ? ['company_name', 'location'] : ['company_name']);
      const conf = typeof o.confidence === 'number' ? o.confidence : osintMatchConfidence(matchBasis);
      const found = !!(o.summary || (o.productLines && o.productLines.length) || (o.sourceUrls && o.sourceUrls.length));
      sources.push({ source: 'World', tier: 'verified', status: found ? 'ok' : 'no_record', ms, anchor: gateW.strongest, value: o as Record<string, unknown>, confidence: conf });
      if (found) ledger.push({ source: 'OSINT', key_used: gateW.strongest, confidence: conf, fetched_at: opts.nowIso, raw_value: o.summary, value_summary: o.summary });
    } catch {
      sources.push({ source: 'World', tier: 'verified', status: 'failed', ms: Math.round(now() - t0), anchor: gateW.strongest });
    }
  }

  // P4 — cross-validate everything that returned a record against the first-party seed.
  const crossValidation = crossValidateExternal(sources, seed);
  return { sources, externalEvidenceLedger: ledger, ranAt: opts.nowIso, seed, gate: gateW, crossValidation };
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

// ── REAL World/OSINT via Firecrawl web search (POST /v2/search) ───────────────────────────────
// A genuine web search — returns TRACEABLE source URLs, never a fabricated profile (unlike an LLM
// guess). The Firecrawl key is injected server-side by the Vite proxy (/api/firecrawl), so it never
// ships to the client. Gated upstream by anchorStrength (≥2 anchors). Builds a business-oriented query
// from the seed (company/name + location + industry) and maps the top results into a WorldOsint.
export async function firecrawlOsint(seed: ExternalSeed, fetchImpl: typeof fetch = fetch): Promise<WorldOsint> {
  // Lead with the strongest descriptive anchors. A bare website resolves the business directly; else
  // company/name + location + industry. (GST/Udyam gate eligibility but aren't good free-text terms.)
  const query = [seed.website, seed.companyName || seed.name, seed.city, seed.industry].map((x) => (x || '').trim()).filter(Boolean).join(' ');
  if (query.length < 4) return {};
  try {
    const r = await fetchImpl('/api/firecrawl/v2/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 5 }),
    });
    if (!r.ok) return {};
    const j = (await r.json()) as { success?: boolean; data?: { web?: Array<{ url?: string; title?: string; description?: string }> } };
    const results = j?.data?.web || [];
    if (!results.length) return {};
    const urls = results.map((x) => x.url).filter((u): u is string => !!u).slice(0, 5);
    const top = results[0];
    const summary = [top?.title, top?.description].filter(Boolean).join(' — ').slice(0, 240);
    // a result on a B2B marketplace / directory ⇒ the buyer (or a namesake) has a live catalog presence.
    const isAlsoSeller = results.some((x) => /indiamart|tradeindia|justdial|exportersindia|alibaba|dial4trade|sulekha/i.test(x.url || ''));
    const matchBasis = [seed.companyName && 'company_name', seed.name && 'name', seed.city && 'location', seed.industry && 'industry'].filter(Boolean) as string[];
    return { summary, productLines: [], isAlsoSeller, sourceUrls: urls, match_basis: matchBasis, confidence: osintMatchConfidence(matchBasis) };
  } catch {
    return {};
  }
}
