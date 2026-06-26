// ─── RFQ OBSERVATORY — the brain (P0 + the L11–L20 compute) ──────────────────────────────────────
// PURE · deterministic · NO LLM · NO infra. Every deduction becomes a Decision in one Ledger; every
// "trust / value / governance" question is answered by a pure function here. Each function is tagged
// with the canonical question(s) it answers (see RFQ_FINAL_PLAN.md) so NONE goes missing. The V4
// AI-Inspector renders these; the harness (observatorytest.mjs) mirrors + asserts them.
//
// Scope built here: P0 (schema + ledger + emit), and the compute for L11–L20:
//   L11 Non-Consumption Matrix · L12 Output-Acceptance · L13 Waste-Question · L14 Sufficiency/Robustness/
//   Confidence-Formula · L15 Counterfactual/Dependency + Deterministic-vs-AI · L16 ROI/Value · L17 Impact-Diff ·
//   L20 Governance (precedence · override · safeguards · non-assumptions · FMEA · blast-radius · irreversibility · READY · why-now).
// (E2 replay/compare needs the persisted store; L19 prediction-vs-outcome needs telemetry — both flagged, not faked.)

export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'info';

// ── P0: the Decision object (the single first-class primitive) ──
export interface Evidence { source: string; node?: string; endpoint?: string; jsonPath?: string; rawLine?: string; weight?: number; used: boolean; reason?: string }
export interface Decision {
  id: string;
  surface: string;                 // intent | planner | spec | last-page | profile | category | fact
  producedBy: { kind: 'code' | 'llm' | 'node' | 'user' | 'api'; ref: string };
  value: unknown;
  state?: 'Confirmed' | 'Likely' | 'Weak' | 'Unknown' | 'Contradicted';
  confidence?: number;
  evidence?: Evidence[];           // used inputs (L3)
  ignored?: Evidence[];            // available-but-not-used + why (L11 feeds this)
  alternatives?: Array<{ value: unknown; score: number; whyLost: string }>;
  consumers?: string[];
  consumed?: boolean; consumptionReason?: string;
  ts?: number;
}

