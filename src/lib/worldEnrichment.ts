// ─── World Enrichment — connect the RFQ to the buyer's OUTSIDE world ──────────
// Standalone (NOT wired into the form yet — placement decided after review).
// Chain: buyer mobile (from the GLID dump: glusr_usr_ph_mobile) →
//   Mobile→GST → GST→MCC/HSN + GST(Advance) [turnover · SAC/HSN · compliance] +
//   Mobile→Udyam [MSME] + company OSINT (public web) → a BUSINESS context object
//   that sharpens the Twin ("what does this buyer actually trade in / make?").
//
// Vendor: Befisc / Sign3 on base `https://prod.smartauth.co/<CODE>` (POST,
//   header `authkey`, JSON body, most need `consent:"Y"` + consent_text).
//   Profile Advance = /C9S1 · Udyam = /TGAG (the only 2 codes in the shared docs;
//   the rest must come from your API console — see endpoints map below).
//
// ⚠ TWO SEPARATE PII TIERS — by design:
//   • BUSINESS tier (GST/HSN/turnover/Udyam/OSINT) → SAFE to feed the Twin +
//     (HSN/sector only, never turnover/contact) the seller-facing requirement.
//   • PERSONAL tier (Profile Advance: name/DOB/income/home addresses/alt-phones/
//     PAN) → consent-gated KYC PII. OFF by default. NEVER feed the Twin or sellers.
//   PROD MUST run this SERVER-SIDE (keys + PII must never reach the client).

export interface WorldEndpoints {
  mobileToGst?: string;   // #47 Mobile→GST   → GSTIN
  gstToMcc?: string;      // #53 GST→MCC      → Type of Goods + HSN + MCC
  gstAdvance?: string;    // #40 GST(Advance) → turnover · SAC/HSN · compliance · addresses
  mobileToUdyam?: string; // #72 Mobile→Udyam → MSME (NIC activity, enterprise type)
  profileAdvance?: string; // #98 /C9S1 — PERSONAL lookup (gated; default off)
}

export interface WorldBusiness {
  gstin?: string;
  legalName?: string;
  tradeName?: string;
  constitution?: string;       // Proprietorship / Partnership / Pvt Ltd …
  taxpayerType?: string;
  status?: string;             // Active / Cancelled …
  registrationDate?: string;
  turnoverBand?: string;       // e.g. "Rs. 1.5 Cr. to 5 Cr." — NEVER shown to sellers
  hsnCodes: string[];          // what they trade in — the key category signal
  sacCodes: string[];
  natureOfBusiness?: string;   // Supplier of Services / Manufacturer / Trader …
  goodsDescription?: string;   // GST→MCC "Type of Goods"
  udyam?: { type?: string; nicActivity?: string; majorActivity?: string };
  verified: boolean;
}

export interface WorldOsint {
  summary?: string;            // 1–2 line public business description
  productLines?: string[];
  isAlsoSeller?: boolean;      // has a live marketplace catalog (strong signal)
  sourceUrls?: string[];
  match_basis?: string[];      // WHAT the web match hinged on (drives confidence)
  confidence?: number;         // osintMatchConfidence(match_basis)
}

// ── Source trust model (per spec) ───────────────────────────────────────────
// Internal n8n profile/transcript + KYC (Sign3) + govt registry (Befisc) are
// AUTHORITATIVE. Open-web is only as strong as the KEY the match hinged on.
export const SOURCE_CONFIDENCE = { internal_n8n: 95, sign3: 90, befisc_gst: 92, befisc_udyam: 90 } as const;
export function osintMatchConfidence(basis: string[] = []): number {
  const b = basis.map((s) => String(s).toLowerCase());
  const strong = ['gst', 'gstin', 'mobile', 'phone', 'website', 'domain', 'email'];
  if (b.some((x) => strong.includes(x))) return 92;                                     // unique identifier
  if (b.includes('company_name') && (b.includes('marketplace_catalog') || b.includes('website'))) return 88;
  if (b.includes('company_name') && b.includes('location')) return 62;                  // company + city = medium
  if (b.includes('company_name')) return 55;
  if (b.includes('name') && b.includes('location')) return 42;                          // person name + city = weak
  return 35;
}

// ChatGPT's accountability ledger — every external fact + WHY we trust it, so any
// downstream conclusion ("packaging manufacturer") traces to {source,key,confidence}.
export interface ExternalEvidenceEntry {
  source: 'Internal' | 'GST' | 'Udyam' | 'Sign3' | 'OSINT';
  key_used: string;        // 'mobile' | 'GSTIN' | 'GSTIN→HSN' | 'company_name+website' | …
  confidence: number;
  fetched_at: string;
  raw_value?: unknown;     // redacted for identity-tier (PII stays server-side)
}

