// ─── Procurement Context Engine (P3) ─────────────────────────────────────────
// "You have Authority. You have Nature. You don't yet have Procurement Context." The SAME battery can be
// a research prototype, a lab purchase, a department buy, a grant-funded project, or institutional supply —
// and that changes urgency, GST need, approval flow, quote format and seller follow-up far more than any
// extra Twin field. This classifies the procurement PROCESS from signals we already hold (Nature +
// authority + journey/intent + order scale + requirement mode) — deterministic, NO new pull, NO new LLM,
// NO category literals (it keys off procurement-process words like "research / prototype / resale", never
// a product/category). Channel-agnostic; the RFQ is one consumer.

export type ProcurementContext =
  | 'research_prototype' | 'lab_procurement' | 'project' | 'department_purchase' | 'institutional_supply'
  | 'capex' | 'production_input' | 'resale_stock' | 'maintenance' | 'one_off' | 'unknown';

export interface ProcurementImplications {
  gstLikely: boolean;     // does this process need a GST invoice? (institution/business → yes; personal → no)
  approvalFlow: string;   // direct buy · PO · grant / PO · tender …
  quoteFormat: string;    // best rate · formal itemised quote · proforma for PO …
  followUp: string;       // a hint for seller follow-up cadence
}
export interface ProcurementSignal {
  context: ProcurementContext;
  label: string;
  confidence: number;     // 0-100 (evidence-gated; unknown ⇒ 0)
  evidence: string[];
  implications: ProcurementImplications;
}

const RND = /research|\br&?d\b|prototype|develop|experiment|proof.?of.?concept|poc\b/i;
const LAB = /\blab\b|laborator|testing|test\s*bench|characteris|measurement|teaching|training|academ/i;
const RESALE = /resale|resell|reseller|trading|distribut|wholesal|stock(?!\s*out)|retail/i;
const PRODUCTION = /production|manufactur|assembly|process(?:ing)?\s*line|plant\s*input|raw\s*material/i;
const MAINT = /maintenance|repair|replacement|spare|amc|breakdown|servicing/i;

const INSTITUTIONAL = (nature?: string) => /academic|research|government|psu/i.test(nature || '');
const small = (band?: string) => band === 'single' || band === 'small';

export function classifyProcurement(s: {
  nature?: string;
  authorityRole?: string;     // procurement / researcher / decision_maker / influencer
  journey?: string;           // industrial | resale | project | maintenance | personal | …
  intentText?: string;        // the buyer's stated use-case
  orderScaleBand?: string;    // single | small | bulk | wholesale
  requirementMode?: string;   // capital | project | recurring | sample_trial | bulk | …
}): ProcurementSignal {
  const hay = `${s.journey || ''} ${s.intentText || ''}`;
  const ev: string[] = [];
  const mk = (context: ProcurementContext, label: string, confidence: number, implications: ProcurementImplications): ProcurementSignal => ({ context, label, confidence, evidence: ev, implications });

  const institutional = INSTITUTIONAL(s.nature);
  const procurementRole = /procurement/i.test(s.authorityRole || '');
  const capitalMode = /capital|project/i.test(s.requirementMode || '');

  if (institutional) {
    ev.push(`institutional Nature (${s.nature})`);
    // A research institution's process splits on intent + scale + authority.
    if (procurementRole || /tender|rate.?contract/i.test(hay)) { ev.push('procurement authority / tender language'); return mk('institutional_supply', 'Institutional supply (PO / tender)', 80, { gstLikely: true, approvalFlow: 'tender / rate contract', quoteFormat: 'formal itemised quote + compliance docs', followUp: 'expect a committee timeline, not a quick close' }); }
    if (capitalMode || /turnkey|installation|setup|commission/i.test(hay)) { ev.push('capital / project mode'); return mk('project', 'Grant / project procurement', 78, { gstLikely: true, approvalFlow: 'grant / PO (milestone)', quoteFormat: 'proforma for PO + installation scope', followUp: 'tied to project/grant timeline' }); }
    if (RND.test(hay) && small(s.orderScaleBand)) { ev.push('R&D intent + single/small qty'); return mk('research_prototype', 'Research prototype / trial unit', 80, { gstLikely: true, approvalFlow: 'PI / grant PO', quoteFormat: 'formal quote (single unit), spec-precise', followUp: 'spec-led, not price-led; patient timeline' }); }
    if (LAB.test(hay) || small(s.orderScaleBand)) { ev.push('lab / teaching intent or small qty'); return mk('lab_procurement', 'Lab procurement', 72, { gstLikely: true, approvalFlow: 'department PO', quoteFormat: 'formal itemised quote', followUp: 'spec-precise; GST invoice required' }); }
    ev.push('larger / recurring institutional buy');
    return mk('department_purchase', 'Department / institutional purchase', 70, { gstLikely: true, approvalFlow: 'department PO', quoteFormat: 'formal itemised quote', followUp: 'GST invoice + delivery to campus' });
  }

  // Non-institutional businesses / individuals — key off journey + mode + scale.
  if (RESALE.test(hay)) { ev.push('resale / trading journey'); return mk('resale_stock', 'Resale / stocking', 75, { gstLikely: true, approvalFlow: 'direct buy', quoteFormat: 'best landed rate, bulk slabs', followUp: 'price-led; repeat potential' }); }
  if (capitalMode) { ev.push('capital requirement mode'); return mk('capex', 'Capital purchase (capex)', 75, { gstLikely: true, approvalFlow: 'PO / finance approval', quoteFormat: 'proforma + installation/AMC', followUp: 'commercial + installation matter' }); }
  if (MAINT.test(hay)) { ev.push('maintenance / replacement intent'); return mk('maintenance', 'Maintenance / replacement', 72, { gstLikely: true, approvalFlow: 'direct buy', quoteFormat: 'fast quote, availability-led', followUp: 'speed > price' }); }
  if (PRODUCTION.test(hay) || /bulk|wholesale/i.test(s.orderScaleBand || '')) { ev.push('production-input / bulk'); return mk('production_input', 'Production input', 72, { gstLikely: true, approvalFlow: 'PO / credit', quoteFormat: 'bulk rate + cadence', followUp: 'recurring; credit terms' }); }
  if (/personal|individual|consumer|own use/i.test(hay)) { ev.push('personal / own-use intent'); return mk('one_off', 'Personal / one-off buy', 65, { gstLikely: false, approvalFlow: 'direct buy', quoteFormat: 'simple quote, COD/advance', followUp: 'consumer framing, no GST/credit' }); }
  ev.push('no decisive procurement signal yet');
  return mk('unknown', 'Procurement context — not yet clear', 0, { gstLikely: true, approvalFlow: 'direct buy', quoteFormat: 'standard quote', followUp: '' });
}
