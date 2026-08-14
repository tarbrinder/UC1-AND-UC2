// ─── Dynamic RFQ — data layer (leaf webhooks + spec APIs) ─────────────────────
// Every fetch is failure-tolerant: it resolves to null on error/timeout so a
// "no blocker" source can never hang the flow. The monolith bi-requirement-brain
// is deliberately NOT used here — Page 0 hits the leaf webhooks directly (they are
// ~2–3s each, vs 55–180s for the monolith).
import { api, getJSON, postJSON } from '../api';
import { fetchCategoryTopSpecs } from '../enrichment';
import { parseEnquiries, type Enquiry } from './enquiryParse';
export type { Enquiry } from './enquiryParse';

const HOOK = (path: string, glid: string, extra = '') =>
  api(`/api/imworkflow/webhook/${path}?glid=${encodeURIComponent(glid)}${extra}`);

// safe() used to swallow the error object entirely, so a failed leaf had no status code or message ANYWHERE — the
// inspector could say "empty/err" but never which. The last error per source is now retained (message + any status
// the transport attached) purely for telemetry; the return contract is unchanged (null on failure).
const LAST_ERR: Record<string, { message: string; status?: number }> = {};
async function safe<T>(p: Promise<T>, tag?: string): Promise<T | null> {
  try { return await p; } catch (e) {
    if (tag) {
      const err = e as { message?: string; status?: number; response?: { status?: number } };
      LAST_ERR[tag] = { message: String(err?.message ?? e ?? 'unknown error').slice(0, 300), status: err?.status ?? err?.response?.status };
    }
    return null;
  }
}
export const getSourceError = (tag: string) => LAST_ERR[tag];
// GREEN-ON-EMPTY (fix 2026-08-01): `ok: d != null` counted [], {} and "" as a healthy source, so the panel showed a
// green dot for a webhook that returned nothing. A source is only healthy if it came back AND carried something.
export const hasPayload = (v: unknown): boolean => {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
};

// ── AI Inspector telemetry (plan §6): Raw → Cleaned → Latency, per source ────────────────────────────────────
// Records the RAW response, the CLEANED/parsed result, and the round-trip ms for each leaf fetch so the AI-Debug
// inspector can show "what came back · what we made of it · how long it took" per source. Mirrored to window for
// the panel + console. (Date.now is fine in app code — only Workflow scripts lack it.)
export interface SourceHealthRec { source: string; ok: boolean; ms: number; at: number; raw: unknown; cleaned: unknown; }
const SOURCE_HEALTH: Record<string, SourceHealthRec> = {};
export function recordSource(source: string, rec: { ok: boolean; ms: number; raw: unknown; cleaned: unknown }): void {
  SOURCE_HEALTH[source] = { source, at: Date.now(), ...rec };
  try { (globalThis as unknown as { __sourceHealth?: Record<string, SourceHealthRec> }).__sourceHealth = SOURCE_HEALTH; } catch { /* noop */ }
}
export const getSourceHealth = (): SourceHealthRec[] => Object.values(SOURCE_HEALTH).sort((a, b) => a.at - b.at);
/** Clear all recorded source health — called once per GLID pull (BrainFormGate.load) so the AI-Debug Sources panel
 *  shows ONLY the current pull's sources. Without this, SOURCE_HEALTH (a module global) accumulated across GLID
 *  reloads and PNS-mode switches, which is why PNS showed TWICE (api + full) and the "N/6 sources" denominator crept. */
export function resetSourceHealth(): void {
  for (const k of Object.keys(SOURCE_HEALTH)) delete SOURCE_HEALTH[k];
  try { (globalThis as unknown as { __sourceHealth?: Record<string, SourceHealthRec> }).__sourceHealth = SOURCE_HEALTH; } catch { /* noop */ }
}

