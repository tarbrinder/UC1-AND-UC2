// ─── n8n E3 · REDASH GLUSR FETCH — member-since + last-modified ───────────────────────────────────────────
// Mirrors your EXISTING category fetch (redashRows(mcat) → POST /api/queries/11308/results + poll jobs). This is
// the SAME pattern on query 12070 ( select * from GLUSR_usr where glusr_usr_id = {{ glusr }} ), param `glusr`.
// It merges a small `glusr_extra` block the app reads:
//   • glusr_usr_membersince  → "Member since" (months) on BOTH enrichment cards
//   • glusr_usr_lastmodified → a row right after the verified email/mobile on the NEW card
//
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// EASIEST (recommended) — DON'T add a node. In your EXISTING category Code node (where REDASH / RKEY / redashRows
// already live) paste the `redashGlusr` function below + these 3 lines where you build the output item, then it
// rides your existing merge for free:
//     const glusr = $json.glusr ?? $json.glid;
//     const gRows = await redashGlusr(glusr).catch(() => []);
//     item.json.glusr_extra = gRows[0] ? { glusr_usr_membersince: gRows[0].glusr_usr_membersince, glusr_usr_lastmodified: gRows[0].glusr_usr_lastmodified } : null;
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// OR as a STANDALONE node (this whole file, "Run Once for Each Item") — wire Webhook → E3 → final Merge.

const REDASH = 'https://redash.intermesh.net';
const RKEY   = 'KHDBL787pd3sbkWyPo8Gs2KsE20DZA1AhQLZwjmE'; // ⚠ use the SAME user key your category node's RKEY uses;
                                                            //    the POST/poll endpoints need the user key, not a per-query key.
const QUERY_ID = 12070;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// identical shape to your redashRows(mcat) — only the query id (12070) + param name (glusr) differ
async function redashGlusr(glusr) {
  const trig = await fetch(`${REDASH}/api/queries/${QUERY_ID}/results`, {
    method: 'POST',
    headers: { Authorization: `Key ${RKEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parameters: { glusr: Number(glusr) }, max_age: 0 }),
    signal: AbortSignal.timeout(40000),
  });
  const tj = await trig.json();
  if (tj?.query_result?.data?.rows) return tj.query_result.data.rows;               // cached → done
  let jobId = tj?.job?.id, qrid = tj?.job?.query_result_id || null, status = tj?.job?.status;
  for (let i = 0; i < 40 && !qrid; i++) {
    await sleep(3000);
    const pj = await (await fetch(`${REDASH}/api/jobs/${jobId}?api_key=${RKEY}`, { signal: AbortSignal.timeout(20000) })).json();
    status = pj?.job?.status;
    if (status === 3) qrid = pj.job.query_result_id;
    else if (status === 4) throw new Error('redash job failed: ' + (pj?.job?.error || '?'));
  }
  if (!qrid) throw new Error('redash poll timeout (status ' + status + ')');
  const rj = await (await fetch(`${REDASH}/api/query_results/${qrid}.json?api_key=${RKEY}`, { signal: AbortSignal.timeout(20000) })).json();
  return rj?.query_result?.data?.rows || [];
}

const out = [];
for (const item of items) {
  const j = item.json || {};
  const glusr = j.glusr ?? j.glid ?? j.glusr_usr_id ?? j.GLID;
  let extra = null;
  if (glusr != null) {
    try {
      const rows = await redashGlusr(glusr);
      const row = rows[0] || {};
      extra = { glusr_usr_membersince: row.glusr_usr_membersince ?? null, glusr_usr_lastmodified: row.glusr_usr_lastmodified ?? null };
    } catch (e) { extra = { _error: String(e && e.message ? e.message : e) }; } // honest: surface failure, don't drop silently
  }
  out.push({ json: { ...j, glusr_extra: extra } });
}
return out;
