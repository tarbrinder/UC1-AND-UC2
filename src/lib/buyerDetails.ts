// ─── BUYER DETAILS (V10.1 merged-source readers) — the structured feed for the L6 "Buyer Details" card ──────────
// PURE · deterministic · no LLM. The extract LLM only ever SEES these summaries flattened into evidence; the L6
// Buylead-Details card needs them as STRUCTURED objects (member-since, emails, mobiles, PAN, GST from identity;
// verified name / PAN / income / location / gender / social from external) + a cross-source "Available" resolver.
//
// VERIFICATION TICKS (owner): an Available anchor (mobile / email / address / PAN / GST) gets a SINGLE tick when it
// is present in the buyer's own profile (identity), and a DOUBLE tick when it is ALSO present in the paid external
// source AND the two values agree (cross-source corroboration). Each row carries the value, the external value, the
// source label and a debug note so the L6 expand can show "the last fact + which source". Harnessed in
// scripts/buyerdetailstest.mjs.

import { decodePANs, type PanInfo } from './panDecode';
import { decodeGST, type GstInfo } from './gstDecode';

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? '' : String(v)).trim();
// first non-empty value across a set of candidate keys (merged nodes vary key names across versions)
const pick = (o: Record<string, unknown>, ...keys: string[]): string => { for (const k of keys) { const v = str(o[k]); if (v) return v; } return ''; };
const list = (o: Record<string, unknown>, ...keys: string[]): string[] => {
  for (const k of keys) { const v = o[k]; if (Array.isArray(v)) { const a = v.map(str).filter(Boolean); if (a.length) return [...new Set(a)]; } else { const s = str(v); if (s) return [s]; } }
  return [];
};

export interface MergedIdentity { name?: string; company?: string; city?: string; state?: string; address?: string; memberSince?: string; designation?: string; emails: string[]; mobiles: string[]; pan?: string; gst?: string }
export interface MergedExternal { verifiedName?: string; verifiedNameConfidence?: number; verifiedNameSource?: string; befiscName?: string; nameCrossSourceMatch?: boolean; pan?: string; pans: string[]; gender?: string; dob?: string; city?: string; state?: string; location?: string; incomeBand?: string; age?: string; socialPlatforms: string[]; socialPresenceCount?: number; emails: string[]; mobiles: string[] }
export interface AvailabilityRow { key: 'mobile' | 'email' | 'address' | 'pan' | 'gst' | 'company'; label: string; present: boolean; verified: boolean; isNew: boolean; value: string; externalValue?: string; source: string; note: string }

function richSources(rich: unknown): Record<string, unknown> {
  const sources = obj(obj(rich).sources);
  return sources;
}
function summaryOf(rich: unknown, key: string): Record<string, unknown> {
  const node = obj(richSources(rich)[key]);
  return obj('summary' in node ? node.summary : node);
}

export function identityFromMerged(rich: unknown): MergedIdentity | null {
  const s = summaryOf(rich, 'identity');
  // member-since / tenure live in the GLUSR `usersince` source (usersince.member_since ISO date + tenure_years),
  // NOT inside the merged identity node — read it as a fallback so the deterministic "Member since" row populates.
  const us = summaryOf(rich, 'usersince');
  if (!Object.keys(s).length && !Object.keys(us).length) return null;
  return {
    name: pick(s, 'name', 'buyer_name', 'first_name', 'ceo_name') || undefined,
    company: pick(s, 'company', 'company_name', 'companyname') || undefined,
    city: pick(s, 'city', 'buyer_city') || undefined,
    state: pick(s, 'state', 'buyer_state') || undefined,
    address: pick(s, 'address', 'full_address') || undefined,
    memberSince: pick(s, 'member_since', 'membersince', 'usersince', 'registered_on', 'joined') || pick(us, 'member_since', 'membersince', 'registered_on', 'joined', 'since') || undefined,
    designation: pick(s, 'designation', 'role', 'custtype') || undefined,
    emails: list(s, 'emails', 'email', 'email_id'),
    mobiles: list(s, 'mobiles', 'mobile', 'phone', 'glusr_phone'),
    pan: pick(s, 'pan', 'pan_number') || undefined,
    gst: pick(s, 'gst', 'gstin', 'gst_number') || undefined,
  };
}