// ─── C16 · NAMING (2026-08-03) ────────────────────────────────────────────────────────────────────────────────────
// THREE different things in this estate were all called "PNS", and TWO were called "WhatsApp". That ambiguity is not
// cosmetic — it caused a real mis-analysis during the 2026-08-02 audit. The canonical names, use them in new code:
//
//   category_call_insights     — calls aggregated at MCAT level (Redash 13521 → `bi-category-brain`). Market truth.
//                                Feeds LLM 2 ONLY. Owner-locked: never an LLM 1 input.
//   buyer_call_insights_api    — THIS buyer's calls, fast API (`bi-pns-insights`, mode `api`). GLID-only, all
//                                categories. Known to under-return: 6/12 buyers gave 0 rows against non-zero
//                                profile counters, hence the contradiction alarm in fetchPnsInsights.
//   buyer_call_transcripts_full— the same analysis over ALL of the buyer's calls (audio → transcript). Coverage, not
//                                depth. Lives behind `bi-transcribe`; NOT reachable from the api path.
//   vani_bot_calls             — the 9696 inbound bot. Frequently NOT about the requirement, so it must inform
//                                PERSONA only and never requirement extraction (hallucination risk).
//
//   WhatsApp has two ORTHOGONAL axes, and conflating them loses a third of the buyer's voice:
//     `channel` = which THREAD          — `inbound` (user-initiated, incl. a "get price" CTA) | `outbound` (paid push)
//     `sender`  = who SPOKE in it       — `buyer` | `ours`
//   Measured over 12 buyers: buyer 107 turns vs ours 305, and 31 of the buyer's 107 turns sit inside OUTBOUND
//   threads. Filtering on `channel === 'inbound'` therefore discards 29% of everything the buyer ever said.
//   Classify intent by `sender`; treat `channel` as context. `kind` is the fidelity tier:
//     isq_answer (a named-ISQ answer, strongest) > button_tap > free_text > caption (usually ours — context, never intent)
//
// ── Landing truth (Page 0) ────────────────────────────────────────────────────
// browse_location (task #78): the geo-IP browse city + searched/targeted cities. hydrateLocationSignals reads it as
// node_raw.csl.browse_location to drive the name+location gate's city-conflict — but it was only ever inside `raw`, so
// the reconstructed node_raw (BrainFormGate) never carried it and the gate was ~0%. Surface it as a first-class field.
export interface CslResult { viewed_products: ViewedProduct[]; searches: string[]; browse_location?: unknown; raw: unknown; }
export interface ViewedProduct { name: string; mcat?: string; image?: string; specs?: { name: string; value: string }[]; }

export async function fetchCsl(glid: string, timeoutMs = 60000): Promise<CslResult | null> {
  const t0 = Date.now();
  const d = await safe(getJSON<Record<string, unknown>>(HOOK('bi-csl-parser', glid), undefined, timeoutMs));
  if (!d) { recordSource('CSL · bi-csl-parser', { ok: false, ms: Date.now() - t0, raw: null, cleaned: null }); return null; }
  const base = (Array.isArray(d) ? d[0] : d) as { summary?: Record<string, unknown> } | undefined;
  const s = base?.summary ?? {};   // guard: an empty-array [] response left d[0] undefined → `.summary` threw OUTSIDE safe()
  const vp = (Array.isArray(s.viewed_products) ? s.viewed_products : []) as Array<Record<string, unknown>>;
  const result: CslResult = {
    viewed_products: vp.map((v) => ({
      name: String(v.name ?? ''), mcat: v.mcat != null ? String(v.mcat) : undefined,
      image: typeof v.image === 'string' ? v.image : undefined,
      specs: Array.isArray(v.specs) ? (v.specs as Array<Record<string, unknown>>).map((x) => ({ name: String(x.name ?? ''), value: String(x.value ?? '') })).filter((x) => x.name && x.value) : undefined,
    })).filter((v) => v.name),
    // The n8n `csl-to-llm1` node emits `searched`; this reader only ever looked for `searches`, so the buyer's own
    // search phrases were ALWAYS empty on the typed path (they survived only because `raw` carries the whole
    // summary into the brain prompt). Accept both keys — server-side is being fixed to emit both, this is the
    // client half so the fix works whichever lands first.
    searches: (Array.isArray(s.searches) ? s.searches : Array.isArray((s as { searched?: unknown }).searched) ? (s as { searched: unknown[] }).searched : []).map(String),
    browse_location: s.browse_location,   // #78: surface the geo-IP / searched-city block so node_raw can carry it to the gate
    raw: s,
  };
  recordSource('CSL · bi-csl-parser', { ok: result.viewed_products.length > 0 || result.searches.length > 0, ms: Date.now() - t0, raw: d, cleaned: { viewed_products: result.viewed_products, searches: result.searches } });
  return result;
}