// ── P0: the in-app Decision Ledger (single source of truth) ──
export interface Ledger {
  add: (d: Decision) => void;
  all: () => Decision[];
  byId: (id: string) => Decision | undefined;
  bySurface: (s: string) => Decision[];
  search: (term: string) => Decision[];
}
const nrm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function createLedger(seed: Decision[] = []): Ledger {
  const rows: Decision[] = [...seed];
  return {
    add: (d) => { const i = rows.findIndex((r) => r.id === d.id); if (i >= 0) rows[i] = d; else rows.push(d); },
    all: () => rows.slice(),
    byId: (id) => rows.find((r) => r.id === id),
    bySurface: (s) => rows.filter((r) => r.surface === s),
    search: (term) => { const toks = String(term || '').toLowerCase().split(/\s+/).map(nrm).filter((t) => t.length >= 2); if (!toks.length) return []; const hit = (x: unknown) => { const n = nrm(x); return toks.some((t) => n.includes(t)); }; return rows.filter((r) => hit(r.id) || hit(r.value) || (r.evidence || []).some((e) => hit(e.rawLine))); },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// L20 · GOVERNANCE — who is ALLOWED to decide (Q61–Q70). The rules already exist in the engine; this
// surfaces them as a ledger.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// Q63 — the global precedence hierarchy (higher index = wins).
export const PRECEDENCE = ['Fallback', 'LLM', 'Category', 'Twin', 'Corroborated', 'ConfirmedHistory', 'VerifiedAPI', 'User'] as const;
export type Source = typeof PRECEDENCE[number];
export function precedenceRank(s: string): number { const i = PRECEDENCE.indexOf(s as Source); return i < 0 ? 0 : i; }

// Q61 — who wins a conflict + why (override ledger). Returns winner/loser/rule.
export interface Conflict { field: string; contenders: Array<{ source: string; value: unknown }> }
export function resolveConflict(c: Conflict): { field: string; winner: { source: string; value: unknown }; losers: Array<{ source: string; value: unknown }>; rule: string } {
  const ranked = c.contenders.slice().sort((a, b) => precedenceRank(b.source) - precedenceRank(a.source));
  const winner = ranked[0]; const losers = ranked.slice(1);
  const rule = losers.length ? `${winner.source} > ${losers.map((l) => l.source).join(' > ')} (precedence)` : `${winner.source} (uncontested)`;
  return { field: c.field, winner, losers, rule };
}

// Q64/Q65 — safeguards that fired + assumptions intentionally NOT made (the trust panel).
export interface Safeguard { name: string; fired: boolean; subject: string; reason: string }
export function safeguardsFired(list: Safeguard[]): Safeguard[] { return list.filter((s) => s.fired); }

// Q66 — FMEA: per decision, the plausible failure mode. Q67 — blast radius if wrong. Q68 — irreversibility.
export interface RiskRow { decision: string; failureMode: string; blastRadius: 'Low' | 'Medium' | 'High' | 'Very High'; cascadesInto: string[]; irreversible: boolean }
export function riskProfile(rows: RiskRow[]): RiskRow[] {
  // irreversible = cascades into ≥3 downstream systems (e.g. Intent → planner/specs/matching/summary)
  return rows.map((r) => ({ ...r, irreversible: r.irreversible || r.cascadesInto.length >= 3 }));
}

// Q69 — READY gate: explicit requirements before the planner may run. Answers "planner fired before category".
export interface ReadyReq { name: string; required: boolean; met: boolean }
export function readyVerdict(reqs: ReadyReq[]): { ready: boolean; missing: string[]; rows: ReadyReq[] } {
  const missing = reqs.filter((r) => r.required && !r.met).map((r) => r.name);
  return { ready: missing.length === 0, missing, rows: reqs };
}

// Q70 — why THIS question NOW (timing dependency, not just "why this question").
export function whyNow(question: string, dependsOn: string[]): string {
  return dependsOn.length ? `asked now because it depends on: ${dependsOn.join(', ')} (resolved upstream)` : `${question}: no upstream dependency — order-independent`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// L11 · NON-CONSUMPTION MATRIX (Q14, the "why it DIDN'T happen" answer)
// ════════════════════════════════════════════════════════════════════════════════════════════════
export interface ConsumerAvailability { consumer: string; available: boolean; consumed: boolean; reason: string }
export function nonConsumptionMatrix(fact: string, rows: ConsumerAvailability[]): { fact: string; rows: Array<ConsumerAvailability & { tone: Tone }>; everywhereRejected: boolean } {
  const out = rows.map((r) => ({ ...r, tone: (r.consumed ? 'good' : r.available ? 'bad' : 'muted') as Tone }));
  return { fact, rows: out, everywhereRejected: rows.length > 0 && rows.every((r) => r.available && !r.consumed) };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// L12 · OUTPUT-ACCEPTANCE (Q5/Q27 — of what an LLM produced, what survived + why dropped)
// ════════════════════════════════════════════════════════════════════════════════════════════════
export interface ProducedItem { key: string; value: unknown; confidence: number }
export function outputAcceptance(produced: ProducedItem[], gate: number, contradicts: (k: string) => boolean = () => false): { produced: number; accepted: ProducedItem[]; rejected: Array<ProducedItem & { reason: string }> } {
  const accepted: ProducedItem[] = []; const rejected: Array<ProducedItem & { reason: string }> = [];
  for (const p of produced) {
    if (contradicts(p.key)) rejected.push({ ...p, reason: 'contradicts a user/verified fact' });
    else if (p.confidence < gate) rejected.push({ ...p, reason: `confidence ${p.confidence} < gate ${gate}` });
    else accepted.push(p);
  }
  return { produced: produced.length, accepted, rejected };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// L13 · WASTE-QUESTION eval (Q58 — did the answer change any downstream decision?)
// ════════════════════════════════════════════════════════════════════════════════════════════════
export function answerImpact(question: string, downstreamChanged: string[]): { question: string; useful: boolean; changed: string[]; verdict: string } {
  const useful = downstreamChanged.length > 0;
  return { question, useful, changed: downstreamChanged, verdict: useful ? `USEFUL — changed ${downstreamChanged.join(', ')}` : 'WASTE QUESTION — changed nothing downstream' };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// L14 · SUFFICIENCY · ROBUSTNESS · CONFIDENCE-FORMULA (Q43, Q45, Q50)
// ════════════════════════════════════════════════════════════════════════════════════════════════
// Q43 — did we even have enough info? coverage = received/needed; caps confidence when thin.
export function evidenceSufficiency(received: number, needed: number, rawConf: number): { coveragePct: number; cappedConfidence: number; sufficient: boolean; note: string } {
  const coverage = needed > 0 ? Math.round((received / needed) * 100) : 100;
  const cap = coverage >= 80 ? 100 : coverage >= 50 ? 80 : coverage >= 25 ? 60 : 45;
  const capped = Math.min(rawConf, cap);
  return { coveragePct: coverage, cappedConfidence: capped, sufficient: coverage >= 80, note: coverage >= 80 ? 'sufficient' : `thin evidence (${received}/${needed}) → confidence capped at ${cap}` };
}
// Q45 — robustness = how many INDEPENDENT sources back a fact (1 = fragile).
export function robustness(sources: string[]): { score: number; fragile: boolean; note: string } {
  const n = new Set(sources.map(nrm)).size;
  const score = Math.min(100, n * 25);
  return { score, fragile: n <= 1, note: n <= 1 ? `single-source (${sources[0] || 'none'}) — fragile` : `${n} independent sources — ${n >= 3 ? 'stable' : 'moderate'}` };
}
// Q50 — the additive confidence formula ("73 = 40 PNS + 15 WA …").
export function confidenceFormula(parts: Array<{ source: string; points: number }>, conflicts = 0): { total: number; breakdown: string } {
  const sum = parts.reduce((s, p) => s + p.points, 0) - conflicts * 10;
  const total = Math.max(0, Math.min(100, sum));
  const breakdown = `${total} = ${parts.map((p) => `${p.points} ${p.source}`).join(' + ')}${conflicts ? ` − ${conflicts * 10} conflicts` : ' − 0 conflicts'}`;
  return { total, breakdown };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// L15 · COUNTERFACTUAL / DEPENDENCY (Q44) + DETERMINISTIC-vs-AI survival (Q60)
// ════════════════════════════════════════════════════════════════════════════════════════════════
// Q44 — if a source is dropped, does the fact still survive? (needs ≥1 OTHER backing source)
export function dependencyImpact(fact: string, backingSources: string[], dropped: string): { fact: string; dropped: string; survives: boolean; remaining: string[] } {
  const remaining = backingSources.filter((s) => nrm(s) !== nrm(dropped));
  return { fact, dropped, survives: remaining.length > 0, remaining };
}
// Q60 — remove all LLM-produced decisions: what survives (deterministic spine) vs what's lost (AI-only).
export function deterministicVsAI(ledger: Decision[]): { survives: Decision[]; lost: Decision[] } {
  const survives = ledger.filter((d) => d.producedBy.kind !== 'llm');
  const lost = ledger.filter((d) => d.producedBy.kind === 'llm');
  return { survives, lost };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// L16 · VALUE & ROI (Q46-48, Q52, Q57)
// ════════════════════════════════════════════════════════════════════════════════════════════════
// Q48 — source ROI: facts contributed vs actually used.
export function sourceROI(facts: Array<{ source: string; used: boolean }>): Array<{ source: string; contributed: number; used: number; roiPct: number }> {
  const m = new Map<string, { c: number; u: number }>();
  for (const f of facts) { const e = m.get(f.source) || { c: 0, u: 0 }; e.c++; if (f.used) e.u++; m.set(f.source, e); }
  return [...m.entries()].map(([source, e]) => ({ source, contributed: e.c, used: e.u, roiPct: e.c ? Math.round((e.u / e.c) * 100) : 0 })).sort((a, b) => b.roiPct - a.roiPct);
}
// Q52 — cost per decision per downstream use.
export function costPerUse(costUsd: number, uses: number): { costUsd: number; uses: number; perUse: number } {
  return { costUsd, uses, perUse: uses > 0 ? costUsd / uses : costUsd };
}
// Q57 — top-impact decisions (ranked by # of downstream consumers).
export function topImpact(decisions: Decision[]): Array<{ id: string; impact: number }> {
  return decisions.map((d) => ({ id: d.id, impact: (d.consumers || []).length })).sort((a, b) => b.impact - a.impact);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// L17 · IMPACT-DIFF (Q49 — on an answer, what changed vs what did NOT, across all downstream systems)
// ════════════════════════════════════════════════════════════════════════════════════════════════
export function impactDiff(before: Record<string, unknown>, after: Record<string, unknown>): { changed: Array<{ field: string; from: unknown; to: unknown }>; notChanged: string[] } {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: Array<{ field: string; from: unknown; to: unknown }> = []; const notChanged: string[] = [];
  for (const k of keys) { if (nrm(before[k]) !== nrm(after[k])) changed.push({ field: k, from: before[k], to: after[k] }); else notChanged.push(k); }
  return { changed, notChanged };
}
