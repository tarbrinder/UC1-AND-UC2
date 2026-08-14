// ─── ABSURD QUANTITY ──────────────────────────────────────────────────────────
// Deterministic, no-LLM detector — a faithful port of the production `bl_quality/agents/absurd_quantity.py`
// so an RFQ posted here passes the exact audit it will later be graded by. It only ever raises a SOFT confirm
// ("is that really the quantity?"); it never blocks submission (owner 2026-08-13). Rules (only for qty > 1000):
//   1. Non-round / irregular — ones digit ≠ 0 (43869 → yes; 10980 → no).
//   2. Price-as-quantity — qty exactly equals a buyer-viewed product PRICE (parsed from "₹ 8 Lakh / Piece").
//   3. Within MCAT price IQR — qty ∈ [Q1,Q3] of the category price distribution, AND no GST, AND no company name.
// Rules 2 & 3 activate only when their inputs are supplied (viewed-product prices / MCAT IQR); Rule 1 is always on.

const ABSURD_QTY_THRESHOLD = 1000;

const MULTIPLIERS: Record<string, number> = { lakh: 100000, lac: 100000, crore: 10000000, cr: 10000000 };

/** Parse an Indian-formatted price string into a plain INR number. "₹ 5.75 Lakh / Piece" → 575000. Mirrors _parse_price_inr. */
export function parsePriceInr(priceStr: string): number | null {
  if (!priceStr || !priceStr.trim()) return null;
  const m = priceStr.match(/([\d,.]+)\s*(lakh|lac|crore|cr)?/i);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(num)) return null;
  return num * (MULTIPLIERS[(m[2] || '').toLowerCase()] ?? 1);
}

export interface AbsurdQtyInputs {
  productPrices?: string[];   // buyer-viewed product prices (formatted strings) — enables Rule 2
  mcatQ1?: number;            // category price distribution Q1/Q3 — enables Rule 3
  mcatQ3?: number;
  gstFlag?: 0 | 1;            // 1 = buyer has GST
  companyFlag?: 0 | 1;       // 1 = buyer gave a company name
}

/** Returns { absurd, reason }. `absurd` drives a soft confirm only — never a hard block. */
export function detectAbsurdQty(quantityRaw: string | number, x: AbsurdQtyInputs = {}): { absurd: boolean; reason: string } {
  const q = Math.floor(Number(quantityRaw) || 0);
  if (!(q > ABSURD_QTY_THRESHOLD)) return { absurd: false, reason: '' };

  const reasons: string[] = [];

  // Rule 1 — non-round / irregular
  if (q % 10 !== 0) reasons.push(`${q} is an unusually specific quantity (does not end in 0)`);

  // Rule 2 — price entered as quantity
  if ((x.productPrices ?? []).some((p) => { const v = parsePriceInr(String(p)); return v != null && Math.floor(v) === q; })) {
    reasons.push(`${q} exactly matches a product's price — did you type the price instead of the quantity?`);
  }

  // Rule 3 — within the category's price band, with no GST and no company name
  if (x.mcatQ1 && x.mcatQ3 && x.mcatQ1 > ABSURD_QTY_THRESHOLD && q >= x.mcatQ1 && q <= x.mcatQ3 && (x.gstFlag ?? 0) === 0 && (x.companyFlag ?? 0) === 0) {
    reasons.push(`${q} falls in this category's typical PRICE range, which is unusual for an order quantity`);
  }

  return { absurd: reasons.length > 0, reason: reasons.join('; ') };
}
