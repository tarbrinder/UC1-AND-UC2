// Contract test for the Nature engine (P0) — mirrors src/lib/nature.ts (repo harness pattern:
// re-implement the pure logic inline, no TS import). Proves the email-domain → institution-type
// classification + the ANTI-HALLUCINATION discipline (the Golden Rule): assert only what the domain
// PROVES (institution level), never a person's role; generic providers never drive.

const ACADEMIC_TLD = /\.(ac\.[a-z]{2,}|edu|edu\.[a-z]{2,})$/i;
const GOV_TLD = /(\.gov(\.[a-z]{2,})?|\.nic\.in|\.gov\.in|\.mil)$/i;
const PUBLIC_PROVIDERS = new Set(['gmail.com','googlemail.com','yahoo.com','yahoo.co.in','yahoo.in','ymail.com','rocketmail.com','hotmail.com','outlook.com','live.com','msn.com','rediffmail.com','rediff.com','icloud.com','me.com','protonmail.com','proton.me','zoho.com','aol.com','gmx.com']);
const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function classifyEmailDomain(email, companyName) {
  const e = (email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  const domain = at >= 0 ? e.slice(at + 1).trim() : '';
  const base = (v) => ({ institutionType: 'unknown', value: '', confidence: 0, evidence: [], source: 'email-domain', domain, ...v });
  if (!domain || !domain.includes('.')) return base({});
  if (ACADEMIC_TLD.test(domain)) return base({ institutionType: 'academic', value: 'Academic / Research Institution', confidence: 95, evidence: [`${domain} is an academic-institution email domain`] });
  if (GOV_TLD.test(domain)) return base({ institutionType: 'government', value: 'Government / PSU', confidence: 95, evidence: [`${domain} is a government email domain`] });
  if (PUBLIC_PROVIDERS.has(domain)) return base({ institutionType: 'generic', value: '', confidence: 55, evidence: [`${domain} is a public email provider — no organisation signal`] });
  const co = slug(companyName), dom = slug(domain.split('.')[0]);
  const echoes = !!(co && dom && (co.includes(dom) || dom.includes(co)));
  return base({ institutionType: 'corporate', value: 'Corporate / Business', confidence: echoes ? 85 : 65, evidence: [`${domain} is a private business domain${echoes ? ' matching the company name' : ''}`] });
}
const natureDrives = (n) => (['academic', 'government', 'corporate'].includes(n.institutionType)) && !!n.value && n.confidence >= 60;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the IIT-Kanpur case (the headline miss) ──
const iitk = classifyEmailDomain('skkakodia@iitk.ac.in', 'IIT Kanpur');
ok('IIT-Kanpur: iitk.ac.in → academic', iitk.institutionType === 'academic');
ok('IIT-Kanpur: value = institution level, NOT a person role', iitk.value === 'Academic / Research Institution');
ok('IIT-Kanpur: value does NOT claim "Professor"/"Researcher" (anti-hallucination)', !/professor|researcher|faculty/i.test(iitk.value));
ok('IIT-Kanpur: high confidence (≥90)', iitk.confidence >= 90);
ok('IIT-Kanpur: evidence cites the domain', iitk.evidence[0].includes('iitk.ac.in'));
ok('IIT-Kanpur: drives the RFQ', natureDrives(iitk));

// ── academic TLD variants ──
ok('mit.edu → academic', classifyEmailDomain('x@mit.edu').institutionType === 'academic');
ok('ox.ac.uk → academic', classifyEmailDomain('x@ox.ac.uk').institutionType === 'academic');

// ── government ──
ok('x@drdo.gov.in → government', classifyEmailDomain('x@drdo.gov.in').institutionType === 'government');
ok('x@dept.nic.in → government', classifyEmailDomain('x@dept.nic.in').institutionType === 'government');
ok('government drives', natureDrives(classifyEmailDomain('x@drdo.gov.in')));

// ── generic public providers → NO org signal, NEVER drives ──
ok('gmail → generic', classifyEmailDomain('dineshchetna@gmail.com', 'Indomaret').institutionType === 'generic');
ok('generic has empty value', classifyEmailDomain('x@gmail.com').value === '');
ok('generic does NOT drive (no org signal)', !natureDrives(classifyEmailDomain('x@gmail.com', 'Indomaret')));
ok('fireandpersonalsafety@gmail.com → generic (business-on-gmail, no domain signal)', classifyEmailDomain('fireandpersonalsafety@gmail.com', 'Fire And Personal Safety Enterprises').institutionType === 'generic');
ok('yahoo.co.in → generic', classifyEmailDomain('x@yahoo.co.in').institutionType === 'generic');

// ── corporate (private domain) ──
const gfo = classifyEmailDomain('info@gfofireequipments.com', 'GFO Fire Equipments');
ok('corporate: private domain → corporate', gfo.institutionType === 'corporate');
ok('corporate: company-echo → higher confidence (85)', gfo.confidence === 85);
ok('corporate: drives', natureDrives(gfo));
const corpNoEcho = classifyEmailDomain('buyer@acmeholdings.com', 'Indomaret');
ok('corporate (no name echo) → still corporate, lower conf (65)', corpNoEcho.institutionType === 'corporate' && corpNoEcho.confidence === 65);

// ── consume-gate / Golden Rule: missing/weak inputs never drive ──
ok('no email → unknown, conf 0', classifyEmailDomain('').institutionType === 'unknown');
ok('no email → does NOT drive', !natureDrives(classifyEmailDomain('')));
ok('malformed (no @) → unknown', classifyEmailDomain('not-an-email').institutionType === 'unknown');
ok('@ but no dot in domain → unknown', classifyEmailDomain('x@localhost').institutionType === 'unknown');

// ── P0 IDENTITY HIERARCHY: institutionalRole + canonicalBuyerType precedence (Nature > Business Type) ──
// Mirror of nature.ts institutionalRole(): an evidence-gated academic/gov Nature → the institutional
// buyer-type label; corporate/generic → '' (a real company keeps its inferred business_type).
function institutionalRole(n, authorityRole) {
  if (!n || n.confidence < 80) return '';
  if (n.institutionType === 'academic') return authorityRole === 'procurement' ? 'Institution — Procurement' : 'Research / Academic Institution';
  if (n.institutionType === 'government') return 'Government / PSU';
  return '';
}
const iitNature = classifyEmailDomain('skkakodia@iitk.ac.in');
ok('institutionalRole: iitk.ac.in → "Research / Academic Institution"', institutionalRole(iitNature) === 'Research / Academic Institution');
ok('institutionalRole: academic + procurement authority → "Institution — Procurement"', institutionalRole(iitNature, 'procurement') === 'Institution — Procurement');
ok('institutionalRole: gov domain → "Government / PSU"', institutionalRole(classifyEmailDomain('x@dst.gov.in')) === 'Government / PSU');
ok('institutionalRole: corporate domain → "" (a real company keeps its business_type)', institutionalRole(classifyEmailDomain('procurement@tatasteel.com')) === '');
ok('institutionalRole: generic gmail → "" (no override)', institutionalRole(classifyEmailDomain('someone@gmail.com')) === '');

// Mirror of canonicalBuyerType(): Nature (academic/gov, conf≥80) outranks an LLM business_type AND a
// CONTRADICTING pick; a deliberate institutional pick stands; corporate/generic → pick > business_type.
function canonicalBuyerType({ nature, natConf, authorityRole, pick, businessType, persona }) {
  const nat = (nature || '').toLowerCase();
  const institutional = /academic|research/.test(nat) ? (authorityRole === 'procurement' ? 'Institution — Procurement' : 'Research / Academic Institution') : /government|psu/.test(nat) ? 'Government / PSU' : '';
  if (institutional && (natConf || 0) >= 80) {
    if (pick && /institut|research|academ|government|psu|college|univers|\blab\b|\bdept\b|department|faculty/i.test(pick)) return pick;
    return institutional;
  }
  if (pick) return pick;
  return businessType || persona || '';
}
// THE IIT-KANPUR FIX: Twin guessed "Manufacturer", buyer was led to pick "Manufacturer" — Nature wins.
ok('IIT: Nature(academic,95) BEATS a "Manufacturer" pick → Research Institution', canonicalBuyerType({ nature: 'Academic / Research Institution', natConf: 95, pick: 'Manufacturer', businessType: 'Manufacturer' }) === 'Research / Academic Institution');
ok('IIT: Nature BEATS the Twin business_type when there is no pick', canonicalBuyerType({ nature: 'Academic / Research Institution', natConf: 95, businessType: 'Manufacturer' }) === 'Research / Academic Institution');
ok('IIT: a DELIBERATE institutional pick is respected (not overwritten)', canonicalBuyerType({ nature: 'Academic / Research Institution', natConf: 95, pick: 'Institution — Procurement', businessType: 'Manufacturer' }) === 'Institution — Procurement');
ok('corporate manufacturer: Nature does NOT override → "Manufacturer" stands', canonicalBuyerType({ nature: 'Corporate / Business', natConf: 90, pick: 'Manufacturer', businessType: 'Manufacturer' }) === 'Manufacturer');
ok('corporate, no pick → Twin business_type wins', canonicalBuyerType({ nature: 'Corporate / Business', natConf: 90, businessType: 'Trader' }) === 'Trader');
ok('low-confidence Nature does NOT override a pick', canonicalBuyerType({ nature: 'Academic / Research Institution', natConf: 50, pick: 'Manufacturer' }) === 'Manufacturer');
ok('no Nature, no pick → persona fallback', canonicalBuyerType({ businessType: '', persona: 'Business Buyer' }) === 'Business Buyer');

console.log(`\nnatureenginetest (email-domain → institution-type · evidence-gated · anti-hallucination · P0 identity hierarchy): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
