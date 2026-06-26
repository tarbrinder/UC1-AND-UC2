// Deterministic test for the INTELLIGENCE CONSUMPTION ENGINE — mirrors src/lib/consumption.ts.
// Transfer = "what CAN I reuse?"; Consumption = "what SHOULD actually shape THIS RFQ?". A researcher is
// still a researcher buying an office chair (it TRANSFERS) but must NOT drive the chair's questions (it's
// not CONSUMED as a driver). Salience = fact KIND + coarse product shape (archetype + order scale). NO
// category literals, NO LLM, NO network.

const FACT_PROFILE = {
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
function processMatters(archetype, orderScale) {
  if (/capital|project|made_to_spec|branded/i.test(archetype || '')) return true;
  if (/industrial|wholesale|bulk/i.test(orderScale || '')) return true;
  return false;
}
const RANK = { high: 3, medium: 2, low: 1 };
function consume(items, context = {}) {
  const procMatters = processMatters(context.archetype, context.orderScale);
  const consumed = (items || []).filter((it) => it && it.key).map((it) => {
    const prof = FACT_PROFILE[it.key] || (it.key.startsWith('history:') || it.key.startsWith('theme:') || it.tier === 'C' ? { dims: ['intent'], base: 'high' } : { dims: ['process'], base: 'low' });
    const salience = prof.processWeighted ? (procMatters ? 'high' : 'low') : prof.base;
    return { key: it.key, value: it.value, tier: it.tier, salience, dimensions: prof.dims };
  });
  const drivers = consumed.filter((c) => c.salience !== 'low' && !(c.dimensions.length === 1 && c.dimensions[0] === 'routing')).sort((a, b) => RANK[b.salience] - RANK[a.salience]);
  const quiet = consumed.filter((c) => !drivers.includes(c));
  return { consumed, drivers, quiet, processMatters: procMatters };
}
const isDriver = (r, key) => r.drivers.some((d) => d.key === key);
const isQuiet = (r, key) => r.quiet.some((q) => q.key === key);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// Jaiveer's transferred set for a generator (A+B, no C — from the transfer engine)
const jaiveerGen = [
  { key: 'business type', value: 'Manufacturer', tier: 'A' },
  { key: 'region', value: 'Auraiya', tier: 'A' },
  { key: 'language', value: 'Hindi', tier: 'A' },
  { key: 'procurement model', value: 'Recurring Supply', tier: 'B' },
  { key: 'local preference', value: 'Local Only', tier: 'B' },
  { key: 'communication', value: 'WhatsApp Friendly', tier: 'B' },
];

// ── the reviewer's table: which traits should CONSUME for a Diesel Generator (industrial) ──
const gen = consume(jaiveerGen, { orderScale: 'industrial' });
ok('GEN: manufacturer DRIVES (industrial vs domestic, phase, install)', isDriver(gen, 'business type'));
ok('GEN: region DRIVES (freight + local supplier)', isDriver(gen, 'region'));
ok('GEN: procurement model DRIVES (capital commercial terms)', isDriver(gen, 'procurement model'));
ok('GEN: local preference DRIVES (supplier radius)', isDriver(gen, 'local preference'));
ok('GEN: language is QUIET (seller routing, never a question)', isQuiet(gen, 'language'));
ok('GEN: communication channel is QUIET (routing, not the RFQ)', isQuiet(gen, 'communication'));

// ── CASE 4 — the heart of it: authority drives a capital buy, goes quiet for a plain commodity ──
const withAuthority = [
  { key: 'business type', value: 'Research Institution', tier: 'A' },
  { key: 'nature', value: 'Academic / Research Institution', tier: 'A' },
  { key: 'authority', value: 'Researcher', tier: 'A' },
  { key: 'region', value: 'Kanpur', tier: 'A' },
];
const labEquip = consume(withAuthority, { archetype: 'capital' });        // lab equipment → capital
const officeChair = consume(withAuthority, { archetype: 'commodity', orderScale: 'small' }); // office chair → commodity
ok('CASE 3 — Lab Equipment (capital): authority/researcher DRIVES (PO/tender/spec-precision real)', isDriver(labEquip, 'authority') && labEquip.processMatters);
ok('CASE 4 — Office Chair (commodity): authority/researcher goes QUIET (does NOT dominate)', isQuiet(officeChair, 'authority') && !officeChair.processMatters);
ok('CASE 4 — but region STILL drives the chair (freight is always relevant)', isDriver(officeChair, 'region'));
ok('CASE 4 — nature (institution) still carried, business type still a driver', isDriver(officeChair, 'business type'));
ok('the SAME researcher fact flips driver→quiet purely on product shape (consumption, not transfer)', isDriver(labEquip, 'authority') && isQuiet(officeChair, 'authority'));

// ── process-weighting via order scale (no archetype yet, e.g. at page-1 intent time) ──
ok('procurement model DRIVES for an industrial-scale order (scale alone)', isDriver(consume([{ key: 'procurement model', value: 'Capex', tier: 'B' }], { orderScale: 'industrial' }), 'procurement model'));
ok('procurement model goes QUIET for a tiny commodity order', isQuiet(consume([{ key: 'procurement model', value: 'Capex', tier: 'B' }], { orderScale: 'single' }), 'procurement model'));
ok('processMatters: capital archetype → true', processMatters('capital', 'single') === true);
ok('processMatters: commodity + small → false', processMatters('commodity', 'small') === false);
ok('processMatters: industrial order overrides a missing archetype → true', processMatters(undefined, 'wholesale') === true);

// ── always/never salience invariants ──
ok('region is ALWAYS a driver (logistics, every product)', isDriver(consume([{ key: 'region', value: 'X', tier: 'A' }], {}), 'region'));
ok('language is NEVER a driver (routing-only)', !isDriver(consume([{ key: 'language', value: 'Hindi', tier: 'A' }], { archetype: 'capital' }), 'language'));
ok('Tier-C category history is an intent driver when present', isDriver(consume([{ key: 'history: Notebook Making Machine', value: 'Notebook Making Machine', tier: 'C' }], {}), 'history: Notebook Making Machine'));
ok('drivers are ranked high→medium', (() => { const r = consume([{ key: 'maturity', value: 'm', tier: 'A' }, { key: 'business type', value: 'b', tier: 'A' }], {}); return r.drivers[0].key === 'business type'; })());

// ── robustness ──
ok('empty intelligence → no drivers, no crash', consume([], {}).drivers.length === 0);
ok('unknown fact key → defaults to low/process (carried, quiet)', isQuiet(consume([{ key: 'mystery', value: 'x', tier: 'B' }], {}), 'mystery'));

console.log(`\nconsumptiontest (Intelligence Consumption: salience by fact-kind × product shape · process-weighted authority/procurement · routing always quiet · case-4 chair-vs-lab): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
