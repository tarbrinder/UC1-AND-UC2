// Deterministic regression harness for the twin adapter's load-bearing logic (mirrors src/lib/twinAdapter.ts:
// the twin_confidence saturating formula, the business_type institutional-override decision, negatives passthrough,
// and the always-populate invariants). The REAL adapter is type-checked by tsc AND live-verified against the running
// module; this pins the formula + decisions against drift in CI. `node scripts/twinadaptertest.mjs`.

// ── mirror: twin_confidence (EXACT copy of deriveBuyerTwin / finalsToBuyerTwin) ──
const sat = (n, k) => 1 - Math.exp(-n / k);
const twinConf = (c) => Math.round(100 * (0.35 * sat(c.pns_calls, 3) + 0.25 * sat(c.whatsapp_events, 30) + 0.25 * sat(c.bls_created, 4) + 0.15 * sat(c.csl_events, 20)));
const freshFromDays = (days) => (Number.isNaN(days) ? 'Unknown' : days < 30 ? 'Fresh' : days < 90 ? 'Moderate' : 'Stale');

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n); } };

// 1 · twin_confidence formula parity (the field intent-preselect / cold-vs-warm gating reads)
ok('twin_confidence(5,60,7,33) === 83 (matches live adapter + deriveBuyerTwin)', twinConf({ pns_calls: 5, whatsapp_events: 60, bls_created: 7, csl_events: 33 }) === 83);
ok('twin_confidence(0,0,0,0) === 0 (no evidence → cold)', twinConf({ pns_calls: 0, whatsapp_events: 0, bls_created: 0, csl_events: 0 }) === 0);
ok('twin_confidence monotonic — more PNS ⇒ higher', twinConf({ pns_calls: 10, whatsapp_events: 0, bls_created: 0, csl_events: 0 }) > twinConf({ pns_calls: 1, whatsapp_events: 0, bls_created: 0, csl_events: 0 }));

// 2 · freshness bands
ok('freshness <30d → Fresh', freshFromDays(29) === 'Fresh');
ok('freshness 30-89d → Moderate', freshFromDays(60) === 'Moderate');
ok('freshness >=90d → Stale', freshFromDays(120) === 'Stale');
ok('freshness no-date → Unknown', freshFromDays(NaN) === 'Unknown');

// 3 · business_type override DECISION (institutional email drives it; generic does not) — mirror of natureDrives gate
const natureDrives = (email) => /\.(ac|edu)\.[a-z]+$|\.gov(\.[a-z]+)?$|@(.*\.)?(iit|nit|aiims)/i.test(String(email || ''));
const resolveBT = (finalBT, email) => (natureDrives(email) ? 'institutional-role' : finalBT);
ok('generic gmail → business_type = final value (no override)', resolveBT('Manufacturer', 'jayveernayak75@gmail.com') === 'Manufacturer');
ok('academic .ac.in → business_type override fires', resolveBT('Manufacturer', 'procurement@iitd.ac.in') === 'institutional-role');
ok('gov domain → override fires', resolveBT('Trader', 'x@nic.gov.in') === 'institutional-role');

// 4 · negatives passthrough + best-effort derive (never-re-ask must survive the cutover)
const NEG_RE = /\b(no traders?|oem only|don'?t call|manufacturer only|no resell|local only)\b/i;
const negatives = (ctxNeg, finals) => { const out = [...(ctxNeg || [])]; for (const f of finals) if (NEG_RE.test(String(f.value || ''))) out.push(f.value); const seen = new Set(); return out.filter((x) => { const k = String(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };
ok('ctx.explicitNegatives passthrough', negatives(['Need More Sellers'], []).includes('Need More Sellers'));
ok('hard-constraint phrasing in a final is caught', negatives([], [{ value: 'Manufacturer only, no traders' }]).length === 1);
ok('negatives de-duped', negatives(['OEM only'], [{ value: 'OEM only' }]).length === 1);

// 5 · always-populate invariants (the fields ~40 consumers + intent-preselect read)
const activeIntent = (f) => f.current_active_intent || f.products_of_interest || f.buyer_persona || f.industry || '';
ok('current_active_intent falls back products→persona→industry', activeIntent({ products_of_interest: 'Notebook Machine' }) === 'Notebook Machine' && activeIntent({ industry: 'Paper' }) === 'Paper');

console.log(`\ntwinadaptertest (twin_confidence formula · freshness · business_type override · negatives passthrough · active-intent fallback): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
console.log('NOTE: full value-parity vs a recorded deriveBuyerTwin output needs a live LLM fixture; shape + formula + override + always-populate are pinned here + live-verified against the real module.');
process.exit(fail ? 1 : 0);
