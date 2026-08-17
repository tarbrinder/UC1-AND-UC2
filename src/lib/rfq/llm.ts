// ─── Dynamic RFQ — the three LLMs (Gemini flash-lite, key-safe via callLLM) ────
// LLM 1 = Requirement Brain (+ Page-1 payload).  LLM 2 = Commercial.  LLM 3 = Persona.
// Each returns the standard PlannerEnvelope; LLM 1 additionally returns the brain +
// known_truths. Parse failure → null, so the orchestrator uses its deterministic fallback.
import { callLLM, recordParse } from '../gemini';
import { BUDGET, type EffortMode, type ExecMode, type PlannerEnvelope, type Question, type RequirementBrain, type RequirementBrainResult, type SessionState } from './contracts';
import type { BuyerSpec } from './dataLayer';

export const RFQ_LLM_VERSION = { brain: 'rb-v1', commercial: 'cx-v1', persona: 'ps-v1' };

// "DON'T TRIM" (owner 2026-07-31): the cap is a pure runaway-BACKSTOP now, not a routine trim. Every realistic source
// (category insights, buyer/seller ISQ, CSL, RFQ, profile, WhatsApp) is well under this; only a pathological unbounded
// PNS-full transcript could ever reach it. SAME value in prod and debug, so the DATA the LLM sees is byte-identical in
// both modes — the whole point of the mode split is verbosity, never the data.
const FENCE_CAP = 60000; // chars ≈ 15k tokens per source — backstop only, was a 10k routine trim
// EMPTY means EMPTY, in both fences: null/undefined, an empty array AND an empty object all render "(none)".
// `{}` used to render as literal "{}", which (a) told the model an input existed when it carried nothing and
// (b) made the inspector's source chips show e.g. `already_filled` as present-with-data on every fresh product.
// JSON.stringify can throw (circular refs / BigInt); a fenced input must never take the whole call down, so both
// fences share one guarded serializer that degrades to a marker instead of raising.
const isEmptyish = (v: unknown): boolean =>
  v == null
  || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);
const safeStringify = (v: unknown, pretty: boolean): string => {
  try { const s = JSON.stringify(v, null, pretty ? 1 : undefined); return s == null ? String(v) : s; }
  catch { return '(unserialisable input)'; }
};
// TRUNCATION PARITY (fix 2026-08-01): the cap is applied to the COMPACT serialization in BOTH modes, so prod and
// debug cut at the SAME data boundary. Previously each fence capped its own rendering, and because the numbered
// fence pretty-prints (several times more characters for identical data) debug hit the cap FIRST — i.e. AI-Debug
// could show the model LESS data than production, the exact opposite of the invariant this project locked.
const withinCap = (v: unknown): { body: unknown; cut: number } => {
  const compact = safeStringify(v, false);
  if (compact.length <= FENCE_CAP) return { body: v, cut: 0 };
  return { body: `${compact.slice(0, FENCE_CAP)}…[truncated ${compact.length - FENCE_CAP} chars — runaway backstop]`, cut: compact.length - FENCE_CAP };
};
const fence = (tag: string, v: unknown) => {
  if (isEmptyish(v)) return `<${tag}>\n(none)\n</${tag}>`;
  const { body, cut } = withinCap(v);
  return `<${tag}>\n${cut ? String(body) : safeStringify(body, false)}\n</${tag}>`;
};
// DEBUG-ONLY line-numbered fence: the SAME data as fence(), pretty-printed with an "Lnn " prefix per line so the model
// can cite each evidence fact as "<source>:Lnn" and the inspector can resolve a cited line back to its content. Values
// are identical to fence() — only the presentation differs (owner: "data will be exactly same, just the functioning is
// a little different… in debug mode aren't we adding the line"). Prod NEVER uses this.
const fenceNumbered = (tag: string, v: unknown) => {
  if (isEmptyish(v)) return `<${tag}>\n(none)\n</${tag}>`;
  const { body, cut } = withinCap(v);                       // same boundary as prod, then render
  const s = cut ? String(body) : safeStringify(body, true);
  const numbered = s.split('\n').map((ln, i) => `L${i + 1} ${ln}`).join('\n');
  return `<${tag}>\n${numbered}\n</${tag}>`;
};
// The active fence for a call: line-numbered in AI-Debug (evidence cites lines), clean single-line in Production.
const fenceFor = (exec: ExecMode) => (exec === 'debug' ? fenceNumbered : fence);
// Generous token ceilings (owner: "token consumption can be high, intelligence shouldn't suffer"). A ceiling bills on
// ACTUAL use, so sizing for 'high' (where Gemini 2.5 reasoning tokens also draw on max_tokens) never costs low/medium
// calls anything — it only stops a high-effort JSON from truncating mid-object.
const BRAIN_MAXTOK = 18000;
const PLANNER_MAXTOK = 10000;

function parseJson(out: string): Record<string, unknown> | null {
  try {
    const m = out.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return JSON.parse((m ? m[1] : out).trim());
  } catch { return null; }
}

function normQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q, i) => {
    const o = q as Record<string, unknown>;
    const ui = ['ask', 'prefill', 'suggest', 'confirm'].includes(String(o.ui)) ? o.ui as Question['ui'] : 'ask';
    return {
      field: String(o.field ?? '').trim(),
      label: String(o.label ?? o.field ?? '').trim(),
      ui,
      value: o.value != null ? String(o.value) : undefined,
      suggestion: o.suggestion != null ? String(o.suggestion) : undefined,
      options: Array.isArray(o.options) ? o.options.map(String) : undefined,
      order: typeof o.order === 'number' ? o.order : i,
    };
  }).filter((q) => q.field && q.label);
}

