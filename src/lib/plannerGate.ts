// ─── PLANNER READY GATE (loader orchestration) ───────────────────────────────
// The user's worry: "don't let me move forward while the planner is still planning / category Redash
// is still loading." So the spec/question page opens ONLY when the brains it consumes are READY — and
// a transparent per-source loader shows what's still pending. The gate NEVER deadlocks:
//   • category is TIME-BOXED (prod ~2.5s, debug/fresh up to a cap) → categoryWaitElapsed releases it
//   • a "Start anyway" escape also sets categoryWaitElapsed
//   • plannerDone = plan ready OR planner not running
// Pure + deterministic → harnessable. The timing/flags live in the form; this is just the decision.

export type PlannerStatus = 'WAITING_BUYER' | 'WAITING_MCAT' | 'WAITING_CATEGORY' | 'PLANNING' | 'READY';

export interface GateSources {
  hasGlid: boolean;            // is there a buyer pull to wait on at all?
  buyerReady: boolean;         // pull finished (requirement/buyer brain hydrated) OR no glid
  needsCategory: boolean;      // a product is committed → category intel is relevant to this RFQ
  mcatResolved: boolean;       // the product resolved to an mcat (category fetch can start)
  categoryStatus: 'idle' | 'building' | 'hit' | 'error';
  categoryWaitElapsed: boolean;// time-box/cap elapsed, or the buyer hit "Start anyway"
  plannerDone: boolean;        // reqPlan ready OR the planner is not running (nothing to wait for)
}

export interface ChecklistRow { key: string; label: string; state: 'done' | 'pending' | 'skip' }
export interface GateResult { status: PlannerStatus; ready: boolean; checklist: ChecklistRow[]; categorySoft: boolean }

// categorySoft = we proceeded WITHOUT a category hit (elapsed/error) → specs render in buyer-informed
// order now and re-rank silently if/when the category lands. The loader notes this honestly.
// Are the planner's INPUTS ready? (everything the planner consumes, EXCLUDING the planner itself.)
// This is the gate that defers planRequirement so intent / spec-order / panel questions can consume
// category criticals. buyer ready · mcat resolved (or timed out) · category hit/error/timed-out.
export function plannerInputsReady(s: GateSources): boolean {
  const categoryResolved = s.categoryStatus === 'hit' || s.categoryStatus === 'error';
  const categoryReady = !s.needsCategory || categoryResolved || s.categoryWaitElapsed;
  const mcatPending = s.needsCategory && !s.mcatResolved && !s.categoryWaitElapsed;
  return s.buyerReady && !mcatPending && categoryReady;
}

export function plannerGate(s: GateSources): GateResult {
  const categoryResolved = s.categoryStatus === 'hit' || s.categoryStatus === 'error';
  const categoryReady = !s.needsCategory || categoryResolved || s.categoryWaitElapsed;
  const mcatPending = s.needsCategory && !s.mcatResolved && !s.categoryWaitElapsed;
  const categorySoft = s.needsCategory && s.categoryStatus !== 'hit' && (s.categoryStatus === 'error' || s.categoryWaitElapsed);

  let status: PlannerStatus;
  if (!s.buyerReady) status = 'WAITING_BUYER';
  else if (mcatPending) status = 'WAITING_MCAT';
  else if (!categoryReady) status = 'WAITING_CATEGORY';
  else if (!s.plannerDone) status = 'PLANNING';
  else status = 'READY';

  const catState: ChecklistRow['state'] = !s.needsCategory
    ? 'skip'
    : s.categoryStatus === 'hit'
      ? 'done'
      : (s.categoryStatus === 'error' || s.categoryWaitElapsed)
        ? 'skip'        // proceeding without it (soft)
        : 'pending';

  const checklist: ChecklistRow[] = [
    { key: 'buyer', label: 'Buyer profile & history', state: !s.hasGlid ? 'skip' : s.buyerReady ? 'done' : 'pending' },
    { key: 'signals', label: 'Conversational signals', state: !s.hasGlid ? 'skip' : s.buyerReady ? 'done' : 'pending' },
    { key: 'category', label: 'Category intelligence (seller patterns)', state: catState },
    { key: 'planner', label: 'Planning your questions', state: status === 'READY' ? 'done' : 'pending' },
  ];

  return { status, ready: status === 'READY', checklist, categorySoft };
}

// Human label for the current wait (narrator line above the checklist).
export function gateHeadline(status: PlannerStatus): string {
  switch (status) {
    case 'WAITING_BUYER': return 'Loading your profile & past requirements…';
    case 'WAITING_MCAT': return 'Identifying the category…';
    case 'WAITING_CATEGORY': return 'Learning what sellers ask in this category…';
    case 'PLANNING': return 'Planning the sharpest set of questions…';
    case 'READY': return 'Ready.';
  }
}
