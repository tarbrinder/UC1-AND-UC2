// ─── Form Adapter ────────────────────────────────────────────────────────────
// The explicit contract: Requirement Engine → Decision Objects → Form Adapter → SimpleRFQ state.
// Maps a RequirementBrainPayload (or one chosen recommendation) into the seed the duplicated
// Simple form initializes from. The form's OWN logic (getSpecHints, getMissingSpecs, mic, photo,
// results) then runs on top — the brain only pre-fills; it never replaces the form.
import type { RequirementBrainPayload, Decision } from './requirementBrain';

export type BrainStage = 'product' | 'specs' | 'aispecs' | 'more' | 'results';

export interface BrainSeed {
  productName: string;
  mcatId: string;
  committed: boolean;
  quantity: string;
  unit: string;
  specValues: Record<string, string>;      // stated/confirmed specs → pre-filled spec fields
  deliveryLocation: string;
  startStage: BrainStage;
  entryMode: string;
  gaps: { q: string; kind?: string; options?: string[] }[];   // ASK decisions → shown on the aispecs page
  conflicts: Decision[];                    // RESOLVE_CONFLICT decisions → the A/B widget
  gstAsk: boolean;                          // kyb_unlock === 'offer'
  // context for the buyer-aware first question (the intelligence layer)
  buyerFacts?: Record<string, unknown>;
  basket?: string[];
  categoryTopSpecs?: { q: string; pct?: number; vals?: string[] }[];
  categoryKeywords?: string[];
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
// fields that are NOT ISQ specs — routed to their own form state, not specValues
const QTY = /^(quantity|qty)$/i, QTY_UNIT = /quantity ?unit|unit of/i, DELIV = /deliver|location|city/i;

/** Build the seed for the RESOLVED primary requirement (the enrich / gap flow). */
export function brainToSeed(p: RequirementBrainPayload): BrainSeed {
  const m = p.metadata;
  const specValues: Record<string, string> = {};
  let quantity = '', unit = '', deliveryLocation = '';
  for (const d of p.decisions) {
    if (!isFilled(d) || !d.value) continue;
    if (QTY.test(d.field)) { quantity = val(d); continue; }
    if (QTY_UNIT.test(d.field)) { unit = val(d); continue; }
    if (DELIV.test(d.field)) { deliveryLocation = val(d); continue; }
    if (/^(order_value|requirement_type|purchase_frequency|application)$/i.test(d.field)) continue; // context, not an ISQ chip
    specValues[d.field] = val(d);
  }
  // entry_mode → where to land. Enrich/confirm start on specs (product known); cold starts on product.
  const startStage: BrainStage =
    m.entry_mode === 'blank_multimodal' || !m.primary ? 'product'
    : m.entry_mode === 'confirm_draft' ? 'more'          // complete → straight to the last page to send
    : 'specs';                                           // gap/repost/chooser → specs, then aispecs gaps
  return {
    productName: m.primary?.product ?? '',
    mcatId: m.primary?.mcat ?? '',
    committed: !!m.primary,
    quantity, unit, deliveryLocation, startStage,
    entryMode: m.entry_mode,
    specValues,
    gaps: p.decisions.filter((d) => d.action === 'ASK').map((d) => ({ q: d.field, kind: d.kind, options: (d.options ?? []).map((o) => (typeof o === 'string' ? o : o.value)) })),
    conflicts: p.decisions.filter((d) => d.action === 'RESOLVE_CONFLICT'),
    gstAsk: m.kyb_unlock.state === 'offer',
    buyerFacts: m.buyer_facts as Record<string, unknown> | undefined,
    basket: (m.recommendations ?? []).map((r) => r.product),
    // clamp the corpus asked_pct bug (39% of categories exceed 100% — counts spec occurrences across products);
    // clamp to <=100 so the gate + any "asked in X%" copy is never nonsensical (true corpus dedupe is a separate fix).
    categoryTopSpecs: (m.category?.top_specs ?? []).map((s) => ({ ...s, pct: typeof s.pct === 'number' ? Math.min(100, Math.round(s.pct)) : s.pct })),
    categoryKeywords: m.category?.keywords,
    buyerSignals: extractBuyerSignals(p),
  };
}

/** Seed for a picked recommendation card. Enrich & Source are the SAME flow — both carry product +
 *  image + whatever specs we have; the form's own pipeline (like the image flow) fills the rest. */
export function recommendationToSeed(rec: { product: string; mcat?: string; is_expired?: boolean; specs?: { name: string; value: string }[]; image?: string | null }): BrainSeed {
  const specValues: Record<string, string> = {};
  // Route qty / unit / delivery OUT of specs into their own fields (same as brainToSeed) — else a
  // reposted card's "Quantity: 500 / Quantity Unit: Piece" stays a spec chip and the qty box shows empty.
  let quantity = '', unit = '', deliveryLocation = '';
  for (const s of rec.specs ?? []) {
    if (!s.name || !s.value) continue;
    if (QTY.test(s.name)) { quantity = s.value; continue; }
    if (QTY_UNIT.test(s.name)) { unit = s.value; continue; }
    if (DELIV.test(s.name)) { deliveryLocation = s.value; continue; }
    if (/^(order_value|requirement_type|purchase_frequency|application)$/i.test(s.name)) continue; // context, not an ISQ chip
    specValues[s.name] = s.value;
  }
  return {
    productName: rec.product, mcatId: rec.mcat ?? '', committed: !!rec.mcat,
    quantity, unit, deliveryLocation,
    startStage: rec.mcat ? 'specs' : 'product',
    entryMode: rec.is_expired ? 'repost' : 'enrich',
    specValues, gaps: [], conflicts: [], gstAsk: false,
    // carry image so the seed flows through the form's image/display pipeline exactly like an upload
    productImage: rec.image ?? undefined,
  };
}

/** Blank seed — brand-new requirement (cold start). */
export const blankSeed = (): BrainSeed => ({
  productName: '', mcatId: '', committed: false, quantity: '', unit: '', deliveryLocation: '',
  startStage: 'product', entryMode: 'blank_multimodal', specValues: {}, gaps: [], conflicts: [], gstAsk: false,
});
