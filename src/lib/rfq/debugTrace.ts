// ─── Dynamic RFQ — Debug RunTrace aggregation (persona-driven observability, 2026-08-10) ────────────────────────────
// Per the debug plan (RFQ-DEBUG-PLAN.md): five readers, five questions. This is the KEYSTONE — one PURE aggregation
// over the telemetry the panel already captures (LLM call records + raw I/O + source health) → a `RunTrace` the panel
// rolls up per persona (L1 Story = CEO · L2 Scorecard = HOD/COO · L3 Decision-Trace = PM · Mechanics = Engineer).
// PURE + no runtime imports (only `import type`, erased before the test loader ever sees them), so it is unit-testable.
import type { LLMCallRecord, LLMRawIO } from '../gemini';
import type { SourceHealthRec } from './dataLayer';

export type Persona = 'ceo' | 'coo' | 'hod' | 'pm' | 'engineer';
/** Default debug DEPTH each persona opens on (1 Story · 2 Scorecard · 3 Decision-Trace + Mechanics). Everyone can expand. */
export const PERSONA_DEPTH: Record<Persona, 1 | 2 | 3> = { ceo: 1, coo: 2, hod: 2, pm: 3, engineer: 3 };
export const PERSONA_LABEL: Record<Persona, string> = { ceo: 'CEO', coo: 'COO', hod: 'HOD', pm: 'PM', engineer: 'Engineer' };

interface Q { field?: string; label?: string; ui?: string; value?: string; options?: string[]; order?: number }
interface Reason { evidence?: unknown; source?: string; confidence?: number }

export interface RunTrace {
  // L1 — CEO story: "knew N of N+M, asked M, invented 0, and it's a form no other buyer gets."
  story: { knew: number; asked: number; total: number; invented: number; prefilledFields: string[]; askedFields: string[] };
  // L2 — KPI (HOD/PM): TUS proxy = filled-from-truth ÷ (filled+asked); BES proxy = ask-count + chip-weight.
  kpi: { tusPct: number; besProxy: number };
  // L2 — quality gates (HOD/trust): both must be 0. fabrications = prefills with no evidence; dedupViolations =
  // the same concept ASKED on more than one page (the "same question again on page 2/3" bug, made a counter).
  gates: { fabrications: number; dedupViolations: number };
  // L2 — Ops (COO/HOD): cost, latency, the bottleneck source, and the things that failed.
  ops: { totalCostUsd: number; llmCalls: number; llmMs: number; slowestSource?: { source: string; ms: number }; parseFailures: number; sourcesErrored: number; sourcesEmpty: number };
  // L2 — per-source contribution (HOD): the "every source must Prefill/Confirm/Ask/Rank or it's a red row" invariant.
  contribution: { source: string; ok: boolean; ms: number }[];
  // L2 — exceptions only (HOD): what went wrong THIS run, not the 30 things that went right.
  exceptions: string[];
}

const arr = (x: unknown): Q[] => (Array.isArray(x) ? (x as Q[]) : []);
function parseOut(io?: LLMRawIO): { questions: Q[]; reasoning: Record<string, Reason> } {
  if (!io?.output) return { questions: [], reasoning: {} };
  try {
    const j = JSON.parse(io.output) as Record<string, unknown>;
    // brain output nests page-1 questions under page1; planners are flat { questions }.
    const p1 = (j.page1 as { questions?: unknown; metadata?: { reasoning?: unknown } } | undefined);
    const questions = arr(j.questions ?? p1?.questions);
    const meta = (j.metadata ?? p1?.metadata ?? {}) as { reasoning?: Record<string, Reason> };
    return { questions, reasoning: meta.reasoning ?? {} };
  } catch { return { questions: [], reasoning: {} }; }
}
const hasEvidence = (r?: Reason): boolean => { const e = r?.evidence; return Array.isArray(e) ? e.length > 0 : e != null && String(e).trim().length > 0; };

