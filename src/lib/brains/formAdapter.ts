// ─── Form Adapter ────────────────────────────────────────────────────────────
// The explicit contract: Requirement Engine → Decision Objects → Form Adapter → SimpleRFQ state.
// Maps a RequirementBrainPayload (or one chosen recommendation) into the seed the form initializes from.
//
// TWO STAGES, ONE DECISION SYSTEM (2026-07-28). The engine's Decision Objects are not merely prefills: they
// are the decision about WHAT this buyer still needs to be asked. The seed carries them through in two forms —
// the filled values (specValues / observedFields / quantity / location) that seed the form directly, and
// `engineDecisions`, which the form hands to `runCuratedPlanner` so the planner can RANK and PHRASE them.
// The planner may add candidates of its own, but they compete in the same ledger; it does not get to re-decide.
import type { RequirementBrainPayload, Decision, DecisionAction } from './requirementBrain';

export type BrainStage = 'product' | 'specs' | 'more' | 'results';

// ─── ONE DECISION SYSTEM, TWO STAGES ─────────────────────────────────────────
// The ENGINE decides WHAT to ask (Decision Objects); the PLANNER ranks, phrases and supplies chips.
// Before this, `brainToSeed` mapped ASK→gaps and RESOLVE_CONFLICT→conflicts and NOTHING in the form ever
// read either field — the form ran `runCuratedPlanner`, which invented its own questions from scratch, so
// every ASK / SUGGEST / RESOLVE_CONFLICT / OFFER the engine emitted was silently discarded. `engineDecisions`
// is the channel that carries them INTO the planner as a first-class, XML-fenced input.
//
// Deliberately a FLAT, structural shape (not the `Decision` type): `runCuratedPlanner` lives in lib/gemini.ts
// and must stay free of any dependency on the brain contract. gemini.ts declares the same shape inline.
export interface EngineDecisionInput {
  id: string;                       // stable handle ("e3") the planner echoes back as `engine_ref`
  action: 'ASK' | 'SUGGEST' | 'RESOLVE_CONFLICT' | 'OFFER';
  field: string;
  value?: string;
  options?: string[];
  conflict?: { value: string; source: string; evidence?: string }[];  // RESOLVE_CONFLICT: the A and the B, each with its source
  why?: string;
  kind?: string;
  priority?: number;
  confidence?: number;
  freshness?: string;
}

// ─── DECISION ROUTING LEDGER (firewall rule: nothing may be SILENTLY dropped) ──
// Every engine Decision Object is accounted for: either it rendered somewhere, or it is here with a reason.
// The form calls `recordDecisionRoutes` after each plan; the debug panel reads `decisionRoutingReport()`.
// Also mirrored to `window.__decisionRouting` for console introspection (same pattern as __llmHealth).
export interface DecisionRoute {
  id: string;
  action: DecisionAction | string;
  field: string;
  rendered: boolean;
  where: string;                    // "spec page · inline question", "suppressed", …
  reason: string;                   // REQUIRED when !rendered — why the buyer never sees it
  q?: string;                       // the buyer-facing wording it finally rendered as (planner-phrased)
}
let _routes: DecisionRoute[] = [];
export function recordDecisionRoutes(rs: DecisionRoute[]): void {
  _routes = rs;
  try { (window as unknown as Record<string, unknown>).__decisionRouting = rs; } catch { /* SSR / locked-down global */ }
}
export function decisionRoutingReport(): DecisionRoute[] { return _routes; }
/** Slug used to match an engine decision to whatever the planner did with it (id OR field text). */
export const decisionKey = (s: string): string => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ─── ITEM 1 · BULK-B2B TRUTH EXPANSION — the persona gate ─────────────────────
// Owner: "for bulk b2b requirements, the actual IndiaMART buyer — we expand the truth of that buyer:
// profile spiral, persona, business persona, buyer persona." He never resolved WHERE it lives; the
// identity decision already answers it by analogy — persona is NOT a separate screen. It defaults to the
// last page (Business type / Industry) and is promoted onto the spec page as a NORMAL ranked question
// when it earns the slot, exactly like the GST ask.
//
// This is the DETERMINISTIC half. A persona question is only ever allowed for a buyer who is genuinely
// buying in bulk / as a business — never a small or one-off buyer — and never when we already hold his
// persona (then it is a prefill, not a question). The prompt states the rule; this decides it, because a
// prompt rule is a promise and a gate is an invariant (same discipline as the gstOnFile identity gate).

/** Rupee amounts as IndiaMART writes them: "0 - 40 L", "40 L - 1.5 Cr", "Rs. 400 - 1,600". */
const INR_UNIT: Record<string, number> = {
  k: 1e3, thousand: 1e3, l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5,
  mn: 1e6, million: 1e6, cr: 1e7, crore: 1e7, crores: 1e7, bn: 1e9, billion: 1e9,
};
/** Parse every number+unit pair out of a free-text amount band. Free text, not a field name — no routing. */
export function parseInrRange(raw: unknown): { min: number; max: number } | undefined {
  // Commas are STRIPPED, not spaced: Indian grouping writes ₹250,000 as "2,50,000", so turning commas into
  // separators reads one amount as three ("Rs. 400 - 1,600" became min 1 / max 600 — an order 100× too small).
  const s = String(raw ?? '').toLowerCase().replace(/,/g, '').replace(/₹/g, ' ').replace(/\brs\.?\b|\binr\b/g, ' ');
  if (!s.trim()) return undefined;
  const nums: number[] = [];
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)?/g)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    nums.push(n * (m[2] && INR_UNIT[m[2]] ? INR_UNIT[m[2]] : 1));
  }
  if (!nums.length) return undefined;
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/** Business roles that mean "buys for a business". Matched by EXACT normalised equality — never a
 *  substring, so "Individual Buyer" can never be read as a "Buyer" of any kind. */
const B2B_ROLES = new Set([
  'manufacturer', 'wholesaler', 'distributor', 'trader', 'exporter', 'importer', 'retailer',
  'service provider', 'online business', 'supplier', 'reseller', 'contractor', 'institution',
]);
/** Incorporation forms that are a direct read on B2B-ness. Proprietorship is deliberately NOT here —
 *  it is the default form for a one-man shop and says nothing about bulk. */
const B2B_LEGAL = new Set([
  'private limited', 'private limited company', 'pvt ltd', 'public limited', 'public limited company',
  'limited company', 'limited', 'llp', 'limited liability partnership', 'partnership', 'company',
]);
// A member_since string that clearly reads as a BRAND-NEW account (IndiaMART shows "This Month" / "This Week" and
// relative "N days ago" phrasings). Used only as a one-off veto BACKSTOP — never fires on an absent member_since.
const NEW_ACCOUNT = /this\s*(month|week)|\btoday\b|\byesterday\b|\b\d{1,2}\s*(day|week)s?\s*ago\b/i;

