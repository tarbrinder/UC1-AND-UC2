// ─── Phase 5e — External Buyer Intelligence (EBI) sandbox ─────────────────────
// STANDALONE R&D pipeline. Does NOT touch the app / ConciergeChip / Twin.
// Chain (graceful at every step — internal OR sign3 OR befisc OR web can fail and
// the pipeline still produces a partial, never crashes):
//   mobile ─┬─ Profile Advance (Sign3)      → identity (Tier 3, SANDBOXED)
//           ├─ Mobile→GST (Befisc)          → GSTIN ─┬─ GST Advance → turnover/SAC/compliance
//           │                                        └─ GST→MCC/HSN → HSN + goods
//           └─ Mobile→Udyam (Befisc)        → NIC / enterprise type / scale
//   company ─ Web/OSINT (manual in this pass) → public footprint
//   ⇒ synthesize Layer-4 procurement_context (industry cluster) from EBI (+ internal)
//
// AUTH — TWO SEPARATE SERVICES (corrected):
//   • Befisc = https://prod.smartauth.co/<code>, header `authkey: BRLN…`
//             (Profile Advance C9S1 [identity], Udyam TGAG, GST codes [unknown]).
//   • Sign3  = https://you.sign3.in/v1/persona, header `Authorization: Bearer …`,
//             body {"phone": …} — a SEPARATE service. Returns social-footprint /
//             data-breach / linked-email intelligence = Tier-3 SURVEILLANCE data:
//             ~zero RFQ value + high DPDP risk → we extract ONLY a coarse non-PII
//             footprint bucket, DISCARD accounts/breaches/emails/names, never plan on it.
//
// RUN (keys via env — never hardcode):
//   EBI_AUTHKEY=BRLN… SIGN3_BEARER='Bearer aW5k…' EBI_GLID=64573225 \
//   [EP_MOBILE_GST=… EP_GST_ADV=… EP_GST_HSN=…] node scripts/ebi_sandbox.mjs
//   (EBI_MASK_PII=false → raw identity in console)

const GATEWAY = process.env.EBI_GATEWAY || 'https://prod.smartauth.co'; // Befisc gateway
const BEFISC_KEY = process.env.EBI_AUTHKEY || '';                       // Befisc → authkey header
const SIGN3_URL = process.env.SIGN3_URL || 'https://you.sign3.in/v1/persona'; // Sign3 — separate service
const SIGN3_BEARER = process.env.SIGN3_BEARER || '';                    // 'Bearer aW5k…' or raw token
const MASK_PII = process.env.EBI_MASK_PII !== 'false';
const TARGET = { glid: process.env.EBI_GLID || '64573225' };
const ENV_MOBILE = (process.env.EBI_MOBILE || '').replace(/[^0-9]/g, '').replace(/^91(?=\d{10}$)/, ''); // optional override; else derived from dump
const CONSENT = 'We confirm obtaining valid customer consent to access/process their mobile data. Consent remains valid, informed, and unwithdrawn.';
const TIMEOUT_MS = Number(process.env.EBI_TIMEOUT || 25000);
const EP = {
  profileAdvance: process.env.EP_PROFILE || 'C9S1', // KNOWN (Sign3)
  mobileToUdyam: process.env.EP_UDYAM || 'TGAG',    // KNOWN (account may lack privilege)
  mobileToGst: process.env.EP_MOBILE_GST || '',     // UNKNOWN — from Befisc console
  gstAdvance: process.env.EP_GST_ADV || '',         // UNKNOWN
  gstToHsn: process.env.EP_GST_HSN || '',           // UNKNOWN (GST→MCC/HSN)
};

// Note: 2/3/4 are API-specific (e.g. 2 can be "no-record" or "GST not filed"); these are the common readings.
const STATUS_MEANING = { 1: 'success', 2: 'no-record', 3: 'invalid-input', 4: 'name-not-found', 301: 'consent-missing', 302: 'source-down', 401: 'auth-failed', 402: 'no-privilege', 403: 'limit/whitelist', 404: 'not-whitelisted' };

