// ─── Identity Resolution (P3 · the "Dinesh mechanism") ────────────────────────
// Stitches the buyer's scattered anchors — Name · Mobile · Company · Email · PAN · GST · City/State —
// into ONE composite identity with a confidence score, using ONLY universal STRUCTURAL cross-checks
// (government ID formats + domain echo). NO category hardcoding, NO external tables beyond the fixed
// GST state-code list and PAN entity-type letter (both are statutory numbering, not product rules).
//
// WHY: a lone mobile or a common name is weak; but when GST embeds the same PAN, the email domain
// echoes the company, and the GST state matches the buyer's state, the anchors CORROBORATE and the
// identity is strong. Contradictions (GST embeds a DIFFERENT PAN, GST state ≠ stated state) are
// surfaced as conflicts that LOWER confidence — we never paper over a mismatch.
//
// OBSERVED-ONLY: PAN/GST often arrive from the external pull (Befisc), so this resolution is a
// confidence + identity signal for the dossier — it is NEVER a planner spec-driver (locked rule).
// Anti-hallucination: every agreement/conflict is structurally PROVED; missing anchors are absent,
// not conflicts. Malformed inputs are ignored (not counted), never crash — chaos-safe by design.

export interface IdentityAnchors {
  name?: string;
  altNames?: string[]; // N6 — the same person's name as it appears in OTHER sources (Befisc, WhatsApp…)
  mobile?: string;
  company?: string;
  email?: string;
  pan?: string;
  gst?: string;
  city?: string;
  state?: string;
}

export interface IdentityResolution {
  anchorsPresent: string[];     // which anchors we actually have (valid ones only)
  anchorCount: number;
  entityType?: string;          // from PAN 4th char — "Company" | "Individual / Proprietor" | …
  gstState?: string;            // state name decoded from the GST state code
  agreements: string[];         // structural corroborations (raise confidence)
  conflicts: string[];          // structural contradictions (lower confidence)
  compositeConfidence: number;  // 0-100
  identityStrength: 'strong' | 'moderate' | 'weak' | 'thin';
  evidence: string[];           // human-readable structural notes
}

// PAN: 5 letters + 4 digits + 1 letter. 4th letter = holder type.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;
// GSTIN: 2-digit state + 10-char PAN + entity-no + 'Z'/var + checksum (15 chars).
const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/i;
const PAN_ENTITY: Record<string, string> = {
  P: 'Individual / Proprietor', C: 'Company', H: 'HUF', F: 'Firm / LLP', A: 'Association of Persons',
  T: 'Trust', B: 'Body of Individuals', L: 'Local Authority', J: 'Artificial Juridical Person', G: 'Government',
};
// GST state codes (statutory; not a category list).
const GST_STATE: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh', '24': 'Gujarat', '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli', '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Old)', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

const slug = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const last10 = (m?: string) => (m || '').replace(/\D/g, '').slice(-10);

