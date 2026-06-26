// Deterministic test for MODULE 2 — the RFQ Ledger (mirrors src/lib/rfqLedger.ts).
// Proves the SAME 5-layer ledger covers Intent / Planner / Spec / Logistics: each becomes a Decision
// with candidates-that-lost, governance, consumption, outcome. NO LLM.

const asArr = (x) => (Array.isArray(x) ? x : []);
function buildRfqLedger(state, version = 1) {
  const facts = [], beliefs = [], decisions = [], consumption = [], outcomes = []; let fc = 0, bc = 0;
  const addFact = (jsonPath, rawValue, kind, reason, used) => { const f = { id: `rf${++fc}`, sourceNode: 'pns-insights', jsonPath, rawValue, tag: jsonPath, kind, coverage: used ? 'used' : 'ignored', coverageReason: reason, usedBy: [] }; facts.push(f); return f; };
  const mkBelief = (statement, weight, forKey, fs) => { const b = { id: `rb${++bc}`, statement, signal: forKey, weight, fromFacts: fs.map((f) => f.id), forKey }; beliefs.push(b); for (const f of fs) f.usedBy.push(b.id); return b; };
  const i = state.intent;
  if (i && (i.value || i.question)) { const cands = asArr(i.candidates); const wf = i.value ? addFact('intent.value', i.value, 'intent', 'buyer-picked', true) : null; const b = wf ? mkBelief(`end-use "${i.value}"`, i.confidence ?? 70, 'intent', [wf]) : null; decisions.push({ id: 'rd:intent', surface: 'intent', key: 'intent', value: i.value || i.question, state: i.value ? 'Confirmed' : 'Unknown', confidence: i.confidence ?? (i.value ? 100 : 0), producedBy: { kind: i.value ? 'direct' : 'llm', node: 'fusion' }, beliefs: b ? [b.id] : [], contributions: [{ source: 'pns-insights', points: i.confidence ?? 70 }], alternatives: cands.filter((c) => c.label !== i.value).map((c) => ({ value: c.label, score: c.score, whyLost: c.reason })), conflict: null, governance: { winner: i.value ? 'buyer (User)' : 'LLM', losers: cands.filter((c) => c.label !== i.value).map((c) => c.label), rule: 'User end-use > LLM > ask' }, reasoning: 'intent', version }); }
  asArr(state.planner?.questions).forEach((q) => { const gf = q.groundedIn ? addFact(`planner.${q.id}`, q.groundedIn, 'other', 'grounding', true) : null; const b = gf ? mkBelief(`grounded in ${q.groundedIn}`, q.priority ?? 70, `q:${q.id}`, [gf]) : null; decisions.push({ id: `rd:q:${q.id}`, surface: 'planner', key: `question:${q.label}`, value: q.label, state: 'Confirmed', confidence: q.priority ?? 70, producedBy: { kind: 'llm', node: 'fusion' }, beliefs: b ? [b.id] : [], contributions: [{ source: 'pns-insights', points: q.priority ?? 70 }], alternatives: asArr(state.planner?.considered).map((s) => ({ value: s.label, score: s.score, whyLost: s.reason })), conflict: null, governance: { winner: 'selected', losers: asArr(state.planner?.considered).map((s) => s.label), rule: `top ${state.planner?.budgetMax ?? 3}; rest suppressed` }, reasoning: q.reason || 'planner', version }); });
  asArr(state.specs).forEach((s) => { const auto = /cascade|infer|deduc/.test(s.source || ''); const ef = s.value ? addFact(`spec.${s.name}`, s.value, 'spec', auto ? 'cascade' : 'filled', true) : null; const b = ef ? mkBelief(auto ? `inferred ${s.value}` : `filled ${s.value}`, s.priority ?? 60, `spec:${s.name}`, [ef]) : null; decisions.push({ id: `rd:spec:${s.name}`, surface: 'spec', key: `spec:${s.name}`, value: s.value || '(asked)', state: s.value ? (auto ? 'Likely' : 'Confirmed') : 'Unknown', confidence: s.value ? (auto ? 80 : 100) : (s.priority ?? 50), producedBy: { kind: auto ? 'rule' : s.value ? 'direct' : 'llm', node: 'fusion' }, beliefs: b ? [b.id] : [], contributions: [], alternatives: [], conflict: null, governance: { winner: auto ? 'cascade' : 'user', losers: [], rule: 'spec rule' }, reasoning: 'spec', version }); });
  for (const [k, d] of Object.entries(state.logistics || {})) { if (!d?.value) continue; const lf = addFact(`logistics.${k}`, d.value, 'other', d.reason || 'deduced', true); const b = mkBelief(`deduced ${k}`, d.confidence, `logi:${k}`, [lf]); decisions.push({ id: `rd:logi:${k}`, surface: 'last-page', key: `logistics:${k}`, value: d.value, state: d.confidence >= 70 ? 'Likely' : 'Unknown', confidence: d.confidence, producedBy: { kind: 'llm', node: 'fusion' }, beliefs: [b.id], contributions: [], alternatives: [], conflict: null, governance: { winner: 'deduced', losers: [], rule: '≥70 recommend' }, reasoning: 'logi', version }); }
  for (const d of decisions) { consumption.push({ id: `c:${d.key}`, subject: d.id, entries: [{ consumer: 'final-rfq', status: 'consumed', reason: 'in the requirement' }], status: 'consumed' }); outcomes.push({ id: `o:${d.key}`, subject: d.id, changedDownstream: d.surface === 'intent' ? ['re-ranked specs'] : [], mattered: true, verdict: 'useful' }); }
  return { facts, beliefs, decisions, consumption, outcomes, decisionByKey: (k) => decisions.find((d) => d.key === k) };
}