// map a categorical confidence ("high"/"medium"/"low") OR a raw number → a 0-100 band (owner: confidence as NUMBERS).
export function bandConfidence(raw: unknown): number | undefined {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return undefined;
  const n = Number(s.replace('%', ''));
  if (!isNaN(n) && n > 0) return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n));
  if (/high|verified|strong/.test(s)) return 90;
  if (/med|moderate/.test(s)) return 70;
  if (/low|weak/.test(s)) return 50;
  return undefined;
}

export function externalFromMerged(rich: unknown): MergedExternal | null {
  const s = summaryOf(rich, 'external');
  if (!Object.keys(s).length) return null;
  const cnt = Number(pick(s, 'social_presence_count', 'social_count'));
  return {
    verifiedName: pick(s, 'verified_name', 'name') || undefined,
    verifiedNameConfidence: bandConfidence(pick(s, 'verified_name_confidence', 'name_confidence')),
    verifiedNameSource: pick(s, 'verified_name_source', 'name_source') || undefined,
    befiscName: pick(s, 'befisc_name') || undefined,
    nameCrossSourceMatch: s.name_cross_source_match === true ? true : (s.name_cross_source_match === false ? false : undefined),
    pan: pick(s, 'pan', 'pan_number') || undefined,
    pans: list(s, 'pans', 'pan', 'pan_number', 'pan_list'),
    gender: pick(s, 'gender') || undefined,
    dob: pick(s, 'date_of_birth', 'dob') || undefined,
    city: pick(s, 'city') || undefined,
    state: pick(s, 'state') || undefined,
    location: pick(s, 'location', 'address', 'full_address') || undefined,
    incomeBand: pick(s, 'income_band', 'income') || undefined,
    age: pick(s, 'age', 'age_band') || undefined,
    socialPlatforms: list(s, 'social_platforms', 'social', 'platforms', 'phone_accounts'),
    socialPresenceCount: isNaN(cnt) ? undefined : cnt,
    emails: list(s, 'emails', 'email', 'email_id'),
    mobiles: list(s, 'mobiles', 'mobile', 'phone'),
  };
}

