// ─── RFQ DECISION AUDIT (the SCORECARD) ──────────────────────────────────────
// "Without this you won't know whether all this intelligence is actually doing anything."
// The measure half of feed-and-measure. Every RFQ produces a transparent tally of what the
// intelligence stack actually DID: facts known vs used, questions avoided (the knownDropped
// guardrail + coverage suppression + auto-fills), which brains contributed, contradictions caught,
// and a single confidence number. Pure + deterministic → harnessable, and attachable to submission.
//
// The headline metric is UTILIZATION, not volume: a system that knows 11 facts and uses 6 is doing
// more than one that knows 50 and uses 3. "Good AI knows more and asks LESS."

export interface ScorecardInput {
  factsAvailable: number;            // distinct facts known about this buyer/requirement
  factsUsed: number;                 // facts that changed the form (suppressed a question / prefilled / reranked)
  questionsAsked: number;            // questions actually put to the buyer
  questionsAvoided: number;          // knownDropped + coverage-suppressed + cascade prefills
  autoFilled: number;                // spec fields prefilled from memory/cascade
  contradictions: number;            // cross-signal conflicts surfaced (a GOOD catch, but lowers confidence)
  locationPreferenceReused: boolean; // a conversational location pref was consumed
  prevRequirementReused: boolean;    // repost or prior known-specs reused
  categoryIntelUsed: boolean;        // category brain was 'hit' and fed the resolver
  buyerIntelUsed: boolean;           // requirement_brain facts were present
  conversationalSignalsUsed: number; // count of conversational signals consumed
}

export interface Scorecard extends ScorecardInput {
  factsIgnored: number;
  utilizationPct: number;  // factsUsed / factsAvailable
  confidence: number;      // 0-100 composite
  grade: 'A' | 'B' | 'C' | 'D';
  lines: string[];         // human-readable readout (the ChatGPT-style rows)
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0);

// ─── UTILIZATION TALLY ────────────────────────────────────────────────────────
// The honest answer to "how much of what we know did we USE?". The old caller set
// factsUsed = questionsAvoided ONLY → "2/44 used" even when category criticals, conversational
// signals, the locked intent and the buyer persona ALL shaped the RFQ. This counts every distinct
// kind of consumption, and grows the knowable universe by the same category contribution so the
// ratio stays meaningful (numerator and denominator move together). Pure → harnessable.
export interface UtilizationParts {
  questionsAvoided: number;       // engine-filled/twin-skipped/deduced/resolver-dropped/repost/loc-pref
  conversationalSignalsUsed: number; // conversational signals actually consumed
  categoryCriticalsUsed: number;  // category criticals that reranked/added specs (0 if not hit/consumed)
  categoryEnhancers: number;      // category budget bands + deal-blocker checks applied
  intentUsed: number;             // 1 if a requirement intent was captured/locked
  personaUsed: number;            // 1 if the buyer persona fed the planner
  registryFacts: number;          // buyer-intelligence facts available (the knowable base)
  conversationalAvailable: number; // conversational signals available
  isqSpecs: number;               // category ISQ schema size (knowable specs)
}
export function tallyUtilization(p: UtilizationParts): { factsUsed: number; factsAvailable: number } {
  const used = Math.max(0, p.questionsAvoided) + Math.max(0, p.conversationalSignalsUsed)
    + Math.max(0, p.categoryCriticalsUsed) + Math.max(0, p.categoryEnhancers)
    + Math.max(0, p.intentUsed) + Math.max(0, p.personaUsed);
  const knowable = Math.max(0, p.registryFacts) + Math.max(0, p.conversationalAvailable)
    + Math.max(0, p.isqSpecs) + Math.max(0, p.categoryCriticalsUsed) + Math.max(0, p.categoryEnhancers);
  return { factsUsed: used, factsAvailable: Math.max(used, knowable) };
}

export function scoreRFQ(input: ScorecardInput): Scorecard {
  const factsAvailable = Math.max(0, input.factsAvailable);
  const factsUsed = clamp(input.factsUsed, 0, factsAvailable);
  const factsIgnored = Math.max(0, factsAvailable - factsUsed);
  const utilizationPct = pct(factsUsed, factsAvailable);

  // Transparent composite. Base + utilization + questions-avoided + reuse bonuses − contradictions.
  let confidence = 40;
  confidence += (utilizationPct / 100) * 30;                       // up to +30 for using what we know
  confidence += (Math.min(input.questionsAvoided, 8) / 8) * 15;    // up to +15 for asking less
  if (input.buyerIntelUsed) confidence += 4;
  if (input.prevRequirementReused) confidence += 5;
  if (input.locationPreferenceReused) confidence += 4;
  if (input.categoryIntelUsed) confidence += 5;
  if (input.conversationalSignalsUsed > 0) confidence += Math.min(input.conversationalSignalsUsed, 3);
  confidence -= input.contradictions * 6;                          // unresolved conflicts erode trust
  confidence = clamp(Math.round(confidence));

  const grade: Scorecard['grade'] = confidence >= 80 ? 'A' : confidence >= 65 ? 'B' : confidence >= 50 ? 'C' : 'D';
  const yn = (b: boolean) => (b ? 'Yes' : 'No');
  const lines = [
    `Known facts: ${factsUsed}/${factsAvailable} used (${factsIgnored} ignored)`,
    `Questions avoided: ${input.questionsAvoided}`,
    `Questions asked: ${input.questionsAsked}`,
    `Fields auto-filled: ${input.autoFilled}`,
    `Conversational signals used: ${input.conversationalSignalsUsed}`,
    `Location preference reused: ${yn(input.locationPreferenceReused)}`,
    `Previous requirement reused: ${yn(input.prevRequirementReused)}`,
    `Category intelligence used: ${yn(input.categoryIntelUsed)}`,
    `Buyer intelligence used: ${yn(input.buyerIntelUsed)}`,
    `Cross-signal conflicts (open): ${input.contradictions}`,
    `Confidence: ${confidence}%`,
  ];

  return { ...input, factsUsed, factsIgnored, utilizationPct, confidence, grade, lines };
}

// One-line summary for compact display.
export function scorecardSummary(s: Scorecard): string {
  return `${s.grade} · ${s.confidence}% · avoided ${s.questionsAvoided}q · used ${s.factsUsed}/${s.factsAvailable} facts`;
}
