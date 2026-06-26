// ─── OBSERVATORY · DEEP LAYERS (W1 · W2 · W7) — closes the partials in the 100-question audit ─────────
// PURE · deterministic · NO LLM. Section builders for the gaps the scorecard flagged 🟡:
//   W1 Brain-Construction  — HOW the Buyer Twin / Profile / Requirement brain were assembled, fact-by-fact
//                            (contributed · ignored · unknown · superseded · contradicting). C Q26-34 + H Q71-76.
//   W2 Spec-Reasoning      — per spec: shown/hidden · reorder rank · auto-fill evidence · confidence · alts. G Q65-70.
//   W7 Outcome-value scaffold — the structure that lights up when a real lead/call-outcome feed exists. K Q93-98.
// Inputs are STRUCTURAL (V4 passes the real BuyerTwin / ResolvedRequirement objects); we read only the
// fields we render, so no import cycle and no heavy type coupling.

import type { InspectorSection, InspectorRow, Tone } from './inspectorData';

const row = (label: string, value?: string, tone?: Tone, sub?: string, score?: number): InspectorRow => ({ label, value, tone, sub, score });
const sec = (title: string, rows: InspectorRow[]): InspectorSection => ({ title, rows: rows.length ? rows : [row('—', 'no data for this lens yet', 'muted')] });

// ── structural shapes (subset of the real BuyerTwin / ResolvedRequirement) ──
export interface TwinLike {
  buyer_version?: number; major_profile_shift_detected?: boolean; total_signal_count?: number; twin_generation_time_ms?: number;
  twin_confidence?: { overall_score?: number; evidence_base?: { pns_calls?: number; whatsapp_events?: number; bls_created?: number; csl_events?: number }; freshness?: string; last_signal_at?: string };
  explicit_unknowns?: string[]; explicit_negative_signals?: string[];
  signals?: Array<{ source?: string; date?: string; signal?: string }>;
  layer_a_identity?: { city?: string; state?: string; business_type?: string; secondary_roles?: string[]; language?: string; verified?: boolean; company_desc?: string | null };
}
export interface BrainFactLike { source?: string; type?: string; key?: string; value?: string; evidence?: string; confidence?: number }
export interface RequirementLike {
  registryFacts?: BrainFactLike[]; knownInSchema?: string[]; knownDropped?: string[]; ask?: string[]; addedSpecs?: string[];
  criticalRanked?: Array<{ name?: string; maps_to_isq?: string; seller_frequency?: number | null }>;
}
export interface SpecLike { name: string; value?: string; source?: string; status?: string; priority?: number; sellerFreq?: number; reason?: string }
export interface OutcomeLike { converted?: boolean; predictedIntent?: string; actualIntent?: string; respondedQuestions?: string[]; at?: number }

