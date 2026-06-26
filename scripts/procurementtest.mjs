// Deterministic test for the PROCUREMENT CONTEXT ENGINE (P3) — mirrors src/lib/procurement.ts.
// The same product is a different REQUIREMENT depending on the procurement process: research prototype /
// lab / project / department / institutional supply / capex / production / resale / maintenance / one-off.
// Keys off Nature + authority + journey/intent + scale + mode — NO category literals. NO LLM, NO network.

const RND = /research|\br&?d\b|prototype|develop|experiment|proof.?of.?concept|poc\b/i;
const LAB = /\blab\b|laborator|testing|test\s*bench|characteris|measurement|teaching|training|academ/i;
const RESALE = /resale|resell|reseller|trading|distribut|wholesal|stock(?!\s*out)|retail/i;
const PRODUCTION = /production|manufactur|assembly|process(?:ing)?\s*line|plant\s*input|raw\s*material/i;
const MAINT = /maintenance|repair|replacement|spare|amc|breakdown|servicing/i;
const INSTITUTIONAL = (n) => /academic|research|government|psu/i.test(n || '');
const small = (b) => b === 'single' || b === 'small';

function classifyProcurement(s) {
  const hay = `${s.journey || ''} ${s.intentText || ''}`;
  const mk = (context, gstLikely) => ({ context, implications: { gstLikely } });
  const institutional = INSTITUTIONAL(s.nature);
  const procurementRole = /procurement/i.test(s.authorityRole || '');
  const capitalMode = /capital|project/i.test(s.requirementMode || '');
  if (institutional) {
    if (procurementRole || /tender|rate.?contract/i.test(hay)) return mk('institutional_supply', true);
    if (capitalMode || /turnkey|installation|setup|commission/i.test(hay)) return mk('project', true);
    if (RND.test(hay) && small(s.orderScaleBand)) return mk('research_prototype', true);
    if (LAB.test(hay) || small(s.orderScaleBand)) return mk('lab_procurement', true);
    return mk('department_purchase', true);
  }
  if (RESALE.test(hay)) return mk('resale_stock', true);
  if (capitalMode) return mk('capex', true);
  if (MAINT.test(hay)) return mk('maintenance', true);
  if (PRODUCTION.test(hay) || /bulk|wholesale/i.test(s.orderScaleBand || '')) return mk('production_input', true);
  if (/personal|individual|consumer|own use/i.test(hay)) return mk('one_off', false);
  return mk('unknown', true);
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const ctx = (s) => classifyProcurement(s).context;
const gst = (s) => classifyProcurement(s).implications.gstLikely;

// ── IIT Kanpur (academic) — the SAME battery, different process by intent + scale ──
ok('IIT + R&D intent + single qty → research_prototype', ctx({ nature: 'Academic / Research Institution', journey: 'industrial', intentText: 'Research and development', orderScaleBand: 'single' }) === 'research_prototype');
ok('IIT + lab/testing intent → lab_procurement', ctx({ nature: 'Academic / Research Institution', intentText: 'Testing and prototyping equipment', orderScaleBand: 'small' }) === 'lab_procurement');
ok('IIT + capital/project mode → project', ctx({ nature: 'Academic / Research Institution', intentText: 'new setup', requirementMode: 'capital' }) === 'project');
ok('IIT + procurement authority → institutional_supply (tender)', ctx({ nature: 'Academic / Research Institution', authorityRole: 'procurement' }) === 'institutional_supply');
ok('IIT + large/recurring → department_purchase', ctx({ nature: 'Academic / Research Institution', intentText: 'annual stock', orderScaleBand: 'bulk' }) === 'department_purchase');

// ── THE GST FIX: an institution needs a GST invoice in EVERY procurement context (even qty 1) ──
ok('GST: research_prototype (institution, qty 1) → GST needed (the IIT gap fix)', gst({ nature: 'Academic / Research Institution', intentText: 'Research and development', orderScaleBand: 'single' }) === true);
ok('GST: lab_procurement → GST needed', gst({ nature: 'Academic / Research Institution', orderScaleBand: 'single' }) === true);
ok('GST: government PSU buy → GST needed', gst({ nature: 'Government / PSU', orderScaleBand: 'single' }) === true);

// ── non-institutional businesses ──
ok('corporate + resale journey → resale_stock', ctx({ nature: 'Corporate / Business', journey: 'resale', intentText: 'for resale to customers' }) === 'resale_stock');
ok('corporate + capital mode → capex', ctx({ nature: 'Corporate / Business', requirementMode: 'capital' }) === 'capex');
ok('corporate + maintenance intent → maintenance', ctx({ nature: 'Corporate / Business', intentText: 'replacement spare for breakdown' }) === 'maintenance');
ok('corporate + production/bulk → production_input', ctx({ nature: 'Corporate / Business', journey: 'industrial', intentText: 'raw material for production line', orderScaleBand: 'wholesale' }) === 'production_input');

// ── personal / one-off → NO GST (consumer) ──
ok('personal/own-use intent → one_off', ctx({ intentText: 'for my own personal use' }) === 'one_off');
ok('GST: personal one-off → NOT needed (consumer, no GST/credit)', gst({ intentText: 'for my own personal use at home' }) === false);

// ── unknown when no decisive signal ──
ok('no signals → unknown', ctx({}) === 'unknown');

// ── the headline: SAME product (battery), DIFFERENT context purely by buyer+intent ──
ok('same battery: IIT-R&D = research_prototype, but a trader = resale_stock', ctx({ nature: 'Academic / Research Institution', intentText: 'R&D', orderScaleBand: 'single' }) !== ctx({ nature: 'Corporate / Business', journey: 'resale', intentText: 'resale' }));

console.log(`\nprocurementtest (P3: research-prototype/lab/project/department/institutional/capex/production/resale/maintenance · institution→GST · same product different process): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
