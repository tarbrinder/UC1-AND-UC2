// ─── SYNTHESIS ENGINE ────────────────────────────────────────────────────────────────────────────────────────
// V10 (owner-locked): the ARITHMETIC merged path below — mergeArithmetic · buildMergedSynthPrompt · mergeWithLLM ·
// buildMergedSynth (+ MergedAttr/MergedSynth) — is DEAD. No runtime caller reaches it (mergedTwinStore + the
// dashboard are extract-only). It is kept compiled-but-unused pending physical excision; do NOT re-hook it.
// STILL-LIVE exports used by the extract path: FinalAttr · Provenance · synthEval · buildPrunePrompt · applyPrune ·
// synthDelta · llmFinals · verifyLLMOutput. Touch only those.
//
// ─── (DEAD) MERGED SYNTHESIS ENGINE — the former arithmetic buyer-twin builder ──────────
// The architecture the user locked: the two arithmetic engines (the 4 formal ledger.decisions + the ~25-slot
// Persona Registry) are MERGED into one attribute set; that set — WITH its arithmetic explanation — plus the
// full persona schema and the raw evidence is handed to the LLM with: "here is what we deduced and why;
// re-verify each, fill any you can ground, and add new grounded attributes." The LLM is the AUTHORITY: its
// verdict OVERRIDES the arithmetic for the twin value, but the arithmetic is kept beside it as the prior +
// provenance. Every value is tagged where it came from (arithmetic / llm-confirmed / llm-changed / llm-new)
// and every LLM step is checked for hallucinated evidence ids.
//
// This is the SHARED engine: the real V3/V4 pull runs it eagerly (one flash-lite call per GLID, cached) and
// the Observatory renders its output as the Fusion flow. Pure pieces (merge / prompt / merge-back) are
// deterministic and harnessed in synthtest.mjs; only the gemini round-trip is async + env-gated.

import type { Ledger } from './ledger';
import type { Persona } from './personaRegistry';
import { assembleBundle, type SynthBundle } from './profileSynth';
import type { SynthLLMOut } from './gemini';
import { SIGNAL_PRIORITY } from './provenance';

// one unified arithmetic attribute (4 legacy decisions ∪ all persona candidates, deduped by key)
export interface MergedAttr {
  key: string; label: string; group: string;
  value: string; confidence: number; shown: boolean;
  sources: string[];
  arithmetic: string;          // the human explanation of HOW the arithmetic got here
  method: string;              // the RULE that ran — declared rule + the actual fact-tags matched → value @ base (no black box)
  decisionId?: string;         // set if a formal ledger.Decision backs this key (→ deep chain available)
}

// the final twin attribute after the LLM pass — LLM value wins, arithmetic kept as prior, provenance tagged
export type Provenance = 'arithmetic' | 'llm-confirmed' | 'llm-changed' | 'llm-new';
export interface FinalAttr {
  key: string; label: string; group: string;
  value: string; confidence: number;
  provenance: Provenance;
  method?: string;             // the arithmetic RULE that ran (or "LLM-surfaced" for llm-new) — drives the per-attr "no black box" drill
  arithmetic?: { value: string; confidence: number; explanation: string; decisionId?: string };
  // the LLM is the decider; EACH attribute carries its own reasoning — every step a claim + the evidence id(s)
  // it cites (a raw line, or it may reference the arithmetic in the claim text). The UI resolves ids → raw text.
  llm?: { value: string; confidence: number; reasoning: Array<{ claim: string; evidence: string[]; rejected?: string }>; grounded: boolean; confidenceReason?: string; to100?: string };
  pruned?: boolean;            // set by the critic/prune pass — the LLM judged it not worth surfacing (→ held)
  state?: 'Confirmed' | 'Likely' | 'Conflicted' | 'Unknown'; // set ONLY by the LLM extract path (buyerProfileExtract); old merged path leaves it undefined
}

