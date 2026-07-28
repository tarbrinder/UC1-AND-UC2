// ─── The Consumption Ladder ───────────────────────────────────────────────────
// An INSTRUMENT, not a report. Every data-consumption bug this codebase has shipped was found by hand,
// and every one of them was the same disease at a different rung:
//
//    Received → Parsed → Planner Saw → Planner Used → Decision → Rendered → Submitted → Seller Saw
//
//   · parsed and then dropped          — seller_context, category_isq, search frequency, CSL timestamps
//   · accepted and never passed        — category_personas / category_b2b_b2c sat in BrainSeed unused
//   · decided and never rendered       — engine ASK / SUGGEST / RESOLVE_CONFLICT / OFFER
//   · health green on empty extraction — a node "succeeded" while returning nothing usable
//
// This module walks every source-facet up the ladder and reports where it stops, so the NEXT one of
// these is found by the panel instead of by a human reading n8n JSON at midnight.
//
// HONESTY RULES (non-negotiable — this instrument is worthless the moment it flatters us):
//   1. A stage that cannot be computed is 'unknown' (?). Never 'yes', and never 'no'. Absence of
//      evidence is not evidence of absence.
//   2. Submitted / Seller Saw are 'unverified' for EVERY facet. There is no per-field record of the
//      submitted RFQ in this client and no seller-side telemetry at all. We do not guess them.
//   3. Anything derived from a heuristic rather than an accounting record is flagged `soft` and the
//      panel renders it with a ~ so it can never be mistaken for a ledger fact.
import type { RequirementBrainPayload, Decision, EvidenceAtom } from './brains/requirementBrain';

// ── Stages ───────────────────────────────────────────────────────────────────
export const STAGES = ['received', 'parsed', 'saw', 'used', 'decision', 'rendered', 'submitted', 'seller'] as const;
export type StageKey = (typeof STAGES)[number];

export const STAGE_META: { key: StageKey; abbr: string; name: string; how: string }[] = [
  { key: 'received', abbr: 'Rc', name: 'Received', how: 'the source node answered — observability.node_health status + row count.' },
  { key: 'parsed', abbr: 'Pa', name: 'Parsed', how: 'this facet exists with REAL content in observability.node_raw. An empty array, a null, or a truthy-but-empty dict is NOT parsed.' },
  { key: 'saw', abbr: 'Sa', name: 'Planner saw', how: 'the facet arrived inside its XML block in the curated-planner USER message. A block rendering "(none)", or no block existing at all in the prompt, means NOT seen.' },
  { key: 'used', abbr: 'Us', name: 'Planner used', how: 'the planner named this input in considered[].from_source, or a prefills[].source traces back to it.' },
  { key: 'decision', abbr: 'De', name: 'Decision', how: 'the facet produced a decision — an evidence atom of its that a decision cites, a planner candidate that shipped as "asked", or a surviving prefill.' },
  { key: 'rendered', abbr: 'Re', name: 'Rendered', how: 'HEURISTIC. Checked against the render map below — which decision actions the form actually reads out of BrainSeed, not which ones it theoretically could.' },
  { key: 'submitted', abbr: 'Su', name: 'Submitted', how: 'UNVERIFIED for every facet. Nothing in this client records WHICH values left in the submitted RFQ (BES records only that a submit happened, and when).' },
  { key: 'seller', abbr: 'Se', name: 'Seller saw', how: 'UNVERIFIED for every facet. No seller-side telemetry reaches this client.' },
];

export type Mark = 'yes' | 'no' | 'na' | 'unknown' | 'unverified';
export interface Cell {
  mark: Mark;
  n?: number;          // count where meaningful (rows parsed, atoms used, questions shipped)
  of?: number;         // when the facet has named sub-fields: n of `of` survived this stage
  why: string;         // rendered as the cell tooltip AND in the expanded row — always populated
  soft?: boolean;      // derived from a heuristic, not from an accounting record → panel shows ~
}
export interface FacetLadder {
  id: string; node: string | null; label: string; note?: string;
  stages: Record<StageKey, Cell>;
  carriedData: boolean;    // Parsed === yes — the denominator for the KPI
  diesAt: StageKey | null; // first PROVEN break (a definite 'no') at or before Decision
  /** THE BRIDGE. node_raw is a debug channel; the form adapter builds the planner's input from
   *  `metadata.*`. When a facet is rich in node_raw and empty in the metadata slot the adapter reads,
   *  the signal is dead on arrival — provable OFFLINE, before any planner call, and invisible in the
   *  stage columns (Parsed is a legitimate ✓ and Planner-saw needs a live run). This is how
   *  `metadata.category = null` silently starved <category_personas> and <category_b2b_b2c>. */
  bridge?: { via: string; ok: boolean; why: string };
}
export interface LadderReport {
  facets: FacetLadder[];
  m: number;                       // facets that carried real data
  dying: FacetLadder[];            // carried data, proven break before/at Decision
  unverifiable: FacetLadder[];     // carried data, no proven break, but Decision not provable either
  reachedDecision: FacetLadder[];
  notRendered: FacetLadder[];      // reached a decision and then died at Rendered
  brokenBridges: FacetLadder[];    // parsed in node_raw, empty in the metadata slot the adapter reads
  plannerRun: boolean;             // was a curated-planner call captured this session?
  hasEvidenceDict: boolean;
}

