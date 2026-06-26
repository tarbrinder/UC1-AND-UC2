// ─── n8n E2 · ISQ STRIP-DEDUCED — paste into a Code node right AFTER the ISQ fetch, BEFORE it joins the response ──
// PURPOSE: the ISQ payload mixes two very different things under the same `isq` list:
//   • BUYER-STATED specs  — what the buyer actually answered (Material = Writing Paper, GSM = 54, …)  ✅ keep
//   • SYSTEM-DEDUCED specs — "Probable Order Value", "Probable Requirement Type"/business-type, etc. that an
//     upstream model GUESSED. They are NOT buyer-stated, are frequently wrong, and (because they look like real
//     ISQ answers) they leak into the twin's specs / order-value / business-type as if confirmed.  ❌ drop
// The app already drops these client-side (requirements.ts IGNORE), but doing it HERE means the inaccurate
// deductions never enter the pull at all — so every downstream consumer (twin, RFQ, evals, exports) is clean,
// not just this one screen. This is the "transform ISQ in n8n to exclude the deduced specs" change.
//
// REAL SHAPE this node expects (from the advanced pull):
//   prev_isq_data : [ { title, isq: [ { IM_SPEC_MASTER_DESC, ISQ_RESPONSE }, … ] }, … ]
//
// HOW TO DEPLOY (you — I can't push to your n8n):
//   1. Add a Code node named "E2 ISQ Strip" immediately after the node that produces prev_isq_data.
//   2. Mode: "Run Once for All Items". Paste this whole file as the JS.
//   3. If your field is NOT called `prev_isq_data`, change ISQ_FIELD below. If the ISQ list key inside each
//      record is NOT `isq`, change LIST_KEY. If the spec-name key is NOT `IM_SPEC_MASTER_DESC`, change DESC_KEY.
//   4. (Optional) tune DEDUCED_DESC — anything whose spec-name matches it is treated as a guess and removed.
// OUTPUT: same items, but every dropped answer is removed from `isq` AND recorded under `_isq_stripped` so the
//   removal is auditable (counts + the exact specs dropped) — nothing disappears silently.

const ISQ_FIELD = 'prev_isq_data';            // the field holding the ISQ array on each item
const LIST_KEY  = 'isq';                       // the per-record list of answers
const DESC_KEY  = 'IM_SPEC_MASTER_DESC';       // the spec name on each answer
// SYSTEM-DEDUCED spec names to strip (case-insensitive substring / regex). Buyer-stated specs never match these.
const DEDUCED_DESC = /probable order value|probable requirement type|requirement type|business type|buyer type|estimated (order )?value|order value range|annual turnover|company turnover|deduced|predicted|inferred|likely/i;

function stripRecord(rec) {
  if (!rec || typeof rec !== 'object') return { rec, dropped: [] };
  const list = Array.isArray(rec[LIST_KEY]) ? rec[LIST_KEY] : [];
  const dropped = [];
  const kept = list.filter((a) => {
    const desc = a && typeof a === 'object' ? String(a[DESC_KEY] ?? '') : '';
    if (desc && DEDUCED_DESC.test(desc)) { dropped.push(desc.trim()); return false; }
    return true;
  });
  return { rec: { ...rec, [LIST_KEY]: kept }, dropped };
}

const out = [];
for (const item of items) {
  const j = item.json || {};
  const isqArr = j[ISQ_FIELD];
  if (!Array.isArray(isqArr)) { out.push(item); continue; }   // nothing to clean on this item — pass through

  let totalDropped = 0; const droppedSpecs = [];
  const cleaned = isqArr.map((rec) => {
    const { rec: r, dropped } = stripRecord(rec);
    totalDropped += dropped.length; droppedSpecs.push(...dropped);
    return r;
  });

  out.push({
    json: {
      ...j,
      [ISQ_FIELD]: cleaned,
      // audit trail — the removal is visible, not silent (matches the app's honesty model)
      _isq_stripped: { count: totalDropped, specs: [...new Set(droppedSpecs)], rule: DEDUCED_DESC.source },
    },
  });
}

return out;
