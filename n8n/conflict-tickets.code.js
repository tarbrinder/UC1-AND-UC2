// ===== NODE: conflict-tickets (iil_customer_tickets — buyer↔seller conflict history) =====
// ASYNC-workflow source node. Redash fire→poll (same pattern as csl-enrich-mcat) for the buyer's
// conflict-ticket history. House contract: ONE item { summary, raw, __health }.
//
// v1 (live TODAY): Redash QID 12023 "BS Conflict" — parameterized {{glid}}, counts type-181 tickets
//   (buyer as RESPONDENT, i.e. the buyer-as-seller being complained about) over 365 days.
// v2 (create the richer query from docs/seller-verify-conflict-tickets.md, then bump QID):
//   both directions + 306 PreBS + statuses + the conflicted-seller exclusion list. The parser below
//   ALREADY handles the v2 row shape — only CONFLICT_QID changes.
//
// KEYS INLINE (owner 2026-08-18: n8n Variables are paywalled on this instance, so the key is embedded
// exactly like csl-enrich-mcat does). This is the SERVICE key — a personal read-only Redash key is
// REJECTED by Redash's unsafe-parameter guard ("cannot be executed with read-only access").
// ⚠ plaintext key in a repo file: keep the repo private; rotate if it ever moves to a shared remote.
const RKEY = 'u39CfxKyFrTeXmGYyaXwy0uuNrJ0SsRnrJeuIn4y';
const QID = 12023;   // v1 "BS Conflict" (parameterized glid). Bump to the v2 query id once created
                     // (docs/seller-verify-conflict-tickets.md) — the parser below handles both shapes.
// Wiring: fan out from the tier resolver → this node → DUMB-MERGE barrier; register 'conflict_tickets'
// in final-assemble's source registry; clone an emit-prep/emit-post pair with source 'conflict-tickets'.
//
// Use: as_respondent (buyer accused) → persona trust/risk flag, pairs with seller_verify's is_seller.
//      as_complainant (v2) → RESPONDENT_GLUSR_ID list = personalized seller-exclusion list for UC2
//      curated-seller routing (never re-match conflicted pairs) + serial-complainer fairness cap.

const REDASH = 'https://redash.intermesh.net';
const now = new Date().toISOString();
const http = this.helpers.httpRequest.bind(this.helpers);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GLID = (() => {
  try {
    const t = $('t0').first().json || {};
    return String(t.glid || (t.query && t.query.glid) || '').trim();
  } catch (e) { return ''; }
})();

const fail = (status, error_msg, extra) => [{ json: {
  summary: { glid: GLID || null, as_respondent: null, as_complainant: null, conflicted_seller_glids: [] },
  raw: null,
  __health: Object.assign({ node: 'conflict_tickets', ok: false, status, error_msg: error_msg || null, version: 'redash/' + QID, fetched_at: now }, extra || {}),
} }];

if (!GLID) return fail('skipped', 'no glid on t0');

// ── fire the query (fresh ≤24h cache is fine — tickets move slowly) ──────────────────────────
let tj = null;
for (let a = 0; a < 3 && !tj; a++) {
  try {
    tj = await http({
      method: 'POST', url: REDASH + '/api/queries/' + QID + '/results',
      headers: { Authorization: 'Key ' + RKEY, 'Content-Type': 'application/json' },
      body: { parameters: { glid: GLID }, max_age: 86400 }, json: true, timeout: 40000,
    });
  } catch (e) { tj = null; await sleep(1500); }
}
if (!tj) return fail('error', 'redash submit failed (3 tries)');

