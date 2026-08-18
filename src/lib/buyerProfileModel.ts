// ─── TrustSEAL Buyer Profile — DATA LAYER (decoupled from the UI, per owner §5) ──────────────────────────────
// ONE parseBuyerProfile(rich) → a normalized BuyerProfileModel the card renders. ZERO fabricated data: every field
// either traces to a real JSON path or carries present:false (the UI renders an explicit "Not available" state).
// Provenance is first-class — a field knows whether it is registry-grade, cross-source-triangulated, single-source,
// or LLM-inferred (web_osint), so the card can badge it. Reads `__health` per node: a node whose health is ok:false
// or status skipped/timeout/no_data is treated as UNAVAILABLE (no partial render off a failed fetch). PURE, no LLM.
import { identityFromMerged, externalFromMerged, bandConfidence, gstAdvance, type GstAdvance } from './buyerDetails';
import { waFromMerged } from './whatsappTimeline';
import { requirementsFromMerged, type Requirement } from './requirements';

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? '' : String(v)).trim();

// ── provenance grades (drive the badge + the conflict priority) ──────────────────────────────────────────────
export type Provenance = 'registry' | 'triangulated' | 'single' | 'inferred' | 'derived' | 'composed' | 'absent';
export interface Field<T = string> {
  value: T | null;
  present: boolean;
  provenance: Provenance;
  source: string;              // human label of the origin ("GST certificate", "web_osint (LLM)", …)
  confidence?: number;         // 0-100 when known (esp. inferred / verified-name)
  agreementCount?: number;     // # of independent vendors that carry this value
  foundBy?: string[];
  inferred?: boolean;          // true → web_osint / LLM synthesis → card shows the "inferred" marker
  note?: string;
  alternates?: { value: string; source: string; foundBy?: string[] }[]; // never discarded — surfaced on hover/expand
}
const absentField = (source = '—'): Field => ({ value: null, present: false, provenance: 'absent', source });
const field = (value: string, provenance: Provenance, source: string, extra: Partial<Field> = {}): Field =>
  (value ? { value, present: true, provenance, source, inferred: provenance === 'inferred', ...extra } : absentField(source));

// ── §4 empty-state detector — web_osint strings like "no official website found in the supplied records" must NEVER
// render as if real. Every web/social/plan value passes through this before display. ─────────────────────────────
export function isAbsent(value: string | null | undefined): boolean {
  if (!value) return true;
  const v = String(value).trim();
  if (!v) return true;
  // v20 audit fix: broadened — (a) "provided sources" as well as "supplied records" (Parallel says the former),
  // (b) embedded \bundefined\b (a malformed scrape slug like ".../jaiveer-...-undefined-0192663b3" must be rejected, not link-ified).
  return /no\s+(account|company|official website|google business rating|website|record|data|listing)[^.]*found|not\s+found\s+in\s+(the\s+)?(supplied|provided)\s+(records?|sources?)|no\s+.*found\s+in\s+the\s+(supplied|provided)|\bundefined\b|^n\/?a$|^-+$|^none$|^null$|^unknown$|not available|no\s+pan\s+on\s+file|^skipped$/i.test(v);
}
// clean a possibly-absent web string → real value or null
const webVal = (v: unknown): string | null => { const s = str(v); return (!s || isAbsent(s)) ? null : s; };

// ── SHARED digital-footprint platform → bucket map (audit BPC-84) — ONE source of truth so the GLADMIN card
// (FootprintChips) and the BuyLead card (BL footprint builder) surface the IDENTICAL set from the same Sign3
// social_platforms data. UPPERCASE match key → display label + bucket. (IndiaMART / GST / Udyam / EPFO are added
// per-surface from their own model fields, not from social_platforms.) ────────────────────────────────────────────
export type FootprintBucket = 'b2b' | 'social' | 'consumer' | 'discovery';
export const PLATFORM_BUCKET: Array<{ key: string; label: string; bucket: FootprintBucket }> = [
  { key: 'TRADEINDIA', label: 'TradeIndia', bucket: 'b2b' }, { key: 'EXPORTERSINDIA', label: 'ExportersIndia', bucket: 'b2b' }, { key: 'ALIBABA', label: 'Alibaba', bucket: 'b2b' },
  { key: 'FACEBOOK', label: 'Facebook', bucket: 'social' }, { key: 'INSTAGRAM', label: 'Instagram', bucket: 'social' }, { key: 'LINKEDIN', label: 'LinkedIn', bucket: 'social' }, { key: 'TWITTER', label: 'Twitter/X', bucket: 'social' }, { key: 'X', label: 'Twitter/X', bucket: 'social' }, { key: 'YOUTUBE', label: 'YouTube', bucket: 'social' },
  { key: 'AMAZON', label: 'Amazon', bucket: 'consumer' }, { key: 'FLIPKART', label: 'Flipkart', bucket: 'consumer' }, { key: 'SNAPDEAL', label: 'Snapdeal', bucket: 'consumer' }, { key: 'MYNTRA', label: 'Myntra', bucket: 'consumer' },
  { key: 'JUSTDIAL', label: 'JustDial', bucket: 'discovery' }, { key: 'INDIABIZ', label: 'IndiaBiz', bucket: 'discovery' }, { key: 'CRUNCHBASE', label: 'Crunchbase', bucket: 'discovery' },
];
export function bucketPlatforms(platforms: readonly string[]): Record<FootprintBucket, string[]> {
  const up = new Set((platforms || []).map((p) => String(p).toUpperCase()));
  const out: Record<FootprintBucket, string[]> = { b2b: [], social: [], consumer: [], discovery: [] };
  for (const { key, label, bucket } of PLATFORM_BUCKET) if (up.has(key) && !out[bucket].includes(label)) out[bucket].push(label);
  return out;
}

// ── §3 reusable reconciliation — one function, source-priority + agreement, alternates always kept ──────────────
export type SourceTier = 'registry' | 'agreement' | 'thirdparty' | 'web';
const TIER_RANK: Record<SourceTier, number> = { registry: 4, agreement: 3, thirdparty: 2, web: 1 };
const normVal = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
export interface ReconcileInput { value: string; source: string; tier: SourceTier; foundBy?: string[]; confidence?: number }
export interface ReconcileResult {
  primaryValue: string; primarySource: string; primaryTier: SourceTier;
  agreementCount: number; conflicting: boolean;
  alternates: { value: string; source: string; foundBy?: string[] }[];
}
export function reconcileField(sources: ReconcileInput[]): ReconcileResult | null {
  const clean = sources.filter((s) => s.value && s.value.trim());
  if (!clean.length) return null;
  // group by normalized value → agreement is # of DISTINCT sources carrying the same value
  const groups = new Map<string, ReconcileInput[]>();
  for (const s of clean) { const k = normVal(s.value); (groups.get(k) || groups.set(k, []).get(k)!).push(s); }
  const ranked = [...groups.values()].map((g) => {
    const best = [...g].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
    const vendors = new Set<string>(); g.forEach((x) => (x.foundBy || [x.source]).forEach((v) => vendors.add(v)));
    return { rep: best, agreement: vendors.size, tier: best.tier };
  }).sort((a, b) => (b.agreement - a.agreement) || (TIER_RANK[b.tier] - TIER_RANK[a.tier]));
  const winner = ranked[0];
  return {
    primaryValue: winner.rep.value, primarySource: winner.rep.source, primaryTier: winner.tier,
    agreementCount: winner.agreement, conflicting: ranked.length > 1,
    alternates: ranked.slice(1).map((r) => ({ value: r.rep.value, source: r.rep.source, foundBy: r.rep.foundBy })),
  };
}