// ── The curated-planner's XML block list ─────────────────────────────────────
// Mirrors the `blk(...)` list in runCuratedPlanner (gemini.ts). A facet whose `block` is null has NO
// CHANNEL into the planner at all — that is an architectural ✗, provable without a live run, and it is
// the single most valuable thing this table reports.
// The blocks runCuratedPlanner ACTUALLY fences into its user turn. This list is asserted against the real
// prompt by src/lib/__tests__/plannerBlocks.test.ts — it declared 13 while 19 were being sent, and the six
// it missed (engine_decisions, buyer_business, buyer_persona, context_facts, bulk_b2b_gate,
// relocatable_last_page_fields) are the newest and most load-bearing. A hand-kept mirror of a moving list is
// the exact rot this instrument exists to detect, so the test now fails if they diverge again.
export const PLANNER_BLOCKS = [
  'requirement', 'category_name', 'flow', 'already_known', 'engine_decisions', 'page1_buyer_specs',
  'seller_flagged_specs', 'seller_top_questions', 'category_personas', 'category_b2b_b2c', 'buyer_facts',
  'also_sourcing', 'buyer_signals', 'buyer_business', 'buyer_persona', 'context_facts', 'bulk_b2b_gate',
  'relocatable_last_page_fields', 'category_corpus',
] as const;

// ── The RENDER MAP (heuristic — the honest kind: read off the code, and dated) ─────────────────────
// STATIC FALLBACK, verified 2026-07-28 against BrainRFQForm's `_seed.*` reads. brainToSeed BUILDS `gaps`
// and `conflicts` and the form reads NEITHER; SUGGEST and OFFER never enter the seed at all. So only
// PREFILL/CONFIRM survive to a control.
//
// A hard-coded map is exactly the thing that rots, and this instrument exists to catch rot — so the
// surface that renders decisions can OVERRIDE it at runtime with the truth:
//
//     registerRenderedActions('BrainRFQForm', { ASK: 'page-2 smart-question chips', ... })
//
// Anything registered wins, and the cell reason says which basis was used. Nothing is imported from a
// form here (the panel must stay usable on any surface) — registration is a one-line push from theirs.
export const ENGINE_RENDER_MAP: Record<string, { rendered: boolean; where: string }> = {
  PREFILL: { rendered: true, where: 'BrainSeed.specValues / quantity / unit / deliveryLocation → spec chips' },
  CONFIRM: { rendered: true, where: 'BrainSeed.observedFields → badged "from a product you viewed" chip' },
  ASK: { rendered: false, where: 'BrainSeed.gaps — built by the adapter, never read by BrainRFQForm' },
  RESOLVE_CONFLICT: { rendered: false, where: 'BrainSeed.conflicts — built by the adapter, never read by BrainRFQForm' },
  SUGGEST: { rendered: false, where: 'never enters BrainSeed at all' },
  OFFER: { rendered: false, where: 'never enters BrainSeed at all' },
  SUPPRESS: { rendered: false, where: 'firewall — dropped by design, not a defect' },
};
const REGISTERED: Record<string, { rendered: boolean; where: string }> = {};
let registeredBy = '';
/** A rendering surface declares which engine decision actions it ACTUALLY reads, and into what control.
 *  `where` is the control; omit an action to declare it unrendered. Overrides the dated static map. */
export function registerRenderedActions(surface: string, map: Record<string, string>): void {
  registeredBy = surface;
  for (const k of Object.keys(ENGINE_RENDER_MAP)) REGISTERED[k] = { rendered: false, where: `not read by ${surface}` };
  for (const [action, where] of Object.entries(map)) REGISTERED[action] = { rendered: true, where };
}
export const renderBasis = (): string =>
  registeredBy ? `registered live by ${registeredBy}` : 'static map read off BrainRFQForm on 2026-07-28 — no surface has registered a live one, so it can rot';
const renderOf = (action: string) => (registeredBy ? REGISTERED[action] : ENGINE_RENDER_MAP[action]);

// ── Facet catalogue ──────────────────────────────────────────────────────────
interface FacetSpec {
  id: string;
  node: string | null;                 // node_health / node_raw key; null ⇒ not carried in the brain payload
  label: string;
  path?: string[];                     // path inside node_raw[node]
  arrayItemPath?: string[];            // node_raw[node] is an array ⇒ flatten this path out of every item
  metaPath?: string[];                 // the metadata slot the form adapter reads to build the planner input
  metaWhy?: string;                    // what the adapter does with it
  keys?: string[];                     // sub-fields we expect to survive — drives the "k of n fields" count
  keyAlias?: Record<string, string>;   // rename between the source and the planner block
  block: string | null;                // planner XML block; null ⇒ the prompt has no channel for it
  blockKey?: string;                   // sub-key inside <buyer_signals>
  fromSource?: string[];               // planner considered[].from_source tokens
  prefillSource?: RegExp;              // planner prefills[].source phrasing
  evSource?: RegExp;                   // evidence atom .source match
  prov?: RegExp;                       // decisions[].reason provenance phrase (heuristic)
  naFrom?: StageKey;                   // legitimately n/a from this stage on
  naWhy?: string;
  note?: string;
}