// normalizers for cross-source matching
const digits = (s: string) => s.replace(/\D/g, '').slice(-10);          // last-10 digits (drop +91 / leading 0)
const lc = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function resolveAvailable(idn: MergedIdentity | null, ext: MergedExternal | null, gstLegalName?: string): AvailabilityRow[] {
  const rows: AvailabilityRow[] = [];
  const idnAddress = idn ? (idn.address || [idn.city, idn.state].filter(Boolean).join(', ')) : '';
  const extLocation = ext ? (ext.location || [ext.city, ext.state].filter(Boolean).join(', ')) : '';

  // V10 §E: isNew = the anchor exists ONLY in the paid external source (NOT in the buyer's own profile) — render
  // gives it a violet border ("we discovered this"). verified ✓✓ = present in BOTH and the values cross-source agree.
  const add = (key: AvailabilityRow['key'], label: string, idnValue: string, extValue: string, matched: boolean, displayOverride?: string) => {
    const value = displayOverride || idnValue || extValue;
    const present = !!value;
    const isNew = present && !idnValue && !!extValue;       // discovered via external, absent from profile
    const verified = present && !!idnValue && !!extValue && matched;
    const ext_ = extValue || '';
    const note = !present ? 'not in profile' :
      verified ? `Profile: ${idnValue} · External(Befisc/Sign3): ${ext_} — values AGREE → cross-source verified ✓✓` :
      isNew ? `Not in profile · found via External(Befisc/Sign3): ${ext_} — NEW anchor we surfaced` :
      ext_ ? `Profile: ${idnValue} · External: ${ext_} — present in both but values differ (single ✓)` :
      `Profile: ${idnValue} — no external corroboration on file (single ✓)`;
    const source = !present ? '—' : verified ? 'Profile ⊕ External (matched)' : isNew ? 'External (Befisc/Sign3)' : 'Profile';
    rows.push({ key, label, present, verified, isNew, value, externalValue: ext_ || undefined, source, note });
  };

  add('mobile', 'Mobile', idn?.mobiles[0] || '', ext?.mobiles[0] || '', !!idn?.mobiles[0] && !!ext?.mobiles[0] && digits(idn.mobiles[0]) === digits(ext.mobiles[0]));
  add('email', 'Email', idn?.emails[0] || '', ext?.emails[0] || '', !!idn?.emails[0] && !!ext?.emails[0] && lc(idn.emails[0]) === lc(ext.emails[0]));
  // surface the MOST-COMPLETE address (Befisc full_address is far richer than the bare city/state)
  const bestAddr = (extLocation && extLocation.length > idnAddress.length) ? extLocation : idnAddress;
  add('address', 'Address', idnAddress, extLocation, !!idnAddress && !!extLocation && (lc(idnAddress).includes(lc(idn?.city || '')) && lc(extLocation).includes(lc(idn?.city || '')) && !!idn?.city), bestAddr);
  add('pan', 'PAN', idn?.pan || '', ext?.pan || '', !!idn?.pan && !!ext?.pan && lc(idn.pan) === lc(ext.pan));
  // GST is buyer-supplied only; external rarely carries it — verified only when the external PAN is embedded in the GSTIN (chars 3-12)
  const gstPanMatch = !!idn?.gst && !!ext?.pan && lc(idn.gst).includes(lc(ext.pan));
  add('gst', 'GST', idn?.gst || '', gstPanMatch ? ext!.pan! : '', gstPanMatch);
  // V10 §B: Company anchor — cross-slot interdependent resolution; ✓✓ ONLY when the company string agrees across
  // >=2 of {IndiaMART company · IndiaMART name · Sign3 name · Befisc name} (NOT driven by GST presence).
  const rc = resolveCompany(idn, ext, gstLegalName);
  rows.push({
    key: 'company', label: 'Company', present: !!rc, verified: !!rc?.verified, isNew: false,
    value: rc?.company || '', externalValue: undefined,
    source: rc ? rc.source : '—',
    note: !rc ? 'not in profile' : rc.verified ? `Company matches across: ${rc.matchedSlots.join(', ')} → cross-source confirmed ✓✓` : `Company from ${rc.matchedSlots[0] || 'profile'} — only one slot carries it (single ✓)`,
  });
  return rows;
}

// ── NAME RESOLUTION (owner Q6/Q14/Q24/Q37) — pick the BEST full name + a confidence band ───────────────────
// Profile often carries only a first name ("Jaiveer"); the paid external source carries the bank-verified FULL
// name ("JAYVEER SINGH"). Prefer the most-complete name (more words wins), tie-break to the verified one, and
// Title-Case it. Confidence = the external verified-name band when that's the source; a softer band when we only
// have the profile first name. Deterministic; the name itself is PII but kept (debug/requirement form, owner-OK).
const titleCase = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
export interface ResolvedName { name: string; confidence: number; source: string; full: boolean; conflict?: boolean }
export function resolveBuyerName(idn: MergedIdentity | null, ext: MergedExternal | null): ResolvedName | null {
  const profile = (idn?.name || '').trim();
  const verified = (ext?.verifiedName || '').trim();
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  // name the SPECIFIC external provider (Sign3 bank-verified vs Befisc) instead of a generic "External (verified)".
  const vs = String(ext?.verifiedNameSource || '');
  const extSrc = /sign3/i.test(vs) ? 'Sign3 (bank-verified)' : /befisc/i.test(vs) ? 'Befisc (verified)' : 'External (verified)';
  // candidate = the one with more words; tie → the verified one (it's bank-corroborated)
  let chosen = profile, src = 'Profile', conf = profile ? 55 : 0;
  if (verified && (words(verified) > words(profile) || (words(verified) === words(profile) && verified.length >= profile.length))) {
    chosen = verified; src = extSrc; conf = ext?.verifiedNameConfidence ?? 80;
  } else if (verified && !profile) { chosen = verified; src = extSrc; conf = ext?.verifiedNameConfidence ?? 80; }
  if (!chosen) return null;
  // cross-source agreement (same surname token present in both) bumps confidence
  if (profile && verified && titleCase(profile).split(' ').some((t) => titleCase(verified).includes(t))) conf = Math.max(conf, 85);
  // NAME CONFLICT (owner PII-correctness): Sign3-bank name ≠ Befisc name (name_cross_source_match=false). Do NOT let a
  // lone bank hit auto-verify (cap below the ✓✓ gate) — and if Befisc corroborates the PROFILE name, prefer that.
  // (GLID 22642257: sign3 "Niti Kapoor" vs befisc+profile "Akash" → must not assert "Niti Kapoor" as ✓✓ verified.)
  if (ext?.nameCrossSourceMatch === false && verified) {
    const bef = (ext.befiscName || '').trim();
    const befAgreesProfile = !!bef && !!profile && (titleCase(bef).split(' ').some((t) => t && titleCase(profile).includes(t)) || titleCase(profile).split(' ').some((t) => t && titleCase(bef).includes(t)));
    if (befAgreesProfile && chosen === verified) { chosen = bef.length >= profile.length ? bef : profile; src = 'Profile ⊕ Befisc (Sign3 disagrees)'; }
    conf = Math.min(conf, 60); // never ✓✓ (gate is ≥85) while sources conflict
  }
  return { name: titleCase(chosen), confidence: Math.round(conf), source: src, full: words(chosen) > 1, conflict: ext?.nameCrossSourceMatch === false || undefined };
}

