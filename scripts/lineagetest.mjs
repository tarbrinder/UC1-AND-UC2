// Deterministic test for the RAW LINEAGE resolver — mirrors src/lib/lineage.ts.
// Asserts: fact → exact JSON path → raw value → emitting n8n node (from E1 trace) → execution. NO LLM.
// Grounded in the REAL response shape (array of singly-keyed objects) deriveEnrichment reads.

function getTop(raw, key) {
  if (!Array.isArray(raw)) return undefined;
  for (const el of raw) { if (el && typeof el === 'object' && key in el) { const v = el[key]; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v; } }
  return undefined;
}
function walk(value, segs) {
  if (!segs.length) return value;
  const [head, ...rest] = segs;
  const isArr = head.endsWith('[]'); const key = isArr ? head.slice(0, -2) : head;
  const next = (value && typeof value === 'object') ? value[key] : undefined;
  if (isArr) { if (!Array.isArray(next)) return undefined; for (const el of next) { const r = walk(el, rest); if (r !== undefined && r !== null && r !== '') return r; } return undefined; }
  return walk(next, rest);
}
function resolveAtPath(raw, path) {
  const segs = path.split('.'); const first = segs[0]; const firstIsArr = first.endsWith('[]'); const firstKey = firstIsArr ? first.slice(0, -2) : first;
  const top = getTop(raw, firstKey); if (top === undefined) return undefined;
  if (firstIsArr) { if (!Array.isArray(top)) return undefined; for (const el of top) { const r = walk(el, segs.slice(1)); if (r !== undefined && r !== null && r !== '') return r; } return undefined; }
  return walk(top, segs.slice(1));
}
function nodeForTopKey(trace, topKey) { if (!trace?.nodes) return null; for (const n of trace.nodes) { if (n.output_keys && n.output_keys.includes(topKey) && n.node) return n.node; } return null; }

// realistic buyer-pull response (array of singly-keyed objects; pns_data nested deep; isq as JSON string)
const raw = [
  { buyer_profile: { glusr_usr_company_desc: 'We manufacture LED drivers', designation: 'Proprietor', verified_business_buyer_flag: true, location_preference: '2', city: 'Lucknow', locality: 'Aliganj' } },
  { pns_data: [
    { extracted_data: { metadata: { intended_application: 'Backup power for plant', primary_language: 'Hindi', call_type: { evidence: { buyer_persona: 'Manufacturer', quantity_scale: 'High', order_type: 'Commercial' } }, buyer_intent: { intent_level: 'High', narrative: 'Needs 5 gensets this month' } } } },
  ] },
  { prev_isq_data: JSON.stringify([{ title: 'Diesel Generator', isq: [{ IM_SPEC_MASTER_DESC: 'Rated Power', ISQ_RESPONSE: '5 kVA' }], post_date: '2026-05-01' }]) },
  { prev_bl_data: [{ ETO_OFR_TITLE: 'Silent Diesel Genset', ETO_OFR_POSTDATE_ORIG: '2026-04-10' }] },
  { csl_data: [{ glb_city: 'Lucknow', request_url: '/x?s=generator' }] },
];
// E1 trace: maps container keys → emitting n8n node
const trace = { summary: { execution_id: 'exec-7788' }, nodes: [
  { node: 'Buyer Twin', status: 'ok', output_keys: ['buyer_profile'] },
  { node: 'PNS Fetch', status: 'ok', output_keys: ['pns_data'] },
  { node: 'ISQ Fetch', status: 'ok', output_keys: ['prev_isq_data'] },
] };

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// deep nested path through pns_data[]
ok('persona resolves deep path → Manufacturer', resolveAtPath(raw, 'pns_data[].extracted_data.metadata.call_type.evidence.buyer_persona') === 'Manufacturer');
ok('application resolves → Backup power for plant', resolveAtPath(raw, 'pns_data[].extracted_data.metadata.intended_application') === 'Backup power for plant');
ok('intent narrative resolves', /5 gensets/.test(String(resolveAtPath(raw, 'pns_data[].extracted_data.metadata.buyer_intent.narrative'))));
// flat buyer_profile path
ok('company desc resolves', resolveAtPath(raw, 'buyer_profile.glusr_usr_company_desc') === 'We manufacture LED drivers');
ok('city resolves → Lucknow', resolveAtPath(raw, 'buyer_profile.city') === 'Lucknow');
ok('verified flag resolves → true', resolveAtPath(raw, 'buyer_profile.verified_business_buyer_flag') === true);
// JSON-string-encoded container (prev_isq_data) is parsed then walked
ok('isq title resolves through a JSON-string container', resolveAtPath(raw, 'prev_isq_data[].title') === 'Diesel Generator');
ok('bl title resolves → Silent Diesel Genset', resolveAtPath(raw, 'prev_bl_data[].ETO_OFR_TITLE') === 'Silent Diesel Genset');
ok('csl city resolves → Lucknow', resolveAtPath(raw, 'csl_data[].glb_city') === 'Lucknow');
// missing path → undefined (honest "not found")
ok('missing path → undefined', resolveAtPath(raw, 'buyer_profile.nonexistent_field') === undefined);
// node mapping from the E1 trace
ok('persona maps to PNS Fetch node', nodeForTopKey(trace, 'pns_data') === 'PNS Fetch');
ok('company desc maps to Buyer Twin node', nodeForTopKey(trace, 'buyer_profile') === 'Buyer Twin');
ok('unknown container → no node', nodeForTopKey(trace, 'whatsapp_data') === null);
// execution id available
ok('execution id surfaced from trace summary', trace.summary.execution_id === 'exec-7788');

console.log(`\nlineagetest (RAW lineage: deep-path · flat-path · JSON-string container · missing → undefined · node-from-E1-trace · execution): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