// ── 1 · MERGE the two arithmetic engines into one set (persona schema is the spine; decisions overlay depth) ──
export function mergeArithmetic(L: Ledger, persona: Persona): MergedAttr[] {
  const byKey = new Map<string, MergedAttr>();
  // persona.all = every candidate (shown + held) → this IS the ~25-slot schema the LLM must fill/verify
  for (const a of persona.all) {
    const arithmetic = a.confidenceLedger.length
      ? a.confidenceLedger.map((i) => `${i.delta > 0 ? '+' : ''}${i.delta} ${i.label}`).join(' ') + ` = ${a.confidence}`
      : (a.shown ? `confidence ${a.confidence}` : (a.ignoredReason || 'no grounding evidence'));
    byKey.set(a.key, { key: a.key, label: a.label, group: a.group, value: a.value, confidence: a.confidence, shown: a.shown, sources: a.sources.map(String), arithmetic, method: a.method });
  }
  // overlay the formal decisions (the legacy 4) — attach decisionId + prefer the decision's reasoning line
  for (const d of L.decisions) {
    const ex = byKey.get(d.key);
    if (ex) { ex.decisionId = d.id; ex.arithmetic = d.reasoning || ex.arithmetic; ex.shown = true; if (!ex.value || ex.value === '—') ex.value = d.value; }
    else byKey.set(d.key, { key: d.key, label: d.key.replace(/_/g, ' '), group: 'Decisions', value: d.value, confidence: d.confidence, shown: true, sources: d.contributions.map((c) => String(c.source)), arithmetic: d.reasoning, method: `formal decision ${d.id} · ${d.contributions.map((c) => c.source).join('+')} → "${d.value}" @${d.confidence}`, decisionId: d.id });
  }
  return [...byKey.values()];
}

// ── 2 · PROMPT — merged arithmetic (with WHY) + full schema + raw evidence → "re-verify, fill, extend" ──
export const MERGED_SYNTH_SYSTEM = [
  'You are a procurement analyst building a LEAN B2B buyer profile from multiple SIGNALS: raw evidence lines (each',
  'with an evidence_id) AND our arithmetic deduction scores. Treat the arithmetic as ONE hint — NOT ground truth;',
  'YOU decide each value, confidence (0-100), and reasoning_steps. EACH step states a claim and cites from_evidence =',
  'evidence_id(s) in the bundle (e.g. f27) — or the literal "arithmetic" when your support IS the arithmetic prior;',
  'if signals conflict, name the loser in "rejected"; never invent an id. When buyer signals DISAGREE, the',
  `higher-priority source wins, in order: ${SIGNAL_PRIORITY}. External (Befisc/Sign3) stays TRUSTWORTHY first-class`,
  "evidence (never discounted) — this order only breaks ties. On WhatsApp, only the BUYER's own messages are signal;",
  "our messages (seller shares / marketing) are context, never the buyer's intent. Be concise (one response) and",
  'ALWAYS cite a real evidence_id in every step.',
  'SURFACE ONLY WHAT EARNS ITS PLACE — returning FEWER attributes is CORRECT; only emit an attribute you actually',
  'want shown. The arithmetic candidate list is a MENU TO PRUNE, NOT a checklist to fill: for a typical buyer only a',
  'MINORITY survives — emitting an attribute merely because it is in the list or arithmetic gave it a value is an ERROR.',
  'Apply these rules to EVERY attribute, for ANY product / persona / requirement (universal — never',
  'hardcode a category or product):',
  '1) NO REDUNDANCY — emit each fact ONCE, at its MOST SPECIFIC level. Drop an attribute if it merely restates',
  '   another, or restates the offer’s products / quantity / location (e.g. emit the specific SUB-industry, not also a',
  '   broad industry; do not re-list products already implied; do not emit a "scale" or "value" that quantity already states).',
  '2) NO HEDGES — surface only if genuinely grounded. If your answer would be "likely X" or a non-committal "medium"',
  '   with no real support, OMIT it. No filler, no default midpoints.',
  '3) BENIGN DEFAULTS STAY SILENT — for risk, identity-verification and trust/footprint, emit ONLY when they flag a',
  '   CONCERN (elevated risk, UNverified, weak/suspicious footprint). If all is fine/verified/low-risk, OMIT — silence = all-clear.',
  '4) IGNORE PLATFORM-DERIVED FIELDS as evidence — never base a deduction on "Probable …", "Requirement Type", or',
  '   "Business Use"-type values (marked platform-derived); they are the platform’s guesses, not the buyer. Ground in buyer',
  '   signals: quantity × product name, stated specs, call/chat content, on-site search/browse.',
  '5) MERGE related signals into ONE read — a single engagement/recency attribute (response quality + last-active/login);',
  '   communication preference ABSORBS channel affinity (no separate "WhatsApp affinity").',
  '6) RECURRENCE ≠ RE-POSTING — when prior requirements repeat, decide: genuine recurring demand (DISTINCT purchases',
  '   over time) vs the SAME requirement re-posted (same product/spec repeated, often close in time → usually unfulfilled /',
  '   no-response). Only call it recurring/frequent when distinct; otherwise label it re-posted (possibly unmet).',
  'Use the real account age for tenure (never guess). Return ONLY JSON of EXACTLY this shape:',
  '{"attributes":[{"key":"business_type","value":"Manufacturer","confidence":88,"reasoning_steps":[{"claim":"producer not reseller","from_evidence":["f27"],"delta":40,"rejected":"Trader — no resale"}]}]}.',
].join(' ');