export interface BulkB2BSignals {
  buyer_b2b_b2c?: string;        // calls.buyer.b2b_b2c — HIS OWN call, outranks the category average
  buyer_persona?: string;        // calls.buyer.persona — the per-buyer persona the engine already computes
  turnover?: string;             // profile.business.turnover
  nature_of_business?: string;   // profile.business.nature_of_business
  legal_status?: string;         // profile.kyb.legal_status
  registration_year?: string;    // profile.kyb.registration_year
  business_type?: string;        // buyer_facts.business_type
  also_a_paid_seller?: string;   // profile.seller_context.custtype_name — he is himself a paying seller
  total_requirements?: number;
  total_calls?: number;
  member_since?: string;
  has_gst?: boolean;
  order_value?: string;          // the engine's order_value context fact for THIS requirement
}
export interface BulkB2BGate {
  is_bulk_b2b: boolean;
  score: number;                 // how many independent BUYER-level signals fired
  met: string[];                 // the signals, in plain English — shown to the planner and to the ledger
  vetoed_by?: string;            // why a persona question is forbidden outright
  persona_on_file?: string;      // when set, persona is a PREFILL and asking it is re-work
  signals: BulkB2BSignals;
}
/** Minimum independent buyer-level signals before a persona question may compete at all. */
const BULK_B2B_MIN_SCORE = 3;

/** THE GATE. Real signals only — turnover, order value, requirement count, incorporation, GST, his own
 *  B2B/B2C call read, and whether he is himself a paid IndiaMART seller. The CATEGORY's persona mix is
 *  deliberately NOT scored: a corpus average over other buyers is not evidence about this one. */
export function assessBulkB2B(s: BulkB2BSignals): BulkB2BGate {
  const met: string[] = [];
  const norm = (v: unknown) => decisionKey(String(v ?? ''));
  const b2b = norm(s.buyer_b2b_b2c);
  if (b2b === 'b2b') met.push('he reads as B2B on his own seller call');
  const turnover = parseInrRange(s.turnover);
  if (turnover && turnover.min > 0 && turnover.max >= 4e6) met.push(`declared turnover ${s.turnover}`);
  if (s.legal_status && B2B_LEGAL.has(norm(s.legal_status))) met.push(`incorporated as ${s.legal_status}`);
  const role = [s.nature_of_business, s.business_type].find((r) => r && B2B_ROLES.has(norm(r)));
  if (role) met.push(`his business is a ${role}`);
  if (s.has_gst) met.push('GST registered');
  if (s.also_a_paid_seller) met.push(`he is himself a paid IndiaMART seller (${s.also_a_paid_seller})`);
  if ((s.total_requirements ?? 0) >= 10) met.push(`${s.total_requirements} requirements posted before this one`);
  const order = parseInrRange(s.order_value);
  // order_value is a CORROBORATOR, never a standalone bulk trigger (deep-audit 2026-08-12 #13): a consumer buying 500
  // diaper packets legitimately reaches Rs 1–2 Lakh, so a basket size ALONE is not evidence of B2B — it was Sadhana's
  // only firing signal. It now counts only when a GENUINE business signal (GST / seller account / turnover /
  // incorporation / role / his own B2B call) has ALREADY fired, and the bar is raised above a consumer basket.
  if (order && order.max >= 100000 && met.length > 0) met.push(`this order is worth about ${s.order_value}`);

  // VETOES. Either one forbids the question no matter how the rest scores.
  let vetoed_by: string | undefined;
  if (b2b === 'b2c') vetoed_by = 'he reads as B2C on his own seller call — his own voice outranks every profile signal';
  // The one-off veto must fire only when we AFFIRMATIVELY KNOW he is a one-off — not when the counters are simply
  // ABSENT. Requiring `typeof total_requirements === 'number'` stops the veto from firing on an empty buyer_facts
  // payload; without this guard, a missing profile vetoed EVERY buyer and the persona prompt then silenced page 3
  // for everyone (the "same generic/empty page 3" bug, 2026-08-10). Unknown → neutral gate → LLM 3 may still ask.
  else if (typeof s.total_requirements === 'number' && s.total_requirements <= 2 && !s.has_gst && !s.also_a_paid_seller) {
    vetoed_by = 'a one-off buyer — barely any requirement history, no GST and no seller account';
  }
  // BACKSTOP (deep-audit 2026-08-12): even if the count is missing/inflated upstream, a BRAND-NEW buyer-only account
  // with NO bulk signal at all (met.length === 0), no GST and no seller account is a one-off — veto so the persona
  // layer cannot inflate him into a wholesaler. Gated on a PRESENT, clearly-new member_since (never on absent facts),
  // so it does NOT reintroduce the "empty page 3 for everyone" bug: an empty payload has no member_since to match.
  else if (met.length === 0 && !s.has_gst && !s.also_a_paid_seller && NEW_ACCOUNT.test(String(s.member_since ?? ''))) {
    vetoed_by = 'a brand-new buyer-only account — no bulk signal, no GST, no seller account, joined recently';
  }
  const persona_on_file = s.buyer_persona && String(s.buyer_persona).trim() ? String(s.buyer_persona).trim() : undefined;
  return { is_bulk_b2b: !vetoed_by && met.length >= BULK_B2B_MIN_SCORE, score: met.length, met, vetoed_by, persona_on_file, signals: s };
}

// ─── ITEM 3 · LAST-PAGE PLACEMENT — what the planner may and may not move ─────
// Owner: "the LLM also decides if last-page static questions remain, disappear, or if category insights
// say to ask them somewhere else in the flow." Today only GST is dynamic.
//
// HARD CONSTRAINT, enforced HERE and not in the prompt: consent, contact details and delivery location
// ALWAYS render. They are contractual (DPDP consent, the number a seller calls, where the goods go) and no
// model output may remove them. A planner that tries is a DEFECT — the attempt is ignored and recorded.
export const RELOCATABLE_LAST_PAGE_FIELDS = ['business_type', 'industry', 'purchase_frequency', 'delivery_timeline', 'payment_terms'] as const;
export type RelocatableField = (typeof RELOCATABLE_LAST_PAGE_FIELDS)[number];
export type Placement = 'keep_last_page' | 'promote_to_spec_page' | 'drop';
/** Never movable, never droppable, whatever the planner returns. */
export const LOCKED_LAST_PAGE_FIELDS = ['consent', 'contact_details', 'delivery_location'] as const;

/** Field name (planner's wording) → the canonical relocatable id. EXACT normalised keys, a Map lookup and
 *  not a regex, so no name can be matched inside a longer one (the Capa-CITY class of bug). */
