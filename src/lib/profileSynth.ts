// ─── PROFILE SYNTHESIS TIER — the reasoning layer over the node facts ──────────────────────────────────
// The architecture (extract → REASON → verify): node facts (the bundle) → a synthesis judgment with
// MANDATORY grounded reasoning_steps → a deterministic verifier. Two honest modes:
//   • LLM mode (gemini key present): the model produces richer reasoning + catches nuance/contradiction,
//     constrained to cite evidence_ids. Activated by synthesizeProfile().
//   • Rule mode (no key): the ledger's own deterministic reasoningSteps stand — and are STILL verified.
// Either way the schema is identical, so the trace UI never changes. The bundle is the full catalog (no
// node hidden) + the signal-bearing facts in full; nothing is pre-filtered away from the model.
// The deterministic core (assembleBundle · verifyDecision · prompts) is harnessed in reasoningtest.mjs.

import { type Ledger, type Decision, nodeContract } from './ledger';
import { hasGeminiKey, type SynthLLMOut } from './gemini';

// ── the bundle the synthesis model sees: full catalog (every node, counts, roles) + signal facts in full ──
export interface SynthBundle {
  catalog: Array<{ node: string; api: string; transform: 'rule' | 'llm'; rawCount: number; roles: Record<string, number> }>;
  evidence: Array<{ evidence_id: string; node: string; tag: string; raw: string; role: string }>;  // signal-bearing, model-visible in full
  arithmeticPrior: Array<{ key: string; value: string; confidence: number }>;                       // the deterministic hint (NOT a gate)
}

export function assembleBundle(L: Ledger): SynthBundle {
  const cards = nodeContract(L);
  const catalog = cards.map((c) => ({ node: c.node, api: c.api, transform: c.transform, rawCount: c.rawCount, roles: c.roleCounts as unknown as Record<string, number> }));
  // every fact EXCEPT pure plumbing noise is visible to the model in full (decisive + scanned + available +
  // discounted). Noise is summarised by the catalog counts, never silently dropped — and is +-openable.
  const evidence = L.facts
    .filter((f) => f.role !== 'noise')
    .map((f) => ({ evidence_id: f.id, node: f.sourceNode, tag: f.tag, raw: f.rawValue, role: f.role ?? 'available' }));
  const arithmeticPrior = L.decisions.map((d) => ({ key: d.key, value: d.value, confidence: d.confidence }));
  return { catalog, evidence, arithmeticPrior };
}

// ── VERIFIER (deterministic guard) — runs in BOTH modes. Grounds the REASONING, not just the conclusion. ──
export interface VerifyCheck { name: string; pass: boolean; detail: string }
export interface VerifyResult { ok: boolean; checks: VerifyCheck[] }

export function verifyDecision(L: Ledger, d: Decision): VerifyResult {
  const factIds = new Set(L.facts.map((f) => f.id));
  const checks: VerifyCheck[] = [];

  // 1 · grounded reasoning — every reasoning step's evidence ids must resolve to a real fact (no invention)
  const steps = d.reasoningSteps ?? [];
  const ungrounded: string[] = [];
  for (const s of steps) for (const id of s.fromEvidence) if (!factIds.has(id)) ungrounded.push(`step ${s.n} → ${id}`);
  checks.push({ name: 'grounded reasoning', pass: ungrounded.length === 0, detail: ungrounded.length ? `${ungrounded.length} step citation(s) not in evidence: ${ungrounded.join(', ')}` : `${steps.length} step(s), all cite real facts` });

  // 2 · has reasoning — every decision must carry ≥1 reasoning step (reasoning for every output)
  checks.push({ name: 'has reasoning', pass: steps.length > 0, detail: steps.length ? `${steps.length} step(s)` : 'NO reasoning steps' });

  // 3 · grounded conclusion — at least one decisive (cited) fact, OR it is an honest direct lookup
  const cited = new Set<string>(); for (const s of steps) s.fromEvidence.forEach((id) => cited.add(id));
  const direct = d.producedBy.kind === 'direct';
  checks.push({ name: 'grounded conclusion', pass: cited.size > 0 || direct, detail: cited.size ? `${cited.size} fact(s) cited` : direct ? 'direct lookup (no inference)' : 'no cited evidence' });

  // 4 · confidence vs arithmetic prior — flag a large divergence (only meaningful for LLM mode; rule==prior)
  const priorSum = d.contributions.reduce((s, c) => s + c.points, 0);
  const div = Math.abs(d.confidence - Math.min(100, priorSum));
  checks.push({ name: 'confidence vs prior', pass: div <= 20 || d.contributions.length === 0, detail: `decision ${d.confidence} vs prior ${Math.min(100, priorSum)} (Δ${div})` });

  return { ok: checks.every((c) => c.pass), checks };
}