export interface RfqRequirement { product: string; mcat?: string; status?: string; is_expired?: boolean; recency_days?: number | null; specs: { name: string; value: string }[]; }
export async function fetchRfq(glid: string, timeoutMs = 60000): Promise<{ requirements: RfqRequirement[]; enquiries: Enquiry[]; raw: unknown } | null> {
  const t0 = Date.now();
  const d = await safe(getJSON<Record<string, unknown>>(HOOK('bi-rfq-details', glid), undefined, timeoutMs));
  if (!d) { recordSource('RFQ · bi-rfq-details', { ok: false, ms: Date.now() - t0, raw: null, cleaned: null }); return null; }
  const base = (Array.isArray(d) ? d[0] : d) as { summary?: Record<string, unknown>; raw?: { rfq?: { RESPONSE?: { DATA?: { Listing?: unknown } } } } } | undefined;
  const s = base?.summary ?? {};   // guard: an empty-array [] response left d[0] undefined → `.summary` threw OUTSIDE safe()
  // TYPE-E ENQUIRIES (2026-08-11): the raw display Listing carries his outbound enquiries alongside the B buyleads
  // that became `requirements` — highest-intent "he contacted this seller about this product" signal. Parse them
  // out (PII-masked, deduped by product). Empty for a buyer who never enquired (e.g. 106815489).
  const enquiries = parseEnquiries(base?.raw?.rfq?.RESPONSE?.DATA?.Listing, Date.now());
  const reqs = (Array.isArray(s.requirements) ? s.requirements : []) as Array<Record<string, unknown>>;
  const result = {
    requirements: reqs.map((r) => {
      const specsObj = (r.specs && typeof r.specs === 'object' && !Array.isArray(r.specs)) ? r.specs as Record<string, unknown>
        : Array.isArray(r.specs) ? Object.fromEntries((r.specs as Array<Record<string, unknown>>).map((x) => [String(x.name), String(x.value)])) : {};
      return {
        product: String(r.title ?? r.product ?? ''), mcat: (r.category_id ?? r.mcat) != null ? String(r.category_id ?? r.mcat) : undefined,
        status: r.status != null ? String(r.status) : undefined, is_expired: !!r.is_expired,
        recency_days: typeof r.recency_days === 'number' ? r.recency_days : null,
        specs: Object.entries(specsObj).map(([name, value]) => ({ name, value: String(value) })).filter((x) => x.name && x.value),
      };
    }).filter((r) => r.product),
    enquiries,
    raw: s,
  };
  recordSource('RFQ · bi-rfq-details', { ok: result.requirements.length > 0 || result.enquiries.length > 0, ms: Date.now() - t0, raw: d, cleaned: { requirements: result.requirements, enquiries: result.enquiries } });
  return result;
}