const RELOCATABLE_ALIASES = new Map<string, RelocatableField>(([
  ['business type', 'business_type'], ['businesstype', 'business_type'], ['buyer type', 'business_type'],
  ['buyertype', 'business_type'], ['type of business', 'business_type'], ['business role', 'business_type'],
  ['industry', 'industry'], ['industry sector', 'industry'], ['sector', 'industry'],
  ['purchase frequency', 'purchase_frequency'], ['purchasefrequency', 'purchase_frequency'],
  ['frequency', 'purchase_frequency'], ['cadence', 'purchase_frequency'], ['purchase cadence', 'purchase_frequency'],
  ['order frequency', 'purchase_frequency'], ['buying frequency', 'purchase_frequency'], ['how often', 'purchase_frequency'],
  ['delivery timeline', 'delivery_timeline'], ['deliverytimeline', 'delivery_timeline'], ['timeline', 'delivery_timeline'],
  ['delivery time', 'delivery_timeline'], ['lead time', 'delivery_timeline'], ['delivery', 'delivery_timeline'],
  ['payment terms', 'payment_terms'], ['paymentterms', 'payment_terms'], ['payment term', 'payment_terms'],
  ['payment', 'payment_terms'], ['credit period', 'payment_terms'],
] as [string, RelocatableField][]));
/** Field name → the contractual field it is trying to touch. Everything here is refused. */
const LOCKED_ALIASES = new Map<string, string>([
  ['consent', 'consent'], ['terms', 'consent'], ['privacy', 'consent'], ['terms and conditions', 'consent'],
  ['consent notice', 'consent'], ['disclaimer', 'consent'],
  ['contact', 'contact details'], ['contact details', 'contact details'], ['contact detail', 'contact details'],
  ['contact name', 'contact details'], ['contact number', 'contact details'], ['name', 'contact details'],
  ['mobile', 'contact details'], ['phone', 'contact details'], ['email', 'contact details'],
  ['delivery location', 'delivery location'], ['location', 'delivery location'], ['delivery city', 'delivery location'],
  ['city', 'delivery location'], ['pincode', 'delivery location'], ['pin code', 'delivery location'],
  ['delivery address', 'delivery location'], ['address', 'delivery location'], ['deliver to', 'delivery location'],
  ['shipping address', 'delivery location'],
]);
/** GST is dynamic ALREADY, through the identity gap (owner-locked 2026-07-27). It is not a defect for the
 *  planner to want to move it — it just has its own path, so a placement decision on it is a no-op. */
const GST_ALIASES = new Set(['gst', 'gstin', 'gst number', 'gst registered', 'gst registration', 'tax registration']);

/** Fields that render on the last page today with no planner involvement. `purchase_frequency` is false:
 *  it has never had a last-page control (cadence arrives as a ranked gap), so "no decision" must leave the
 *  form exactly as it is rather than growing a new always-on question. */
const RENDERS_BY_DEFAULT: Record<RelocatableField, boolean> = {
  business_type: true, industry: true, purchase_frequency: false, delivery_timeline: true, payment_terms: true,
};

// ── The double-ask backstop ───────────────────────────────────────────────────
// Observed live on 106815489 the first time placements shipped: the planner promoted delivery_timeline and
// purchase_frequency onto the spec page AND emitted its own "How soon do you need delivery?" / "Is this a
// one-time order or a recurring requirement?" gaps, so the buyer was looking at each question twice, one
// above the other. The prompt has forbidden that since v2; a prompt rule is not an invariant.
//
// TOKEN-SET matching, never substring: a signature fires only when EVERY one of its tokens is present as a
// whole word. That is what keeps "How soon do you need it?" (delivery) apart from "How many do you need?"
// and stops "Delivery Pressure" — a real pump spec — from being read as a delivery date.
const CONCEPT_SIGNATURES: [RelocatableField, string[][]][] = [
  ['delivery_timeline', [['how', 'soon'], ['lead', 'time'], ['when', 'need'], ['when', 'require'], ['when', 'want'],
    ['delivery', 'time'], ['delivery', 'timeline'], ['delivery', 'date'], ['delivery', 'schedule'], ['deliver', 'by'], ['urgency'], ['timeline']]],
  ['purchase_frequency', [['how', 'often'], ['frequency'], ['recurring'], ['cadence'], ['reorder'],
    ['one', 'time', 'order'], ['repeat', 'order'], ['ongoing', 'requirement'], ['regular', 'supply']]],
  ['payment_terms', [['payment'], ['credit', 'period'], ['credit', 'terms'], ['advance']]],
  ['business_type', [['business', 'type'], ['type', 'business'], ['kind', 'business'], ['nature', 'business']]],
  ['industry', [['industry'], ['sector']]],
];
/** Which relocatable last-page field a free-form question is really asking about, if any. Free text in, so
 *  this is content matching and not name routing — but it is token-exact all the same. */
export function relocatableConceptOf(question: string): RelocatableField | undefined {
  const toks = new Set(decisionKey(question).split(' ').filter(Boolean));
  if (!toks.size) return undefined;
  for (const [field, signatures] of CONCEPT_SIGNATURES) {
    if (signatures.some((sig) => sig.every((t) => toks.has(t)))) return field;
  }
  return undefined;
}

export type PlacementSurface = 'last_page' | 'spec_page' | 'none';
export interface PlannerPlacement { field?: string; placement?: string; reason?: string }
export interface ResolvedPlacements {
  /** The planner's decision for each relocatable field, after the allow-list. */
  effective: Record<RelocatableField, Placement>;
  /** WHERE each field actually renders — the single thing the form reads. Distinct from `effective` because
   *  `keep_last_page` on purchase_frequency means "the last page" only when the planner ASKED for it there;
   *  with no decision at all that field has no last-page control and renders nowhere, exactly as today. */
  renders: Record<RelocatableField, PlacementSurface>;
  /** Only the fields the planner explicitly decided (everything else is the default) → reason. */
  decided: Partial<Record<RelocatableField, string>>;
  /** Ledger rows: every placement decision, honoured or refused, with the reason. */
  routes: DecisionRoute[];
}

const PLACEMENTS = new Set<Placement>(['keep_last_page', 'promote_to_spec_page', 'drop']);
const WHERE: Record<Placement, string> = {
  keep_last_page: 'last page · as usual',
  promote_to_spec_page: 'spec page · promoted question',
  drop: 'suppressed',
};

/** Apply the planner's placement decisions through the allow-list. `held` = the values we ALREADY have for
 *  each relocatable field — a `drop` is only honoured when we hold one, because dropping a question we
 *  cannot answer ourselves is not curation, it is data loss. */
