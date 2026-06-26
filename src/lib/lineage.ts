// ─── RAW LINEAGE (P1) — the keystone: fact → exact JSON path → value → n8n node → execution ─────────
// PURE · deterministic · NO LLM. Answers Gap 1 + Gap 2 of the explainability review: click a derived
// fact ("Manufacturer", "Local supplier preference") and see WHERE it physically came from — the exact
// JSON field in the buyer-pull response, its raw value, and (via the E1 `_trace`) which n8n node emitted
// the container key and in which execution. Grounded in the REAL paths src/lib/enrichment.ts reads — no
// invented structure. The response `raw` is an array of singly-keyed objects (buyer_profile, pns_data,…).

import type { ServerTrace } from './enrichment';

export interface FactLineage {
  fact: string;            // human label ("Buyer persona")
  jsonPath: string;        // exact path, e.g. pns_data[].extracted_data.metadata.call_type.evidence.buyer_persona
  topKey: string;          // the container key (buyer_profile / pns_data / …) — used to find the emitting node
  api: string | null;      // the source API behind the container key (PNS / CSL / Buyer Profile …) — Q3
  value: string | null;    // the raw value found at that path (stringified, trimmed)
  sourceNode: string | null;   // n8n node that emitted topKey (from the E1 trace output_keys), if available
  execution: string | null;    // n8n execution id (from the E1 trace summary), if available
  found: boolean;          // did the path resolve to a value in this pull?
}

// container key → the upstream API/source that produced it (answers Q3 "which API endpoint?")
export const API_FOR_KEY: Record<string, string> = {
  buyer_profile: 'Buyer Profile API', pns_data: 'PNS', prev_isq_data: 'ISQ history', prev_bl_data: 'Buylead history',
  whatsapp_data: 'WhatsApp', whatsapp_inbound: 'WhatsApp inbound', csl_data: 'CSL (browse/search)',
};
export function apiForKey(topKey: string): string | null { return API_FOR_KEY[topKey] || null; }

// ── the REAL fact→path registry (mirrors the reads in deriveEnrichment). topKey is the container the
//    n8n trace keys nodes by; the rest is the in-document path. `[]` = "first array element that resolves". ──
export const FACT_PATHS: Array<{ fact: string; topKey: string; path: string }> = [
  { fact: 'Buyer persona', topKey: 'pns_data', path: 'pns_data[].extracted_data.metadata.call_type.evidence.buyer_persona' },
  { fact: 'Quantity scale', topKey: 'pns_data', path: 'pns_data[].extracted_data.metadata.call_type.evidence.quantity_scale' },
  { fact: 'Order type', topKey: 'pns_data', path: 'pns_data[].extracted_data.metadata.call_type.evidence.order_type' },
  { fact: 'Intended application', topKey: 'pns_data', path: 'pns_data[].extracted_data.metadata.intended_application' },
  { fact: 'Call intent level', topKey: 'pns_data', path: 'pns_data[].extracted_data.metadata.buyer_intent.intent_level' },
  { fact: 'Call narrative', topKey: 'pns_data', path: 'pns_data[].extracted_data.metadata.buyer_intent.narrative' },
  { fact: 'Primary language', topKey: 'pns_data', path: 'pns_data[].extracted_data.metadata.primary_language' },
  { fact: 'Company description', topKey: 'buyer_profile', path: 'buyer_profile.glusr_usr_company_desc' },
  { fact: 'Designation', topKey: 'buyer_profile', path: 'buyer_profile.designation' },
  { fact: 'Verified business buyer', topKey: 'buyer_profile', path: 'buyer_profile.verified_business_buyer_flag' },
  { fact: 'Location preference', topKey: 'buyer_profile', path: 'buyer_profile.location_preference' },
  { fact: 'City', topKey: 'buyer_profile', path: 'buyer_profile.city' },
  { fact: 'Locality', topKey: 'buyer_profile', path: 'buyer_profile.locality' },
  { fact: 'Last RFQ category', topKey: 'prev_isq_data', path: 'prev_isq_data[].title' },
  { fact: 'Last buylead enquiry', topKey: 'prev_bl_data', path: 'prev_bl_data[].ETO_OFR_TITLE' },
  { fact: 'CSL browse city', topKey: 'csl_data', path: 'csl_data[].glb_city' },
];

const str = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'object') { try { const s = JSON.stringify(v); return s.length > 160 ? s.slice(0, 160) + '…' : s; } catch { return '[object]'; } }
  const s = String(v).trim();
  return s ? (s.length > 160 ? s.slice(0, 160) + '…' : s) : null;
};

// pick a top-level key out of the response array (same shape deriveEnrichment uses; JSON.parse strings)
function getTop(raw: unknown, key: string): unknown {
  if (!Array.isArray(raw)) return undefined;
  for (const el of raw as Array<Record<string, unknown>>) {
    if (el && typeof el === 'object' && key in el) {
      const v = el[key];
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
      return v;
    }
  }
  return undefined;
}

// walk dotted segments; a `key[]` segment iterates the array and returns the first element that resolves
function walk(value: unknown, segs: string[]): unknown {
  if (!segs.length) return value;
  const [head, ...rest] = segs;
  const isArr = head.endsWith('[]');
  const key = isArr ? head.slice(0, -2) : head;
  const next = (value && typeof value === 'object') ? (value as Record<string, unknown>)[key] : undefined;
  if (isArr) {
    if (!Array.isArray(next)) return undefined;
    for (const el of next) { const r = walk(el, rest); if (r !== undefined && r !== null && r !== '') return r; }
    return undefined;
  }
  return walk(next, rest);
}

// resolve a full path like "pns_data[].extracted_data.metadata.intended_application" against the raw array
export function resolveAtPath(raw: unknown, path: string): unknown {
  const segs = path.split('.');
  const first = segs[0];
  const firstIsArr = first.endsWith('[]');
  const firstKey = firstIsArr ? first.slice(0, -2) : first;
  const top = getTop(raw, firstKey);
  if (top === undefined) return undefined;
  if (firstIsArr) {
    if (!Array.isArray(top)) return undefined;
    for (const el of top) { const r = walk(el, segs.slice(1)); if (r !== undefined && r !== null && r !== '') return r; }
    return undefined;
  }
  return walk(top, segs.slice(1));
}

// which n8n node emitted a container key — from the E1 trace's per-node output_keys
export function nodeForTopKey(trace: ServerTrace | null | undefined, topKey: string): string | null {
  if (!trace?.nodes) return null;
  for (const n of trace.nodes) { if (n.output_keys && n.output_keys.includes(topKey) && n.node) return n.node; }
  return null;
}

// trace ONE fact end-to-end
export function traceFact(raw: unknown, trace: ServerTrace | null | undefined, entry: { fact: string; topKey: string; path: string }): FactLineage {
  const v = resolveAtPath(raw, entry.path);
  const value = str(v);
  return {
    fact: entry.fact, jsonPath: entry.path, topKey: entry.topKey, api: apiForKey(entry.topKey), value,
    sourceNode: nodeForTopKey(trace, entry.topKey),
    execution: trace?.summary?.execution_id ?? null,
    found: value != null,
  };
}

// all registry facts that resolved in this pull (the lineage table the Inspector renders)
export function allLineage(raw: unknown, trace: ServerTrace | null | undefined): FactLineage[] {
  if (!Array.isArray(raw)) return [];
  return FACT_PATHS.map((e) => traceFact(raw, trace, e)).filter((l) => l.found);
}
