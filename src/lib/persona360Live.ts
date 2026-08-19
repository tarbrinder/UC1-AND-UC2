// Persona360 — live data adapter (K-5 task 9 / K-3 referee @batman).
// PURE function module — contract pinned by src/lib/__tests__/persona360Live.test.ts:
//   · no import.meta.env, no network, no gemini — node --test imports it directly (types stripped)
//   · PRIMARY INPUT = the Buyer-intelligence webhook response — the SYNC workflow
//     (n8n/Buyer-intelligence.json, webhook path 'buyer-intelligence') responds with ONE
//     final JSON: the 08 — Intelligence Parser output
//       { glid, fetched_at, persona{}, sourcing{}, risk{}, internet_profile{},
//         needs_input, __health, __source_priority, __sources_present, __sources_absent }
//     (cache hits return the same 08-parser shape — cache-store sits AFTER the parser).
//   · LEGACY/FALLBACK INPUT = the final-assemble shape { glid, sources{…}, buyer, … }
//     (async buyer-persona-async fixtures). The 08-parser sections are absent there, so
//     the adapter derives from sources{} / buyer — never reads sections that don't exist.
//   · OUTPUT = Persona360Data (src/lib/persona360Types.ts) — never invents trust/risk
//     numbers, never null-coerces an absent fraud score to 0, keeps Sign3 0–1 floats raw
//     & unbanded, and carries supplier rating with seller-side semantics.
import type { ColumnState, Persona360Data, VerifyStatus } from './persona360Types';

type Json = Record<string, unknown>;

function sourcesOf(payload: unknown): Json {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Json;
  const s = p.sources;
  return s && typeof s === 'object' ? (s as Json) : {};
}

/** Top-level 08-parser section ({persona,sourcing,risk,internet_profile}) or {}. */
function secOf(payload: unknown, name: string): Json {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Json;
  const v = p[name];
  return v && typeof v === 'object' ? (v as Json) : {};
}

/** Read the {summary,rows,__health} wrapper OR treat the value itself as the summary. */
function sumOf(sources: Json, key: string): Json {
  const v = sources[key];
  if (v == null) return {};
  if (Array.isArray(v) || typeof v !== 'object') return {};
  const vObj = v as Json;
  const sm = vObj.summary;
  if (sm && typeof sm === 'object') return sm as Json;
  return vObj;
}

/**
 * Extract the per-row array of sources.pan_union / sources.mobiles tolerating ALL the
 * shapes final-assemble actually emits: {summary:{rows,primary,count},rows,__health}
 * wrapper, a bare per-row array, or null/missing (→ []).
 */
function rowsOf(sources: Json, key: string): Json[] {
  const v = sources[key];
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((r): r is Json => !!r && typeof r === 'object');
  if (typeof v !== 'object') return [];
  const vObj = v as Json;
  const sm = vObj.summary;
  const sumRows = sm && typeof sm === 'object' && Array.isArray((sm as Json).rows)
    ? ((sm as Json).rows as Json[]) : [];
  if (sumRows.length) return sumRows;
  const topRows = Array.isArray(vObj.rows) ? (vObj.rows as Json[]) : [];
  return topRows.filter((r): r is Json => !!r && typeof r === 'object');
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

/** Unwrap {value, confidence, …} LLM-attribute objects to their .value (else the value as-is). */
function unwrap(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as Json)) {
    return (v as Json).value;
  }
  return v;
}

function strV(v: unknown): string {
  return str(unwrap(v));
}

/** Real present/absent/error counts for the internet completeness strip (design §7). */
interface HealthCounts { present: number; absent: number; errors: number }

function healthCounts(payload: Json): HealthCounts {
  // final-assemble emits sources_present/sources_absent; the 08-parser output (sync
  // buyer-intelligence webhook) emits the double-underscore __sources_present/__sources_absent.
  const presentList = (payload as Json).sources_present ?? (payload as Json).__sources_present;
  const absentList = (payload as Json).sources_absent ?? (payload as Json).__sources_absent;
  const present = Array.isArray(presentList)
    ? (presentList as unknown[]).length : Object.keys(sourcesOf(payload)).length;
  const absent = Array.isArray(absentList) ? (absentList as unknown[]).length : 0;
  let errors = 0;
  const ph = (payload as Json).pipeline_health as Json | undefined;
  const errCount = ph && typeof ph === 'object' ? num((ph as Json).error_count) : null;
  if (errCount != null) {
    errors = errCount;
  } else {
    const h = (payload as Json).__health;
    if (Array.isArray(h)) {
      errors = (h as Json[]).filter((x) => {
        const ok = x && x.ok;
        const status = x && x.status;
        return ok === false || status === 'error' || status === 'ERROR';
      }).length;
    }
  }
  return { present, absent, errors };
}