export function resolvePlacements(
  raw: PlannerPlacement[] | undefined,
  held: Partial<Record<RelocatableField, string>> = {},
): ResolvedPlacements {
  const effective = Object.fromEntries(RELOCATABLE_LAST_PAGE_FIELDS.map((f) => [f, 'keep_last_page'])) as Record<RelocatableField, Placement>;
  const decided: Partial<Record<RelocatableField, string>> = {};
  const routes: DecisionRoute[] = [];
  const seen = new Set<RelocatableField>();
  for (const p of Array.isArray(raw) ? raw : []) {
    const name = String(p?.field ?? '').trim();
    if (!name) continue;
    const key = decisionKey(name);
    const want = String(p?.placement ?? '').trim().toLowerCase() as Placement;
    const why = String(p?.reason ?? '').trim();
    const canonical = RELOCATABLE_ALIASES.get(key);
    if (!canonical) {
      // ── the firewall. A contractual field always renders; the ATTEMPT is the thing worth recording.
      const locked = LOCKED_ALIASES.get(key);
      if (locked) {
        routes.push({ id: `place:${key}`, action: 'PLACEMENT', field: name, rendered: true, where: `last page · ${locked} (contractual)`,
          reason: `planner defect — it asked to ${want || 'move'} "${name}". Consent, contact details and delivery location always render; the request was ignored.` });
      } else if (GST_ALIASES.has(key)) {
        routes.push({ id: `place:${key}`, action: 'PLACEMENT', field: name, rendered: true, where: 'its own identity path',
          reason: 'GST is already dynamic through the ranked identity gap — a placement decision on it changes nothing and was ignored.' });
      } else {
        routes.push({ id: `place:${key}`, action: 'PLACEMENT', field: name, rendered: false, where: 'ignored',
          reason: `"${name}" is not one of the relocatable last-page fields (${RELOCATABLE_LAST_PAGE_FIELDS.join(', ')}) — ignored.` });
      }
      continue;
    }
    if (seen.has(canonical)) {
      routes.push({ id: `place:${canonical}:dup`, action: 'PLACEMENT', field: canonical, rendered: false, where: 'ignored',
        reason: 'the planner decided this field twice — the first decision stands.' });
      continue;
    }
    seen.add(canonical);
    if (!PLACEMENTS.has(want)) {
      routes.push({ id: `place:${canonical}`, action: 'PLACEMENT', field: canonical, rendered: RENDERS_BY_DEFAULT[canonical], where: WHERE.keep_last_page,
        reason: `"${p?.placement}" is not a placement — kept on the last page.` });
      continue;
    }
    if (want === 'drop' && !String(held[canonical] ?? '').trim()) {
      routes.push({ id: `place:${canonical}`, action: 'PLACEMENT', field: canonical, rendered: RENDERS_BY_DEFAULT[canonical], where: WHERE.keep_last_page,
        reason: `drop refused — we hold no value for it, so dropping it would lose the answer, not save the buyer a tap. (planner said: ${why || 'no reason given'})` });
      continue;
    }
    effective[canonical] = want;
    decided[canonical] = why;
    routes.push({
      id: `place:${canonical}`, action: 'PLACEMENT', field: canonical,
      rendered: want !== 'drop',
      where: WHERE[want],
      reason: want === 'drop' ? `we already hold "${held[canonical]}" — ${why || 'the planner dropped it'}` : why,
    });
  }
  // Everything the planner never mentioned keeps its default — recorded, because "no decision" is a decision.
  for (const f of RELOCATABLE_LAST_PAGE_FIELDS) {
    if (seen.has(f)) continue;
    routes.push({ id: `place:${f}`, action: 'PLACEMENT', field: f, rendered: RENDERS_BY_DEFAULT[f],
      where: RENDERS_BY_DEFAULT[f] ? WHERE.keep_last_page : 'not rendered',
      reason: RENDERS_BY_DEFAULT[f] ? 'the planner returned no decision — default placement.' : 'the planner returned no decision, and this field has no last-page control by default.' });
  }
  const renders = Object.fromEntries(RELOCATABLE_LAST_PAGE_FIELDS.map((f) => {
    if (effective[f] === 'drop') return [f, 'none'];
    if (effective[f] === 'promote_to_spec_page') return [f, 'spec_page'];
    // keep_last_page: only genuinely "on the last page" if it has a control there today, or the planner
    // deliberately put it there. Anything else must leave the form exactly as it was.
    return [f, RENDERS_BY_DEFAULT[f] || f in decided ? 'last_page' : 'none'];
  })) as Record<RelocatableField, PlacementSurface>;
  return { effective, renders, decided, routes };
}