const state = {
  intent: { value: 'Construction site power', confidence: 100, journey: 'industrial', candidates: [{ label: 'Construction site power', score: 70, reason: 'picked' }, { label: 'Manufacturing unit operations', score: 60, reason: 'manufacturer profile' }, { label: 'Backup', score: 40, reason: 'common' }] },
  planner: { budgetMax: 3, questions: [{ id: 'q1', label: 'What is your budget?', priority: 90, reason: 'category negotiates hard', groundedIn: 'category' }, { id: 'q2', label: 'Installation service?', priority: 85, reason: 'capital equipment', groundedIn: 'product' }], considered: [{ label: 'What phase?', score: 75, reason: 'covered by Phase spec' }, { label: 'Engine brand?', score: 65, reason: 'covered by spec' }] },
  specs: [{ name: 'Rated Power', value: '5 kVA', source: 'user', priority: 100 }, { name: 'Phase', value: 'Single', source: 'cascade-inferred', priority: 85 }, { name: 'Warranty', value: '', source: 'isq', priority: 40 }],
  logistics: { paymentTerms: { value: 'Credit (Post-Delivery)', confidence: 85, reason: 'capital equipment, manufacturer' } },
};

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const L = buildRfqLedger(state);

ok('intent → Decision with losing candidates as alternatives', L.decisionByKey('intent')?.value === 'Construction site power' && L.decisionByKey('intent')?.alternatives.length === 2 && L.decisionByKey('intent')?.alternatives.some((a) => a.value === 'Manufacturing unit operations'));
ok('intent governance: User-picked wins', /User end-use/.test(L.decisionByKey('intent')?.governance.rule) && L.decisionByKey('intent')?.governance.winner.includes('User'));
ok('each planner question → a Decision', L.decisions.filter((d) => d.surface === 'planner').length === 2);
ok('planner suppressed questions = alternatives that lost', L.decisionByKey('question:What is your budget?')?.alternatives.some((a) => /phase|brand/i.test(a.value)));
ok('spec auto-fill flagged (cascade → Likely 80, rule producer)', L.decisionByKey('spec:Phase')?.state === 'Likely' && L.decisionByKey('spec:Phase')?.confidence === 80 && L.decisionByKey('spec:Phase')?.producedBy.kind === 'rule');
ok('spec user-filled → Confirmed 100', L.decisionByKey('spec:Rated Power')?.state === 'Confirmed' && L.decisionByKey('spec:Rated Power')?.confidence === 100);
ok('logistics deduction → Decision (≥70 → Likely/recommend)', L.decisionByKey('logistics:paymentTerms')?.state === 'Likely');
ok('every RFQ decision is consumed by final-rfq (L4)', L.consumption.length === L.decisions.length && L.consumption.every((c) => c.entries.some((e) => e.consumer === 'final-rfq' && e.status === 'consumed')));
ok('intent outcome changed downstream (re-ranked specs)', L.outcomes.find((o) => o.subject === 'rd:intent')?.changedDownstream.includes('re-ranked specs'));
ok('total RFQ decisions = intent(1)+planner(2)+spec(3)+logi(1) = 7', L.decisions.length === 7);
ok('every fact carries a coverage verdict', L.facts.every((f) => ['used', 'ignored', 'partial'].includes(f.coverage)));

console.log(`\nrfqledgertest (Module 2 · same ledger over Intent/Planner/Spec/Logistics · candidates-that-lost · governance · consumption · outcome): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