const WA = /discussed_wa|whatsapp/i;
const CALL = /\bcall|pns|vani/i;
const PROF = /profile|kyb|gst|identity|interested/i;
const CAT = /categor/i;

export const FACETS: FacetSpec[] = [
  // ── CSL · what the buyer browsed ──
  { id: 'csl.searches', node: 'csl', label: 'recent searches', path: ['searches'], block: null,
    metaPath: ['buyer_memory', 'recent_searches'], metaWhy: 'the only metadata slot carrying searches',
    evSource: /search/i, prov: /you searched|your search/i,
    note: 'lands in metadata.buyer_memory.recent_searches and stops there — no planner block carries it, and the entries hold no timestamp, so search FREQUENCY is unrecoverable downstream.' },
  { id: 'csl.viewed', node: 'csl', label: 'products viewed', path: ['viewed'], block: null,
    metaPath: ['buyer_memory', 'viewed'], metaWhy: 'the only metadata slot carrying viewed products',
    evSource: /viewed/i, prov: /you viewed|product you viewed|your browsing/i },
  { id: 'csl.seller_intent', node: 'csl', label: 'seller context (suppliers · comparisons · contacted)', path: ['seller_intent'],
    keys: ['suppliers_viewed', 'profile_visits', 'comparisons', 'contacted'], block: null,
    evSource: /interested|supplier|compar/i,
    note: 'the "seller_context" the audit found parsed-then-dropped. Its counters are summarised into metadata.intent.why as a string; no structured consumer reads it.' },

  // ── RFQ · what the buyer posted ──
  { id: 'rfq.requirements', node: 'rfq', label: 'posted requirements', block: 'also_sourcing',
    metaPath: ['recommendations'], metaWhy: 'brainToSeed builds `basket` (→ <also_sourcing>) from metadata.recommendations, never from node_raw.rfq',
    fromSource: ['also_sourcing'], prefillSource: /also sourcing|also_sourcing/i,
    prov: /also sourcing|other active needs/i },
  { id: 'rfq.specs', node: 'rfq', label: 'specs on those requirements', arrayItemPath: ['specs'], block: 'already_known',
    fromSource: ['already_known'], prefillSource: /last requirement|posted/i,
    evSource: /posted/i, prov: /posted requirement|your last requirement/i },

  // ── Profile · who the buyer is ──
  { id: 'profile.identity', node: 'profile', label: 'identity', path: ['identity'],
    keys: ['name', 'mobile', 'email', 'company', 'member_since', 'whatsapp_active', 'email_verified', 'website'],
    metaPath: ['buyer_facts'], metaWhy: 'brainToSeed passes metadata.buyer_facts straight through as <buyer_facts>',
    block: 'buyer_facts', fromSource: ['buyer_facts'], evSource: PROF },
  { id: 'profile.location', node: 'profile', label: 'location', path: ['location'],
    keys: ['city', 'district', 'state', 'pincode', 'address', 'country_iso'],
    metaPath: ['buyer_facts'], metaWhy: 'brainToSeed passes metadata.buyer_facts straight through as <buyer_facts>',
    block: 'buyer_facts', fromSource: ['buyer_facts'], evSource: PROF },
  { id: 'profile.business', node: 'profile', label: 'business', path: ['business'],
    keys: ['turnover', 'nature_of_business'], keyAlias: { nature_of_business: 'business_type' },
    metaPath: ['buyer_facts'], metaWhy: 'brainToSeed passes metadata.buyer_facts straight through as <buyer_facts>',
    block: 'buyer_facts', fromSource: ['buyer_facts'], evSource: PROF },
  { id: 'profile.kyb', node: 'profile', label: 'KYB / GST', path: ['kyb'],
    keys: ['gst', 'pan', 'gst_verified', 'legal_status', 'registration_year', 'nature_secondary'],
    keyAlias: { gst: 'has_gst' },
    metaPath: ['buyer_facts'], metaWhy: 'brainToSeed passes metadata.buyer_facts straight through as <buyer_facts>',
    block: 'buyer_facts', fromSource: ['buyer_facts'], evSource: PROF, prov: /gst|kyb|verified business/i },
  { id: 'profile.activity', node: 'profile', label: 'activity counters', path: ['activity'],
    keys: ['total_requirements', 'past_requirements', 'enquiries', 'enquiry_replies', 'total_calls', 'pns_calls', 'call_backs', 'buy_replies'],
    metaPath: ['buyer_facts'], metaWhy: 'brainToSeed passes metadata.buyer_facts straight through as <buyer_facts>',
    block: 'buyer_facts', fromSource: ['buyer_facts'], evSource: PROF },

  // ── WhatsApp · the buyer's own words, channel 1 ──
  { id: 'wa.products', node: 'whatsapp', label: 'products enquired', path: ['products_enquired'],
    block: 'buyer_signals', blockKey: 'whatsapp_products', fromSource: ['buyer_signals.whatsapp_products'],
    prefillSource: /whatsapp/i, evSource: WA, prov: /whatsapp/i },
  { id: 'wa.typed_specs', node: 'whatsapp', label: 'specs he typed', path: ['buyer_typed_enquiries'],
    block: 'buyer_signals', blockKey: 'whatsapp_specs', fromSource: ['buyer_signals.whatsapp_specs'],
    prefillSource: /whatsapp/i, evSource: WA, prov: /whatsapp/i },
  { id: 'wa.objections', node: 'whatsapp', label: 'objections', path: ['objections'],
    block: 'buyer_signals', blockKey: 'objections', fromSource: ['buyer_signals.objections'], evSource: WA },
  { id: 'wa.business_intent', node: 'whatsapp', label: 'business intent', path: ['explicit_business_intent'],
    block: 'buyer_signals', blockKey: 'business_intent', fromSource: ['buyer_signals.business_intent'], evSource: WA },

  // ── Calls · the buyer's own words, channel 2 ──
  { id: 'calls.products', node: 'calls', label: 'products + specs said on calls', path: ['requirement', 'products'],
    keys: ['name', 'specs', 'quantity', 'price'], keyAlias: { specs: 'call_specs' },
    block: 'buyer_signals', blockKey: 'call_specs', fromSource: ['buyer_signals.call_specs'],
    prefillSource: /call/i, evSource: CALL, prov: /call with a seller|on a call|seller call/i,
    note: 'the adapter lifts only the SPECS out of each call product — the product name, quantity and price are read, then dropped.' },
  { id: 'calls.queries', node: 'calls', label: 'what he asked sellers', path: ['requirement', 'buyer_queries'],
    block: 'buyer_signals', blockKey: 'call_queries', fromSource: ['buyer_signals.call_queries'], evSource: CALL },
  { id: 'calls.application', node: 'calls', label: 'use-case he said out loud', path: ['requirement', 'intended_application'],
    block: 'buyer_signals', blockKey: 'call_application', fromSource: ['buyer_signals.call_application'], evSource: CALL },
  { id: 'calls.intent_level', node: 'calls', label: 'intent level from calls', path: ['requirement', 'intent_level'], block: null, evSource: CALL },
  { id: 'calls.buyer', node: 'calls', label: 'buyer read from calls (persona · B2B/B2C)', path: ['buyer'],
    keys: ['name', 'city', 'state', 'b2b_b2c', 'persona'], block: null, evSource: CALL,
    note: 'a per-buyer persona and B2B/B2C read, straight from his own calls — strictly better than the category-level guess, and no consumer exists for it.' },
  { id: 'calls.seller_engagement', node: 'calls', label: 'seller engagement (outcomes · readiness)', path: ['seller_engagement'],
    keys: ['outcomes', 'deal_readiness', 'next_steps', 'callbacks'], block: null, evSource: CALL },
  { id: 'calls.coverage', node: 'calls', label: 'transcription coverage', path: ['coverage'], block: null,
    naFrom: 'saw', naWhy: 'fetch telemetry about the calls pull itself, not a buyer signal — nothing downstream should consume it, so a ✗ here would be a false alarm.' },

  // ── Category · what sellers ask in this MCAT ──
  { id: 'cat.top_specs', node: 'category', label: 'seller top questions', path: ['top_specs'],
    metaPath: ['category', 'top_specs'], metaWhy: 'brainToSeed reads metadata.category.top_specs (the form does re-fetch these per selected mcat, so a broken bridge here is recoverable)',
    block: 'seller_top_questions', fromSource: ['seller_top_questions', 'category_top_specs'],
    evSource: CAT, prov: /sellers (ask|qualify)|common in this category/i },
  { id: 'cat.personas', node: 'category', label: 'category personas', path: ['personas'],
    metaPath: ['category', 'personas'], metaWhy: 'metadata.category.personas is the ONLY channel — BrainRFQForm passes `_seed.categoryPersonas` and nothing re-fetches it',
    block: 'category_personas', fromSource: ['category_personas'], evSource: CAT,
    note: 'where INTENT actually lives per the v6 grounding audit. The planner has accepted <category_personas> since v2; nothing passed it until the wiring fix.' },
  { id: 'cat.b2b_b2c', node: 'category', label: 'category B2B/B2C mix', path: ['b2b_b2c'],
    metaPath: ['category', 'b2b_b2c'], metaWhy: 'metadata.category.b2b_b2c is the ONLY channel — BrainRFQForm passes `_seed.categoryB2b` and nothing re-fetches it',
    block: 'category_b2b_b2c', fromSource: ['category_b2b_b2c'], evSource: CAT },
  { id: 'cat.keywords', node: 'category', label: 'category keywords', path: ['keywords'], block: null, evSource: CAT,
    metaPath: ['category', 'keywords'], metaWhy: 'metadata.category.keywords → BrainSeed.categoryKeywords, which is then read by nobody',
    note: 'carried all the way into BrainSeed.categoryKeywords and then abandoned: runCuratedPlanner has no categoryKeywords input and no <category_keywords> block exists.' },

  // ── Client-side inputs · not carried in the brain payload ──
  { id: 'isq.page1', node: null, label: 'page-1 buyer ISQ fields', block: 'page1_buyer_specs', fromSource: ['page1_buyer_specs'] },
  { id: 'isq.seller_flagged', node: null, label: 'seller-flagged ISQ specs', block: 'seller_flagged_specs', fromSource: ['seller_flagged_specs'] },
  { id: 'cat.corpus', node: null, label: 'category call corpus', block: 'category_corpus', fromSource: ['category_corpus'] },
];

