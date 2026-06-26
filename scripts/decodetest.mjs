// Deterministic test for panDecode.ts + gstDecode.ts (logic replicated in JS, per the project's no-TS-import
// convention). Proves entity-type decode, surname cross-check (no false mismatch on a first-name-only name),
// distinct-PAN duplicate flag, and GSTIN state/PAN/entity decode. NO LLM, NO fetch. `node scripts/decodetest.mjs`.

const PAN_ENTITY = { P: 'Individual', C: 'Company', H: 'Hindu Undivided Family (HUF)', F: 'Firm / LLP', A: 'Association of Persons (AOP)', T: 'Trust', B: 'Body of Individuals (BOI)', L: 'Local Authority', J: 'Artificial Juridical Person', G: 'Government', E: 'LLP / limited liability partnership', K: 'Trust (Krish, legacy series)' };
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
function decodePAN(pan, resolvedName) {
  const p = String(pan || '').trim().toUpperCase();
  if (!p) return null;
  const valid = PAN_RE.test(p);
  const entityChar = p.charAt(3), surnameInitial = p.charAt(4), isIndividual = entityChar === 'P';
  let nameMatch = 'unknown';
  const parts = String(resolvedName || '').trim().split(/\s+/).filter(Boolean);
  if (isIndividual && valid && parts.length > 1 && /[A-Z]/.test(surnameInitial)) {
    const expected = parts[parts.length - 1].charAt(0).toUpperCase();
    nameMatch = expected === surnameInitial ? 'match' : 'mismatch';
  }
  return { pan: p, valid, entityChar, entityType: PAN_ENTITY[entityChar] || 'Unknown', isIndividual, surnameInitial, nameMatch };
}
function decodePANs(pans, name) {
  const infos = pans.map((x) => decodePAN(x, name)).filter(Boolean);
  const distinct = new Set(infos.map((i) => i.pan));
  return { infos, duplicate: infos.length > 1 && distinct.size > 1 };
}
const GST_STATE = { '07': 'Delhi', '09': 'Uttar Pradesh', '24': 'Gujarat', '27': 'Maharashtra', '33': 'Tamil Nadu' };
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
function decodeGST(gstin) {
  const g = String(gstin || '').trim().toUpperCase();
  if (!g || g.length !== 15) return null;
  const stateCode = g.substring(0, 2), pan = g.substring(2, 12), entityChar = pan.charAt(3);
  return { gstin: g, valid: GSTIN_RE.test(g), stateCode, state: GST_STATE[stateCode] || 'Unknown', pan, entityType: PAN_ENTITY[entityChar] || 'Unknown', registered: true };
}

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

// PAN — Jaiveer's real PAN (4th=P → Individual; 5th=S → Singh)
{
  const r = decodePAN('KDVPS7147Q', 'Jaiveer Singh');
  ok('PAN entity = Individual', r.entityType === 'Individual' && r.isIndividual === true);
  ok('PAN surname-initial match (S = Singh)', r.surnameInitial === 'S' && r.nameMatch === 'match');
  ok('PAN format valid', r.valid === true);
}
// no false mismatch when only a first name is known
{
  const r = decodePAN('KDVPS7147Q', 'Jaiveer');
  ok('first-name-only → nameMatch unknown (no false mismatch)', r.nameMatch === 'unknown');
}
// company PAN
ok('PAN 4th=C → Company', decodePAN('AAACX1234Z').entityType === 'Company');
// empty → null · garbage → invalid but не crash
ok('empty PAN → null', decodePAN('') === null);
ok('garbage PAN → invalid', decodePAN('NOTAPAN').valid === false);
// two DISTINCT PANs = data-quality flag; two identical = not
ok('two distinct PANs → duplicate flag', decodePANs(['KDVPS7147Q', 'KDVPS7145Q'], 'Jaiveer Singh').duplicate === true);
ok('two identical PANs → no flag', decodePANs(['KDVPS7147Q', 'KDVPS7147Q']).duplicate === false);

// GST — UP state code 09, embedded PAN, Individual entity
{
  const r = decodeGST('09KDVPS7147Q1Z5');
  ok('GST state 09 → Uttar Pradesh', r.state === 'Uttar Pradesh');
  ok('GST embedded PAN extracted', r.pan === 'KDVPS7147Q');
  ok('GST entity from PAN = Individual', r.entityType === 'Individual');
  ok('GST format valid', r.valid === true);
}
ok('GST 27 → Maharashtra · Company', decodeGST('27AAACX1234Z1Z5').state === 'Maharashtra' && decodeGST('27AAACX1234Z1Z5').entityType === 'Company');
ok('bad GST (len≠15) → null', decodeGST('BAD') === null);

console.log(`\ndecode (PAN+GST) harness: ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
