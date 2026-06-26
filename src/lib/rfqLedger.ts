// ─── MODULE 2 · RFQ LEDGER — the SAME Decision Ledger over Intent / Planner / Spec / Logistics ──────
// PURE · deterministic · NO LLM. Proves the universal-ledger thesis: Buyer Profile was consumer #1;
// the RFQ surfaces (intent question, each planner question, each spec, each last-page deduction) are
// MORE consumers of the identical Fact→Belief→Decision→Consumption→Outcome model. Renders in the same
// BuyerLedgerView (it accepts any Ledger). Built from the RFQ's already-computed inspector state — no
// new LLM/compute. Harnessed in scripts/rfqledgertest.mjs.

import { assemble, type Fact, type Belief, type Decision, type Consumption, type Outcome, type Ledger, type SourceNode } from './ledger';
import type { InspectorState } from './inspectorData';

// the slice of the RFQ's live state this consumes (a subset of V4's InspectorState — structural)
export interface RfqLedgerState {
  intent?: { value: string | null; confidence?: number; journey?: string; question?: string; candidates?: Array<{ label: string; score: number; reason: string }> | null };
  planner?: { archetype?: string; questions?: Array<{ id: string; label: string; priority?: number; reason?: string; groundedIn?: string }>; considered?: Array<{ label: string; score: number; reason: string }> | null; budgetMax?: number };
  specs?: Array<{ name: string; value?: string; source?: string; priority?: number; sellerFreq?: number; reason?: string }>;
  logistics?: Record<string, { value: string; confidence: number; reason: string }>;
}

const asArr = <T,>(x: T[] | null | undefined): T[] => (Array.isArray(x) ? x : []);

// rfq grounding sources → reuse the SourceNode space (planner/profile are the "nodes" for RFQ decisions)
const RFQ_SRC: SourceNode = 'pns-insights'; // grounding facts ride on a generic source slot for display

