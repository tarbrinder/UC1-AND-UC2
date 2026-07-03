// ─── TrustSEAL Buyer Profile — DATA LAYER (decoupled from the UI, per owner §5) ──────────────────────────────
// ONE parseBuyerProfile(rich) → a normalized BuyerProfileModel the card renders. ZERO fabricated data: every field
// either traces to a real JSON path or carries present:false (the UI renders an explicit "Not available" state).
// Provenance is first-class — a field knows whether it is registry-grade, cross-source-triangulated, single-source,
// or LLM-inferred (web_osint), so the card can badge it. Reads `__health` per node: a node whose health is ok:false
// or status skipped/timeout/no_data is treated as UNAVAILABLE (no partial render off a failed fetch). PURE, no LLM.
import { identityFromMerged, externalFromMerged, bandConfidence, gstAdvance } from './buyerDetails';
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
  return /no\s+(account|company|official website|google business rating|website|record|data|listing)[^.]*found|not\s+found\s+in\s+(the\s+)?supplied\s+records|no\s+.*found\s+in\s+the\s+supplied|^n\/?a$|^-+$|^none$|^null$|^unknown$|not available|no\s+pan\s+on\s+file|^skipped$/i.test(v);
}
// clean a possibly-absent web string → real value or null
const webVal = (v: unknown): string | null => { const s = str(v); return (!s || isAbsent(s)) ? null : s; };

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
    const match = normVal(g).includes(normVal(w).slice(0, 24)) || normVal(w).includes(normVal(g).slice(0, 24));
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
export interface UdyamBlock { present: boolean; regNo: Field; enterpriseType: Field; organizationType: Field; majorActivity: Field; nicIndustries: string[]; incorporation: Field; officialAddress: Field }
export interface MonthBar { month: string; count: number }
export interface BuyerProfileModel {
  glid: string;
  available: boolean;                       // false → no rich payload pulled yet
  header: { company: Field; contactName: Field; memberSince: Field; tenureYears: number | null; tiles: StatTile[] };
  businessStory: { text: string; inferredParts: string[] } | null;   // templated, NOT literal
  overview: LabeledField[];
  procurement: LabeledField[];              // all "Not available" in current data
  market: LabeledField[];                   // all "Not available" in current data
  company: {
    gst: Field; gstStatus: Field; tradeName: Field; constitution: Field; regDate: Field; principalAddress: Field;
    identity: IdentitySignals | null; pans: PanBlock | null; mobiles: MobileRow[]; udyam: UdyamBlock;
  };
  requirementActivity: { total: number | null; months: MonthBar[]; series: string[]; note: string };
  social: { website: Field; facebook: Field; instagram: Field; linkedin: Field; twitter: Field };
  products: string[];
  productsOffered: string[];
  googleBusiness: { exists: boolean; rating: string | null } | null;
  plan: null;                               // omitted — no source field (see comment in parseBuyerProfile)
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
  const certs = arr(summaryOf(rich, 'gst_cert_idfy').certificates).map(obj);
  const cert0 = certs[0] || {};
  const gdDetails = arr(summaryOf(rich, 'gst_detail_union').gst_details).map(obj);

  // ── tenure ──────────────────────────────────────────────────────────────────────────────────────────────
  // tenure_years lives on the GLUSR `usersince` source (NOT identity.summary as the sample prompt assumed) — read it,
  // else derive from member_since ISO date. (Honest note: neither is in identity.summary; verified against buyerDetails.ts.)
  const tenureRaw = str(usSince.tenure_years) || str(obj(summaryOf(rich, 'identity')).tenure_years);
  let tenureYears: number | null = tenureRaw && !isNaN(Number(tenureRaw)) ? Number(tenureRaw) : null;
  const memberSince = idn?.memberSince || str(usSince.member_since) || '';
  if (tenureYears == null && memberSince) { const t = Date.parse(memberSince); if (!isNaN(t)) tenureYears = Math.floor((Date.now() - t) / (365.25 * 86400000)); }

  // ── header stat tiles — the sample JSON has NO "sellers connected" count; map to REAL aggregates, labeled honestly
  // (owner §2). buyer_turns / campaigns_received (cited) are ABSENT from the frontend shape → computed from the WA
  // timeline instead of trusting a key that isn't there. ────────────────────────────────────────────────────────
  const buyerMsgs = wa ? wa.inbound.buyerMsgs : null;
  const campaigns = wa ? wa.inbound.messages.filter((m) => m.side === 'platform' && m.kind === 'template').length : null;
  const tiles: StatTile[] = [
    { label: 'Buyer Messages (6mo)', value: buyerMsgs, sourceNote: 'whatsapp.summary.timeline · buyer-side count (cited buyer_turns not in shape)' },
    { label: 'Campaigns Received', value: campaigns, sourceNote: 'whatsapp.summary.timeline · templated/offer msgs (cited campaigns_received not in shape)' },
    { label: 'BuyLeads', value: reqs.length || null, sourceNote: 'requirement.summary.requirements[].length' },
  ];