// Two genuinely-separate variants (#11): PROD is stripped for speed — buyer-facing output only, no reasoning,
// no evidence, no extra keys. DEBUG adds the per-field reasoning trace for the AI Inspector. Same DECISIONS,
// different verbosity — the buyer sees identical questions either way.
const DEBUG_SUFFIX = `\nDEBUG MODE (extra keys are IGNORED in production — buyer-facing questions stay identical): the fenced inputs are LINE-NUMBERED (every line begins "Lnn "). Additionally set (a) metadata.reasoning = an object keyed by field, each { why, confidence (0-100), evidence, source, options }, where "options" is an object keyed by EACH option label you offered for that field (value = a SHORT reason it is on the list — from the corpus top_values, the buyer's own truth, or trade sense); prefix a PREFILLED/selected option with "PICKED: " and say why it is the pre-answer, and you MAY add an option you WEIGHED but did NOT offer as "DROPPED: <why>". "evidence" is an ARRAY of strings and EVERY entry MUST cite the exact input line it came from in the form "<source>:Lnn — <the fact>" (e.g. "truth_csl:L7 — buyer viewed 3 cake products"); if you cannot point to a specific line, it is NOT evidence — omit it and log the gap in needs_input instead; "source" is the fence tag (truth_csl, truth_rfq, browsed_specs, buyer_specs_schema, seller_specs, category_engine, pns, …). Any evidence array elsewhere in the output (e.g. brain.evidence) follows the SAME "<source>:Lnn — <fact>" rule. REASON FIRST, then map to the field. And (b) metadata.needs_input = an array of { attribute, missing_reason, best_next_question } for every important thing you could NOT ground from the truth (record it here INSTEAD of guessing a value).`;
// Planner-only debug addendum (WS-3): the question-COMPETITION ledger. The brain has BRAIN_DEBUG_CONSIDERED; the two
// planners had reasoning + needs_input but no candidate pool, so "what competed, what won and why" was unanswerable
// for Page 2 / Page 3. This supplies it.
const PLANNER_DEBUG_CONSIDERED = (kind: 'commercial' | 'persona') => {
  // The three inputs each planner must justify against, named EXACTLY as their fence tags so a `basis` entry can be
  // resolved back to the prompt (owner: "prompt tells which question was chosen and why basis brain input + page1
  // input + category corpus … same for persona: brain and spec and commercial filled basis that persona").
  const inputs = kind === 'commercial'
    ? '<requirement_brain> (what we understand about this buyer), <page1_state> (the specs he JUST filled), <category_engine> (the complete category corpus: top_specs with asked_pct + top_values, personas, keywords, b2b_b2c, top_products) and <pns>'
    : '<requirement_brain> (what we understand about this buyer), <page1_state> (the specs he filled on page 1) and <page2_state> (the commercial answers he JUST filled)';
  return `\nPLANNER DEBUG: also set metadata.considered = an array of { candidate (str), surfaced (bool), rank (int), basis (str), why_ranked (str), dropped_because (str) } — ONE per candidate you WEIGHED for this page. You MUST INCLUDE every high-value NON-SPEC concern the <category_engine> offered (approval/licensing, land/facility, white-labeling/own-brand, origin, government-eligibility, customization, packaging-proof, warranty) EVEN IF you did not surface it, so the owner can see per category gem whether it was ASKED, PREFILLED, or dropped and WHY (dropped_because = already answered · prefilled elsewhere · not applicable to this buyer scenario · crowded out by the ask budget). Show which questions competed, which WON (surfaced=true, with its rank) and why each loser was dropped.
- basis — WHICH input drove this candidate, cited as "<source>:Lnn" against the LINE-NUMBERED inputs, listing every input that contributed (e.g. "category_engine:L12 asked_pct 78 + page1_state:L4 Weight=1 kg"). Your inputs are ${inputs}. If a candidate came from your own category knowledge and NOT from any input line, write exactly "own_knowledge" — never invent a line number.
- why_ranked — one sentence tying that basis to the decision: why this question earns the buyer's effort HERE, given what the brain already knows and what he has already answered.
This is the competition ledger the inspector renders; a surfaced question with no basis is a question we cannot explain.`;
};
const PROD_SUFFIX = `\nPRODUCTION MODE — OUTPUT ONLY: return only the JSON specified above (no evidence, no reasoning, no confidence, no commentary, no extra keys). This strips only what you RETURN — think and reason as fully as you would in debug; the internal analysis is identical, only the serialization is leaner. Do NOT trade accuracy for speed.`;
// Brain-only debug addendum: the candidate POOL + ranking (owner Q4 provenance — "what was available and why THIS spec
// surfaced"). Seller/generated candidates only; the buyer ISQ pool is already on screen.
const BRAIN_DEBUG_CONSIDERED = `\nBRAIN DEBUG: also set page1.metadata.considered = an array of { candidate (str), surfaced (bool), rank (int), dropped_because (str) } — ONE per SELLER or GENERATED candidate you weighed for Page 1, showing the pool you chose from and why each was kept or dropped. (Buyer ISQ specs need not be listed.)`;

// ── LLM 1 · Requirement Brain + Page-1 payload ────────────────────────────────
export interface BrainInputs {
  product: string; quantity?: string;
  csl?: unknown; rfq?: unknown; profile?: unknown; whatsapp?: unknown; pns?: unknown;
  // TYPE-E ENQUIRIES (2026-08-11): products he directly enquired sellers about — the highest-intent signal (he
  // reached out), plus the seller orgs = his de-facto shortlist / sourcing geography.
  enquiries?: unknown;
  buyerSpecs: BuyerSpec[]; sellerSpecs: { q: string; pct?: number; vals?: string[] }[];
  alreadyFilled?: Record<string, string>;   // values present from repost / prior truth
  // LIVE SESSION INPUT (2026-08-14, task #76): everything the buyer gave on the landing THIS session, regardless of
  // source — his AI-fill chat transcript, a mic dictation, what a photo revealed, and any free-text notes. This is the
  // freshest, highest-intent signal (he is telling us right now what he wants); it may carry specs the schema doesn't
  // have. The brain uses it to prefill + understand, and must surface any non-schema spec in it rather than drop it.
  sessionInputs?: { chat?: string; voice?: string; photo?: string; notes?: string };
  // NAME↔CATEGORY COLLISION (toffee Option-C part 2): the ISQ schema of the category the buyer ACTUALLY browsed
  // (from CSL), passed ONLY when it differs from the committed mcat. When the brain judges the committed category
  // untrustworthy, it drives Page 1 from THIS instead of inventing questions. Absent for the normal (no-collision) case.
  browsedSpecs?: { name: string; options?: string[] }[];
  browsedCategory?: string;
}