// ── §3 address triangulation — GST-registry canonical vs web_osint.official_address ─────────────────────────────
export function triangulateAddress(gstAddr: string | null, webAddr: string | null): Field {
  const g = gstAddr && !isAbsent(gstAddr) ? gstAddr.trim() : '';
  const w = webAddr && !isAbsent(webAddr) ? webAddr.trim() : '';
  if (!g && !w) return absentField('GST registry / web_osint');
  if (g && w) {
    // audit P2: a 24-char prefix let a city-only web string "agree" with any full GST address in that city. Require the
    // SHORTER address to be substantial (≥30 chars) AND fully contained in the longer one before claiming 2-source agreement.
    const gn = normVal(g), wn = normVal(w); const shorter = gn.length <= wn.length ? gn : wn; const longer = gn.length <= wn.length ? wn : gn;
    const match = shorter.length >= 30 && longer.includes(shorter);
    if (match) return { value: g, present: true, provenance: 'triangulated', source: 'GST certificate ⊕ web_osint (agree)', note: 'confirmed by 2 independent sources' };
    return { value: g, present: true, provenance: 'registry', source: 'GST certificate (registry)', note: 'web_osint reported a different address', alternates: [{ value: w, source: 'web_osint (LLM)' }] };
  }
  if (g) return field(g, 'registry', 'GST certificate (registry)');
  return { value: w, present: true, provenance: 'inferred', source: 'web_osint (LLM)', inferred: true, confidence: 60 };
}

// ── per-node health gate ────────────────────────────────────────────────────────────────────────────────────
function nodeOk(rich: unknown, key: string): boolean {
  const node = obj(obj(obj(rich).sources)[key]);
  const h = obj('__health' in node ? node.__health : obj(node.summary).__health);
  if (!Object.keys(h).length) return true;                       // no health signal → don't hide present data
  if (h.ok === false) return false;
  const st = str(h.status).toLowerCase();
  return !['skipped', 'timeout', 'no_data', 'error'].includes(st);
}
function summaryOf(rich: unknown, key: string): Record<string, unknown> {
  if (!nodeOk(rich, key)) return {};
  const node = obj(obj(obj(rich).sources)[key]);
  return obj('summary' in node ? node.summary : node);
}

// ── the normalized model the card consumes ──────────────────────────────────────────────────────────────────
export interface StatTile { label: string; value: number | null; sourceNote: string }
export interface LabeledField { label: string; field: Field }
export interface IdentitySignals { registered: { name: string; source: string } | null; bankLinked: { name: string; source: string; confidence?: number } | null; conflict: boolean }
export interface PanBlock { primary: Field | null; alternates: { value: string; source: string; foundBy?: string[] }[]; conflict: boolean; note?: string }
export interface MobileRow { value: string; foundBy: string[]; agreementCount: number; primary: boolean }
export interface UdyamBlock { present: boolean; regNo: Field; enterpriseName: Field; enterpriseType: Field; organizationType: Field; majorActivity: Field; nicIndustries: string[]; incorporation: Field; officialAddress: Field }
// PII / contact group (INTERNAL card — all deterministic, owner: show everything, full/unmasked).
export interface ContactPii { email: Field; altEmail: Field; fullAddress: Field; city: Field; district: Field; state: Field; pincode: Field; dob: Field; gender: Field; age: Field; incomeBand: Field }
export interface EpfoBlock { present: boolean; establishment: Field; employeeCount: Field }
export interface AadhaarBlock { present: boolean; value: Field; name: Field }
export interface MonthBar { month: string; count: number }
// #11 — a web citation behind an inferred field (source URL + quoted excerpt + engine confidence), from web_osint basis[]/proofs[].
export interface ProofRow { field: string; url: string; excerpt: string; confidence: string }
// #4 — the most-recent requirement's BuyLead-page fields, surfaced on the 1-pager (consistent with the BuyLead-details view).
export interface ReqDetail { title: string; orderValue: Field; requirementType: Field; category: Field; posted: string; specs: { k: string; v: string }[]; isExpired: boolean; status: string; expiry: string; recencyDays: number | null }
export interface BuyerProfileModel {
  glid: string;
  available: boolean;                       // false → no rich payload pulled yet
  header: { company: Field; contactName: Field; memberSince: Field; registeredLocation: Field; tenureYears: number | null; tiles: StatTile[] };
  // Amit (demo): the plain-language "what does this buyer do / kis cheez ka dhandha hai" — the ONE line a CXO reads first.
  headline: string | null;
  // IndiaMART verified-business-buyer flag → TS status. 6-9 = TrustSEAL Buyer; 4/5 = Verified Business Buyer;
  // else if mobile+email present & verified = Verified Buyer; else partial/unverified.
  verifiedBuyer: { flag: number; tier: 'trustseal' | 'gst_verified' | 'verified' | 'partial' | 'unverified' | 'fraud'; label: string } | null;
  businessStory: { text: string; inferredParts: string[] } | null;   // templated, NOT literal
  buyerDetails: LabeledField[];             // "Who is the buyer?" — maturity · intent · deal-readiness · objective · stage (inferred)
  overview: LabeledField[];                 // "What business?" — type · model · industry · retail/wholesale · scale · turnover · procurement
  procurement: LabeledField[];              // "How does he buy?" — model · frequency · sourcing · price/quality · payment · timeline · challenge
  market: LabeledField[];                   // "Whom does he sell to?" — customers · channel · geography
  company: {
    gst: Field; gstStatus: Field; tradeName: Field; constitution: Field; regDate: Field; turnoverBand: Field; principalAddress: Field;
    identity: IdentitySignals | null; pans: PanBlock | null; mobiles: MobileRow[]; udyam: UdyamBlock;
  };
  requirementActivity: { total: number | null; months: MonthBar[]; series: string[]; note: string };
  social: { website: Field; facebook: Field; instagram: Field; linkedin: Field; twitter: Field };
  socialPlatforms: string[];                // Sign3 phone-linked platforms (FLIPKART/FACEBOOK/…) — for the segmented digital-footprint chips
  products: string[];
  productsOffered: string[];
  latestRequirement: ReqDetail | null;      // #4 — BuyLead order value / type / specs of the most-recent requirement
  hasActiveRequirement: boolean;            // N1 — any live (non-expired) BuyLead? false ⇒ latest requirement is expired / buyer is browse-only
  proofs: ProofRow[];                       // #11 — web citations (URL + excerpt + confidence) behind inferred fields
  googleBusiness: { exists: boolean; rating: string | null; kind: 'gmb' | 'maps_contributor' } | null;
  plan: null;                               // omitted — no source field (see comment in parseBuyerProfile)
  // ── owner: INTERNAL dashboard card shows EVERY deterministic value (full PII). All below are deterministic passthroughs. ──
  contact: ContactPii;                      // email · address · dob · gender · age · income (Befisc/profile)
  gstDetail: GstAdvance | null;             // full GST-advance registry detail (taxpayer · SAC · signatories · filing · jurisdiction · compliance · GST email/mobile)
  businessNature: Field;                    // GST nature_of_business_activity (deterministic — distinct from the inferred role)
  socialPresenceCount: number | null;       // Sign3 phone-linked account count
  epfo: EpfoBlock | null;                   // IDfy EPFO employer (size signal · employee count)
  aadhaar: AadhaarBlock | null;             // aadhaar-fact (internal, full per owner)
  catalogueLink: Field;                     // IndiaMART storefront (paidurl) when also a listed seller
  health: Record<string, { ok: boolean; status: string }>;
}

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// BuyLead dates arrive "18-JUN-26" (DD-MON-YY) → "JUN'26" bucket. Fall back to recencyDays. Returns bucket|null.
function monthBucket(r: Requirement): string | null {
  const m = /^(\d{1,2})[-/\s]([A-Za-z]{3})[-/\s](\d{2,4})$/.exec(str(r.posted));
  if (m) return `${m[2].toUpperCase()}'${m[3].slice(-2)}`;
  if (r.recencyDays != null && !isNaN(r.recencyDays)) { const d = new Date(Date.now() - r.recencyDays * 86400000); return `${MON[d.getUTCMonth()]}'${String(d.getUTCFullYear()).slice(-2)}`; }
  return null;
}