// ── Source trust model (your rule) ──────────────────────────────────────────
// Internal n8n profile/transcript + KYC (Sign3) + govt registry (Befisc GST/Udyam)
// are AUTHORITATIVE. Open-web (OSINT) is only as strong as the KEY the match hinged
// on: a unique identifier (GST/mobile/website/email) ≈ very high; company-name ≈
// medium; a person's name + location ≈ weak (namesakes).
const SOURCE_CONFIDENCE = { internal_n8n: 95, sign3: 90, befisc_gst: 92, befisc_udyam: 90 };
function osintMatchConfidence(basis = []) {
  const b = basis.map((s) => String(s).toLowerCase());
  const strong = ['gst', 'gstin', 'mobile', 'phone', 'website', 'domain', 'email'];
  if (b.some((x) => strong.includes(x))) return 92;                                    // matched a unique identifier
  if (b.includes('company_name') && (b.includes('marketplace_catalog') || b.includes('website'))) return 88;
  if (b.includes('company_name') && b.includes('location')) return 62;                 // company + city = medium
  if (b.includes('company_name')) return 55;
  if (b.includes('name') && b.includes('location')) return 42;                         // person name + city = weak
  return 35;
}

// One Befisc gateway call (authkey header). NEVER throws. Times out gracefully.
async function gw(label, code, body) {
  if (!code) return { label, skipped: true, why: 'no endpoint code configured' };
  if (!BEFISC_KEY) return { label, skipped: true, why: 'EBI_AUTHKEY not set' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(`${GATEWAY}/${code}`, {
      method: 'POST', signal: ctrl.signal,
      headers: { authkey: BEFISC_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: 'Y', consent_text: CONSENT, ...body }),
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    const status = j ? Number(j.status) : undefined;
    return { label, code, http: r.status, status, meaning: STATUS_MEANING[status] || (j ? 'unknown' : 'non-json'),
             message: j?.message, ok: status === 1, data: status === 1 ? (j.result || j.data || j) : undefined, ms: Date.now() - t0 };
  } catch (e) {
    return { label, code, error: e.name === 'AbortError' ? `timeout>${TIMEOUT_MS}ms` : String(e), ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

// Sign3 persona (SEPARATE service, Bearer). NEVER throws. ⚠ Returns social/breach/
// linked-email SURVEILLANCE data — we extract ONLY a coarse, non-identifying
// footprint bucket (a faint "real person vs burner" proxy) and DISCARD the rest.
async function sign3Persona(phone) {
  if (!SIGN3_BEARER) return { skipped: true, why: 'SIGN3_BEARER not set' };
  if (!phone) return { skipped: true, why: 'no phone' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS); const t0 = Date.now();
  try {
    const auth = SIGN3_BEARER.startsWith('Bearer ') ? SIGN3_BEARER : `Bearer ${SIGN3_BEARER}`;
    const r = await fetch(SIGN3_URL, { method: 'POST', signal: ctrl.signal, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
    const j = await r.json().catch(() => null);
    const pd = j?.phone_data?.primary_data || {};
    const n = Number(pd.social_profile_count || 0);
    // ONLY a coarse trust proxy is kept. accounts/breaches/email/names = DISCARDED.
    return { ok: j?.status === 'SUCCESS' || j?.status_code === 2000, http: r.status, status: j?.status,
             footprint: n >= 8 ? 'established' : n >= 3 ? 'moderate' : 'sparse',
             ms: Date.now() - t0, _discarded: 'social_accounts, breaches, linked_email, names (Tier-3 surveillance — not used)' };
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : String(e), ms: Date.now() - t0 }; }
  finally { clearTimeout(timer); }
}

// Internal IndiaMART enrichment (the existing n8n webhook). NEVER throws. Caches
// to /tmp/glid_<glid>.json and falls back to the cache when the (flaky) webhook
// returns empty — so the per-source breakdown stays available across runs.
async function internalPull(glid) {
  const fs = await import('node:fs');
  const cache = `/tmp/glid_${glid}.json`;
  const fromCache = () => { try { if (fs.existsSync(cache)) { const c = fs.readFileSync(cache, 'utf8'); if (c.length) return { ok: true, bytes: c.length, raw: c, src: 'cache' }; } } catch {} return null; };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://imworkflow.intermesh.net/webhook/user-insights-glid123?glid=${glid}`, { signal: ctrl.signal });
    const t = await r.text();
    if (r.status === 200 && t.length > 0) { try { fs.writeFileSync(cache, t); } catch {} return { ok: true, http: r.status, bytes: t.length, raw: t, src: 'live' }; }
    return fromCache() || { ok: false, http: r.status, bytes: t.length };
  } catch (e) { return fromCache() || { ok: false, error: String(e) }; }
  finally { clearTimeout(timer); }
}

// Break the internal dump into its 7 sources, with counts + a short peek each —
// so debug shows EXACTLY what came from PNS / CSL / WhatsApp / BL / ISQ / profile.
function internalBreakdown(raw) {
  let arr; try { arr = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const get = (k) => { const o = arr.find((x) => x && x[k] !== undefined); let v = o ? o[k] : undefined; if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} } return v; };
  const cnt = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : v ? 1 : 0);
  const bpv = get('buyer_profile'); const bp = Array.isArray(bpv) ? bpv[0] : bpv;
  const pns = get('pns_data'), bl = get('prev_bl_data');
  const pnsPeek = Array.isArray(pns) && pns[0]?.extracted_data?.metadata?.buyer_intent?.narrative;
  const blTitles = Array.isArray(bl) ? bl.map((x) => x?.ETO_OFR_TITLE || x?.title).filter(Boolean).slice(0, 4) : [];
  return {
    buyer_profile: bp ? { name: [bp.ceo_fname, bp.ceo_lname].filter(Boolean).join(' ') || bp.first_name || '?', company: bp.company_name || '?', loc: [bp.city, bp.state].filter(Boolean).join(', '), mobile: bp.glusr_usr_ph_mobile || bp.mobile1, gst: bp.glusr_usr_gst || bp.gstin || null, custtype: bp.glusr_usr_custtype_name } : null,
    pns: cnt(get('pns_data')), pnsPeek: pnsPeek ? String(pnsPeek).slice(0, 90) : null,
    csl: cnt(get('csl_data')),
    wa_outbound: cnt(get('whatsapp_data')),
    wa_inbound: cnt(get('whatsapp_inbound')),
    prev_bl: cnt(bl), blTitles,
    prev_isq: cnt(get('prev_isq_data')),
  };
}

// Web/OSINT — node has no browser; in prod this is a server-side search API
// (Serp/Bing). In this R&D pass the assistant runs the web search and writes
// findings (+ `match_basis`) to /tmp/osint_<glid>.json, which we score by match
// strength. Graceful skip if absent — pipeline never blocks on it.
async function webFootprint(company, glid) {
  try {
    const fs = await import('node:fs');
    const p = `/tmp/osint_${glid}.json`;
    if (fs.existsSync(p)) {
      const o = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { ok: true, ...o, confidence: osintMatchConfidence(o.match_basis || []) };
    }
  } catch { /* fall through */ }
  if (!company) return { skipped: true, why: 'no company name + no /tmp/osint file' };
  return { skipped: true, why: `no /tmp/osint_${glid}.json (wire to server-side search API in prod)` };
}

const maskPan = (p) => (p && p.length >= 6 ? `${p.slice(0, 2)}XXXX${p.slice(-1)}` : '[present]');
const present = (v) => (v == null || v === '' ? null : '[present]');

(async () => {
  // ── Stage 0 — internal FIRST: pull the GLID dump, derive mobile + company ──
  // Per "use similarly for rest cases": the mobile is read from the dump's
  // glusr_usr_ph_mobile (exactly like the app's deriveEnrichment), so the chain
  // works for ANY glid with no hardcoded number. Env EBI_MOBILE overrides.
  const internal = await internalPull(TARGET.glid);
  let company = null, profileMobile = null;
  try {
    if (internal.ok && internal.raw) {
      const arr = JSON.parse(internal.raw);
      const bpRaw = (Array.isArray(arr) ? arr.find((o) => o && o.buyer_profile) : null)?.buyer_profile;
      const bp = bpRaw ? (typeof bpRaw === 'string' ? JSON.parse(bpRaw) : bpRaw) : null;
      const prof = Array.isArray(bp) ? bp[0] : bp;
      if (prof) {
        company = prof.company_name || null;
        profileMobile = String(prof.glusr_usr_ph_mobile || prof.mobile1 || '').replace(/[^0-9]/g, '').replace(/^91(?=\d{10}$)/, '') || null;
      }
    }
  } catch { /* graceful */ }
  const mobile = ENV_MOBILE || profileMobile || '';
  const mobileSrc = ENV_MOBILE ? 'env' : profileMobile ? 'dump:glusr_usr_ph_mobile' : 'none';

  console.log(`\n════════ EBI SANDBOX — GLID ${TARGET.glid} · mobile ${(mobile || '----').replace(/\d(?=\d{4})/g, 'X')} (${mobileSrc}) ════════`);
  console.log(`befisc authkey: ${BEFISC_KEY ? BEFISC_KEY.slice(0, 4) + '…' : 'MISSING'} · sign3 bearer: ${SIGN3_BEARER ? 'set' : 'MISSING'} · mask_pii: ${MASK_PII} · company: ${company || '—'}\n`);
  if (!mobile) console.log('  ⚠ no mobile (env or dump) — mobile-keyed branches skipped.\n');

  // ── Stage 1 — parallel primary wave off the resolved mobile (fail-safe each) ──
  const [profile, mobGst, mobUdyam, sign3] = await Promise.all([
    gw('Profile Advance (Befisc, identity)', EP.profileAdvance, mobile ? { mobile } : {}),
    gw('Mobile→GST (Befisc)', EP.mobileToGst, mobile ? { mobile } : {}),
    gw('Mobile→Udyam (Befisc)', EP.mobileToUdyam, mobile ? { mobile } : {}),
    sign3Persona(mobile),
  ]);

  // ── Stage 2 — cascade off any resolved GSTIN ──
  const gstins = [];
  if (mobGst.ok && mobGst.data) {
    const g = mobGst.data.gst_number || mobGst.data.gstin || mobGst.data.GSTIN;
    if (g) gstins.push(String(g));
  }
  const gstDetails = [];
  for (const g of gstins) {
    const [adv, hsn] = await Promise.all([gw('GST Advance', EP.gstAdvance, { gst: g }), gw('GST→HSN/MCC', EP.gstToHsn, { gst: g })]);
    gstDetails.push({ gstin: g, adv, hsn });
  }

  // ── Company name for OSINT: from internal profile (Stage 0); GST legal name as fallback ──
  if (!company && gstDetails[0]?.adv?.data) company = gstDetails[0].adv.data.legal_name || gstDetails[0].adv.data.trade_name;
  const web = await webFootprint(company, TARGET.glid);

  // ── Assemble BTE-v1.3 EBI (tiered, gated) ──
  const sig = (value, source, confidence) => (value == null ? undefined : { value, source, confidence, contradiction_triggered: false });
  const advData = gstDetails[0]?.adv?.data || {};
  const hsnData = gstDetails[0]?.hsn?.data || {};
  const udyamData = mobUdyam.ok ? mobUdyam.data : {};
  const profData = profile.ok ? profile.data : {};

  const ebi = {
    glid: TARGET.glid,
    procurement_tier: {
      active_hsn_codes: sig(hsnData.hsn_code ? [String(hsnData.hsn_code)] : (Array.isArray(advData.hsn_codes) ? advData.hsn_codes : undefined), 'GST', 80),
      goods: sig(hsnData.type_of_goods, 'GST', 80),
      turnover_slab: sig(advData.aggregate_turnover || advData.turnover, 'GST', 75),
      business_constitution: sig(advData.constitution, 'GST', 75),
      manufacturing_vs_trading: sig(udyamData?.major_activity, 'Udyam', 70),
      nic_codes: sig(udyamData?.nic_codes, 'Udyam', 70),
      enterprise_scale: sig(udyamData?.type_of_enterprise, 'Udyam', 70),
    },
    // Tier 3 — identity. SANDBOXED. Never feeds the planner. Masked in console.
    identity_tier_present: {
      full_name: present(profData?.personal_information?.full_name),
      pan: profData?.document_data?.pan?.[0]?.value ? (MASK_PII ? maskPan(profData.document_data.pan[0].value) : profData.document_data.pan[0].value) : null,
      dob: present(profData?.personal_information?.date_of_birth),
      income: present(profData?.personal_information?.income),
      alt_phones: Array.isArray(profData?.alternate_phone) ? profData.alternate_phone.length : 0,
      emails: Array.isArray(profData?.email) ? profData.email.length : 0,
      addresses: Array.isArray(profData?.address) ? profData.address.length : 0,
      sign3_footprint: sign3.ok ? sign3.footprint : null, // ONLY this from Sign3; rest discarded
    },
  };

  // ── Layer-4 synthesis (best-effort from whatever resolved) ──
  const hsn = ebi.procurement_tier.active_hsn_codes?.value || [];
  const nic = ebi.procurement_tier.nic_codes?.value || [];
  const have = [hsn.length && `HSN ${hsn.join(',')}`, nic.length && `NIC ${nic.join(',')}`, ebi.procurement_tier.goods?.value, ebi.procurement_tier.manufacturing_vs_trading?.value].filter(Boolean);
  const procurement_context = {
    industry_cluster: have.length ? '(derive from HSN/NIC once procurement APIs return)' : null,
    confidence_score: Math.min(95, have.length * 25),
    derived_reasoning: have.length ? `From: ${have.join(' · ')}` : 'No procurement signals resolved (GST/Udyam blocked).',
    context_matching_mode: 'Pending (needs internal Twin + procurement data)',
  };

  // ── externalEvidenceLedger (ChatGPT) — every external fact + WHY we trust it, ──
  // so any conclusion is traceable to {source, key_used, confidence}. Identity raw
  // is redacted here (PII stays in the /tmp dump, server-side).
  const nowIso = new Date().toISOString();
  const ledger = [];
  // value_summary + used_by_twin = the fields the in-form Buyer Intelligence Ledger
  // reads. used_by_twin is FALSE for all external (observed evidence, NOT a planning
  // input — DPDP set aside); only the internal pull feeds deriveBuyerTwin today.
  const summarize = (source, raw) => {
    try {
      if (source === 'Internal') return company || 'internal n8n profile';
      if (source === 'Sign3') return `digital footprint: ${sign3.footprint || 'n/a'}`;
      if (source === 'GST') return raw?.tradeName || raw?.legalName || raw?.nature_of_business || (Array.isArray(raw?.hsn) ? raw.hsn.join(', ') : '') || 'GST registry record';
      if (source === 'Udyam') return raw?.enterprise_name || raw?.major_activity || 'Udyam record';
      if (source === 'OSINT') return raw?.summary || 'web footprint';
    } catch { /* best-effort */ }
    return '';
  };
  const addEv = (source, key_used, ok, confidence, raw) => { if (ok) ledger.push({ source, key_used, confidence, value_summary: String(summarize(source, raw)).slice(0, 80), used_by_twin: source === 'Internal', fetched_at: nowIso, raw_value: source === 'Sign3' ? '[identity — sandboxed; see /tmp dump]' : raw }); };
  addEv('Internal', 'glid', internal.ok, SOURCE_CONFIDENCE.internal_n8n, { company });
  addEv('Sign3', 'mobile', profile.ok, SOURCE_CONFIDENCE.sign3, profData);
  addEv('GST', 'GSTIN', gstDetails[0]?.adv?.ok, SOURCE_CONFIDENCE.befisc_gst, advData);
  addEv('GST', 'GSTIN→HSN', gstDetails[0]?.hsn?.ok, SOURCE_CONFIDENCE.befisc_gst, hsnData);
  addEv('Udyam', 'mobile', mobUdyam.ok, SOURCE_CONFIDENCE.befisc_udyam, udyamData);
  addEv('OSINT', (web.match_basis || []).join('+') || 'company_name', web.ok, web.confidence, { summary: web.summary, urls: web.source_urls });

  // ── Availability map (the graceful-degradation summary) ──
  const branch = (r) => (r.ok ? '✓ live' : r.skipped ? `– skipped (${r.why})` : r.status ? `✗ ${r.meaning} (status ${r.status})` : `✗ ${r.error || 'fail'}`);
  console.log('── source availability (graceful) ──');
  console.log(`  internal webhook : ${internal.ok ? `✓ ${internal.bytes}b` : `✗ down (http ${internal.http ?? '—'}, ${internal.bytes ?? 0}b)`}`);
  console.log(`  Profile Advance  : ${branch(profile)}  ${profile.ms ? profile.ms + 'ms' : ''}`);
  console.log(`  Mobile→GST       : ${branch(mobGst)}`);
  console.log(`  Mobile→Udyam     : ${branch(mobUdyam)}`);
  console.log(`  Sign3 persona    : ${sign3.ok ? `✓ footprint=${sign3.footprint}` : sign3.skipped ? `– skipped (${sign3.why})` : `✗ ${sign3.status || sign3.error || 'fail'}`}  ⚠ Tier-3 surveillance — details discarded`);
  console.log(`  GST cascade      : ${gstins.length ? gstDetails.map((d) => `${d.gstin}:adv=${branch(d.adv)},hsn=${branch(d.hsn)}`).join(' | ') : '– no GSTIN resolved'}`);
  console.log(`  Web/OSINT        : ${branch(web)}`);

  // ── per-source fetch + confidence (debug) — exactly what came from where ──
  console.log('\n── per-source fetch + confidence (debug) ──');
  const tag = (c) => `conf ${c}`;
  console.log(`  n8n profile/transcript : ${internal.ok ? `✓ ${internal.bytes}b · ${tag(SOURCE_CONFIDENCE.internal_n8n)} — our own truth${company ? ` · "${company}"` : ''}` : '✗ unavailable'}`);
  console.log(`  Sign3 Profile Advance  : ${profile.ok ? `✓ · ${tag(SOURCE_CONFIDENCE.sign3)} — KYC identity (Tier-3, sandboxed)` : `${branch(profile)}`}`);
  console.log(`  Befisc GST (→HSN/Adv)  : ${mobGst.ok ? `✓ · ${tag(SOURCE_CONFIDENCE.befisc_gst)} — registry` : `${branch(mobGst)}`}`);
  console.log(`  Befisc Udyam (NIC)     : ${mobUdyam.ok ? `✓ · ${tag(SOURCE_CONFIDENCE.befisc_udyam)} — registry` : `${branch(mobUdyam)}`}`);
  console.log(`  World/OSINT (open web) : ${web.ok ? `✓ · ${tag(web.confidence)} — matched on [${(web.match_basis || []).join(', ')}]${web.confidence >= 85 ? ' (strong id)' : web.confidence >= 55 ? ' (medium)' : ' (weak — namesake risk)'}` : `${branch(web)}`}`);

  // ── internal pull breakdown — exactly what came from each n8n source ──
  const ib = internalBreakdown(internal.raw || '');
  console.log(`\n── internal pull breakdown (n8n ${internal.src || ''} · conf ${SOURCE_CONFIDENCE.internal_n8n}) ──`);
  if (!ib) {
    console.log('  internal unavailable this run (webhook down + no cache)');
  } else {
    const mm = (m) => (m ? String(m).replace(/\D/g, '').replace(/^91/, '').replace(/\d(?=\d{4})/g, 'X') : '—');
    if (ib.buyer_profile) console.log(`  buyer_profile     : ${ib.buyer_profile.name} · ${ib.buyer_profile.company} · ${ib.buyer_profile.loc} · mob ${mm(ib.buyer_profile.mobile)} · GST ${ib.buyer_profile.gst || '—'} · ${ib.buyer_profile.custtype || ''}`);
    console.log(`  PNS calls         : ${ib.pns}${ib.pnsPeek ? ` · "${ib.pnsPeek}…"` : ''}`);
    console.log(`  CSL searches      : ${ib.csl}`);
    console.log(`  WhatsApp outbound : ${ib.wa_outbound}`);
    console.log(`  WhatsApp inbound  : ${ib.wa_inbound}`);
    console.log(`  Prev requirements : ${ib.prev_bl}${ib.blTitles.length ? ` · ${ib.blTitles.join(' / ')}` : ''}`);
    console.log(`  Prev ISQ answers  : ${ib.prev_isq}`);
  }

  console.log('\n── assembled EBI (identity masked) ──');
  console.log(JSON.stringify(ebi, null, 2));
  console.log('\n── Layer-4 procurement_context ──');
  console.log(JSON.stringify(procurement_context, null, 2));

  console.log('\n── externalEvidenceLedger (traceability) ──');
  console.log(ledger.length ? JSON.stringify(ledger.map((e) => ({ source: e.source, key_used: e.key_used, confidence: e.confidence })), null, 2) : '  (empty — no external source resolved yet)');

  // ── DEBUG VIEW mock-up (ChatGPT layout) — renders perfectly once data flows ──
  let counts = { pns: 0, wa: 0, bl: 0, csl: 0 };
  try {
    if (internal.raw) {
      const arr = JSON.parse(internal.raw);
      const cnt = (k) => { const o = arr.find((x) => x && x[k]); let v = o ? o[k] : null; try { v = typeof v === 'string' ? JSON.parse(v) : v; } catch {} return Array.isArray(v) ? v.length : v ? 1 : 0; };
      counts = { pns: cnt('pns_data'), wa: cnt('whatsapp_data'), bl: cnt('prev_bl_data'), csl: cnt('csl_data') };
    }
  } catch {}
  const row = (name, r, conf) => `  ${name.padEnd(15)} ${r.ok ? '✓' : r.skipped ? '—' : '✗'}  ${r.ok ? 'conf ' + conf : r.skipped ? 'pending' : r.meaning || 'fail'}`;
  console.log('\n════════ DEBUG VIEW (mock-up — ChatGPT layout) ════════');
  console.log(`Internal Signals:  PNS ${counts.pns} · WA ${counts.wa} · BL ${counts.bl} · CSL ${counts.csl}   [conf ${SOURCE_CONFIDENCE.internal_n8n} — truth]`);
  console.log('External Signals:');
  console.log(row('GST / HSN', gstDetails[0]?.hsn || { skipped: true }, SOURCE_CONFIDENCE.befisc_gst));
  console.log(row('GST Advance', gstDetails[0]?.adv || { skipped: true }, SOURCE_CONFIDENCE.befisc_gst));
  console.log(row('Udyam / NIC', mobUdyam, SOURCE_CONFIDENCE.befisc_udyam));
  console.log(row('Sign3 (id)', profile, SOURCE_CONFIDENCE.sign3));
  console.log(row('World Search', web, web.confidence || 0));
  console.log(`Procurement Context:  ${procurement_context.industry_cluster || '(pending GST/Udyam)'}   conf ${procurement_context.confidence_score}`);
  console.log(`Derived From:  ${procurement_context.derived_reasoning}`);
  console.log('═══════════════════════════════════════════════════════');
  if (sign3.ok) console.log('\n⚠ PRIVACY: Sign3 persona returned social/breach/linked-email data — DISCARDED here\n  (Tier-3 surveillance · ~zero RFQ value · DPDP-sensitive). Recommend it does NOT feed the Twin.');

  // Raw (UNMASKED) dump for the developer — stays on their machine.
  const fs = await import('node:fs');
  const dump = { target: { ...TARGET, mobile_used: mobile, mobile_src: mobileSrc, company }, fetched_at: nowIso, evidence_ledger: ledger, raw: { profile, mobGst, mobUdyam, gstDetails, internal: { ok: internal.ok, bytes: internal.bytes }, web } };
  fs.writeFileSync(`/tmp/ebi_${TARGET.glid}.json`, JSON.stringify(dump, null, 2));
  console.log(`\nRaw (unmasked) written to /tmp/ebi_${TARGET.glid}.json`);
  console.log('════════ end — pipeline completed without crashing (partial-tolerant) ════════');
})();
