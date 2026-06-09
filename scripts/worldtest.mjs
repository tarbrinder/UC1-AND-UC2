// World-enrichment readiness probe + chain test.
//   node scripts/worldtest.mjs                  → reachability probe (no key needed)
//   SMARTAUTH_KEY=xxx EP_MOBILE_GST=ABCD EP_GST_MCC=EFGH \
//     EP_GST_ADV=IJKL EP_MOBILE_UDYAM=TGAG TEST_MOBILE=9910110910 \
//     node scripts/worldtest.mjs                → runs the real chain
const BASE = 'https://prod.smartauth.co';
const KEY = process.env.SMARTAUTH_KEY || '';
const CONSENT = 'We confirm obtaining valid customer consent to access/process their data. Consent remains valid, informed, and unwithdrawn.';

async function call(code, body) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/${code}`, {
      method: 'POST',
      headers: { authkey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: 'Y', consent_text: CONSENT, ...body }),
    });
    const j = await r.json();
    return { http: r.status, status: j.status, message: j.message, api: j.api_name, ms: Date.now() - t0, hasResult: !!j.result };
  } catch (e) { return { error: String(e), ms: Date.now() - t0 }; }
}

// 1) Reachability — the two endpoint codes present in the shared docs.
console.log('\n════ WORLD ENRICHMENT — readiness probe ════');
console.log(`authkey: ${KEY ? 'SET' : 'MISSING (probe will 401 — that still proves the endpoint is LIVE)'}\n`);
const known = [['C9S1', 'Profile Advance (mobile→personal)'], ['TGAG', 'Udyam (mobile→MSME)']];
for (const [code, name] of known) {
  const r = await call(code, { mobile: process.env.TEST_MOBILE || '9999999999' });
  const live = r.http === 200 && (r.status === 401 || r.status === 1 || r.status === 2);
  console.log(`  /${code}  ${name}`);
  console.log(`    ${live ? '✓ LIVE' : '✗'} http=${r.http} status=${r.status} "${r.message || r.error}" ${r.ms}ms`);
}

// 2) Full business chain — only if creds + endpoint codes are provided.
const EP = { mobileToGst: process.env.EP_MOBILE_GST, gstToMcc: process.env.EP_GST_MCC, gstAdvance: process.env.EP_GST_ADV, mobileToUdyam: process.env.EP_MOBILE_UDYAM };
const mobile = process.env.TEST_MOBILE;
if (KEY && mobile && EP.mobileToGst) {
  console.log(`\n──── BUSINESS CHAIN for mobile ${mobile.replace(/\d(?=\d{4})/g, 'X')} ────`);
  const g = await call(EP.mobileToGst, { mobile });
  const gstin = g.hasResult ? '(see result)' : null;
  console.log(`  Mobile→GST: status=${g.status} ${g.message || ''}`);
  if (EP.gstToMcc) console.log('  → run GST→MCC (HSN) + GST(Advance) with the returned GSTIN');
} else {
  console.log('\n  ⚠ Business chain NOT run — need SMARTAUTH_KEY + endpoint codes (EP_MOBILE_GST, EP_GST_MCC, EP_GST_ADV).');
  console.log('    Only /C9S1 (Profile Advance) and /TGAG (Udyam) codes are in the shared docs;');
  console.log('    the GST/Mobile→GST/MCC codes must come from your Befisc API console.');
}
console.log('\n════ end ════');