// ── IDENTITY DOC DECODE (owner Q30/Q34/Q39/L) — PAN entity + GST decode, deterministic ─────────────────────
export interface IdentityDocs { pan?: PanInfo; pans: PanInfo[]; panDuplicate: boolean; gst?: GstInfo; entityType?: string }
export function decodeIdentityDocs(idn: MergedIdentity | null, ext: MergedExternal | null, resolvedName?: string): IdentityDocs {
  const raw = [idn?.pan, ext?.pan, ...(ext?.pans || [])].filter(Boolean) as string[];
  const { infos, duplicate } = decodePANs(raw, resolvedName);
  const gst = decodeGST(idn?.gst || '');
  // entity type: prefer the PAN's read; else the GST's embedded PAN
  const entityType = infos[0]?.entityType || gst?.entityType;
  return { pan: infos[0], pans: infos, panDuplicate: duplicate, gst: gst || undefined, entityType };
}

// ── COMPANY ANCHOR (V10 §B) — INTERDEPENDENT, CROSS-SLOT company resolution (owner) ──────────────────────────
// The company name can be typed into ANY slot: the profile company field, the profile NAME field, or it may match
// the Sign3 / Befisc verified name. So we take the company string (company field, else the name field) and cross-
// match it against all four slots {profile company · profile name · Sign3 name · Befisc name}. ✓✓ (double-confidence)
// ONLY when it agrees across >=2 of those slots — name↔company corroborate each other. A GST on file is a SECONDARY
// note, NOT the ✓✓ driver (we must never assert a corroboration we didn't actually compute). Deterministic teal.
export interface ResolvedCompany { company: string; confidence: number; source: string; verified: boolean; matchedSlots: string[] }
export function resolveCompany(idn: MergedIdentity | null, ext: MergedExternal | null, gstLegalName?: string): ResolvedCompany | null {
  const companyField = (idn?.company || '').trim();
  const candidate = companyField || (idn?.name || '').trim() || (gstLegalName || '').trim();   // company may be typed into the name field, or only the GST legal name carries it
  if (!candidate) return null;
  const target = lc(candidate);
  const vs = String(ext?.verifiedNameSource || '');
  const slots: { label: string; val: string }[] = [
    { label: 'IndiaMART company', val: idn?.company || '' },
    { label: 'IndiaMART name', val: idn?.name || '' },
    { label: 'Sign3 name', val: /sign3/i.test(vs) ? (ext?.verifiedName || '') : '' },
    { label: 'Befisc name', val: /befisc/i.test(vs) ? (ext?.verifiedName || '') : '' },
    { label: 'GST legal name', val: gstLegalName || '' },   // §B — authoritative registered name
  ];
  // a slot "agrees" when its normalized value contains, or is contained by, the candidate (handles "Acme" vs "Acme Traders")
  const matched = slots.filter((s) => { const v = lc(s.val); return !!v && (v === target || v.includes(target) || target.includes(v)); }).map((s) => s.label);
  const verified = matched.length >= 2;                          // ✓✓ ONLY when >=2 independent slots agree
  const gstNote = idn?.gst ? ' (+GST on file)' : '';
  return {
    company: titleCase(candidate),
    confidence: verified ? 90 : (matched.length === 1 ? 60 : 40),
    source: (matched.length ? matched.join(' + ') : 'single slot') + gstNote,
    verified,
    matchedSlots: matched,
  };
}