/** A concept canonicaliser (plannerController.canonConcept in the app; a plain normaliser in tests). */
export type Canon = (s: string) => string;
const defaultCanon: Canon = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Build the whole-run trace from the telemetry the panel already holds. Pure.
 * `canon` lets the app inject the REAL cross-page canonicaliser so the dedup-violation gate matches the planner's own
 * dedup logic; tests (and any caller that omits it) get a plain alnum-lowercase normaliser.
 */
export function buildRunTrace(llm: LLMCallRecord[], raw: Record<string, LLMRawIO>, sources: SourceHealthRec[], canon: Canon = defaultCanon): RunTrace {
  const brain = parseOut(raw['requirement-brain']);
  const cx = parseOut(raw['commercial-planner']);
  const ps = parseOut(raw['persona-planner']);
  const allQ = [...brain.questions, ...cx.questions, ...ps.questions];
  const allReason: Record<string, Reason> = { ...brain.reasoning, ...cx.reasoning, ...ps.reasoning };
  const nameOf = (q: Q) => q.label || q.field || '(unnamed)';

  const asks = allQ.filter((q) => q.ui === 'ask');
  const fills = allQ.filter((q) => q.ui === 'prefill' || q.ui === 'confirm');
  const knew = fills.length, asked = asks.length, total = knew + asked;
  // FABRICATION check: a prefill/confirm whose reasoning cites NO evidence is a value we may have invented.
  const invented = fills.filter((q) => !hasEvidence(allReason[q.field ?? ''] || allReason[q.label ?? ''])).length;
  const tusPct = total ? Math.round((100 * knew) / total) : 0;
  const chipWeight = allQ.reduce((s, q) => s + (q.options?.length ?? 0), 0);
  const besProxy = Math.round(asked + chipWeight * 0.1);
  // DEDUP gate: the same concept asked on more than one page. dropAnswered should make this 0 live; a non-zero here
  // is exactly the "same question again on page 2/3" regression, now self-reporting.
  const askedConcepts = asks.map((q) => canon(q.field || q.label || ''));
  const seenConcept = new Set<string>(); let dedupViolations = 0;
  for (const c of askedConcepts) { if (c && seenConcept.has(c)) dedupViolations++; else if (c) seenConcept.add(c); }

  const totalCostUsd = llm.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const llmMs = llm.reduce((s, r) => s + (r.ms ?? 0), 0);
  const parseFailures = llm.filter((r) => r.parseOk === false).length;
  const sourcesErrored = sources.filter((s) => !s.ok && s.raw != null).length;   // came back but carried nothing / errored
  const sourcesEmpty = sources.filter((s) => !s.ok && s.raw == null).length;      // never returned
  let slowestSource: { source: string; ms: number } | undefined;
  for (const s of sources) if (!slowestSource || s.ms > slowestSource.ms) slowestSource = { source: s.source, ms: s.ms };

  const exceptions: string[] = [];
  if (parseFailures) exceptions.push(`${parseFailures} LLM parse failure(s) — a 200 that could not be read`);
  for (const s of sources) if (!s.ok) exceptions.push(`${s.source}: no data`);
  if (invented) exceptions.push(`${invented} prefill(s) with no cited evidence — check for fabrication`);
  if (dedupViolations) exceptions.push(`${dedupViolations} concept(s) asked on more than one page — dedup leak`);

  return {
    story: { knew, asked, total, invented, prefilledFields: fills.map(nameOf), askedFields: asks.map(nameOf) },
    kpi: { tusPct, besProxy },
    gates: { fabrications: invented, dedupViolations },
    ops: { totalCostUsd, llmCalls: llm.length, llmMs, slowestSource, parseFailures, sourcesErrored, sourcesEmpty },
    contribution: sources.map((s) => ({ source: s.source, ok: s.ok, ms: s.ms })),
    exceptions,
  };
}
