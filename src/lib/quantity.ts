// ─── Order-SCALE signal (P2.6) ───────────────────────────────────────────────
// "1 tyre" and "1000 tyres" are the SAME product but a TOTALLY different requirement: scale shapes
// business-model, buyer stage, and commercial framing for THIS order (a single piece → personal/sample;
// a truckload → reseller/distributor). Until now quantity drove payment-lean + question-gating but never
// the WHO-IS-THIS-BUYER reasoning. This turns qty + unit into one explicit, plain-English implication.
//
// Pure · NO category literals · deterministic. It is consumed as a SOFT, per-order 'Deduced' signal — it
// FILLS the "how big is this order" Unknown and shapes the planner/intent; it NEVER overturns a Confirmed
// buyer truth (Deduced is the lowest authority — a User/Verified fact always wins). Chaos-safe: no/!qty ⇒ unknown.

const DISCRETE_UNIT = /piece|pcs|\bnos?\b|\bunit\b|\bset\b|pair|item|each|packet/i;
// Units that imply a business-scale order at ANY count (a single tonne / truck / container is bulk).
const BULK_UNIT = /tonne|\btons?\b|\bmt\b|metric\s*ton|quintal|truck|container|wagon|\bkg\b|kilogram|litre|liter|\bton\b|drum|barrel|roll|bundle|carton|gross|dozen/i;

export type OrderScale = 'single' | 'small' | 'bulk' | 'wholesale' | 'unknown';
export interface OrderScaleSignal {
  band: OrderScale;
  label: string;       // human "1000 Piece"
  implication: string; // plain-English what-this-means-for-the-buyer (fed to the planner)
  bulkUnit: boolean;   // the unit itself is a business-scale unit (tonne/truck/…)
}

// Generic, category-AGNOSTIC unit-of-measure fallback. Used ONLY when a category's ISQ carries
// no quantity/unit spec (e.g. Diesel Generator, mcat 13467, whose GetIsq returns Power/Brand/…
// but no unit). So the buyer still gets unit CHIPS with the first pre-selected — never a free-text
// box, never a hidden field. No category literals: these are the same universal units for every mcat.
export const DEFAULT_UNITS = ['Piece', 'Unit', 'Nos', 'Set', 'Pair', 'Dozen', 'Kg', 'Meter', 'Litre', 'Box'];

/** Pick the pre-selected unit from a list, honouring a unit typed in the query ("10 nos …" → "Nos"). */
export function matchUnit(options: string[], typed?: string): string {
  if (!options.length) return '';
  const t = (typed || '').toLowerCase().trim();
  if (!t) return options[0];
  return options.find((o) => { const lo = o.toLowerCase(); return lo === t || lo.startsWith(t) || t.startsWith(lo); }) || options[0];
}

export function classifyOrderScale(qty?: number | string, unit?: string): OrderScaleSignal {
  const n = typeof qty === 'number' ? qty : parseFloat(String(qty ?? '').replace(/[^0-9.]/g, ''));
  const u = (unit || '').trim();
  const bulkUnit = BULK_UNIT.test(u) && !DISCRETE_UNIT.test(u);
  const label = (Number.isFinite(n) && n > 0) ? `${n} ${u || 'unit'}`.trim() : (u || 'unknown');
  if (!Number.isFinite(n) || n <= 0) return { band: 'unknown', label: 'unknown scale', implication: '', bulkUnit };
  // A bulk unit (tonne / truck / container …) at ANY count is a business-scale order.
  if (bulkUnit) return { band: 'wholesale', label, implication: 'bulk-unit order → business / reseller scale, NOT personal use; bulk pricing, credit terms and freight are relevant', bulkUnit };
  // Discrete-unit (or unitless) counts (bulkUnit is false here — the bulk-unit branch returned above).
  if (n <= 2) return { band: 'single', label, implication: 'tiny order → personal use, a sample, or a trial; NOT wholesale/resale; use consumer framing, skip bulk/credit/cadence', bulkUnit };
  if (n <= 25) return { band: 'small', label, implication: 'small order → a small business, a trial, or a top-up; only light commercial signals apply', bulkUnit };
  if (n <= 500) return { band: 'bulk', label, implication: 'sizeable order → an established business buy; cadence, commercial terms and a likely internal approver matter', bulkUnit };
  return { band: 'wholesale', label, implication: 'large order → reseller / distributor / project scale; bulk pricing, credit, and a planned/approved purchase', bulkUnit };
}