/** Trust signals are a fixture-only embellishment (audit: formula pending). Live → []. */
function trustSignals(): Persona360Data['trust']['signals'] {
  return [];
}

/** Map the LLM business_stage string onto the enum; unknown → 'sme' (raw kept in stageEstimate). */
function mapStage(raw: string): Persona360Data['persona']['stage'] {
  const r = raw.toLowerCase();
  if (r.includes('start') || r.includes('new')) return 'startup';
  if (r.includes('enterprise') || r.includes('large') || r.includes('corporate') || r.includes('mid')) return 'mid';
  if (r.includes('sme') || r.includes('small') || r.includes('micro')) return 'sme';
  return 'sme';
}

/**
 * mapFinalToPersona360 — contract referee is src/lib/__tests__/persona360Live.test.ts.
 * Pure: same input ⇒ byte-identical output (no clock, no randomness, no env).
 * Reads the 08-parser sections (sync buyer-intelligence webhook) FIRST; falls back to
 * sources{} / buyer derivation when they are absent (async final-assemble fixtures).
 */
export function mapFinalToPersona360(payload: unknown): Persona360Data {
  const P = (payload && typeof payload === 'object' ? payload : {}) as Json;
  const sources = sourcesOf(payload);
  const persona08 = secOf(payload, 'persona');
  const sourcing08 = secOf(payload, 'sourcing');
  const risk08 = secOf(payload, 'risk');
  const net08 = secOf(payload, 'internet_profile');
  // 08-parser identity block (sync webhook) — deterministic passthrough already masked upstream.
  // Absent on legacy async payloads, so identity falls back to sources.* below.
  const identity08 = secOf(payload, 'identity');

  const identitySum = sumOf(sources, 'identity');
  const extSum = sumOf(sources, 'external');
  const bpSum = sumOf(sources, 'buyerprofile');
  const pnsSum = sumOf(sources, 'pns');
  const reqSum = sumOf(sources, 'requirement');
  const cslSum = sumOf(sources, 'csl');
  const gstSum = sumOf(sources, 'gst_detail_union');
  const udySum = sumOf(sources, 'udyam');

  // ── 08-parser company_previous (company history) — feeds entity/identity/internet ──
  const cpWrap = net08.company_previous && typeof net08.company_previous === 'object'
    ? (net08.company_previous as Json) : {};
  const cpObj = cpWrap.value && typeof cpWrap.value === 'object'
    ? (cpWrap.value as Json) : {};
  const companyName = strV(cpObj.company);

  // ── Sign3 fraud-seller-detection score — raw 0–1 passthrough or 'unknown' (never 0) ──
  const s3s = (extSum.sign3_scores && typeof extSum.sign3_scores === 'object')
    ? (extSum.sign3_scores as Json) : {};
  const fsd = s3s.fraud_seller_detection_score;
  const hasFsd = typeof fsd === 'number' && Number.isFinite(fsd);
  const fsd08Wrap = risk08.fraud_seller_detection_score
    && typeof risk08.fraud_seller_detection_score === 'object'
    ? (risk08.fraud_seller_detection_score as Json) : {};
  const fsd08 = fsd08Wrap.value;
  const hasFsd08 = typeof fsd08 === 'number' && Number.isFinite(fsd08);
  const rawSign3: number | 'unknown' = hasFsd08 ? (fsd08 as number) : hasFsd ? (fsd as number) : 'unknown';

  // ── identity ── prefer the 08-parser identity block (masked upstream); fall back to sources.* for async payloads.
  const name = str(
    identity08.name ?? identitySum.name ?? extSum.name ?? extSum.verified_name ?? bpSum.contacts_name ?? bpSum.name,
  );
  const badges: string[] = [];
  const isAlsoSeller08 = risk08.is_also_seller && typeof risk08.is_also_seller === 'object'
    ? (risk08.is_also_seller as Json).value : undefined;
  if (bpSum.is_also_seller === true || isAlsoSeller08 === true) badges.push('ALSO SELLER');
  const memberSince = str(identity08.member_since ?? identitySum.member_since ?? bpSum.member_since)
    || strV(cpObj.member_since ?? cpObj.year_of_estb) || undefined;
  // 08-parser already masks; local mask is only needed for async fallback shapes.
  const phoneMasked = str(identity08.mobile_masked)
    || (() => { const raw = str(identitySum.mobile ?? identitySum.mobiles ?? extSum.mobile); return raw ? maskPhone(raw) : ''; })()
    || undefined;
  const emailMasked = str(identity08.email_masked)
    || (() => { const raw = str(identitySum.email ?? extSum.email); return raw ? maskEmail(raw) : ''; })()
    || undefined;
  const city = str(identity08.city ?? identitySum.city ?? bpSum.city);
  const description = [strV(persona08.business_type), strV(persona08.scale), city]
    .filter(Boolean).join(' · ');
  const age = num(identity08.age ?? extSum.age ?? identitySum.age) ?? undefined;
  const gender = str(identity08.gender ?? extSum.gender ?? identitySum.gender) || undefined;

  // ── trust — derived from Sign3 fraud-seller-detection score (0=safe → 1=fraud).
  //    Formula: trust = round((1 - fsd) * 100), clamped 0–100. When Sign3 is 'unknown'
  //    (cache miss / no score) we DO NOT invent a number — score stays 0 and the
  //    recommendation surfaces the unavailability so the ring can render '—'. ──
  const hasFsdNum = typeof rawSign3 === 'number' && Number.isFinite(rawSign3);
  const trustScore = hasFsdNum
    ? Math.max(0, Math.min(100, Math.round((1 - (rawSign3 as number)) * 100)))
    : 0;
  const trustRecommendation = hasFsdNum
    ? ''
    : 'Sign3 fraud-seller score unavailable — trust pending';
  const trust: Persona360Data['trust'] = {
    score: trustScore,
    max: 100,
    recommendation: trustRecommendation,
    mode: 'live',
    signals: trustSignals(),
  };

  // ── persona — 08-parser section first (LLM attributes are legal: they ARE the workflow
  //    output); sources{} / buyerprofile derivation is the fallback for async shapes ──
  const personaPrimary = strV(persona08.business_persona || persona08.business_type)
    || str(pnsSum.persona ?? bpSum.contacts_name ?? bpSum.business_type ?? identitySum.name);
  const industry = strV(persona08.industry)
    || str(
      reqSum.category ?? (Array.isArray(reqSum.requirements) ? ((reqSum.requirements as Json[])[0]?.category) : null)
        ?? (Array.isArray(bpSum.browse_interest) ? (bpSum.browse_interest as unknown[])[0] : null)
        ?? (Array.isArray(cslSum.categories) ? String((cslSum.categories as Json[])[0]?.name ?? '') : ''),
    );
  const pan = rowsOf(sources, 'pan_union')
    .map((r) => str(r.pan))
    .find((x) => x !== '')
    ?? str(identitySum.pan)
    ?? null;
  const stageRaw = strV(persona08.business_stage);
  const entityType = strV(persona08.business_type) || str(bpSum.business_type) || 'Business';
  const persona: Persona360Data['persona'] = {
    primary: personaPrimary || '—',
    matchPct: 0,
    alternate: strV(persona08.buyer_maturity)
      || str(pnsSum.b2b_or_b2c || pnsSum.order_type) || undefined,
    industry: industry || '—',
    industrySecondary: strV(persona08.scale) || str(bpSum.browse_interest) || undefined,
    stage: mapStage(stageRaw),
    stageEstimate: stageRaw || undefined,
    turnover: {
      display: strV(persona08.annual_turnover) || '',
      declared: false,
    },
    entity: {
      type: entityType,
      detail: companyName || str(bpSum.contacts_company ?? identitySum.company) || undefined,
      panMasked: pan ?? undefined,
    },
  };

  // ── sourcing — 08-parser section first (procurement_cities is derived deterministically
  //    in the workflow, never LLM-scored); sources{}-derivation is the async fallback ──
  const citySet: string[] = [];
  const pushCities = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
      const nm = str(typeof c === 'object' && c != null ? (c as Json).name ?? (c as Json).value : c);
      if (nm && !citySet.includes(nm)) citySet.push(nm);
    }
  };
  const pcWrap = sourcing08.procurement_cities;
  if (Array.isArray(pcWrap)) pushCities(pcWrap);
  else if (pcWrap && typeof pcWrap === 'object') pushCities((pcWrap as Json).value);
  pushCities(reqSum.search_cities);
  pushCities(cslSum.browse_cities);
  pushCities(cslSum.cities_resolved);
  const operatingCity = str(bpSum.city ?? identitySum.city).trim().toLowerCase();
  const cities = citySet
    .filter((c) => c.trim().toLowerCase() !== operatingCity)
    .map((name) => ({ name, sharePct: 0 })); // shares are a formula gap — never invented
  const products: string[] = [];
  const pushProd = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) {
      const nm = str(typeof p === 'object' && p != null ? (p as Json).name ?? (p as Json).product_name : p);
      if (nm && !products.includes(nm)) products.push(nm);
    }
  };
  pushProd(pnsSum.products);
  if (Array.isArray(reqSum.requirements)) {
    for (const r of reqSum.requirements as Json[]) {
      const t = str((r as Json).title);
      if (t && !products.includes(t)) products.push(t);
    }
  }
  pushProd([str(bpSum.browse_interest)]);
  pushProd(bpSum.products_of_interest);

  // deliveryNote surfaces sourcing_channel and, when present, location_sourcing_preference (LLM
  // deterministic per-workflow note like "Operates in Greater Noida"). Both together read naturally
  // as the small italic caption under the cities list.
  const channelStr = strV(sourcing08.sourcing_channel);
  const locPref = strV(sourcing08.location_sourcing_preference);
  const deliveryNote = [channelStr, locPref].filter(Boolean).join(' · ') || undefined;
  const sourcing: Persona360Data['sourcing'] = {
    priceQuality: { label: strV(sourcing08.price_vs_quality) || '', position: 0 },
    annualProcurement: { display: strV(sourcing08.annual_procurements) || '', basis: '' },
    orderPattern: {
      display: strV(sourcing08.purchase_frequency) || '',
      note: strV(sourcing08.procurement_model) || strV(sourcing08.procurement_approach) || '',
    },
    cities,
    deliveryNote,
    products,
  };

  // ── risk — deterministic flags only (the 08 section IS those flags, never LLM-scored) ──
  const avg = num(bpSum.avg_rating);
  const ratingCount = num(bpSum.rating_count);
  const rating08Wrap = risk08.indiamart_seller_rating && typeof risk08.indiamart_seller_rating === 'object'
    ? (risk08.indiamart_seller_rating as Json) : {};
  const rating08Val = rating08Wrap.value && typeof rating08Wrap.value === 'object'
    ? (rating08Wrap.value as Json) : {};
  const avg08 = num(rating08Val.avg);
  const count08 = num(rating08Val.count);
  const rating = avg08 != null
    ? { value: avg08, grade: '', count: count08 ?? 0 }
    : avg != null
      ? { value: avg, grade: '', count: ratingCount ?? 0 }
      : undefined;
  const isFraud08 = risk08.is_fraud && typeof risk08.is_fraud === 'object'
    ? (risk08.is_fraud as Json).value : undefined;
  const fraudReason08 = risk08.fraud_reason && typeof risk08.fraud_reason === 'object'
    ? strV((risk08.fraud_reason as Json).value) : '';
  const fraudRead: Persona360Data['risk']['fraudRead'] = typeof isFraud08 === 'boolean'
    ? {
        verdict: isFraud08 ? 'FLAGGED' : 'CLEAR',
        detail: fraudReason08 || (isFraud08 ? 'Fraud flag on buyer profile' : 'No fraud flag on buyer profile'),
      }
    : undefined;
  const verification08 = risk08.verification_status && typeof risk08.verification_status === 'object'
    ? strV((risk08.verification_status as Json).value) : '';
  const financial: Persona360Data['risk']['financial'] = [
    { label: 'Balance sheet', status: 'pending' as VerifyStatus },
    { label: 'Cheque history', status: 'pending' as VerifyStatus },
    { label: 'Credit exposure', status: 'pending' as VerifyStatus },
  ];
  const risk: Persona360Data['risk'] = {
    score: 0,
    band: '',
    smRisk: verification08,
    smNote: rating08Wrap.note
      ? strV(rating08Wrap.note)
      : rating08Val.avg != null
        ? 'SELLER-side IndiaMART rating — not the buyer\'s trust grade'
        : undefined,
    rating,
    fraudRead,
    financial,
    rawSign3,
  };

  // ── internet profile — 08-parser sections first; source health counts always real ──
  const counts = healthCounts(P);
  const internetRows: Persona360Data['internet']['rows'] = [];
  const gst08 = net08.gst && typeof net08.gst === 'object' ? (net08.gst as Json) : {};
  const gst08Val = gst08.value && typeof gst08.value === 'object' ? (gst08.value as Json) : {};
  // 08-parser GST shape carries the union under gst_details[]. Each row's fields object holds
  // {canonical, values_by_vendor, agreement_count} per attribute — drill down to the first row's
  // legal_name (fall back to trade_name / nature_of_business_activity) for the sub label.
  const gstDetails = Array.isArray(gst08Val.gst_details) ? (gst08Val.gst_details as Json[]) : [];
  const primaryGst = (gstDetails[0] && typeof gstDetails[0] === 'object') ? (gstDetails[0] as Json) : {};
  const primaryFields = (primaryGst.fields && typeof primaryGst.fields === 'object') ? (primaryGst.fields as Json) : {};
  const canonical = (k: string): string => {
    const f = primaryFields[k];
    if (!f || typeof f !== 'object') return '';
    const c = (f as Json).canonical;
    if (Array.isArray(c)) return c.map((x) => str(x)).filter(Boolean).slice(0, 3).join(', ');
    return str(c);
  };
  const gstLegal = canonical('legal_name') || canonical('trade_name');
  const gstConstitution = canonical('constitution_of_business');
  const gstNature = canonical('nature_of_business_activity');
  const gstStatus = canonical('gstin_status');
  const gstHas = !!(gstDetails.length) || !!(gstSum.gstin || gstSum.gst || gstSum.count || gstSum.primary);
  const gstSubParts = [
    gstLegal,
    gstConstitution,
    gstNature,
    gstStatus && gstStatus !== 'Active' ? gstStatus : '',
    str(primaryGst.gstin),
  ].filter(Boolean);
  internetRows.push({
    label: 'GST registration',
    sub: gstSubParts.join(' · ')
      || strV(gst08Val.legal_name ?? gst08Val.trade_name)
      || (gstHas ? str(gstSum.legal_name ?? gstSum.trade_name ?? '') : ''),
    state: gstHas ? 'good' : 'caution',
  });
  const pns08 = net08.pns_profiling && typeof net08.pns_profiling === 'object'
    ? (net08.pns_profiling as Json) : {};
  const pns08Val = pns08.value && typeof pns08.value === 'object' ? (pns08.value as Json) : {};
  const pnsCalls = num(pns08Val.call_count) ?? num(pnsSum.call_count);
  internetRows.push({
    label: 'PNS profiling',
    sub: pnsCalls != null ? `${pnsCalls} calls` : undefined,
    state: pnsCalls != null ? 'good' : 'caution',
  });
  const udyHas = !!(udySum.udyam_reg_no || udySum.enterprise_type);
  internetRows.push({
    label: 'Udyam registration',
    sub: udyHas ? str(udySum.enterprise_type ?? udySum.udyam_reg_no) || undefined : undefined,
    state: udyHas ? 'good' : 'caution',
  });
  internetRows.push({
    label: 'Company history',
    sub: companyName || str(bpSum.contacts_company ?? identitySum.company) || undefined,
    state: companyName || str(bpSum.contacts_company ?? identitySum.company) ? 'caution' : 'caution',
  });

  const verifiedTags: Persona360Data['internet']['verifiedTags'] = [];
  const bpVer = (bpSum.verification && typeof bpSum.verification === 'object')
    ? (bpSum.verification as Json) : {};
  const gstVerified08 = risk08.gst_verified && typeof risk08.gst_verified === 'object'
    ? (risk08.gst_verified as Json).value : undefined;
  const udyVerified08 = risk08.udyam_registered && typeof risk08.udyam_registered === 'object'
    ? (risk08.udyam_registered as Json).value : undefined;
  const panVerified08 = risk08.pan_present && typeof risk08.pan_present === 'object'
    ? (risk08.pan_present as Json).value : undefined;
  verifiedTags.push({ name: 'Mobile', verified: bpVer.alt_mobile === true || !!identitySum.mobile });
  verifiedTags.push({ name: 'Email', verified: bpVer.email === true || !!identitySum.email });
  verifiedTags.push({ name: 'PAN', verified: panVerified08 === true || !!pan });
  verifiedTags.push({ name: 'GST', verified: gstVerified08 === true || gstHas });
  verifiedTags.push({ name: 'Udyam', verified: udyVerified08 === true || udyHas });

  // ── engagement — real counts only when present; monthly buckets are an audit gap → [] ──
  const metrics: Persona360Data['engagement']['metrics'] = [];
  const act = (bpSum.activity && typeof bpSum.activity === 'object') ? (bpSum.activity as Json) : {};
  const histAct = (cpObj.historical_activity && typeof cpObj.historical_activity === 'object')
    ? (cpObj.historical_activity as Json) : {};
  const actSrc = Object.keys(histAct).length ? histAct : act;
  const addMetric = (label: string, v: unknown) => {
    const n = num(v);
    if (n != null) metrics.push({ label, value: n });
  };
  if (Object.keys(actSrc).length) {
    addMetric('Requirements posted', actSrc.total_requirement ?? actSrc.past_requirement_count);
    addMetric('Calls made', actSrc.total_calls ?? actSrc.pns_call_cnt);
    addMetric('Enquiries posted', actSrc.enq_count);
    addMetric('BuyLeads replied', actSrc.buy_reply);
  }

  return {
    glid: str(P.glid),
    identity: {
      name: name || '—',
      badges,
      description,
      age,
      gender,
      memberSince,
      phoneMasked,
      emailMasked,
    },
    trust,
    persona,
    sourcing,
    risk,
    internet: {
      rows: internetRows,
      verifiedTags,
      completeness: { pct: 0, missing: [] },
      counts,
    },
    engagement: {
      windowMonths: 6,
      metrics,
      monthly: [],
    },
  };
}

