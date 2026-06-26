// Deterministic test for the PLANNER READY GATE — mirrors src/lib/plannerGate.ts.
// The user's worry: never move forward while a dependency is still processing — but NEVER deadlock.
// Proves: 4 states in order, category time-box releases, error/no-glid/no-category degrade, READY reachable.

function plannerInputsReady(s) {
  const categoryResolved = s.categoryStatus === 'hit' || s.categoryStatus === 'error';
  const categoryReady = !s.needsCategory || categoryResolved || s.categoryWaitElapsed;
  const mcatPending = s.needsCategory && !s.mcatResolved && !s.categoryWaitElapsed;
  return s.buyerReady && !mcatPending && categoryReady;
}
function plannerGate(s) {
  const categoryResolved = s.categoryStatus === 'hit' || s.categoryStatus === 'error';
  const categoryReady = !s.needsCategory || categoryResolved || s.categoryWaitElapsed;
  const mcatPending = s.needsCategory && !s.mcatResolved && !s.categoryWaitElapsed;
  const categorySoft = s.needsCategory && s.categoryStatus !== 'hit' && (s.categoryStatus === 'error' || s.categoryWaitElapsed);
  let status;
  if (!s.buyerReady) status = 'WAITING_BUYER';
  else if (mcatPending) status = 'WAITING_MCAT';
  else if (!categoryReady) status = 'WAITING_CATEGORY';
  else if (!s.plannerDone) status = 'PLANNING';
  else status = 'READY';
  const catState = !s.needsCategory ? 'skip' : s.categoryStatus === 'hit' ? 'done' : (s.categoryStatus === 'error' || s.categoryWaitElapsed) ? 'skip' : 'pending';
  const checklist = [
    { key: 'buyer', label: 'Buyer profile & history', state: !s.hasGlid ? 'skip' : s.buyerReady ? 'done' : 'pending' },
    { key: 'signals', label: 'Conversational signals', state: !s.hasGlid ? 'skip' : s.buyerReady ? 'done' : 'pending' },
    { key: 'category', label: 'Category intelligence (seller patterns)', state: catState },
    { key: 'planner', label: 'Planning your questions', state: status === 'READY' ? 'done' : 'pending' },
  ];
  return { status, ready: status === 'READY', checklist, categorySoft };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const base = { hasGlid: true, buyerReady: true, needsCategory: true, mcatResolved: true, categoryStatus: 'hit', categoryWaitElapsed: false, plannerDone: true };

// ── the states, in order of precedence ──
ok('buyer pull in flight → WAITING_BUYER', plannerGate({ ...base, buyerReady: false }).status === 'WAITING_BUYER');
ok('product committed, mcat not resolved yet → WAITING_MCAT', plannerGate({ ...base, mcatResolved: false, categoryStatus: 'idle' }).status === 'WAITING_MCAT');
ok('buyer ready, category building (no time-box yet) → WAITING_CATEGORY', plannerGate({ ...base, categoryStatus: 'building' }).status === 'WAITING_CATEGORY');
ok('buyer+category ready, planner running → PLANNING', plannerGate({ ...base, plannerDone: false }).status === 'PLANNING');
ok('all ready → READY', plannerGate(base).status === 'READY' && plannerGate(base).ready === true);

// ── precedence: buyer wait beats category wait beats planning ──
ok('precedence: not-ready buyer wins even if category building', plannerGate({ ...base, buyerReady: false, categoryStatus: 'building', plannerDone: false }).status === 'WAITING_BUYER');

// ── THE TIME-BOX: category never blocks forever ──
ok('category still building BUT wait elapsed → releases past WAITING_CATEGORY', plannerGate({ ...base, categoryStatus: 'building', categoryWaitElapsed: true }).status === 'READY');
ok('time-box release marks categorySoft (will re-rank later)', plannerGate({ ...base, categoryStatus: 'building', categoryWaitElapsed: true }).categorySoft === true);
ok('category ERROR releases (not stuck)', plannerGate({ ...base, categoryStatus: 'error' }).status === 'READY');
ok('category error → categorySoft true', plannerGate({ ...base, categoryStatus: 'error' }).categorySoft === true);
ok('category HIT → not soft (real intel used)', plannerGate(base).categorySoft === false);

// ── degrade: no glid / no category ──
ok('no glid (cold RFQ) → buyer + signals rows SKIP', (() => { const c = plannerGate({ ...base, hasGlid: false }).checklist; return c[0].state === 'skip' && c[1].state === 'skip'; })());
ok('no mcat (category irrelevant) → category row SKIP, still can be READY', (() => { const g = plannerGate({ ...base, needsCategory: false, categoryStatus: 'idle' }); return g.checklist[2].state === 'skip' && g.status === 'READY'; })());

// ── checklist reflects reality ──
ok('checklist: category building → category row pending', plannerGate({ ...base, categoryStatus: 'building' }).checklist[2].state === 'pending');
ok('checklist: time-boxed building → category row skip (continuing without)', plannerGate({ ...base, categoryStatus: 'building', categoryWaitElapsed: true }).checklist[2].state === 'skip');
ok('checklist: planner row done only at READY', plannerGate({ ...base, plannerDone: false }).checklist[3].state === 'pending' && plannerGate(base).checklist[3].state === 'done');

// ── READY is always reachable from a stuck category via the escape ──
ok('STUCK category + Start-anyway (elapsed) → READY (no deadlock)', plannerGate({ hasGlid: true, buyerReady: true, needsCategory: true, categoryStatus: 'building', categoryWaitElapsed: true, plannerDone: true }).ready === true);

// ── planner not running (no plan needed) still reaches READY ──
ok('planner not running (plannerDone via !dynLoading) → READY', plannerGate({ ...base, plannerDone: true }).status === 'READY');

// ════ plannerInputsReady — the EXECUTION gate (category must be ready BEFORE the planner runs) ════
ok('planner does NOT run while category is building (the bug: planner ran before category)', plannerInputsReady({ ...base, categoryStatus: 'building' }) === false);
ok('planner does NOT run while mcat is still resolving', plannerInputsReady({ ...base, mcatResolved: false, categoryStatus: 'idle' }) === false);
ok('planner does NOT run while buyer pull in flight', plannerInputsReady({ ...base, buyerReady: false }) === false);
ok('planner RUNS once category HIT (consumes criticals)', plannerInputsReady(base) === true);
ok('planner RUNS after category time-box (prod soft) — no infinite wait', plannerInputsReady({ ...base, categoryStatus: 'building', categoryWaitElapsed: true }) === true);
ok('planner RUNS on category error (degrade)', plannerInputsReady({ ...base, categoryStatus: 'error' }) === true);
ok('planner RUNS immediately when no category needed (cold/no-product)', plannerInputsReady({ ...base, needsCategory: false, mcatResolved: false, categoryStatus: 'idle' }) === true);
ok('mcat-stuck + time-box elapsed → planner runs (no deadlock)', plannerInputsReady({ ...base, mcatResolved: false, categoryStatus: 'idle', categoryWaitElapsed: true }) === true);

// ── the headline regression: the exact dry-run failure must now be PREVENTED ──
ok('REGRESSION (Jaiveer/paper): category building → planner gated OFF (was running)', plannerInputsReady({ hasGlid: true, buyerReady: true, needsCategory: true, mcatResolved: true, categoryStatus: 'building', categoryWaitElapsed: false, plannerDone: false }) === false);

console.log(`\nplannergatetest (5 states +WAITING_MCAT · precedence · time-box never deadlocks · plannerInputsReady gates execution before category · regression-locked): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