// ── Planner prompt parsing ───────────────────────────────────────────────────
/** Split the XML-fenced curated-planner USER message into `{tag: body}`. Returns null when there is no
 *  message to parse — the caller must render '?' rather than assume anything. */
export function parsePlannerBlocks(user?: string): Record<string, string> | null {
  if (!user || typeof user !== 'string') return null;
  const out: Record<string, string> = {};
  const re = /<([a-z0-9_]+)>\n?([\s\S]*?)\n?<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(user)) !== null) out[m[1]] = (m[2] ?? '').trim();
  return Object.keys(out).length ? out : null;
}
const blockEmpty = (body?: string): boolean => !body || body === '(none)' || body === '{}' || body === '[]' || body === 'null';

/** Word-boundary key probe. Substring containment is the recurring false-positive bug in this codebase
 *  (`/city/` once matched "CapaCITY" and routed a weight into the delivery field), so both the haystack
 *  and the needle are normalised to space-separated tokens before matching. */
function hasKey(body: string, key: string): boolean {
  const hay = ` ${body.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const needle = ` ${key.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  return needle.trim() ? hay.includes(needle) : false;
}

// ── node_raw walking ─────────────────────────────────────────────────────────
type Content = { present: boolean; n: number };
/** "Real content" test. A truthy-but-empty dict is NOT parsed — that distinction is the whole reason
 *  health can read green while extraction produced nothing. */
function content(v: unknown): Content {
  if (v == null) return { present: false, n: 0 };
  if (Array.isArray(v)) return { present: v.length > 0, n: v.length };
  if (typeof v === 'object') {
    const vals = Object.values(v as Record<string, unknown>);
    const live = vals.filter((x) => x != null && !(typeof x === 'string' && !x.trim()) && !(Array.isArray(x) && !x.length));
    return { present: live.length > 0, n: live.length };
  }
  if (typeof v === 'string') return { present: !!v.trim(), n: v.trim() ? 1 : 0 };
  return { present: true, n: 1 };
}
function walk(root: unknown, path: string[]): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) return { found: false, value: undefined };
    if (!(seg in (cur as Record<string, unknown>))) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { found: true, value: cur };
}

