// Deterministic test for REPLAY (P5) — mirrors the PURE parts of src/lib/replay.ts (buildSnapshot, diffRuns).
// Asserts: snapshot compaction + Run A vs Run B diff (intent/category/questions changed + added/removed Qs). NO LLM.

function buildSnapshot(state, opts) {
  return {
    id: opts.id, at: opts.at, label: opts.label,
    buyer: state.buyer?.nature ?? state.buyer?.persona ?? null, buyerVerified: state.buyer?.verified,
    intent: state.intent?.value ?? null, intentConf: state.intent?.confidence,
    category: state.category?.band ?? 'none', categoryScore: state.category?.score, categoryConsumed: state.category?.consume,
    questionCount: state.planner?.questions?.length ?? 0,
    questions: (state.planner?.questions || []).map((q) => q.label),
    specCount: (state.specs || []).length, filledSpecs: (state.specs || []).filter((s) => s.value).length,
    overall: state.confidence?.overall,
  };
}
function diffRuns(a, b) {
  const mk = (field, av, bv) => ({ field, a: String(av ?? '—'), b: String(bv ?? '—'), changed: String(av ?? '') !== String(bv ?? '') });
  const rows = [mk('buyer', a.buyer, b.buyer), mk('intent', a.intent, b.intent), mk('category', a.category, b.category), mk('category fused', a.categoryConsumed, b.categoryConsumed), mk('questions', a.questionCount, b.questionCount), mk('overall conf', a.overall, b.overall)];
  const aq = new Set(a.questions.map((x) => x.toLowerCase())); const bq = new Set(b.questions.map((x) => x.toLowerCase()));
  const questionsAdded = b.questions.filter((q) => !aq.has(q.toLowerCase()));
  const questionsRemoved = a.questions.filter((q) => !bq.has(q.toLowerCase()));
  return { rows, questionsAdded, questionsRemoved, anyChange: rows.some((r) => r.changed) || !!questionsAdded.length || !!questionsRemoved.length };
}

const runA = buildSnapshot({
  intent: { value: 'Commercial', confidence: 70 },
  category: { band: 'thin', score: 40, consume: false },
  planner: { questions: [{ label: 'Budget' }, { label: 'Phase' }, { label: 'Installation' }] },
  specs: [{ name: 'Power', value: '5kVA' }, { name: 'Phase', value: '' }],
  confidence: { overall: 58 },
}, { id: 'A', at: 1, label: 'yesterday' });

const runB = buildSnapshot({
  intent: { value: 'Manufacturing', confidence: 86 },           // intent changed
  category: { band: 'rich', score: 72, consume: true },          // category improved + now fused
  planner: { questions: [{ label: 'Budget' }, { label: 'Rated Power' }] }, // Phase+Installation dropped, Rated Power added
  specs: [{ name: 'Power', value: '5kVA' }, { name: 'Phase', value: '3-phase' }],
  confidence: { overall: 74 },
}, { id: 'B', at: 2, label: 'today' });

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

ok('snapshot compacts intent + question list', runA.intent === 'Commercial' && runA.questionCount === 3 && runB.questions.includes('Rated Power'));
const d = diffRuns(runA, runB);
ok('diff: intent changed Commercial→Manufacturing', d.rows.find((r) => r.field === 'intent')?.changed === true);
ok('diff: category fused flipped false→true', d.rows.find((r) => r.field === 'category fused').a === 'false' && d.rows.find((r) => r.field === 'category fused').b === 'true');
ok('diff: question count 3→2 flagged changed', d.rows.find((r) => r.field === 'questions')?.changed === true);
ok('diff: Rated Power added', d.questionsAdded.includes('Rated Power') && d.questionsAdded.length === 1);
ok('diff: Phase + Installation removed', d.questionsRemoved.includes('Phase') && d.questionsRemoved.includes('Installation') && d.questionsRemoved.length === 2);
ok('diff: anyChange true', d.anyChange === true);
// identical runs → no change
const d0 = diffRuns(runA, buildSnapshot({ intent: { value: 'Commercial', confidence: 70 }, category: { band: 'thin', score: 40, consume: false }, planner: { questions: [{ label: 'Budget' }, { label: 'Phase' }, { label: 'Installation' }] }, specs: [{ name: 'Power', value: '5kVA' }, { name: 'Phase', value: '' }], confidence: { overall: 58 } }, { id: 'A2', at: 3, label: 'same' }));
ok('diff: identical run → anyChange false', d0.anyChange === false && d0.questionsAdded.length === 0 && d0.questionsRemoved.length === 0);

// W4 — buyer identity captured + diffed (buyer-vs-buyer compare)
const bA = buildSnapshot({ buyer: { nature: 'Trader', verified: true }, planner: { questions: [] }, specs: [] }, { id: 'bA', at: 1, label: 'buyerA' });
const bB = buildSnapshot({ buyer: { nature: 'Manufacturer', verified: true }, planner: { questions: [] }, specs: [] }, { id: 'bB', at: 2, label: 'buyerB' });
ok('W4 buyer captured', bA.buyer === 'Trader' && bB.buyer === 'Manufacturer');
ok('W4 buyer diff flagged Trader→Manufacturer', diffRuns(bA, bB).rows.find((r) => r.field === 'buyer')?.changed === true);

console.log(`\nreplaytest (P5 · snapshot compaction · Run A↔B diff: buyer/intent/category/fused/question-count · Qs added-removed · no-change · W4 buyer-compare): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
