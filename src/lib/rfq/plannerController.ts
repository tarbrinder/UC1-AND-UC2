// ─── Dynamic RFQ — Planner Controller (extraction step 1: pure orchestration helpers) ───────────────────────────
// The 3-LLM orchestration currently lives inside the ~3500-line BrainRFQForm. This module is the first, SAFE step of
// pulling it out: the PURE helpers (no React state, no refs) that the planner effects call. The effects themselves —
// which fire LLM 1/2/3, hold the fire/upgrade guards, and consume the results — move into a `usePlannerController`
// hook next, once the case-audit lands (so its planner/arch findings shape the hook boundary). Keeping these pure and
// unit-testable first means the eventual hook is a mechanical move, not a rewrite.
import { answeredKeys, type PlannerEnvelope, type RequirementBrain, type SessionState } from './contracts';

/** Build the forward-flowing session state the planners see. page1 = filled specs (extras + buyer + generated),
 *  page2 = commercial answers, page3 = persona answers. specValues/aiSpecValues win on a key collision (they are the
 *  buyer's live selections); extraSpecs ("Also detected") come first so they are seen but never override. */
export function buildSession(a: {
  product: string; quantity?: string; mcatId?: string;
  extraSpecs: Record<string, string>; specValues: Record<string, string>; aiSpecValues: Record<string, string>;
  cxAnswers: Record<string, string>; psAnswers: Record<string, string>;
}): SessionState {
  return {
    product: a.product, quantity: a.quantity, mcatId: a.mcatId,
    page1: { ...a.extraSpecs, ...a.specValues, ...a.aiSpecValues },
    page2: a.cxAnswers, page3: a.psAnswers,
  };
}

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** CONCEPT ALIASES (C12). Two planners can name the same concept differently — "Delivery Timeline" vs
 *  `delivery_timeline` is caught by normKey, but "when do you need it" vs `delivery_timeline` is not. Each canonical
 *  key owns a set of alias fragments; a field or LABEL containing a fragment resolves to the canonical key BEFORE
 *  comparison, so the merge layer dedups by CONCEPT rather than by spelling. Deliberately conservative: a fragment
 *  must be distinctive enough that a false match is unlikely. */
// Fragments are matched by `n.includes(f)`, so each MUST be distinctive — short ambiguous ones are avoided on purpose
// ('eta' matches "detail", 'tat' matches "status", bare 'iso'/'standard'/'emi' are too greedy). The 2026-08-10 audit
// found the buyer's own examples leaking because these concepts had NO alias or NO canonical entry: a FINANCE/credit
// spec on page 1 didn't suppress the last-page payment control; DISPATCH/ETA questions re-asked delivery; and
// application/usage/intent, MOQ, installation, certification had no canonical concept at all so any rephrase leaked.
const CONCEPT_ALIASES: Record<string, string[]> = {
  delivery_timeline: ['deliverytimeline', 'deliverytime', 'whendoyouneed', 'leadtime', 'timeline', 'deliveryby', 'requiredby', 'urgency', 'dispatch', 'dispatchtime', 'shippingtime', 'turnaround', 'shipby'],
  payment_terms: ['paymentterms', 'paymentmode', 'paymentmethod', 'howwillyoupay', 'creditterms', 'creditperiod', 'advancepayment', 'finance', 'financing', 'loanamount', 'emitenure', 'emioption'],
  supplier_type: ['suppliertype', 'supplierpreference', 'manufactureror', 'preferredsupplier', 'vendortype'],
  purchase_frequency: ['purchasefrequency', 'howoften', 'orderfrequency', 'buyingfrequency', 'reorder', 'repeatorder'],
  warranty: ['warranty', 'guarantee'],
  sample_order: ['sampleorder', 'sample', 'trialorder'],
  minimum_order: ['minimumorder', 'minimumorderquantity', 'moq', 'minorder', 'minimumquantity', 'minqty'],
  installation: ['installation', 'installationtype', 'installservice', 'commissioning', 'fitting'],
  certification: ['certification', 'certifications', 'certificate', 'compliance'],
  // application == intent: a page-1 "Application"/"Usage"/"End Use" spec answers the page-2 intent question, so it must
  // canonicalize to the same concept for the merge layer to skip the re-ask (owner #5).
  application: ['application', 'usage', 'enduse', 'endapplication', 'intendeduse', 'usedfor', 'whatisthisfor', 'purposeofuse', 'intent', 'iwantthisfor'],
  annual_procurement: ['annualprocurement', 'annualvolume', 'yearlyvolume', 'annualspend', 'yearlyrequirement'],
  designation: ['designation', 'yourrole', 'jobrole', 'jobtitle', 'position'],
  industry: ['industry', 'businessindustry', 'sector', 'tradetype'],
  business_size: ['businesssize', 'companysize', 'businessscale', 'employees', 'turnover', 'organisationsize', 'organizationsize'],
  decision_maker: ['decisionmaker', 'finaldecision', 'whodecides', 'purchaseauthority', 'approver'],
  gst: ['gst', 'gstin', 'gstnumber', 'taxregistration'],
  // setup_stage (2026-08-12 audit): the commercial planner's `business_setup_type` ("Select Business Setup Type":
  // new-unit / expanding / replacing) and the persona planner's `setup_stage` ("Machinery setup stage": setting-up /
  // expanding / replacing) are the SAME lifecycle question under two field keys, so the buyer saw it on BOTH pages.
  // Fragments are chosen to catch that pair WITHOUT collapsing `machine_setup_configuration` ("Choose Machine Setup
  // Requirement" — a distinct product-scope question): 'machinesetupconfiguration' contains none of these.
  setup_stage: ['setupstage', 'businesssetup', 'setuptype'],
};