// ── The build ────────────────────────────────────────────────────────────────
interface PlannerOut {
  considered?: { from_source?: string; outcome?: string; q?: string }[];
  prefills?: { field?: string; value?: string; source?: string }[];
  gaps?: unknown[];
  opening?: unknown;
}
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function buildLadder(
  p: RequirementBrainPayload,
  plannerUser?: string,
  plannerOutput?: string,
): LadderReport {
  const o = p.observability;
  const nodeHealth = o.node_health ?? {};
  const hasHealth = Object.keys(nodeHealth).length > 0;
  const nodeRaw = o.node_raw as Record<string, unknown> | undefined;
  const evAtoms: EvidenceAtom[] = o.evidence ?? [];
  const hasEvidenceDict = evAtoms.length > 0;
  const evUsed = new Set(p.decisions.flatMap((d) => d.evidence ?? []));
  const blocks = parsePlannerBlocks(plannerUser);

  let plan: PlannerOut | null = null;
  if (plannerOutput) { try { plan = JSON.parse(plannerOutput) as PlannerOut; } catch { plan = null; } }
  const considered = Array.isArray(plan?.considered) ? plan!.considered! : null;
  const prefills = Array.isArray(plan?.prefills) ? plan!.prefills! : null;
  const planComputable = !!plan && (considered !== null || prefills !== null);

  // An evSource shared by several facets can only credit them all — flag that as soft rather than
  // pretending atom.source resolves to sub-facet granularity.
  const evSourceUses = new Map<string, number>();
  for (const f of FACETS) if (f.evSource) evSourceUses.set(String(f.evSource), (evSourceUses.get(String(f.evSource)) ?? 0) + 1);

  const facets: FacetLadder[] = FACETS.map((f) => {
    const st = {} as Record<StageKey, Cell>;

    // ── Received ──
    if (f.node == null) {
      st.received = { mark: 'unknown', why: 'not carried in the brain payload — this input is fetched client-side (getISQ / category corpus), and the panel has no health channel for it. Its presence in the planner prompt is the only proof available.' };
    } else if (!hasHealth) {
      st.received = { mark: 'unknown', why: 'the engine emitted no node_health at all, so no source can be shown to have answered.' };
    } else {
      const h = nodeHealth[f.node];
      if (!h) st.received = { mark: 'unknown', why: `"${f.node}" is absent from node_health — the engine did not report on this source.` };
      else if (h.status === 'red') st.received = { mark: 'no', n: h.count, why: `node_health.${f.node} is RED — the source errored.` };
      else st.received = { mark: 'yes', n: h.count, why: `node_health.${f.node} = ${h.status}, ${h.count} row${h.count === 1 ? '' : 's'}.${h.count === 0 ? ' Green/amber on a zero count is exactly the "healthy on empty" case — see Parsed.' : ''}` };
    }

    // ── Parsed ──
    if (f.node == null) {
      const body = blocks && f.block ? blocks[f.block] : undefined;
      if (blocks && f.block && !blockEmpty(body)) st.parsed = { mark: 'yes', n: (body ?? '').length, why: `no node_raw channel, but <${f.block}> carried ${(body ?? '').length} chars into the planner — proof it was fetched and parsed.`, soft: true };
      else st.parsed = { mark: 'unknown', why: 'not in node_raw and not (yet) provable from the planner prompt. Empty here could mean "never fetched" or "fetched empty" and we cannot tell them apart.' };
    } else if (!nodeRaw) {
      st.parsed = { mark: 'unknown', why: 'the engine emitted no node_raw — re-import the engine. Without it nothing about parsing is knowable.' };
    } else if (!(f.node in nodeRaw)) {
      st.parsed = { mark: 'unknown', why: `node_raw has no "${f.node}" entry at all.` };
    } else {
      const rootRaw = nodeRaw[f.node];
      if (rootRaw == null) {
        st.parsed = { mark: 'no', n: 0, why: `node_raw.${f.node} is null — the source produced nothing to parse.` };
      } else if (f.arrayItemPath) {
        const items = Array.isArray(rootRaw) ? rootRaw : [];
        const flat = items.flatMap((it) => { const r = walk(it, f.arrayItemPath!); return Array.isArray(r.value) ? r.value : r.found && r.value != null ? [r.value] : []; });
        st.parsed = flat.length
          ? { mark: 'yes', n: flat.length, why: `${flat.length} ${f.arrayItemPath.join('.')} entries across ${items.length} items in node_raw.${f.node}.` }
          : { mark: 'no', n: 0, why: `node_raw.${f.node} has ${items.length} items but none carry ${f.arrayItemPath.join('.')}.` };
      } else {
        const path = f.path ?? [];
        const r = path.length ? walk(rootRaw, path) : { found: true, value: rootRaw };
        if (!r.found) st.parsed = { mark: 'no', n: 0, why: `node_raw.${[f.node, ...path].join('.')} does not exist — the source's payload has no such key.` };
        else {
          const c = content(r.value);
          st.parsed = c.present
            ? { mark: 'yes', n: c.n, why: `node_raw.${[f.node, ...path].join('.')} holds ${c.n} live value${c.n === 1 ? '' : 's'}.` }
            : { mark: 'no', n: 0, why: `node_raw.${[f.node, ...path].join('.')} exists but is empty (empty array / null / a dict whose every value is blank). Present-but-empty is NOT parsed.` };
        }
      }
    }

    // ── Planner saw ──
    if (f.naFrom === 'saw') {
      st.saw = { mark: 'na', why: f.naWhy ?? 'not applicable to this facet.' };
    } else if (f.block == null) {
      st.saw = { mark: 'no', why: `ARCHITECTURAL: the curated-planner prompt has no block for this facet. Its block list is [${PLANNER_BLOCKS.join(', ')}] — none of them carries it, so no run can ever show it to the planner. Provable without a live call.` };
    } else if (!blocks) {
      st.saw = { mark: 'unknown', why: 'no curated-planner call has been captured this session, so the prompt that was actually sent cannot be inspected. Run the planner (pick a product) and this column fills in.' };
    } else if (!(f.block in blocks)) {
      st.saw = { mark: 'no', why: `<${f.block}> is not present in the prompt this run actually sent — prompt-builder drift against the block list.` };
    } else {
      const body = blocks[f.block];
      if (blockEmpty(body)) {
        st.saw = { mark: 'no', why: `<${f.block}> rendered "(none)" — the block exists but nothing was passed into it. This is the "accepted and never passed" failure.` };
      } else if (f.blockKey) {
        let sub: unknown; let ok = true;
        try { const j = JSON.parse(body) as Record<string, unknown>; sub = j?.[f.blockKey]; } catch { ok = false; }
        if (!ok) st.saw = { mark: 'unknown', why: `<${f.block}> is not JSON, so its "${f.blockKey}" sub-key cannot be resolved.` };
        else {
          const c = content(sub);
          st.saw = c.present
            ? { mark: 'yes', n: c.n, why: `<${f.block}>.${f.blockKey} carried ${c.n} value${c.n === 1 ? '' : 's'}.` }
            : { mark: 'no', why: `<${f.block}> was sent but its "${f.blockKey}" sub-key is empty/absent — the block being non-empty says nothing about THIS facet.` };
        }
      } else if (f.keys?.length) {
        const seen = f.keys.filter((k) => hasKey(body, f.keyAlias?.[k] ?? k));
        const missing = f.keys.filter((k) => !seen.includes(k));
        st.saw = seen.length
          ? { mark: 'yes', n: seen.length, of: f.keys.length, why: `<${f.block}> carried ${seen.length} of this facet's ${f.keys.length} fields.${missing.length ? ` Dropped on the way in: ${missing.join(', ')}.` : ''}` }
          : { mark: 'no', why: `<${f.block}> was sent but none of this facet's fields (${f.keys.join(', ')}) appear in it.` };
      } else {
        st.saw = { mark: 'yes', n: body.length, why: `<${f.block}> carried ${body.length} chars.` };
      }
    }

    // ── Planner used ──
    if (st.saw.mark === 'na') st.used = { mark: 'na', why: st.saw.why };
    else if (st.saw.mark === 'no') st.used = { mark: 'na', why: 'the planner was never shown this facet, so it could not use it. The break is one column left.' };
    else if (st.saw.mark === 'unknown') st.used = { mark: 'unknown', why: 'unknowable until we know whether the planner even saw it.' };
    else if (!planComputable) st.used = { mark: 'unknown', why: 'the curated-planner output was not captured (or did not parse), so its considered[]/prefills[] accounting cannot be read.' };
    else if (!f.fromSource?.length && !f.prefillSource) st.used = { mark: 'unknown', why: 'no from_source token in the planner contract maps to this facet, so its use cannot be attributed.' };
    else {
      const want = new Set((f.fromSource ?? []).map(norm));
      const hitC = (considered ?? []).filter((c) => want.has(norm(c?.from_source)));
      const hitP = f.prefillSource ? (prefills ?? []).filter((x) => f.prefillSource!.test(String(x?.source ?? ''))) : [];
      const n = hitC.length + hitP.length;
      st.used = n
        ? { mark: 'yes', n, why: `${hitC.length} candidate${hitC.length === 1 ? '' : 's'} in considered[] name it as from_source${hitP.length ? `, and ${hitP.length} prefill${hitP.length === 1 ? '' : 's'} trace to it` : ''}.` }
        : { mark: 'no', why: `the planner was shown this facet and named nothing from it — no considered[].from_source of [${(f.fromSource ?? []).join(', ')}] and no prefill traced to it. Seen and ignored.` };
    }

    // ── Decision ──
    const shared = f.evSource ? (evSourceUses.get(String(f.evSource)) ?? 1) > 1 : false;
    const myAtoms = hasEvidenceDict && f.evSource ? evAtoms.filter((a) => f.evSource!.test(String(a.source ?? ''))) : [];
    const atomsInDecision = myAtoms.filter((a) => evUsed.has(a.id));
    const provDecisions: Decision[] = f.prov ? p.decisions.filter((d) => d.action !== 'SUPPRESS' && f.prov!.test(String(d.reason ?? d.why ?? ''))) : [];
    const evDecisions: Decision[] = atomsInDecision.length
      ? p.decisions.filter((d) => (d.evidence ?? []).some((id) => atomsInDecision.some((a) => a.id === id)))
      : [];
    const askedFromFacet = st.used.mark === 'yes' && considered
      ? considered.filter((c) => (f.fromSource ?? []).map(norm).includes(norm(c?.from_source)) && String(c?.outcome) === 'asked')
      : [];
    const prefillsFromFacet = st.used.mark === 'yes' && prefills && f.prefillSource
      ? prefills.filter((x) => f.prefillSource!.test(String(x?.source ?? '')))
      : [];

    let decisionDecisions: Decision[] = [];
    if (f.naFrom && STAGES.indexOf(f.naFrom) <= STAGES.indexOf('decision')) {
      st.decision = { mark: 'na', why: f.naWhy ?? 'not applicable to this facet.' };
    } else if (atomsInDecision.length) {
      decisionDecisions = evDecisions;
      st.decision = { mark: 'yes', n: atomsInDecision.length, soft: shared, why: `${atomsInDecision.length} of this source's ${myAtoms.length} evidence atoms are cited by a decision.${shared ? ' SOFT: atom.source is a signal-vocabulary string that several facets of this node share, so the attribution is at node granularity, not facet.' : ''}` };
    } else if (askedFromFacet.length || prefillsFromFacet.length) {
      st.decision = { mark: 'yes', n: askedFromFacet.length + prefillsFromFacet.length, why: `the planner shipped ${askedFromFacet.length} question${askedFromFacet.length === 1 ? '' : 's'} and ${prefillsFromFacet.length} prefill${prefillsFromFacet.length === 1 ? '' : 's'} from it. (Prefills counted off the raw planner output, i.e. before the grounding guard runs.)` };
    } else if (provDecisions.length) {
      decisionDecisions = provDecisions;
      st.decision = { mark: 'yes', n: provDecisions.length, soft: true, why: `SOFT: no evidence dictionary to check, so this is matched on the buyer-facing provenance phrase in ${provDecisions.length} decision reason${provDecisions.length === 1 ? '' : 's'} ("${String(provDecisions[0].reason ?? '').slice(0, 60)}"). A phrase match, not a ledger entry.` };
    } else {
      const engineChecked = hasEvidenceDict && !!f.evSource;
      const plannerChecked = st.used.mark === 'no' || st.used.mark === 'na';
      if (engineChecked && plannerChecked) {
        st.decision = { mark: 'no', n: 0, why: `both accounting layers checked and both are empty: none of this source's ${myAtoms.length} evidence atoms is cited by any decision, and the planner did not use it either.` };
      } else if (!hasEvidenceDict) {
        st.decision = { mark: 'unknown', why: 'the engine emitted no evidence dictionary (observability.evidence), so decisions[].evidence ids dangle and engine-side attribution is unauditable. Nothing here can be called a ✗ without inventing it.' };
      } else if (!f.evSource) {
        st.decision = { mark: 'unknown', why: 'no evidence-atom source pattern maps to this facet, so its engine-side use cannot be attributed.' };
      } else {
        st.decision = { mark: 'unknown', why: 'the planner layer has not been observed yet, so a negative would be premature.' };
      }
    }

    // ── Rendered (heuristic, and labelled as one everywhere) ──
    if (st.decision.mark !== 'yes') {
      st.rendered = st.decision.mark === 'no'
        ? { mark: 'na', why: 'nothing from this facet reached a decision, so there was nothing to render.' }
        : { mark: st.decision.mark, why: st.decision.mark === 'na' ? st.decision.why : 'unknowable until the decision stage resolves.' };
    } else if (decisionDecisions.length) {
      const rendered = decisionDecisions.filter((d) => renderOf(d.action)?.rendered);
      const dead = decisionDecisions.filter((d) => !renderOf(d.action)?.rendered);
      const deadWhy = [...new Set(dead.map((d) => `${d.action} → ${renderOf(d.action)?.where ?? 'unmapped action'}`))].join('; ');
      const basis = `HEURISTIC (${renderBasis()})`;
      st.rendered = rendered.length
        ? { mark: 'yes', n: rendered.length, soft: true, why: `${basis}: ${rendered.length} decision${rendered.length === 1 ? '' : 's'} of a kind the form actually reads (${[...new Set(rendered.map((d) => d.action))].join(', ')}).${dead.length ? ` ${dead.length} more died on the way to a control — ${deadWhy}.` : ''}` }
        : { mark: 'no', n: 0, soft: true, why: `${basis}: every decision this facet produced is of a kind the form never reads — ${deadWhy}. Generated and thrown away.` };
    } else {
      st.rendered = { mark: 'yes', n: st.decision.n, soft: true, why: 'HEURISTIC: the planner\'s own outputs are rendered — opening/gaps become question chips (setBaq / setAiSpecs) and prefills are applied to the spec fields (applyExtractedSpecs).' };
    }

    // ── Submitted / Seller saw — never faked ──
    st.submitted = { mark: 'unverified', why: 'UNVERIFIED. This client keeps no per-field record of the submitted RFQ. BES proves a submit happened and how long it took, not which values went with it. Wiring a submitted-payload snapshot is what would make this column real.' };
    st.seller = { mark: 'unverified', why: 'UNVERIFIED. No seller-side signal (lead delivered, opened, quoted) reaches this client at all. Nothing short of a seller-side feed can fill this in.' };

    // ── The bridge check (offline-provable, and orthogonal to the columns) ──
    // node_raw is a DEBUG channel. What the planner actually gets is built by brainToSeed out of
    // `metadata.*`. A facet can therefore be a perfectly honest Parsed ✓ and still be dead on arrival
    // because its metadata slot is empty — which is precisely how `metadata.category = null` starved
    // <category_personas> and <category_b2b_b2c> while node_raw.category sat there fully populated.
    let bridge: FacetLadder['bridge'];
    if (f.metaPath) {
      const via = `metadata.${f.metaPath.join('.')}`;
      const r = walk(p.metadata as unknown as Record<string, unknown>, f.metaPath);
      const c = r.found ? content(r.value) : { present: false, n: 0 };
      if (c.present) bridge = { via, ok: true, why: `${via} holds ${c.n} live value${c.n === 1 ? '' : 's'}${f.metaWhy ? ` — ${f.metaWhy}.` : '.'}` };
      else if (st.parsed.mark === 'yes') bridge = { via, ok: false, why: `BRIDGE BROKEN — the source parsed fine, but ${via} is ${r.found ? 'empty' : 'missing/null'}, and that is what the form adapter reads${f.metaWhy ? ` (${f.metaWhy})` : ''}. Rich in node_raw, dead on arrival at the planner input.` };
      else bridge = { via, ok: false, why: `${via} is empty — but the source produced nothing either, so this bridge was never load-bearing here.` };
    }

    const carriedData = st.parsed.mark === 'yes';
    const diesAt: StageKey | null =
      st.parsed.mark === 'no' ? 'parsed'
      : st.saw.mark === 'no' ? 'saw'
      : st.used.mark === 'no' ? 'used'
      : st.decision.mark === 'no' ? 'decision'
      : null;

    return { id: f.id, node: f.node, label: f.label, note: f.note, stages: st, carriedData, diesAt, bridge };
  });

  const withData = facets.filter((f) => f.carriedData);
  const dying = withData.filter((f) => f.diesAt && f.diesAt !== 'parsed');
  const reachedDecision = withData.filter((f) => f.stages.decision.mark === 'yes');
  const unverifiable = withData.filter((f) => !f.diesAt && f.stages.decision.mark === 'unknown');
  const notRendered = reachedDecision.filter((f) => f.stages.rendered.mark === 'no');
  const brokenBridges = withData.filter((f) => f.bridge && !f.bridge.ok);

  return { facets, m: withData.length, dying, unverifiable, reachedDecision, notRendered, brokenBridges, plannerRun: !!blocks, hasEvidenceDict };
}
