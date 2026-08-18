#!/usr/bin/env node
// Build n8n/Buyer Intelligence Unified.json from n8n/RFQ Buyer Unified (bi-buyer-unified) - ASYNC.json
// Per plan at C:\Users\Imart\.claude\plans\sunny-soaring-stream.md
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SRC = path.join(REPO, 'n8n', 'RFQ Buyer Unified (bi-buyer-unified) - ASYNC.json');
const OUT = path.join(REPO, 'n8n', 'Buyer Intelligence Unified.json');
const CONFLICT_CODE = path.join(REPO, 'n8n', 'conflict-tickets.code.js');

const wf = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const conflictCode = fs.readFileSync(CONFLICT_CODE, 'utf8');

// ── DROP SET (verified against inventory) ────────────────────────────────────
const DROP = new Set([
  // client-facing async plumbing
  'cache-gate', 'respond-cached', 'early-respond', 'mode_router',
  // seller-verify chain (10) — broken in source (wired to merge slot 20 on a 20-input node), out of scope
  'sv-fire','sv-wait-init','sv-poll','sv-if-done','sv-if-failed','sv-guard','sv-guard-if','sv-wait-poll','sv-parse','sv-empty',
  // calls transcription chain (21) — tier-gated OFF in superfast, per plan section 04
  'calls-trigger','calls-wait-initial','calls-poll','calls-if-done','calls-if-failed','calls-guard','calls-guard-if','calls-wait-poll',
  'calls-fetch','calls-parse','calls-route-if','calls-fetch-audio','calls-transcribe','calls-assemble','calls-empty','calls-audio-b64',
  'calls-llm-body','calls-tier-gate','calls-audio-if','calls-audio-skip','calls-join',
  // pns TRANSCRIPTION only (pns-insights + pns-parser are KEPT)
  'pns-tier-gate','pns-trigger','pns-wait-initial','pns-poll','pns-if-done','pns-if-failed','pns-guard','pns-guard-if','pns-wait-poll',
  'pns-fetch','pns-parse','pns-route-if','pns-sign-url','pns-sign-parse','pns-fetch-audio','pns-audio-b64','pns-llm-body',
  'pns-audio-if','pns-audio-skip','pns-transcribe','pns-join','pns-assemble','pns-empty',
  // parallel.ai OSINT (8) — per plan section 05, don't reproduce this architecture
  'websearch-build','websearch-if','websearch-post','websearch-poll','websearch-parse','websearch-if-done','websearch-guard','websearch-guard-if',
  // gst-cert-wait — per plan "Collapsed to single Code nodes", remove wait; keep post→poll direct.
  'gst-cert-wait',
]);

// Drop every emit-prep-* / emit-post-* (24) and every sticky note (16 — we add our own)
for (const n of wf.nodes) {
  if (/^emit-(prep|post)-/.test(n.name)) DROP.add(n.name);
  if (n.type === 'n8n-nodes-base.stickyNote') DROP.add(n.name);
}

// ── FILTER nodes ─────────────────────────────────────────────────────────────
const kept = wf.nodes.filter(n => !DROP.has(n.name));

// ── EDIT: Webhook1 → path 'buyer-intelligence' ───────────────────────────────
const webhook = kept.find(n => n.type === 'n8n-nodes-base.webhook');
webhook.parameters.path = 'buyer-intelligence';
webhook.webhookId = 'buyer-intelligence-sync';
webhook.name = '01 — Input';

// ── EDIT: t0 — strip __job_id / __callback_url minting ───────────────────────
// Original t0 ends with:
//   var __job_id = ...;
//   var __callback_url = ...;
//   return [{ json: Object.assign({}, j, { ..., __job_id: __job_id, __callback_url: __callback_url }) }];
// Drop the two `var` mint lines. Strip `__job_id`/`__callback_url` KEYS from the return
// object literal WITHOUT deleting the return line itself.
const t0 = kept.find(n => n.name === 't0');
{
  let js = t0.parameters.jsCode;
  // 1. Drop the two var-mint lines (they don't contain `return`)
  js = js.split('\n').filter(l => !/^\s*var __(job_id|callback_url)\b/.test(l)).join('\n');
  // 2. Remove `, __job_id: __job_id` and `, __callback_url: __callback_url` from the return-object keys
  js = js.replace(/,\s*__job_id:\s*__job_id/g, '');
  js = js.replace(/,\s*__callback_url:\s*__callback_url/g, '');
  t0.parameters.jsCode = js;
}