export function buildMergedSynthPrompt(merged: MergedAttr[], bundle: SynthBundle): { system: string; user: string } {
  const user = [
    'CANDIDATE PRIORS — arithmetic deductions, a MENU TO PRUNE (NOT a form to fill). Most are redundant or weak; keep ONLY the few that pass the rules. Returning most of this list is WRONG:',
    ...merged.map((m) => `  ${m.key} [${m.label}] — arithmetic: ${m.value || '—'} (${m.confidence}) · because ${m.arithmetic}`),
    '',
    'CATALOG (every node — nothing hidden):',
    ...bundle.catalog.map((c) => `  ${c.node} · ${c.rawCount} lines · ${c.transform} · ${JSON.stringify(c.roles)}`),
    '',
    `EVIDENCE — ALL ${bundle.evidence.length} signal-bearing facts (no cap; only pure noise/plumbing excluded). Cite these ids in from_evidence:`,
    ...bundle.evidence.map((e) => { const platform = /probable |requirement type|business use/i.test(e.raw); return `  [${e.evidence_id}] (${e.node}/${e.tag}, ${e.role}) ${e.raw}${platform ? '  ⟨platform-derived — context only, NOT evidence⟩' : ''}`; }),
    '',
    'FINAL SELF-CHECK before returning — DROP every attribute that: (a) repeats another you are returning, or the offer’s product / quantity / location; (b) you would phrase as "likely …" or a bare "low / medium / high" without a specific cited line; (c) is a benign risk / verification / footprint (no concern). A typical buyer yields roughly 8–14 attributes — NOT the whole candidate list; returning most of the list means you did not prune. One reasoning_steps entry per SURFACED attribute; cite a real evidence_id.',
  ].join('\n');
  return { system: MERGED_SYNTH_SYSTEM, user };
}

