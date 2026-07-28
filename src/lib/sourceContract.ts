// ─── Source Contracts ────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// The external architecture review's finding was: "Every source should publish Version, Fields,
// Freshness, Confidence, Coverage, Latency, Owner. Today every parser is custom. That becomes hard
// to maintain." This file is that publication — one declared contract per source the RFQ pipeline
// consumes, plus the thing the review did NOT ask for but every incident so far has needed:
//
//   FOR EVERY FACET, WHO READS IT.
//
// The recurring bug class in this pipeline is "parsed-then-dropped": a parser does real work,
// emits a field, and nothing downstream ever reads it. Confirmed instances (all encoded below):
//   · profile.seller_context — parsed by buyer-brain, dropped by the node_raw output whitelist
//   · csl.search_freq        — the "×15" repeat count, regex-stripped then re-emitted, unread
//   · csl.viewed_last        — CSL timestamps, collapsed to an int elsewhere, this map unread
//   · category.top_specs_source — added in v11 so getisq-derived specs could be told apart; unread
//   · calls.seller_engagement.* / calls.buyer.persona / calls.buyer.b2b_b2c — whole branches unread
// A facet with zero LIVE consumers is a finding, not a curiosity. `validateSourceContract` makes it
// machine-detectable, and src/lib/__tests__/sourceConsumption.test.ts makes it a build failure.
//
// SCOPE — the six sources of `observability.node_raw` in a RequirementBrainPayload:
//   csl · rfq · profile · calls · whatsapp · category
// The facet list is derived from two pieces of REAL data, never from imagination:
//   1. src/lib/brains/requirementBrainFixtures.json (3 captured engine outputs), and
//   2. the v11 workflow "REQUIREMENT-BRAIN v11 (overlap hardening + top_specs_source)
//      [bi-requirement-brain].json", nodes `buyer-brain` and `requirement-brain` (jsCode).
// Where the two disagree the workflow wins and the facet is marked `sinceVersion`, because the
// fixtures were captured from the older `req-brain-v2` emitter.

import type { RequirementBrainPayload } from './brains/requirementBrain';

// ── the six sources ──────────────────────────────────────────────────────────
export type SourceId = 'csl' | 'rfq' | 'profile' | 'calls' | 'whatsapp' | 'category';
export const SOURCE_IDS: SourceId[] = ['csl', 'rfq', 'profile', 'calls', 'whatsapp', 'category'];

/** How a consumer uses a facet. `debug` and `health` DO NOT keep a facet alive — a raw JSON dump in
 *  the observability panel is not consumption, it is the absence of consumption made visible. */
export type ConsumerKind = 'decision' | 'planner' | 'llm' | 'render' | 'debug' | 'health';
const LIVE_KINDS: ConsumerKind[] = ['decision', 'planner', 'llm', 'render'];

export interface ConsumerDef {
  kind: ConsumerKind;
  /** file:symbol, or the n8n node name — always greppable. */
  where: string;
  /** what this consumer does with what it reads. */
  does: string;
}

/** Every consumer in the requirement-brain path. Ids are stable and greppable; a typo is a compile
 *  error because facets reference them by `ConsumerId`. */
export const CONSUMERS = {
  'planner:bulk-b2b-gate': { kind: 'planner', where: 'formAdapter.assessBulkB2B + runCuratedPlanner', does: 'scores whether this is a genuinely bulk/B2B buyer, and reasons the business/buyer persona from it' },
  'buyer-brain:signal-pool': { kind: 'decision', where: 'n8n buyer-brain (jsCode) — signals[] → reqs[]', does: 'pools every source signal into requirement clusters (overlap()/NAME_RANK)' },
  'buyer-brain:signal-age': { kind: 'decision', where: 'n8n buyer-brain (jsCode) — ageDays()/hit.dates', does: 'turns a source timestamp into age_days + a freshness band' },
  'req-brain:evidence': { kind: 'decision', where: 'n8n requirement-brain — buildEvidence()', does: 'emits an evidence atom (stated/observed/inferred/noise)' },
  'req-brain:resolver': { kind: 'decision', where: 'n8n requirement-brain — resolve()/scoreReq()', does: 'ranks requirements and picks the primary' },
  'req-brain:relevance': { kind: 'decision', where: 'n8n requirement-brain — relevance()', does: 'splits the rest into relevant / project / ignore' },
  'req-brain:reconcile': { kind: 'decision', where: 'n8n requirement-brain — reconcile()', does: 'builds the A/B conflict when two of the buyer own signals disagree' },
  'req-brain:planner': { kind: 'planner', where: 'n8n requirement-brain — plan()', does: 'chooses the ≤3 gap questions and the ghost-chip suggestions' },
  'req-brain:scorer': { kind: 'decision', where: 'n8n requirement-brain — score()', does: 'computes intent level + certainty' },
  'req-brain:kyb': { kind: 'decision', where: 'n8n requirement-brain — kybUnlock()', does: 'decides verified / on_file / offer / suppressed' },
  'req-brain:adapter': { kind: 'render', where: 'n8n requirement-brain — adapt()', does: 'writes metadata the UI renders (primary, recommendations, buyer_memory, category, buyer_facts)' },
  'req-brain:entry': { kind: 'planner', where: 'n8n requirement-brain — n8n entry block', does: 'substitutes getISQ rows for an empty category brain (cat.top_specs fallback)' },
  'req-brain:node-health': { kind: 'health', where: 'n8n requirement-brain — nodeHealth()', does: 'green/amber/red dot + count in the debug panel' },
  'formAdapter:brainToSeed': { kind: 'render', where: 'src/lib/brains/formAdapter.ts — brainToSeed()', does: 'maps decisions + metadata into the form seed the buyer actually sees' },
  'formAdapter:buyerSignals': { kind: 'llm', where: 'src/lib/brains/formAdapter.ts — extractBuyerSignals()', does: 'lifts WhatsApp/call truth out of node_raw into BrainSeed.buyerSignals' },
  'gemini:curated-planner': { kind: 'llm', where: 'src/lib/gemini.ts — runCuratedPlanner()', does: 'fences the value into its own XML block in the planner prompt' },
  'BrainFormGate:suggester': { kind: 'render', where: 'src/components/BrainFormGate.tsx — SUGGEST', does: 'product-name suggest dropdown on the landing page' },
  'BrainFormGate:cards': { kind: 'render', where: 'src/components/BrainFormGate.tsx — reqCards/browsed', does: 'requirement + browsed-product cards' },
  'BrainDebugPanel:raw-dump': { kind: 'debug', where: 'src/components/BrainDebugPanel.tsx — <Pre v={nodeRaw[name]}/>', does: 'dumps the whole source blob as JSON — NOT consumption' },
} as const satisfies Record<string, ConsumerDef>;

