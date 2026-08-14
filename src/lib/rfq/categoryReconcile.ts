// ─── Posted-requirement category reconciliation (Theme-B #5, deep-audit 2026-08-12) ──────────────────────────────
// PURE + dependency-free so the node:test harness loads it directly. commitProduct resolves the committed product
// name to an mcat via mcatid-suggestion and (already) lets a CSL browse-twin re-anchor it. The buyer's OWN posted
// RFQ requirement ALSO carries a category_id — an independent authority the resolver used to ignore entirely, so a
// branded search string could win over the category the buyer himself filed the requirement under.
//
// This reconciles the two DETERMINISTICALLY: when the committed name NAME-MATCHES a posted requirement that resolved
// to a DIFFERENT mcat, his posted category is authoritative → swap (mirroring the CSL swap). CSL stays PRIMARY (a
// browse re-anchor is acted on first); the posted requirement is the fallback authority. A name-matched divergence is
// always RECORDED for the inspector even when we do not swap.
//
// SCOPE LIMIT (honest): this only fires on a NAME match. A SEMANTIC mismatch — a different product string for the
// same need, e.g. a browsed "Mamy Poko Pants Diaper" vs a posted "Cotton Pant Style Diaper" — is not name-matchable
// here and is handled by the LLM-1 brain via truth_rfq + the category-mismatch prompt rule (B1), not this function.

export interface RfqReq { product?: string; mcat?: string; specs?: unknown[] }
export interface Reconciliation {
  id: string;                                  // the mcat to commit (swapped or unchanged)
  swapped: boolean;                            // true when we re-anchored to the posted-requirement mcat
  authority: '' | 'posted-requirement';        // which signal won, for the inspector
  divergence: { rfq_mcat: string; rfq_product: string } | null; // a name-matched posted mcat ≠ resolvedId (recorded even without a swap)
}

const norm = (v?: string): string => (v ?? '').trim().toLowerCase();

/** Reconcile the resolved mcat against the buyer's own posted requirements. `cslSwapped` = whether the CSL browse-twin
 *  already re-anchored the category (if so, CSL wins and we only RECORD any posted-requirement divergence). */
export function reconcilePostedRequirement(committedName: string, resolvedId: string, cslSwapped: boolean, reqs: RfqReq[]): Reconciliation {
  const want = norm(committedName);
  const list = Array.isArray(reqs) ? reqs : [];
  const exact = list.find((r) => !!r.mcat && norm(r.product) === want && want.length > 0);
  // Strong containment either way, on names long enough that a shared substring is not a coincidence.
  const contains = list.find((r) => { const n = norm(r.product); return !!r.mcat && n.length >= 6 && want.length >= 6 && (n.includes(want) || want.includes(n)); });
  const twin = exact ?? contains;
  if (!twin?.mcat || twin.mcat === resolvedId) return { id: resolvedId, swapped: false, authority: '', divergence: null };
  const divergence = { rfq_mcat: twin.mcat, rfq_product: String(twin.product ?? '') };
  // Swap only when CSL did not already re-anchor AND the posted requirement carries real specs (a genuine record, not a
  // bare title) — we never trade a resolved category for an empty one.
  if (!cslSwapped && Array.isArray(twin.specs) && twin.specs.length > 0) {
    return { id: twin.mcat, swapped: true, authority: 'posted-requirement', divergence };
  }
  return { id: resolvedId, swapped: false, authority: '', divergence };
}