// Non-blocking landing truth — pass whatever JSON they return straight to the LLM (raw == cleaned here).
export async function fetchProfile(glid: string, t = 60000): Promise<unknown> {
  const t0 = Date.now();
  const d = await safe(getJSON<unknown>(HOOK('bi-bpod', glid), undefined, t));
  recordSource('Profile · bi-bpod', { ok: hasPayload(d), ms: Date.now() - t0, raw: d, cleaned: d });
  return d;
}
export async function fetchWhatsapp(glid: string, t = 60000): Promise<unknown> {
  const t0 = Date.now();
  const d = await safe(getJSON<unknown>(HOOK('bi-whatsapp', glid), undefined, t));
  recordSource('WhatsApp · bi-whatsapp', { ok: hasPayload(d), ms: Date.now() - t0, raw: d, cleaned: d });
  return d;
}
// bi-pns-insights. pns=api → fast insights; pns=full → currently the same call (the transcription suite lives
// behind bi-transcribe), and the response says so via `full_supported:false` + `mode_effective`.
// mcatId is passed for traceability and is ECHOED BACK, but it is deliberately NOT forwarded upstream
// (owner 2026-08-02). PNS is fetched GLID-only, across ALL categories, because:
//   1. filtering by the mcat the buyer is posting for returns NOTHING when he is researching a NEW product —
//      which is exactly why this source read as "empty" for every buyer we tested; and
//   2. his calls in OTHER categories are where persona and buying intent surface, and that is the signal the
//      Commercial (page 2) and Persona (page 3) planners are built on.
// The response carries `mcats_seen` / `mcats_distinct` so the breadth of that cross-category pull is visible.
export async function fetchPnsInsights(glid: string, pns: 'api' | 'full' = 'api', mcatId?: string, t = 120000, profile?: unknown): Promise<unknown> {
  const t0 = Date.now();
  const d = await safe(getJSON<unknown>(HOOK('bi-pns-insights', glid, `&pns=${pns}${mcatId ? `&mcat_id=${encodeURIComponent(mcatId)}` : ''}`), undefined, t), 'pns');
  // C5 — GREEN-ON-EMPTY + CROSS-SOURCE CONTRADICTION ALARM.
  // `ok: d != null` counted an empty-but-structured response as healthy, which is how a 12-buyer study found SIX
  // buyers returning zero call rows while their OWN profile recorded calls (pns_call_cnt 52, 116, 58 …) with nobody
  // noticing. Two distinct states now: `empty` (no rows, and the profile agrees there are no calls) versus
  // `contradicted` (no rows, but the profile says calls exist) — the latter is a RED source, because it means the
  // request or the upstream is wrong, not that the buyer is quiet.
  const item = (Array.isArray(d) ? d.find((x) => x && typeof x === 'object') : d) as Record<string, unknown> | undefined;
  const rows = Array.isArray(item?.insights) ? (item!.insights as unknown[]).length : 0;
  const claimed = pnsCallsClaimed(profile);
  const contradicted = rows === 0 && claimed > 0;
  // #12 (deep-audit 2026-08-12): 'full' promises VANI transcription, but the upstream reports `mode_effective` /
  // `full_supported` and — until now — NOBODY read them, so a silently-downgraded 'full' request was labelled as if
  // it had run. Read them and label the row HONESTLY (e.g. "full→api") so the inspector never asserts transcription
  // that did not happen. The real fix (routing bi-transcribe) is owner/n8n; this makes the downgrade visible.
  const modeEff = typeof item?.mode_effective === 'string' ? item.mode_effective : undefined;
  const fullSupported = item?.full_supported === true ? true : item?.full_supported === false ? false : undefined;
  const downgraded = pns === 'full' && (fullSupported === false || (!!modeEff && modeEff !== 'full'));
  recordSource(`PNS · bi-pns-insights (${downgraded ? `full→${modeEff || 'api'}` : pns})`, {
    ok: hasPayload(d) && rows > 0,
    ms: Date.now() - t0, raw: d,
    cleaned: { rows, profile_claims_calls: claimed, contradicted, mode_requested: pns, mode_effective: modeEff ?? null, full_supported: fullSupported ?? null, downgraded, verdict: contradicted ? `CONTRADICTED — profile records ${claimed} call(s), API returned 0 rows` : rows > 0 ? 'ok' : 'no calls (profile agrees)' },
  });
  return d;
}

/** How many calls the buyer's OWN profile says exist — the cross-check for the alarm above. Reads the counters that a
 *  12-buyer study found populated 12/12 (`pns_call_cnt`, `total_calls`), wherever they sit in the bpod payload. */
export function pnsCallsClaimed(profile: unknown): number {
  if (!profile) return 0;
  let best = 0;
  const walk = (o: unknown) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (/^(pns_call_cnt|total_calls)$/i.test(k)) { const n = Number(v); if (Number.isFinite(n)) best = Math.max(best, n); }
      else if (v && typeof v === 'object') walk(v);
    }
  };
  try { walk(profile); } catch { /* noop */ }
  return best;
}

// ── Spec APIs (MCAT-derived, on product commit) ───────────────────────────────
export interface BuyerSpec { name: string; options: string[]; mandatory?: boolean; }

export async function resolveMcat(query: string): Promise<string | null> {
  const d = await safe(getJSON<Record<string, string> | Array<Record<string, string>>>(
    `/api/imimg/models/mcatid-suggestion.php?search_param=${encodeURIComponent(query)}&modid=MY`));
  if (!d) return null;
  const row = Array.isArray(d) ? d[0] : d;
  const id = row?.mcat_id ?? row?.MID ?? row?.mcatid ?? row?.mcatId;
  return id ? String(id) : null;
}

/** Buyer Specs = the MCAT ISQ schema (what a buyer is asked). GetIsq returns DATA as arrays-of-specs. */
export async function fetchBuyerSpecs(mcatId: string): Promise<BuyerSpec[]> {
  const d = await safe(getJSON<{ DATA?: Array<Record<string, unknown> | Array<Record<string, unknown>>> }>(
    `/api/imimg/index.php?r=Newreqform/GetIsq&modid=MY&mcatid=${mcatId}&cat_type=3&flag=1&isq_format=1&generic_flag=1&country_iso=IN`));
  const rows = (d?.DATA ?? []).flat() as Array<Record<string, unknown>>;
  const out: BuyerSpec[] = [];
  for (const r of rows) {
    const name = String(r.IM_SPEC_NAME ?? r.name ?? r.SPEC_NAME ?? '').trim();
    if (!name) continue;
    const opts = Array.isArray(r.OPTIONS_DATA) ? (r.OPTIONS_DATA as Array<Record<string, unknown>>).map((o) => String(o.IM_SPEC_OPTIONS_DESC ?? o.desc ?? '')).filter(Boolean) : [];
    out.push({ name, options: opts, mandatory: String(r.IM_MANDATORY ?? r.mandatory ?? '') === '1' });
  }
  return out;
}

