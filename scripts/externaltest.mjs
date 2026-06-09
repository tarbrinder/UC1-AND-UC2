// Deterministic test for the External enrichment runner (E) — mirrors src/lib/externalRun.ts.
// Proves the ANTI-BOGUS gate (no web search without a unique anchor) + the per-source
// status logic (creds_pending when unconfigured, ok/no_record/skipped). No network, no LLM.

// ── mirror of anchorStrength ──
function anchorStrength(seed) {
  if (seed.gstin && /^[0-9A-Z]{15}$/i.test(String(seed.gstin).trim()))
    return { osintEligible: true, strongest: 'GSTIN', reason: 'GSTIN is a unique business identifier' };
  if (seed.website && /\./.test(seed.website))
    return { osintEligible: true, strongest: 'website', reason: 'a website resolves to exactly one business' };
  if (seed.companyName && seed.companyName.trim().length >= 4)
    return { osintEligible: true, strongest: 'company_name', reason: seed.city ? 'company name + city is specific enough' : 'company name is specific enough' };
  const have = [seed.mobile && 'mobile', seed.name && 'name', seed.city && 'city'].filter(Boolean).join('+') || 'nothing';
  return { osintEligible: false, strongest: have, reason: 'only a mobile/first-name — too weak to search the open web without returning the wrong company' };
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
ok('company name (≥4 chars) → OSINT eligible', anchorStrength({ companyName: 'Trident Electro Components' }).osintEligible === true);
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
ok('World not_run when eligible but no provider wired', statusOf(runExternal({ companyName: 'Trident Electro Components' }, {}, undefined), 'World') === 'not_run');
ok('World ok when eligible + provider returns a summary', statusOf(runExternal({ companyName: 'Trident Electro Components' }, {}, { summary: 'Electronic components distributor in Mumbai', match_basis: ['company_name'] }), 'World') === 'ok');
ok('World no_record when eligible + provider returns nothing', statusOf(runExternal({ companyName: 'Trident Electro Components' }, {}, {}), 'World') === 'no_record');

console.log(`\nexternaltest (anti-bogus gate + source status): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
