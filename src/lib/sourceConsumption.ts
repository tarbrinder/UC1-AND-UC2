// ── SOURCE-CONSUMPTION MATRIX ───────────────────────────────────────────────
// The #8 deliverable: for EVERY source in the pull, show present? → consumed by the
// LLM? → surfaced on the card? → surfaced in debug?. This is the top-level answer to
// a reviewer's "we had this data — why didn't we use it?" (the per-attribute panel in
// finalAttrDetail answers it per attribute; this answers it per source).
//
// The per-surface membership is grounded in the codebase audit (scout, 2026-07-08):
// which compose* feed the extract prompt, which keys parseBuyerProfile reads on the
// card, and which have an L2 readable vs L1-raw-only in debug. Presence is checked
// LIVE against the pull. Honest gaps are flagged in `gap`.

type Reach = 'yes' | 'via-llm' | 'partial' | 'no';

interface SurfaceSpec {
  key: string;         // canonical source key in rich.sources (or a virtual group)
  label: string;
  aliases?: string[];  // other keys that count as this source being present
  llm: Reach;          // reaches the extract prompt (compose* in buyerProfileExtract)
  card: Reach;         // parseBuyerProfile reads it (directly, or only via the LLM overlay)
  debug: Reach;        // L2 curated readable ('yes') vs L1 raw+summary only ('partial')
  gap?: string;        // honest note when under-consumed
}

// Ordered by the buyer-journey narrative (identity → behaviour → KYB → web).
const SURFACES: SurfaceSpec[] = [
  { key: 'identity', label: 'Buyer Profile (GLUSR)', aliases: ['profile', 'glusr'], llm: 'yes', card: 'yes', debug: 'yes' },
  { key: 'usersince', label: 'Member-since / tenure', llm: 'yes', card: 'yes', debug: 'yes' },
  { key: 'pns', label: 'PNS · sales calls (spoken)', llm: 'yes', card: 'via-llm', debug: 'yes', gap: 'card shows PNS only through the LLM overlay (persona/intent), not as a direct card field' },
  { key: 'pns_calls', label: 'PNS calls · masked seller calls', llm: 'yes', card: 'via-llm', debug: 'yes', gap: 'card reads it only via the LLM overlay' },
  { key: 'calls', label: 'Call recordings · transcribed', llm: 'yes', card: 'via-llm', debug: 'yes', gap: 'deal-readiness/payment/language reach the card only via the LLM overlay' },
  { key: 'whatsapp', label: 'WhatsApp (in + out)', aliases: ['whatsapp_inbound', 'whatsapp_conversations', 'whatsapp_conversations2'], llm: 'yes', card: 'yes', debug: 'yes' },
  { key: 'csl', label: 'CSL · on-site behaviour', llm: 'yes', card: 'partial', debug: 'partial', gap: 'card uses only the also-a-seller flag; debug has raw+summary but no curated readable — browse categories/cities dropped on both' },
  { key: 'requirement', label: 'RFQs / BuyLeads + ISQ specs', aliases: ['rfq', 'isq'], llm: 'yes', card: 'yes', debug: 'yes' },
  { key: 'mobiles', label: 'Mobiles (multi-vendor)', llm: 'yes', card: 'yes', debug: 'yes' },
  { key: 'gst', label: 'Befisc GST', llm: 'yes', card: 'yes', debug: 'partial', gap: 'no dedicated __health row emitted for gst (health matrix infers it from sources.gst)' },
  { key: 'gst_detail_union', label: 'GST detail (3-vendor union)', aliases: ['gstin_union'], llm: 'yes', card: 'yes', debug: 'yes' },
  { key: 'pan_union', label: 'PAN (union)', aliases: ['pan'], llm: 'yes', card: 'yes', debug: 'yes' },
  { key: 'udyam', label: 'Udyam / MSME', llm: 'yes', card: 'yes', debug: 'yes' },
  { key: 'external', label: 'External · Befisc + Sign3', llm: 'yes', card: 'yes', debug: 'yes' },
  { key: 'gst_cert_idfy', label: 'IDfy · GST certificate', llm: 'yes', card: 'yes', debug: 'yes' },
  { key: 'pan_gst_idfy', label: 'IDfy · PAN↔GST link', llm: 'yes', card: 'no', debug: 'yes', gap: 'card ignores it (uses gst_cert_idfy / gst_detail_union instead)' },
  { key: 'epfo', label: 'IDfy · EPFO (employer size)', llm: 'yes', card: 'no', debug: 'yes', gap: 'card ignores it; feeds scale via the LLM only' },
  { key: 'web_osint', label: 'Web OSINT · Parallel + Gemini', llm: 'yes', card: 'yes', debug: 'yes', gap: 'LLM + card gate web on match_confidence (namesake guard) — a "none" match is intentionally withheld' },
];

export interface ConsumptionRow {
  key: string;
  label: string;
  present: boolean;
  llm: Reach;
  card: Reach;
  debug: Reach;
  gap?: string;
}

function obj(v: unknown): Record<string, unknown> { return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {}; }

/** Is a source key present + non-empty in the pull? Checks rich.sources[key].{summary,raw}
 *  and derived_anchors for the profile alias. */