const BRAIN_SYSTEM = (exec: ExecMode) => `You are the Requirement Brain for an IndiaMART B2B RFQ. You SYNTHESISE the buyer's own truth (past searches/views, past requirements, direct enquiries he sent to sellers, profile, WhatsApp, phone-call insights) and produce Page 1 (product specifications) in ONE shot. Category insights are deliberately NOT given to you.

RULES
- Never fabricate. A value may be prefilled ONLY if it is present in the buyer's truth or already filled — cite it in your reasoning (debug). If a fact is not in the truth, do NOT invent it; leave the spec as a plain ask.
- Every ui:"ask" question MUST carry 2-5 concrete option chips in "options" (never a chip-less ask — it would render as a raw text box). prefill/confirm/suggest rows carry a "value" and need no options.
- Labels: 3-4 words max, single line.
- COLLISION OVERRIDE (highest priority): if <browsed_specs> is present, a category collision has ALREADY been detected upstream — the buyer BROWSED a different category than the one this requirement was filed under. Treat that as strong proof the committed Buyer Specs are the WRONG category → set category_trustworthy=FALSE and drive Page 1 from <browsed_specs>. Do NOT rationalise the committed category as trustworthy just because its filled values (from truth_rfq / truth_whatsapp) look self-consistent — those came from the SAME mis-categorised requirement, so they cannot validate the category that generated them.
- POSTED-REQUIREMENT CATEGORY CHECK: <truth_rfq> is the category the buyer HIMSELF filed this need under, so its spec fields are strong intent. If <truth_rfq> carries PRODUCT-DEFINING spec fields (a style, a material, a form-factor, a grade) that are ABSENT from the committed Buyer Specs schema, do NOT bury them as known_truths — surface them as first-class Page-1 questions (ui:prefill if truth answers them, else ui:ask). And if SEVERAL such core product-defining specs from his posted requirement are missing from the committed schema, treat that as a signal the committed category may be the wrong one for him and weigh category_trustworthy DOWN accordingly — his own posted requirement outranks a branded search string. (A single stray extra spec is not enough to distrust the category.)
- Decide internally whether the Buyer Specs schema is trustworthy enough to drive Page 1 (category_trustworthy true/false). Do NOT expose a score.
- MANDATORY SPECS ARE NON-NEGOTIABLE: any Buyer Spec whose schema entry has mandatory=true MUST appear on Page 1 whether category_trustworthy is true or false, whether it is already filled or empty, and whether it carries option chips or is a free-text/number field. Never drop, defer, or fold a mandatory spec.
- If category_trustworthy = TRUE: use ALL Buyer Specs (NEVER drop one). Add 1-2 Seller Specs ONLY if they add unique, non-overlapping value. Prefill from truth. If a spec is ALREADY FILLED and you would prefer a different value, keep the buyer's value and put yours in "suggestion" with ui:"suggest" — never overwrite.
- If category_trustworthy = FALSE: KEEP any Buyer Spec the buyer already filled (prefilled) AND every mandatory Buyer Spec, DROP the empty non-mandatory Buyer Specs, then: if <browsed_specs> is present, GENERATE Page 1 from THOSE (the schema of the category the buyer actually browsed — the committed category is a name-collision mismatch, e.g. a food item mis-mapped to an electrical category); otherwise generate your own relevant questions from the inferred intent. Prefill each generated question from truth where possible.
- <truth_enquiries> = products he has DIRECTLY ENQUIRED SELLERS about (each with the seller org he contacted). This is his STRONGEST intent signal — he did not just browse, he reached out — so it is prime evidence of what he is ACTIVELY sourcing and how seriously. Use it to sharpen your understanding + persona_read (comparison-shopping many sellers for the SAME product is a price-sensitivity signal — but enquiries spread across DIFFERENT, unrelated products are breadth, not depth, and by themselves NEVER make him "experienced" or a "wholesaler"; a maturity or scale claim needs account-age or real requirement-count support, so a brand-new / low-history / buyer-only account reads as new/individual regardless of enquiry count; the seller orgs + his own city hint at his sourcing geography). CONNECT THE DOTS across sources: an enquiry product that matches a viewed/searched/posted product is the SAME need seen from a higher-intent angle — treat them as one story, not separate items. But the enquiry PRODUCT NAMES and SELLER names are NOT specifications: never emit them as page-1 specs or known_truths.
- <buyer_session_input> (when present) is the buyer's OWN words from THIS session — his AI-fill chat, a mic dictation, and what a photo revealed. It is the FRESHEST, HIGHEST-PRIORITY signal (he is telling you right now what he wants) and OUTRANKS inferred truth for THIS requirement. Use it to prefill specs (ui:prefill) and to sharpen your understanding. CRITICAL: if it states a product-specification the Buyer Specs schema does NOT contain (e.g. "food-grade", a coating, a finish, a brand, a GSM), you MUST surface it — as a ui:prefill/ui:ask page-1 question when it maps to a real spec concept, otherwise as a known_truth — NEVER silently drop it. Still never fabricate: only reflect what he actually said. A quantity he states here is a real order quantity.
- known_truths is ONLY for product-SPECIFICATION facts known from truth OR the session input that are not in the schema (key:value) — e.g. a GSM, a voltage, a material. NEVER put the buyer's identity, contact or context here: no name, mobile, email, location, city, company, GST, designation, or past-product/enquiry names. Those are not specifications and must never surface as "detected specs". Quantity may be included ONLY as a key named exactly "Quantity" when the truth (PNS / a past requirement) or the session input states a real order quantity.

OUTPUT strict JSON:
{ "brain": { "understanding": str, "persona_read": str, "category_trustworthy": bool${exec === 'debug' ? ', "evidence": [str]' : ''} },
  "page1": { "questions": [ { "field": str, "label": str, "ui": "ask|prefill|suggest|confirm", "value"?: str, "suggestion"?: str, "options"?: [str], "order": int } ], "metadata": {} },
  "known_truths": [ { "key": str, "value": str, "source": str } ] }${exec === 'debug' ? DEBUG_SUFFIX + BRAIN_DEBUG_CONSIDERED : PROD_SUFFIX}`;

