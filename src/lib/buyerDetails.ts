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
const str = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? '' : String(v)).trim();
// first non-empty value across a set of candidate keys (merged nodes vary key names across versions)
const pick = (o: Record<string, unknown>, ...keys: string[]): string => { for (const k of keys) { const v = str(o[k]); if (v) return v; } return ''; };
const list = (o: Record<string, unknown>, ...keys: string[]): string[] => {
  for (const k of keys) { const v = o[k]; if (Array.isArray(v)) { const a = v.map(str).filter(Boolean); if (a.length) return [...new Set(a)]; } else { const s = str(v); if (s) return [s]; } }
  return [];
};

export interface MergedIdentity { name?: string; company?: string; city?: string; state?: string; address?: string; memberSince?: string; designation?: string; emails: string[]; mobiles: string[]; pan?: string; gst?: string }
export interface MergedExternal { verifiedName?: string; verifiedNameConfidence?: number; verifiedNameSource?: string; pan?: string; pans: string[]; gender?: string; dob?: string; city?: string; state?: string; location?: string; incomeBand?: string; age?: string; socialPlatforms: string[]; socialPresenceCount?: number; emails: string[]; mobiles: string[] }
export interface AvailabilityRow { key: 'mobile' | 'email' | 'address' | 'pan' | 'gst'; label: string; present: boolean; verified: boolean; value: string; externalValue?: string; source: string; note: string }

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
  if (!Object.keys(s).length) return null;
  return {
    name: pick(s, 'name', 'buyer_name', 'first_name', 'ceo_name') || undefined,
    company: pick(s, 'company', 'company_name', 'companyname') || undefined,
    city: pick(s, 'city', 'buyer_city') || undefined,
    state: pick(s, 'state', 'buyer_state') || undefined,
    address: pick(s, 'address', 'full_address') || undefined,
    memberSince: pick(s, 'member_since', 'membersince', 'usersince', 'registered_on', 'joined') || undefined,
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

export function resolveAvailable(idn: MergedIdentity | null, ext: MergedExternal | null): AvailabilityRow[] {
  const rows: AvailabilityRow[] = [];
  const idnAddress = idn ? (idn.address || [idn.city, idn.state].filter(Boolean).join(', ')) : '';
  const extLocation = ext ? (ext.location || [ext.city, ext.state].filter(Boolean).join(', ')) : '';

  const add = (key: AvailabilityRow['key'], label: string, value: string, externalValue: string, matched: boolean) => {
    const present = !!value;
    const verified = present && !!externalValue && matched;
    const note = !present ? 'not in profile' : verified ? `Profile: ${value} · External(Befisc/Sign3): ${externalValue} — values AGREE → cross-source verified ✓✓` : externalValue ? `Profile: ${value} · External: ${externalValue} — present in both but values differ (single ✓)` : `Profile: ${value} — no external corroboration on file (single ✓)`;
    const source = !present ? '—' : verified ? 'Profile ⊕ External (matched)' : 'Profile';
    rows.push({ key, label, present, verified, value, externalValue: externalValue || undefined, source, note });
  };

  add('mobile', 'Mobile', idn?.mobiles[0] || '', ext?.mobiles[0] || '', !!idn?.mobiles[0] && !!ext?.mobiles[0] && digits(idn.mobiles[0]) === digits(ext.mobiles[0]));
  add('email', 'Email', idn?.emails[0] || '', ext?.emails[0] || '', !!idn?.emails[0] && !!ext?.emails[0] && lc(idn.emails[0]) === lc(ext.emails[0]));
  // surface the MOST-COMPLETE address (Befisc full_address is far richer than the bare city/state)
  const bestAddr = (extLocation && extLocation.length > idnAddress.length) ? extLocation : idnAddress;
  add('address', 'Address', bestAddr, extLocation, !!idnAddress && !!extLocation && (lc(idnAddress).includes(lc(idn?.city || '')) && lc(extLocation).includes(lc(idn?.city || '')) && !!idn?.city));
  add('pan', 'PAN', idn?.pan || '', ext?.pan || '', !!idn?.pan && !!ext?.pan && lc(idn.pan) === lc(ext.pan));
  // GST is buyer-supplied only; external rarely carries it — verified only when the external PAN is embedded in the GSTIN (chars 3-12)
  const gstPanMatch = !!idn?.gst && !!ext?.pan && lc(idn.gst).includes(lc(ext.pan));
  add('gst', 'GST', idn?.gst || '', gstPanMatch ? ext!.pan! : '', gstPanMatch);
  return rows;
}

// ── NAME RESOLUTION (owner Q6/Q14/Q24/Q37) — pick the BEST full name + a confidence band ───────────────────
// Profile often carries only a first name ("Jaiveer"); the paid external source carries the bank-verified FULL
// name ("JAYVEER SINGH"). Prefer the most-complete name (more words wins), tie-break to the verified one, and
// Title-Case it. Confidence = the external verified-name band when that's the source; a softer band when we only
// have the profile first name. Deterministic; the name itself is PII but kept (debug/requirement form, owner-OK).
const titleCase = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
export interface ResolvedName { name: string; confidence: number; source: string; full: boolean }
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
  return { name: titleCase(chosen), confidence: Math.round(conf), source: src, full: words(chosen) > 1 };
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
