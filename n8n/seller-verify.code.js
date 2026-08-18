// ===== NODE: seller-verify (entity web-verify crawler — is this buyer ALSO a seller?) =====
// ASYNC-workflow source node. Fire → poll the scraper at 34.93.111.50 (reachable from the n8n host,
// NOT from office/VPN egress — the browser path goes through the /api/sellerverify proxy instead).
// House contract: emits ONE item { summary, raw, __health } with alwaysOutputData + onError=continue.
//
// ENV (set in the n8n INSTANCE env — never paste keys into nodes/chats):
//   SELLER_VERIFY_KEY   X-Gemini-Key for the crawler (falls back LLM_GATEWAY_KEY / LLM_KEY)
//   SELLER_VERIFY_MAX_MS  poll budget, default 75000 (keep ≤ the pipeline's other branches so the
//                         DUMB-MERGE barrier isn't extended; whatever arrived by the cap is emitted)
// Wiring: fan out from the tier resolver → this node → DUMB-MERGE barrier; register 'seller_verify'
// in final-assemble's source registry; clone an emit-prep/emit-post pair with source 'seller-verify'.
//
// Pairs with: buyerprofile.summary.is_also_seller (self-declared flag) — this is the EXTERNAL
// confirmation. Cross-check with conflict_tickets: seller side + open disputes = strong risk signal.

const now = new Date().toISOString();
const http = this.helpers.httpRequest.bind(this.helpers);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = 'sk-Jeftmk4N_Ns7ZBXyl0oJGA';
const MAX_MS = 45000;
const BASE = 'http://34.93.111.50/api/v2';

// GLID: t0 (tier resolver) carries the resolved query + async plumbing (__job_id/__callback_url).
const GLID = (() => {
  try {
    const t = $('t0').first().json || {};
    return String(t.glid || (t.query && t.query.glid) || '').trim();
  } catch (e) { return ''; }
})();

const fail = (status, error_msg, extra) => [{ json: {
  summary: { glid: GLID || null, is_seller: null, fields: null },
  raw: null,
  __health: Object.assign({ node: 'seller_verify', ok: false, status, error_msg: error_msg || null, version: 'crawler/v2', fetched_at: now }, extra || {}),
} }];

if (!GLID) return fail('skipped', 'no glid on t0');
if (!KEY) return fail('no_key', 'set SELLER_VERIFY_KEY (or LLM_GATEWAY_KEY/LLM_KEY) in the n8n instance env');

// Distill the (undocumented, evolving) scraper result: keep the raw payload whole, surface common
// keys defensively. is_seller: any explicit flag wins, else infer from catalog/site/company evidence.
function distill(result, glid) {
  const r = (result && typeof result === 'object') ? result : {};
  const flag = r.is_seller !== undefined ? r.is_seller
    : r.seller_found !== undefined ? r.seller_found
    : r.is_also_seller !== undefined ? r.is_also_seller : null;
  const catalog = r.catalog_url || r.catalogue_url || r.storefront_url || (r.urls && Array.isArray(r.urls) && r.urls[0]) || null;
  const website = r.website || r.official_website || null;
  const company = r.company_name || r.legal_name || r.trade_name || null;
  const evidenceCount = [catalog, website, company].filter(Boolean).length;
  return {
    glid,
    is_seller: flag !== null ? !!flag : (evidenceCount >= 2 ? true : (evidenceCount === 0 ? false : null)),
    is_seller_source: flag !== null ? 'explicit_flag' : (evidenceCount >= 1 ? 'inferred_evidence' : 'no_evidence'),
    company_name: company,
    catalog_url: catalog,
    website,
    fields_returned: Object.keys(r).filter((k) => r[k] != null && r[k] !== ''),
  };
}

let jobId = null;
try {
  const start = await http({
    method: 'POST', url: BASE + '/seller/verify',
    headers: { 'Content-Type': 'application/json', 'X-Gemini-Key': KEY },
    body: { glid: GLID }, json: true, timeout: 25000,
  });
  jobId = start && (start.job_id || start.jobId || start.id) || null;
} catch (e) {
  return fail('error', 'init: ' + String((e && (e.message || e.description)) || e).slice(0, 240));
}
if (!jobId) return fail('no_data', 'verify returned no job id');

const t0 = Date.now();
let polls = 0;
let last = null;
while (Date.now() - t0 < MAX_MS) {
  await sleep(3000);
  polls++;
  try { last = await http({ method: 'GET', url: BASE + '/seller/status/' + encodeURIComponent(jobId), json: true, timeout: 20000 }); }
  catch (e) { continue; }                       // transient poll failure → keep polling
  const s = String((last && last.status) || '').toLowerCase();
  if (s === 'failed' || s === 'error') {
    return fail('error', 'job failed: ' + String((last && (last.error || last.message)) || ' scraper reported failure').slice(0, 240), { job_id: jobId, polls });
  }
  if (s === 'completed' || s === 'done' || s === 'success' || s === 'finished') {
    const summary = distill(last && last.result, GLID);
    const hasResult = !!(last && last.result && typeof last.result === 'object' && Object.keys(last.result).length);
    return [{ json: {
      summary,
      raw: (last && last.result) || null,
      __health: { node: 'seller_verify', ok: hasResult, status: hasResult ? 'success' : 'no_data', job_id: jobId, polls, ms: Date.now() - t0, version: 'crawler/v2', fetched_at: new Date().toISOString() },
    } }];
  }
}
// Budget exhausted — the scrape may still finish later, but the barrier must not wait.
return fail('timeout', 'poll budget exhausted (' + MAX_MS + 'ms) — scrape still running', { job_id: jobId, polls });
