// ─── QUALITY GATES (P0.5) — deterministic checks ported from bl_quality (NO LLM, no infra) ─────────
// Direct ports of the battle-tested rules in bl_quality/routing.py + absurd_quantity.py, adapted for
// the RFQ form. These close real gaps the RFQ has today: no quantity-sanity, no GSTIN/PII regex, no
// product-name quality gate, no seller-intent guard. Pure + harnessed (qualitygatestest.mjs).

// ── PII / GSTIN regexes (bl_quality routing.py PII_PATTERNS) ──────────────────────────────────────
export const PII = {
  mobileCC: /\+91[\s-]?[6-9]\d{9}/,
  mobile: /\b0?[6-9]\d{9}\b/,
  email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  gstin: /\b\d{2}[a-z]{5}\d{4}[a-z][a-z0-9]z[a-z0-9]\b/i,
  card: /\b(?:\d[\s-]*?){13,16}\b/,
};
export function detectPII(text: string): { found: boolean; kinds: string[] } {
  const t = String(text || '');
  const kinds: string[] = [];
  if (PII.mobileCC.test(t) || PII.mobile.test(t)) kinds.push('mobile');
  if (PII.email.test(t)) kinds.push('email');
  if (PII.gstin.test(t)) kinds.push('gstin');
  if (PII.card.test(t)) kinds.push('card');
  if (/facebook|linkedin|instagram/i.test(t)) kinds.push('social');
  return { found: kinds.length > 0, kinds };
}
// a buyer's free-text GSTIN we CAN use (vs PII to scrub) — surface it as a fact, don't silently drop.
export function extractGSTIN(text: string): string | null { const m = String(text || '').toUpperCase().match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/); return m ? m[0] : null; }

// ── Selling-intent keyword pre-filter (bl_quality routing.py SELLING_KEYWORDS) ─────────────────────
export const SELLING_KEYWORDS = ['i want to sale', 'available for sale', 'i have for sale', 'we manufacture', 'offering at best rate', 'we have material ready', 'we deal in', 'our company produces', 'we are manufacturers of', 'available immediately', 'bulk quantity ready for dispatch'];
export function looksLikeSeller(text: string): boolean {
  const t = String(text || '').toLowerCase();
  // skip the false-positive pair (Usage=Selling is a buyer answer, not seller intent)
  return SELLING_KEYWORDS.some((kw) => t.includes(kw));
}

// ── Product-name / title quality gates (bl_quality routing.py title gates) ─────────────────────────
const words = (s: string) => String(s || '').trim().split(/\s+/).filter(Boolean);
export function productNameQuality(name: string, category = ''): { issue: 'one-word' | 'trivial' | 'matches-category' | null; note: string } {
  const n = String(name || '').trim(); const wc = words(n).length;
  if (wc === 0) return { issue: 'trivial', note: 'empty product name' };
  // matches-category is the more specific signal → check before one-word (handles 1-word name == 1-word category)
  if (category && n.toLowerCase() === category.toLowerCase()) return { issue: 'matches-category', note: 'product name == category — add specificity' };
  if (wc === 1) return { issue: 'one-word', note: 'one-word product name — too vague; enrich from specs' };
  if (wc < 3 && !category) return { issue: 'trivial', note: 'very short product name' };
  return { issue: null, note: 'ok' };
}

// ── Absurd-quantity rules (bl_quality absurd_quantity.py — rule-based, no LLM) ──────────────────────
export const ABSURD_QTY_THRESHOLD = 1000;
const MULT: Record<string, number> = { lakh: 1e5, lac: 1e5, crore: 1e7, cr: 1e7 };
export function parsePriceINR(s: string): number | null {
  if (!s || !String(s).trim()) return null;
  const m = String(s).match(/[₹Rs.\s]*([\d,.]+)\s*(lakh|lac|crore|cr)?/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, '')); if (!Number.isFinite(v)) return null;
  return v * (MULT[(m[2] || '').toLowerCase()] || 1);
}
export interface QtyCheckInput { quantity: number; productPrices?: string[]; mcatQ1?: number; mcatQ3?: number; gstOnFile?: boolean; companyOnFile?: boolean }
export function absurdQuantity(i: QtyCheckInput): { absurd: boolean; reasons: string[] } {
  const q = Number(i.quantity) || 0; const reasons: string[] = [];
  if (q <= ABSURD_QTY_THRESHOLD) return { absurd: false, reasons: [] };
  // Rule 1 — non-round (ones digit ≠ 0 at large magnitude → likely a typo/price pasted into qty)
  if (Math.trunc(q) % 10 !== 0) reasons.push(`non-round quantity ${Math.trunc(q)} (ones digit ${Math.trunc(q) % 10}) — looks like a typo or a price`);
  // Rule 2 — quantity equals a viewed product price (buyer typed the price into the qty box)
  for (const p of i.productPrices || []) { const parsed = parsePriceINR(String(p)); if (parsed != null && Math.trunc(parsed) === Math.trunc(q)) { reasons.push(`quantity ${Math.trunc(q)} matches a product price — did you mean the price?`); break; } }
  // Rule 3 — quantity sits inside the category price IQR + no GST + no company (price-as-qty signal)
  if (i.mcatQ1 && i.mcatQ3 && i.mcatQ1 > ABSURD_QTY_THRESHOLD && q >= i.mcatQ1 && q <= i.mcatQ3 && !i.gstOnFile && !i.companyOnFile) reasons.push(`quantity ${q} lies within the category price band [${i.mcatQ1}–${i.mcatQ3}] — likely a price, not a quantity`);
  return { absurd: reasons.length > 0, reasons };
}

// ── Order-value (POV) — bl_quality core.compute_order_value_metrics ────────────────────────────────
export function orderValue(quantity: number, mcatMedianPrice: number): { pov: number; heavyCheck: boolean } {
  const q = Number(quantity) || 0; return { pov: q * (Number(mcatMedianPrice) || 0), heavyCheck: q >= ABSURD_QTY_THRESHOLD };
}