// ── ADD: 01 — Cache Gate (if node — replaces the deleted cache-gate) ────────
const cacheGate = {
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [{
        id: 'cache-hit-check',
        leftValue: '={{ $json.__cached_result ? 1 : 0 }}',
        rightValue: 1,
        operator: { type: 'number', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  },
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  id: 'cache-gate-new-id',
  name: '01 — Cache Gate',
  position: [400, 200],
};
kept.push(cacheGate);

// ── ADD: 05 — Conflict Tickets (Code node from n8n/conflict-tickets.code.js) ─
const conflictTickets = {
  parameters: { jsCode: conflictCode },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  id: 'conflict-tickets-id',
  name: '05 — Conflict Tickets',
  position: [900, 1400],
  alwaysOutputData: true,
  onError: 'continueRegularOutput',
};
kept.push(conflictTickets);

// ── EDIT: final-assemble — add conflict_tickets to sources{} + REGISTRY ──────
const finalAssemble = kept.find(n => n.name === 'final-assemble');
{
  let js = finalAssemble.parameters.jsCode;
  // Add conflict_tickets to sources{} (insert after aadhaar line)
  js = js.replace(
    /aadhaar: ref\('aadhaar-fact'\),.*$/m,
    match => match + `\n  conflict_tickets: ref('05 — Conflict Tickets'),   // Redash QID 12023 (BS_Conflict, buyer as respondent, 365d) — genuine dispute-history signal`
  );
  // Add REGISTRY entry (insert after buyerprofile)
  js = js.replace(
    /(buyerprofile: \{ source_name:"buyerprofile"[^}]+\},)/,
    `$1\n    conflict_tickets: { source_name:'conflict_tickets', purpose:'IndiaMART iil_customer_tickets — BS_Conflict count as RESPONDENT (buyer-as-seller being complained about), 365d window. Genuine dispute-history signal. Never rebranded as a risk score.', trust_level:'high', should_influence_persona:false, should_influence_intent:false, should_influence_requirement_generation:false, should_influence_trust_score:true, observed_only:false },`
  );
  finalAssemble.parameters.jsCode = js;
}

// ── EDIT: profile-bundle — add CONFLICT TICKETS evidence line + procurement_cities to OUTPUT CONTRACT ──
const profileBundle = kept.find(n => n.name === 'profile-bundle');
{
  let js = profileBundle.parameters.jsCode;
  // Add CONFLICT TICKETS evidence line after the WHATSAPP push (find a stable anchor)
  if (!js.includes('CONFLICT TICKETS')) {
    js = js.replace(
      /(const _od = sumOf\('company_reg'\);[^\n]*\n)/,
      `$1const _conflict = sumOf('conflict_tickets'); if (_conflict && _conflict.as_respondent) L.push('CONFLICT TICKETS (iil_customer_tickets — BS_Conflict as RESPONDENT, 365d): as_respondent.count=' + (_conflict.as_respondent.count||0) + ' | source=REDASH');\n`
    );
  }
  // procurement_cities is DERIVED deterministically in 08 — Intelligence Parser
  // from sources.requirement.search_cities + sources.csl.browse_cities (excluding own operating city).
  // Not asked of the LLM — respects "LLM must not regenerate deterministic data."
  profileBundle.parameters.jsCode = js;
}

// ── EDIT: profile-llm — model → google/gemini-3.7-flash ──────────────────────
const profileLlm = kept.find(n => n.name === 'profile-llm');
{
  const p = profileLlm.parameters;
  // Body is built inline via jsonBody expression — find and replace the model string in the expression
  if (p.jsonBody) p.jsonBody = String(p.jsonBody).replace(/google\/gemini-2\.5-flash/g, 'google/gemini-3.7-flash');
  // Also check any bodyParametersJson / bodyParameters shapes
  if (p.bodyParametersJson) p.bodyParametersJson = String(p.bodyParametersJson).replace(/google\/gemini-2\.5-flash/g, 'google/gemini-3.7-flash');
  // Some HTTP-node versions carry body under options
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'string') o[k] = o[k].replace(/google\/gemini-2\.5-flash/g, 'google/gemini-3.7-flash');
      else walk(o[k]);
    }
  };
  walk(p);
}