export interface WorldContext {
  glid?: string;
  mobileMasked: string;        // never store the raw mobile in the result
  business: WorldBusiness;
  osint: WorldOsint;
  // PERSONAL — populated ONLY when explicitly requested + consent captured. Gated.
  personal?: Record<string, unknown>;
  steps: Array<{ api: string; status: 'live' | 'no-record' | 'unauthorized' | 'error' | 'skipped'; code?: number; ms?: number }>;
  evidence_ledger?: ExternalEvidenceEntry[]; // traceability — see ExternalEvidenceEntry
  confidence: number;          // 0-100, by how many business steps succeeded
}

const BASE = 'https://prod.smartauth.co';
const CONSENT_TEXT =
  'We confirm obtaining valid customer consent to access/process their data. Consent remains valid, informed, and unwithdrawn.';

const mask = (m: string) => (m && m.length >= 4 ? `XXXXXX${m.slice(-4)}` : 'XXXXXX');

type BefiscResult = { status: WorldContext['steps'][number]['status']; code?: number; data?: Record<string, unknown>; ms: number };
const SKIP: BefiscResult = { status: 'skipped', ms: 0 };

// One Befisc/smartauth call. Returns {status,code,data}. Never throws.
async function befisc(
  code: string | undefined,
  body: Record<string, unknown>,
  authkey: string,
  fetchImpl: typeof fetch = fetch
): Promise<BefiscResult> {
  if (!code) return { status: 'skipped', ms: 0 };
  const t0 = Date.now();
  try {
    const r = await fetchImpl(`${BASE}/${code}`, {
      method: 'POST',
      headers: { authkey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: 'Y', consent_text: CONSENT_TEXT, ...body }),
    });
    const j = (await r.json()) as { status?: number; result?: Record<string, unknown>; data?: Record<string, unknown> };
    const ms = Date.now() - t0;
    const sc = Number(j?.status);
    if (sc === 401 || sc === 402 || sc === 404) return { status: 'unauthorized', code: sc, ms };
    if (sc === 2 || sc === 3) return { status: 'no-record', code: sc, ms };
    if (sc === 1) return { status: 'live', code: sc, data: (j.result || j.data || j) as Record<string, unknown>, ms };
    return { status: 'error', code: sc, ms };
  } catch {
    return { status: 'error', ms: Date.now() - t0 };
  }
}

/**
 * Compile the buyer's BUSINESS world from a mobile (+ optional known GST).
 * Personal (Profile Advance) is OFF unless opts.includePersonal === true.
 * `osintFn` is injected (LLM- or search-backed) so the module stays I/O-agnostic.
 */