// ── job poll (Redash async execution) ───────────────────────────────────────────────────────
let rows = null;
try {
  let r = tj.query_result && tj.query_result.data && tj.query_result.data.rows;
  if (!r) {
    const jid = tj.job && tj.job.id;
    let qrid = (tj.job && tj.job.query_result_id) || null;
    let st = tj.job && tj.job.status;
    const end = Date.now() + 60000;
    while (Date.now() < end && !qrid) {
      await sleep(2500);
      let pj = null;
      try { pj = await http({ method: 'GET', url: REDASH + '/api/jobs/' + jid + '?api_key=' + RKEY, json: true, timeout: 20000 }); } catch (e) { /* retry */ }
      st = pj && pj.job && pj.job.status;
      if (st === 3) qrid = pj.job.query_result_id;        // 3 = done, 4 = failed
      else if (st === 4) break;
    }
    if (qrid) {
      const raw = await http({ method: 'GET', url: REDASH + '/api/query_results/' + qrid + '.json?api_key=' + RKEY, json: false, timeout: 25000 });
      let rj = raw; if (typeof raw === 'string') { try { rj = JSON.parse(raw); } catch (e) { rj = null; } }
      r = rj && rj.query_result && rj.query_result.data && rj.query_result.data.rows;
    }
  }
  rows = Array.isArray(r) ? r : [];
} catch (e) {
  return fail('error', 'redash poll failed: ' + String((e && (e.message || e.description)) || e).slice(0, 240));
}

// ── parse: v1 shape (total_tickets) and v2 shape (per-ticket rows) ──────────────────────────
const isOpen = (s) => !/close|resolved|cancel/i.test(String(s || ''));
let summary;
if (rows.length && rows[0].CUSTOMER_TICKET_ID !== undefined) {
  // v2 rich shape — split by direction
  const asResp = [], asComp = [];
  for (const r of rows) {
    const t = {
      ticket_id: r.CUSTOMER_TICKET_ID,
      type: r.ticket_type || (String(r.Ticket_types || '').includes('BS_Conflict') ? 'BS_Conflict' : 'PreBS_Conflict'),
      other_party_glid: String(r.RESPONDENT_GLUSR_ID) === GLID ? String(r.COMPLAINANT_GLUSR_ID) : String(r.RESPONDENT_GLUSR_ID),
      status: r.CUSTOMER_TICKET_STATUS || null,
      issued: r.CUSTOMER_TICKET_ISSUEDATE || null,
      closed: r.CUSTOMER_TICKET_CLOSEDATE || null,
    };
    (String(r.RESPONDENT_GLUSR_ID) === GLID ? asResp : asComp).push(t);
  }
  const lastDate = (a) => a.length ? a.map((x) => String(x.issued || '')).sort().pop() || null : null;
  summary = {
    glid: GLID,
    as_respondent: {
      count: asResp.length,
      bs_conflict: asResp.filter((x) => x.type === 'BS_Conflict').length,
      prebs_conflict: asResp.filter((x) => x.type === 'PreBS_Conflict').length,
      open: asResp.filter((x) => isOpen(x.status)).length,
      last_date: lastDate(asResp),
    },
    as_complainant: {
      count: asComp.length,
      conflicted_seller_glids: [...new Set(asComp.map((x) => x.other_party_glid).filter(Boolean))],
      last_date: lastDate(asComp),
    },
    conflicted_seller_glids: [...new Set(asComp.map((x) => x.other_party_glid).filter(Boolean))],
  };
} else {
  // v1 (QID 12023): one row { total_tickets } — buyer as RESPONDENT, type 181, 365d
  summary = {
    glid: GLID,
    as_respondent: {
      count: Number(rows[0] && rows[0].total_tickets) || 0,
      window: '365d', type: 'BS_Conflict (181)',
    },
    as_complainant: null,             // v2 only
    conflicted_seller_glids: [],      // v2 only
  };
}

const n = summary.as_respondent && summary.as_respondent.count || 0;
return [{ json: {
  summary,
  raw: { rows },
  __health: { node: 'conflict_tickets', ok: true, status: rows.length ? 'success' : 'no_data', qid: QID, count: n, as_complainant_count: summary.as_complainant ? summary.as_complainant.count : null, version: 'redash/' + QID, fetched_at: now },
} }];