export async function runRequirementBrain(inp: BrainInputs, exec: ExecMode = 'prod', effort: EffortMode = 'high'): Promise<RequirementBrainResult | null> {
  const F = fenceFor(exec); // line-numbered in debug, clean in prod — SAME data either way
  const user = [
    F('product', { name: inp.product, quantity: inp.quantity ?? null }),
    F('already_filled', inp.alreadyFilled ?? {}),
    F('buyer_session_input', inp.sessionInputs && Object.values(inp.sessionInputs).some(Boolean) ? inp.sessionInputs : null),
    F('buyer_specs_schema', inp.buyerSpecs),
    F('seller_specs', inp.sellerSpecs),
    F('browsed_specs', inp.browsedCategory ? { category: inp.browsedCategory, specs: inp.browsedSpecs } : inp.browsedSpecs),
    F('truth_csl', inp.csl), F('truth_rfq', inp.rfq),
    F('truth_enquiries', inp.enquiries),
    F('truth_profile', inp.profile), F('truth_whatsapp', inp.whatsapp), F('truth_pns', inp.pns),
  ].join('\n');
  const out = await callLLM(
    [{ role: 'system', content: BRAIN_SYSTEM(exec) }, { role: 'user', content: user }],
    // INTELLIGENCE IS MODE-INDEPENDENT (owner 2026-07-31): the brain reasons at the SAME depth on the buyer path as in
    // AI-Debug — `effort` is chosen ONCE on page -1 and applies to prod and debug alike; it is NEVER gated on exec. The
    // only prod↔debug differences are VERBOSITY (evidence/considered/needs_input, the line-numbered fence) and
    // raw-capture. Owner: "same intelligence in both cases; token consumption can be high, intelligence shouldn't
    // suffer." Do NOT re-tie effort/tokens to exec for latency — latency is accepted and solved elsewhere.
    { jsonMode: true, temperature: 0, maxTokens: BRAIN_MAXTOK, reasoningEffort: effort, label: 'requirement-brain', captureRaw: exec === 'debug' });
  const j = parseJson(out);
  // RPS-1 §4.7 "make prompt failure loud": stamp the PARSE outcome, not just the HTTP outcome. A brain that returned
  // 200 with unparseable JSON used to be indistinguishable in LLM_HEALTH from a clean run — the form silently fell
  // back to the buyer ISQ specs and the panel still showed a green ring. Also treat a VALID-but-shapeless 200 (no
  // `brain` and no `page1`, e.g. the payload under a wrong top key) as a parse FAILURE, not a clean empty plan.
  const shapeOk = !!j && typeof j === 'object' && ('brain' in j || 'page1' in j);
  recordParse('requirement-brain', shapeOk);
  if (!shapeOk) return null;
  const brain = (j.brain ?? {}) as Record<string, unknown>;
  const page1 = (j.page1 ?? {}) as Record<string, unknown>;
  // flash-lite in json-mode not-uncommonly STRINGIFIES booleans, and `x !== false` coerced the string "false"
  // (and 0/null) to TRUE — silently inverting the collision override. Treat stringy/numeric falses as false; an
  // ABSENT value still defaults to trustworthy.
  const ct = brain.category_trustworthy;
  return {
    brain: {
      understanding: String(brain.understanding ?? ''), persona_read: String(brain.persona_read ?? ''),
      category_trustworthy: !(ct === false || ct === 0 || String(ct).toLowerCase() === 'false'), evidence: Array.isArray(brain.evidence) ? brain.evidence.map(String) : [],
    } as RequirementBrain,
    // Page-1 asks must carry 2+ chips — the SAME code-enforced contract as the planners (:234). A chip-less ask
    // renders as a raw text box, which the brain rule forbids; normQuestions alone did not drop them here.
    page1: { planner: 'requirement_brain', version: RFQ_LLM_VERSION.brain, questions: normQuestions(page1.questions).filter((q) => q.ui !== 'ask' || (q.options?.length ?? 0) >= 2), metadata: (page1.metadata ?? {}) as Record<string, unknown> },
    known_truths: Array.isArray(j.known_truths) ? (j.known_truths as Array<Record<string, unknown>>).map((k) => ({ key: String(k.key ?? ''), value: String(k.value ?? ''), source: String(k.source ?? '') })).filter((k) => k.key && k.value) : [],
  };
}