export interface DeepInput {
  twin?: TwinLike | null;
  requirement?: RequirementLike | null;
  contradictions?: { count?: number; items?: string[] } | null;
  specOrder?: string[];
  specs?: SpecLike[];
  outcome?: OutcomeLike | null;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// W1 · BRAIN-CONSTRUCTION — how each brain was built (the "WHY/HOW it exists" the audit wanted)
// ════════════════════════════════════════════════════════════════════════════════════════════════
function twinConstruction(twin: TwinLike): InspectorSection[] {
  const out: InspectorSection[] = [];
  const tc = twin.twin_confidence || {}; const eb = tc.evidence_base || {};
  // (Q27) how the Twin was built — the evidence base + compile metadata
  out.push(sec('🧠 Buyer Twin · how built (Q27)', [
    row('confidence', tc.overall_score != null ? String(tc.overall_score) : '—', (tc.overall_score ?? 0) >= 65 ? 'good' : 'warn', `freshness ${tc.freshness ?? '—'} · last signal ${tc.last_signal_at || '—'}`, tc.overall_score),
    row('evidence base', `${eb.pns_calls ?? 0} PNS · ${eb.whatsapp_events ?? 0} WA · ${eb.bls_created ?? 0} BL · ${eb.csl_events ?? 0} CSL`, 'info', `${twin.total_signal_count ?? 0} raw signals compiled`),
    row('version', `v${twin.buyer_version ?? 1}${twin.major_profile_shift_detected ? ' · ⚠ profile shift' : ''}`, twin.major_profile_shift_detected ? 'warn' : 'muted', twin.twin_generation_time_ms != null ? `compiled in ${Math.round(twin.twin_generation_time_ms)}ms` : undefined),
  ]));
  // (Q29) facts that CONTRIBUTED — the dated, sourced evidence pool the Twin cited
  const sig = (twin.signals || []).slice(0, 10);
  out.push(sec('🧠 Twin · facts that contributed (Q29)', sig.map((s) => row(s.source || '—', (s.signal || '').slice(0, 80), 'good', s.date || undefined))));
  // (Q30/Q34) facts the Twin could NOT determine (unknowns) + hard constraints it will never violate
  const unk = twin.explicit_unknowns || []; const neg = twin.explicit_negative_signals || [];
  out.push(sec('🧠 Twin · unknowns & hard constraints (Q30/Q34)', [
    ...(unk.length ? unk.slice(0, 8).map((u) => row('unknown', u, 'warn', 'no evidence → planner asks from here')) : [row('unknowns', 'none', 'good')]),
    ...(neg.length ? neg.slice(0, 6).map((n) => row('NEVER', n, 'bad', 'hard constraint — never violated')) : []),
  ]));
  // (Q26) Buyer Profile identity — Layer A
  const a = twin.layer_a_identity;
  if (a) out.push(sec('🪪 Buyer Profile · identity (Q26)', [
    row('business type', a.business_type || '—', 'info', a.secondary_roles?.length ? `+ ${a.secondary_roles.join(', ')}` : undefined),
    row('location', [a.city, a.state].filter(Boolean).join(', ') || '—'),
    row('language', a.language || '—'),
    row('verified', a.verified ? 'yes' : 'no', a.verified ? 'good' : 'muted'),
    ...(a.company_desc ? [row('own description', String(a.company_desc).slice(0, 90), 'good')] : []),
  ]));
  return out;
}

function requirementFacts(reqr: RequirementLike, contradictions?: { count?: number; items?: string[] } | null): InspectorSection {
  const active = (reqr.registryFacts || []).slice(0, 8);
  const knownInSchema = reqr.knownInSchema || [];
  const dropped = reqr.knownDropped || [];
  const ask = reqr.ask || [];
  const rows: InspectorRow[] = [];
  // (Q71) currently ACTIVE facts
  for (const f of active) rows.push(row(`active · ${f.key || f.type || 'fact'}`, String(f.value ?? '').slice(0, 60), 'good', `${f.source || ''}${f.confidence != null ? ' · conf ' + f.confidence : ''}`));
  if (knownInSchema.length) rows.push(row('active · buyer-memory', `${knownInSchema.length} prior specs reused`, 'good', knownInSchema.slice(0, 5).join(', ')));
  // (Q72) SUPERSEDED / known → not re-asked (the guardrail receipt)
  if (dropped.length) rows.push(row('superseded (not re-asked)', `${dropped.length}`, 'muted', dropped.slice(0, 6).join(', ')));
  // (Q73/Q74) contradictions
  const cc = contradictions?.count ?? 0;
  rows.push(row('contradictions (Q73/74)', String(cc), cc ? 'bad' : 'good', cc ? (contradictions?.items || []).slice(0, 4).join('; ') : 'no active contradictions'));
  // what's still to ask
  if (ask.length) rows.push(row('still to ask', `${ask.length}`, 'info', ask.slice(0, 6).join(', ')));
  return sec('📒 Requirement brain · facts (W1 · H Q71-76)', rows);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// W2 · SPEC-REASONING — per spec: shown vs hidden · reorder rank · auto-fill evidence · confidence · alts
// ════════════════════════════════════════════════════════════════════════════════════════════════
function specReasoning(specs: SpecLike[], specOrder: string[], criticalRanked: Array<{ name?: string; maps_to_isq?: string; seller_frequency?: number | null }>): InspectorSection {
  const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const orderRank = new Map(specOrder.map((n, i) => [norm(n), i]));
  const askedKeys = new Set(specs.map((s) => norm(s.name)));
  const rows: InspectorRow[] = [];
  for (const s of specs.slice(0, 8)) {
    const rank = orderRank.get(norm(s.name));
    const auto = /cascade|infer|deduc/.test(s.source || '');
    const why = s.value ? (auto ? `auto-filled from ${s.source} — ⚠ inference` : `filled (${s.source || 'user'})`) : (s.reason || 'asked');
    rows.push(row(s.name, s.value ? (auto ? 'AUTO' : 'filled') : 'asked', auto ? 'warn' : s.value ? 'good' : 'info',
      `${rank != null ? `rank #${rank + 1}` : 'unranked'}${typeof s.sellerFreq === 'number' ? ` · ${s.sellerFreq}% sellers ask` : ''} · ${why}`,
      typeof s.priority === 'number' ? s.priority : undefined));
  }
  // (Q65) criticals NOT shown — the "why hidden" answer
  const hidden = (criticalRanked || []).filter((c) => { const k = norm(c.maps_to_isq || c.name); return k && !askedKeys.has(k) && ![...askedKeys].some((a) => a.includes(k) || k.includes(a)); }).slice(0, 5);
  for (const h of hidden) rows.push(row(`  (hidden) ${h.name || '—'}`, 'not shown', 'muted', `seller-freq ${h.seller_frequency ?? '—'} — no ISQ mapping / below cut`));
  return sec('🧩 Spec reasoning (W2 · G Q64-70)', rows);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// W7 · OUTCOME-VALUE — prediction vs reality (lights up only with a real lead/call-outcome feed)
// ════════════════════════════════════════════════════════════════════════════════════════════════
function outcomeSection(outcome?: OutcomeLike | null): InspectorSection {
  if (!outcome) {
    return sec('🎯 Outcome value (W7 · K Q93-98 · L19)', [
      row('status', 'awaiting outcome feed', 'muted', 'prediction-vs-outcome is INFRA-GATED — needs a real lead/call-outcome source. STRUCTURAL until then.'),
    ]);
  }
  const right = outcome.predictedIntent && outcome.actualIntent ? norm(outcome.predictedIntent) === norm(outcome.actualIntent) : undefined;
  return sec('🎯 Outcome value (W7 · K Q93-98 · L19)', [
    row('converted', outcome.converted == null ? '—' : outcome.converted ? 'yes' : 'no', outcome.converted ? 'good' : 'warn'),
    row('intent prediction', right == null ? '—' : right ? 'CORRECT' : 'WRONG', right ? 'good' : 'bad', `predicted ${outcome.predictedIntent ?? '—'} · actual ${outcome.actualIntent ?? '—'}`),
    row('questions answered', outcome.respondedQuestions?.length != null ? String(outcome.respondedQuestions.length) : '—', 'info', 'which planner questions the buyer actually engaged'),
  ]);
}
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ── the public entry: all deep sections, in display order ──
export function deepSections(input: DeepInput): InspectorSection[] {
  const out: InspectorSection[] = [];
  if (input.twin) out.push(...twinConstruction(input.twin));
  if (input.requirement) out.push(requirementFacts(input.requirement, input.contradictions));
  if (input.specs && input.specs.length) out.push(specReasoning(input.specs, input.specOrder || [], input.requirement?.criticalRanked || []));
  out.push(outcomeSection(input.outcome));
  return out;
}
