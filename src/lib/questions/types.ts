// ─── Dynamic non-spec question engine — shared types ──────────────────────────

// Buyer/category segment, derived from in-session signals (cold mode) and
// optionally sharpened by enrichment later. Drives WHICH questions fire & depth.
export type Segment =
  | 'retail' // end-consumer / B2C / hyperlocal, small qty → minimal questions
  | 'b2b_small' // business buyer, small/sample qty → moderate
  | 'b2b_bulk' // business buyer, bulk/recurring → thorough
  | 'reseller' // reseller / trader / stockist → thorough (margins, market)
  | 'capital' // machinery / capital good, no unit qty → thorough (site/install)
  | 'service' // service category, no specs/qty → thorough (scope/timeline)
  | 'unknown'; // not enough signal yet → moderate default

// Where a question is rendered. Slots map onto the form, not fixed step indexes.
export type Slot =
  | 'product' // inline on the product page (flow-forking only)
  | 'specs' // woven into the spec page, near its trigger
  | 'requirement' // logistics & requirement step
  | 'persona' // persona / business profile step (collapsed, contextual)
  | 'postsubmit' // collected after Get-Quotes (success screen)
  | 'skip'; // not asked

export type Bucket = 'requirement' | 'persona' | 'business';

export interface DynQuestion {
  id: string; // stable key; answer stored in form.dynamicEnrich[id]
  label: string; // the question shown to the buyer
  options?: string[]; // chips; empty/undefined → free text
  multi?: boolean; // allow multiple options
  slot: Slot;
  afterSpec?: string; // slot==='specs': the exact spec field this question renders after
  bucket: Bucket;
  optional?: boolean; // never blocks submit
  prefill?: string; // value from enrichment (Phase 4); empty in cold mode
  reason?: string; // ≤12-word rationale ("why we ask"); shown only in debug
  groundedIn?: string; // A1: the REGISTRY signal that justifies this question (qty/category/profile/history) — required for non-spec questions; debug-auditable
  source?: 'seed' | 'llm' | 'isq'; // provenance, for debugging/telemetry
  tier?: 'intent' | 'scale' | 'constraint' | 'spec'; // carried from PlanQuestion → lets P6 treat a wizard INTENT answer as a re-rank trigger
  // ── Debug provenance (HOD trace): which PROMPT produced this question and
  // WHAT was passed to it — so debug mode can explain how/why it surfaced. ──
  genBy?: 'planner' | 'generator' | 'seed' | 'cascade' | 'refine';
  genInputs?: string; // compact signature of the inputs fed to that prompt
}

// How "thorough" the form is allowed to be, by segment.
export interface DepthPolicy {
  maxQuestions: number; // cap on in-form non-spec questions
  askPersona: boolean;
  askBusiness: boolean; // company size/type/turnover/GST
}

export const DEPTH_BY_SEGMENT: Record<Segment, DepthPolicy> = {
  retail: { maxQuestions: 2, askPersona: false, askBusiness: false },
  b2b_small: { maxQuestions: 5, askPersona: true, askBusiness: false },
  b2b_bulk: { maxQuestions: 9, askPersona: true, askBusiness: true },
  reseller: { maxQuestions: 8, askPersona: true, askBusiness: true },
  capital: { maxQuestions: 9, askPersona: true, askBusiness: true },
  service: { maxQuestions: 8, askPersona: true, askBusiness: true },
  unknown: { maxQuestions: 5, askPersona: true, askBusiness: false },
};

// ─── Intent Planner ───────────────────────────────────────────────────────────
// One LLM pass at product-commit that reads the category's selling intent and
// decides the SHAPE of the RFQ: archetype → order → the one leading qualifier →
// which specs are decisive → the questions a seller in this trade actually asks,
// with placement. ISQs are a REFERENCE (the spec dimension), not the goal.
export type Archetype =
  | 'commodity'
  | 'branded_commodity'
  | 'capital'
  | 'made_to_spec'
  | 'project_service'
  | 'visual_odd_part'
  | 'unknown';

export interface PlanQuestion {
  id: string;
  label: string;
  options?: string[]; // chips; [] → free text
  kind: 'spec' | 'context' | 'persona' | 'identity' | 'logistics';
  // P5b funnel inversion: information-gain tier. The panel renders intent → scale →
  // constraint → spec, so the buyer establishes WHY/HOW-BIG before product attributes.
  tier?: 'intent' | 'scale' | 'constraint' | 'spec';
  decisive?: boolean;
  placement: 'page1' | 'specpage' | 'wizard' | 'laststep';
  order?: number;
  reason?: string; // ≤12 words; why a seller asks it
  groundedIn?: string; // A1: the concrete registry signal that justifies THIS question (qty / category / buyer history / profile pattern) — empty ⇒ the parser DROPS it
  priority?: number; // DEBUG observability: the planner's own 0-100 score for this question. Does NOT affect selection/order (the parser's tier+cap logic is unchanged) — it only EXPLAINS the ranking in the leaderboard.
}

export interface RequirementPlan {
  archetype: Archetype;
  orderMode: 'spec_first' | 'qualifier_first';
  leadingQuestion: string; // the one decisive qualifier, or '' for pure commodity
  mustHaveSpecs: string[]; // decisive ISQ subset (exact field names)
  questions: PlanQuestion[];
  serveSignals: string[]; // what the seller needs to decide serve/no-serve
  // ── P1: intent-ranking (shadow until wired into the UI) ──
  specOrder?: string[]; // ALL ISQ spec names ranked by inference power (highest-intent first)
  specReasons?: Record<string, string>; // P3 "gold": per-spec ≤12-word WHY-HERE sentence (why ranked where it is) — HOD-facing, never engineering-grade
  lead?: { source: 'spec' | 'qualifier'; ref: string }; // the #1 intent-driver — a spec OR a qualifier
  personaOptions?: string[]; // category-tailored buyer types (replaces the generic role list)
  // ── P5b: Twin-aware planning (the "ruthless editor") ──
  twinResolved?: string[]; // topics the planner SKIPPED because the Twin already knew them (≥80 conf) — drives the question-budget metric ("high-confidence buyer → fewer questions")
  twinMode?: 'fast_track' | 'cold_discover' | 'off_profile' | 'none'; // which track the planner took (code-derived), for the debug readout
  considered?: Array<{ label: string; score: number; reason: string }>; // DEBUG observability: questions the planner WEIGHED but did NOT select (lost to the 3-cap, or covered by a sibling/spec/intent), each with a 0-100 score + a one-line why-not. Pure provenance — never rendered to the buyer, never affects the asked set.
}

// ─── A6: Requirement Intent (first-class — NOT the per-category ISQ "Use Case") ──
// The buyer's WHY, captured BEFORE the planner so it shapes the single plan. Journey
// adapts the question; locked freezes it once answered (planner must not reinterpret).
export interface RequirementIntent {
  value: string | null; // the chosen/derived intent, e.g. "Corporate Gifting" (null until known)
  journey: string; // retail | resale | industrial | project | maintenance | personal | unknown
  question: string; // the journey-adapted question shown to the buyer
  chips: string[]; // option chips
  confidence: number; // 0 until answered; 100 when buyer selects; 50-80 if derived from Twin
  source: 'buyer' | 'derived';
  locked: boolean; // once answered, the planner/cascade/re-rank must NOT reinterpret it
}
