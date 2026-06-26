// ─── Consistency Engine ──────────────────────────────────────────────────────
// Different engines reach conclusions from different signals; before an RFQ is rendered those conclusions
// must be CHECKED for co-occurrence validity. The IIT-Kanpur run showed the failure: "1 Piece → personal
// use / sample / skip-credit" (qty-only order-scale) shipped alongside "capital purchase · credit ·
// installation" (requirement mode + deductions) — mutually impossible, both rendered. This engine takes
// the resolved fact snapshot and returns the CONFLICTS, each with a resolution (downgrade the weaker /
// re-derive / ask). It invents NO new facts — it gates the ones we hold. Pure · channel-agnostic · NO
// category literals. A consumer of the Buyer Memory, like everything else.

export interface ConsistencySnapshot {
  buyerKind?: string;             // business | personal
  buyerType?: string;             // Manufacturer | Research Institution | personal | …
  journey?: string;               // industrial | personal | resale | …
  orderScaleBand?: string;        // single | small | bulk | wholesale
  orderScaleImplication?: string; // the prose (may carry "personal use" / "skip credit")
  requirementMode?: string;       // capital | recurring | sample_trial | …
  paymentLean?: string;           // credit | advance | …
  installation?: string;          // yes | no
}
export interface ConsistencyConflict { a: string; b: string; severity: 'high' | 'medium'; resolution: string }

export function checkConsistency(s: ConsistencySnapshot): ConsistencyConflict[] {
  const conflicts: ConsistencyConflict[] = [];
  // P1 fix: a CONSUMER framing only exists for a consumer-sized band (single/small/sample). NEVER read
  // it from the prose substring alone — the WHOLESALE/BULK implication literally contains "NOT personal
  // use", which used to false-trigger /personal/ and conflict with a business buyer. Gate on the band.
  const consumerBand = /single|small|sample/i.test(s.orderScaleBand || '');
  const consumerFraming = consumerBand && /personal|consumer|sample|skip\s*(bulk|credit|cadence)/i.test(s.orderScaleImplication || '');
  const capitalMode = /capital|project/i.test(s.requirementMode || '');
  const credit = /credit/i.test(s.paymentLean || '');
  const installNeeded = /\byes\b/i.test(s.installation || '');
  const businessBuyer = /business/i.test(s.buyerKind || '')
    || /manufacturer|institution|trader|distributor|wholesal|government|research|industr|corporate/i.test(s.buyerType || '');
  const bulk = /bulk|wholesale/i.test(s.orderScaleBand || '');

  // R1 — a consumer / "skip-credit" scale framing cannot coexist with a capital / credit / installation buy.
  if (consumerFraming && (capitalMode || credit || installNeeded)) {
    conflicts.push({
      a: `order-scale framing = consumer ("${s.orderScaleBand}")`,
      b: capitalMode ? 'requirement mode = capital' : credit ? 'payment lean = credit' : 'installation required',
      severity: 'high',
      resolution: 'downgrade the qty-only consumer framing — a single unit of a capital / credit / installed buy is a normal business purchase, not a personal sample',
    });
  }
  // R2 — consumer / personal framing cannot coexist with a BUSINESS buyer.
  if (consumerFraming && businessBuyer) {
    conflicts.push({
      a: 'order-scale framing = personal / consumer',
      b: `business buyer (${s.buyerType || s.buyerKind})`,
      severity: 'high',
      resolution: "a business buyer's single unit is not 'personal use' — drop the consumer framing, keep the band only",
    });
  }
  // R3 — journey "personal" cannot coexist with a business buyer or a bulk / wholesale order.
  if (/personal/i.test(s.journey || '') && (businessBuyer || bulk)) {
    conflicts.push({
      a: 'journey = personal',
      b: businessBuyer ? `business buyer (${s.buyerType || s.buyerKind})` : 'bulk / wholesale order',
      severity: 'high',
      resolution: 'journey must not be personal for a business / bulk requirement — re-derive as a business journey',
    });
  }
  // R4 — a bulk / wholesale order cannot coexist with a personal buyer-kind.
  if (bulk && /personal/i.test(s.buyerKind || '')) {
    conflicts.push({
      a: `order scale = ${s.orderScaleBand}`,
      b: 'buyer-kind = personal',
      severity: 'medium',
      resolution: 'a bulk / wholesale order is not a personal buy — confirm buyer-kind',
    });
  }
  return conflicts;
}

export const isConsistent = (s: ConsistencySnapshot): boolean => checkConsistency(s).length === 0;
