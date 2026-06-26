// ─── RFQ Completeness Engine (P2) ────────────────────────────────────────────
// The system kept DISCOVERING long after it knew enough. This engine answers the seller's question —
// "what do I still need to quote?" — and, crucially, "do I already know enough to STOP asking?". It is
// NOT generic form-fill % (that's score.ts); it measures SELLER-READINESS: are the DECISIVE fields (the
// planner's must-have specs + the essentials a seller can't quote without) captured? Everything else is
// optional. Pure · channel-agnostic · NO category literals. A consumer of the Buyer Memory like the rest.

export interface CompletenessInput {
  mustHaveSpecs: string[];        // the planner's decisive specs for THIS product
  allSpecNames: string[];         // every ISQ spec (the optional pool)
  isFilled: (specName: string) => boolean; // filled by the buyer OR covered in the registry
  hasQuantity: boolean;           // a quantity is set
  hasIntent: boolean;             // the use-case / intent is known
}
export interface CompletenessResult {
  pct: number;                    // 0-100 over the REQUIRED set (essentials + must-haves)
  missingRequired: string[];      // the few things a seller still needs ("you still need …")
  optional: string[];             // remaining specs — nice-to-have, never blocks
  sellerReady: boolean;           // enough to quote → STOP asking, let them post
}

export function scoreCompleteness(input: CompletenessInput): CompletenessResult {
  const required: Array<{ key: string; ok: boolean }> = [
    { key: 'Use-case / intent', ok: !!input.hasIntent },
    { key: 'Quantity', ok: !!input.hasQuantity },
  ];
  const mustHave = [...new Set((input.mustHaveSpecs || []).filter(Boolean))];
  for (const m of mustHave) required.push({ key: m, ok: input.isFilled(m) });

  const missingRequired = required.filter((r) => !r.ok).map((r) => r.key);
  const optional = (input.allSpecNames || []).filter((n) => n && !mustHave.includes(n) && !input.isFilled(n));
  const pct = required.length ? Math.round((required.filter((r) => r.ok).length / required.length) * 100) : 0;
  // Seller-ready = every REQUIRED field captured. The optional pool can be entirely empty and still ready
  // (a seller can quote from the decisive specs + qty + intent). This is the "stop asking" governor.
  const sellerReady = missingRequired.length === 0;
  return { pct, missingRequired, optional, sellerReady };
}

// One-line human summary for the buyer / debug ledger.
export function completenessLine(r: CompletenessResult): string {
  if (r.sellerReady) return `Ready to post (${r.pct}%) — sellers have what they need; ${r.optional.length} optional spec${r.optional.length === 1 ? '' : 's'} left if you want sharper quotes`;
  return `${r.pct}% — still needed: ${r.missingRequired.join(', ')}${r.optional.length ? ` · ${r.optional.length} optional` : ''}`;
}