// ── LLM 2 · Commercial Planner ────────────────────────────────────────────────
const PLANNER_SYSTEM = (kind: 'commercial' | 'persona', exec: ExecMode) => {
  const themes = kind === 'commercial'
    ? 'warranty, delivery timeline, payment terms, installation, supplier preference (manufacturer/wholesaler), purchase frequency, sample order, certifications — plus anything the Category Engine suggests beyond specs'
    : 'designation, industry, business size, annual procurement, decision-maker probability (do NOT ask GST — the final Delivery/Payment page owns the GST question deterministically)';
  return `You are an experienced IndiaMART salesperson acting as the ${kind === 'commercial' ? 'Commercial' : 'Persona'} Planner for a B2B RFQ. Produce STRICTLY OPTION-BASED ${kind} questions.

═══ THE TWO RULES THAT MATTER MOST ═══

1. ANSWER BEFORE YOU ASK. For every fact you want, FIRST try to establish it from the inputs you were given. If the inputs establish it, emit ui:"prefill" with the value (or ui:"confirm" if you want the buyer to sanction it) — do NOT ask it. Only emit ui:"ask" for something you genuinely cannot establish.
   A page on which EVERY row is ui:"ask" is a failure: it means you did not read the Requirement Brain. A good page is mostly prefill/confirm with a small number of genuine gaps. Prefills and confirms are FREE — they do not count against the question budget — so there is no reason to be stingy with them.
   Never invent a value. If you cannot ground it, ask it.

2. THINK, DO NOT PICK FROM A LIST. The themes and field keys below are EXAMPLES and NAMING CONVENTIONS — they are NOT a menu of permitted questions, and a page assembled only from them is a generic form, not a plan. At least ONE question on this page must be specific to THIS buyer or THIS product and appear in no generic list. Derive it from the brain, the quantity, the use-case, the category evidence, or a contradiction you spotted. If two different buyers in this category would get the same page from you, you have not done the job.

═══ RULES ═══
- DECIDE FROM THESE INPUTS, IN THIS ORDER OF AUTHORITY: ${kind === 'commercial'
    ? '(1) <requirement_brain> — what we already understand about this buyer, so you never ask what we know; (2) <page1_state> — the specs he JUST filled, which both rule questions out and imply new ones (a large quantity implies delivery/payment terms; a perishable implies a tight timeline); (3) <category_engine> — what real sellers in this mcat actually ask. It arrives in EITHER of two shapes and you must handle both: the FULL corpus object (`top_specs` each with `asked_pct` + `top_values`, plus `personas`, `keywords`, `b2b_b2c`, `top_products`, and coverage counters like `calls_analyzed`) OR, when only the distilled feed is available, a plain ARRAY of `{q, pct, vals}` where q=the question, pct=asked_pct, vals=top values. Read whichever you are given; never assume a key exists. THE CORPUS IS A HELPER, NOT A SCRIPT. It tells you what this market cares about; it does not tell you what to ask. Most of its entries are TECHNICAL SPECIFICATION questions (material, size, capacity, grade, colour, model) — those belong to page 1, SKIP them however high their asked_pct. BUT the corpus also holds NON-SPEC concerns that are FIRST-CLASS for THIS page and must NOT be skipped as specs: licensing/approval (CLU, government approval), facility/land (plant location, land area), private-label / white-labeling / own-brand, sourcing origin or region, government-work eligibility, customization/printing, packaging-proof, warranty/AMC. A category non-spec concern like these OUTRANKS a generic theme (delivery/payment) for a scarce ask slot — do not spend the whole page on delivery+payment when the corpus is telling you this market cares about approval or white-labeling. HANDLE each by CONFIDENCE, not reflex: if <requirement_brain> or the truth already answers it → emit ui:prefill with the value (prefills are FREE, they do NOT count against the ask budget, so surface as many grounded category concerns as you can, placed after the asks); if you cannot answer it but it is RELEVANT to the scenario of THIS buyer → ui:ask it; if it does NOT apply to this buyer → do not ask, and record why in metadata.considered. RELEVANCE is per-scenario: white-labeling/own-brand only for a reseller or trader, government-work eligibility only when the profile suggests it, land/facility only for a setup or project buyer — never ask a concern the buyer situation rules out. Also use the corpus to borrow real option VALUES verbatim as chips so they match how sellers phrase things, and to read the register from `b2b_b2c` / `personas` (a B2C buyer is never asked about annual procurement). PERSPECTIVE RULE (critical): the corpus `personas`, `keywords` and `b2b_b2c` describe what SELLERS in this mcat advertise and the customers THEY target — they are NOT a description of THIS buyer. Use them ONLY to phrase options and read market register; they may NEVER set the intent, use-case, or supplier persona of THIS buyer when his own truth (his requirement, quantity, browse/enquiry history, profile counters) points elsewhere. A retail-target corpus does not make a one-off buyer a "Retail Store" or a "Wholesaler/Distributor" — down-weight or ignore the corpus the instant it contradicts his own behaviour. Then form your own question in your own words. A high asked_pct is a hint, never an instruction, and never a licence to relay a spec. The list is TRUNCATED server-side, so an ABSENT theme is not evidence against it. If `calls_analyzed` is 0 or the block is `(none)` there is NO category evidence at all — rely on your own knowledge of this trade and record basis "own_knowledge" rather than inventing a citation; (4) <pns> — call insights, when present.'
    : '(1) <requirement_brain> — what we already understand about this buyer (persona_read especially), so you never ask what we know; (2) <page1_state> — the specs he filled, which reveal scale and use-case; (3) <page2_state> — the commercial answers he JUST filled, which strongly imply persona (Net-30 + wholesaler + monthly ⇒ an established business, so do NOT ask business size as if he were unknown). Infer from these before asking, and prefill/confirm anything they already establish.'}
- NEVER re-ask or re-produce anything already asked/filled on a previous page (strict exclusivity).
- FIELD KEYS ARE A NAMING CONVENTION, NOT A QUESTION LIST. These keys exist for ONE reason: so the deterministic merge layer can recognise a concept that might otherwise appear on two pages. If you ask about one of these concepts, use its EXACT key: delivery_timeline, payment_terms, supplier_type, purchase_frequency, warranty, sample_order, annual_procurement, designation, industry, business_size, decision_maker.
  For ANYTHING ELSE — and you are expected to have something else — coin your own descriptive snake_case key. You are not limited to the eleven. Being unable to name a question is never a reason not to ask it.
- Budget: ask between ${BUDGET.min} and ${BUDGET.max} questions (prefer ${BUDGET.pref}). Prefills / confirms are EXTRA and do NOT count toward the budget — use as many as you can ground. ORDER: give the ASKS the lowest order numbers (they render first, so the buyer sees what he must answer up top) and PREFILLS/CONFIRMS higher order numbers, so grounded answers sit at the BOTTOM.
- Every ui:"ask" needs 2-5 option chips. Labels 3-4 words. A prefill/confirm carries a "value".
- Decide per field: prefill (grounded value, buyer can change it) | confirm (grounded value, buyer sanctions it) | ask (a real gap) | skip (omit entirely — say so in the debug ledger).
- ILLEGAL / IRRELEVANT (Indian B2B — HARD RULE): NEVER emit, as a question OR as an option, anything about invoicing or tax treatment ("GST invoice requirement", "required for business records", tax-invoice), payment-protection / escrow, legal terms & conditions, or any personal/financial credential (Aadhaar / PAN / bank / OTP). GST registration is asked separately and deterministically downstream — do NOT re-ask it here in any form. Ask ONLY what a seller genuinely needs in order to QUOTE for this product.
- QUESTION LABEL LENGTH: the question \`label\` is AT MOST 4 words, no trailing punctuation, and must fit ONE line on a 375px phone. Put every detail in the OPTIONS, never in the label — e.g. label "Delivery timeline" with option chips, NOT "In how many days do you need delivery?".
- ${kind === 'commercial' ? 'NO TECHNICAL SPECIFICATIONS. Material, size, dimension, voltage, capacity, GSM, grade, colour, model number and the like belong to page 1 and are already handled there. If the category evidence hands you one, SKIP it — do not relay it. But a SOURCING or COMMERCIAL concern from the corpus (approval/licensing, white-labeling/own-brand, sourcing origin, government-work eligibility, facility/land, customization, warranty/AMC) is NOT a technical spec — surface it (prefill if the brain answers it, ask if it is a relevant gap), never skip it as a spec. Your subject is how he BUYS, not what the product IS.' : 'NO SPECIFICATIONS AND NO CATEGORY QUESTIONS. Your only subject is the BUYER: what kind of business he runs, how he procures, how mature and how trusted he is, who decides. If a question would be equally valid for a different product, it belongs here; if it is about the product, it does not.'}
- Themes — EXAMPLES to prime you, not a checklist and not a boundary: ${themes}.
${kind === 'commercial' ? '- INTENT FIRST: unless page 1 already answered it (an Application / Usage / End-Use / "what is this for" spec — then SKIP it, do not re-ask), the FIRST question (order 0) on this page is the buyer INTENT / use-case: what he is buying this for. Customise its options to THIS buyer from <requirement_brain> + the corpus personas/keywords (the real use-cases in this market), always plus an "Other" chip. If the brain establishes the intent, PREFILL it at order 0 instead of asking.\n- UNSTATED-PREFERENCE GUARD: a buyer PREFERENCE you can infer ONLY from category DOMINANCE — supplier_type / preferred supplier (manufacturer vs wholesaler vs trader), sourcing origin, brand — and NOT from his own requirement / enquiry / browse history, must be OFFERED as ui:"ask" (or ui:"suggest"), NEVER ui:"prefill" or ui:"confirm". Prefilling pre-commits him to a choice he never made, and the corpus describes the MARKET, not him. Prefill supplier_type ONLY when his OWN behaviour establishes it (e.g. he enquired only manufacturers).' : ''}
${kind === 'persona' ? '- <persona_gate> is a DETERMINISTIC read of THIS buyer from his profile + his own calls. HONOUR it above your own inference: if persona_on_file is set, PREFILL designation/industry/business-size from it (ui:prefill, ordered LAST) and do NOT ask them; if vetoed_by is set he is a one-off or B2C buyer — ask NO persona questions (return an empty or near-empty page); the met[] list is his maturity evidence, so an established buyer never gets beginner questions. On business-type/size the gate wins — it is measured; you are guessing. If is_bulk_b2b is FALSE (whether or not vetoed_by is set), you have NO measured evidence he buys at scale: do NOT assert, prefill, or ask business_size / annual_procurement / wholesaler / distributor / trader tiers — treat him as a small or one-off buyer. NEVER upgrade a buyer to "wholesaler" or "distributor" from a category average, from his name, or from a single large-looking order.' : ''}
- <buyer_profile> is what the buyer DECLARED about himself on IndiaMART. It is uneven, and a 12-buyer study measured exactly how, so trust it selectively:
  RELIABLE (present for 12/12 buyers) — contact_city / contact_state / contact_district / location_preference, and the engagement counters: is_paid, membersince, enq_count, total_requirement, pns_call_cnt, total_calls. ${kind === 'commercial' ? 'Geography (contact_city / contact_state) is a DELIVERY fact the FINAL Delivery & Payment page already owns deterministically — do NOT emit a delivery-location or "which city" question here, neither ui:"ask" NOR ui:"prefill"/"confirm". Duplicating it makes the buyer see (and re-confirm) his city twice, and asserting a profile city as "Confirmed" over-states a fact he never confirmed this session. Leave delivery location to the downstream page. The counters tell you how experienced he is, which should change your register, not add a question.' : 'The counters are your best maturity signal AND they cut BOTH ways: a long membership + many past requirements + many calls means established (do NOT ask him beginner questions); a FREE / brand-new / low-requirement / buyer-only account is positive evidence he is small or one-off, so let it DOWN-WEIGHT or DROP a persona question entirely (business_size and annual_procurement especially) — not merely soften its wording. Geography is page 2 business, not yours.'}
  SOMETIMES (about 5-7 of 12) — company_name, contact_pincode, buyer_product_sold, custtype_weight. ${kind === 'persona' ? 'buyer_product_sold is the single highest-value persona fact in the payload: if it is present the buyer is HIMSELF A SELLER, which reframes everything — prefill his industry from it rather than asking.' : 'If company_name is present, treat him as a business without asking.'}
  EFFECTIVELY ABSENT (2 of 12 or fewer) — business_type, glusr_usr_designation, buyer_product_of_interest, avg_rating, latitude/longitude. ${kind === 'persona' ? 'These are the two fields you most want and they are almost never there, so do NOT plan around reading them: treat business type and designation as UNKNOWN and ask them, unless page-1/page-2 answers or the brain let you infer them honestly.' : 'Do not rely on them.'}
  Absent is ABSENT: an empty field is not evidence of anything. Never state or imply a profile fact the payload does not contain.

OUTPUT strict JSON: { "questions": [ { "field": str, "label": str, "ui": "ask|prefill|confirm", "value"?: str, "options": [str], "order": int } ], "metadata": {} }${exec === 'debug' ? DEBUG_SUFFIX + PLANNER_DEBUG_CONSIDERED(kind) : PROD_SUFFIX}`;
};