// ── DEVICE (V10 §F) — which surface the buyer transacted on, for the Available chip ──────────────────────────
// Read the REAL CSL `channel` field (verified values: "IndiaMART Android app" · "IndiaMART mobile site" · "Android
// web" · "iOS web" · "IndiaMART desktop" · "My IndiaMART (logged-in)" · "Search/Directory"). Owner intent = "is the
// APP installed?" — the truthful signal is the explicit APP channel; "Android web" / "iOS web" are mobile BROWSERS,
// NOT the app, so they do NOT count as app-installed (mapping them to "app" would be wrong against the real codes).
// IMOB / mobile site → Mobile site · WhatsApp activity → WhatsApp · everything else (desktop / my-imart / web) → Desktop.
export interface DeviceInfo { device: string; source: string; note: string }
export function resolveDevice(rich: unknown): DeviceInfo | null {
  const csl = summaryOf(rich, 'csl');
  const wa = summaryOf(rich, 'whatsapp');
  const channel = pick(csl, 'channel', 'device_channel', 'source_channel').toLowerCase();
  const hasCsl = Object.keys(csl).length > 0;
  const hasWa = Object.keys(wa).length > 0;
  // explicit APP channel = app installed (NOT "android web"/"ios web", which are mobile browsers)
  if (/\bapp\b/.test(channel) && /android/.test(channel)) return { device: 'Android app', source: 'CSL · channel', note: `channel "${channel}" → IndiaMART Android app installed` };
  if (/\bapp\b/.test(channel) && /ios|iphone|ipad/.test(channel)) return { device: 'iOS app', source: 'CSL · channel', note: `channel "${channel}" → IndiaMART iOS app installed` };
  if (/mobile site|imob|m\.indiamart|msite|\bwap\b/.test(channel)) return { device: 'Mobile site', source: 'CSL · channel', note: `channel "${channel}" → IndiaMART mobile site` };
  if (hasWa) return { device: 'WhatsApp', source: 'WhatsApp timeline', note: 'buyer engaged primarily over WhatsApp' };
  if (channel) return { device: 'Desktop', source: 'CSL · channel', note: `channel "${channel}" → desktop / mobile-web (no app channel seen)` };
  if (hasCsl) return { device: 'Desktop', source: 'CSL · on-site behaviour', note: 'on-site activity, no channel field → desktop web (default)' };
  return null;
}