// ── 3 · MERGE-BACK — LLM overrides the value; arithmetic kept as prior; provenance + grounding tagged ──
const norm = (s: string) => String(s ?? '').trim().toLowerCase();
export function mergeWithLLM(merged: MergedAttr[], llmOut: SynthLLMOut | null, evidenceIds: Set<string>): FinalAttr[] {
  const arithByKey = new Map(merged.map((m) => [m.key, m]));
  const llmByKey = new Map<string, SynthLLMOut['attributes'][number]>();
  for (const a of llmOut?.attributes || []) if (a && a.key) llmByKey.set(a.key, a);
  const out: FinalAttr[] = [];

  const groundOf = (a: SynthLLMOut['attributes'][number]) => {
    const steps = a.reasoning_steps || [];
    const cites = steps.flatMap((s) => s.from_evidence || []);
    return cites.length > 0 && cites.every((id) => evidenceIds.has(id));
  };
  const reasonOf = (a: SynthLLMOut['attributes'][number]) => (a.reasoning_steps || []).map((s) => ({ claim: s.claim, evidence: s.from_evidence || [], rejected: s.rejected }));

  // (a) every arithmetic attribute, overlaid by the LLM verdict if it spoke
  for (const m of merged) {
    const la = llmByKey.get(m.key);
    if (!la) { // LLM silent → arithmetic stands (only surface ones the arithmetic actually grounded)
      if (m.shown) out.push({ key: m.key, label: m.label, group: m.group, value: m.value, confidence: m.confidence, provenance: 'arithmetic', method: m.method, arithmetic: { value: m.value, confidence: m.confidence, explanation: m.arithmetic, decisionId: m.decisionId } });
      continue;
    }
    const changed = norm(la.value) !== norm(m.value);
    out.push({ key: m.key, label: m.label, group: m.group, value: la.value, confidence: la.confidence, provenance: changed ? 'llm-changed' : 'llm-confirmed', method: m.method, arithmetic: { value: m.value, confidence: m.confidence, explanation: m.arithmetic, decisionId: m.decisionId }, llm: { value: la.value, confidence: la.confidence, reasoning: reasonOf(la), grounded: groundOf(la) } });
  }
  // (b) NEW attributes the LLM surfaced (not in the arithmetic schema)
  for (const la of llmOut?.attributes || []) {
    if (!la || !la.key || arithByKey.has(la.key)) continue;
    out.push({ key: la.key, label: la.key.replace(/_/g, ' '), group: 'LLM-surfaced', value: la.value, confidence: la.confidence, provenance: 'llm-new', method: 'LLM-surfaced — no arithmetic rule (the synthesis LLM proposed this attribute from the raw evidence)', llm: { value: la.value, confidence: la.confidence, reasoning: reasonOf(la), grounded: groundOf(la) } });
  }
  return out;
}

// ── orchestration shape — what the eager pull stores + the Observatory renders (LLM call is wired by callers) ──
export interface MergedSynth { merged: MergedAttr[]; bundle: SynthBundle; prompt: { system: string; user: string }; evidenceIds: Set<string> }
export function buildMergedSynth(L: Ledger, persona: Persona): MergedSynth {
  const merged = mergeArithmetic(L, persona);
  const bundle = assembleBundle(L);
  const prompt = buildMergedSynthPrompt(merged, bundle);
  // 'arithmetic' is a VALID citation — the LLM may cite the arithmetic prior as its support (not just a raw
  // line). Per the locked design: "reasoning can cite arithmetic OR some line." So it counts as grounded.
  const evidenceIds = new Set([...bundle.evidence.map((e) => e.evidence_id), 'arithmetic']);
  return { merged, bundle, prompt, evidenceIds };
}