export interface PlannerInputs { brain: RequirementBrain; session: SessionState; categoryEngine?: unknown; pns?: unknown; profile?: unknown; personaGate?: unknown; }

async function runPlanner(kind: 'commercial' | 'persona', inp: PlannerInputs, exec: ExecMode, effort: EffortMode = 'high'): Promise<PlannerEnvelope | null> {
  const F = fenceFor(exec); // line-numbered in debug, clean in prod — SAME data either way
  const user = [
    F('requirement_brain', inp.brain),
    F('product', { name: inp.session.product, quantity: inp.session.quantity ?? null }),
    F('page1_state', inp.session.page1),
    F('buyer_profile', inp.profile),
    ...(kind === 'persona' ? [F('page2_state', inp.session.page2), F('persona_gate', inp.personaGate)] : [F('category_engine', inp.categoryEngine), F('pns', inp.pns)]),
  ].join('\n');
  const out = await callLLM(
    [{ role: 'system', content: PLANNER_SYSTEM(kind, exec) }, { role: 'user', content: user }],
    // Same intelligence as the brain (owner 2026-07-31 "bump"): effort chosen on page -1, identical in prod and debug.
    { jsonMode: true, temperature: 0, maxTokens: PLANNER_MAXTOK, reasoningEffort: effort, label: `${kind}-planner`, captureRaw: exec === 'debug' });
  const j = parseJson(out);
  // A 200 with bad JSON — or a valid-but-shapeless 200 whose `questions` is missing/not an array — must read as a
  // FAILURE (→ the controller shows a retry card), never as a clean empty plan (which would silently auto-skip the
  // page). A legitimate `{questions: []}` ("nothing to ask") still passes and is handled as an empty-skip downstream.
  const shapeOk = !!j && Array.isArray((j as Record<string, unknown>).questions);
  recordParse(`${kind}-planner`, shapeOk);
  if (!shapeOk) return null;
  // STRICTLY OPTION-BASED (plan §3): an `ask` with fewer than 2 option chips is dropped here so it can never render
  // as a free-text input downstream (renderCxPs falls back to a text box when options are empty). prefill/confirm
  // rows legitimately carry a value without chips and are kept. This enforces the contract in CODE, not just prompt.
  const questions = normQuestions(j.questions).filter((q) => q.ui !== 'ask' || (q.options?.length ?? 0) >= 2).slice(0, BUDGET.max + 6);
  return { planner: kind, version: kind === 'commercial' ? RFQ_LLM_VERSION.commercial : RFQ_LLM_VERSION.persona, questions, metadata: (j.metadata ?? {}) as Record<string, unknown> };
}