/** Seller Specs / Category Engine — the seller-asked questions for the mcat (bi-category-brain). */
export async function fetchSellerSpecs(mcatId: string): Promise<{ q: string; pct?: number; vals?: string[] }[]> {
  return (await safe(fetchCategoryTopSpecs(mcatId))) ?? [];
}
// (`fetchCategoryEngine`, an alias of fetchSellerSpecs, was removed 2026-08-01 — nothing imported it, and a second
//  name for one fetch invited exactly the confusion this file already carries about which category path is live.
//  The shipping route uses fetchCategoryBrainFull + distillCategory; ?rfq=brain2 uses fetchSellerSpecs directly.)

/** The COMPLETE bi-category-brain payload (owner 2026-07-31: "recheck if complete category corpus is coming for
 *  commercials"). It was NOT: `fetchCategoryTopSpecs` keeps only `top_specs` and silently discards four whole
 *  sections the node computes — `personas`, `keywords`, `b2b_b2c`, `top_products` — plus the coverage counters
 *  (`calls_analyzed` / `rows_received` / `rows_unparsed`), which say how much real call evidence the numbers rest on.
 *  LLM 2 therefore planned commercial questions blind to the category's own persona/keyword/order-type signal.
 *  This returns the object verbatim so nothing is dropped before the prompt. NOTE the n8n node still caps
 *  `top_specs` at the top 15 and `top_values` at 5 per spec (`topN(specs,15)`) — that cap is SERVER-side. */
export async function fetchCategoryBrainFull(mcatId: string): Promise<Record<string, unknown> | null> {
  const id = String(mcatId || '').trim();
  if (!id) return null;
  const raw = await safe(getJSON<unknown>(api(`/api/imworkflow/webhook/bi-category-brain?mcat_id=${encodeURIComponent(id)}`), undefined, 30000), 'category');
  if (raw == null) return null;
  const item = Array.isArray(raw) ? raw.find((x) => x && typeof x === 'object') : raw;
  return item && typeof item === 'object' ? item as Record<string, unknown> : null;
}

/** Derive the distilled `{q, pct, vals}[]` feed FROM an already-fetched full corpus, so one HTTP call serves both
 *  consumers. This replaces a second `fetchCategoryTopSpecs` round-trip that was mistakenly commented as a
 *  "cache-warm": the n8n node sends Redash `max_age: 0`, so the second call was a second FULL query execution of a
 *  pipeline that can take ~185s server-side. `asked_pct` is CLAMPED to 0..100 here because the node can emit >100
 *  (it counts per product·spec but divides by rows), and an out-of-range "how often sellers ask this" would reach
 *  LLM 2 as ranking truth. */
export function distillCategory(full: Record<string, unknown> | null): { q: string; pct?: number; vals?: string[] }[] {
  const rows = Array.isArray(full?.top_specs) ? full!.top_specs as Array<Record<string, unknown>> : [];
  return rows.map((s) => {
    const q = String(s.question ?? s.q ?? '').trim();
    const rawPct = typeof s.asked_pct === 'number' ? s.asked_pct : typeof s.pct === 'number' ? s.pct : undefined;
    const rawVals: unknown = s.top_values ?? s.vals;
    const vals = Array.isArray(rawVals)
      ? (rawVals as unknown[]).map((v) => (v && typeof v === 'object' && 'value' in (v as object) ? String((v as { value: unknown }).value) : String(v))).filter(Boolean)
      : undefined;
    return { q, ...(rawPct != null ? { pct: Math.max(0, Math.min(100, Math.round(rawPct))) } : {}), ...(vals?.length ? { vals } : {}) };
  }).filter((r) => r.q);
}

// ── Curated seller search input (Page 0 product+qty flow into the final step) ──
export const postSellerSearch = <T>(body: unknown, t = 120000) => postJSON<T>('/api/sellersearch', body, t);
