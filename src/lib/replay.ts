// ─── REPLAY (P5 · Gap 6) — snapshot each run, diff Run A vs Run B (the LangSmith-style regression view) ──
// PURE snapshot + diff (harnessed) + thin localStorage persistence (guarded). Answers "what changed
// between yesterday's run and today's?" — intent / category / questions / confidence, plus which exact
// questions were added or dropped. No LLM, no infra: snapshots are taken client-side from InspectorState.

import type { InspectorState } from './inspectorData';

export interface RunSnapshot {
  id: string; at: number; label: string;
  buyer: string | null; buyerVerified?: boolean;     // identity → buyer-vs-buyer compare (W4 · Q91)
  intent: string | null; intentConf?: number;
  category: string; categoryScore?: number; categoryConsumed?: boolean;
  questionCount: number; questions: string[];
  specCount: number; filledSpecs: number;
  overall?: number;
}

// PURE — compact a live InspectorState into a comparable snapshot.
export function buildSnapshot(state: InspectorState, opts: { id: string; at: number; label: string }): RunSnapshot {
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

export interface RunDiffRow { field: string; a: string; b: string; changed: boolean }
export interface RunDiff { rows: RunDiffRow[]; questionsAdded: string[]; questionsRemoved: string[]; anyChange: boolean }
// PURE — diff two runs (A = older, B = newer).
export function diffRuns(a: RunSnapshot, b: RunSnapshot): RunDiff {
  const mk = (field: string, av: unknown, bv: unknown): RunDiffRow => ({ field, a: String(av ?? '—'), b: String(bv ?? '—'), changed: String(av ?? '') !== String(bv ?? '') });
  const rows = [
    mk('buyer', a.buyer, b.buyer),
    mk('intent', a.intent, b.intent),
    mk('category', a.category, b.category),
    mk('category fused', a.categoryConsumed, b.categoryConsumed),
    mk('questions', a.questionCount, b.questionCount),
    mk('overall conf', a.overall, b.overall),
  ];
  const aq = new Set(a.questions.map((x) => x.toLowerCase()));
  const bq = new Set(b.questions.map((x) => x.toLowerCase()));
  const questionsAdded = b.questions.filter((q) => !aq.has(q.toLowerCase()));
  const questionsRemoved = a.questions.filter((q) => !bq.has(q.toLowerCase()));
  return { rows, questionsAdded, questionsRemoved, anyChange: rows.some((r) => r.changed) || !!questionsAdded.length || !!questionsRemoved.length };
}

// ── thin persistence (side-effecting; guarded so SSR / private-mode never throws) ──
const KEY = 'rfq_observatory_runs_v1';
export function listRuns(): RunSnapshot[] {
  try { const s = localStorage.getItem(KEY); const arr = s ? JSON.parse(s) : []; return Array.isArray(arr) ? arr as RunSnapshot[] : []; } catch { return []; }
}
export function saveRun(snap: RunSnapshot, cap = 20): RunSnapshot[] {
  try { const runs = listRuns(); runs.push(snap); while (runs.length > cap) runs.shift(); localStorage.setItem(KEY, JSON.stringify(runs)); return runs; } catch { return []; }
}
export function clearRuns(): void { try { localStorage.removeItem(KEY); } catch { /* noop */ } }