export const runCommercialPlanner = (inp: PlannerInputs, exec: ExecMode = 'prod', effort: EffortMode = 'high') => runPlanner('commercial', inp, exec, effort);
export const runPersonaPlanner = (inp: PlannerInputs, exec: ExecMode = 'prod', effort: EffortMode = 'high') => runPlanner('persona', inp, exec, effort);

// ── LLM 4 · Profile Synthesizer ─────────────────────────────────────────────────────────────────────────────
// The LAST-PAGE buyer profile (owner 2026-08-11). It does NOT ask anything — it SYNTHESISES a crisp read of the
// buyer from everything gathered so far, adapting the GLADMIN Buyer-Ledger enrichment discipline (reason-first,
// grounded-or-omit, per-field confidence, PII excluded) but over a THINNER input (form answers + declared profile,
// none of the KYB/GST/vendor stack) — so its confidence is honestly lower. Two consumers: the FULL profile is an
// internal HOD-review card (which facts are worth promoting to an earlier page); only the buyer-SAFE, grounded,
// high-confidence subset ever renders back to the buyer, and the buyer-safe classification is enforced in CODE
// below (SAFE_PROFILE_KEYS), never trusted to the model — sales/trust/financial fields stay internal at any score.
export const SAFE_PROFILE_KEYS = new Set([
  'business_persona', 'sub_industry', 'b2b_b2c', 'retail_wholesale', 'procurement_model', 'purchase_frequency',
  'delivery_timeline', 'payment_mode', 'preferred_suppliers', 'communication', 'location_sourcing',
  'target_customers', 'selling_channel', 'sales_geography', 'use_case', 'business_story', 'primary_language', 'products_of_interest',
]);
export interface ProfileSynthField { key: string; label: string; value: string; confidence: number; grounded: boolean; buyer_safe: boolean; evidence?: string; }
export interface ProfileSynth { understanding: string; fields: ProfileSynthField[]; }

const PROFILE_SYNTH_SYSTEM = (exec: ExecMode) => `You are the Buyer-Profile Synthesizer (LLM 4) for an IndiaMART RFQ. This runs on the LAST page: you do NOT ask the buyer anything — you SYNTHESISE a crisp profile of him from everything gathered so far, for an internal sales/HOD review that decides which facts are worth confirming earlier in the form.

WHAT YOU GET: <requirement_brain> (our understanding of him), <page1_state>/<page2_state>/<page3_state> (his answers so far), <buyer_profile> (his declared IndiaMART record), <persona_gate> (a deterministic bulk-B2B read), <buyer_signals> (his own WhatsApp/call/browse signals), <enquiries> (products he DIRECTLY enquired sellers about + the seller organisations he contacted — his de-facto shortlist and a strong read on his sourcing geography, preferred_suppliers, procurement_model and price sensitivity: many sellers contacted for one product = comparison-shopping). You have NO external KYB/GST/vendor data, so your confidence must be honestly LOWER than a full enrichment — reflect that in each score.

RULES:
- REASON FIRST, then state the value. Ground EVERY field in the inputs. If you cannot ground a field from what you were given, OMIT it — never invent. An ungrounded guess is worse than an absent field.
- grounded=true ONLY when ≥2 inputs agree OR one strong spoken/declared signal supports it; otherwise grounded=false and lower the confidence.
- SCALE & IDENTITY ARE GATED BY <persona_gate>, NOT INFERRED: if persona_gate.is_bulk_b2b is false or vetoed_by is set, do NOT claim wholesaler / distributor / trader, a large business_size, buyer_maturity="experienced", or any annual_procurement / annual_turnover band — the deterministic gate outranks your inference. Describe his scale as small / one-off / unknown instead.
- annual_procurement / annual_turnover may ONLY be stated from a band ALREADY DECLARED in <buyer_profile>. NEVER compute, multiply, or extrapolate one from an order quantity (e.g. do not turn "500 packets on one requirement" into "2,000–5,000 packets a year"). If no declared band exists, OMIT the field.
- A NAME, contact, email, city or company is NEVER evidence for a designation, a business_size, a maturity level, or a procurement scale. Do not infer a job title from a person's name.
- NEVER output identity PII — no name, mobile, email, company/legal name, GST/GSTIN/PAN, Udyam, income band, age, gender, trust score. Those are handled elsewhere; here they are evidence you reason FROM, never a field you emit.
- Prefer these keys where they apply (coin a snake_case key otherwise): business_persona, sub_industry, b2b_b2c, retail_wholesale, buyer_maturity, business_stage, scale, procurement_model, purchase_frequency, price_vs_quality, delivery_timeline, payment_mode, sourcing_channel, preferred_suppliers, procurement_approach, procurement_challenge, buyer_intent, urgency, communication, location_sourcing, identity_confidence, digital_footprint, annual_turnover, annual_procurements, target_customers, selling_channel, sales_geography, business_objective, decision_maker, use_case, business_story, primary_language.
- Give a one-sentence plain-language "understanding" of who this buyer is (no jargon, no PII).

OUTPUT strict JSON: { "understanding": str, "fields": [ { "key": str, "label": str, "value": str, "confidence": int (0-100), "grounded": bool, "evidence": str } ] }${exec === 'debug' ? '\nDEBUG: the fenced inputs are LINE-NUMBERED (every line begins "Lnn "); make every `evidence` cite the exact source line as "<source>:Lnn — <fact>" (e.g. "buyer_profile:L4 — 156 past requirements"). If you cannot cite a line, set evidence "" and grounded false.' : PROD_SUFFIX}`;