export function buildRfqLedger(state: RfqLedgerState, version = 1): Ledger {
  const facts: Fact[] = []; const beliefs: Belief[] = []; const decisions: Decision[] = []; const consumption: Consumption[] = []; const outcomes: Outcome[] = [];
  let fc = 0, bc = 0;
  const addFact = (jsonPath: string, rawValue: string, kind: Fact['kind'], reason: string, used: boolean): Fact => { const f: Fact = { id: `rf${++fc}`, sourceNode: RFQ_SRC, api: 'RFQ engine', jsonPath, rawValue, tag: jsonPath, kind, coverage: used ? 'used' : 'ignored', coverageReason: reason, usedBy: [] }; facts.push(f); return f; };
  const mkBelief = (statement: string, weight: number, forKey: string, fs: Fact[]): Belief => { const b: Belief = { id: `rb${++bc}`, statement, signal: forKey, weight, via: 'rule', fromFacts: fs.map((f) => f.id), forKey }; beliefs.push(b); for (const f of fs) f.usedBy.push(b.id); return b; };

  // ── INTENT decision (the page-1 question + its winning end-use) ──
  const i = state.intent;
  if (i && (i.value || i.question)) {
    const cands = asArr(i.candidates);
    const winnerF = i.value ? addFact('intent.value', i.value, 'intent', 'buyer-picked / top candidate', true) : null;
    const b = winnerF ? mkBelief(`end-use resolved to "${i.value}"`, i.confidence ?? 70, 'intent', [winnerF]) : null;
    decisions.push({
      id: 'rd:intent', surface: 'intent', key: 'intent', value: i.value || (i.question || 'asking'),
      state: i.value ? 'Confirmed' : 'Unknown', confidence: i.confidence ?? (i.value ? 100 : 0),
      producedBy: { kind: i.value ? 'direct' : 'llm', ref: 'deriveIntent', node: 'fusion' },
      beliefs: b ? [b.id] : [], contributions: [{ source: RFQ_SRC, points: i.confidence ?? 70 }],
      alternatives: cands.filter((c) => c.label !== i.value).map((c) => ({ value: c.label, score: c.score, whyLost: c.reason })),
      conflict: null,
      governance: { winner: i.value ? 'buyer (User)' : 'LLM candidate', losers: cands.filter((c) => c.label !== i.value).map((c) => c.label), rule: 'User-picked end-use > LLM candidates > ask' },
      reasoning: `journey ${i.journey || '—'} · ${cands.length} candidates`, version,
    });
  }

  // ── PLANNER questions (each asked question = a Decision; suppressed = alternatives that lost) ──
  const asked = asArr(state.planner?.questions);
  const suppressed = asArr(state.planner?.considered);
  asked.forEach((q) => {
    const gf = q.groundedIn ? addFact(`planner.${q.id}.groundedIn`, q.groundedIn, 'other', 'grounding for this question', true) : null;
    const b = gf ? mkBelief(`asked because grounded in ${q.groundedIn}`, q.priority ?? 70, `q:${q.id}`, [gf]) : null;
    decisions.push({
      id: `rd:q:${q.id}`, surface: 'planner', key: `question:${q.label}`, value: q.label,
      state: 'Confirmed', confidence: q.priority ?? 70, producedBy: { kind: 'llm', ref: 'planRequirement', node: 'fusion' },
      beliefs: b ? [b.id] : [], contributions: [{ source: RFQ_SRC, points: q.priority ?? 70 }],
      alternatives: suppressed.map((s) => ({ value: s.label, score: s.score, whyLost: s.reason })),
      conflict: null,
      governance: { winner: `selected (priority ${q.priority ?? '—'})`, losers: suppressed.map((s) => s.label), rule: `top ${state.planner?.budgetMax ?? 3} by priority; rest suppressed (covered/contradiction/low-conf)` },
      reasoning: q.reason || 'planner-selected', version,
    });
  });

  // ── SPECS (each spec = a Decision; auto-filled vs asked via producedBy) ──
  asArr(state.specs).forEach((s) => {
    const auto = /cascade|infer|deduc/.test(s.source || '');
    const ef = s.value ? addFact(`spec.${s.name}`, `${s.value} (${s.source || 'user'})`, 'spec', auto ? 'cascade-inferred fill' : 'filled', true) : null;
    const b = ef ? mkBelief(auto ? `inferred "${s.value}" from cascade` : `filled "${s.value}"`, s.priority ?? 60, `spec:${s.name}`, [ef]) : null;
    decisions.push({
      id: `rd:spec:${s.name}`, surface: 'spec', key: `spec:${s.name}`, value: s.value || '(asked)',
      state: s.value ? (auto ? 'Likely' : 'Confirmed') : 'Unknown', confidence: s.value ? (auto ? 80 : 100) : (s.priority ?? 50),
      producedBy: { kind: auto ? 'rule' : s.value ? 'direct' : 'llm', ref: s.source || 'isq', node: 'fusion' },
      beliefs: b ? [b.id] : [], contributions: [{ source: RFQ_SRC, points: s.value ? (auto ? 80 : 100) : (s.priority ?? 50) }],
      alternatives: [],
      conflict: null,
      governance: auto ? { winner: 'cascade inference', losers: [], rule: 'inferred — buyer confirms (never silently shipped)' } : { winner: s.value ? 'buyer (User)' : 'ISQ schema', losers: [], rule: 'spec from buyer > inference > ask' },
      reasoning: s.reason || (auto ? 'cascade' : s.value ? 'user' : 'asked'), version,
    });
  });

  // ── LOGISTICS (last-page deductions) ──
  for (const [k, d] of Object.entries(state.logistics || {})) {
    if (!d?.value) continue;
    const lf = addFact(`logistics.${k}`, `${d.value} (${d.confidence}%)`, 'other', d.reason || 'deduced', true);
    const b = mkBelief(`deduced ${k} = ${d.value}`, d.confidence, `logi:${k}`, [lf]);
    decisions.push({
      id: `rd:logi:${k}`, surface: 'last-page', key: `logistics:${k}`, value: d.value,
      state: d.confidence >= 70 ? 'Likely' : 'Unknown', confidence: d.confidence,
      producedBy: { kind: 'llm', ref: 'deduceLogistics', node: 'fusion' }, beliefs: [b.id],
      contributions: [{ source: RFQ_SRC, points: d.confidence }], alternatives: [], conflict: null,
      governance: { winner: d.confidence >= 70 ? 'deduced (recommend)' : 'asked', losers: [], rule: 'deduce only ≥70% → recommend; else ask (never silently fill)' },
      reasoning: d.reason || 'logistics deduction', version,
    });
  }

  // ── L4 CONSUMPTION + L5 OUTCOME — RFQ decisions feed matching/the final RFQ ──
  for (const d of decisions) {
    consumption.push({ id: `c:${d.key}`, subject: d.id, entries: [
      { consumer: 'final-rfq', status: 'consumed', reason: 'written into the requirement sent to sellers' },
      { consumer: 'supplier-matching', status: d.surface === 'intent' || d.surface === 'spec' ? 'consumed' : 'available', reason: d.surface === 'intent' || d.surface === 'spec' ? 'narrows supplier fit' : 'available to matching' },
    ], status: 'consumed' });
    outcomes.push({ id: `o:${d.key}`, subject: d.id, changedDownstream: d.surface === 'intent' ? ['re-ranked specs', 'shaped planner'] : [], mattered: true, verdict: 'useful' });
  }

  return assemble(facts, beliefs, decisions, consumption, outcomes, [{ version, trigger: 'RFQ build', changed: decisions.map((d) => d.key) }]);
}

// P6 · LIVE RFQ — project V4's full InspectorState onto the RfqLedgerState slice buildRfqLedger consumes.
// InspectorState is a structural superset (intent/planner/specs/logistics share field names), so this is a
// pure projection — no LLM, no compute. MainApp feeds the result into buildRfqLedger so the RFQ Ledger shows
// the REAL run the buyer just completed instead of the static demo. `null`/empty in → an empty (honest) ledger.
export function rfqStateFromInspector(s: InspectorState | null | undefined): RfqLedgerState {
  if (!s) return {};
  return {
    intent: s.intent ? { value: s.intent.value, confidence: s.intent.confidence, journey: s.intent.journey, question: s.intent.question, candidates: s.intent.candidates ?? null } : undefined,
    planner: s.planner ? { archetype: s.planner.archetype, questions: s.planner.questions, considered: s.planner.considered ?? null, budgetMax: s.planner.budgetMax } : undefined,
    specs: s.specs,
    logistics: s.logistics,
  };
}
