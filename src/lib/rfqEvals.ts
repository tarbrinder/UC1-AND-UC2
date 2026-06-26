// ─── RFQ EVALS — "was this GOOD?" (quality judgment), distinct from HARNESSES ("is it CORRECT?") ──
// A harness asserts output == expected on a fixed input (regression). An eval scores the quality of a
// LIVE RFQ across the dimensions that actually matter for lead quality — and produces a number that
// can be tracked over time, so we can tell whether a change HELPED, not just "didn't break."
// Pure · deterministic · NO LLM (heuristic scorers over signals the engine already produced).
//
//   Question Quality · Category Quality · Fusion Quality · Planner Quality → overall RFQ eval.

export interface EvalDimension { name: string; score: number; max: number; note: string }
export interface RFQEval { score: number; max: number; pct: number; grade: 'A' | 'B' | 'C' | 'D'; dimensions: EvalDimension[]; issues: string[] }

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// 1 ── QUESTION QUALITY — are the asked questions decisive, grounded, chip-based, non-redundant, capped?
export interface QQInput {
  questions: Array<{ label: string; grounded: boolean; optionCount: number; tier?: string }>;
  specNames: string[];   // the ISQ spec set — a question that re-asks a spec is redundant
  maxCards?: number;     // the panel cap (default 3)
}
export function questionQualityEval(i: QQInput): EvalDimension {
  const qs = i.questions || [];
  const cap = i.maxCards ?? 3;
  // A known buyer with ZERO planner questions is a GOOD outcome (fast-track), not a failure.
  if (qs.length === 0) return { name: 'Question Quality', score: 100, max: 100, note: '0 planner cards (known buyer / off-profile lead) — nothing to fault' };
  const grounded = qs.filter((q) => q.grounded).length;
  const chipped = qs.filter((q) => q.optionCount >= 2).length;
  const specSet = new Set((i.specNames || []).map(norm));
  const redundant = qs.filter((q) => specSet.has(norm(q.label.replace(/\?$/, '')))).length;
  const groundedScore = (grounded / qs.length) * 40;
  const chipScore = (chipped / qs.length) * 25;
  const redundantScore = qs.length ? (1 - redundant / qs.length) * 20 : 20;
  const volumeScore = qs.length <= cap ? 15 : clamp(15 - (qs.length - cap) * 5, 0, 15);
  const score = Math.round(groundedScore + chipScore + redundantScore + volumeScore);
  const flags: string[] = [];
  if (grounded < qs.length) flags.push(`${qs.length - grounded} ungrounded`);
  if (redundant) flags.push(`${redundant} re-ask a spec`);
  if (qs.length > cap) flags.push(`${qs.length} cards (cap ${cap})`);
  return { name: 'Question Quality', score: clamp(score), max: 100, note: flags.length ? flags.join(' · ') : `${qs.length} grounded chip questions, capped` };
}

// 1b ── INTENT QUALITY — was the FIRST-PAGE intent decision specific, decisive, and aligned?
// Consumes deriveIntent's scored intent_candidates (the LLM's self-ranked end-uses). Penalises a
// generic/journey-word winner (the "umbrella" failure — e.g. picking "industrial" instead of a real
// end-use), rewards a clear MARGIN over the runner-up (decisiveness), and a chosen value that MATCHES
// the top-scored candidate. A null chosen (we asked the buyer) is neutral — restraint, not a failure.
const GENERIC_INTENT = new Set(['retail', 'resale', 'industrial', 'project', 'maintenance', 'personal', 'unknown', 'general', 'generaluse', 'other', 'use', 'business', 'commercial', 'misc', 'packaging', 'supply', 'equipment']);
export interface IntentQInput { chosen: string | null; candidates: Array<{ label: string; score: number }> }
export function intentQualityEval(i: IntentQInput): EvalDimension {
  const cands = (i.candidates || []).slice().sort((a, b) => b.score - a.score);
  const top = cands[0];
  if (!i.chosen) return { name: 'Intent Quality', score: 100, max: 100, note: top ? `asked the buyer (no pre-fill) · top candidate "${top.label}" ${top.score}` : 'asked the buyer (no candidates emitted)' };
  const isGeneric = GENERIC_INTENT.has(norm(i.chosen));
  const specScore = isGeneric ? 10 : 50;                                   // 50: a concrete end-use, not an umbrella
  const margin = cands.length >= 2 ? clamp(cands[0].score - cands[1].score) : (top ? top.score : 50);
  const marginScore = clamp((margin / 40) * 30, 0, 30);                    // 30: clear winner over the runner-up
  const aligned = top ? (norm(i.chosen).includes(norm(top.label)) || norm(top.label).includes(norm(i.chosen))) : false;
  const alignScore = top ? (aligned ? 20 : 8) : 12;                        // 20: chosen matches the top-scored candidate
  const score = Math.round(specScore + marginScore + alignScore);
  const flags: string[] = [];
  if (isGeneric) flags.push('generic/umbrella winner');
  if (cands.length >= 2 && margin < 15) flags.push(`thin margin (${cands[0].score} vs ${cands[1].score})`);
  if (top && !aligned) flags.push('chosen ≠ top candidate');
  return { name: 'Intent Quality', score: clamp(score), max: 100, note: flags.length ? flags.join(' · ') : `specific intent "${i.chosen}", clear winner` };
}

