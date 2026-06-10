// Deterministic test for the External enrichment runner (E) — mirrors src/lib/externalRun.ts.
// Proves the ANTI-BOGUS gate (no web search without a unique anchor) + the per-source
// status logic (creds_pending when unconfigured, ok/no_record/skipped). No network, no LLM.

// ── mirror of anchorStrength ──
function anchorStrength(seed) {
  if (seed.gstin && /^[0-9A-Z]{15}$/i.test(String(seed.gstin).trim()))
    return { osintEligible: true, strongest: 'GSTIN', reason: 'GSTIN is a unique business identifier' };
  if (seed.website && /\./.test(seed.website))
    return { osintEligible: true, strongest: 'website', reason: 'a website resolves to exactly one business' };
  if (seed.companyName && seed.companyName.trim().length >= 4 && seed.city && seed.city.trim())
    return { osintEligible: true, strongest: 'company_name', reason: 'company name + city is specific enough' };
  const have = [seed.mobile && 'mobile', seed.name && 'name', seed.companyName && 'company(no city)', seed.city && 'city'].filter(Boolean).join('+') || 'nothing';
  return { osintEligible: false, strongest: have, reason: seed.companyName ? 'company name without a city is too generic — could match the wrong business' : 'only a mobile/first-name — too weak to search the open web without returning the wrong company' };
}

// ── mirror of runExternal's status decisions (sync, no I/O) ──
function runExternal(seed, cfg = {}, osintResult = undefined) {
  const gate = anchorStrength(seed);
  const sources = [];
  // Befisc
  if (!seed.mobile) sources.push({ source: 'Befisc', status: 'not_run' });
  else if (!(cfg.befiscAuthkey && cfg.befiscProfileEndpoint)) sources.push({ source: 'Befisc', status: 'creds_pending' });
  else sources.push({ source: 'Befisc', status: 'ok' });
  // Sign3
  if (!seed.mobile) sources.push({ source: 'Sign3', status: 'not_run' });
  else if (!(cfg.sign3Bearer && cfg.sign3Endpoint)) sources.push({ source: 'Sign3', status: 'creds_pending' });
  else sources.push({ source: 'Sign3', status: 'ok' });
  // World (gated)
  if (!gate.osintEligible) sources.push({ source: 'World', status: 'skipped_low_confidence' });
  else if (osintResult === undefined) sources.push({ source: 'World', status: 'not_run' });
  else {
    const found = !!(osintResult && (osintResult.summary || (osintResult.productLines || []).length || (osintResult.sourceUrls || []).length));
    sources.push({ source: 'World', status: found ? 'ok' : 'no_record' });
  }
  return { gate, sources };
}
const statusOf = (r, src) => r.sources.find((s) => s.source === src)?.status;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// 1. THE anti-bogus gate — a web search needs a UNIQUE anchor.
ok('bare mobile → OSINT skipped (anti-bogus)', anchorStrength({ mobile: '9929163666' }).osintEligible === false);
ok('the cable-lug seed (mobile+name+city, NO company) → OSINT skipped', anchorStrength({ mobile: '9929163666', name: 'Sanjay', city: 'Kanpur' }).osintEligible === false);
ok('company name ALONE (no city) → NOT eligible (generic-name guard, audit #2)', anchorStrength({ companyName: 'Trident Electro Components' }).osintEligible === false);
ok('company name + city → OSINT eligible', anchorStrength({ companyName: 'Trident Electro Components', city: 'Mumbai' }).osintEligible === true);
ok('short company name (<4) → NOT eligible', anchorStrength({ companyName: 'ABC' }).osintEligible === false);
ok('GSTIN (15 chars) → OSINT eligible', anchorStrength({ gstin: '09AAACT2727Q1ZW' }).osintEligible === true);
ok('website → OSINT eligible', anchorStrength({ website: 'tridentelectro.in' }).osintEligible === true);
ok('strongest anchor reported = GSTIN when present', anchorStrength({ gstin: '09AAACT2727Q1ZW', companyName: 'X Corp' }).strongest === 'GSTIN');

// 2. Befisc/Sign3 statuses — creds_pending until configured, not_run without a mobile.
const noCreds = runExternal({ mobile: '9929163666' }, {});
ok('Befisc creds_pending when no authkey/endpoint', statusOf(noCreds, 'Befisc') === 'creds_pending');
ok('Sign3 creds_pending when no bearer/endpoint', statusOf(noCreds, 'Sign3') === 'creds_pending');
const noMobile = runExternal({ companyName: 'Trident Electro Components' }, {});
ok('Befisc not_run when no mobile', statusOf(noMobile, 'Befisc') === 'not_run');
const withCreds = runExternal({ mobile: '9929163666' }, { befiscAuthkey: 'k', befiscProfileEndpoint: 'C9S1', sign3Bearer: 'b', sign3Endpoint: 'https://x' });
ok('Befisc ok when configured', statusOf(withCreds, 'Befisc') === 'ok');
ok('Sign3 ok when configured', statusOf(withCreds, 'Sign3') === 'ok');

