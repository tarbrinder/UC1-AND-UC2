// Deterministic test for the QUESTION GRAPH (Phase C) — mirrors src/lib/questionGraph.ts.
// The headline: intent "Notebook Manufacturing Inputs" IMPLIES the Usage spec = "Notebooks", so we
// prefill it instead of asking the same thing twice (the Jaiveer/paper duplication). NO LLM, NO category literals.

const STOP = new Set(['for','the','and','with','from','your','our','this','that','any','all','per','via','new','use','used','type','types','input','inputs','material','materials','other','general','standard']);
function toks(s) { const out = new Set(); for (let w of String(s ?? '').toLowerCase().split(/[^a-z0-9]+/)) { if (w.length < 3 || STOP.has(w)) continue; if (w.length > 4 && w.endsWith('s')) w = w.slice(0, -1); out.add(w); } return out; }
function overlap(a, b) { let n = 0; for (const t of a) if (b.has(t)) n++; return n; }
function buildQuestionGraph(nodes) {
  const upstream = nodes.filter((n) => n.kind === 'intent' && (n.answered || '').trim());
  const specs = nodes.filter((n) => n.kind === 'spec');
  const edges = [], implied = [];
  for (const spec of specs) {
    if ((spec.answered || '').trim()) continue;
    const opts = (spec.options || []).filter(Boolean);
    if (!opts.length) continue;
    let best = null;
    for (const up of upstream) {
      const upToks = toks(up.answered); if (!upToks.size) continue;
      const scored = opts.map((o) => ({ o, s: overlap(toks(o), upToks) })).sort((a, b) => b.s - a.s);
      const top = scored[0]; if (!top || top.s < 1) continue;
      const second = scored[1]?.s ?? 0; if (top.s <= second) continue;
      const confidence = Math.min(90, 55 + top.s * 15);
      if (!best || confidence > best.confidence) best = { specId: spec.id, specName: spec.name, impliedValue: top.o, via: up.id, viaValue: up.answered || '', confidence };
    }
    if (best) { implied.push(best); edges.push({ from: best.via, to: spec.id, relation: 'implies' }); }
  }
  const impliedIds = new Set(implied.map((i) => i.specId));
  const order = [...upstream.map((n) => n.id), ...specs.filter((s) => !impliedIds.has(s.id)).map((s) => s.id), ...specs.filter((s) => impliedIds.has(s.id)).map((s) => s.id)];
  return { edges, implied, order };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ════ THE JAIVEER DUPLICATION: intent "Notebook Manufacturing Inputs" ⟹ Usage = "Notebooks" ════
const nodes = [
  { id: 'intent', kind: 'intent', name: 'Use case', answered: 'Notebook Manufacturing Inputs' },
  { id: 'usage', kind: 'spec', name: 'Usage', options: ['Photocopy', 'Printing', 'Packaging', 'Notebooks', 'Craft', 'Office Use'] },
  { id: 'gsm', kind: 'spec', name: 'GSM', options: ['55 GSM', '60 GSM', '70 GSM', '80 GSM'] },
  { id: 'sheet', kind: 'spec', name: 'Sheet Size', options: ['A4', 'A3', 'A5', 'Legal'] },
];
const g = buildQuestionGraph(nodes);
const usageImplied = g.implied.find((i) => i.specId === 'usage');
ok('HEADLINE: Usage is IMPLIED by the intent (not asked again)', !!usageImplied);
ok('HEADLINE: implied value = "Notebooks"', usageImplied?.impliedValue === 'Notebooks');
ok('HEADLINE: via the intent node', usageImplied?.via === 'intent');
ok('HEADLINE: edge intent→usage recorded', g.edges.some((e) => e.from === 'intent' && e.to === 'usage'));
ok('GSM is NOT implied (no token overlap with intent) → still asked', !g.implied.some((i) => i.specId === 'gsm'));
ok('Sheet Size NOT implied → still asked', !g.implied.some((i) => i.specId === 'sheet'));
ok('order: implied Usage drops to the END (ask the open ones first)', g.order.indexOf('usage') > g.order.indexOf('gsm'));
ok('order: intent (answered upstream) leads', g.order[0] === 'intent');

// ════ ambiguity guard — two options tie on overlap → DON'T guess ════
const tie = buildQuestionGraph([
  { id: 'intent', kind: 'intent', name: 'Use', answered: 'office printing copier' },
  { id: 'usage', kind: 'spec', name: 'Usage', options: ['Office Use', 'Printing'] }, // both overlap → tie
]);
ok('ambiguous (Office Use ~ Printing both match) → NOT implied (no guess)', !tie.implied.length);

// ════ generic English, no category literals ════
const gen = buildQuestionGraph([
  { id: 'intent', kind: 'intent', name: 'Use', answered: 'industrial welding work' },
  { id: 'app', kind: 'spec', name: 'Application', options: ['Welding', 'Cutting', 'Brazing'] },
]);
ok('generic: "welding work" intent ⟹ Application = Welding', gen.implied.find((i) => i.specId === 'app')?.impliedValue === 'Welding');

// ════ already-answered spec is left alone; no intent → nothing implied ════
ok('answered spec → not re-implied', !buildQuestionGraph([{ id: 'intent', kind: 'intent', name: 'U', answered: 'notebooks' }, { id: 'usage', kind: 'spec', name: 'Usage', options: ['Notebooks'], answered: 'Notebooks' }]).implied.length);
ok('no intent answered → nothing implied, order = specs as-is', (() => { const r = buildQuestionGraph([{ id: 'usage', kind: 'spec', name: 'Usage', options: ['Notebooks'] }]); return r.implied.length === 0 && r.order.join() === 'usage'; })());
ok('confidence scales with overlap strength (single-token ≈ 70)', usageImplied.confidence >= 70 && usageImplied.confidence <= 90);

// ════ graceful ════
ok('empty nodes → empty graph', (() => { const r = buildQuestionGraph([]); return r.implied.length === 0 && r.edges.length === 0 && r.order.length === 0; })());
ok('spec with no options → never implied (nothing to prefill)', !buildQuestionGraph([{ id: 'intent', kind: 'intent', name: 'U', answered: 'notebooks' }, { id: 's', kind: 'spec', name: 'Notes' }]).implied.length);

console.log(`\nquestiongraphtest (Phase C: intent⟹spec option-implication · Jaiveer Usage dedup · ambiguity guard · generic · order · graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