export function verifyLedger(L: Ledger): Array<{ key: string; result: VerifyResult }> {
  return L.decisions.map((d) => ({ key: d.key, result: verifyDecision(L, d) }));
}

// ── PROMPT (resolved system + user) — shown verbatim in the trace; used by the LLM mode ──
export const SYNTH_SYSTEM_PROMPT = [
  'You are a procurement analyst deducing a B2B buyer profile from the evidence bundle.',
  'Return ONLY a JSON object of EXACTLY this shape (no prose, no markdown):',
  '{"attributes":[{"key":"business_type","value":"Manufacturer","confidence":82,"reasoning_steps":[{"claim":"producer not reseller","from_evidence":["f27","f72"],"delta":40,"rejected":"Trader — no resale signals"}]}]}.',
  'Emit one entry per attribute you can ground (business_type, industry, scale, machine_ownership, purchase_frequency, communication, etc.).',
  'RULES: every reasoning step MUST cite from_evidence as evidence_id(s) that appear in the bundle (e.g. f27); never invent a fact;',
  'if evidence conflicts, name it in a step with "rejected". External signals (Befisc/Sign3, paid APIs) are TRUSTWORTHY first-class evidence — use them like PNS for identity, business vintage, legitimacy, scale and trust (weight them equally, do not dismiss as "observed-only").',
].join(' ');

export function buildSynthPrompt(b: SynthBundle): { system: string; user: string } {
  const user = [
    'CATALOG (every node — nothing hidden):',
    ...b.catalog.map((c) => `  ${c.node} · ${c.rawCount} lines · ${c.transform} · ${JSON.stringify(c.roles)}`),
    '',
    'EVIDENCE (signal-bearing, full — no cap):',
    ...b.evidence.map((e) => `  [${e.evidence_id}] (${e.node}/${e.tag}, ${e.role}) ${e.raw}`),
    '',
    'ARITHMETIC PRIOR (a hint, not a gate):',
    ...b.arithmeticPrior.map((p) => `  ${p.key} = ${p.value} (${p.confidence})`),
  ].join('\n');
  return { system: SYNTH_SYSTEM_PROMPT, user };
}

// ── LIVE LLM SYNTHESIS (env-gated). No key → null, and the deterministic reasoning on the ledger stands. ──
// Kept thin & honest: the prompt + bundle are real and rendered; wiring the gemini round-trip + schema parse
// is the one piece that needs the key at runtime (Phase: activate when VITE_LLM_KEY is set).
export interface SynthMeta { mode: 'llm' | 'rule'; prompt: { system: string; user: string }; bundle: SynthBundle; verify: Array<{ key: string; result: VerifyResult }> }

export function synthMeta(L: Ledger): SynthMeta {
  const bundle = assembleBundle(L);
  return { mode: hasGeminiKey() ? 'llm' : 'rule', prompt: buildSynthPrompt(bundle), bundle, verify: verifyLedger(L) };
}

// ── verify the LIVE LLM output the SAME way (#8) — every reasoning step must cite a real evidence_id. ──
export interface LLMVerify { ok: boolean; attributes: number; steps: number; grounded: number; hallucinated: string[] }
export function verifyLLMOutput(bundle: SynthBundle, out: SynthLLMOut): LLMVerify {
  const ids = new Set(bundle.evidence.map((e) => e.evidence_id));
  let steps = 0, grounded = 0; const hallucinated: string[] = [];
  for (const a of out.attributes || []) for (const s of a.reasoning_steps || []) {
    steps++; const cites = s.from_evidence || [];
    if (cites.length && cites.every((id) => ids.has(id))) grounded++;
    for (const id of cites) if (!ids.has(id)) hallucinated.push(`${a.key}:${id}`);
  }
  return { ok: hallucinated.length === 0, attributes: (out.attributes || []).length, steps, grounded, hallucinated };
}
