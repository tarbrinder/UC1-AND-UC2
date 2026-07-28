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
  productImage?: string;                    // viewed/posted product image → seeded for display + image pipeline
  // the buyer's OWN truth signals for THIS requirement (WhatsApp / calls) — the planner enriches/corrects from these
  buyerSignals?: {
    whatsapp_products?: string[]; call_queries?: string[]; call_application?: string; call_specs?: { name: string; value: string }[];
    whatsapp_specs?: { name: string; value: string }[];   // buyer-typed specs on WhatsApp (e.g. gsm) → PREFILL
    objections?: string[];                                 // "too far" / "high price" → planner reframes a gap
    business_intent?: string[];                            // reselling / wholesale → flips the KYB/GST ask
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
  const sig = {
    whatsapp_products: asStrs(wa.products_enquired).slice(0, 8),
    call_queries: asStrs(cr.buyer_queries).slice(0, 8),
    call_application: typeof cr.intended_application === 'string' ? (cr.intended_application as string) : undefined,
    call_specs, whatsapp_specs,
    objections: asStrs(wa.objections).slice(0, 6),
    business_intent: asStrs(wa.explicit_business_intent).slice(0, 6),
  };
  // only return if there's at least one real signal
  return (sig.whatsapp_products.length || sig.call_queries.length || sig.call_application || sig.call_specs.length || sig.whatsapp_specs.length || sig.objections.length || sig.business_intent.length) ? sig : undefined;
}

const val = (d: Decision) => (typeof d.value === 'string' ? d.value : '');
const isFilled = (a: Decision) => a.action === 'PREFILL' || a.action === 'CONFIRM';

// The four actions that are a QUESTION-SELECTION decision (as opposed to a fill). These are the ones the
// planner must rank/phrase rather than re-invent. Ordered by how load-bearing they are for the firewall.
const PLANNABLE: DecisionAction[] = ['RESOLVE_CONFLICT', 'ASK', 'SUGGEST', 'OFFER'];
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
      why: d.why || d.reason || undefined,
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
  let quantity = '', unit = '', deliveryLocation = '';
  for (const d of p.decisions) {
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
    buyerSignals: extractBuyerSignals(p),
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
  // Route qty / unit / delivery OUT of specs into their own fields (same as brainToSeed) — else a
  // reposted card's "Quantity: 500 / Quantity Unit: Piece" stays a spec chip and the qty box shows empty.
  let quantity = '', unit = '', deliveryLocation = '';
  for (const s of rec.specs ?? []) {
    if (!s.name || !s.value) continue;
    if (QTY.test(s.name)) { quantity = s.value; continue; }
    if (QTY_UNIT.test(s.name)) { unit = s.value; continue; }
    if (DELIV(s.name)) { deliveryLocation = s.value; continue; }
    if (/^(order_value|requirement_type|purchase_frequency|buyer_context)$/i.test(s.name)) continue; // context, not an ISQ chip
    specValues[s.name] = s.value;
  }
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
    categoryTopSpecs: (p?.metadata.category?.top_specs ?? []).map((x) => ({ ...x, pct: typeof x.pct === 'number' ? Math.min(100, Math.round(x.pct)) : x.pct })),
    categoryKeywords: p?.metadata.category?.keywords,
    categoryPersonas: p?.metadata.category?.personas,
    categoryB2b: p?.metadata.category?.b2b_b2c,
    buyerSignals: p ? extractBuyerSignals(p) : undefined,
  };
}

/** Blank seed — brand-new requirement (cold start). */
export const blankSeed = (): BrainSeed => ({
  productName: '', mcatId: '', committed: false, quantity: '', unit: '', deliveryLocation: '',
  startStage: 'product', entryMode: 'blank_multimodal', specValues: {}, gaps: [], conflicts: [], gstAsk: false,
});