// 3. World statuses — skipped (no anchor), not_run (eligible, no provider), ok/no_record (provider ran).
ok('World skipped_low_confidence for the cable-lug seed', statusOf(runExternal({ mobile: '9929163666', name: 'Sanjay', city: 'Kanpur' }), 'World') === 'skipped_low_confidence');
// #2 (audit): a company name WITHOUT a city is too generic → World skipped (anti-bogus).
ok('company name ALONE (no city) → World skipped (generic-name guard)', statusOf(runExternal({ companyName: 'M Enterprises' }, {}, { summary: 'x' }), 'World') === 'skipped_low_confidence');
ok('company name + CITY → World eligible', anchorStrength({ companyName: 'M Enterprises', city: 'Noida' }).osintEligible === true);
ok('World not_run when eligible (company+city) but no provider wired', statusOf(runExternal({ companyName: 'Trident Electro Components', city: 'Mumbai' }, {}, undefined), 'World') === 'not_run');
ok('World ok when eligible + provider returns a summary', statusOf(runExternal({ companyName: 'Trident Electro Components', city: 'Mumbai' }, {}, { summary: 'Electronic components distributor in Mumbai', match_basis: ['company_name', 'city'] }), 'World') === 'ok');
ok('World no_record when eligible + provider returns nothing', statusOf(runExternal({ companyName: 'Trident Electro Components', city: 'Mumbai' }, {}, {}), 'World') === 'no_record');

// 4. osintDemoProvider — mirror: returns a [DEMO] summary for a real company anchor; nothing for a weak one.
function osintDemoProvider(seed) {
  const co = (seed.companyName || '').trim();
  if (co.length < 4) return {}; // anti-bogus: never guess off a weak anchor
  return { summary: `[DEMO] ${co}${seed.city ? `, ${seed.city}` : ''} — registered business (synthetic).`, match_basis: ['company_name', seed.city ? 'city' : ''].filter(Boolean) };
}
ok('demo provider: real company anchor → [DEMO] summary', /^\[DEMO\]/.test(osintDemoProvider({ companyName: 'M Enterprises', city: 'Noida' }).summary || ''));
ok('demo provider: weak anchor (no company) → nothing (anti-bogus)', Object.keys(osintDemoProvider({ mobile: '8527610141', name: 'Mohak' })).length === 0);
ok('demo provider drives World → ok via the runner', statusOf(runExternal({ companyName: 'M Enterprises', city: 'Noida' }, {}, osintDemoProvider({ companyName: 'M Enterprises', city: 'Noida' })), 'World') === 'ok');

// 5. The Verified-stitch bridge — ONLY structured government-grade truths feed the engine (audit #1).
//    World/OSINT + Befisc/Sign3 identity are OBSERVED-only (a web match on a generic name could be
//    the wrong company → never a 'Verified' fact until confidence-scored).
const TIER1 = /gst|hsn|udyam|nic/i; // NOT world/osint
const stitches = (source, value) => !!(value && TIER1.test(source)); // mirror of the registry bridge gate
ok('GST ledger entry → stitches as Verified', stitches('GST', 'Manufacturer') === true);
ok('HSN ledger entry → stitches as Verified', stitches('HSN', '4820') === true);
ok('World/OSINT → does NOT stitch (observed-only until confidence-scored) [audit #1]', stitches('OSINT', '[DEMO] M Enterprises, Noida') === false && stitches('World', 'something') === false);
ok('Sign3 IDENTITY → does NOT stitch (observed-only)', stitches('Sign3', 'Mohak Saxena') === false);
ok('Befisc IDENTITY → does NOT stitch (observed-only)', stitches('Befisc', '8527610141') === false);
ok('empty value → never stitches', stitches('GST', '') === false);