export type ConsumerId = keyof typeof CONSUMERS;

export interface Facet {
  /** Dot path inside `observability.node_raw[source]`. `[]` = array hop (each element is walked). */
  path: string;
  /** One line: what the value is. */
  what: string;
  /** Who reads it. EMPTY ARRAY = parsed-then-dropped. */
  consumedBy: ConsumerId[];
  /** false = the upstream parser produces it but the node_raw whitelist drops it before it is
   *  observable at all. Those are the worst offenders: invisible AND unread. */
  emitted?: boolean;
  /** engine version that introduced the facet — the 3 fixtures predate anything above req-brain-v2. */
  sinceVersion?: string;
  note?: string;
}

export interface SourceContract {
  source: SourceId;
  /** Version of the SHAPE published here, i.e. which emitter produced it. */
  version: string;
  /** Who owns the parser — the n8n node chain that must change if the shape changes. */
  owner: string;
  producedBy: string[];
  /** Wall-clock cost of including this source in a pull. */
  latency: { tier: 'fast' | 'slow'; typicalMs: number; note?: string };
  /** How old the data can be, and what ages it. */
  freshness: { kind: 'event_log' | 'snapshot' | 'transcript' | 'corpus'; window: string; ageField: string | null };
  /** Fabrication-firewall tier this source can ever justify. `stated` = the buyer said/typed it. */
  confidence: { tier: 'stated' | 'observed' | 'inferred' | 'meta'; basis: string };
  /** Share of buyers this source returns anything for. `pct: null` = never measured — say so
   *  rather than invent a number; `observed` is computed per-payload by validateSourceContract. */
  coverage: { pct: number | null; basis: string };
  fields: Facet[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CSL — clickstream / HTTP access logs. Everything here is OBSERVED, never stated.
// ─────────────────────────────────────────────────────────────────────────────
const CSL: SourceContract = {
  source: 'csl',
  version: 'csl-final1 → buyer-brain-v4.2-timelines (bundle.browse + bundle.seller_intent)',
  owner: 'BI pipeline · CSL branch',
  producedBy: ['csl-data', 'csl-to-llm1', 'csl-enrich-mcat1', 'csl-enrich-city1', 'csl-enrich-prod1', 'csl-merge1', 'csl-final1'],
  latency: { tier: 'fast', typicalMs: 4000, note: 'always in the fast tier; the enrich fan-out is the slow part' },
  freshness: { kind: 'event_log', window: 'rolling recent sessions', ageField: 'searched_last / viewed[].last_seen' },
  confidence: { tier: 'observed', basis: 'browsing behaviour — the buyer never asserted any of it, so it can only ever produce CONFIRM chips, never PREFILL' },
  coverage: { pct: null, basis: 'not measured pipeline-wide; present in 3/3 captured fixtures' },
  fields: [
    { path: 'searches', what: 'search terms the buyer typed, repeat-count suffix stripped', consumedBy: ['buyer-brain:signal-pool', 'req-brain:adapter', 'BrainFormGate:suggester'] },
    { path: 'search_freq', what: 'per-term repeat count — the "x15" the label-cleaner used to throw away', consumedBy: [], sinceVersion: 'buyer-brain v8', note: 'DEAD. Re-captured in v8 precisely because it had been destroyed by the label regex; still nothing ranks by it. Repeat count is the single strongest un-used intent signal CSL has.' },
    { path: 'searched_last', what: 'ISO timestamp of the last time each term was searched', consumedBy: ['buyer-brain:signal-age'], note: 'consumed, but ONLY collapsed into age_days — the timestamp itself never reaches a surface' },
    { path: 'viewed_last', what: 'ISO timestamp map for viewed products', consumedBy: [], note: 'DEAD. buyer-brain ages viewed products from viewed[].last_seen instead, so this parallel map is pure duplication.' },
    { path: 'viewed[].name', what: 'product page the buyer opened', consumedBy: ['buyer-brain:signal-pool', 'req-brain:adapter', 'BrainFormGate:cards'] },
    { path: 'viewed[].image', what: 'product image from mesh_report.pc_item', consumedBy: ['buyer-brain:signal-pool', 'req-brain:adapter', 'BrainFormGate:cards'] },
    { path: 'viewed[].mcat', what: 'mcat of the viewed product', consumedBy: ['buyer-brain:signal-pool', 'req-brain:planner'] },
    { path: 'viewed[].specs', what: "spec sheet lifted off the SELLER's catalogue row", consumedBy: ['buyer-brain:signal-pool', 'req-brain:evidence'], note: 'tiered `observed` per-spec since buyer-brain v8 (_src) — before that a seller catalogue row could ride in as "from your posted requirement"' },
    { path: 'viewed[].last_seen', what: 'when the product page was opened', consumedBy: ['buyer-brain:signal-age'] },
    { path: 'isq_filters', what: 'ISQ filter values the buyer TICKED on a listing page', consumedBy: [], note: 'DEAD. This is the buyer choosing a spec value with his own hands — the highest-value observed signal CSL has — and only bundle.browse.filters.city is read. The rest is dumped and forgotten.' },
    { path: 'category_isq', what: 'getISQ spec rows resolved for the top browsed mcat', consumedBy: ['req-brain:entry'], sinceVersion: 'requirement-brain v8', note: 'was the textbook parsed-then-dropped case until v8 wired it in as the fallback for an empty category brain' },
    { path: 'buyer_is_also_seller', what: 'the buyer also has a seller panel', consumedBy: [], note: 'DEAD, and worse: it is computed in csl-to-llm1 by `title.includes("seller") || path.includes("seller")`, which also matches reseller / bestseller / the buyer own seller-panel traffic. An unread facet computed by an unbounded substring match.' },
    { path: 'seller_intent.suppliers_viewed', what: 'GLIDs of suppliers whose pages were opened', consumedBy: [], note: 'DEAD' },
    { path: 'seller_intent.profile_visits', what: 'count of supplier-profile visits', consumedBy: [], note: 'DEAD. Inflated by the same includes("seller") substring bug above.' },
    { path: 'seller_intent.comparisons', what: 'supplier comparisons run', consumedBy: ['req-brain:scorer'], note: 'the ONE seller_intent facet with a live consumer (funnel + callLvl)' },
    { path: 'seller_intent.contacted', what: 'called / whatsapped / messages_to_sellers counters', consumedBy: [], note: 'DEAD. score() reads profile.activity.total_calls instead, so the CSL-side proof that he already contacted sellers is discarded.' },
    { path: 'browse_channel', what: 'web / msite / app', consumedBy: [], note: 'DEAD' },
    { path: 'browse_location', what: 'city the buyer was actually browsing from', consumedBy: ['req-brain:evidence'], note: 'drives the delivery_city A/B — registered vs browsing city differ for ~53% of buyers' },
    { path: 'filters.city', what: 'city filter the buyer applied on a listing page', consumedBy: ['req-brain:evidence'], emitted: false, note: 'read as bundle.browse.filters.city (delivery_city backstop) but NOT re-emitted into node_raw — invisible in debug' },
    { path: 'filters.mcategory', what: 'mcategory filters applied', consumedBy: [], emitted: false, note: 'DEAD and invisible' },
    { path: 'filters.category', what: 'category filters applied', consumedBy: [], emitted: false, note: 'DEAD and invisible' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// RFQ — the buyer's own posted requirements. The only STATED source with structure.
// ─────────────────────────────────────────────────────────────────────────────
const RFQ: SourceContract = {
  source: 'rfq',
  version: 'rfq-call1 → buyer-brain reqs[] (posted-only projection)',
  owner: 'BI pipeline · RFQ branch',
  producedBy: ['rfq-call1', 'rfq-tag1', 'buyer-brain'],
  latency: { tier: 'fast', typicalMs: 2500 },
  freshness: { kind: 'snapshot', window: 'lifetime of the account', ageField: 'recency_days' },
  confidence: { tier: 'stated', basis: 'the buyer posted it himself — the only source that may produce a PREFILL fact chip at 0.9' },
  coverage: { pct: null, basis: 'not measured pipeline-wide; present in 3/3 captured fixtures' },
  fields: [
    { path: '[].product', what: 'requirement title (after cluster naming by authority)', consumedBy: ['buyer-brain:signal-pool', 'req-brain:resolver', 'req-brain:adapter', 'formAdapter:brainToSeed'] },
    { path: '[].status', what: 'approved / pending / open / expired', consumedBy: ['req-brain:resolver', 'req-brain:adapter', 'BrainFormGate:cards'] },
    { path: '[].recency_days', what: 'age of the post in days', consumedBy: ['req-brain:resolver', 'req-brain:evidence', 'BrainFormGate:cards'] },
    { path: '[].is_expired', what: 'lead expiry flag', consumedBy: ['req-brain:resolver', 'req-brain:adapter', 'BrainFormGate:cards'] },
    { path: '[].specs[].name', what: 'ISQ spec name the buyer answered', consumedBy: ['req-brain:evidence', 'formAdapter:brainToSeed'] },
    { path: '[].specs[].value', what: 'ISQ spec value the buyer answered', consumedBy: ['req-brain:evidence', 'formAdapter:brainToSeed'] },
    { path: '[].specs[].mandatory', what: 'was the spec mandatory on the original form', consumedBy: [], note: 'DEAD. The planner ranks gaps by the CATEGORY corpus pct and never by what this category actually forces a buyer to answer.' },
    { path: '[].specs[].priority', what: 'display priority of the spec', consumedBy: [], note: 'DEAD. Nothing orders the seeded chips by the buyer own form order.' },
    { path: '[].order_value', what: 'stated order value / budget', consumedBy: ['planner:bulk-b2b-gate'], note: 'DEAD-ENDED. buildEvidence emits it as a stated atom at 0.7 and the adapter turns it into a PREFILL decision — then formAdapter drops it on the /^(order_value|requirement_type|purchase_frequency|application|buyer_context)$/i skip-list and no surface renders it.' },
    { path: '[].category_name', what: 'catalogue category label of the post', consumedBy: [], note: 'DEAD. runCuratedPlanner receives categoryName from the McatDtl API (BrainRFQForm categoryNameRef), never from here — so the label the buyer actually posted under is discarded.' },
    { path: '[]._name_from', what: 'which signal source named the cluster', consumedBy: [], note: 'DEAD (debug-only). The v9 merge ledger added after a CSL search string outranked a posted requirement.' },
    { path: '[]._renamed_from', what: 'previous cluster title before an authority rename', consumedBy: [], note: 'DEAD (debug-only)' },
    { path: '[]._merged', what: 'the other product names folded into this cluster by overlap()', consumedBy: [], note: 'DEAD (debug-only) — this is the audit trail for the Sweet Packaging Tray ← Sweet Potatoes incident and nothing reads it, so a bad merge is still only findable by a human opening the raw dump.' },
    { path: '[].mcat', what: 'mcat id of the requirement', consumedBy: ['req-brain:planner', 'req-brain:relevance', 'req-brain:adapter', 'formAdapter:brainToSeed'], emitted: false, note: 'carried on the cluster and shipped via metadata.recommendations, but the node_raw.rfq projection omits it' },
    { path: '[].repostable', what: 'posted + expired ⇒ can be reposted', consumedBy: ['req-brain:adapter', 'req-brain:relevance', 'BrainFormGate:cards'], emitted: false },
    { path: '[].requirement_type', what: 'business / resale / wholesale / personal', consumedBy: ['req-brain:kyb', 'req-brain:scorer', 'req-brain:evidence'], emitted: false, note: 'decides the whole KYB/GST branch, yet is invisible in the debug dump' },
    { path: '[].purchase_frequency', what: 'one-time vs recurring', consumedBy: [], emitted: false, note: 'DEAD-ENDED. Becomes a stated evidence atom, then formAdapter skip-lists it — while the planner still spends a gap question asking "One-time order, or a recurring monthly need?".' },
    { path: '[].description', what: 'free-text description the buyer typed on the original post', consumedBy: [], emitted: false, note: 'DEAD. The buyer own prose about his own requirement, parsed and never read by anything.' },
    { path: '[].product_or_service', what: 'product vs service', consumedBy: [], emitted: false, note: 'DEAD' },
    { path: '[].posted', what: 'post date', consumedBy: [], emitted: false, note: 'DEAD (recency_days is used instead)' },
    { path: '[].expiry', what: 'expiry date', consumedBy: [], emitted: false, note: 'DEAD (is_expired is used instead)' },
    { path: '[].verified', what: 'lead verification flag', consumedBy: [], emitted: false, note: 'DEAD' },
    { path: '[].offer_id', what: 'source buylead id', consumedBy: [], emitted: false, note: 'DEAD — no decision can be traced back to the buylead it came from' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE — GLADMIN buyer profile + OD/GST. Mostly identity; mostly unread.
// ─────────────────────────────────────────────────────────────────────────────
const PROFILE: SourceContract = {
  source: 'profile',
  version: 'bp-call1 + od-fetch → buyer-brain parseBuyer()',
  owner: 'BI pipeline · buyer-profile branch',
  producedBy: ['BL profile', 'bp-call1', 'bp-fetch', 'od-fetch', 'buyer-brain:parseBuyer'],
  latency: { tier: 'fast', typicalMs: 1800 },
  freshness: { kind: 'snapshot', window: 'account lifetime', ageField: 'identity.member_since' },
  confidence: { tier: 'stated', basis: 'registration + KYB data the buyer supplied to IndiaMART, junk-filtered (JUNK_NAME/isJunk)' },
  coverage: { pct: null, basis: 'not measured pipeline-wide; present in 3/3 captured fixtures' },
  fields: [
    { path: 'identity.name', what: 'contact name', consumedBy: [], note: 'DEAD by design (PII never crosses into the seller-facing payload) — but then it should not be in node_raw either.' },
    { path: 'identity.mobile', what: 'mobile number', consumedBy: [], note: 'DEAD by design (PII)' },
    { path: 'identity.email', what: 'email', consumedBy: [], note: 'DEAD by design (PII)' },
    { path: 'identity.company', what: 'company name', consumedBy: [], note: 'DEAD. Not PII in the same sense — the company name is the single best clue to what the buyer does, and the planner is told to infer buyer_situation without it.' },
    { path: 'identity.designation', what: 'designation', consumedBy: [], note: 'DEAD' },
    { path: 'identity.member_since', what: 'account age', consumedBy: ['req-brain:adapter', 'formAdapter:brainToSeed', 'gemini:curated-planner'], note: 'reaches the planner prompt inside <buyer_facts>' },
    { path: 'identity.whatsapp_active', what: 'WhatsApp reachable', consumedBy: [], note: 'DEAD — even though the WhatsApp source itself is amber/empty for most buyers, so this is the cheap availability check nobody makes' },
    { path: 'identity.email_verified', what: 'email verified', consumedBy: [], note: 'DEAD' },
    { path: 'identity.website', what: 'buyer website', consumedBy: [], note: 'DEAD' },
    { path: 'location.city', what: 'registered city', consumedBy: ['req-brain:evidence', 'req-brain:adapter', 'gemini:curated-planner'], note: 'the "registered" half of the delivery_city A/B' },
    { path: 'location.state', what: 'registered state', consumedBy: ['req-brain:adapter', 'gemini:curated-planner'] },
    { path: 'location.district', what: 'district', consumedBy: [], note: 'DEAD' },
    { path: 'location.pincode', what: 'pincode', consumedBy: [], note: 'DEAD. The form asks the buyer for a delivery pincode it already holds.' },
    { path: 'location.address', what: 'full address', consumedBy: [], note: 'DEAD' },
    { path: 'location.country_iso', what: 'country', consumedBy: [], note: 'DEAD' },
    { path: 'business.type', what: 'business type', consumedBy: ['req-brain:adapter', 'gemini:curated-planner'], note: 'buyer_facts.business_type' },
    { path: 'business.nature_of_business', what: 'GST nature of business', consumedBy: ['req-brain:adapter', 'gemini:curated-planner'], note: 'fallback for business_type' },
    { path: 'business.turnover', what: 'annual turnover band', consumedBy: ['planner:bulk-b2b-gate'], note: 'DEAD. Order-size sanity, budget banding and B2B/B2C judgement all guess without it.' },
    { path: 'kyb.gst', what: 'GSTIN', consumedBy: ['req-brain:evidence', 'req-brain:kyb', 'req-brain:adapter'] },
    { path: 'kyb.gst_verified', what: 'GST verified flag', consumedBy: ['req-brain:evidence', 'req-brain:kyb', 'req-brain:adapter', 'formAdapter:brainToSeed'], note: 'suppresses the identity gap question' },
    { path: 'kyb.pan', what: 'PAN', consumedBy: [], note: 'DEAD' },
    { path: 'kyb.legal_status', what: 'proprietorship / pvt ltd / …', consumedBy: ['planner:bulk-b2b-gate'], note: 'DEAD. Legal status is a direct read on B2B-ness and the planner is left to infer it from the category.' },
    { path: 'kyb.registration_year', what: 'GST registration year', consumedBy: ['planner:bulk-b2b-gate'], note: 'DEAD' },
    { path: 'kyb.nature_secondary', what: 'secondary nature of business', consumedBy: [], note: 'DEAD' },
    { path: 'activity.total_requirements', what: 'lifetime requirement count', consumedBy: ['req-brain:adapter', 'gemini:curated-planner'] },
    { path: 'activity.total_calls', what: 'lifetime calls', consumedBy: ['req-brain:scorer', 'req-brain:adapter', 'gemini:curated-planner'] },
    { path: 'activity.enquiries', what: 'enquiries sent', consumedBy: ['req-brain:scorer'] },
    { path: 'activity.call_backs', what: 'callbacks requested', consumedBy: ['req-brain:scorer'] },
    { path: 'activity.past_requirements', what: 'past requirement count', consumedBy: [], note: 'DEAD' },
    { path: 'activity.enquiry_replies', what: 'replies to enquiries', consumedBy: [], note: 'DEAD — responsiveness is never scored' },
    { path: 'activity.pns_calls', what: 'PNS call count', consumedBy: [], note: 'DEAD' },
    { path: 'activity.buy_replies', what: 'buy replies', consumedBy: [], note: 'DEAD' },
    { path: 'rating', what: 'avg + count of ratings the buyer gave', consumedBy: [], note: 'DEAD (both sub-keys)' },
    { path: 'seller_status', what: 'listing_status · is_paid · custtype_weight · trustseal', consumedBy: [], note: 'DEAD (all four sub-keys)' },
    { path: 'seller_context', what: 'product_sold · fcp_flag · custtype_name — i.e. THIS BUYER IS ALSO A PAID SELLER', consumedBy: ['planner:bulk-b2b-gate'], sinceVersion: 'requirement-brain v8', note: 'THE named incident. Parsed by buyer-brain, then dropped by the node_raw output whitelist so only the opaque custtype_weight survived. v8 re-emitted it — and it STILL has zero consumers, so a buyer who is a paid seller is treated exactly like a cold buyer.' },
    { path: 'products_of_interest', what: 'mcats on the buyer profile (name/mcat_id/image)', consumedBy: ['buyer-brain:signal-pool', 'req-brain:adapter', 'BrainFormGate:suggester'], note: 'weakest signal (NAME_RANK 1) but live' },
    { path: 'interests.browse_interest', what: 'buyer_search_browse_interest string', consumedBy: [], emitted: false, note: 'DEAD and invisible — parsed by parseBuyer, dropped by the whitelist' },
    { path: 'verified_business_buyer', what: 'verified-business-buyer flag', consumedBy: [], emitted: false, note: 'DEAD and invisible — parsed by parseBuyer, dropped by the whitelist' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// CALLS — PNS/VANI recordings, LLM-transcribed. The only source where the buyer SPEAKS.
// ─────────────────────────────────────────────────────────────────────────────
const CALLS: SourceContract = {
  source: 'calls',
  version: 'assemble-rfq1.summary (pns-transcribe1 + vani-transcribe1 + pns-insights-api1)',
  owner: 'BI pipeline · calls branch',
  producedBy: ['calls-call', 'redash-pns-', 'redash-vani-', 'pns-insights-api1', 'pns-transcribe1', 'vani-transcribe1', 'assemble-rfq1'],
  latency: { tier: 'slow', typicalMs: 90000, note: '?pns=api skips transcription (~fast); ?pns=full runs Gemini audio over every recording and dominates the 150s timeout' },
  freshness: { kind: 'transcript', window: 'recent analysed calls only', ageField: null },
  confidence: { tier: 'stated', basis: 'the buyer said it out loud — but LLM-extracted, so free-text fields carry garbled extractions (isNoiseSpec/META_FIELD exists for exactly this)' },
  coverage: { pct: null, basis: 'not measured pipeline-wide; 2/3 fixtures have calls, 1/3 is amber-empty' },
  fields: [
    { path: 'coverage', what: '9 counters: pns_in_redash · vani_in_redash · pns_from_api · *_llm_extracted · *_no_audio · pns_skipped_api_dup · pns_api_error', consumedBy: [], note: 'DEAD. Pure pipeline telemetry — and the one place a silent transcription failure would show up, which nothing checks.' },
    { path: 'buyer.name', what: 'name as heard on the call', consumedBy: [], note: 'DEAD (PII)' },
    { path: 'buyer.mobile', what: 'number as heard on the call', consumedBy: [], note: 'DEAD (PII)' },
    { path: 'buyer.city', what: 'city the buyer stated on the call', consumedBy: [], note: 'DEAD — and this is a STATED city, which would outrank both the browsing city and the registered city in the delivery_city A/B if anything read it.' },
    { path: 'buyer.state', what: 'state stated on the call', consumedBy: [], note: 'DEAD' },
    { path: 'buyer.b2b_b2c', what: 'B2B/B2C read for THIS buyer from his own call', consumedBy: ['planner:bulk-b2b-gate'], note: 'DEAD — while category.b2b_b2c (a corpus average) IS passed to the planner. The per-buyer truth loses to the category average.' },
    { path: 'buyer.persona', what: 'persona for THIS buyer from his own call', consumedBy: ['planner:bulk-b2b-gate'], note: 'DEAD — same inversion as b2b_b2c: category.personas is passed, the buyer own persona is not.' },
    { path: 'requirement.products[].name', what: 'product the buyer asked a seller about, by name', consumedBy: [], note: 'DEAD. buyer-brain pools csl/rfq/profile/whatsapp into clusters; calls arrive one level later at requirement-brain, so a product the buyer SPOKE about can never become (or rename) a requirement cluster.' },
    { path: 'requirement.products[].source', what: 'which call the product came from', consumedBy: [], note: 'DEAD' },
    { path: 'requirement.products[].quantity', what: 'quantity the buyer said out loud', consumedBy: [], note: 'DEAD. A stated quantity, dropped — while the form still asks for quantity.' },
    { path: 'requirement.products[].price', what: 'price discussed', consumedBy: [], note: 'DEAD' },
    { path: 'requirement.products[].specs[].name', what: 'spec name from the call', consumedBy: ['req-brain:reconcile', 'formAdapter:buyerSignals', 'gemini:curated-planner'] },
    { path: 'requirement.products[].specs[].value', what: 'spec value from the call', consumedBy: ['req-brain:reconcile', 'formAdapter:buyerSignals', 'gemini:curated-planner'] },
    { path: 'requirement.products[].specs[].unit', what: 'unit of the spec value', consumedBy: ['req-brain:reconcile'], note: 'concatenated onto the value in the CARRYOVER conflict pool only' },
    { path: 'requirement.intent_level', what: 'intent as read from the conversation', consumedBy: [], note: 'DEAD. score() rebuilds intent from click/call funnel counters and ignores the read taken from the buyer own voice.' },
    { path: 'requirement.intended_application', what: 'the use-case the buyer described on the call', consumedBy: ['req-brain:evidence', 'formAdapter:buyerSignals', 'gemini:curated-planner'], note: 'the `buyer_context` global evidence atom — was itself dead until the GLOBAL_FIELDS fix in adapt()' },
    { path: 'requirement.buyer_queries', what: 'the questions the buyer asked the seller, verbatim', consumedBy: ['formAdapter:buyerSignals', 'gemini:curated-planner'] },
    { path: 'seller_engagement.outcomes', what: 'call outcomes (Follow-up, …)', consumedBy: [], note: 'DEAD' },
    { path: 'seller_engagement.deal_readiness', what: 'how close the deal was', consumedBy: [], note: 'DEAD — a direct read on intent, unused by score()' },
    { path: 'seller_engagement.next_steps', what: 'agreed next steps', consumedBy: [], note: 'DEAD' },
    { path: 'seller_engagement.callbacks', what: 'promised callbacks with timing', consumedBy: [], note: 'DEAD — an explicit, dated commitment from the buyer, unread' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP — two channels; only sender=user turns are buyer intent (see the channel model).
// ─────────────────────────────────────────────────────────────────────────────
const WHATSAPP: SourceContract = {
  source: 'whatsapp',
  version: 'whatsapp1 → buyer.whatsapp (buyer-brain projection)',
  owner: 'BI pipeline · WhatsApp branch',
  producedBy: ['wa-call1', 'whatsapp-inbound1', 'whatsapp-conversations', 'whatsapp1'],
  latency: { tier: 'fast', typicalMs: 3000 },
  freshness: { kind: 'event_log', window: 'conversation history', ageField: 'products_enquired_dated' },
  confidence: { tier: 'stated', basis: 'buyer-typed turns only (sender=user); bot/api turns are our own messages and are context, not intent' },
  coverage: { pct: null, basis: 'amber/empty in 3/3 captured fixtures — the least-covered source in the bundle' },
  fields: [
    { path: 'products_enquired', what: 'products the buyer asked about on WhatsApp', consumedBy: ['buyer-brain:signal-pool', 'formAdapter:buyerSignals', 'req-brain:node-health', 'gemini:curated-planner'] },
    { path: 'products_enquired_dated', what: 'timestamp per enquired product', consumedBy: ['buyer-brain:signal-age'], emitted: false, note: 'read from the wa summary for ageing, not re-emitted into node_raw.whatsapp' },
    { path: 'buyer_typed_enquiries', what: 'structured specs the buyer TYPED (e.g. {product, gsm})', consumedBy: ['formAdapter:buyerSignals', 'gemini:curated-planner'] },
    { path: 'objections', what: '"too far" / "high price" / "no response"', consumedBy: ['formAdapter:buyerSignals', 'gemini:curated-planner'], note: 'the planner is instructed to reframe one gap around the most relevant objection' },
    { path: 'explicit_business_intent', what: 'reselling / wholesale / distribution statements', consumedBy: ['formAdapter:buyerSignals', 'gemini:curated-planner'], note: 'flips the identity/GST ask' },
    { path: 'buyer_turns', what: 'how many messages the buyer sent', consumedBy: [], note: 'DEAD' },
    { path: 'responsive', what: 'does the buyer reply', consumedBy: [], note: 'DEAD' },
    { path: 'button_taps', what: 'quick-reply buttons tapped', consumedBy: [], note: 'DEAD — a tap is a stated answer and it is thrown away' },
    { path: 'campaigns_received', what: 'campaigns sent to the buyer', consumedBy: [], note: 'DEAD' },
    { path: 'campaigns_responded', what: 'campaigns the buyer answered', consumedBy: [], note: 'DEAD' },
    { path: 'response_rate', what: 'reply rate', consumedBy: [], note: 'DEAD' },
    { path: 'images_requested', what: 'the buyer asked for photos', consumedBy: [], note: 'DEAD' },
    { path: 'supplier_feedback_given', what: 'the buyer rated a supplier', consumedBy: [], note: 'DEAD' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY — corpus-level, NOT about this buyer. Inferred tier, always.
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY: SourceContract = {
  source: 'category',
  version: 'category-brain1 (+ getISQ substitution, requirement-brain v8) · top_specs_source v11',
  owner: 'BI pipeline · category branch',
  producedBy: ['cat-call', 'redash-', 'category-brain1', 'getisq-from-mcat1'],
  latency: { tier: 'fast', typicalMs: 5000, note: 'one Redash corpus query per mcat' },
  freshness: { kind: 'corpus', window: 'all analysed seller calls for the mcat', ageField: null },
  confidence: { tier: 'inferred', basis: 'a corpus average over OTHER buyers — may only ever produce a SUGGEST ghost chip, never a fact' },
  coverage: { pct: null, basis: 'present 3/3 in fixtures, but planner_gate=no_brain in 1/3 — an empty brain is common enough that v8 added the getISQ fallback' },
  fields: [
    { path: 'mcat_id', what: 'the mcat this brain is for', consumedBy: ['req-brain:planner', 'req-brain:adapter'], note: 'the planner matches it against the primary requirement mcat' },
    { path: 'calls', what: 'how many seller calls were analysed', consumedBy: ['req-brain:node-health'], note: 'DEAD for decisions — only the debug dot reads it, so a brain built from 3 calls and one built from 3000 are indistinguishable to the planner AND to the LLM prompt.' },
    { path: 'b2b_b2c', what: 'B2B/B2C split of the category', consumedBy: ['req-brain:adapter', 'formAdapter:brainToSeed', 'gemini:curated-planner'], note: 'reaches the prompt as <category_b2b_b2c>' },
    { path: 'personas', what: 'buyer types this category serves', consumedBy: ['req-brain:adapter', 'formAdapter:brainToSeed', 'gemini:curated-planner'], note: 'reaches the prompt as <category_personas>' },
    { path: 'keywords', what: 'category vocabulary', consumedBy: ['req-brain:adapter', 'formAdapter:brainToSeed', 'gemini:curated-planner'] },
    { path: 'top_specs[].q', what: 'the question sellers actually ask', consumedBy: ['req-brain:planner', 'formAdapter:brainToSeed', 'gemini:curated-planner'] },
    { path: 'top_specs[].pct', what: 'share of analysed calls that asked it', consumedBy: ['req-brain:planner', 'formAdapter:brainToSeed', 'gemini:curated-planner'], note: 'planner gate is pct>=30; formAdapter clamps to <=100 because 39% of categories report >100 (the corpus counts spec occurrences across products)' },
    { path: 'top_specs[].vals', what: 'real answers real buyers gave — the option chips', consumedBy: ['req-brain:planner', 'formAdapter:brainToSeed', 'gemini:curated-planner'] },
    { path: 'top_specs_source', what: "'getisq' when the rows are a getISQ substitution rather than call-derived", consumedBy: [], sinceVersion: 'v11', note: 'DEAD. Added in v11 for exactly one reason — so downstream could tell a real call-derived brain from the getISQ fallback — and nothing downstream reads it. The planner still tells the LLM "asked in X% of this category seller calls" for rows that were never on a call.' },
    { path: 'calls_analyzed', what: 'duplicate of `calls` in the node_raw projection', consumedBy: [], note: 'DEAD (duplicate field)' },
    { path: 'top_products', what: 'top products in the category corpus', consumedBy: [], emitted: false, note: 'DEAD and invisible — parsed in the requirement-brain entry block, never emitted, never read' },
  ],
};

export const SOURCE_CONTRACTS: Record<SourceId, SourceContract> = {
  csl: CSL, rfq: RFQ, profile: PROFILE, calls: CALLS, whatsapp: WHATSAPP, category: CATEGORY,
};

// ─── runtime validation ──────────────────────────────────────────────────────

export interface FacetReport {
  source: SourceId;
  path: string;
  /** the facet's key exists in this payload (even if the value is empty) */
  present: boolean;
  /** the parser produced a non-empty value — i.e. real work happened */
  parsed: boolean;
  /** LIVE consumers only. Empty = parsed-then-dropped. */
  consumedBy: ConsumerId[];
  /** consumers that exist but do not keep the facet alive (debug dumps, health dots) */
  inertConsumers: ConsumerId[];
  /** zero live consumers */
  dead: boolean;
  /** parsed AND dead — real work, thrown away. The strongest form of the finding. */
  wasted: boolean;
  /** declared but never emitted into node_raw at all */
  emitted: boolean;
  note?: string;
}

export interface SourceReport {
  source: SourceId;
  present: boolean;
  facets: FacetReport[];
  /** observed coverage for THIS payload: parsed facets / emitted facets */
  observedCoverage: number;
  declaredCoverage: number | null;
}

export interface ContractReport {
  glid: string;
  engine: string;
  sources: SourceReport[];
  facets: FacetReport[];
  /** every facet with zero live consumers */
  dead: FacetReport[];
  /** dead AND non-empty in this payload */
  wasted: FacetReport[];
  /** declared emitted:true but absent from this payload */
  absent: FacetReport[];
}

/** Emptiness, defined the same way the pipeline itself defines it (buyer-brain's `V()` helper):
 *  null/undefined, blank string, the string "0" or the number 0, an empty array or empty object. */
const isEmpty = (v: unknown): boolean =>
  v == null || v === 0 || v === '0'
  || (typeof v === 'string' && !v.trim())
  || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Walk a dot path with `[]` array hops. Returns every value the path reaches, plus whether the
 *  final key existed on at least one container. */
function resolvePath(root: unknown, path: string): { present: boolean; values: unknown[] } {
  let containers: unknown[] = [root];
  let present = false;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    const isArrayHop = raw.endsWith('[]');
    const key = isArrayHop ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const c of containers) {
      if (c == null) continue;
      let v: unknown;
      if (key === '') {
        v = c;                                  // leading "[]" — the source itself is an array
      } else if (typeof c === 'object' && key in (c as Record<string, unknown>)) {
        v = (c as Record<string, unknown>)[key];
        if (i === parts.length - 1) present = true;
      } else {
        continue;
      }
      if (i === parts.length - 1) { next.push(v); continue; }
      if (isArrayHop) { for (const e of Array.isArray(v) ? v : []) next.push(e); }
      else next.push(v);
    }
    // a trailing "[]" on the LAST part means "the array itself", already pushed above
    containers = next;
  }
  return { present, values: containers };
}

/**
 * Check a live (or fixture) engine payload against the declared contracts.
 * Returns per-facet `{present, parsed, consumedBy[]}` so that a facet with zero consumers is a
 * machine-detectable finding instead of something a human has to notice in a JSON dump.
 */
export function validateSourceContract(payload: unknown): ContractReport {
  const p = (payload ?? {}) as Partial<RequirementBrainPayload>;
  const nodeRaw = (p.observability?.node_raw ?? {}) as Record<string, unknown>;
  const sources: SourceReport[] = [];
  const all: FacetReport[] = [];

  for (const id of SOURCE_IDS) {
    const contract = SOURCE_CONTRACTS[id];
    const raw = nodeRaw[id];
    const srcPresent = raw != null;
    const reports: FacetReport[] = contract.fields.map((f) => {
      const live = f.consumedBy.filter((c) => LIVE_KINDS.includes(CONSUMERS[c].kind));
      const inert = f.consumedBy.filter((c) => !LIVE_KINDS.includes(CONSUMERS[c].kind));
      const emitted = f.emitted !== false;
      // an array source (rfq) is addressed with a leading "[]." hop
      const { present, values } = srcPresent && emitted ? resolvePath(raw, f.path) : { present: false, values: [] };
      const parsed = values.some((v) => !isEmpty(v));
      const dead = live.length === 0;
      return {
        source: id, path: f.path, present, parsed,
        consumedBy: live, inertConsumers: inert, dead, wasted: dead && parsed, emitted, note: f.note,
      };
    });
    const emittedFacets = reports.filter((r) => r.emitted);
    sources.push({
      source: id, present: srcPresent, facets: reports,
      observedCoverage: emittedFacets.length ? reports.filter((r) => r.parsed).length / emittedFacets.length : 0,
      declaredCoverage: contract.coverage.pct,
    });
    all.push(...reports);
  }

  return {
    glid: String(p.metadata?.glid ?? ''),
    engine: String(p.metadata?.versions?.brain ?? 'unknown'),
    sources,
    facets: all,
    dead: all.filter((f) => f.dead),
    wasted: all.filter((f) => f.wasted),
    absent: all.filter((f) => f.emitted && !f.present),
  };
}

/** Stable `source:path` key — what the dead-facet allow-list is keyed on. */
export const facetKey = (f: { source: SourceId; path: string }): string => `${f.source}:${f.path}`;
