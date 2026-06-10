// Contract test for Identity Resolution (P3, the "Dinesh mechanism") — mirrors src/lib/identity.ts
// (repo harness pattern: re-implement pure logic inline). Proves multi-anchor stitching via UNIVERSAL
// structural cross-checks (PAN entity letter, GST↔PAN embed, GST state, email↔company echo), composite
// confidence that RISES on agreement + FALLS on conflict, and chaos-safety (malformed inputs ignored).

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;
const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/i;
const PAN_ENTITY = { P: 'Individual / Proprietor', C: 'Company', H: 'HUF', F: 'Firm / LLP', A: 'Association of Persons', T: 'Trust', B: 'Body of Individuals', L: 'Local Authority', J: 'Artificial Juridical Person', G: 'Government' };
const GST_STATE = { '07': 'Delhi', '09': 'Uttar Pradesh', '24': 'Gujarat', '27': 'Maharashtra', '29': 'Karnataka', '33': 'Tamil Nadu' };
const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const last10 = (m) => (m || '').replace(/\D/g, '').slice(-10);

function resolveIdentity(a) {
  const evidence = [], agreements = [], conflicts = [];
  const name = (a.name || '').trim(), company = (a.company || '').trim();
  const email = (a.email || '').trim().toLowerCase();
  const emailDomain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : '';
  const mob = last10(a.mobile);
  const pan = PAN_RE.test((a.pan || '').trim()) ? (a.pan || '').trim().toUpperCase() : '';
  const gst = GST_RE.test((a.gst || '').trim()) ? (a.gst || '').trim().toUpperCase() : '';
  const city = (a.city || '').trim(), state = (a.state || '').trim();
  const present = [['name', !!name], ['mobile', mob.length === 10], ['company', company.length >= 2], ['email', !!emailDomain], ['pan', !!pan], ['gst', !!gst], ['city', !!city]];
  const anchorsPresent = present.filter(([, ok]) => ok).map(([k]) => k);
  let entityType;
  if (pan) { entityType = PAN_ENTITY[pan[3].toUpperCase()] || 'Unknown entity type'; evidence.push(`PAN entity letter "${pan[3].toUpperCase()}" → ${entityType}`); }
  let gstState;
  if (gst) { gstState = GST_STATE[gst.slice(0, 2)]; if (gstState) evidence.push(`GST state code ${gst.slice(0, 2)} → ${gstState}`); }
  if (gst && pan) { const gp = gst.slice(2, 12); if (gp === pan) agreements.push('GST embeds the same PAN'); else conflicts.push(`GST embeds PAN ${gp} but PAN is ${pan}`); }
  else if (gst && !pan) evidence.push(`GST embeds PAN ${gst.slice(2, 12)} (derived)`);
  if (gstState && state) { if (slug(gstState).includes(slug(state)) || slug(state).includes(slug(gstState))) agreements.push('GST state matches stated state'); else conflicts.push(`GST state (${gstState}) ≠ stated state (${state})`); }
  if (emailDomain && company && !/^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|rediffmail|rediff|icloud|me|protonmail|proton|zoho|aol|gmx)\./.test(emailDomain)) {
    const co = slug(company), dom = slug(emailDomain.split('.')[0]);
    if (co && dom && (co.includes(dom) || dom.includes(co))) agreements.push('email domain echoes the company name');
  }
  if (entityType && company.length >= 2) { if (pan[3].toUpperCase() === 'P') evidence.push('individual PAN with a company name — likely proprietorship'); else if (pan[3].toUpperCase() === 'C') agreements.push('company PAN aligns with company name'); }
  const allNames = [name, ...((a.altNames) || [])].map((n) => (n || '').trim()).filter(Boolean);
  if (allNames.length >= 2) {
    const tok = (n) => new Set(n.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));
    const prime = tok(allNames[0]);
    const unrelated = allNames.slice(1).filter((n) => { const t = tok(n); return t.size > 0 && ![...t].some((x) => prime.has(x)); });
    const uniq = [...new Set(allNames)];
    if (unrelated.length) conflicts.push(`name appears as unrelated variants: ${uniq.join(' / ')}`);
    else if (uniq.length >= 2) agreements.push('name corroborated across sources');
  }
  const W = { gst: 25, pan: 20, email: 15, company: 15, mobile: 10, name: 8, city: 7 };
  const presenceScore = Math.min(85, anchorsPresent.reduce((s, k) => s + (W[k] || 0), 0));
  const agreementBonus = Math.min(15, agreements.length * 8);
  const conflictPenalty = conflicts.length * 25;
  const compositeConfidence = Math.max(0, Math.min(100, Math.round(presenceScore + agreementBonus - conflictPenalty)));
  const identityStrength = compositeConfidence >= 80 ? 'strong' : compositeConfidence >= 55 ? 'moderate' : compositeConfidence >= 30 ? 'weak' : 'thin';
  return { anchorsPresent, anchorCount: anchorsPresent.length, entityType, gstState, agreements, conflicts, compositeConfidence, identityStrength, evidence };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the "Dinesh" case: every anchor agrees → strong identity ──