// 2 ── CATEGORY QUALITY — wraps the structural categoryConfidence (0-100) into an eval dimension.
export function categoryQualityEval(confidenceScore: number, band: string): EvalDimension {
  return { name: 'Category Quality', score: clamp(Math.round(confidenceScore)), max: 100, note: `${band} category intelligence` };
}

// 3 ── FUSION QUALITY — did buyer×category fusion behave per the gate? (rich+operation ⇒ fuse;
// thin/empty ⇒ DON'T fuse). A false fusion on weak data is the worst outcome (multiplying noise).
export interface FQInput { band: 'rich' | 'thin' | 'empty'; fusionFired: boolean; buyerHasOperation: boolean }
export function fusionQualityEval(i: FQInput): EvalDimension {
  const shouldFuse = i.band === 'rich' && i.buyerHasOperation;
  let score: number, note: string;
  if (shouldFuse && i.fusionFired) { score = 100; note = 'rich category × known operation → fused (correct)'; }
  else if (shouldFuse && !i.fusionFired) { score = 60; note = 'rich category × operation but did NOT fuse (missed)'; }
  else if (!shouldFuse && i.fusionFired) { score = 20; note = `fused on a ${i.band} category (false fusion — multiplying weak intel)`; }
  else { score = 100; note = i.band === 'empty' ? 'empty category → buyer-only (correct restraint)' : 'no fusion (correct — gate not met)'; }
  return { name: 'Fusion Quality', score, max: 100, note };
}

// 4 ── PLANNER QUALITY — did the planner produce a well-formed shape (archetype, lead, must-haves,
// a capped + grounded question set)?
export interface PQInput { archetype?: string; hasLead: boolean; mustHaveCount: number; questionCount: number; groundedQuestions: number }
export function plannerQualityEval(i: PQInput): EvalDimension {
  const archetypeOk = !!i.archetype && i.archetype !== 'unknown';
  const grounded = i.questionCount === 0 ? true : i.groundedQuestions >= i.questionCount;
  const score = (archetypeOk ? 20 : 0) + (i.hasLead ? 20 : 0) + (i.mustHaveCount >= 1 ? 20 : 0) + (i.questionCount <= 3 ? 20 : 0) + (grounded ? 20 : 0);
  const flags: string[] = [];
  if (!archetypeOk) flags.push('no archetype');
  if (!i.hasLead) flags.push('no lead spec');
  if (i.mustHaveCount < 1) flags.push('no must-have specs');
  if (i.questionCount > 3) flags.push('over card cap');
  if (!grounded) flags.push('ungrounded questions');
  return { name: 'Planner Quality', score, max: 100, note: flags.length ? flags.join(' · ') : 'archetype + lead + must-haves + capped grounded questions' };
}

// ─── BUSINESS EVALS (proxy / leading indicators) ─────────────────────────────────────────────
// The system evals above ask "did the engine behave well?". These ask "is this a GOOD RFQ / lead?"
// — predicted from the RFQ shape. They are LEADING indicators; the true outcome evals (seller
// response rate, quote count, conversion) require post-RFQ data we don't have client-side. Honest
// proxies, clearly labelled.

// RFQ Quality — can a seller quote on this WITHOUT back-and-forth? (completeness + basics + trust)
export interface RFQQInput {
  mustHaveTotal: number; mustHaveFilled: number;
  hasQuantity: boolean; hasIntent: boolean; hasLocation: boolean; identityVerified: boolean;
  openContradictions: number;
}
export function rfqQualityEval(i: RFQQInput): EvalDimension {
  const completeness = i.mustHaveTotal > 0 ? (i.mustHaveFilled / i.mustHaveTotal) * 35 : 35;
  const score = clamp(Math.round(
    completeness + (i.hasQuantity ? 10 : 0) + (i.hasIntent ? 15 : 0) + (i.hasLocation ? 10 : 0) +
    (i.identityVerified ? 15 : 0) + Math.max(0, 15 - i.openContradictions * 7.5)
  ));
  const flags: string[] = [];
  if (i.mustHaveTotal > 0 && i.mustHaveFilled < i.mustHaveTotal) flags.push(`${i.mustHaveTotal - i.mustHaveFilled} must-have spec(s) open`);
  if (!i.hasIntent) flags.push('no intent');
  if (!i.identityVerified) flags.push('identity unverified');
  if (i.openContradictions) flags.push(`${i.openContradictions} open conflict(s)`);
  return { name: 'RFQ Quality (proxy)', score, max: 100, note: flags.length ? flags.join(' · ') : 'seller-ready: specs + intent + location + trust' };
}

