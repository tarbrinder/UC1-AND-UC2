// ─── Intelligence Consumption Engine ─────────────────────────────────────────
// Transfer answers "what CAN I reuse for this RFQ?". Consumption answers "what SHOULD actually shape it?".
// A researcher is still a researcher when buying an office chair (so it TRANSFERS) — but it must not
// DOMINATE the chair's questions (so it must not be CONSUMED as a driver). This layer scores each carried
// intelligence item for SALIENCE to the current requirement and routes it to the consumer it actually
// affects: intent · logistics · commercial · process · routing. Only the DRIVERS (high/medium, non-routing)
// shape questions/deductions/nudges/spec-order; the rest are carried but quiet.
//
// Pure · channel-agnostic · NO category literals — salience is a function of the fact's KIND plus the
// coarse PRODUCT SHAPE (archetype + order scale), never the category string. The form is one consumer;
// WhatsApp / VANI / a negotiation agent can call consume() with their own context.

export type RfqDimension = 'intent' | 'logistics' | 'commercial' | 'process' | 'routing';
export type Salience = 'high' | 'medium' | 'low';
export interface ConsumedItem { key: string; value: string; tier: string; salience: Salience; dimensions: RfqDimension[] }

// Intrinsic relevance of each KIND of fact (by its transfer key, never the category):
//  dims = the RFQ dimensions it can touch · base = baseline salience ·
//  processWeighted = its salience tracks product complexity (rises for capital/industrial, falls for a
//  plain commodity — this is the office-chair fix: authority/procurement shouldn't lead a chair RFQ).
const FACT_PROFILE: Record<string, { dims: RfqDimension[]; base: Salience; processWeighted?: boolean }> = {
  'business type':        { dims: ['intent', 'process'], base: 'high' },
  'nature':               { dims: ['process', 'intent'], base: 'high' },
  'authority':            { dims: ['process', 'commercial'], base: 'medium', processWeighted: true },
  'maturity':             { dims: ['intent'], base: 'medium' },
  'region':               { dims: ['logistics'], base: 'high' },
  'language':             { dims: ['routing'], base: 'low' },
  'entity type':          { dims: ['process'], base: 'medium' },
  'verified':             { dims: ['routing'], base: 'low' },
  'procurement model':    { dims: ['commercial', 'intent'], base: 'high', processWeighted: true },
  'buying pattern':       { dims: ['intent', 'commercial'], base: 'high' },
  'sourcing style':       { dims: ['process'], base: 'medium' },
  'decision style':       { dims: ['process'], base: 'medium' },
  'info-seeking':         { dims: ['process'], base: 'medium' },
  'supplier preference':  { dims: ['routing'], base: 'medium' },
  'local preference':     { dims: ['logistics'], base: 'high' },
  'communication':        { dims: ['routing'], base: 'low' },
  'response sensitivity': { dims: ['logistics', 'commercial'], base: 'medium' },
  'multi-SKU':            { dims: ['intent'], base: 'medium' },
};

// Does PROCESS / authority intelligence actually matter for this product? A capital / project / made-to-spec
// buy, or an industrial / bulk order → YES (tender, PO, installation are real). A plain commodity at small
// scale → NO (an office chair needs no procurement-cell treatment, even from a research institution).
export function processMatters(archetype?: string, orderScale?: string): boolean {
  if (/capital|project|made_to_spec|branded/i.test(archetype || '')) return true;
  if (/industrial|wholesale|bulk/i.test(orderScale || '')) return true;
  return false;
}

const RANK: Record<Salience, number> = { high: 3, medium: 2, low: 1 };

export function consume(
  items: Array<{ key: string; value: string; tier: string }>,
  context: { archetype?: string; orderScale?: string } = {}
): {
  consumed: ConsumedItem[];
  drivers: ConsumedItem[]; // what SHOULD shape this RFQ (high/medium, non-routing) — ranked
  quiet: ConsumedItem[];   // carried but must not lead (low salience / routing-only)
  byDimension: Record<RfqDimension, ConsumedItem[]>;
  processMatters: boolean;
} {
  const procMatters = processMatters(context.archetype, context.orderScale);
  const consumed: ConsumedItem[] = (items || []).filter((it) => it && it.key).map((it) => {
    // Tier-C (their categories/themes) is intent-salient whenever it is present — transfer already gated it.
    const prof = FACT_PROFILE[it.key]
      || (it.key.startsWith('history:') || it.key.startsWith('theme:') || it.tier === 'C'
        ? { dims: ['intent'] as RfqDimension[], base: 'high' as Salience }
        : { dims: ['process'] as RfqDimension[], base: 'low' as Salience });
    // case-4: a process-weighted fact rises to 'high' for a complex/industrial buy, drops to 'low' otherwise.
    const salience: Salience = prof.processWeighted ? (procMatters ? 'high' : 'low') : prof.base;
    return { key: it.key, value: it.value, tier: it.tier, salience, dimensions: prof.dims };
  });
  // DRIVERS = items that genuinely shape the RFQ: not 'low', and not routing-only (routing = seller wiring,
  // not the buyer's questions/specs). Ranked high→medium so the most-decisive lead.
  const drivers = consumed
    .filter((c) => c.salience !== 'low' && !(c.dimensions.length === 1 && c.dimensions[0] === 'routing'))
    .sort((a, b) => RANK[b.salience] - RANK[a.salience]);
  const quiet = consumed.filter((c) => !drivers.includes(c));
  const byDimension: Record<RfqDimension, ConsumedItem[]> = { intent: [], logistics: [], commercial: [], process: [], routing: [] };
  for (const c of consumed) for (const d of c.dimensions) byDimension[d].push(c);
  return { consumed, drivers, quiet, byDimension, processMatters: procMatters };
}

// Render the DRIVERS for an LLM prompt — what should actually shape THIS requirement. PII-free.
export function formatDrivers(drivers: ConsumedItem[]): string {
  return (drivers || []).map((c) => c.tier === 'C' || c.key.includes(':') ? c.value : `${c.key}: ${c.value}`).join(' · ');
}