  // ── business overview ───────────────────────────────────────────────────────────────────────────────────────
  const businessType = webVal(web.business_type);
  const turnover = webVal(web.turnover_estimate);
  const industry = webVal(web.industry);
  const stageDesc = tenureYears == null ? null : tenureYears < 1 ? 'Recently Established' : tenureYears < 4 ? 'Growing' : 'Established';
  const webConf = bandConfidence(web.confidence) ?? 60;
  // ROLE from VERIFIED GST nature_of_business — registry-grade, needs NO web. Fixes "Business Type = Not available when
  // web fails but the GST clearly says Manufacturer/Wholesaler/Retailer" (GLID 22642257: Factory+Retail+Wholesale).
  const gstNature: string[] = (Array.isArray(cert0.nature_of_business_activity) ? cert0.nature_of_business_activity as string[]
    : (gdDetails.length && Array.isArray(obj(obj(gdDetails[0].fields).nature_of_business_activity).canonical) ? obj(obj(gdDetails[0].fields).nature_of_business_activity).canonical as string[] : []));
  const roleMap: Array<[RegExp, string]> = [[/manufactur|factory/i, 'Manufacturer'], [/wholesale/i, 'Wholesaler'], [/retail/i, 'Retailer'], [/import|export/i, 'Importer/Exporter'], [/service/i, 'Service Provider'], [/\btrad/i, 'Trader']];
  const gstRole = [...new Set(gstNature.flatMap((n) => roleMap.filter(([re]) => re.test(n)).map(([, r]) => r)))].join(' · ');
  const gstTurnover = gstAdvance(rich)?.turnover || null;   // registry turnover if the GST-advance record carried one
  // industry: web (inferred) → else the buyer's own top requirement category / enquired product (registry-ish)
  const reqIndustry = str(reqs[0]?.category) || (wa?.meta?.productsEnquired || [])[0] || '';
  const businessTypeField: Field = gstRole
    ? field(gstRole, 'registry', 'GST nature of business (verified · Sign3⊕IDfy)')
    : businessType ? field(businessType, 'inferred', 'web_osint (LLM)', { confidence: webConf }) : absentField('GST / web_osint');
  const overview: LabeledField[] = [
    { label: 'Business Type', field: businessTypeField },
    { label: 'Business Stage', field: stageDesc ? { value: stageDesc, present: true, provenance: 'derived', source: `derived from tenure (${tenureYears}y)`, note: 'rule: <1y Recently Established · <4y Growing · else Established' } : absentField('tenure') },
    { label: 'Annual Procurements', field: absentField('no source field in pipeline') },   // §2 — no field exists; never fabricated
    { label: 'Annual Turnover', field: turnover ? field(turnover, 'inferred', 'web_osint (LLM · from listing snippet, not a filed financial)', { confidence: webConf }) : gstTurnover ? field(gstTurnover, 'registry', 'GST-advance (filed)') : absentField('web_osint / GST-advance') },
  ];
  // PROCUREMENT PROFILE + MARKET FOCUS — no source fields exist in the pipeline. Rendered as muted "Not available"
  // rows (owner choice) so the 3-column layout holds and the gap is visible/honest. Wire an upstream source to fill.
  const procurement: LabeledField[] = ['Sourcing Channel', 'Preferred Suppliers', 'Procurement Approach'].map((label) => ({ label, field: absentField('no source field in pipeline') }));
  const market: LabeledField[] = ['Target Customers', 'Selling Channel', 'Sales Geography'].map((label) => ({ label, field: absentField('no source field in pipeline') }));

  // ── B server-LLM overlay — when the response carries `llm_profile` (from the bi-buyer-profile endpoint's LLM tail),
  // its inferred narrative fields REPLACE the deterministic "Not available"/web fallbacks (this is what fills the
  // Procurement Profile / Market Focus / stage / type / turnover / story that no raw source can). Absent → deterministic
  // values above stand. Each is tagged inferred (server LLM) with its confidence + reason. ─────────────────────────────
  const llm = obj(obj(rich).llm_profile);
  const lf = (k: string): Field | null => { const o = obj(llm[k]); const v = str(o.value); if (!v || /^(null|n\/?a|none|unknown|not available)$/i.test(v)) return null; return { value: v, present: true, provenance: 'inferred', source: 'server LLM (bi-buyer-profile)', inferred: true, confidence: Number(o.confidence) || undefined, note: str(o.reason) || undefined }; };
  if (Object.keys(llm).length) {
    const setL = (a: LabeledField[], i: number, k: string) => { const f = lf(k); if (f) a[i] = { label: a[i].label, field: f }; };
    setL(overview, 0, 'business_type'); setL(overview, 1, 'business_stage'); setL(overview, 3, 'annual_turnover');
    setL(procurement, 0, 'sourcing_channel'); setL(procurement, 1, 'preferred_suppliers'); setL(procurement, 2, 'procurement_approach');
    setL(market, 0, 'target_customers'); setL(market, 1, 'selling_channel'); setL(market, 2, 'sales_geography');
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
    businessStory = { text: `${company} is a ${stagePart}${rolePart}business${prodPart}.`.replace(/\s+/g, ' ').trim(), inferredParts: gstRole ? [] : (industry ? ['industry (web)'] : []) };
  }
  // server-LLM story (if B provided one) supersedes the templated one — it's a fuller narrative from the evidence
  const llmStory = str(obj(llm.business_story).value);
  if (llmStory && !/^(null|n\/?a|none)$/i.test(llmStory)) businessStory = { text: llmStory, inferredParts: ['server LLM'] };

