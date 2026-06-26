// ─── Requirement-Brain RESOLVER (Phase 1, form side · "RFQ = Reflexes") ───────
// The n8n brain returns stable, cached intelligence: BUYER BRAIN (facts + known specs/intent) and
// CATEGORY BRAIN (critical_specs by seller-frequency + common_followups). This module is the RESOLVER:
// it turns those two brains + the form's LIVE state into the ephemeral REQUIREMENT BRAIN (what to ask
// for THIS product, right now). It is the ONLY place the subtraction lives, and the subtraction is the
// guardrail ChatGPT insisted on — NEVER ask what the buyer already told us.
//
//   ask = (category.critical_specs + common_followups)  MINUS  (buyer known + current-session answers)
//
// Pure · deterministic · channel-agnostic (RFQ/WhatsApp/VANI can all call it). No LLM. The Requirement
// Brain it produces is a generated VIEW — never cached, never a system of record.

export interface BrainFact { source: string; type: string; key: string; value: string; evidence?: string; confidence?: number }
export interface CriticalSpec { name: string; seller_frequency?: number | null; maps_to_isq?: string }
export interface RequirementBrainInput {
  facts?: BrainFact[];
  buyer_intelligence?: {
    known_specs?: string[];
    known_intent?: string[];
    history_categories?: string[];
    conversational_signals?: Array<{ key: string; value: string }>; // v13+ (Layer-2 fuel)
  };
  category_intelligence?: {
    critical_specs?: CriticalSpec[];
    intent_patterns?: Array<{ intent: string; frequency?: number } | string>;
    // v13 cat_store derives this from seller_usually_ask as OBJECTS ({question, maps_to_spec,
    // frequency}); older/other producers may send plain strings. Accept BOTH; normalize on read.
    common_followups?: Array<string | { question?: string; maps_to_spec?: string; frequency?: string }>;
    deal_blockers?: Array<{ name: string; frequency?: number } | string>;
  } | null;
  planner_input?: { category_critical_specs?: CriticalSpec[]; buyer_known_specs?: string[]; suggested_ask?: CriticalSpec[] };
}

const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Pull the appended `requirement_brain` item out of the webhook response (an array of per-source items
// + one brain item). Defensive: returns null if absent, so the form degrades to its current behaviour.
export function parseRequirementBrain(raw: unknown): RequirementBrainInput | null {
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  for (const item of arr) {
    const rb = (item && typeof item === 'object') ? (item as Record<string, unknown>).requirement_brain : undefined;
    if (rb && typeof rb === 'object') return rb as RequirementBrainInput;
  }
  return null;
}

export interface ResolveContext {
  isqSpecNames: string[];       // the category's ISQ schema (canonical spec list — already in the form)
  answeredSpecNames: string[];  // specs the buyer has filled THIS session (live)
  intentKnown: boolean;         // page-1 intent already captured
}
export interface ResolvedRequirement {
  specOrder: string[];          // ISQ specs reprioritised by seller-frequency, criticals first
  addedSpecs: string[];         // critical specs NOT in the ISQ schema → add at top (debug: "added from category intel")
  ask: string[];               // what to ask = (critical + followups) − known   ← the subtraction
  knownDropped: string[];       // what we did NOT ask because it's already known  ← proves the guardrail fired
  criticalRanked: CriticalSpec[]; // category criticals, highest seller-frequency first
  registryFacts: BrainFact[];   // facts to record into the Coverage Registry (incl. PNS intent)
  knownInSchema: string[];      // buyer's prior-answered specs that ARE in this ISQ schema → skip/prefill, NO category needed (buyer memory works immediately)
}

// THE RESOLVER. Given the brain + the form's live state → the Requirement-Brain view.
export function resolveRequirement(brain: RequirementBrainInput | null, ctx: ResolveContext): ResolvedRequirement {
  const empty: ResolvedRequirement = { specOrder: [...(ctx?.isqSpecNames || [])], addedSpecs: [], ask: [], knownDropped: [], criticalRanked: [], registryFacts: [], knownInSchema: [] };
  if (!brain) return empty;

  const critical = (brain.category_intelligence?.critical_specs || brain.planner_input?.category_critical_specs || []).filter((c) => c && (c.name || c.maps_to_isq));
  const criticalRanked = [...critical].sort((a, b) => (b.seller_frequency ?? 0) - (a.seller_frequency ?? 0));

  // KNOWN = buyer's prior known specs + intent + this session's answers (the live part).
  const known = new Set<string>([
    ...(brain.buyer_intelligence?.known_specs || []),
    ...(brain.buyer_intelligence?.known_intent || []),
    ...(ctx.answeredSpecNames || []),
  ].map(norm));

  // 1) REPRIORITISE the ISQ schema by seller-frequency (criticals float up).
  const freq = new Map<string, number>();
  for (const c of criticalRanked) freq.set(norm(c.maps_to_isq || c.name), c.seller_frequency ?? 50);
  const isqRanked = [...(ctx.isqSpecNames || [])].sort((a, b) => (freq.get(norm(b)) ?? -1) - (freq.get(norm(a)) ?? -1));

  // 2) ADD criticals that the ISQ schema is missing (the common_missing_specs case).
  const isqSet = new Set((ctx.isqSpecNames || []).map(norm));
  const addedSpecs = criticalRanked.filter((c) => { const k = norm(c.maps_to_isq || c.name); return k && !isqSet.has(k); }).map((c) => c.name);

  // BUYER MEMORY (no category needed): prior-answered specs that ARE fields in THIS ISQ schema.
  // These can be skipped/prefilled the instant the buyer pull lands — the form is intelligent before
  // category intel arrives (ChatGPT: "buyer memory makes the form intelligent immediately").
  const answeredSet = new Set((ctx.answeredSpecNames || []).map(norm));
  const knownInSchema = [...(brain.buyer_intelligence?.known_specs || [])]
    .filter((k) => isqSet.has(norm(k)) && !answeredSet.has(norm(k)));

  // 3) SUBTRACT — the guardrail. ask = (critical + followups) − known. Never ask a known.
  // common_followups may be strings OR {question,...} objects (v13 cat_store shape) — normalize to
  // the question text so `ask` never contains "[object Object]".
  const followups = (brain.category_intelligence?.common_followups || [])
    .map((f) => (typeof f === 'string' ? f : (f && typeof f === 'object' ? (f.question || f.maps_to_spec || '') : '')))
    .filter(Boolean);
  const askCandidates = [...criticalRanked.map((c) => c.maps_to_isq || c.name), ...followups].filter(Boolean);
  const seen = new Set<string>();
  const ask: string[] = []; const knownDropped: string[] = [];
  for (const cand of askCandidates) {
    const k = norm(cand);
    if (!k || seen.has(k)) continue; seen.add(k);
    (known.has(k) ? knownDropped : ask).push(cand);
  }

  return { specOrder: [...addedSpecs, ...isqRanked], addedSpecs, ask, knownDropped, criticalRanked, registryFacts: brain.facts || [], knownInSchema };
}