// ── CRITIC / PRUNE PASS — a fast 2nd LLM call that reads the emitted twin and returns ONLY the keys worth
//    surfacing. Pure LLM judgment (no per-category hardcoding); enforces the leanness the synthesis prompt asks
//    for but flash-lite under-applies in one pass. Attributes not in `keep` are flagged pruned → held. ──
export const PRUNE_SYSTEM = [
  'You are pruning a B2B buyer twin down to the attributes that earn their place — the sharp, decision-useful set.',
  'You are given the attributes a first model emitted (key · value · confidence). Return the keys to KEEP.',
  'DROP an attribute when it:',
  '1) REPEATS another attribute or the offer’s product / quantity / location — within a group of overlapping',
  '   attributes keep the ONE most specific / highest-confidence and drop the rest (e.g. a precise sub-industry over',
  '   a broad industry; one order-value attribute, not three; drop "scale" / "purchase style" when quantity conveys them).',
  '2) is HEDGED — a "likely …" value, or a bare low / medium / high with no sharp basis.',
  '3) is a BENIGN default — clean risk, verified identity, ordinary footprint — UNLESS it flags a concern or is unusual:',
  '   a brand-new or long-dormant account, an adverse external flag, an off-pattern value is itself a SIGNAL — keep it.',
  'COLLAPSE, never DELETE a dimension: when several attributes describe the SAME dimension (channel / communication,',
  'recency / last-seen, order value, scale) keep exactly ONE — the sharpest — never drop that dimension to zero.',
  'Folding "whatsapp affinity" into communication means KEEPING communication, not dropping both.',
  'TARGET 8–14 kept. If your keep-set is below 8 while sharp, non-redundant attributes remain you pruned too hard —',
  'restore the next-sharpest until you are in band. Never hardcode a category or product; judge only by the values shown.',
  'Return ONLY JSON: {"keep":["business_type","sub_industry","negotiation_style", …]}.',
].join(' ');
export function buildPrunePrompt(finals: FinalAttr[]): { system: string; user: string } {
  const user = ['ATTRIBUTES EMITTED (key · value · confidence) — choose which to KEEP:',
    ...finals.map((f) => `  ${f.key} · ${f.value} · ${f.confidence}`)].join('\n');
  return { system: PRUNE_SYSTEM, user };
}
export function applyPrune(finals: FinalAttr[], keep: string[] | null): FinalAttr[] {
  if (!keep || !keep.length) return finals;                 // prune unavailable → leave as-is (no silent loss)
  const keepSet = new Set(keep.map((k) => k.toLowerCase()));
  return finals.map((f) => keepSet.has(f.key.toLowerCase()) ? f : { ...f, pruned: true });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PURE-LLM MODE (ACTIVE) — the arithmetic synthesizer above (mergeArithmetic · buildMergedSynthPrompt ·
// mergeWithLLM · buildMergedSynth) is UNHOOKED but kept verbatim for later. In this mode the LLM works straight
// off the RAW NODES: no arithmetic attributes in the prompt, no arithmetic/provenance merge-back. The LLM output
// IS the twin. To re-hook the arithmetic prior, switch the caller back to buildMergedSynth + mergeWithLLM.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
export const LLM_SYNTH_SYSTEM = [
  'You are a procurement analyst building a B2B buyer profile PURELY from the raw evidence lines below — each has',
  'an evidence_id. For every buyer attribute you can ground in the evidence, return: key (snake_case), value,',
  'confidence (0-100, your judgment), and reasoning_steps. EACH step states a claim and cites from_evidence =',
  'evidence_id(s) that appear in the bundle (e.g. f27); NEVER invent an id; if signals conflict, name the loser in',
  '"rejected". External signals (Befisc/Sign3, paid APIs) are TRUSTWORTHY first-class evidence — weight them like',
  'PNS. Cover the usual B2B attributes (business_type, industry, scale, machine_ownership, purchase_frequency,',
  'purchase_style, communication, procurement_value, geo, risk_profile, account_tenure, …) PLUS any the evidence',
  'supports. Be concise so the WHOLE profile fits one response (do not get cut off), but ALWAYS cite a real',
  'evidence_id in every step. Return ONLY JSON of EXACTLY this shape:',
  '{"attributes":[{"key":"business_type","value":"Manufacturer","confidence":88,"reasoning_steps":[{"claim":"producer not reseller — owns making machines","from_evidence":["f27"],"delta":40,"rejected":"Trader — no resale signals"}]}]}.',
].join(' ');

export function buildLLMSynthPrompt(bundle: SynthBundle): { system: string; user: string } {
  const user = [
    'CATALOG (every node — nothing hidden):',
    ...bundle.catalog.map((c) => `  ${c.node} · ${c.rawCount} lines · ${c.transform} · ${JSON.stringify(c.roles)}`),
    '',
    `EVIDENCE — ALL ${bundle.evidence.length} signal-bearing facts (no cap; only pure noise/plumbing excluded). Cite these ids in from_evidence:`,
    ...bundle.evidence.map((e) => `  [${e.evidence_id}] (${e.node}/${e.tag}, ${e.role}) ${e.raw}`),
    '',
    'Decide EVERY attribute you can ground straight from these lines. One reasoning_steps entry per attribute minimum; cite the evidence_id behind each claim.',
  ].join('\n');
  return { system: LLM_SYNTH_SYSTEM, user };
}

export interface LLMSynth { bundle: SynthBundle; prompt: { system: string; user: string }; evidenceIds: Set<string> }
export function buildLLMSynth(L: Ledger): LLMSynth {
  const bundle = assembleBundle(L);
  return { bundle, prompt: buildLLMSynthPrompt(bundle), evidenceIds: new Set(bundle.evidence.map((e) => e.evidence_id)) };
}

// map the LLM's raw output straight into FinalAttr[] — no arithmetic prior, no provenance merge. `meta` resolves
// a key → its display label + bucket (so the enrichment/twin grouping stays meaningful); unknown keys fall back.
export function llmFinals(llmOut: SynthLLMOut | null, evidenceIds: Set<string>, meta?: (key: string) => { label: string; group: string }): FinalAttr[] {
  const groundOf = (a: SynthLLMOut['attributes'][number]) => { const cites = (a.reasoning_steps || []).flatMap((s) => s.from_evidence || []); return cites.length > 0 && cites.every((id) => evidenceIds.has(id)); };
  const reasonOf = (a: SynthLLMOut['attributes'][number]) => (a.reasoning_steps || []).map((s) => ({ claim: s.claim, evidence: s.from_evidence || [], rejected: s.rejected }));
  const out: FinalAttr[] = [];
  for (const la of llmOut?.attributes || []) {
    if (!la || !la.key) continue;
    const m = meta ? meta(la.key) : { label: la.key.replace(/_/g, ' '), group: 'Deduced' };
    out.push({ key: la.key, label: m.label, group: m.group, value: la.value, confidence: la.confidence, provenance: 'llm-confirmed', llm: { value: la.value, confidence: la.confidence, reasoning: reasonOf(la), grounded: groundOf(la) } });
  }
  return out;
}

// counts for the Fusion stage header (how the LLM moved the arithmetic)
export function synthDelta(finals: FinalAttr[]): { total: number; arithmetic: number; confirmed: number; changed: number; llmNew: number; ungrounded: number } {
  return {
    total: finals.length,
    arithmetic: finals.filter((f) => f.provenance === 'arithmetic').length,
    confirmed: finals.filter((f) => f.provenance === 'llm-confirmed').length,
    changed: finals.filter((f) => f.provenance === 'llm-changed').length,
    llmNew: finals.filter((f) => f.provenance === 'llm-new').length,
    ungrounded: finals.filter((f) => f.llm && !f.llm.grounded).length,
  };
}

// ── EVAL BAND (agentic observability · Langfuse-style "scores") — quality of the synthesis, deterministic ──
export interface SynthEval {
  surfaced: number; llmDecided: number;            // how many attributes; how many the LLM spoke on
  grounded: number; ungrounded: number; groundedPct: number;  // of the LLM ones, how many cite real evidence
  avgConfidence: number; lowConfidence: number;    // calibration: mean conf; count below 50
  changed: number; llmNew: number; arithmeticOnly: number;    // how much the LLM moved the prior
  verdict: 'strong' | 'review';                    // strong = well-grounded + few low-conf; else review
}
export function synthEval(finals: FinalAttr[]): SynthEval {
  const llm = finals.filter((f) => f.llm);
  const grounded = llm.filter((f) => f.llm!.grounded).length;
  const ungrounded = llm.length - grounded;
  const groundedPct = llm.length ? Math.round((grounded / llm.length) * 100) : 0;
  const avgConfidence = finals.length ? Math.round(finals.reduce((s, f) => s + (f.confidence || 0), 0) / finals.length) : 0;
  const lowConfidence = finals.filter((f) => (f.confidence || 0) < 50).length;
  const changed = finals.filter((f) => f.provenance === 'llm-changed').length;
  const llmNew = finals.filter((f) => f.provenance === 'llm-new').length;
  const arithmeticOnly = finals.filter((f) => f.provenance === 'arithmetic').length;
  const verdict: SynthEval['verdict'] = groundedPct >= 80 && ungrounded <= 2 && lowConfidence <= Math.ceil(finals.length * 0.25) ? 'strong' : 'review';
  return { surfaced: finals.length, llmDecided: llm.length, grounded, ungrounded, groundedPct, avgConfidence, lowConfidence, changed, llmNew, arithmeticOnly, verdict };
}