export function resolveIdentity(a: IdentityAnchors): IdentityResolution {
  const evidence: string[] = [];
  const agreements: string[] = [];
  const conflicts: string[] = [];

  // ── normalise + validate each anchor (invalid → ignored, never counted) ──
  const name = (a.name || '').trim();
  const company = (a.company || '').trim();
  const email = (a.email || '').trim().toLowerCase();
  const emailDomain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : '';
  const mob = last10(a.mobile);
  const pan = PAN_RE.test((a.pan || '').trim()) ? (a.pan || '').trim().toUpperCase() : '';
  const gst = GST_RE.test((a.gst || '').trim()) ? (a.gst || '').trim().toUpperCase() : '';
  const city = (a.city || '').trim();
  const state = (a.state || '').trim();

  const present: Array<[string, boolean]> = [
    ['name', !!name], ['mobile', mob.length === 10], ['company', company.length >= 2],
    ['email', !!emailDomain], ['pan', !!pan], ['gst', !!gst], ['city', !!city],
  ];
  const anchorsPresent = present.filter(([, ok]) => ok).map(([k]) => k);

  // ── entity type from PAN ──
  let entityType: string | undefined;
  if (pan) {
    entityType = PAN_ENTITY[pan[3].toUpperCase()] || 'Unknown entity type';
    evidence.push(`PAN entity letter "${pan[3].toUpperCase()}" → ${entityType}`);
  }

  // ── GST state code ──
  let gstState: string | undefined;
  if (gst) {
    gstState = GST_STATE[gst.slice(0, 2)];
    if (gstState) evidence.push(`GST state code ${gst.slice(0, 2)} → ${gstState}`);
  }

  // ── cross-check A: GST embeds PAN (chars 3-12) ──
  if (gst && pan) {
    const gstPan = gst.slice(2, 12);
    if (gstPan === pan) agreements.push('GST embeds the same PAN — registration & PAN corroborate');
    else conflicts.push(`GST embeds PAN ${gstPan} but the buyer's PAN is ${pan} — mismatch`);
  } else if (gst && !pan) {
    // GST alone still yields the PAN — surface it (informative, not a conflict).
    evidence.push(`GST embeds PAN ${gst.slice(2, 12)} (derived)`);
  }

  // ── cross-check B: GST state vs stated state ──
  if (gstState && state) {
    if (slug(gstState).includes(slug(state)) || slug(state).includes(slug(gstState))) agreements.push(`GST state (${gstState}) matches the stated state`);
    else conflicts.push(`GST state (${gstState}) ≠ stated state (${state})`);
  }

  // ── cross-check C: email domain echoes company name (corporate identity) ──
  if (emailDomain && company && !/^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|rediffmail|rediff|icloud|me|protonmail|proton|zoho|aol|gmx)\./.test(emailDomain)) {
    const co = slug(company);
    const dom = slug(emailDomain.split('.')[0]);
    if (co && dom && (co.includes(dom) || dom.includes(co))) agreements.push('email domain echoes the company name — same business');
  }

  // ── cross-check D: PAN entity vs company presence (soft, informative) ──
  if (entityType && company.length >= 2) {
    if (pan[3].toUpperCase() === 'P') evidence.push('individual PAN with a company name — likely a proprietorship');
    else if (pan[3].toUpperCase() === 'C') agreements.push('company PAN aligns with a company name');
  }

  // ── cross-check E: NAME VARIANTS (N6) — Tarbrinder / Singh Tarbrinder / Sumit across sources ──
  const allNames = [name, ...(a.altNames || [])].map((n) => (n || '').trim()).filter(Boolean);
  if (allNames.length >= 2) {
    const tok = (n: string) => new Set(n.toLowerCase().split(/\s+/).filter((w) => w.length >= 3));
    const prime = tok(allNames[0]);
    const unrelated = allNames.slice(1).filter((n) => { const t = tok(n); return t.size > 0 && ![...t].some((x) => prime.has(x)); });
    const uniq = [...new Set(allNames)];
    if (unrelated.length) conflicts.push(`name appears as unrelated variants: ${uniq.join(' / ')}`);
    else if (uniq.length >= 2) agreements.push(`name corroborated across sources (${uniq.join(' / ')})`);
  }

  // ── composite confidence ──
  const W: Record<string, number> = { gst: 25, pan: 20, email: 15, company: 15, mobile: 10, name: 8, city: 7 };
  const presenceScore = Math.min(85, anchorsPresent.reduce((s, k) => s + (W[k] || 0), 0));
  const agreementBonus = Math.min(15, agreements.length * 8);
  const conflictPenalty = conflicts.length * 25;
  const compositeConfidence = Math.max(0, Math.min(100, Math.round(presenceScore + agreementBonus - conflictPenalty)));
  const identityStrength: IdentityResolution['identityStrength'] =
    compositeConfidence >= 80 ? 'strong' : compositeConfidence >= 55 ? 'moderate' : compositeConfidence >= 30 ? 'weak' : 'thin';

  return { anchorsPresent, anchorCount: anchorsPresent.length, entityType, gstState, agreements, conflicts, compositeConfidence, identityStrength, evidence };
}

// One-line summary for the dossier/ledger.
export function identityLine(r: IdentityResolution): string {
  const bits = [
    `${r.anchorCount} anchors [${r.anchorsPresent.join(',') || '—'}]`,
    r.entityType && `entity: ${r.entityType}`,
    r.gstState && `state: ${r.gstState}`,
    r.agreements.length && `✓ ${r.agreements.length} agree`,
    r.conflicts.length && `⚠ ${r.conflicts.length} conflict`,
    `conf ${r.compositeConfidence} (${r.identityStrength})`,
  ].filter(Boolean);
  return bits.join(' · ');
}