// GST 27 + PAN AAAPL1234C (Maharashtra, embeds the PAN), email echoes company, state matches.
const dinesh = resolveIdentity({ name: 'Dinesh Chandra', mobile: '9319312172', company: 'Chetna Industries', email: 'dinesh@chetnaindustries.com', pan: 'AAAPL1234C', gst: '27AAAPL1234C1Z5', city: 'Mumbai', state: 'Maharashtra' });
ok('Dinesh: all 7 anchors present', dinesh.anchorCount === 7);
ok('Dinesh: GST embeds same PAN → agreement', dinesh.agreements.some((x) => /embeds the same PAN/.test(x)));
ok('Dinesh: email echoes company → agreement', dinesh.agreements.some((x) => /echoes the company/.test(x)));
ok('Dinesh: GST state matches → agreement', dinesh.agreements.some((x) => /state matches/.test(x)));
ok('Dinesh: NO conflicts', dinesh.conflicts.length === 0);
ok('Dinesh: entity = Individual / Proprietor (PAN 4th = P)', dinesh.entityType === 'Individual / Proprietor');
ok('Dinesh: gstState = Maharashtra', dinesh.gstState === 'Maharashtra');
ok('Dinesh: strong identity', dinesh.identityStrength === 'strong' && dinesh.compositeConfidence >= 80);

// ── company PAN (4th = C) ──
const corp = resolveIdentity({ company: 'Veka Industries', email: 'sales@veka.in', pan: 'AAACV1234C', gst: '24AAACV1234C1ZP', state: 'Gujarat' });
ok('Corporate PAN → entity Company', corp.entityType === 'Company');
ok('Corporate: company PAN aligns → agreement', corp.agreements.some((x) => /company PAN aligns/.test(x)));

// ── CONFLICT cases lower confidence ──
const panMismatch = resolveIdentity({ pan: 'AAAPL1234C', gst: '27ZZZZZ9999Z1Z5', company: 'X Co', email: 'a@xco.com' });
ok('GST embeds DIFFERENT PAN → conflict', panMismatch.conflicts.some((x) => /mismatch|but PAN is/.test(x)));
ok('PAN mismatch drags confidence DOWN', panMismatch.compositeConfidence < resolveIdentity({ pan: 'AAAPL1234C', gst: '27AAAPL1234C1Z5', company: 'X Co' }).compositeConfidence);
const stateMismatch = resolveIdentity({ gst: '27AAAPL1234C1Z5', state: 'Delhi' });
ok('GST state ≠ stated state → conflict', stateMismatch.conflicts.some((x) => /≠ stated state/.test(x)));

// ── generic email does NOT manufacture a company echo ──
const gmailBuyer = resolveIdentity({ company: 'Chetna Industries', email: 'dineshchetna@gmail.com' });
ok('gmail does NOT echo company (no false agreement)', !gmailBuyer.agreements.some((x) => /echoes/.test(x)));

// ── chaos: malformed anchors are IGNORED, never counted, never crash ──
const garbage = resolveIdentity({ pan: 'not-a-pan', gst: '12345', mobile: 'abc', email: 'no-at-sign' });
ok('malformed PAN ignored', !garbage.anchorsPresent.includes('pan') && !garbage.entityType);
ok('malformed GST ignored', !garbage.anchorsPresent.includes('gst'));
ok('non-numeric mobile ignored', !garbage.anchorsPresent.includes('mobile'));
ok('email without @ ignored', !garbage.anchorsPresent.includes('email'));
ok('all-garbage → thin identity, no crash', garbage.identityStrength === 'thin');

// ── thin / golden rule: missing anchors are absent, NOT conflicts ──
const lone = resolveIdentity({ mobile: '9319312172' });
ok('lone mobile → weak/thin, no conflicts', lone.conflicts.length === 0 && lone.compositeConfidence < 55);
ok('empty → thin, conf low, no crash', (() => { const r = resolveIdentity({}); return r.anchorCount === 0 && r.identityStrength === 'thin' && r.conflicts.length === 0; })());

// ── N6 name-variant reconciliation (Tarbrinder / Singh Tarbrinder / Sumit) ──
const nameCorrob = resolveIdentity({ name: 'Tarbrinder', altNames: ['Singh Tarbrinder'] });
ok('N6: "Tarbrinder" + "Singh Tarbrinder" → corroborated (shared token)', nameCorrob.agreements.some((x) => /name corroborated/.test(x)));
const nameVariant = resolveIdentity({ name: 'Tarbrinder', altNames: ['Sumit'] });
ok('N6: "Tarbrinder" + "Sumit" → unrelated-variants conflict', nameVariant.conflicts.some((x) => /unrelated variants/.test(x)));
ok('N6: unrelated name variant drags confidence down', nameVariant.compositeConfidence < nameCorrob.compositeConfidence);
ok('N6: single name (no alts) → no name nudge', !resolveIdentity({ name: 'Tarbrinder' }).conflicts.some((x) => /variants/.test(x)) && !resolveIdentity({ name: 'Tarbrinder' }).agreements.some((x) => /corroborated/.test(x)));

console.log(`\nidentitytest (multi-anchor stitch · GST↔PAN embed · state · echo · N6 name-variants · agreement↑/conflict↓ · chaos-safe): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