  // ── company details ─────────────────────────────────────────────────────────────────────────────────────────
  const gstAddr = gdDetails.length ? str(obj(obj(gdDetails[0].fields).address).canonical) : '';
  const principalAddress = triangulateAddress(gstAddr || null, webVal(web.official_address));

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
  const udyProfile = obj(udy0.profile);
  const udyNic = arr(udy0.industry).map(obj).map((x) => `${str(x.nic_code)} ${str(x.industry || x.activity)}`.trim()).filter(Boolean);
  const udyam: UdyamBlock = {
    present: !!str(udy0.udyam_reg_no),
    regNo: field(str(udy0.udyam_reg_no), 'registry', 'Udyam MSME registry (Sign3)'),
    enterpriseType: field(str(udyProfile.enterprise_type), 'registry', 'Udyam MSME registry — authoritative SIZE band'),
    organizationType: field(str(udyProfile.organization_type), 'registry', 'Udyam MSME registry'),
    majorActivity: field(str(udyProfile.major_activity), 'registry', 'Udyam MSME registry'),
    nicIndustries: udyNic,
    incorporation: field(str(udyProfile.date_of_incorporation), 'registry', 'Udyam MSME registry'),
    officialAddress: field(str(udy0.official_address), 'registry', 'Udyam MSME registry'),
  };

  const gstStatusVal = str(cert0.gstin_status);
  const cmp = {
    gst: field(str(cert0.gstin), 'registry', 'IDfy GST certificate'),
    gstStatus: gstStatusVal ? { value: gstStatusVal, present: true, provenance: 'registry' as Provenance, source: 'IDfy GST certificate', note: 'literal gstin_status (not a hardcoded label)' } : absentField('IDfy GST certificate'),
    tradeName: field(str(cert0.trade_name) || str(cert0.legal_name), 'registry', 'IDfy GST certificate'),
    constitution: field(str(cert0.constitution_of_business), 'registry', 'IDfy GST certificate'),
    regDate: field(str(cert0.date_of_registration), 'registry', 'IDfy GST certificate'),
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
  const months: MonthBar[] = order.map((m) => ({ month: m, count: bucketCounts.get(m) || 0 }));
  const requirementActivity = {
    total: reqs.length || null,
    months,
    series: ['BuyLeads'],
    note: months.length ? 'Grouped by BuyLead posted-month. Single series — the reference BuyLead/Call/Enquiry 3-way split is not present in this data shape.' : 'No dated requirements to chart.',
  };

  // ── social — every value guarded by isAbsent (web strings like "no account found" → dash, never link-ified) ─────
  const sf = (v: unknown, label: string): Field => { const s = webVal(v); return s ? { value: s, present: true, provenance: 'inferred', source: `web_osint (LLM) · ${label}`, inferred: true, confidence: webConf } : absentField('web_osint'); };
  const gb = obj(web.google_business);
  const googleBusiness = ('google_business' in web) ? { exists: gb.exists === true, rating: gb.exists === true ? (webVal(gb.rating) || null) : null } : null;

  return {
    glid: str(obj(rich).glid),
    available,
    header: {
      company: field(company, company === idn?.company ? 'registry' : 'inferred', company === idn?.company ? 'IndiaMART profile' : 'GST certificate'),
      contactName: field(idn?.name || '', 'registry', 'IndiaMART profile'),
      memberSince: field(memberSince, 'registry', 'GLUSR usersince'),
      tenureYears,
      tiles,
    },
    businessStory,
    overview, procurement, market,
    company: cmp,
    requirementActivity,
    social: {
      website: sf(web.website, 'website'),
      facebook: sf(web.facebook, 'facebook'),
      instagram: sf(web.instagram, 'instagram'),
      linkedin: sf(web.linkedin, 'linkedin'),
      twitter: sf(web.twitter_x ?? web.twitter, 'twitter'),
    },
    products: wa?.meta?.productsEnquired || [],
    productsOffered: arr(summaryOf(rich, 'whatsapp').products_offered).map(str).filter(Boolean),   // available if the spec wants both; not shown by default
    googleBusiness,
    plan: null,   // §2 — no plan_type / activated_on field anywhere in the pipeline → card omits the TrustSEAL Plan tile entirely (never fabricated)
    health: Object.fromEntries(Object.keys(sources).map((k) => { const n = obj(sources[k]); const h = obj('__health' in n ? n.__health : obj(n.summary).__health); return [k, { ok: h.ok !== false, status: str(h.status) }]; })),
  };
}