// Lead Quality — how likely is this buyer to be a serious, convertible lead? (identity + maturity + engagement)
export interface LeadQInput {
  identityVerified: boolean; hasCompany: boolean; hasGST: boolean;
  maturity: string; intentLocked: boolean; engagementSignals: number;
}
export function leadQualityEval(i: LeadQInput): EvalDimension {
  const mat = /repeat/i.test(i.maturity) ? 20 : /existing/i.test(i.maturity) ? 16 : /new/i.test(i.maturity) ? 8 : 4;
  const score = clamp(Math.round(
    (i.identityVerified ? 20 : 0) + (i.hasCompany ? 15 : 0) + (i.hasGST ? 15 : 0) + mat +
    (i.intentLocked ? 15 : 0) + (Math.min(Math.max(i.engagementSignals, 0), 10) / 10) * 15
  ));
  const flags: string[] = [];
  if (!i.identityVerified) flags.push('unverified');
  if (!i.hasGST) flags.push('no GST');
  if (!i.intentLocked) flags.push('intent open');
  if (i.engagementSignals === 0) flags.push('no engagement history');
  return { name: 'Lead Quality (proxy)', score, max: 100, note: flags.length ? flags.join(' · ') : `${i.maturity} buyer · verified · engaged` };
}

// ─── OUTCOME EVAL (grounded leading-outcome — the closest signal to a true business outcome) ──────
// True outcome evals (seller-response rate, quote count, conversion) need a POST-RFQ data pipeline we
// don't have live. The strongest proxy we *do* have is the buyer's historical **deal_readiness**
// (Hot/Warm/Cold) extracted from their PNS calls — which the corpus shows correlates with deal
// progression — combined with whether THIS RFQ is seller-ready and friction-free. This predicts
// conversion-readiness; it is NOT a measured outcome (clearly labelled as such in the UI).
export interface OutcomeInput {
  dealReadiness?: string;   // 'Hot' | 'Warm' | 'Cold' (from the buyer's calls / enrichment)
  rfqComplete: boolean;     // seller-ready RFQ (completeness high)
  openBlockers: number;     // unresolved deal-blockers / conflicts
  buyerEngagement: number;  // call/WA volume signal (0-10)
  intentLocked: boolean;
}
export function outcomeEval(i: OutcomeInput): EvalDimension {
  const dr = (i.dealReadiness || '').toLowerCase();
  const rdy = /hot/.test(dr) ? 35 : /warm/.test(dr) ? 25 : /cold/.test(dr) ? 10 : 18; // unknown = neutral
  const score = clamp(Math.round(
    rdy + (i.rfqComplete ? 20 : 0) + (i.intentLocked ? 10 : 0) +
    (Math.min(Math.max(i.buyerEngagement, 0), 10) / 10) * 15 - i.openBlockers * 8 + 20
  ));
  const flags: string[] = [];
  if (!dr) flags.push('no deal-readiness signal');
  else flags.push(`deal-readiness: ${i.dealReadiness}`);
  if (!i.rfqComplete) flags.push('RFQ not seller-ready');
  if (i.openBlockers) flags.push(`${i.openBlockers} open blocker(s)`);
  return { name: 'Outcome (predicted, leading)', score, max: 100, note: flags.join(' · ') };
}

// Combine dimensions → one RFQ eval (equal-weight average of the dimensions present).
export function evaluateRFQ(dimensions: EvalDimension[]): RFQEval {
  const dims = dimensions.filter(Boolean);
  const max = dims.reduce((s, d) => s + d.max, 0) || 1;
  const score = dims.reduce((s, d) => s + d.score, 0);
  const pct = Math.round((score / max) * 100);
  const grade: RFQEval['grade'] = pct >= 80 ? 'A' : pct >= 65 ? 'B' : pct >= 50 ? 'C' : 'D';
  const issues = dims.filter((d) => d.score < d.max * 0.7).map((d) => `${d.name}: ${d.note}`);
  return { score, max, pct, grade, dimensions: dims, issues };
}