// ── REPEAT SEGMENT (V10 §J1) — deterministic unique-PURCHASE-WEEK count over the buyer's BuyLeads ─────────────
// Owner rule: count DISTINCT calendar weeks the buyer posted a requirement (two BuyLeads in the SAME week = one
// week, never a "repeat"). >=20 unique weeks → HIGH repeat, >=10 → MEDIUM, <10 → don't populate. Deterministic;
// NEVER passed to the LLM — it is a hard count, not a judgement.
export interface RepeatSegment { segment: 'High' | 'Medium'; weeks: number; leads: number; note: string }
// IndiaMART BuyLead dates arrive as "18-JUN-26" (DD-MON-YY) — Date.parse can't read that. Parse it ourselves; fall
// back to native Date.parse for ISO; then to recency_days. Returns epoch-ms or NaN.
const MON: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseBuyLeadDate(s: string): number {
  const m = /^(\d{1,2})[-/\s]([A-Za-z]{3})[-/\s](\d{2,4})$/.exec(s.trim());
  if (m) {
    const day = Number(m[1]); const mon = MON[m[2].toLowerCase()]; let yr = Number(m[3]);
    if (mon != null && !isNaN(day)) { if (yr < 100) yr += 2000; return Date.UTC(yr, mon, day); }
  }
  const p = Date.parse(s);
  return isNaN(p) ? NaN : p;
}
export function repeatSegment(rich: unknown): RepeatSegment | null {
  const sum = summaryOf(rich, 'requirement');
  // merged feed uses `requirements`; raw/legacy uses `buyleads`/`items`/`leads` — accept any populated array.
  const reqs = [sum.requirements, sum.buyleads, sum.items, sum.leads].find((a) => Array.isArray(a) && a.length) as unknown[] | undefined;
  if (!reqs || !reqs.length) return null;
  const DAY = 86400000;
  const nowMs = Date.now();
  const weekSet = new Set<number>();
  let leads = 0;
  for (const it of reqs) {
    const r = obj(it);
    leads++;
    let ts = NaN;
    const posted = pick(r, 'posted', 'posted_on', 'date', 'created', 'created_at', 'generated_date', 'gen_date');
    if (posted) ts = parseBuyLeadDate(posted);
    if (isNaN(ts)) { const rd = Number(pick(r, 'recency_days', 'age_days')); if (!isNaN(rd) && rd >= 0) ts = nowMs - rd * DAY; }
    if (isNaN(ts)) continue;
    weekSet.add(Math.floor(ts / (7 * DAY)));
  }
  const w = weekSet.size;
  if (w >= 20) return { segment: 'High', weeks: w, leads, note: `${w} distinct purchase weeks across ${leads} BuyLeads → HIGH repeat (≥20 unique weeks). Same-week re-posts collapsed to one week.` };
  if (w >= 10) return { segment: 'Medium', weeks: w, leads, note: `${w} distinct purchase weeks across ${leads} BuyLeads → MEDIUM repeat (≥10 unique weeks). Same-week re-posts collapsed to one week.` };
  return null;
}