export interface BrainSeed {
  productName: string;
  mcatId: string;
  committed: boolean;
  quantity: string;
  unit: string;
  specValues: Record<string, string>;      // stated/confirmed specs → pre-filled spec fields
  /** Fields seeded from an OBSERVED-tier decision (engine action CONFIRM) — i.e. lifted from something the
   *  buyer BROWSED, not something he stated. Per the fabrication firewall these must be shown back with their
   *  source and confirmed, never presented as his own words. Engine v8+ tiers these per-spec; before v8 a
   *  seller's catalogue row could ride in as PREFILL/"from your posted requirement". */
  observedFields?: Record<string, string>; // field → buyer-facing provenance ("from a product you viewed")
  deliveryLocation: string;
  /** ⚠ NO LONGER READ BY THE FORM (2026-07-28), and it must stay that way. The form always enters on the
   *  LANDING, because the owner-locked quantity rule is decided there and cannot be decided before the mcat
   *  resolves. Honouring a 'specs'/'more' start was exactly the bug: a seeded requirement skipped the qty ask
   *  and then got bounced backwards a second later. Kept as the adapter's statement of INTENT (which entry
   *  mode this is) — do not wire it back into the initial stage. */
  startStage: BrainStage;
  entryMode: string;
  gaps: { q: string; kind?: string; options?: string[] }[];   // ASK decisions → shown on the spec page's "smart questions"
  conflicts: Decision[];                    // RESOLVE_CONFLICT decisions → the A/B widget on the spec page
  suggestions?: Decision[];                 // SUGGEST decisions → unselected INFERRED-tier ghost chips (never pre-selected)
  offers?: Decision[];                      // OFFER decisions (e.g. the multi-item `project` offer) → dismissable strip
  /** ASK + SUGGEST + RESOLVE_CONFLICT + OFFER, flattened for the planner's <engine_decisions> block.
   *  PREFILL/CONFIRM are NOT here — they already reach the planner as `filled` (+ observedFields). SUPPRESS
   *  never leaves the engine. */
  engineDecisions?: EngineDecisionInput[];
  gstAsk: boolean;                          // kyb_unlock === 'offer'
  // context for the buyer-aware first question (the intelligence layer)
  buyerFacts?: Record<string, unknown>;
  basket?: string[];
  categoryTopSpecs?: { q: string; pct?: number; vals?: string[] }[];
  categoryKeywords?: string[];
  categoryPersonas?: unknown;   // where INTENT actually lives (v6 grounding audit), not in top_specs
  categoryB2b?: unknown;
  categoryCorpus?: unknown;   // the WHOLE category object (top_specs + personas + keywords + b2b_b2c) → drives catCorpus for
  //                            LLM 2. The form used to read only categoryTopSpecs and leave catCorpus null, so LLM 2 got
  //                            the DISTILLED feed (personas/keywords/b2b_b2c stripped) and fell back to generic. (2026-08-10)
  // ── ITEM 1 · the buyer's OWN business truth (node_raw.profile) — turnover, what he does, how he is
  //    incorporated, how old the business is, and whether he is himself a paid IndiaMART seller. Every one
  //    of these was parsed by the engine and read by nothing; they are what a BUSINESS PERSONA is built from.
  buyerProfile?: {
    company?: string; turnover?: string; nature_of_business?: string;
    legal_status?: string; registration_year?: string; also_a_paid_seller?: string;
  };
  /** The per-buyer persona the engine already computes from his own calls. Held → PREFILL, never asked. */
  buyerPersona?: { persona?: string; b2b_b2c?: string };
  /** ── THE BUYER'S OWN CONTACT IDENTITY (2026-07-28) ───────────────────────────────────────────────────
   *  What a LOGGED-IN form pre-fills its name / mobile / email / GST from. It was reading five hard-coded
   *  literals instead ('Demo Buyer', '9876543210', 'Manufacturer', 'Construction Equipment', a fake GSTIN),
   *  so a paper buyer rendered as a construction buyer on the page he submits from — and the form's own
   *  comment said "never ship a hard-coded identity".
   *  Values are passed through VERBATIM, including the masked placeholders this channel carries in
   *  non-production pulls ("MASKED"). Deciding what is presentable is the FORM's job, not the adapter's:
   *  the adapter's contract is "what does the engine know", and dropping data here would hide the masking
   *  from every other reader. The form drops placeholders + validates the GSTIN before it fills a field. */
  buyerIdentity?: { name?: string; mobile?: string; email?: string; gstin?: string };
  /** The engine's requirement-level CONTEXT facts (order_value / requirement_type / purchase_frequency /
   *  buyer_context). These are not ISQ chips — they were being skip-listed and dropped on the floor. */
  contextFacts?: Record<string, string>;
  /** The deterministic bulk-B2B verdict — the gate a persona question has to pass. */
  bulkGate?: BulkB2BGate;
  productImage?: string;                    // viewed/posted product image → seeded for display + image pipeline
  // the buyer's OWN truth signals for THIS requirement (WhatsApp / calls) — the planner enriches/corrects from these
  buyerSignals?: {
    whatsapp_products?: string[]; call_queries?: string[]; call_application?: string; call_specs?: { name: string; value: string }[];
    whatsapp_specs?: { name: string; value: string }[];   // buyer-typed specs on WhatsApp (e.g. gsm) → PREFILL
    objections?: string[];                                 // "too far" / "high price" → planner reframes a gap
    business_intent?: string[];                            // reselling / wholesale → flips the KYB/GST ask
    // CSL clickstream (owner 2026-07-29: "truth lies in his recent viewed product, search keywords, filters used").
    // These reached the buyer-twin PROFILE prompt but never the QUESTION planner — so the granular "he viewed three
    // 5-kVA gensets" / "he filtered Phase=3" signal that should SHARPEN a curated question was dropped. Now fed in.
    viewed_products?: string[];   // supplier-profile / product pages he browsed
    search_keywords?: string[];   // what he searched on site
    isq_filters?: string[];       // spec filters he applied while browsing (e.g. "Phase: 3-Phase")
  };
}

const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const asStrs = (x: unknown): string[] => asArr(x).filter((s): s is string => typeof s === 'string');
/** Pull the buyer's own WhatsApp/call signals out of the engine's node_raw (debug-only channel — but the
 *  PLANNER is a reasoning step, and the firewall still governs OUTPUT, so feeding it raw signals is allowed). */
function extractBuyerSignals(p: RequirementBrainPayload): BrainSeed['buyerSignals'] {
  const nr = (p.observability?.node_raw ?? {}) as Record<string, unknown>;
  const wa = (nr.whatsapp ?? {}) as Record<string, unknown>;
  const cr = (((nr.calls ?? {}) as Record<string, unknown>).requirement ?? {}) as Record<string, unknown>;
  const call_specs = asArr(cr.products)
    .flatMap((pr) => asArr((pr as Record<string, unknown>).specs))
    .map((s) => ({ name: String((s as Record<string, unknown>).name ?? ''), value: String((s as Record<string, unknown>).value ?? '') }))
    .filter((s) => s.name && s.value).slice(0, 12);
  // buyer-typed WhatsApp specs (e.g. {product, gsm}) → {name,value} pairs for PREFILL
  const whatsapp_specs = asArr(wa.buyer_typed_enquiries)
    .flatMap((e) => { const o = e as Record<string, unknown>; return Object.entries(o).filter(([k, v]) => k !== 'product' && v != null && String(v).trim()).map(([k, v]) => ({ name: k, value: String(v) })); })
    .slice(0, 8);
  // CSL clickstream — the browsing truth the QUESTION planner never got (owner 2026-07-29). Defensive shapes:
  // `viewed` may be strings or {name/product} objects; `isq_filters` may be strings or {name,value} pairs.
  const csl = (nr.csl ?? {}) as Record<string, unknown>;
  const nameOf = (v: unknown) => typeof v === 'string' ? v.trim() : String((v as Record<string, unknown>)?.name ?? (v as Record<string, unknown>)?.product ?? '').trim();
  const viewed_products = asArr(csl.viewed).map(nameOf).filter(Boolean).slice(0, 8);
  const search_keywords = asStrs(csl.searches).slice(0, 8);
  const isq_filters = asArr(csl.isq_filters).map((f) => {
    if (typeof f === 'string') return f.trim();
    const o = f as Record<string, unknown>; const n = String(o?.name ?? '').trim(); const val = String(o?.value ?? '').trim();
    return n ? (val ? `${n}: ${val}` : n) : '';
  }).filter(Boolean).slice(0, 8);
  const sig = {
    whatsapp_products: asStrs(wa.products_enquired).slice(0, 8),
    call_queries: asStrs(cr.buyer_queries).slice(0, 8),
    call_application: typeof cr.intended_application === 'string' ? (cr.intended_application as string) : undefined,
    call_specs, whatsapp_specs,
    objections: asStrs(wa.objections).slice(0, 6),
    business_intent: asStrs(wa.explicit_business_intent).slice(0, 6),
    viewed_products, search_keywords, isq_filters,
  };
  // only return if there's at least one real signal
  return (sig.whatsapp_products.length || sig.call_queries.length || sig.call_application || sig.call_specs.length || sig.whatsapp_specs.length || sig.objections.length || sig.business_intent.length || sig.viewed_products.length || sig.search_keywords.length || sig.isq_filters.length) ? sig : undefined;
}

const str = (x: unknown): string | undefined => {
  const s = typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : '';
  return s ? s : undefined;
};
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {});

