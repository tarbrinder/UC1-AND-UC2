// ─── n8n E1 · NODE-RUN TRACE — paste into a Code node at the END of the buyer-pull workflow ───────────────
// PURPOSE: emit the authoritative per-node trace the app's Health/Observatory reads (enrichment.extractServerTrace).
// Today the Observatory's "n8n authoritative trace (E1)" shows 🔴 / 0 items because this node isn't deployed —
// the buyer data DID arrive (the client derives it from the response), but the per-node COUNTER is dark. Deploy
// this and the panel turns green with real items_out / status / latency.
//
// HOW TO DEPLOY (you — I can't push to your n8n):
//   1. Add a Code node named "E1 Trace" just BEFORE "Respond to Webhook2" (so it runs after all branches).
//   2. Mode: "Run Once for All Items". Paste this whole file as the JS.
//   3. Edit NODE_NAMES below to match YOUR exact node names (left = the workflow node, right = the label shown).
//   4. (Optional latency) add a Set node at each branch start writing {{$now.toMillis()}} into a field the
//      branch carries through; set TIMING_FIELD below to read it. Without it, latency_ms is null (honest).
//
// OUTPUT: passes every input item through UNCHANGED + appends one extra item { _trace: {...} }. The app scans
// the response array for the element carrying `_trace`, so existing get()-by-key parsing is unaffected.

// left = exact n8n node name to inspect · right = label shown in the Observatory
const NODE_NAMES = [
  ['Webhook', 'Webhook'],
  ['EBI Pull', 'EBI Pull'],
  ['Firecrawl', 'Firecrawl'],
  ['Buyer Twin', 'Buyer Twin'],
  ['Category Build', 'Category Build'],
  ['Requirement Brain', 'Requirement Brain'],
];
const TIMING_FIELD = '';   // e.g. '__t_start' if you carry a per-branch start timestamp; '' = no latency

const nodes = [];
let totalItems = 0, nodesOk = 0, nodesMissing = 0;

for (const [nodeName, label] of NODE_NAMES) {
  let items = null;
  try { items = $(nodeName).all(); } catch (e) { items = null; } // a node that didn't run on this path → throws
  if (items == null) { nodes.push({ node: label, status: 'missing', items_out: 0, confidence: null, latency_ms: null }); nodesMissing++; continue; }

  const count = items.length;
  totalItems += count;
  const first = (items[0] && items[0].json) || {};
  // best-effort per-node confidence + output keys (purely informational)
  const confidence = typeof first.confidence === 'number' ? first.confidence : (typeof first.score === 'number' ? first.score : null);
  const outputKeys = Object.keys(first).slice(0, 12);
  let latency_ms = null;
  if (TIMING_FIELD && typeof first[TIMING_FIELD] === 'number') latency_ms = Math.max(0, Date.now() - first[TIMING_FIELD]);

  nodes.push({
    node: label,
    status: count > 0 ? 'ok' : 'empty',
    items_out: count,
    confidence,
    latency_ms,
    output_keys: outputKeys,
    output_sample: (() => { try { return JSON.stringify(first).slice(0, 200); } catch (e) { return null; } })(),
  });
  if (count > 0) nodesOk++; else nodesMissing++;
}

const _trace = {
  schema: 'e1.noderun.v1',
  summary: {
    trace_id: $execution.id || null,
    glid: String($json.glid || $('Webhook').first()?.json?.query?.glid || ''),
    execution_id: $execution.id || null,
    node_count: NODE_NAMES.length,
    nodes_ok: nodesOk,
    nodes_missing: nodesMissing,
    total_items: totalItems,
    emitted_at: new Date().toISOString(),
  },
  nodes,
};

// pass everything through + append the trace element (the app finds the element carrying `_trace`)
return [...$input.all(), { json: { _trace } }];