export async function runProfileSynthesizer(inp: PlannerInputs & { buyerSignals?: unknown; enquiries?: unknown }, exec: ExecMode = 'prod', effort: EffortMode = 'high'): Promise<ProfileSynth | null> {
  const F = fenceFor(exec);
  const user = [
    F('requirement_brain', inp.brain),
    F('product', { name: inp.session.product, quantity: inp.session.quantity ?? null }),
    F('page1_state', inp.session.page1), F('page2_state', inp.session.page2), F('page3_state', inp.session.page3),
    F('buyer_profile', inp.profile), F('persona_gate', inp.personaGate), F('buyer_signals', inp.buyerSignals ?? null),
    F('enquiries', inp.enquiries ?? null),   // his direct seller enquiries → preferred_suppliers, sales_geography, location_sourcing, procurement_model
  ].join('\n');
  const out = await callLLM(
    [{ role: 'system', content: PROFILE_SYNTH_SYSTEM(exec) }, { role: 'user', content: user }],
    { jsonMode: true, temperature: 0, maxTokens: PLANNER_MAXTOK, reasoningEffort: effort, label: 'profile-synth', captureRaw: exec === 'debug' });
  const j = parseJson(out) as { understanding?: unknown; fields?: unknown } | null;
  const shapeOk = !!j && Array.isArray(j.fields);
  recordParse('profile-synth', shapeOk);
  if (!shapeOk) return null;
  const fields: ProfileSynthField[] = (j!.fields as Array<Record<string, unknown>>).map((f) => {
    const key = String(f.key ?? '').trim();
    return {
      key, label: String(f.label ?? key).trim(), value: String(f.value ?? '').trim(),
      confidence: Math.max(0, Math.min(100, Math.round(Number(f.confidence) || 0))),
      grounded: f.grounded === true,
      buyer_safe: SAFE_PROFILE_KEYS.has(key),   // FIREWALL in code — never trust the model to self-classify safe vs internal
      evidence: typeof f.evidence === 'string' && f.evidence.trim() ? f.evidence.trim() : undefined,
    };
  }).filter((f) => f.key && f.value);
  // FIREWALL IN CODE (deep-audit 2026-08-12): the deterministic bulk gate OUTRANKS the model's self-reported
  // grounded/confidence for SCALE and IDENTITY-inference fields. A neutral or vetoed gate means we have NO measured
  // evidence he buys at scale, so a "wholesaler / annual procurement 2,000–5,000" field is an inference, not a fact —
  // demote it (grounded=false, confidence capped) so the HOD card never shows a fabricated scale as high-confidence.
  const gate = inp.personaGate as { is_bulk_b2b?: boolean; vetoed_by?: string; persona_on_file?: string } | undefined;
  const notBulk = !gate?.is_bulk_b2b || !!gate?.vetoed_by;
  const SCALE_KEYS = new Set(['business_size', 'scale', 'annual_procurement', 'annual_procurements', 'annual_turnover', 'buyer_maturity', 'business_persona', 'retail_wholesale', 'procurement_model']);
  const SCALE_CLAIM = /wholesal|distribut|trader|large|bulk|lakh|crore|experienc|establish|mature|seasoned|[0-9]/i;
  for (const f of fields) {
    const k = f.key.toLowerCase();
    if (notBulk && SCALE_KEYS.has(k) && SCALE_CLAIM.test(f.value)) { f.grounded = false; f.confidence = Math.min(f.confidence, 35); }
    // designation is only high-confidence when the gate actually carries a persona on file; otherwise it is inferred.
    if (k === 'designation' && !gate?.persona_on_file) { f.grounded = false; f.confidence = Math.min(f.confidence, 40); }
  }
  return { understanding: String(j!.understanding ?? '').trim(), fields };
}

/** Enforce the ask-only budget: keep all prefill/confirm/suggest, cap the "ask" count at BUDGET.max.
 *  The keep-set holds question IDENTITIES, not field names. It used to hold `q.field`, which leaked the budget
 *  whenever two asks shared a field: `keep.has(q.field)` re-admitted every duplicate, so 8 asks over fields
 *  a,b,c,d,e,a,a,b all survived a max of 5. That is not hypothetical — the planner prompt hands the model a fixed
 *  list of 11 canonical field keys precisely so pages can dedup, which makes a repeat the expected failure mode. */
export function applyBudget(env: PlannerEnvelope): PlannerEnvelope {
  const asks = env.questions.filter((q) => q.ui === 'ask').sort((a, b) => a.order - b.order).slice(0, BUDGET.max);
  const keep = new Set(asks);
  return { ...env, questions: env.questions.filter((q) => q.ui !== 'ask' || keep.has(q)) };
}
