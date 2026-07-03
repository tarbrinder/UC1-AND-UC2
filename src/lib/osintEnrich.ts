// ─── OSINT WEB ENRICHMENT (frontend-only · observed-only · LOW-confidence · SEGREGATED) ──────────────────────
// The buyer's OUTSIDE-world footprint via Firecrawl web search. Runs ONLY in the frontend Web-verify band (NEVER
// the n8n sync pull — V10 lock) and NEVER feeds the extract twin / profile. A signal graduates into the profile
// ONLY when it corroborates a Tier-1 fact (cross-validation ladder, handled elsewhere) — so the profile is never
// polluted with low-confidence web guesses. We fire a QUERY MATRIX (name+location, company+location+industry,
// mobile, GSTIN, PAN, website, site-scoped LinkedIn/FB/Insta/JustDial/IndiaMART/TradeIndia/Meesho), dedupe results
// by URL, then ask the LLM to extract SPECIFIC grounded signals (each cited to a source URL). Raw output is shown
// verbatim in the band. Firecrawl key is server-side (Vite /api/firecrawl proxy); LLM uses the IndiaMART 2.5-flash key.

import { osintSignalsLLM } from './gemini';

export interface OsintSeed {
  glid?: string; name?: string; company?: string; legalName?: string;
  city?: string; state?: string; mobile?: string; gstin?: string; pan?: string; website?: string; industry?: string;
}
export interface OsintQuery { q: string; anchor: string; platform?: string }
export interface OsintRawResult { url: string; title?: string; description?: string; platform: string; viaAnchors: string[] }
export interface OsintSignal { signal_type: string; value: string; confidence: number; source_url: string; platform: string }
export interface OsintEnrichment {
  status: 'idle' | 'running' | 'done' | 'failed' | 'no-anchor';
  queries: OsintQuery[]; results: OsintRawResult[]; signals: OsintSignal[];
  ms?: number; error?: string; note?: string;
}

// classify a URL → platform (drives the readable grouping; never used as a trust input)
export function osintPlatform(url: string): string {
  const u = (url || '').toLowerCase();
  if (/linkedin\.com/.test(u)) return 'LinkedIn';
  if (/facebook\.com|fb\.com/.test(u)) return 'Facebook';
  if (/instagram\.com/.test(u)) return 'Instagram';
  if (/justdial\.com/.test(u)) return 'JustDial';
  if (/indiamart\.com/.test(u)) return 'IndiaMART';
  if (/tradeindia\.com|exportersindia\.com|dial4trade/.test(u)) return 'B2B directory';
  if (/meesho\.com|amazon\.|flipkart\.com/.test(u)) return 'Marketplace (seller)';
  if (/knowyourgst|mastersindia|thecompanycheck|zaubacorp|tofler/.test(u)) return 'Registry/GST';
  if (/sulekha\.com/.test(u)) return 'Sulekha';
  return 'Web';
}

// THE query matrix — clubs Profile + Befisc + Sign3 + GST anchors into multiple business-oriented searches.
// Low-confidence by design (this is OSINT) — breadth over precision; the LLM + cross-validation ladder gate trust.
export function buildOsintQueries(seed: OsintSeed): OsintQuery[] {
  const qs: OsintQuery[] = [];
  const loc = [seed.city, seed.state].filter(Boolean).join(' ').trim();
  const company = (seed.legalName || seed.company || '').trim();
  const subject = company || (seed.name || '').trim();
  const add = (q: string, anchor: string, platform?: string) => { const t = q.replace(/\s+/g, ' ').trim(); if (t.length >= 4) qs.push({ q: t, anchor, platform }); };
  if (company) add([company, loc, seed.industry].filter(Boolean).join(' '), 'company + location + industry');
  if (seed.name) add([seed.name, loc].filter(Boolean).join(' '), 'name + location');
  if (seed.mobile) add(seed.mobile, 'mobile number');
  if (seed.gstin) add(seed.gstin, 'GSTIN');
  if (seed.pan) add(`${seed.pan} GST`, 'PAN → GST corroboration');
  if (seed.website) add(seed.website, 'website');
  // site-scoped — surface the platform-specific presence (social + B2B directories + marketplaces)
  if (subject) for (const site of ['linkedin.com', 'facebook.com', 'instagram.com', 'justdial.com', 'indiamart.com', 'tradeindia.com', 'meesho.com']) {
    add([subject, loc, `site:${site}`].filter(Boolean).join(' '), `site:${site}`, site.split('.')[0]);
  }
  // dedupe by query string
  const seen = new Set<string>();
  return qs.filter((x) => { const k = x.q.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function firecrawlSearch(query: string, fetchImpl: typeof fetch): Promise<Array<{ url?: string; title?: string; description?: string }>> {
  const r = await fetchImpl('/api/firecrawl/v2/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: 5, scrapeOptions: { onlyMainContent: true, maxAge: 172800000 } }),
  }).catch(() => null);
  if (!r || !r.ok) return [];
  const j = (await r.json().catch(() => ({}))) as { data?: { web?: Array<{ url?: string; title?: string; description?: string }> } };
  return j?.data?.web || [];
}

// Fire the whole matrix, dedupe by URL (tracking which anchors hit it), then LLM-extract specific grounded signals.
export async function runOsintEnrichment(
  seed: OsintSeed,
  opts?: { fetchImpl?: typeof fetch; onTick?: (done: number, total: number) => void },
): Promise<OsintEnrichment> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const queries = buildOsintQueries(seed);
  if (!queries.length) return { status: 'no-anchor', queries: [], results: [], signals: [], note: 'no searchable anchor on this buyer (need a name/company/mobile/GST/PAN)' };
  const t0 = Date.now();
  const byUrl = new Map<string, OsintRawResult>();
  let done = 0;
  for (const query of queries) {
    opts?.onTick?.(++done, queries.length);
    const rows = await firecrawlSearch(query.q, fetchImpl);
    for (const row of rows) {
      const url = (row.url || '').trim();
      if (!url) continue;
      const ex = byUrl.get(url);
      if (ex) { if (!ex.viaAnchors.includes(query.anchor)) ex.viaAnchors.push(query.anchor); }
      else byUrl.set(url, { url, title: row.title, description: row.description, platform: osintPlatform(url), viaAnchors: [query.anchor] });
    }
  }
  const results = [...byUrl.values()];
  let signals: OsintSignal[] = [];
  if (results.length) {
    try { const out = await osintSignalsLLM(seed, results); signals = Array.isArray(out?.signals) ? out.signals : []; }
    catch { signals = []; }
  }
  return { status: 'done', queries, results, signals, ms: Date.now() - t0 };
}
