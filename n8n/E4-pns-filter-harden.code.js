// ─── E4 · pns_filter (HARDENED) — paste/replace the Code in your n8n "pns_filter" node ──────────────────────
// WHY: the old filter only read `$input.first().json.data`. If the pns-call-insights endpoint returns the calls
// array under ANY other shape (a bare array, or .insights / .call_insights / .result.data / .results / .body.data),
// `.data` is undefined → it emitted pns_data:"[]" → the frontend saw 0 PNS facts (no PNS block in Pull Sources,
// nothing for the twin / offer-enrichment). This version probes the common shapes, picks the first ARRAY it finds,
// and records WHICH key worked in __health so the path is auditable. Output contract is unchanged: { pns_data, __health }.

const __t0 = $('t0').first().json.__t0;
const __h = (source, ok, records, error, via) => ({ source, ok, records, ms: Date.now() - __t0, error: error || null, via: via || null, fetched_at: new Date().toISOString() });

let out = '[]', ok = true, records = 0, err = null, via = null;
try {
  const j = $input.first().json || {};
  // probe the likely shapes, in order — first one that yields a non-empty array wins
  const candidates = [
    ['data', j.data],
    ['insights', j.insights],
    ['call_insights', j.call_insights],
    ['result.data', j.result && j.result.data],
    ['results', j.results],
    ['body.data', j.body && j.body.data],
    ['data.insights', j.data && j.data.insights],
    ['(root array)', Array.isArray(j) ? j : null],
    ['pns_data', typeof j.pns_data === 'string' ? (() => { try { return JSON.parse(j.pns_data); } catch { return null; } })() : j.pns_data],
  ];
  const hit = candidates.find(([, v]) => Array.isArray(v) && v.length > 0)
           || candidates.find(([, v]) => Array.isArray(v)); // fall back to an empty array we DID find (vs none)
  if (hit) { via = hit[0]; records = hit[1].length; out = JSON.stringify(hit[1]); ok = records > 0; if (!records) err = 'PNS endpoint returned 0 calls for this GLID'; }
  else { ok = false; err = (j.error && (j.error.message || j.error)) || j.message || 'no PNS array in response (checked data/insights/result.data/…) — check the endpoint shape'; }
} catch (e) { ok = false; err = e.message; }

return [{ json: { pns_data: out, __health: __h('PNS', ok, records, err, via) } }];