export function parseBuyerProfile(rich: unknown): BuyerProfileModel {
  const sources = obj(obj(rich).sources);
  const available = Object.keys(sources).length > 0;
  const idn = nodeOk(rich, 'identity') ? identityFromMerged(rich) : null;
  const usSince = summaryOf(rich, 'usersince');
  const ext = nodeOk(rich, 'external') ? externalFromMerged(rich) : null;
  const wa = nodeOk(rich, 'whatsapp') ? waFromMerged(rich) : null;
  const reqs = nodeOk(rich, 'requirement') ? requirementsFromMerged(rich) : [];
  const web = summaryOf(rich, 'web_osint');            // {} when web node failed/absent
  const crSum = obj(summaryOf(rich, 'company_reg'));   // v38 IndiaMART VERIFIED GST/KYB (constitution·nature·turnover-band·reg-year·partners) — deterministic, no LLM
  const bpSum = obj(summaryOf(rich, 'buyerprofile'));  // v38 IndiaMART buyer record (business_type·social·geo·activity·verification·member-since)
  // v20 audit fix (P0 — namesake pollution): the card renders web fields off the RAW pull, bypassing the extract-LLM's
  // verify-gate. A NAME-ONLY Parallel query (no company_name/gst sent) reliably returns a namesake (a switchgear
  // "Jaiveer" for a notebook buyer). So surface web website/socials/address ONLY when the search was anchored to a real
  // firm (company_name or gst_number was actually sent); otherwise treat web as unverified and suppress it on the card.
  const webQuery = obj(obj(sources.web_osint).query);
  // v20: the fast-mode web engine is Gemini 2.5 Flash + Google Search grounding, which SELF-REPORTS a match_confidence
  // (the Jaiveer namesake test returned match_confidence:'none' + refused to fabricate). Carry that honesty into the
  // gate end-to-end: a web fact is trusted only when the search was anchored to a real firm AND the engine did not
  // itself flag "no confirmed match" (Parallel-only pulls carry no match_confidence → fall back to the anchor test).
  const webMc = str(obj(sources.web_osint).match_confidence).toLowerCase();
  // v38 (audit gap-4): match_confidence comes ONLY from Gemini; a successful anchored Parallel.ai run (normal mode) must
  // NOT be suppressed by Gemini's independent 'none'. Verified when anchored AND (Gemini!=none OR Parallel returned a hit).
  const webParH = obj(obj(obj(sources.web_osint).__health).parallel);
  const webParallelHit = str(webParH.status) === 'success' && (Number(webParH.proofs_count ?? webParH.basis_count ?? 0) > 0 || Number(webParH.fields_returned ?? 0) > 0);
  const webVerified = (!!str(webQuery.company_name) || !!str(webQuery.gst_number) || !!str(webQuery.pan)) && (webMc !== 'none' || webParallelHit); // v40: verified PAN alone anchors the search (typed firm name can be junk)
  const certs = arr(summaryOf(rich, 'gst_cert_idfy').certificates).map(obj);
  const cert0 = certs[0] || {};
  const gdDetails = arr(summaryOf(rich, 'gst_detail_union').gst_details).map(obj);

  // ── tenure ──────────────────────────────────────────────────────────────────────────────────────────────
  // tenure_years lives on the GLUSR `usersince` source (NOT identity.summary as the sample prompt assumed) — read it,
  // else derive from member_since ISO date. (Honest note: neither is in identity.summary; verified against buyerDetails.ts.)
  const tenureRaw = str(usSince.tenure_years) || str(obj(summaryOf(rich, 'identity')).tenure_years);
  let tenureYears: number | null = tenureRaw && !isNaN(Number(tenureRaw)) ? Number(tenureRaw) : null;
  const memberSince = idn?.memberSince || str(usSince.member_since) || str(bpSum.member_since) || '';
  if (tenureYears == null && memberSince) { const t = Date.parse(memberSince); if (!isNaN(t)) tenureYears = Math.floor((Date.now() - t) / (365.25 * 86400000)); }

  // ── header stat tiles — the sample JSON has NO "sellers connected" count; map to REAL aggregates, labeled honestly
  // (owner §2). buyer_turns / campaigns_received (cited) are ABSENT from the frontend shape → computed from the WA
  // timeline instead of trusting a key that isn't there. ────────────────────────────────────────────────────────
  const buyerMsgs = wa ? wa.inbound.buyerMsgs : null;
  // HOD P-1 / UI-6 (2026-07-13): the top strip carries ONLY the three counts the internal APIs already give —
  // Requirements · Calls · Messages. "Campaigns Received" REMOVED (it's an outbound-to-buyer count, not buyer activity).
  const _cs = obj(obj(sources.calls).summary); const _ps = obj(obj(sources.pns_calls).summary);   // total connected calls across both call sources
  const _cn = (Number(_cs.call_count) || (Array.isArray(_cs.calls) ? _cs.calls.length : 0)) + (Number(_ps.call_count) || (Array.isArray(_ps.calls) ? _ps.calls.length : 0));
  // audit 2026-07-14: on tiers without transcripts the calls/pns_calls arrays are empty → fall back to the buyerprofile
  // aggregate PNS-call counters (pns_call_cnt + call_back_cnt) so the "Total Calls" tile still populates. (bp.total_calls
  // is the ENQUIRIES count per the owner mapping — NOT used here.)
  const _bpAct0 = obj(bpSum.activity);
  const _bpCn = (Number(_bpAct0.pns_call_cnt) || 0) + (Number(_bpAct0.call_back_cnt) || 0);
  // DISCREPANCY FIX (2026-08-18): when call RECORDS exist but extraction FAILED (call_count 0 with failed_count>0 —
  // e.g. the Go-schema audio outage), do NOT silently substitute the buyerprofile lifetime aggregate (pns_call_cnt +
  // call_back_cnt). Swapping metrics made the tile read 10 (connected calls, transcripts working) on one pull and 27
  // (lifetime masked-calls + callbacks) on the next for the SAME buyer — users see it as wrong data. Withhold (null)
  // + an honest note instead. The owner's tier fallback (no call nodes at all → bp aggregate) still applies — a
  // transcript-less tier has failed_count 0 by construction, so it keeps populating the tile as designed.
  const _extractFailed = (Number(_cs.failed_count) || 0) + (Number(_ps.failed_count) || 0);
  const callCount = _cn > 0 ? _cn : (_extractFailed > 0 ? null : (_bpCn > 0 ? _bpCn : null));
  // OVERALL ACTIVITY tiles (owner 2026-07-14, mockup parity): Sellers Connected · Enquiries Posted · BuyLeads Posted.
  // "Sellers Connected" has NO field in the pull → owner substitutes Total Calls. Enquiries Posted ← activity.enq_count,
  // BuyLeads Posted ← activity.total_requirement (fallback: this-pull requirement count).
  const _act = obj(bpSum.activity);
  // owner 2026-07-14 (VERBATIM mapping): the bp field `total_calls` IS the enquiries-posted count (misnamed in the raw);
  // `total_requirement` is the buyleads count. "Sellers Connected" has no field → substituted with real connected calls.
  const enqCount = Number(_act.total_calls) > 0 ? Number(_act.total_calls) : null;
  void buyerMsgs;   // retained (WhatsApp buyer-message count) — no longer a top tile; referenced to keep the binding
  const blCount = Number(_act.total_requirement) > 0 ? Number(_act.total_requirement) : (reqs.length || null);
  const tiles: StatTile[] = [
    { label: 'Total Calls', value: callCount, sourceNote: callCount == null && _extractFailed > 0
        ? 'call extraction failed this pull (recordings found, 0 transcribed) — count withheld rather than swapped for the lifetime PNS aggregate'
        : 'calls/pns_calls summary · total connected calls (shown in place of Sellers Connected, which the pull does not provide)' },
    { label: 'Enquiries Posted', value: enqCount, sourceNote: 'buyerprofile.activity.total_calls (this field holds the enquiries-posted count)' },
    { label: 'BuyLeads Posted', value: blCount, sourceNote: 'buyerprofile.activity.total_requirement (fallback: this-pull requirement count)' },
  ];

  // ── business overview ───────────────────────────────────────────────────────────────────────────────────────
  // v20 audit fix (P0): business_type / turnover / industry are WEB-derived (Parallel) — gate them on webVerified too,
  // exactly like sf()/google_business. Otherwise a name-only namesake (e.g. "Jaiveer Controls & Switchgears" → trader)
  // renders as the buyer's Business Type whenever there's no verified GST role to override it.
  const businessType = webVerified ? webVal(web.business_type) : null;
  const turnover = webVerified ? webVal(web.turnover_estimate) : null;
  const industry = webVerified ? webVal(web.industry) : null;
  const stageDesc = tenureYears == null ? null : tenureYears < 1 ? 'Recently Established' : tenureYears < 4 ? 'Growing' : 'Established';
  const webConf = bandConfidence(web.confidence) ?? 60;
  // ROLE from VERIFIED GST nature_of_business — registry-grade, needs NO web. Fixes "Business Type = Not available when
  // web fails but the GST clearly says Manufacturer/Wholesaler/Retailer" (GLID 22642257: Factory+Retail+Wholesale).
  const gstNatureBase: string[] = (Array.isArray(cert0.nature_of_business_activity) ? cert0.nature_of_business_activity as string[]
    : (gdDetails.length && Array.isArray(obj(obj(gdDetails[0].fields).nature_of_business_activity).canonical) ? obj(obj(gdDetails[0].fields).nature_of_business_activity).canonical as string[] : []));
  // v38 — IndiaMART's OWN verified GST nature (company_reg: primary + secondary activities) is registry-grade too; union it
  // in so Business Type / role resolve deterministically even when IDfy/consensus is empty (e.g. 22642257: Manufacturer + Factory/Retail/Wholesale/Office).
  const crNature = [str(crSum.nature_of_business), ...arr(crSum.nature_secondary).map(str)].filter(Boolean);
  const gstNature: string[] = [...new Set([...gstNatureBase, ...crNature])];
  const roleMap: Array<[RegExp, string]> = [[/manufactur|factory/i, 'Manufacturer'], [/wholesale/i, 'Wholesaler'], [/retail/i, 'Retailer'], [/import|export/i, 'Importer/Exporter'], [/service/i, 'Service Provider'], [/\btrad/i, 'Trader']];
  const gstRole = [...new Set(gstNature.flatMap((n) => roleMap.filter(([re]) => re.test(n)).map(([, r]) => r)))].join(' · ');
  const gstTurnover = gstAdvance(rich)?.turnover || str(crSum.annual_turnover_band) || null;   // GST-advance record, else IndiaMART verified GST turnover band (company_reg)
  // industry: web (inferred) → else the buyer's own top requirement category / enquired product (registry-ish)
  const reqIndustry = str(reqs[0]?.category) || (wa?.meta?.productsEnquired || [])[0] || '';
  const businessTypeField: Field = gstRole
    ? field(gstRole, 'registry', 'GST nature of business (verified · Sign3⊕IDfy)')
    : businessType ? field(businessType, 'inferred', 'web_osint (LLM)', { confidence: webConf }) : absentField('GST / web_osint');
  // ── Buyer Details "who is the buyer?" (inferred) — maturity · intent · deal-readiness · objective · stage.
  // Business Stage keeps its deterministic tenure-derived default; the overlay supersedes it with the LLM value. ──
  const buyerDetails: LabeledField[] = [
    { label: 'Buyer Maturity', field: absentField('buyer-profile extract (LLM)') },
    { label: 'Buyer Intent', field: absentField('buyer-profile extract (LLM)') },
    { label: 'Deal Readiness', field: absentField('call lead-tag · Cold/Warm/Hot (LLM)') },
    { label: 'Business Objective', field: absentField('buyer-profile extract (LLM)') },
    { label: 'Business Stage', field: stageDesc ? { value: stageDesc, present: true, provenance: 'derived', source: `derived from tenure (${tenureYears}y)`, note: 'rule: <1y Recently Established · <4y Growing · else Established' } : absentField('tenure') },
  ];
  // ── Business Overview "what business?" — type · model(b2b/b2c) · industry · retail/wholesale · scale · turnover · procurement.
  // Deterministic defaults for Business Type / Industry / Turnover; the LLM overlay supersedes any it grounds. ──
  const overview: LabeledField[] = [
    { label: 'Business Type', field: businessTypeField },
    { label: 'Business Model', field: absentField('buyer-profile extract (LLM · B2B/B2C)') },
    { label: 'Industry / Sub-Industry', field: (industry && webVerified) ? field(industry, 'inferred', 'web_osint (LLM)', { confidence: webConf }) : (reqIndustry ? field(reqIndustry, 'single', 'buyer requirement category') : absentField('buyer-profile extract (LLM)')) },
    { label: 'Retail / Wholesale', field: absentField('buyer-profile extract (LLM)') },
    { label: 'Business Scale', field: absentField('buyer-profile extract (LLM)') },
    { label: 'Annual Turnover', field: turnover ? field(turnover, 'inferred', 'web_osint (LLM · from listing snippet, not a filed financial)', { confidence: webConf }) : gstTurnover ? field(gstTurnover, 'registry', 'GST-advance (filed)') : absentField('web_osint / GST-advance') },
    { label: 'Annual Procurements', field: absentField('observed order qty/rate/cadence (LLM)') },
  ];
  // ── Procurement Profile "how does he buy?" + Market Focus "whom does he sell to?" — inferred slots the overlay fills.
  // Empty (unevidenced) rows are HIDDEN on the card (owner: hide-empty); the overlay wires each by index below. ──
  const procurement: LabeledField[] = ['Procurement Model', 'Purchase Frequency', 'Sourcing Channel', 'Preferred Suppliers', 'Preferred Sourcing Cities', 'Procurement Approach', 'Price vs Quality', 'Payment Preference', 'Delivery Timeline', 'Procurement Challenge'].map((label) => ({ label, field: absentField('buyer-profile extract (LLM)') }));
  const market: LabeledField[] = ['Target Customers', 'Selling Channel', 'Sales Geography'].map((label) => ({ label, field: absentField('buyer-profile extract (LLM)') }));

  // ── B server-LLM overlay — when the response carries `llm_profile` (from the bi-buyer-profile endpoint's LLM tail),
  // its inferred narrative fields REPLACE the deterministic "Not available"/web fallbacks (this is what fills the
  // Procurement Profile / Market Focus / stage / type / turnover / story that no raw source can). Absent → deterministic
  // values above stand. Each is tagged inferred (server LLM) with its confidence + reason. ─────────────────────────────
  // bi-buyer-unified: prefer the unified buyer.* superset (by key-match); fall back to workflow-B llm_profile so a
  // pre-cutover response still renders; absent both → the deterministic absentField floor below stands.
  const buyerBlk = obj(obj(rich).buyer);
  const llm = Object.keys(buyerBlk).length ? buyerBlk : obj(obj(rich).llm_profile);
  const llmSrc = Object.keys(buyerBlk).length ? 'buyer-profile extract (LLM)' : 'server LLM (bi-buyer-profile-card)';  // neutral — dashboard feeds this from the frontend extract; standalone from bi-buyer-unified
  const lf = (k: string): Field | null => { const o = obj(llm[k]); const v = str(o.value); if (!v || /^(null|n\/?a|none|unknown|not available)$/i.test(v)) return null; return { value: v, present: true, provenance: 'inferred', source: llmSrc, inferred: true, confidence: Number(o.confidence) || undefined, note: str(o.reason) || undefined }; };
  if (Object.keys(llm).length) {
    const setL = (a: LabeledField[], i: number, k: string) => { const f = lf(k); if (f) a[i] = { label: a[i].label, field: f }; };
    setL(buyerDetails, 0, 'buyer_maturity'); setL(buyerDetails, 1, 'buyer_intent'); setL(buyerDetails, 2, 'deal_readiness'); setL(buyerDetails, 3, 'business_objective'); setL(buyerDetails, 4, 'business_stage');
    setL(overview, 0, 'business_type'); setL(overview, 1, 'b2b_b2c'); setL(overview, 2, 'sub_industry'); setL(overview, 3, 'retail_wholesale'); setL(overview, 4, 'scale'); setL(overview, 5, 'annual_turnover'); setL(overview, 6, 'annual_procurements');
    setL(procurement, 0, 'procurement_model'); setL(procurement, 1, 'purchase_frequency'); setL(procurement, 2, 'sourcing_channel'); setL(procurement, 3, 'preferred_suppliers'); setL(procurement, 4, 'location_sourcing_preference'); setL(procurement, 5, 'procurement_approach'); setL(procurement, 6, 'price_vs_quality'); setL(procurement, 7, 'payment_mode'); setL(procurement, 8, 'delivery_timeline'); setL(procurement, 9, 'procurement_challenge');
    setL(market, 0, 'target_customers'); setL(market, 1, 'selling_channel'); setL(market, 2, 'sales_geography');
  }
  // Deterministic Selling-Channel fallback (audit ⑤): a GLID that is ALSO a listed IndiaMART seller has a real selling
  // channel even without the server-LLM overlay — surface its own storefront rather than leaving the slot blank.
  {
    const idS = obj(summaryOf(rich, 'identity')); const cslS = obj(summaryOf(rich, 'csl'));
    const paidurl = str(idS.paidurl); void cslS;
    // audit P2 (consistency): align with the BuyLead card's LINK-GATE — surface Selling Channel ONLY when there is a
    // real storefront URL (paidurl). A bare "also_a_seller" flag with no link is no longer shown as a selling channel.
    if (!market[1].field.present && paidurl) {
      const store = paidurl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
      market[1] = { label: 'Selling Channel', field: { value: `Sells on IndiaMART · ${store}`, present: true, provenance: 'derived', source: 'IndiaMART listing (paidurl)', note: 'this GLID is also a listed IndiaMART seller (storefront link on file)' } };
    }
  }

  // ── business story — TEMPLATED (composed client-side from fields we already have; NOT an LLM call, NOT literal API
  // data). industry is the only inferred part. ───────────────────────────────────────────────────────────────────
  const company = idn?.company || str(cert0.trade_name) || str(cert0.legal_name) || '';
  const topProducts = (wa?.meta?.productsEnquired || []).slice(0, 2);
  let businessStory: BuyerProfileModel['businessStory'] = null;
  if (company) {
    const stagePart = stageDesc ? `${stageDesc.toLowerCase()} ` : '';
    // prefer the verified GST role over the web industry; fall back to the buyer's own requirement category
    const rolePart = gstRole ? `${gstRole.toLowerCase()} ` : (industry ? `${industry} ` : (reqIndustry ? `${reqIndustry} ` : ''));
    const prodPart = topProducts.length ? ` dealing in ${topProducts.join(' and ')}` : '';
    const afterArticle = `${stagePart}${rolePart}`.trim() || 'business';   // N3 — article must agree with the next word's sound ("an established", not "a established")
    const article = /^[aeiou]/i.test(afterArticle) ? 'an' : 'a';
    businessStory = { text: `${company} is ${article} ${stagePart}${rolePart}business${prodPart}.`.replace(/\s+/g, ' ').trim(), inferredParts: gstRole ? [] : (industry ? ['industry (web)'] : []) };
  }
  // server-LLM story (if B provided one) supersedes the templated one — it's a fuller narrative from the evidence
  const llmStory = str(obj(llm.business_story).value);
  if (llmStory && !/^(null|n\/?a|none)$/i.test(llmStory)) businessStory = { text: llmStory, inferredParts: ['server LLM'] };

  // ── company details ─────────────────────────────────────────────────────────────────────────────────────────
  const gstAddr = gdDetails.length ? str(obj(obj(gdDetails[0].fields).address).canonical) : '';
  const principalAddress = triangulateAddress(gstAddr || null, webVerified ? webVal(web.official_address) : null);

  // Identity Signals (Conflict A) — registered business contact vs phone-linked bank identity. NEVER auto-resolved.
  const registeredName = idn?.name || '';
  const bankName = ext?.verifiedName || '';
  const identity: IdentitySignals | null = (registeredName || bankName) ? {
    registered: registeredName ? { name: registeredName, source: 'IndiaMART profile / GST' } : null,
    bankLinked: bankName ? { name: bankName, source: ext?.verifiedNameSource || 'External (sign3/befisc)', confidence: ext?.verifiedNameConfidence } : null,
    conflict: !!registeredName && !!bankName && normVal(registeredName) !== normVal(bankName) && !normVal(registeredName).includes(normVal(bankName)) && !normVal(bankName).includes(normVal(registeredName)),
  } : null;

  // PAN block (Conflict B) — source-priority + agreement. pan_union.rows carry found_by[]; external carries pans[].
  const panRows = arr(summaryOf(rich, 'pan_union').rows).map(obj);
  const panInputs: ReconcileInput[] = [
    ...panRows.map((r) => { const fb = arr(r.found_by).map(str).filter(Boolean); return { value: str(r.pan), source: fb.join('+') || 'pan_union', tier: (fb.length >= 2 ? 'agreement' : 'thirdparty') as SourceTier, foundBy: fb }; }),
    ...(ext?.pans || []).map((p) => ({ value: p, source: 'external', tier: 'thirdparty' as SourceTier })),
  ].filter((x) => x.value);
  const panRec = reconcileField(panInputs);
  const pans: PanBlock | null = panRec ? {
    primary: { value: panRec.primaryValue, present: true, provenance: panRec.primaryTier === 'agreement' ? 'triangulated' : 'single', source: panRec.primarySource, agreementCount: panRec.agreementCount, foundBy: panRows.find((r) => normVal(str(r.pan)) === normVal(panRec.primaryValue)) ? arr(panRows.find((r) => normVal(str(r.pan)) === normVal(panRec.primaryValue))!.found_by).map(str) : undefined },
    alternates: panRec.alternates,
    conflict: panRec.conflicting,
    note: panRec.conflicting ? 'Multiple PANs on the same buyer — primary = highest vendor-agreement; alternate observed (may link to a different named identity, see Identity Signals).' : undefined,
  } : null;

  // linked mobiles with per-number vendor agreement (owner §0: 2-vendor number reads more certain than 1-vendor)
  const mobiles: MobileRow[] = arr(summaryOf(rich, 'mobiles').rows).map(obj).map((r) => { const fb = arr(r.found_by).map(str).filter(Boolean); return { value: str(r.mobile), foundBy: fb, agreementCount: fb.length, primary: r.is_primary === true }; }).filter((m) => m.value);

  // Udyam / MSME (Sign3) — the authoritative govt SIZE band + NIC industry. summaryOf applies the __health gate
  // (no_data → {} → all-absent muted rows). Was fully dropped before the card saw it; now a first-class block.
  const udy0 = obj(arr(summaryOf(rich, 'udyam').registrations).map(obj)[0]);
  const udyProfile = obj(udy0.profile);   // legacy udyam_verification shape (nested); v30 pan_to_udyam emits fields FLAT on udy0
  const uP = (k: string): string => str(udy0[k]) || str(udyProfile[k]);
  const udyNic = arr(udy0.industry).map(obj).map((x) => `${str(x.nic_code || x.industry_code)} ${str(x.industry || x.activity)}`.trim()).filter(Boolean);
  const udyam: UdyamBlock = {
    present: !!str(udy0.udyam_reg_no),
    regNo: field(str(udy0.udyam_reg_no), 'registry', 'Udyam MSME registry (Sign3)'),
    enterpriseName: field(uP('enterprise_name'), 'registry', 'Udyam MSME registry'),
    enterpriseType: field(uP('enterprise_type'), 'registry', 'Udyam MSME registry — authoritative SIZE band'),
    organizationType: field(uP('organization_type'), 'registry', 'Udyam MSME registry'),
    majorActivity: field(uP('major_activity'), 'registry', 'Udyam MSME registry'),
    nicIndustries: udyNic,
    incorporation: field(uP('date_of_incorporation'), 'registry', 'Udyam MSME registry'),
    officialAddress: field(str(udy0.official_address) || uP('official_address'), 'registry', 'Udyam MSME registry'),
  };

  // v29 (demo · "we are not filling fields"): the Company Details block read ONLY cert0 = gst_cert_idfy, which is often
  // ABSENT — yet the 3-vendor consensus (gst_detail_union) + GSTIN union carry the GSTIN, legal/trade name, constitution,
  // registration date and status. Fall back to those so a GST-verified buyer's registry fields actually render.
  const gd0 = obj(gdDetails[0]);
  const gd0f = obj(gd0.fields);
  const gdVal = (k: string): string => { const f = obj(gd0f[k]); const c = f.canonical; if (typeof c === 'string') return c; if (Array.isArray(c)) return c.map(str).filter(Boolean).join(', '); return c != null ? str(c) : ''; };
  // GSTIN: cert → consensus gstin → GSTIN-union primary
  const gstinUnion = obj(summaryOf(rich, 'gstin_union'));
  const gstinVal = str(cert0.gstin) || str(gd0.gstin) || str(gstinUnion.primary) || str(arr(gstinUnion.gstins).map(obj).map((g) => str(g.gstin)).filter(Boolean)[0]);
  const gstSrc = str(cert0.gstin) ? 'IDfy GST certificate' : (str(gd0.gstin) ? 'GST 3-vendor consensus (Sign3⊕IDfy⊕Befisc)' : 'GSTIN union');
  const gstStatusVal = str(cert0.gstin_status) || gdVal('gstin_status');
  // GST verification METHOD label (owner 2026-07-14) — from buyerprofile is_gst_verified CODE: 2 = Tactical, 3 = OTP,
  // 1/4/5 = Matchmaking. (bp-parse collapses is_gst_verified to a boolean today; n8n v48 passes the raw code as
  // buyerprofile.gst_verify_code. Falls back to the literal gstin_status below when the code is absent.)
  const _gstCode = Number((bpSum as Record<string, unknown>).gst_verify_code);
  const gstVerifyLabel = _gstCode === 2 ? 'Verified (Tactical)' : _gstCode === 3 ? 'Verified (OTP)' : (_gstCode === 1 || _gstCode === 4 || _gstCode === 5) ? 'Verified (Matchmaking)' : '';
  const tradeNameVal = str(cert0.trade_name) || str(cert0.legal_name) || gdVal('trade_name') || gdVal('legal_name');
  const constitutionVal = str(cert0.constitution_of_business) || gdVal('constitution_of_business');
  const regDateVal = str(cert0.date_of_registration) || gdVal('date_of_registration');
  const kybSrc = str(cert0.gstin) ? 'IDfy GST certificate' : 'GST 3-vendor consensus (Sign3⊕IDfy⊕Befisc)';
  // v38 — IndiaMART's OWN verified GST record (company_reg) is a registry-grade fallback for every KYB field, and the
  // AUTHORITATIVE source for constitution + turnover-band (IDfy/consensus rarely carry those). Prefer the discovered
  // vendor value; else fill from company_reg so Company Details isn't blank when only the platform GST record exists.
  const crGst = str(crSum.gst), crConstitution = str(crSum.constitution), crRegYear = str(crSum.gst_reg_year), crGstStatus = str(crSum.gst_verified);
  const cmp = {
    gst: gstinVal ? field(gstinVal, 'registry', gstSrc) : (crGst ? field(crGst, 'registry', 'IndiaMART verified GST record (company_reg)') : absentField('no GSTIN discovered across IDfy / consensus / union / IndiaMART')),
    gstStatus: gstVerifyLabel ? { value: gstVerifyLabel, present: true, provenance: 'registry' as Provenance, source: 'IndiaMART buyerprofile · is_gst_verified method code', note: 'GST-verify method: 2=Tactical · 3=OTP · 1/4/5=Matchmaking' } : (gstStatusVal ? { value: gstStatusVal, present: true, provenance: 'registry' as Provenance, source: kybSrc, note: 'literal gstin_status (not a hardcoded label)' } : (crGstStatus ? field(crGstStatus, 'registry', 'IndiaMART verified GST record') : absentField('GST cert / consensus'))),
    tradeName: tradeNameVal ? field(tradeNameVal, 'registry', kybSrc) : absentField('GST cert / consensus'),
    constitution: constitutionVal ? field(constitutionVal, 'registry', kybSrc) : (crConstitution ? field(crConstitution, 'registry', 'IndiaMART verified GST record (legal status)') : absentField('GST cert / consensus / IndiaMART')),
    regDate: regDateVal ? field(regDateVal, 'registry', kybSrc) : (crRegYear ? field(crRegYear, 'registry', 'IndiaMART verified GST record (registration year)') : absentField('GST cert / consensus')),
    turnoverBand: gstTurnover ? field(gstTurnover, 'registry', gstAdvance(rich)?.turnover ? 'GST-advance registry' : 'IndiaMART verified GST record (declared turnover band)') : absentField('GST turnover band'),
    principalAddress,
    identity,
    pans,
    mobiles,
    udyam,
  };

  // ── requirement activity chart — group by month from `posted`; sparse months stay at 0 (never faked/stretched).
  // The reference's 3-way BuyLead/Call/Enquiry split is NOT in this shape → single "BuyLeads" series (honest). ─────
  const bucketCounts = new Map<string, number>();
  const order: string[] = [];
  for (const r of reqs) { const b = monthBucket(r); if (!b) continue; if (!bucketCounts.has(b)) order.push(b); bucketCounts.set(b, (bucketCounts.get(b) || 0) + 1); }
  // audit P2: order the month axis CHRONOLOGICALLY (was requirement-sort order → jumbled) and enforce the stated
  // "(Last 6 Months)" window — keep only the 6 most-recent month buckets.
  const _bucketKey = (b: string): number => { const m = /^([A-Z]{3})'(\d{2})$/.exec(b); return m ? (2000 + Number(m[2])) * 12 + Math.max(0, MON.indexOf(m[1])) : 0; };
  const months: MonthBar[] = order.map((m) => ({ month: m, count: bucketCounts.get(m) || 0 })).sort((a, b) => _bucketKey(a.month) - _bucketKey(b.month)).slice(-6);
  // audit P2: when the requirement source RAN (present), 0 BuyLeads is an honest ZERO, not unknown '—'. Only null when
  // the source itself is absent/errored.
  const _reqPresent = !!(sources as Record<string, unknown>).requirement;
  const requirementActivity = {
    total: _reqPresent ? reqs.length : (reqs.length || null),
    months,
    series: ['BuyLeads'],
    note: months.length ? 'Grouped by BuyLead posted-month. Single series — the reference BuyLead/Call/Enquiry 3-way split is not present in this data shape.' : 'No dated requirements to chart.',
  };

  // ── social — every value guarded by isAbsent (web strings like "no account found" → dash, never link-ified) ─────
  // Sign3 phone-linked social presence (["FACEBOOK","INSTAGRAM",…]) — a real per-buyer signal (not a web namesake), so it
  // fills a slot as presence-only when web_osint has nothing. No handle/URL is fabricated.
  const sign3Socials = new Set(arr(summaryOf(rich, 'external').social_platforms).map((p) => str(p).toUpperCase()));
  // v38 — IndiaMART buyerprofile social_profiles (already cleaned/deduped upstream: markdown-wrapped + /test placeholders stripped).
  // Add their domains to the presence set AND keep the real profile URL, so the footprint shows an actual link (not just "Present").
  const bpSocialUrl = new Map<string, string>();
  for (const s of arr(bpSum.social_profiles)) { const d = str(obj(s).domain).toUpperCase(); const u = str(obj(s).url); if (d) { sign3Socials.add(d); if (u && !bpSocialUrl.has(d)) bpSocialUrl.set(d, u); } }
  const sf = (v: unknown, label: string): Field => {
    const s = webVerified ? webVal(v) : '';
    if (s) return { value: s, present: true, provenance: 'inferred', source: `web_osint (LLM) · ${label}`, inferred: true, confidence: webConf };
    const bpu = bpSocialUrl.get(label.toUpperCase());   // real profile URL from the IndiaMART buyer record
    if (bpu) return { value: bpu, present: true, provenance: 'registry', source: 'IndiaMART buyer profile · social_profiles (verified link)' };
    // owner 2026-07-14: a Sign3 presence-only flag with NO captured URL is slop — show a dash, never "Present".
    // Only a REAL profile URL (web_osint / buyerprofile social_profiles) surfaces; otherwise the row is absent → "-".
    return absentField(webVerified ? 'web_osint / Sign3 (no profile URL captured)' : 'no web/social profile URL on file');
  };
  const gb = obj(web.google_business);
  // Prefer web_osint google_business (only when the web search was anchored); else fall back to the Sign3 Google-Maps
  // contributor profile on external (#12) — that's a real per-buyer signal, not a web namesake, so it's not gated.
  let googleBusiness: BuyerProfileModel['googleBusiness'] = null;
  if (webVerified && 'google_business' in web && Object.keys(gb).length) {
    googleBusiness = { exists: gb.exists === true, rating: gb.exists === true ? (webVal(gb.rating) || null) : null, kind: 'gmb' };
  } else {
    const extGmb = obj(summaryOf(rich, 'external').google_business);
    if (Object.keys(extGmb).length) {
      const r = str(extGmb.ratings); const rev = str(extGmb.reviews);
      const rating = r ? `${r} ratings${rev ? ` · ${rev} reviews` : ''} (Google Maps)` : (rev ? `${rev} reviews (Google Maps)` : null);
      // N7 — this is a personal Google-Maps CONTRIBUTOR profile (Sign3 phone-linked), NOT the firm's verified GMB; its pin
      // can sit in a different city than the registered address, so it must NEVER be read as the operating location.
      if (rating) googleBusiness = { exists: true, rating, kind: 'maps_contributor' };
    }
  }

  // #3 — Products of Interest: aggregate requirement titles (BuyLead) + WhatsApp products_enquired, deduped
  // (case-insensitive, first-occurrence order) → consistent with the BuyLead-details page (was WhatsApp-only → blank).
  const dedupeStr = (xs: string[]): string[] => { const seen = new Set<string>(); const out: string[] = []; for (const x of xs) { const v = x.trim(); const k = v.toLowerCase(); if (!v || seen.has(k)) continue; seen.add(k); out.push(v); } return out; };
  // N6 — collapse near-duplicate product-line variants ("Electronic Piezo Buzzer 12 V" ⊂ "Plastic Electronic Piezo Buzzer"):
  // reduce each name to its SIGNIFICANT tokens (drop pure numbers, 1-char tokens, generic units/fillers — NO category
  // hardcoding) and drop any name whose token-set is a STRICT subset of a longer kept name (keep the richer descriptor).
  const FILLER = new Set(['the', 'for', 'and', 'of', 'with', 'in', 'type', 'size', 'set', 'pcs', 'pc', 'piece', 'pieces', 'mm', 'cm', 'volt', 'volts', 'watt', 'watts', 'kg', 'gm', 'nos', 'unit', 'units']);
  const sigTokens = (name: string): Set<string> => new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && t.length > 1 && !/^\d+$/.test(t) && !FILLER.has(t)));
  const dedupeProducts = (xs: string[]): string[] => {
    const list = dedupeStr(xs).map((name) => ({ name, tk: sigTokens(name) }));
    return list.filter((p, i) => p.tk.size === 0 || !list.some((q, j) => j !== i && q.tk.size > p.tk.size && [...p.tk].every((t) => q.tk.has(t)))).map((p) => p.name);
  };
  // Prefer the extract-LLM's RANKED products_of_interest (already relevance-filtered — off-core BuyLead titles like
  // "Tata Chhota Hathi"/"Garbage Tipper Body" are demoted by the LLM but leak through the raw title aggregate). Fall
  // back to the deterministic aggregate CAPPED to 6 so an unranked dump can't over-elongate the card.
  const llmPoi = str(obj(llm.products_of_interest).value);
  const products = llmPoi
    // owner 2026-07-14: split ONLY on the bullet/pipe delimiters — NOT commas. A comma lives INSIDE a product name
    // ("Electronic components (Piezo Buzzers, Audio ICs)", "Speakers (Bluetooth, Loud, Cabinets)"); splitting on it
    // shredded one product into broken fragments. The extract emits a ' · '-joined ranked list, so · is the separator.
    ? dedupeProducts(llmPoi.split(/\s+·\s+/).map(str).filter(Boolean))
    : dedupeProducts([...reqs.map((r) => str(r.title)), ...(wa?.meta?.productsEnquired || []).map(str)].filter(Boolean)).slice(0, 6);

  // #4 — most-recent requirement's BuyLead-page fields (order value / requirement type / category / specs). Prefer the
  // first requirement carrying order-value or specs, else the recency-spine head. orderValue/requirementType are
  // platform-deduced (Probable *) → provenance 'derived'; category is MCAT-resolved (registry); specs are buyer-filled.
  // N1 — prefer a LIVE lead when one exists (non-expired w/ order-value/specs → any non-expired → any w/ value/specs →
  // recency head). reqs is sorted active-first, so a fully-expired buyer surfaces the freshest EXPIRED lead — flagged as such.
  const hasActiveRequirement = reqs.some((r) => r.hasBL && !r.isExpired);
  const rd = reqs.find((r) => !r.isExpired && (str(r.orderValue) || (r.specs && r.specs.length)))
    || reqs.find((r) => !r.isExpired)
    || reqs.find((r) => str(r.orderValue) || (r.specs && r.specs.length)) || reqs[0] || null;
  const latestRequirement: ReqDetail | null = rd ? {
    title: str(rd.title),
    orderValue: str(rd.orderValue) ? { value: str(rd.orderValue), present: true, provenance: 'derived', source: 'BuyLead ISQ · Probable Order Value (platform-deduced)', note: 'platform-deduced, not buyer-stated' } : absentField('BuyLead ISQ'),
    requirementType: str(rd.requirementType) ? { value: str(rd.requirementType), present: true, provenance: 'derived', source: 'BuyLead ISQ · Probable Requirement Type (platform-deduced)', note: 'platform-deduced, not buyer-stated' } : absentField('BuyLead ISQ'),
    category: field(str(rd.category), 'registry', 'BuyLead category (MCAT-resolved)'),
    posted: str(rd.posted),
    specs: (rd.specs || []).map((s) => ({ k: str(s.k), v: str(s.v) })).filter((s) => s.k && s.v).slice(0, 6),
    isExpired: rd.isExpired === true,
    status: str(rd.status),
    expiry: str(rd.expiry),
    recencyDays: rd.recencyDays != null && !isNaN(Number(rd.recencyDays)) ? Number(rd.recencyDays) : null,
  } : null;

  // #11 — proofs behind the inferred (web) fields: web_osint proofs[] (P3-distilled) else basis[] (raw) → {field, url,
  // excerpt, confidence}, excerpt cleaned of the "(last verified: …)" prefix. Rendered as clickable citations on the card.
  const webNode = obj(sources.web_osint);
  const webProofsRaw = arr(webNode.proofs).length ? arr(webNode.proofs) : arr(webNode.basis);
  // v20 audit fix (P0): when the web search was NOT anchored (name-only → possible namesake) every proof is about the
  // namesake, so suppress the whole block; and defensively drop any proof still carrying a "…-undefined-…" slug or a
  // "not found in supplied/provided records" artifact from the scraper (the switchgear-LinkedIn leak).
  const badProof = (s: string) => /\bundefined\b|not\s+found\s+in\s+(the\s+)?(supplied|provided)/i.test(s);
  const proofs: ProofRow[] = (!webVerified ? [] : webProofsRaw.map(obj).map((b) => {
    let url = str(b.url); let ex = str(b.excerpt);
    if (!url && !ex) { const c0 = obj(arr(b.citations)[0]); url = str(c0.url); ex = arr(c0.excerpts).map(str).filter(Boolean)[0] || ''; }
    ex = ex.replace(/^\(last verified:[^)]*\)\s*/i, '').replace(/\s+/g, ' ').trim();
    return { field: str(b.field), url, excerpt: ex, confidence: str(b.confidence) };
  }).filter((p) => p.field && (p.url || p.excerpt) && !badProof(p.url) && !badProof(p.excerpt)));

  // ── Amit (demo): verified-business (TS) flag + the prominent plain-language "what does this buyer do" headline ──────
  const idSum = obj(summaryOf(rich, 'identity'));
  const bpVer = obj(bpSum.verification);   // v38 buyerprofile verification (flag + email/mobile) — bpSum read at top
  const vbbRaw = idSum.verified_business_buyer_flag ?? bpVer.verified_business_buyer_flag; const vbbN = Number(vbbRaw);
  // "Verified Buyer" tier = a reachable, verified email AND mobile (email verified + WhatsApp-active/alt-mobile verified).
  const emailV = bpVer.email === true || bpVer.alt_email === true;
  const mobileV = bpVer.whatsapp_active === true || bpVer.alt_mobile === true;
  const verifiedTier = (emailV && mobileV) ? { tier: 'verified' as const, label: 'Verified Buyer' } : null;
  // v38 SAFETY (audit P1): an IndiaMART is_fraud flag is a HARD NEGATIVE — it overrides every positive tier so a
  // fraud-flagged account can NEVER read as TrustSEAL/Verified. Shown as its own red badge (never silently hidden).
  const isFraud = bpSum.is_fraud === true;
  const verifiedBuyer: BuyerProfileModel['verifiedBuyer'] = isFraud
    ? { flag: isNaN(vbbN) ? 0 : vbbN, tier: 'fraud', label: '⚠ Fraud-flagged account' }
    : (vbbRaw != null && vbbRaw !== '' && !isNaN(vbbN))
    // owner 2026-07-14: flag 5–8 ⟶ TrustSEAL Buyer; flag 4 ⟶ Verified Business Buyer; ANY GSTIN present ⟶ Verified
    // Business Buyer (even without the flag); else verified mobile+email ⟶ Verified Buyer.
    ? (vbbN >= 5 ? { flag: vbbN, tier: 'trustseal', label: 'TrustSEAL Buyer' }
      : vbbN === 4 ? { flag: vbbN, tier: 'gst_verified', label: 'Verified Business Buyer' }
      : gstinVal ? { flag: vbbN, tier: 'gst_verified', label: 'Verified Business Buyer' }
      : verifiedTier ? { flag: vbbN, ...verifiedTier }
      : vbbN > 0 ? { flag: vbbN, tier: 'partial', label: 'Partially-Verified Account' }
      : { flag: vbbN, tier: 'unverified', label: 'Unverified Account' })
    : (gstinVal ? { flag: 0, tier: 'gst_verified', label: 'Verified Business Buyer' } : (verifiedTier ? { flag: 0, ...verifiedTier } : null));
  // "kis cheez ka dhandha hai" — one plain line: designation · role · what they deal in. Deterministic (no LLM needed);
  // the server-LLM business_persona (if present) supersedes it for a richer phrasing.
  const desigStr = str(idSum.designation);
  // role slot = a real ROLE word only (Manufacturer/Trader/Wholesaler…), NEVER a product category — else the headline
  // reads "Trader · Non Stick Dosa Tawa". Prefer verified GST role; else a non-web businessType; else let designation carry it.
  const roleStr = gstRole || (businessTypeField.present && !/web/i.test(String(businessTypeField.source || '')) ? businessType : '') || '';
  const headlineProds = [...new Set([...(products || []), ...topProducts])].filter(Boolean).slice(0, 3).join(', ');
  const llmPersona = str(obj(llm.business_persona).value) || str(obj(llm.business_type).value);
  const headline = (llmPersona && !/^(null|n\/?a|none)$/i.test(llmPersona))
    ? llmPersona
    : (() => { const lead = [desigStr, roleStr].filter(Boolean).join(' · '); const s = [lead, headlineProds && `deals in ${headlineProds}`].filter(Boolean).join(' — '); return s.trim() || null; })();

  // ── INTERNAL card: all DETERMINISTIC PII + registry detail (owner: show everything, full/unmasked, high-confidence) ──
  const detField = (v: string | null | undefined, src: string): Field => { const s = str(v); return s && !isAbsent(s) ? field(s, 'single', src) : absentField(src); };
  const extLoc = obj(obj(summaryOf(rich, 'external')).location);
  const contact: ContactPii = {
    email: detField(idn?.emails?.[0] || ext?.emails?.[0], 'IndiaMART profile / external'),
    altEmail: detField((idn?.emails || ext?.emails || [])[1], 'external'),
    fullAddress: detField(ext?.location || idn?.address, 'Befisc (external identity)'),
    city: detField(idn?.city || ext?.city, 'profile / external'),
    district: detField(str(idSum.district), 'IndiaMART profile'),
    state: detField(idn?.state || ext?.state, 'profile / external'),
    pincode: detField(str(extLoc.pincode), 'Befisc'),
    dob: detField(ext?.dob, 'Befisc (external identity)'),
    gender: detField(ext?.gender, 'Befisc (external identity)'),
    age: detField(ext?.age, 'Befisc (external identity)'),
    incomeBand: detField(ext?.incomeBand, 'Befisc — purchasing-power hint'),
  };
  const gstDetail = gstAdvance(rich);
  const natureList = (gstDetail?.natureOfBusiness && gstDetail.natureOfBusiness.length) ? gstDetail.natureOfBusiness : gstNature;
  const businessNature = natureList.length ? field([...new Set(natureList)].join(' · '), 'registry', 'GST nature_of_business_activity (verified)') : absentField('GST certificate / advance');
  const socialPresenceCount = (ext && ext.socialPresenceCount != null) ? ext.socialPresenceCount : null;
  const epfoArr = arr(summaryOf(rich, 'epfo').details).map(obj);
  const epfo: EpfoBlock | null = epfoArr.length ? {
    present: true,
    establishment: detField(str(epfoArr[0].establishment_name), 'IDfy EPFO (employer registry)'),
    employeeCount: detField(str(epfoArr[0].employee_count ?? epfoArr[0].employees ?? epfoArr[0].employee_strength), 'IDfy EPFO'),
  } : null;
  const aadSum = obj(summaryOf(rich, 'aadhaar'));
  const aadNo = str(aadSum.aadhaar || aadSum.aadhaar_number || aadSum.masked_aadhaar || obj(arr(aadSum.facts)[0]).value);
  const aadhaar: AadhaarBlock | null = (aadNo && !isAbsent(aadNo)) ? { present: true, value: field(aadNo, 'single', 'aadhaar-fact'), name: detField(str(aadSum.name), 'aadhaar-fact') } : null;
  const paidurlS = str(idSum.paidurl);
  const catalogueLink = (paidurlS && !isAbsent(paidurlS) && /^https?:|indiamart|\.com|\.in/i.test(paidurlS)) ? field(paidurlS, 'registry', 'IndiaMART storefront (paidurl)') : absentField('IndiaMART listing');

  return {
    glid: str(obj(rich).glid),
    available,
    header: {
      company: field(company, 'registry', company === idn?.company ? 'IndiaMART profile' : 'GST certificate'),   // audit P2: GST-cert name is REGISTRY-grade, not 'inferred' (LLM synthesis)
      contactName: field(idn?.name || '', 'registry', 'IndiaMART profile'),
      memberSince: field(memberSince, 'registry', 'GLUSR usersince'),
      registeredLocation: (() => { const loc = [idn?.city, idn?.state].filter(Boolean).join(', '); return loc ? field(loc, 'registry', 'IndiaMART profile · registered city (glusr) — the ORIGINAL operating location; sourcing cities are separate') : absentField('profile city'); })(),
      tenureYears,
      tiles,
    },
    headline,
    verifiedBuyer,
    businessStory,
    buyerDetails, overview, procurement, market,
    company: cmp,
    requirementActivity,
    social: {
      website: sf(web.website, 'website'),
      facebook: sf(web.facebook, 'facebook'),
      instagram: sf(web.instagram, 'instagram'),
      linkedin: sf(web.linkedin, 'linkedin'),
      twitter: sf(web.twitter_x ?? web.twitter, 'twitter'),
    },
    socialPlatforms: [...sign3Socials],
    products,
    productsOffered: arr(summaryOf(rich, 'whatsapp').products_offered).map(str).filter(Boolean),   // available if the spec wants both; not shown by default
    latestRequirement,
    hasActiveRequirement,
    proofs,
    googleBusiness,
    contact, gstDetail, businessNature, socialPresenceCount, epfo, aadhaar, catalogueLink,
    plan: null,   // §2 — no plan_type / activated_on field anywhere in the pipeline → card omits the TrustSEAL Plan tile entirely (never fabricated)
    health: Object.fromEntries(Object.keys(sources).map((k) => { const n = obj(sources[k]); const h = obj('__health' in n ? n.__health : obj(n.summary).__health); return [k, { ok: h.ok !== false, status: str(h.status) }]; })),
  };
}