// ── EDIT: profile-parse — drop 2.5 stamp, extend ALLOW with new keys ─────────
const profileParse = kept.find(n => n.name === 'profile-parse');
{
  let js = profileParse.parameters.jsCode;
  js = js.replace(/google\/gemini-2\.5-flash/g, 'google/gemini-3.7-flash');
  // Extend ALLOW — the v47 cache guard's non-empty check
  js = js.replace(
    /(const ALLOW = \[)/,
    `$1'procurement_cities','industry',`
  );
  profileParse.parameters.jsCode = js;
}

// ── ADD: 08 — Intelligence Parser (regroup 34 flat attrs → 4 sections) ──────
const IP_CODE = `
// 08 — Intelligence Parser — regroup profile-parse's flat attributes into the 4 business sections.
// Persona / Sourcing / Risk / Internet Profile. Also relabels sub_industry → industry.
// Risk section carries deterministic flags from sources.* (never LLM-scored) + conflict_tickets count.
const item = $input.first().json || {};
const b = (item.buyer && typeof item.buyer === 'object') ? item.buyer : {};
const sources = (item.sources && typeof item.sources === 'object') ? item.sources : {};

// Rename sub_industry → industry (attribute-level; frozen prompt still emits sub_industry)
if (b.sub_industry && !b.industry) { b.industry = b.sub_industry; delete b.sub_industry; }

const pick = (keys) => {
  const out = {};
  for (const k of keys) if (b[k] !== undefined && b[k] !== null) out[k] = b[k];
  return out;
};

const persona = pick(['industry','business_stage','scale','annual_turnover','business_persona','business_type','buyer_maturity']);
const sourcing = pick(['price_vs_quality','annual_procurements','sourcing_channel','preferred_suppliers','procurement_approach','procurement_model','purchase_frequency','location_sourcing_preference']);

// procurement_cities — DERIVED deterministically from source data, not asked of the LLM.
// Governed by SOURCING-vs-OPERATING (dedupe against buyer's own operating city) + OUR-OUTBOUND exclusion.
try {
  const cities = new Set();
  const rq = sources.requirement && sources.requirement.summary;
  if (rq && Array.isArray(rq.search_cities)) rq.search_cities.forEach(c => c && cities.add(String(c).trim()));
  const csl = sources.csl && sources.csl.summary;
  if (csl && Array.isArray(csl.browse_cities)) csl.browse_cities.forEach(c => c && cities.add(String(c).trim()));
  // Exclude the buyer's own operating city (the OUR-OUTBOUND / circular rule).
  const bp = (sources.buyerprofile && sources.buyerprofile.summary) || {};
  const own = String(bp.city || '').trim().toLowerCase();
  if (own) [...cities].forEach(c => { if (c.toLowerCase() === own) cities.delete(c); });
  if (cities.size) sourcing.procurement_cities = {
    value: [...cities],
    sources: ['REQUIREMENTS','CSL'],
    note: 'Derived deterministically from search/browse cities, excluding the buyer\\'s own operating city.',
  };
} catch (e) { /* absent sources → skip */ }

// RISK — deterministic flags copied straight from source-node output, never LLM-scored.
const bp = (sources.buyerprofile && sources.buyerprofile.summary) || {};
const gst = (sources.gst_detail_union && sources.gst_detail_union.summary) || {};
const ud  = (sources.udyam && sources.udyam.summary) || {};
const pan = (sources.pan_union && sources.pan_union.summary) || {};
const ct  = (sources.conflict_tickets && sources.conflict_tickets.summary) || null;
const ext = (sources.external && sources.external.summary) || {};

const risk = {};
if (bp.is_fraud !== undefined) risk.is_fraud = { value: !!bp.is_fraud, sources: ['BUYER PROFILE'] };
if (bp.fraudreason) risk.fraud_reason = { value: bp.fraudreason, sources: ['BUYER PROFILE'] };
if (bp.verification_status) risk.verification_status = { value: bp.verification_status, sources: ['BUYER PROFILE'] };
if (bp.avg_rating != null) risk.indiamart_seller_rating = { value: { avg: bp.avg_rating, count: bp.rating_count || null }, note: 'This is the GLID\\'s SELLER-side IndiaMART rating (arrives with is_also_seller). It is NOT the buyer\\'s trust grade.', sources: ['BUYER PROFILE'] };
if (bp.verification) risk.verification_flags = { value: bp.verification, sources: ['BUYER PROFILE'] };
if (ext.phone_breaches !== undefined) risk.phone_breaches = { value: ext.phone_breaches, sources: ['EXTERNAL'] };
if (b.identity_confidence) risk.identity_confidence = b.identity_confidence;
if (b.digital_footprint) risk.digital_footprint = b.digital_footprint;
if (bp.is_also_seller !== undefined) risk.is_also_seller = { value: !!bp.is_also_seller, sources: ['BUYER PROFILE'] };
risk.gst_verified = { value: !!(gst && (gst.count || gst.primary || gst.gstin)), sources: ['GST'] };
risk.udyam_registered = { value: !!(ud && (ud.udyam_reg_no || ud.enterprise_type)), sources: ['UDYAM'] };
risk.pan_present = { value: !!(pan && pan.primary), sources: ['PAN'] };
if (ct && ct.as_respondent) {
  risk.conflict_tickets = {
    as_respondent: {
      count: ct.as_respondent.count || 0,
      window: ct.as_respondent.window || '365d',
      type: ct.as_respondent.type || 'BS_Conflict (181)',
    },
    note: 'Genuine dispute-history count from iil_customer_tickets. NOT a risk score or grade.',
    sources: ['REDASH iil_customer_tickets QID 12023'],
  };
}

// INTERNET PROFILE — GST / PNS / Company & Previous. INRCA omitted (no upstream source).
const internet_profile = {};
if (sources.gst_detail_union) internet_profile.gst = {
  value: sources.gst_detail_union.summary || null,
  sources: ['GST'],
};
if (sources.pns && sources.pns.summary) internet_profile.pns_profiling = {
  value: sources.pns.summary,
  sources: ['PNS'],
};
const cp = {};
if (bp.member_since) cp.member_since = bp.member_since;
if (bp.year_of_estb) cp.year_of_estb = bp.year_of_estb;
if (bp.contacts_company) cp.company = bp.contacts_company;
const od = (sources.company_reg && sources.company_reg.summary) || {};
if (od.constitution) cp.constitution = od.constitution;
if (od.partner_names) cp.partner_names = od.partner_names;
if (od.annual_turnover_band) cp.gst_declared_turnover_band = od.annual_turnover_band;
if (bp.activity) cp.historical_activity = bp.activity;
if (Object.keys(cp).length) internet_profile.company_previous = { value: cp, sources: ['BUYER PROFILE','COMPANY / KYB'] };

// Strip empties from each section
const drop = (o) => { for (const k of Object.keys(o)) { const v = o[k]; if (v == null || v === '' || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) delete o[k]; } return o; };

return [{ json: {
  glid: item.glid || null,
  fetched_at: item.fetched_at || new Date().toISOString(),
  persona: drop(persona),
  sourcing: drop(sourcing),
  risk: drop(risk),
  internet_profile: drop(internet_profile),
  needs_input: Array.isArray(item.needs_input) ? item.needs_input : [],
  __health: item.__health || null,
  __source_priority: item.source_priority || null,
  __sources_present: item.sources_present || null,
  __sources_absent: item.sources_absent || null,
} }];
`;
const intelligenceParser = {
  parameters: { jsCode: IP_CODE },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  id: '08-intel-parser-id',
  name: '08 — Intelligence Parser',
  position: [3800, 800],
};
kept.push(intelligenceParser);

// ── ADD: 08 — Respond (single terminal respondToWebhook) ────────────────────
const respond = {
  parameters: {
    respondWith: 'json',
    responseBody: '={{ $json }}',
    options: {},
  },
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.1,
  id: '08-respond-id',
  name: '08 — Final Buyer Intelligence',
  position: [4400, 800],
};
kept.push(respond);

// ── ADD: cache-hit passthrough (unwraps __cached_result into $json) ─────────
const cacheHit = {
  parameters: {
    jsCode: `return [{ json: ($input.first().json.__cached_result || $input.first().json) }];`,
  },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  id: '01-cache-hit-id',
  name: '01 — Cache Hit',
  position: [600, 200],
};
kept.push(cacheHit);

// ── ADD: 8 section sticky notes (visual grouping) ────────────────────────────
const sections = [
  ['01 — INPUT', [200, 100], '#8b5cf6'],
  ['02 — IDENTITY & ANCHORS', [200, 500], '#3b82f6'],
  ['03 — BUSINESS / KYB', [200, 900], '#0ea5e9'],
  ['04 — PROCUREMENT', [200, 1300], '#10b981'],
  ['05 — TRUST / INTERNET', [200, 1700], '#f59e0b'],
  ['06 — EVIDENCE', [200, 2100], '#ef4444'],
  ['07 — INTELLIGENCE (Gemini 3.7 Flash)', [200, 2500], '#ec4899'],
  ['08 — OUTPUT', [200, 2900], '#64748b'],
];
sections.forEach(([title, [x, y], color], i) => {
  kept.push({
    parameters: { content: `## ${title}`, height: 300, width: 5000, color: 5 },
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    id: `section-${i}-id`,
    name: `SECTION — ${title}`,
    position: [x, y],
  });
});

// ── CONNECTIONS — rewire ─────────────────────────────────────────────────────
const conns = {};

// helper
const wire = (from, targets) => {
  conns[from] = conns[from] || { main: [[]] };
  const arr = conns[from].main[0] = conns[from].main[0] || [];
  for (const t of targets) arr.push({ node: t.node, type: 'main', index: t.index || 0 });
};
const wireIf = (from, trueTargets, falseTargets) => {
  conns[from] = { main: [
    trueTargets.map(t => ({ node: t.node, type: 'main', index: t.index || 0 })),
    falseTargets.map(t => ({ node: t.node, type: 'main', index: t.index || 0 })),
  ]};
};

// Preserve every kept-node's original connections FIRST, then rewrite what we changed.
const keptNames = new Set(kept.map(n => n.name));
for (const [src, spec] of Object.entries(wf.connections)) {
  if (!keptNames.has(src)) continue;
  const newSpec = { main: [] };
  for (const outSlot of (spec.main || [])) {
    const filtered = (outSlot || []).filter(edge => keptNames.has(edge.node));
    newSpec.main.push(filtered);
  }
  conns[src] = newSpec;
}

// Rewrite the ones we changed:
//   Webhook1 (01 — Input) → t0 (unchanged: t0 was already downstream of Webhook1)
conns['01 — Input'] = { main: [[{ node: 't0', type: 'main', index: 0 }]] };
delete conns['Webhook1'];

//   t0 → 01 — Cache Gate
conns['t0'] = { main: [[{ node: '01 — Cache Gate', type: 'main', index: 0 }]] };

//   01 — Cache Gate: true → 01 — Cache Hit → 08 — Final; false → all source heads
const SOURCE_HEADS = [
  'csl-data1','pns-insights1','pns-insights-p2','pns-insights-p3',
  'whatsapp-conversations2','whatsapp-inbound','BL profile','rfq-details-api',
  'usersince','od-fetch','bp-compute-K',
  '05 — Conflict Tickets',
].filter(n => keptNames.has(n));
wireIf('01 — Cache Gate',
  [{ node: '01 — Cache Hit' }],
  SOURCE_HEADS.map(n => ({ node: n }))
);
wire('01 — Cache Hit', [{ node: '08 — Final Buyer Intelligence' }]);

//   profile-parse → 08 — Intelligence Parser → cache-store → 08 — Final Buyer Intelligence
conns['profile-parse'] = { main: [[{ node: '08 — Intelligence Parser', type: 'main', index: 0 }]] };
conns['08 — Intelligence Parser'] = { main: [[{ node: 'cache-store', type: 'main', index: 0 }]] };
conns['cache-store'] = { main: [[{ node: '08 — Final Buyer Intelligence', type: 'main', index: 0 }]] };

// ── FIX: DUMB-MERGE — count wired indices after drops, add conflict_tickets ──
// Original 21-index wiring; drops remove indices 8 (calls), 9 (pns_calls), 17 (web_osint), 20 (sv).
// The remaining feeds re-target sequentially; conflict-tickets gets the tail slot.
const dumb = kept.find(n => n.name === 'DUMB-MERGE');
const DUMB_WIRES = [
  { from: ['csl-merge','aadhaar-fact'] },   // was in0 (double-fed). Fix bug #4 by splitting into two slots.
  { from: ['pns-parser'] },
  { from: ['requirement'] },
  { from: ['whatsapp'] },
  { from: ['identity'] },
  { from: ['external'] },
  { from: ['gst-resolve'] },
  { from: ['gst-advance-resolve'] },
  { from: ['pan-gst-parse'] },
  { from: ['gst-cert-parse'] },
  { from: ['bp-parse'] },
  { from: ['gst-consensus'] },
  { from: ['mobile-compile'] },
  { from: ['pan-compile'] },
  { from: ['s3-pan-advance-parse'] },
  { from: ['udyam-parse'] },
  { from: ['od-parse'] },
  { from: ['05 — Conflict Tickets'] },
  { from: ['aadhaar-fact'] },   // own slot (was double-feeding in0)
];
// Filter to only nodes actually kept
const wires = DUMB_WIRES.map(w => ({ from: w.from.filter(n => keptNames.has(n)) })).filter(w => w.from.length);
// Fix bug #4: split csl-merge and aadhaar-fact into distinct slots — we already gave aadhaar-fact its own slot.
// Wires with 'csl-merge' + 'aadhaar-fact' in the same slot: remove aadhaar-fact from slot 0.
if (wires[0] && wires[0].from.includes('csl-merge') && wires[0].from.includes('aadhaar-fact')) {
  wires[0].from = wires[0].from.filter(x => x !== 'aadhaar-fact');
}
dumb.parameters.numberInputs = wires.length;
// Rewrite connections FROM each source TO the merge at the assigned slot
for (let i = 0; i < wires.length; i++) {
  for (const src of wires[i].from) {
    if (!keptNames.has(src)) continue;
    conns[src] = conns[src] || { main: [[]] };
    // Preserve any existing outputs that aren't the merge (rare — usually just merge or an emit-prep-*)
    // Remove any existing edge into DUMB-MERGE first, then add the correct-slot edge.
    conns[src].main = (conns[src].main || []).map(slot =>
      (slot || []).filter(e => e.node !== 'DUMB-MERGE')
    );
    while (conns[src].main.length === 0) conns[src].main.push([]);
    conns[src].main[0].push({ node: 'DUMB-MERGE', type: 'main', index: i });
  }
}

// Ensure DUMB-MERGE → final-assemble
conns['DUMB-MERGE'] = { main: [[{ node: 'final-assemble', type: 'main', index: 0 }]] };

// Reconnect gst-cert-post → gst-cert-poll (was: post → wait → poll; wait removed)
conns['gst-cert-post'] = { main: [[{ node: 'gst-cert-poll', type: 'main', index: 0 }]] };

// ── STRIP references to dropped nodes from every kept connection spec ────────
for (const src of Object.keys(conns)) {
  const spec = conns[src];
  if (!spec || !spec.main) continue;
  spec.main = spec.main.map(slot =>
    (slot || []).filter(edge => keptNames.has(edge.node))
  );
}

// ── FINAL: assemble ──────────────────────────────────────────────────────────
const out = {
  name: 'Buyer Intelligence Unified',
  active: false,
  nodes: kept,
  connections: conns,
  settings: wf.settings || { executionOrder: 'v1' },
  staticData: null,
  tags: [],
  triggerCount: 1,
  pinData: {},
  versionId: '',
  meta: { instanceId: 'buyer-intelligence-unified' },
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('✓ wrote', OUT);
console.log('  kept nodes:', kept.length, '(dropped', wf.nodes.length - kept.filter(n => wf.nodes.some(o => o.name === n.name)).length + kept.filter(n => !wf.nodes.some(o => o.name === n.name)).length, 'net)');
console.log('  DUMB-MERGE inputs:', dumb.parameters.numberInputs);