export async function fetchWorldContext(args: {
  mobile: string;
  gstin?: string;
  companyName?: string;
  city?: string;
  glid?: string;
  authkey: string;
  endpoints: WorldEndpoints;
  includePersonal?: boolean;
  osintFn?: (companyName: string, city?: string) => Promise<WorldOsint>;
  fetchImpl?: typeof fetch;
}): Promise<WorldContext> {
  const { mobile, authkey, endpoints, fetchImpl } = args;
  const steps: WorldContext['steps'] = [];
  const business: WorldBusiness = { hsnCodes: [], sacCodes: [], verified: false };

  // 1) Resolve GSTIN (use the one we already have, else Mobile→GST).
  let gstin = args.gstin;
  if (!gstin && mobile) {
    const r = await befisc(endpoints.mobileToGst, { mobile }, authkey, fetchImpl);
    steps.push({ api: 'mobileToGst', status: r.status, code: r.code, ms: r.ms });
    gstin = (r.data?.gst_number || r.data?.gstin || r.data?.GSTIN) as string | undefined;
  }
  business.gstin = gstin;

  // 2) In PARALLEL off the GSTIN: HSN (GST→MCC), full GST profile, MSME (Udyam).
  const [mcc, adv, udyam, osint] = await Promise.all([
    gstin ? befisc(endpoints.gstToMcc, { gst: gstin }, authkey, fetchImpl) : Promise.resolve(SKIP),
    gstin ? befisc(endpoints.gstAdvance, { gst: gstin }, authkey, fetchImpl) : Promise.resolve(SKIP),
    befisc(endpoints.mobileToUdyam, { mobile }, authkey, fetchImpl),
    args.osintFn && args.companyName ? args.osintFn(args.companyName, args.city).catch(() => ({} as WorldOsint)) : Promise.resolve({} as WorldOsint),
  ]);
  steps.push({ api: 'gstToMcc', status: mcc.status, code: mcc.code, ms: mcc.ms });
  steps.push({ api: 'gstAdvance', status: adv.status, code: adv.code, ms: adv.ms });
  steps.push({ api: 'mobileToUdyam', status: udyam.status, code: udyam.code, ms: udyam.ms });
  steps.push({ api: 'osint', status: (osint && (osint as WorldOsint).summary) ? 'live' : 'skipped' });

  if (mcc.data) {
    const hsn = String(mcc.data.hsn_code || mcc.data.HSN || '').trim();
    if (hsn) business.hsnCodes.push(hsn);
    business.goodsDescription = (mcc.data.type_of_goods || mcc.data.goods) as string | undefined;
  }
  if (adv.data) {
    business.legalName = (adv.data.legal_name || adv.data.legalName) as string | undefined;
    business.tradeName = (adv.data.trade_name || adv.data.tradeName) as string | undefined;
    business.constitution = adv.data.constitution as string | undefined;
    business.taxpayerType = adv.data.taxpayer_type as string | undefined;
    business.status = (adv.data.status || adv.data.registration_status) as string | undefined;
    business.turnoverBand = (adv.data.aggregate_turnover || adv.data.turnover) as string | undefined;
    business.natureOfBusiness = adv.data.nature_of_business as string | undefined;
    // audit P2: keep goods (HSN) and services (SAC) codes in their OWN buckets — the old `sac_codes || hsn_codes`
    // stashed HSN goods codes into sacCodes (services) whenever only HSN was returned, mislabelling them.
    if (Array.isArray(adv.data.sac_codes)) business.sacCodes = (adv.data.sac_codes as unknown[]).map(String);
    if (Array.isArray(adv.data.hsn_codes) && !business.hsnCodes.length) business.hsnCodes = (adv.data.hsn_codes as unknown[]).map(String);
    // audit 2026-07-13 (P1): substring includes('active') matched "Inactive"/"Not Active" as verified=true. Match the
    // active state exactly (allow only a leading modifier-free "active"/"verified"), and reject explicit negatives.
    business.verified = (() => { const st = business.status?.trim().toLowerCase() || ''; if (!st) return false; if (/\b(in-?active|cancel|suspend|not\s+active|not\s+verified|deactivat)/.test(st)) return false; return /^(active|verified)\b/.test(st); })();
  }
  if (udyam.data) {
    business.udyam = {
      type: udyam.data.type_of_enterprise as string,
      nicActivity: (udyam.data.nic_activity || udyam.data.nature_of_business) as string,
      majorActivity: udyam.data.major_activity as string,
    };
  }

  // 3) PERSONAL — only if explicitly opted in (consent captured upstream).
  let personal: Record<string, unknown> | undefined;
  if (args.includePersonal) {
    const p = await befisc(endpoints.profileAdvance, { mobile }, authkey, fetchImpl);
    steps.push({ api: 'profileAdvance', status: p.status, code: p.code, ms: p.ms });
    if (p.data) personal = p.data; // PII — caller must keep server-side, never feed Twin/sellers
  }

  const okSteps = steps.filter((s) => s.api !== 'profileAdvance' && s.status === 'live').length;
  return {
    glid: args.glid,
    mobileMasked: mask(mobile),
    business,
    osint: (osint as WorldOsint) || {},
    personal,
    steps,
    confidence: Math.min(100, okSteps * 25),
  };
}

// Map the BUSINESS world into the Twin's vocabulary — HSN/sector/scale/verified
// ONLY. No turnover figures, no contact, no personal data leaves this function.
export function worldToTwinSignals(w: WorldContext): {
  trades_in?: string;        // goods description / HSN-derived
  hsn?: string[];
  business_nature?: string;  // Manufacturer / Trader / Service …
  scale_band?: string;       // coarse, internal only
  gst_verified?: boolean;
  is_also_seller?: boolean;
  osint_summary?: string;
} {
  return {
    trades_in: w.business.goodsDescription || w.osint.summary,
    hsn: w.business.hsnCodes.length ? w.business.hsnCodes : undefined,
    business_nature: w.business.natureOfBusiness || w.business.udyam?.majorActivity,
    scale_band: w.business.turnoverBand ? 'has-gst-turnover' : undefined, // band itself stays internal
    gst_verified: w.business.verified,
    is_also_seller: w.osint.isAlsoSeller,
    osint_summary: w.osint.summary,
  };
}