/** ITEM 1 — the buyer's own BUSINESS truth out of node_raw.profile. Debug-only channel, but the planner is
 *  a reasoning step and the firewall governs OUTPUT, so feeding it these is allowed (same rule as signals). */
function extractBuyerProfile(p: RequirementBrainPayload): BrainSeed['buyerProfile'] {
  const pr = obj(obj(p.observability?.node_raw).profile);
  const business = obj(pr.business), kyb = obj(pr.kyb), identity = obj(pr.identity), seller = obj(pr.seller_context);
  const out = {
    company: str(identity.company),
    turnover: str(business.turnover),
    nature_of_business: str(business.nature_of_business),
    legal_status: str(kyb.legal_status),
    registration_year: str(kyb.registration_year),
    // v8 re-emitted this and it STILL had zero consumers: custtype_name "qgFCPplus with PNS" means this
    // buyer runs a paid seller account of his own. A material fact about how he buys — this is its first reader.
    also_a_paid_seller: str(seller.custtype_name),
  };
  return Object.values(out).some(Boolean) ? out : undefined;
}
/** ITEM 1 — `calls.buyer.persona` / `.b2b_b2c`: a per-buyer read the engine computes and nothing consumed,
 *  while the CATEGORY average of the same two fields was being passed to the planner. The average was
 *  beating the individual; this is the individual. */
function extractBuyerPersona(p: RequirementBrainPayload): BrainSeed['buyerPersona'] {
  const b = obj(obj(obj(p.observability?.node_raw).calls).buyer);
  const out = { persona: str(b.persona), b2b_b2c: str(b.b2b_b2c) };
  return out.persona || out.b2b_b2c ? out : undefined;
}
/** The buyer's contact identity: `profile.identity` first (the account record), then `calls.buyer` as a
 *  backstop for the two fields it also carries. GSTIN comes off `profile.kyb.gst`. Read-through only — no
 *  cleaning, no validation, no invention: an absent field stays absent so the form can leave it EMPTY. */
function extractBuyerIdentity(p: RequirementBrainPayload): BrainSeed['buyerIdentity'] {
  const pr = obj(obj(p.observability?.node_raw).profile);
  const identity = obj(pr.identity), kyb = obj(pr.kyb);
  const caller = obj(obj(obj(p.observability?.node_raw).calls).buyer);
  const out = {
    name: str(identity.name) ?? str(caller.name),
    mobile: str(identity.mobile) ?? str(caller.mobile),
    email: str(identity.email),
    gstin: str(kyb.gst),
  };
  return Object.values(out).some(Boolean) ? out : undefined;
}

const val = (d: Decision) => (typeof d.value === 'string' ? d.value : '');
const isFilled = (a: Decision) => a.action === 'PREFILL' || a.action === 'CONFIRM';
/** Requirement-level context the engine states but the ISQ list must not show as a chip. It used to be
 *  `continue`d into oblivion; now it is captured — order_value feeds the bulk gate, buyer_context is the
 *  stated use-case ITEM 2 pre-answers the intent question from, purchase_frequency is a held cadence. */
const CONTEXT_KEYS = new Set(['order_value', 'requirement_type', 'purchase_frequency', 'buyer_context']);

/** The bulk-B2B gate assembled from every source that carries a real signal. */
function gateFor(
  buyerFacts: Record<string, unknown> | undefined,
  profile: BrainSeed['buyerProfile'],
  persona: BrainSeed['buyerPersona'],
  contextFacts: Record<string, string>,
): BulkB2BGate {
  const bf = buyerFacts ?? {};
  return assessBulkB2B({
    buyer_b2b_b2c: persona?.b2b_b2c,
    buyer_persona: persona?.persona,
    turnover: profile?.turnover,
    nature_of_business: profile?.nature_of_business,
    legal_status: profile?.legal_status,
    registration_year: profile?.registration_year,
    business_type: str(bf.business_type),
    also_a_paid_seller: profile?.also_a_paid_seller,
    total_requirements: typeof bf.total_requirements === 'number' ? bf.total_requirements : undefined,
    total_calls: typeof bf.total_calls === 'number' ? bf.total_calls : undefined,
    member_since: str(bf.member_since),
    has_gst: !!bf.has_gst || !!bf.gst_verified,
    order_value: contextFacts.order_value,
  });
}

// The four actions that are a QUESTION-SELECTION decision (as opposed to a fill). These are the ones the
// planner must rank/phrase rather than re-invent. Ordered by how load-bearing they are for the firewall.
const PLANNABLE: DecisionAction[] = ['RESOLVE_CONFLICT', 'ASK', 'SUGGEST', 'OFFER'];

// ─── THE CALL-PRIVACY GATE (P0, owner 2026-07-28) ─────────────────────────────
// "nowhere should buyer know that we are listening his calls."
//
// `why` is the ONE engine-authored string that reaches a BUYER-FACING caption: when the planner dies or never
// ranks an ASK, BrainRFQForm renders the decision's own `why` as the "— …" caption beside the question. And
// `why` falls back to `reason`, which the engine writes in the buyer's voice ("two of your own signals
// disagree", "you have other active needs"). So the day the engine words one of those with a call in it — "you
// said 500 litres on a call" is exactly the phrasing its RESOLVE_CONFLICT sources already use — it ships to the
// buyer, and no amount of prompt discipline in gemini.ts can stop it, because this string never goes near the
// planner. The prompt rule is a promise; this is the invariant.
//
// It can only ever SUPPRESS — absent beats wrong, and losing a four-word caption costs the buyer nothing. The
// decision itself, its `reason`, its conflict sources and its evidence are untouched, so the debug panel and
// the planner still see the full, un-redacted truth. Word-bounded, because unbounded name matching is the
// recurring defect in this codebase; matched against free-form PROSE, not a field name, so it routes nothing.
// A false positive ("sellers call to confirm the size") costs one caption and is the right trade.
const CALL_REVEALING = /\b(call|calls|called|calling|phone|phoned|spoke|spoken|speaking|heard|listen|listened|listening|recorded|recording|recordings|transcript|transcribed|transcription|conversation|conversations)\b/i;
/** Buyer-facing caption, or nothing. Anything that would tell the buyer we read/heard his calls is dropped. */
export function buyerSafeWhy(s: unknown): string | undefined {
  const t = String(s ?? '').trim();
  if (!t) return undefined;
  return CALL_REVEALING.test(t) ? undefined : t;
}
/** Flatten the engine's question-selection decisions into the planner's input shape. Options are normalised:
 *  a RESOLVE_CONFLICT carries `ConflictOption` objects (value + WHERE it came from), everything else plain
 *  strings — the planner needs the source strings to explain the A/B choice in the buyer's own terms. */