// ── GST-ADVANCE (KYB · GST Verification Advance) — sources.gst.summary.advance reader ────────────────────────
// The smartauth FFFQ/v2 endpoint returns the FULL registered-business record for a GSTIN. Deterministic, highest-
// trust identity. We surface: legal/trade name, constitution, status, taxpayer type, registered address, SAC codes
// + descriptions (→ industry), business_nature (→ role: wholesaler/retailer/manufacturer/service), authorized
// signatories (→ name↔company corroboration), turnover (when not "NA" → scale), filing cadence (→ live/compliant),
// and verified business email/mobile. "NA"/blank fields are dropped. Activates once the n8n gst-advance node ships.
const naClean = (v: unknown): string | undefined => { const x = str(v); return (!x || /^na$/i.test(x)) ? undefined : x; };
const ddmmyyyy = (s: string): number => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s.trim()); if (!m) { const p = Date.parse(s); return isNaN(p) ? NaN : p; } let y = Number(m[3]); if (y < 100) y += 2000; return Date.UTC(y, Number(m[2]) - 1, Number(m[1])); };
export interface GstAdvanceFiling { latest?: string; types: string[]; count: number }
export interface GstAdvance {
  gstin?: string; legalName?: string; tradeName?: string; constitution?: string; status?: string; taxpayerType?: string;
  registeredAddress?: string; registrationDate?: string; cancellationDate?: string;
  natureOfBusiness: string[]; sac: { code: string; desc: string }[]; signatories: string[];
  turnover?: string; email?: string; mobile?: string;
  centralJurisdiction?: string; stateJurisdiction?: string;
  filing: GstAdvanceFiling; fieldVisit?: string; eInvoice?: string; complianceRating?: string;
}
export function gstAdvance(rich: unknown): GstAdvance | null {
  const adv = obj(summaryOf(rich, 'gst').advance);
  if (!Object.keys(adv).length) {
    // FALLBACK — Befisc GST-advance absent, but IDfy GST-cert / the 3-vendor consensus carry the same registry record.
    // Build a GstAdvance from gst_cert_idfy.certificates[0] ⊕ gst_detail_union.gst_details[0].fields so the L6 "GST
    // Verified" ribbon + the Company anchor light up on THIS data shape. (Fixes the owner's "I don't see GST" complaint.)
    const cert = obj(asArr(summaryOf(rich, 'gst_cert_idfy').certificates)[0]);
    const gd = obj(asArr(summaryOf(rich, 'gst_detail_union').gst_details)[0]);
    const F = obj(gd.fields);
    const canon = (f: string, fallback = ''): string => { const o = obj(F[f]); const c = o.canonical; return (Array.isArray(c) ? c.map(str).join(', ') : str(c)) || fallback; };
    const gstin = str(cert.gstin) || str(gd.gstin);
    if (!gstin) return null;
    const natureArr = Array.isArray(cert.nature_of_business_activity) ? (cert.nature_of_business_activity as unknown[]).map(str) : (Array.isArray(obj(F.nature_of_business_activity).canonical) ? (obj(F.nature_of_business_activity).canonical as unknown[]).map(str) : []);
    return {
      gstin,
      legalName: naClean(canon('legal_name', str(cert.legal_name))),
      tradeName: naClean(canon('trade_name', str(cert.trade_name))),
      constitution: naClean(canon('constitution_of_business', str(cert.constitution_of_business))),
      status: naClean(canon('gstin_status', str(cert.gstin_status))),
      taxpayerType: naClean(canon('taxpayer_type', str(cert.taxpayer_type))),
      registeredAddress: naClean(canon('address', str(cert.address))),
      registrationDate: naClean(canon('date_of_registration', str(cert.date_of_registration))),
      natureOfBusiness: natureArr.filter(Boolean),
      sac: [], signatories: [], filing: { types: [], count: 0 },
    };
  }
  // filing_status arrives nested ([[{...}]]); flatten, dedupe return types, find the latest filed date
  const filingFlat = (Array.isArray(adv.filing_status) ? (adv.filing_status as unknown[]).flat(Infinity) : []).map(obj).filter((f) => Object.keys(f).length);
  let latestTs = NaN, latest: string | undefined;
  const types = new Set<string>();
  for (const f of filingFlat) { const t = str(f.rtntype); if (t) types.add(t); const ts = ddmmyyyy(str(f.dof)); if (!isNaN(ts) && (isNaN(latestTs) || ts > latestTs)) { latestTs = ts; latest = `${str(f.rtntype)} ${str(f.taxp)} ${str(f.fy)} (${str(f.status)})`; } }
  const sac = (Array.isArray(adv.business_details) ? adv.business_details as unknown[] : []).map(obj).map((d) => ({ code: str(d.saccd), desc: str(d.sdes) })).filter((d) => d.code || d.desc);
  const pad = obj(adv.primary_business_address);
  return {
    gstin: naClean(adv.gstin),
    legalName: naClean(adv.legal_name),
    tradeName: naClean(adv.trade_name),
    constitution: naClean(adv.business_constitution),
    status: naClean(adv.current_registration_status),
    taxpayerType: naClean(adv.tax_payer_type),
    registeredAddress: naClean(pad.registered_address) || naClean(pad.detailed_address),
    registrationDate: naClean(adv.register_date),
    cancellationDate: naClean(adv.register_cancellation_date),
    natureOfBusiness: (Array.isArray(adv.business_nature) ? adv.business_nature as unknown[] : []).map(str).filter(Boolean),
    sac,
    signatories: (Array.isArray(adv.authorized_signatory) ? adv.authorized_signatory as unknown[] : []).map(str).filter(Boolean),
    turnover: naClean(adv.aggregate_turn_over) || naClean(adv.gross_total_income),
    email: naClean(adv.business_email),
    mobile: naClean(adv.business_mobile),
    centralJurisdiction: naClean(adv.central_jurisdiction),
    stateJurisdiction: naClean(adv.state_jurisdiction),
    filing: { latest, types: [...types], count: filingFlat.length },
    fieldVisit: naClean(adv.is_field_visit_conducted),
    eInvoice: naClean(adv.mandate_e_invoice),
    complianceRating: naClean(adv.compliance_rating),
  };
}
