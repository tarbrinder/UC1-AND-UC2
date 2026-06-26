// ─── QUESTION GRAPH (Phase C) ─────────────────────────────────────────────────
// Today the planner emits a FLAT list, so it asks "Usage?" [Photocopy · … · Notebooks] even though the
// buyer's intent is already "Notebook Manufacturing Inputs" — the same question twice. A graph models
// the RELATIONSHIP: an upstream answer (intent / a filled spec) can IMPLY a downstream spec's value, so
// we prefill it instead of asking. Pure · deterministic · NO category literals (token overlap only) ·
// NO LLM. The edges + order also drive the debug visualisation.
//
// The mechanism is option-implication: for a spec with options, the option whose tokens overlap the
// upstream answer most is the implied value (intent "Notebook Manufacturing" → Usage = "Notebooks").

export interface QNode { id: string; kind: 'intent' | 'spec'; name: string; options?: string[]; answered?: string }
export interface QEdge { from: string; to: string; relation: 'implies' }
export interface ImpliedSpec { specId: string; specName: string; impliedValue: string; via: string; viaValue: string; confidence: number }
export interface QuestionGraphResult {
  edges: QEdge[];
  implied: ImpliedSpec[]; // specs whose value an upstream answer implies → prefill, don't ask
  order: string[];        // ask order: answered-upstream first, then specs (implied ones drop to the end)
}

const STOP = new Set(['for', 'the', 'and', 'with', 'from', 'your', 'our', 'this', 'that', 'any', 'all', 'per', 'via', 'new', 'use', 'used', 'type', 'types', 'input', 'inputs', 'material', 'materials', 'other', 'general', 'standard']);
function toks(s: unknown): Set<string> {
  const out = new Set<string>();
  for (let w of String(s ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith('s')) w = w.slice(0, -1); // crude singularise (notebooks→notebook)
    out.add(w);
  }
  return out;
}
function overlap(a: Set<string>, b: Set<string>): number { let n = 0; for (const t of a) if (b.has(t)) n++; return n; }

// Given the nodes + the known upstream answers, find which specs are IMPLIED. An upstream answer
// (an intent value, or another answered node's value) implies a spec when one of the spec's options
// shares ≥1 meaningful token with that answer AND that option wins clearly over the others.
export function buildQuestionGraph(nodes: QNode[]): QuestionGraphResult {
  const upstream = nodes.filter((n) => n.kind === 'intent' && (n.answered || '').trim());
  const specs = nodes.filter((n) => n.kind === 'spec');
  const edges: QEdge[] = [];
  const implied: ImpliedSpec[] = [];

  for (const spec of specs) {
    if ((spec.answered || '').trim()) continue;           // already answered → not implied/asked
    const opts = (spec.options || []).filter(Boolean);
    if (!opts.length) continue;
    let best: ImpliedSpec | null = null;
    for (const up of upstream) {
      const upToks = toks(up.answered);
      if (!upToks.size) continue;
      // score each option by token overlap with the upstream answer; pick the clear winner
      const scored = opts.map((o) => ({ o, s: overlap(toks(o), upToks) })).sort((a, b) => b.s - a.s);
      const top = scored[0];
      if (!top || top.s < 1) continue;
      const second = scored[1]?.s ?? 0;
      if (top.s <= second) continue;                      // ambiguous (two options tie) → don't guess
      const confidence = Math.min(90, 55 + top.s * 15);
      if (!best || confidence > best.confidence) best = { specId: spec.id, specName: spec.name, impliedValue: top.o, via: up.id, viaValue: up.answered || '', confidence };
    }
    if (best) { implied.push(best); edges.push({ from: best.via, to: spec.id, relation: 'implies' }); }
  }

  // Order: answered upstream first, then specs that still need asking, with implied specs LAST (they're
  // effectively answered by the graph — prefill, ask only if the buyer opens them).
  const impliedIds = new Set(implied.map((i) => i.specId));
  const order = [
    ...upstream.map((n) => n.id),
    ...specs.filter((s) => !impliedIds.has(s.id)).map((s) => s.id),
    ...specs.filter((s) => impliedIds.has(s.id)).map((s) => s.id),
  ];
  return { edges, implied, order };
}