/** Minimal privacy masks — upstream masking is a design note; adapters keep it local. */
function maskPhone(p: string): string {
  const d = p.replace(/\D/g, '');
  if (d.length <= 4) return d;
  return `${d.slice(0, 2)}••••${d.slice(-2)}`;
}

function maskEmail(e: string): string {
  const at = e.indexOf('@');
  if (at <= 0) return e.length > 4 ? `${e.slice(0, 2)}•••` : e;
  const local = e.slice(0, at);
  const domain = e.slice(at);
  return `${local.length > 2 ? local.slice(0, 2) : local}•••${domain}`;
}

/**
 * Column render-state derivation for the live page — each column stands alone so a failed
 * source never blanks a ready sibling (design §6). Absence → 'empty', never fabricated.
 * 08-parser sections count as ready; sources{} is the fallback for async shapes.
 */
export interface ColumnStates {
  persona: ColumnState;
  sourcing: ColumnState;
  risk: ColumnState;
  internet: ColumnState;
}

export function deriveColumnStates(payload: unknown): ColumnStates {
  const P = (payload && typeof payload === 'object' ? payload : {}) as Json;
  const sources = sourcesOf(payload);
  const has = (k: string) => {
    const v = sources[k];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v !== 'object') return !!v;
    const sm = (v as Json).summary;
    const obj = sm && typeof sm === 'object' ? (sm as Json) : (v as Json);
    return Object.keys(obj).length > 0;
  };
  const hasSec = (k: string) => {
    const v = P[k];
    return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as Json).length > 0;
  };
  return {
    persona: hasSec('persona') || has('buyerprofile') || has('pns') || has('identity') ? 'ready' : 'empty',
    sourcing: hasSec('sourcing') || has('requirement') || has('csl') || has('pns') ? 'ready' : 'empty',
    risk: hasSec('risk') || has('external') || has('buyerprofile') || has('gst_detail_union') ? 'ready' : 'empty',
    internet: hasSec('internet_profile') || has('gst_detail_union') || has('pns') || has('udyam') || has('buyerprofile') ? 'ready' : 'empty',
  };
}
