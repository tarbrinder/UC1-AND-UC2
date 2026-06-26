// Deterministic test for the Observatory VIEW adapter — mirrors src/lib/observatoryView.ts buildLedger
// + the section derivations that have real logic. Asserts the libs become CONSUMED (state → ledger →
// L11-L20 answers). NO LLM. (Quality-gate internals are covered by qualitygatestest.mjs.)

const nrm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const PRECEDENCE = ['Fallback', 'LLM', 'Category', 'Twin', 'Corroborated', 'ConfirmedHistory', 'VerifiedAPI', 'User'];
const precedenceRank = (s) => { const i = PRECEDENCE.indexOf(s); return i < 0 ? 0 : i; };
function resolveConflict(c) { const ranked = c.contenders.slice().sort((a, b) => precedenceRank(b.source) - precedenceRank(a.source)); const w = ranked[0], l = ranked.slice(1); return { winner: w, losers: l, rule: l.length ? `${w.source} > ${l.map((x) => x.source).join(' > ')} (precedence)` : `${w.source} (uncontested)` }; }
function readyVerdict(reqs) { const missing = reqs.filter((r) => r.required && !r.met).map((r) => r.name); return { ready: missing.length === 0, missing }; }
function deterministicVsAI(led) { return { survives: led.filter((d) => d.producedBy.kind !== 'llm'), lost: led.filter((d) => d.producedBy.kind === 'llm') }; }
function sourceROI(facts) { const m = new Map(); for (const f of facts) { const e = m.get(f.source) || { c: 0, u: 0 }; e.c++; if (f.used) e.u++; m.set(f.source, e); } return [...m.entries()].map(([source, e]) => ({ source, roiPct: e.c ? Math.round((e.u / e.c) * 100) : 0 })).sort((a, b) => b.roiPct - a.roiPct); }
function nonConsumptionMatrix(rows) { return { everywhereRejected: rows.length > 0 && rows.every((r) => r.available && !r.consumed) }; }

// ── mirror of buildLedger(state) ──
function buildLedger(state) {
  const led = [];
  const i = state.intent;
  if (i) led.push({ id: 'intent', surface: 'intent', producedBy: { kind: i.locked ? 'user' : 'llm', ref: 'deriveIntent' }, value: i.value, consumers: ['planner', 'specs', 'matching', 'summary'], consumed: !!i.value });
  const b = state.buyer;
  if (b && (b.nature || b.persona)) led.push({ id: 'buyer', surface: 'profile', producedBy: { kind: 'api', ref: 'enrichment' }, value: b.nature || b.persona, consumers: ['intent', 'planner', 'logistics', 'specs'], consumed: true });
  const c = state.category;
  if (c && c.status === 'hit') led.push({ id: 'category', surface: 'category', producedBy: { kind: 'node', ref: 'category-build' }, value: c.band, consumers: c.consume ? ['specs', 'planner'] : [], consumed: !!c.consume });
  for (const q of state.planner?.questions || []) led.push({ id: `planner:${q.id}`, surface: 'planner', producedBy: { kind: q.groundedIn ? 'code' : 'llm', ref: 'planRequirement' }, value: q.label, consumers: [], consumed: true });
  for (const s of state.specs || []) { const src = s.source || 'unknown'; const kind = src === 'user' || src === 'buyer' ? 'user' : /cascade|infer|deduc/.test(src) ? 'code' : 'api'; led.push({ id: `spec:${s.name}`, surface: 'spec', producedBy: { kind, ref: src }, value: s.value ?? '(asked)', consumers: ['matching', 'summary'], consumed: !!s.value }); }
  for (const [k, d] of Object.entries(state.logistics || {})) led.push({ id: `logi:${k}`, surface: 'last-page', producedBy: { kind: 'code', ref: 'deduceLogistics' }, value: d.value, consumers: ['summary'], consumed: true });
  return led;
}

// fixture: a realistic mid-form state
const state = {
  intent: { value: 'Manufacturing', confidence: 84, locked: false, candidates: [{ label: 'Manufacturing', score: 92 }, { label: 'Commercial', score: 71 }], decision: { threshold: 80, twin: { value: 'Manufacturing', confidence: 70, offProfile: false }, registry: null } },
  buyer: { nature: 'Manufacturer', verified: true, twinConfidence: 78, evidenceCount: 9, offProfile: false },
  category: { status: 'hit', score: 62, band: 'rich', consume: true, fuse: true, criticals: [{ name: 'Rated Power', maps_to_isq: 'Rated Power' }, { name: 'Cooling Type', maps_to_isq: 'Cooling Type' }] },
  planner: { questions: [{ id: 'q1', label: 'Rated Power', groundedIn: 'category' }, { id: 'q2', label: 'Budget band', groundedIn: '' }] },
  specs: [{ name: 'Rated Power', value: '5 kVA', source: 'user' }, { name: 'Phase', value: '', source: 'cascade-inferred' }],
  logistics: { paymentTerms: { value: 'Advance', confidence: 55, reason: 'no signal' } },
  confidence: { buyer: 78, category: 62, intent: 84, specs: 50, overall: 68 },
  overrides: [{ field: 'paymentTerms', suggested: 'Advance', chosen: 'Credit 30d' }],
};

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