/** Exported so the last-page dedup (BrainRFQForm `cxCovers*`) and the page-1 spec matcher can share ONE canonicalizer
 *  instead of each keying differently (the root cause of the cross-page leaks). Given a set of concept strings already
 *  seen anywhere (page-1 specs, filled/prefilled values, planner questions), `conceptSeen(x)` says whether concept `x`
 *  was covered. */
export function conceptSet(fieldsOrLabels: string[]): Set<string> {
  return new Set(fieldsOrLabels.map(canonConcept).filter(Boolean));
}

/** Resolve a field/label to its canonical concept, or fall back to the normalised key. */
export function canonConcept(fieldOrLabel: string): string {
  const n = normKey(fieldOrLabel);
  if (!n) return n;
  for (const [canon, frags] of Object.entries(CONCEPT_ALIASES)) {
    if (n === normKey(canon)) return canon;
    if (frags.some((f) => n.includes(f))) return canon;
  }
  return n;
}

/** DETERMINISTIC MERGE LAYER (plan §5). Drop any planner question whose CONCEPT the buyer has already answered/filled
 *  on an earlier page (answeredKeys unions page1+page2+page3), OR that was merely SHOWN on an earlier page
 *  (extraShown). "Shown" matters as much as "answered": a page-1 spec that RENDERED and was left blank is not in
 *  `answeredKeys` at all (buildSession sees values only), so without extraShown it would be asked again on page 2 —
 *  a guaranteed double-ask (C3). Both sides are resolved through canonConcept so a re-phrased duplicate is caught,
 *  and a question's LABEL is checked as well as its field, because a planner that coins its own key still tends to
 *  phrase the label conventionally. Run BEFORE the ask-budget so the budget counts only net-new questions. */
export function dropAnswered(env: PlannerEnvelope, session: SessionState, extraShown: string[] = []): PlannerEnvelope {
  const done = new Set([...answeredKeys(session)].map((k) => canonConcept(k)));
  const shown = new Set(extraShown.map(canonConcept));
  const taken = (q: { field: string; label?: string }) => {
    const f = canonConcept(q.field);
    const l = q.label ? canonConcept(q.label) : '';
    return done.has(f) || shown.has(f) || (!!l && (done.has(l) || shown.has(l)));
  };
  return { ...env, questions: env.questions.filter((q) => !taken(q)) };
}

/** The thin fallback "brain" LLM 2/3 run on if they fire before LLM 1's real Requirement Brain has landed (#5 — empty
 *  truth carries product + qty + whatever specs are filled). The planner effects allow ONE upgrade re-fire when the
 *  real brain arrives, so this is never the final context on the happy path. */
export function fallbackContext(product: string, quantity: string | undefined, unit: string, specLine: string): RequirementBrain {
  const q = quantity ? ` · qty ${quantity} ${unit}` : '';
  const s = specLine ? ` · ${specLine}` : '';
  return { understanding: `${product}${q}${s}`, persona_read: '', category_trustworthy: true, evidence: [] };
}

/** Whether LLM 1's output is the REAL brain (has content) vs the thin fallback — the upgrade-refire predicate. */
export const haveRealBrain = (b: RequirementBrain | null | undefined): boolean =>
  !!(b && (b.understanding || b.persona_read));