function present(rich: unknown, spec: SurfaceSpec): boolean {
  const r = obj(rich);
  const sources = obj(r.sources);
  const keys = [spec.key, ...(spec.aliases || [])];
  for (const k of keys) {
    if (k === 'profile' || k === 'glusr') { if (Object.keys(obj(r.derived_anchors)).length) return true; continue; }
    const node = sources[k];
    if (node == null) continue;
    const n = obj(node);
    const summary = n.summary, raw = n.raw;
    const nonEmpty = (v: unknown) => v != null && (Array.isArray(v) ? v.length > 0 : (typeof v === 'object' ? Object.keys(v as object).length > 0 : String(v).trim() !== ''));
    if (nonEmpty(summary) || nonEmpty(raw)) return true;
    // audit SC-71: the bare-node fallback must be SEMANTIC — a wrapper carrying only plumbing (__health/count/status/_meta)
    // is NOT "present". Only a real, non-plumbing content key with a value counts.
    const PLUMB = new Set(['summary', 'raw', '__health', '_meta', 'count', 'status', 'ok', 'node']);
    if (Object.keys(n).some((kk) => !PLUMB.has(kk) && nonEmpty((n as Record<string, unknown>)[kk]))) return true;
  }
  return false;
}

/** Build the full matrix for a rich pull — one row per source, presence checked live. */
export function buildSourceConsumptionMatrix(rich: unknown): ConsumptionRow[] {
  return SURFACES.map((s) => ({ key: s.key, label: s.label, present: present(rich, s), llm: s.llm, card: s.card, debug: s.debug, gap: s.gap }));
}

// ── DETERMINISTIC PER-ATTRIBUTE CONSUMPTION ─────────────────────────────────
// The LLM stays lean (it emits only `sources` = what it used). The Available →
// Used → Ignored → Roles view is DERIVED here from: the attribute's policy order,
// the sources the LLM cited (used), and which sources are present in the pull.
// Deterministic ⇒ repeatable + it exactly mirrors the frozen policy (more
// trustworthy for "we had this data, why not used?" than an LLM self-report).
import { POLICIES, type PolicyId, type EvidenceRole } from './sourcePolicies';

// each policy-order label → the pull source KEYS that satisfy it + a short authority reason
const LABEL_MATCH: Array<{ re: RegExp; keys: string[]; short: string; reason: string }> = [
  { re: /gst/i, keys: ['gst', 'gst_detail_union', 'gstin_union', 'gst_cert_idfy'], short: 'GST', reason: 'registration present but not the deciding source here' },
  { re: /udyam/i, keys: ['udyam'], short: 'Udyam', reason: 'no MSME registration bearing on this attribute' },
  { re: /\bpan\b/i, keys: ['pan_union'], short: 'PAN', reason: 'entity signal only' },
  { re: /external|sign3|befisc|idfy/i, keys: ['external', 'pan_union', 'gst_detail_union'], short: 'External (Sign3/Befisc)', reason: 'identity/KYB only — corroborative for this attribute' },
  { re: /pns/i, keys: ['pns', 'pns_calls', 'calls'], short: 'PNS', reason: 'no spoken signal bearing on this attribute' },
  { re: /whatsapp/i, keys: ['whatsapp'], short: 'WhatsApp', reason: 'no chat signal bearing on this attribute' },
  { re: /requirement|isq|buylead/i, keys: ['requirement'], short: 'Requirements', reason: 'corroborative only under this policy' },
  { re: /csl/i, keys: ['csl'], short: 'CSL', reason: 'browsing interest only' },
  { re: /buyer profile/i, keys: ['identity', 'usersince'], short: 'Buyer Profile', reason: 'identity anchor only' },
  { re: /web/i, keys: ['web_osint'], short: 'Web', reason: 'amplifier only (or withheld as a likely namesake)' },
];

export interface DerivedConsumption {
  available: string[];
  used: string[];
  ignored: Array<{ source: string; reason: string }>;
  roles: Array<{ source: string; role: EvidenceRole }>;
}

/** Derive the consumption view for ONE attribute. usedSources = the LLM's cited `sources`;
 *  presentKeys = source keys present in the pull (from buildSourceConsumptionMatrix). */
export function deriveConsumption(policyId: PolicyId | undefined, usedSources: string[] | undefined, presentKeys: Set<string>): DerivedConsumption | null {
  const pol = policyId ? POLICIES[policyId] : null;
  if (!pol) return null;
  const used = (usedSources || []).map((s) => String(s).toLowerCase());
  const isUsed = (short: string, re: RegExp) => used.some((u) => re.test(u) || u.includes(short.toLowerCase().split(/[ (/]/)[0]));
  const available: string[] = []; const usedNames: string[] = []; const ignored: DerivedConsumption['ignored'] = []; const roles: DerivedConsumption['roles'] = [];
  let firstUsed = true;
  const seen = new Set<string>();
  for (const label of pol.order) {
    const spec = LABEL_MATCH.find((m) => m.re.test(label));
    if (!spec || seen.has(spec.short)) continue;
    seen.add(spec.short);
    const present = spec.keys.some((k) => presentKeys.has(k));
    const u = isUsed(spec.short, spec.re);
    if (present) available.push(spec.short);
    if (u) { usedNames.push(spec.short); roles.push({ source: spec.short, role: firstUsed ? 'Primary' : 'Corroborative' }); firstUsed = false; }
    else if (present) { ignored.push({ source: spec.short, reason: spec.reason }); roles.push({ source: spec.short, role: 'Ignored' }); }
    else { roles.push({ source: spec.short, role: 'Missing' }); }
  }
  return { available, used: usedNames, ignored, roles };
}

/** Roll-up counts for the header pill. */
export function consumptionSummary(rows: ConsumptionRow[]): { present: number; total: number; consumedByLLM: number; gaps: number } {
  const presentRows = rows.filter((r) => r.present);
  return {
    present: presentRows.length,
    total: rows.length,
    consumedByLLM: presentRows.filter((r) => r.llm === 'yes').length,
    gaps: presentRows.filter((r) => r.gap).length,
  };
}