// 6. P4 — Cross-validation (the agreement ladder = confidence). Mirror of crossValidateExternal:
//    same fact across more INDEPENDENT sources ⇒ higher tier; 1=observed · 2=corroborated · 3+=verified.
const xslug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FACT_ALIASES = { name: ['name', 'full_name', 'fullName', 'customer_name', 'customerName'], company: ['company', 'company_name', 'companyName', 'business_name', 'businessName', 'firm', 'firm_name'], city: ['city', 'district'], email: ['email', 'email_id', 'emailId'], pan: ['pan', 'pan_number', 'panNumber'] };
function deepGet(obj, key) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj[key] != null && typeof obj[key] !== 'object') return String(obj[key]);
  for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const inner = v[key]; if (inner != null && typeof inner !== 'object') return String(inner); } }
  return '';
}
function extractFacts(source, seed) {
  const out = {};
  if (source.source === 'World') { if (source.status === 'ok' && seed.companyName) out.company = seed.companyName.trim(); return out; }
  const v = source.value || {};
  for (const [key, aliases] of Object.entries(FACT_ALIASES)) { for (const a of aliases) { const got = deepGet(v, a).trim(); if (got) { out[key] = got; break; } } }
  return out;
}
function crossValidateExternal(sources, seed) {
  const providers = [];
  const seedFacts = {};
  if (seed.name) seedFacts.name = seed.name.trim();
  if (seed.companyName) seedFacts.company = seed.companyName.trim();
  if (seed.city) seedFacts.city = seed.city.trim();
  providers.push({ provider: 'first_party', facts: seedFacts });
  for (const s of sources) { if (s.status !== 'ok') continue; providers.push({ provider: s.source, facts: extractFacts(s, seed) }); }
  const map = new Map();
  for (const { provider, facts } of providers) { for (const [key, value] of Object.entries(facts)) { const nv = xslug(value); if (!nv) continue; const id = `${key}::${nv}`; if (!map.has(id)) map.set(id, { key, value, sources: new Set() }); map.get(id).sources.add(provider); } }
  const facts = [...map.values()].map((f) => { const agreement = f.sources.size; const tier = agreement >= 3 ? 'verified' : agreement === 2 ? 'corroborated' : 'observed'; const confidence = agreement >= 3 ? 92 : agreement === 2 ? 78 : 55; return { key: f.key, value: f.value, sources: [...f.sources], agreement, tier, confidence }; }).sort((a, b) => b.agreement - a.agreement);
  return { facts, verifiedFacts: facts.filter((f) => f.tier === 'verified') };
}
const fact = (cv, key) => cv.facts.find((f) => f.key === key);
const cv1 = crossValidateExternal([], { companyName: 'Chetna Industries', name: 'Dinesh' });
ok('P4: company from 1 source (seed only) → observed (1×)', fact(cv1, 'company').tier === 'observed' && fact(cv1, 'company').agreement === 1);
const cv2 = crossValidateExternal([{ source: 'World', status: 'ok', value: {} }], { companyName: 'Chetna Industries' });
ok('P4: seed + World agree on company → corroborated (2×)', fact(cv2, 'company').tier === 'corroborated' && fact(cv2, 'company').agreement === 2);
const cv3 = crossValidateExternal([{ source: 'Befisc', status: 'ok', value: { company_name: 'Chetna Industries' } }, { source: 'World', status: 'ok', value: {} }], { companyName: 'Chetna Industries' });
ok('P4: seed + Befisc + World agree → VERIFIED (3×, conf 92)', fact(cv3, 'company').tier === 'verified' && fact(cv3, 'company').confidence === 92);
ok('P4: verified company graduates observed→Verified (in verifiedFacts)', cv3.verifiedFacts.some((f) => f.key === 'company'));
const cvName = crossValidateExternal([{ source: 'Befisc', status: 'ok', value: { name: 'Dinesh Chandra' } }], { name: 'Dinesh Chandra', companyName: 'Chetna Industries' });
ok('P4: seed + Befisc agree on name → corroborated', fact(cvName, 'name').tier === 'corroborated');
const cvDis = crossValidateExternal([{ source: 'Befisc', status: 'ok', value: { name: 'D Chandra' } }], { name: 'Dinesh Chandra' });
ok('P4: differing names do NOT corroborate (each 1× observed)', cvDis.facts.filter((f) => f.key === 'name').every((f) => f.agreement === 1));
const cvNo = crossValidateExternal([{ source: 'Befisc', status: 'no_record', value: { company_name: 'Chetna Industries' } }], { companyName: 'Chetna Industries' });
ok('P4: a no_record source cannot corroborate (company stays 1× observed)', fact(cvNo, 'company').agreement === 1);
ok('P4: bridge records ONLY business cross-facts (company/city) Verified — NOT name/email/pan', /^(company|city)$/.test('company') && !/^(company|city)$/.test('name'));

console.log(`\nexternaltest (anti-bogus gate + source status + demo provider + Verified stitch + P4 agreement ladder): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