const led = buildLedger(state);
ok('ledger: 8 decisions built from live state', led.length === 8); // intent + buyer + category + 2 planner + 2 specs + 1 logistics

// Q60 det-vs-AI: intent(llm) + planner q2(llm, ungrounded) are AI-only; buyer/category/q1/2 specs/logistics survive
const dva = deterministicVsAI(led);
ok('Q60 det-vs-AI: 6 survive, 2 AI-only (intent + ungrounded planner-q)', dva.survives.length === 6 && dva.lost.length === 2);
ok('Q60 det-vs-AI: grounded planner-q is code (survives), ungrounded is llm (lost)', dva.survives.some((d) => d.id === 'planner:q1') && dva.lost.some((d) => d.id === 'planner:q2'));

// Q69 READY gate
ok('Q69 READY: YES when buyer + category present', readyVerdict([{ name: 'Buyer', required: true, met: true }, { name: 'Category', required: true, met: state.category.status === 'hit' }]).ready === true);
ok('Q69 READY: NO when category missing', readyVerdict([{ name: 'Buyer', required: true, met: true }, { name: 'Category', required: true, met: false }]).ready === false);

// Q61 override → User wins
const conf = resolveConflict({ field: 'paymentTerms', contenders: [{ source: 'LLM', value: 'Advance' }, { source: 'User', value: 'Credit 30d' }] });
ok('Q61 override: User wins over LLM', conf.winner.source === 'User' && /User > LLM/.test(conf.rule));

// L11 non-consumption: a critical NOT in asked specs/planner → everywhereRejected
const asked = new Set([...state.specs.map((s) => nrm(s.name)), ...state.planner.questions.map((q) => nrm(q.label))]);
const coolingConsumed = asked.has(nrm('Cooling Type')) || [...asked].some((a) => a.includes(nrm('Cooling Type')) || nrm('Cooling Type').includes(a));
ok('Q14 non-consumption: Cooling Type available but unused → everywhereRejected', nonConsumptionMatrix([{ available: true, consumed: coolingConsumed }, { available: true, consumed: coolingConsumed }]).everywhereRejected === true);
const powerConsumed = asked.has(nrm('Rated Power'));
ok('Q14 non-consumption: Rated Power IS consumed (asked spec)', powerConsumed === true);

// L16 ROI: user/api (used) rank above llm when intent llm IS used but ungrounded planner llm is NOT
const facts = led.map((d) => ({ source: d.producedBy.kind, used: (d.consumers || []).length > 0 && !!d.consumed }));
const roi = sourceROI(facts);
ok('Q48 ROI: user source 100% used', roi.find((r) => r.source === 'user')?.roiPct === 100);
ok('Q48 ROI: llm < 100% (ungrounded planner-q consumed but no consumers)', (roi.find((r) => r.source === 'llm')?.roiPct ?? 100) < 100);

// ── n8n E1 server-trace extraction (mirror of enrichment.extractServerTrace) ──
function extractServerTrace(raw) {
  const pick = (o) => (o && typeof o === 'object' && '_trace' in o && o._trace && typeof o._trace === 'object') ? o._trace : null;
  if (Array.isArray(raw)) { for (const it of raw) { const t = pick(it); if (t) return t; } return null; }
  return pick(raw);
}
const trc = { schema: 'rfq-observatory.e1', summary: { session_id: '123_na', nodes_ok: 5, nodes_missing: 1 }, nodes: [{ node: 'Buyer Twin', status: 'ok', items_out: 1, confidence: 78 }] };
ok('E1 trace: extracts from a single object', extractServerTrace({ data: 1, _trace: trc })?.schema === 'rfq-observatory.e1');
ok('E1 trace: extracts from an array of items', extractServerTrace([{ x: 1 }, { _trace: trc }])?.summary.nodes_ok === 5);
ok('E1 trace: null when absent (E1 inactive)', extractServerTrace({ data: 1 }) === null && extractServerTrace([{ a: 1 }]) === null);

console.log(`\nobservatoryviewtest (state → ledger → L11-L20: build-ledger · det-vs-AI · READY · override-precedence · non-consumption · ROI · n8n-E1-trace-extract): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
