// ─── Nature engine (Tier-2 STRUCTURAL inference) ──────────────────────────────
// Derives the buyer's INSTITUTION TYPE from their email domain — a first-party signal we already
// hold but never parsed (the IIT-Kanpur "Manufacturer" mislabel came from ignoring `iitk.ac.in`).
//
// NO CATEGORY HARDCODING: this classifies UNIVERSAL email-domain semantics (TLD + public-provider
// list) — never product categories. The richer nature (Research-Lab vs OEM vs Trader) is left to the
// LLM persona pass, which we now FEED this signal so it stops guessing.
//
// ANTI-HALLUCINATION (the Golden Rule): we only assert what the domain PROVES.
//   iitk.ac.in → "Academic Institution" (high) — NEVER "Professor" (that needs a designation).
// Every result carries value + confidence + evidence + source so the consume-gate can trust it.

export type InstitutionType = 'academic' | 'government' | 'corporate' | 'generic' | 'unknown';

// Universal domain semantics — NOT product categories.
const ACADEMIC_TLD = /\.(ac\.[a-z]{2,}|edu|edu\.[a-z]{2,})$/i;          // iitk.ac.in · mit.edu · ox.ac.uk · x.edu.au
const GOV_TLD = /(\.gov(\.[a-z]{2,})?|\.nic\.in|\.gov\.in|\.mil)$/i;     // .gov.in · .gov · .nic.in · .mil
const PUBLIC_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'rediffmail.com', 'rediff.com',
  'icloud.com', 'me.com', 'protonmail.com', 'proton.me', 'zoho.com', 'aol.com', 'gmx.com',
]);

export interface EmailNature {
  institutionType: InstitutionType;
  value: string;        // human label for the Nature attribute (or '' for generic/unknown)
  confidence: number;   // 0-100
  evidence: string[];
  source: 'email-domain';
  domain: string;
}

const slug = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function classifyEmailDomain(email?: string, companyName?: string): EmailNature {
  const e = (email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  const domain = at >= 0 ? e.slice(at + 1).trim() : '';
  const base = (v: Partial<EmailNature>): EmailNature => ({ institutionType: 'unknown', value: '', confidence: 0, evidence: [], source: 'email-domain', domain, ...v });

  if (!domain || !domain.includes('.')) return base({});

  if (ACADEMIC_TLD.test(domain))
    return base({ institutionType: 'academic', value: 'Academic / Research Institution', confidence: 95, evidence: [`${domain} is an academic-institution email domain`] });
  if (GOV_TLD.test(domain))
    return base({ institutionType: 'government', value: 'Government / PSU', confidence: 95, evidence: [`${domain} is a government email domain`] });
  if (PUBLIC_PROVIDERS.has(domain))
    return base({ institutionType: 'generic', value: '', confidence: 55, evidence: [`${domain} is a public email provider — no organisation signal`] });

  // A private (non-public-provider) domain → corporate identity. Stronger when it echoes the company name.
  const co = slug(companyName);
  const dom = slug(domain.split('.')[0]);
  const echoesCompany = !!(co && dom && (co.includes(dom) || dom.includes(co)));
  return base({
    institutionType: 'corporate',
    value: 'Corporate / Business',
    confidence: echoesCompany ? 85 : 65,
    evidence: [`${domain} is a private business domain${echoesCompany ? ' matching the company name' : ''}`],
  });
}

// Whether this email-nature is strong enough to DRIVE the RFQ (consume-gate input). Generic/unknown
// is informational only — it carries no organisation signal, so it never drives.
export function natureDrives(n: EmailNature): boolean {
  return (n.institutionType === 'academic' || n.institutionType === 'government' || n.institutionType === 'corporate') && !!n.value && n.confidence >= 60;
}
