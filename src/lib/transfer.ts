// ─── Intelligence Transfer Engine (the Buyer Memory System's core decision) ───
// The question is NOT "are these two products similar?" — it is "which prior buyer intelligence can I
// SAFELY reuse for THIS requirement?". Prior intelligence is not all-or-nothing; it sits in PORTABILITY
// TIERS, and the old binary off-profile guard (same category → use everything; else → use nothing) is the
// bug: the moment Jaiveer the notebook-maker typed "paper", his MANUFACTURER identity got muted and the
// form asked if it was for "personal use". Tiered transfer fixes that:
//
//   A — Buyer Facts          → ALWAYS portable   (WHO they are: role, nature, region, language, verified, authority, maturity)
//   B — Procurement Traits   → USUALLY portable  (HOW they buy: credit lean, urgency, channel, sourcing, locality, cadence-tendency)
//   C — Category Intelligence→ portable ONLY when the new category is RELATED (WHAT they source: their categories/themes)
//   D — Product Intelligence → NEVER portable    (spec VALUES: GSM, thickness, automation grade — category-bound)
//
// Relatedness (0-100) is an INPUT, supplied by whatever similarity signal exists — deterministic lexical
// overlap now, a semantic Buyer-Story score later. It gates ONLY Tier C; A and B never depend on it, so an
// unrelated product (Jaiveer → "Diesel Generator") still carries "manufacturer · large · regional · credit"
// without leaking "notebook inputs". Channel-agnostic + pure: RFQ, WhatsApp, VANI, BuyerMy all consume it.

export type PortabilityTier = 'A' | 'B' | 'C' | 'D';
export interface IntelligenceItem { key: string; value: string; tier: PortabilityTier }
export interface TransferDecision {
  transfer: IntelligenceItem[];   // intelligence that MAY shape THIS requirement
  withhold: IntelligenceItem[];   // intelligence that must NOT (category-bound, or unrelated-category intel)
  relatedness: number;            // the input score (0-100), echoed
  categoryTransfers: boolean;     // did Tier C clear the relatedness gate?
  reason: string;                 // human-readable why (for the debug ledger + seller transparency)
}

// Above this relatedness the new category is "the same business line" enough to carry Tier-C intelligence.
export const CATEGORY_TRANSFER_THRESHOLD = 50;

// The core decision. Pure: same items + same relatedness ⇒ same result.
export function decideTransfer(items: IntelligenceItem[], relatedness: number): TransferDecision {
  const r = Math.max(0, Math.min(100, Math.round(relatedness || 0)));
  const categoryTransfers = r >= CATEGORY_TRANSFER_THRESHOLD;
  const transfer: IntelligenceItem[] = [];
  const withhold: IntelligenceItem[] = [];
  for (const it of items || []) {
    if (!it || !it.key) continue;
    const keep = it.tier === 'A' || it.tier === 'B' ? true       // who-they-are + how-they-buy: always
      : it.tier === 'C' ? categoryTransfers                       // what-they-source: only when related
      : false;                                                    // product specs (D): never
    (keep ? transfer : withhold).push(it);
  }
  return {
    transfer, withhold, relatedness: r, categoryTransfers,
    reason: categoryTransfers
      ? `related (${r}/100 ≥ ${CATEGORY_TRANSFER_THRESHOLD}): buyer facts + procurement traits + category intelligence all carry; product specs never do`
      : `unrelated (${r}/100 < ${CATEGORY_TRANSFER_THRESHOLD}): only buyer facts + procurement traits carry; category intelligence withheld; product specs never carry`,
  };
}

// Map the buyer's COMPILED intelligence into tiered items. The tier is intrinsic to the KIND of fact
// (who-they-are vs how-they-buy vs what-they-source vs product-spec) — NEVER category-specific, so this
// holds ZERO category literals (standing rule). Blank / Unknown facts are dropped.
export function tierBuyerIntelligence(src: {
  profile?: {
    persona?: string; maturity?: string; authority?: string; authorityRole?: string; procurementModel?: string;
    nature?: string; sourcingStyle?: string; buyingPattern?: string; decisionStyle?: string; infoSeeking?: string;
    supplierPreference?: string; localityPreference?: string; engagement?: string; responseSensitivity?: string; multiSku?: boolean;
  } | null;
  twinBusinessType?: string; region?: string; language?: string; verified?: boolean; entityType?: string;
  historicalCategories?: string[]; themes?: string[];
  knownSpecs?: Record<string, string>; // a PRIOR category's spec answers — Tier D, never portable
}): IntelligenceItem[] {
  const items: IntelligenceItem[] = [];
  const add = (key: string, value: unknown, tier: PortabilityTier) => {
    const v = String(value ?? '').trim();
    if (v && !/^(unknown|n\/?a|none|false)$/i.test(v)) items.push({ key, value: v, tier });
  };
  const p = src.profile || {};
  // Tier A — WHO they are (always portable)
  add('business type', src.twinBusinessType || p.persona, 'A');
  add('nature', p.nature, 'A');
  add('authority', p.authorityRole || p.authority, 'A');
  add('maturity', p.maturity, 'A');
  add('region', src.region, 'A');
  add('language', src.language, 'A');
  add('entity type', src.entityType, 'A');
  if (src.verified) add('verified', 'GST/Udyam verified', 'A');
  // Tier B — HOW they buy (usually portable)
  add('procurement model', p.procurementModel, 'B');
  add('buying pattern', p.buyingPattern, 'B');
  add('sourcing style', p.sourcingStyle, 'B');
  add('decision style', p.decisionStyle, 'B');
  add('info-seeking', p.infoSeeking, 'B');
  add('supplier preference', p.supplierPreference, 'B');
  add('local preference', p.localityPreference, 'B');
  add('communication', p.engagement, 'B');
  add('response sensitivity', p.responseSensitivity, 'B');
  if (p.multiSku) add('multi-SKU', 'buys across categories', 'B');
  // Tier C — WHAT they source for (portable only when related)
  for (const c of src.historicalCategories || []) add(`history: ${c}`, c, 'C');
  for (const th of src.themes || []) add(`theme: ${th}`, th, 'C');
  // Tier D — product-specific spec VALUES (never portable to a different product)
  for (const [k, v] of Object.entries(src.knownSpecs || {})) add(`spec: ${k}`, String(v), 'D');
  return items;
}

// Compact one-line render of the TRANSFERABLE set for an LLM prompt (deriveIntent / planner). PII-free.
export function formatTransfer(items: IntelligenceItem[]): string {
  return (items || []).map((it) => it.tier === 'C' || it.key.includes(':') ? it.value : `${it.key}: ${it.value}`).join(' · ');
}

// Relatedness 0-100 between the current product and the buyer's FULL category history (the WIDEST set —
// Twin's compiled list AND enrichment categories, since the Twin's is an LLM-shaped subset that can omit a
// category enrichment clearly has). `tokenize` is injected (the app passes coreTokens) so this stays a
// standalone Buyer-Memory primitive with no app dependency. Best single-category overlap wins.
export function categoryRelatedness(currentProduct: string, history: string[], tokenize: (s: string) => Set<string>): number {
  const cur = tokenize(currentProduct || '');
  if (!cur.size) return 0;
  let best = 0;
  for (const h of history || []) {
    const ht = tokenize(h || '');
    if (!ht.size) continue;
    const shared = [...cur].filter((t) => ht.has(t)).length;
    if (!shared) continue;
    best = Math.max(best, shared / Math.min(cur.size, ht.size));
  }
  return Math.round(best * 100);
}