export function toEngineDecisions(decisions: Decision[]): EngineDecisionInput[] {
  const out: EngineDecisionInput[] = [];
  for (const d of decisions) {
    if (!d || !PLANNABLE.includes(d.action) || !d.field) continue;
    const opts = d.options ?? [];
    const conflict = d.action === 'RESOLVE_CONFLICT'
      ? opts.map((o) => (typeof o === 'string' ? { value: o, source: 'unknown' } : { value: o.value, source: o.source, evidence: o.evidence })).filter((o) => o.value)
      : undefined;
    out.push({
      id: `e${out.length + 1}`,
      action: d.action as EngineDecisionInput['action'],
      field: d.field,
      value: typeof d.value === 'string' && d.value.trim() ? d.value : undefined,
      options: opts.map((o) => (typeof o === 'string' ? o : o.value)).filter(Boolean),
      conflict: conflict && conflict.length ? conflict : undefined,
      // `why` reaches a BUYER-FACING caption (see buyerSafeWhy) — the planner is not in that path, so the gate is.
      why: buyerSafeWhy(d.why) || buyerSafeWhy(d.reason),
      kind: d.kind,
      priority: typeof d.priority === 'number' ? d.priority : undefined,
      confidence: typeof d.confidence === 'number' ? d.confidence : undefined,
      freshness: d.freshness,
    });
  }
  // Highest-priority first so a truncating model sees the decisive ones; the planner re-ranks anyway.
  return out.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
// fields that are NOT ISQ specs — routed to their own form state, not specValues
// WORD-BOUNDED. `/city/` matched "Capa-CITY" (and Velocity, Electricity), so every capacity spec —
// "Storage Capacity: 1 kg", "Capacity (Weight): 1 kg" — was being routed into DELIVERY LOCATION and the
// buyer saw "1 kg" as his delivery city. Same substring-containment class of bug as the earlier
// application/buyer_context collision. Anchor every alternative to a word boundary.
const QTY = /^(quantity|qty)$/i, QTY_UNIT = /quantity ?unit|unit of/i;
// `\b` does not break on "_", so delivery_city would miss — normalise separators to spaces first.
const words = (s: string) => ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const DELIV = (name: string) => / (deliver|delivery|delivered|location|city|pincode|pin code) /.test(words(name));

/** Build the seed for the RESOLVED primary requirement (the enrich / gap flow). */
export function brainToSeed(p: RequirementBrainPayload): BrainSeed {
  const m = p.metadata;
  const specValues: Record<string, string> = {};
  const observedFields: Record<string, string> = {};
  const contextFacts: Record<string, string> = {};
  let quantity = '', unit = '', deliveryLocation = '';
  for (const d of p.decisions) {
    // capture the context facts BEFORE the skip-list below drops them (they never became a chip and never
    // reached any reader — order_value is on the dead-facet list for exactly this reason)
    if (isFilled(d) && d.value && CONTEXT_KEYS.has(String(d.field).toLowerCase())) contextFacts[String(d.field).toLowerCase()] = val(d);
    if (!isFilled(d) || !d.value) continue;
    // CONFIRM = OBSERVED tier (browsed, not stated). Still seeded so the buyer doesn't retype it, but tracked
    // so the spec page can badge it with its real source instead of passing it off as his own answer.
    if (d.action === 'CONFIRM' && !QTY.test(d.field) && !QTY_UNIT.test(d.field) && !DELIV(d.field)) {
      observedFields[d.field] = d.reason || 'from a product you viewed';
    }
    if (QTY.test(d.field)) { quantity = val(d); continue; }
    if (QTY_UNIT.test(d.field)) { unit = val(d); continue; }
    if (DELIV(d.field)) { deliveryLocation = val(d); continue; }
    if (/^(order_value|requirement_type|purchase_frequency|buyer_context)$/i.test(d.field)) continue; // context, not an ISQ chip. `application` was REMOVED (2026-07-28): the engine renames the
    // call-derived use-case to `buyer_context`, so `application` can now only match a REAL ISQ spec the
    // buyer answered — and this line was deleting it before it reached specValues. Caught by a failing test.
    specValues[d.field] = val(d);
  }
  // entry_mode → where to land. Enrich/confirm start on specs (product known); cold starts on product.
  const startStage: BrainStage =
    m.entry_mode === 'blank_multimodal' || !m.primary ? 'product'
    : m.entry_mode === 'confirm_draft' ? 'more'          // complete → straight to the last page to send
    : 'specs';                                           // gap/repost/chooser → specs (prefills + ranked gaps, one page)
  const buyerProfile = extractBuyerProfile(p);
  const buyerPersona = extractBuyerPersona(p);
  return {
    productName: m.primary?.product ?? '',
    mcatId: m.primary?.mcat ?? '',
    committed: !!m.primary,
    quantity, unit, deliveryLocation, startStage,
    entryMode: m.entry_mode,
    specValues,
    observedFields: Object.keys(observedFields).length ? observedFields : undefined,
    gaps: p.decisions.filter((d) => d.action === 'ASK').map((d) => ({ q: d.field, kind: d.kind, options: (d.options ?? []).map((o) => (typeof o === 'string' ? o : o.value)) })),
    conflicts: p.decisions.filter((d) => d.action === 'RESOLVE_CONFLICT'),
    suggestions: p.decisions.filter((d) => d.action === 'SUGGEST'),
    offers: p.decisions.filter((d) => d.action === 'OFFER'),
    engineDecisions: toEngineDecisions(p.decisions),
    gstAsk: m.kyb_unlock.state === 'offer',
    buyerFacts: m.buyer_facts as Record<string, unknown> | undefined,
    basket: (m.recommendations ?? []).map((r) => r.product),
    // clamp the corpus asked_pct bug (39% of categories exceed 100% — counts spec occurrences across products);
    // clamp to <=100 so the gate + any "asked in X%" copy is never nonsensical (true corpus dedupe is a separate fix).
    categoryTopSpecs: (m.category?.top_specs ?? []).map((s) => ({ ...s, pct: typeof s.pct === 'number' ? Math.min(100, Math.round(s.pct)) : s.pct })),
    categoryKeywords: m.category?.keywords,
    categoryPersonas: m.category?.personas,
    categoryB2b: m.category?.b2b_b2c,
    categoryCorpus: m.category,
    buyerSignals: extractBuyerSignals(p),
    buyerProfile, buyerPersona, buyerIdentity: extractBuyerIdentity(p),
    contextFacts: Object.keys(contextFacts).length ? contextFacts : undefined,
    bulkGate: gateFor(m.buyer_facts as Record<string, unknown> | undefined, buyerProfile, buyerPersona, contextFacts),
    // the primary card has an image too — brainToSeed was the only builder dropping it
    productImage: (m.recommendations ?? []).find((r) => r.product === m.primary?.product)?.image ?? undefined,
  };
}

/** Seed for a picked recommendation card. Enrich & Source are the SAME flow — both carry product +
 *  image + whatever specs we have; the form's own pipeline (like the image flow) fills the rest.
 *
 *  TAKES THE PAYLOAD. This used to build a seed from the card ALONE, so every card except the engine's
 *  #1 (which goes through brainToSeed) dropped buyerFacts, basket and buyerSignals — the planner then ran
 *  with `(none)` for every WhatsApp and call signal, and the GST code-gate read `undefined` and could ask
 *  a GST-verified buyer whether he is GST registered. The cards are recency-sorted, so the one card that
 *  carried full context often was not even the first on screen. Buyer-level truth belongs to the BUYER,
 *  not to whichever card he happened to tap. */
export function recommendationToSeed(
  rec: { product: string; mcat?: string; is_expired?: boolean; specs?: { name: string; value: string }[]; image?: string | null },
  p?: RequirementBrainPayload,
): BrainSeed {
  const specValues: Record<string, string> = {};
  const contextFacts: Record<string, string> = {};
  // Route qty / unit / delivery OUT of specs into their own fields (same as brainToSeed) — else a
  // reposted card's "Quantity: 500 / Quantity Unit: Piece" stays a spec chip and the qty box shows empty.
  let quantity = '', unit = '', deliveryLocation = '';
  for (const s of rec.specs ?? []) {
    if (!s.name || !s.value) continue;
    if (CONTEXT_KEYS.has(s.name.toLowerCase())) contextFacts[s.name.toLowerCase()] = s.value;   // captured, not discarded
    if (QTY.test(s.name)) { quantity = s.value; continue; }
    if (QTY_UNIT.test(s.name)) { unit = s.value; continue; }
    if (DELIV(s.name)) { deliveryLocation = s.value; continue; }
    if (/^(order_value|requirement_type|purchase_frequency|buyer_context)$/i.test(s.name)) continue; // context, not an ISQ chip
    specValues[s.name] = s.value;
  }
  const buyerProfile = p ? extractBuyerProfile(p) : undefined;
  const buyerPersona = p ? extractBuyerPersona(p) : undefined;
  return {
    productName: rec.product, mcatId: rec.mcat ?? '', committed: !!rec.mcat,
    quantity, unit, deliveryLocation,
    startStage: rec.mcat ? 'specs' : 'product',
    entryMode: rec.is_expired ? 'repost' : 'enrich',
    // Decision Objects are REQUIREMENT-scoped: they were reasoned for the engine's primary requirement, not for
    // whichever other card the buyer tapped. Buyer-LEVEL truth below is carried; per-requirement asks are not.
    specValues, gaps: [], conflicts: [], suggestions: [], offers: [], engineDecisions: [],
    gstAsk: p?.metadata.kyb_unlock.state === 'offer',
    // carry image so the seed flows through the form's image/display pipeline exactly like an upload
    productImage: rec.image ?? undefined,
    // BUYER-LEVEL truth — identical for every card, so it must not depend on which card was tapped.
    buyerFacts: p?.metadata.buyer_facts as Record<string, unknown> | undefined,
    basket: (p?.metadata.recommendations ?? []).map((r) => r.product),
    // CATEGORY IS PRIMARY-SCOPED, so carry it ONLY when the tapped card IS the engine's primary (owner 2026-07-29,
    // the anchor bug). The engine computes metadata.category for its OWN primary (chosen by source-count, which can
    // be the WRONG requirement); this seed sets mcatId to the TAPPED card. Carrying the primary's category under a
    // different mcat is exactly how a Tata Chhota Hathi repost showed notebook-machine questions. When the tapped
    // card is not the primary, omit it and let the form re-fetch the RIGHT category for the resolved mcat (the
    // catBrain effect now re-fetches when the seed has no category for this mcat). Same discipline as buyerSeed.
    ...((p?.metadata.primary?.mcat && rec.mcat && String(p.metadata.primary.mcat) === String(rec.mcat)) ? {
      categoryTopSpecs: (p?.metadata.category?.top_specs ?? []).map((x) => ({ ...x, pct: typeof x.pct === 'number' ? Math.min(100, Math.round(x.pct)) : x.pct })),
      categoryKeywords: p?.metadata.category?.keywords,
      categoryPersonas: p?.metadata.category?.personas,
      categoryB2b: p?.metadata.category?.b2b_b2c,
      categoryCorpus: p?.metadata.category,
    } : {}),
    buyerSignals: p ? extractBuyerSignals(p) : undefined,
    // Buyer-LEVEL again: his business truth, his persona, his identity and the bulk gate are identical for
    // every card — none of them may depend on which card he happened to tap.
    buyerProfile, buyerPersona, buyerIdentity: p ? extractBuyerIdentity(p) : undefined,
    contextFacts: Object.keys(contextFacts).length ? contextFacts : undefined,
    bulkGate: gateFor(p?.metadata.buyer_facts as Record<string, unknown> | undefined, buyerProfile, buyerPersona, contextFacts),
  };
}

/** Blank seed — brand-new requirement (cold start). */
export const blankSeed = (): BrainSeed => ({
  productName: '', mcatId: '', committed: false, quantity: '', unit: '', deliveryLocation: '',
  startStage: 'product', entryMode: 'blank_multimodal', specValues: {}, gaps: [], conflicts: [], gstAsk: false,
});

/** ── THE LANDING SEED (2026-07-28) ────────────────────────────────────────────
 *  The chooser is no longer a page of its own: it shares the LANDING with the product input and the
 *  quantity ask, so the form now mounts BEFORE any requirement is picked. That mount needs everything
 *  true about the BUYER — his facts, his business profile, his own persona, the bulk-B2B gate, his
 *  WhatsApp/call signals — and nothing at all about a requirement he has not chosen yet.
 *
 *  Deliberately absent, and each for a reason:
 *   • productName / mcatId — naming the product is the job of the page this seeds.
 *   • engineDecisions / gaps / conflicts / offers — Decision Objects are REQUIREMENT-scoped. They arrive
 *     the moment he taps a card, through brainToSeed (the engine's primary) or recommendationToSeed.
 *   • categoryTopSpecs / personas / b2b_b2c — those describe the PRIMARY's category, which is the wrong
 *     category for a product he has not picked. The form re-fetches top-specs per resolved mcat anyway.
 */
export function buyerSeed(p: RequirementBrainPayload): BrainSeed {
  const m = p.metadata;
  const buyerProfile = extractBuyerProfile(p);
  const buyerPersona = extractBuyerPersona(p);
  return {
    ...blankSeed(),
    entryMode: m.entry_mode || 'blank_multimodal',
    buyerFacts: m.buyer_facts as Record<string, unknown> | undefined,
    basket: (m.recommendations ?? []).map((r) => r.product),
    buyerSignals: extractBuyerSignals(p),
    buyerProfile, buyerPersona, buyerIdentity: extractBuyerIdentity(p),
    // No requirement is chosen, so there is no order_value to score — the gate runs on buyer-level truth only.
    bulkGate: gateFor(m.buyer_facts as Record<string, unknown> | undefined, buyerProfile, buyerPersona, {}),
  };
}
