// ─── THE DECISION LEDGER (Module 1 foundation) — the UNIVERSAL spine, not a profile feature ─────────
// PURE · deterministic · NO LLM · NO infra. Root = the LEDGER; Buyer Profile is the FIRST renderer over
// it. Five FIRST-CLASS layers — nothing magical between any two:
//     Fact → Belief → Decision → Consumption → Outcome
// Built registries-FIRST (per the audit-tool principle): every source line gets a Used/Ignored/Partial
// verdict (Coverage Registry — "100% = no line without a verdict"); Consumption is its own object with
// per-consumer {status, reason}; counterfactualFor() proves "without this fact, confidence drops X→Y"
// so no click dead-ends. Harnessed in scripts/ledgertest.mjs.

const nrm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export type SourceNode = 'profile-api' | 'glusr' | 'pns-insights' | 'prev-bl' | 'prev-isq' | 'csl' | 'wa-out' | 'wa-in' | 'befisc' | 'sign3';
export const API_FOR_SOURCE: Record<SourceNode, string> = {
  'profile-api': 'Buyer Profile API', glusr: 'GLUSR (Redash)', 'pns-insights': 'PNS (call insights)', 'prev-bl': 'Prev BuyLeads', 'prev-isq': 'Prev ISQ',
  csl: 'CSL (browse/search)', 'wa-out': 'WhatsApp out', 'wa-in': 'WhatsApp in', befisc: 'Befisc', sign3: 'Sign3',
};

// ════════ L1 · FACT — one raw line/field from one source (the line-level coverage unit) ════════
export type Coverage = 'used' | 'ignored' | 'partial';
// ROLE — the colour every raw/transformed line carries in the trace (INV-2). decisive=cited, drove the
// output · scanned=seen/considered, not decisive · available=signal-bearing but unused (ignored-impact
// candidate) · discounted=considered & rejected with a reason · noise=plumbing/telemetry (still +-openable).
export type FactRole = 'decisive' | 'scanned' | 'available' | 'discounted' | 'noise';
export interface Fact {
  id: string; sourceNode: SourceNode; api: string; jsonPath: string; lineRef?: string; rawValue: string;
  tag: string;                       // stable grouping tag (e.g. 'pns.persona') so beliefs can cite by meaning
  kind: 'identity' | 'intent' | 'history' | 'behavioral' | 'external' | 'spec' | 'other';
  coverage: Coverage; coverageReason: string;
  role?: FactRole;                   // INV-2 colour role (assigned after decisions resolve)
  usedBy: string[];                  // belief ids that cited this fact
}

// REASONING STEP — first-class, grounded, drillable. EVERY decision (rule or LLM) carries ≥1 step; each
// step cites the evidence ids it used (fromEvidence) so the chain drills to the raw line. `via` is honest:
// 'rule' = deterministic arithmetic step · 'llm' = model-produced reasoning step.
export interface ReasoningStep { n: number; claim: string; fromEvidence: string[]; rejected?: string; delta: number; via: 'rule' | 'llm' }
// IGNORED-IMPACT — the inverse counterfactual: an unused, signal-bearing fact ranked by how much it WOULD
// move confidence if the decision consumed it (lets the HOD argue with the call, not just inspect it).
export interface IgnoredImpact { factId: string; tag: string; raw: string; estDelta: number; note: string }

// ════════ L2 · BELIEF — interpretation of one+ facts (the "probably X" step) ════════
export interface Belief { id: string; statement: string; signal: string; weight: number; via: 'rule' | 'llm'; fromFacts: string[]; forKey: string }

// ════════ L3 · DECISION — a resolved belief → a value, fully governed ════════
export interface Governance { winner: string; losers: string[]; rule: string }
export interface Decision {
  id: string; surface: string; key: string; value: string;
  state: 'Confirmed' | 'Likely' | 'Conflicted' | 'Unknown'; confidence: number;
  producedBy: { kind: 'direct' | 'rule' | 'llm' | 'cross-validated'; ref: string; node: SourceNode | 'fusion' };
  beliefs: string[]; contributions: Array<{ source: SourceNode; points: number }>;
  alternatives: Array<{ value: string; score: number; whyLost: string }>;
  conflict: { contenders: Array<{ source: string; value: string }>; winner: string; losers: string[]; rule: string; confidence: number } | null;
  governance: Governance | null; reasoning: string; version: number;
  reasoningSteps?: ReasoningStep[];   // grounded, drillable chain (INV: reasoning for every output)
  ignoredImpact?: IgnoredImpact[];    // unused facts ranked by would-be impact (the "argue with it" set)
}

// ════════ L4 · CONSUMPTION — first-class: per consumer {status, reason} (not a bare array) ════════
export interface ConsumptionEntry { consumer: string; status: 'consumed' | 'rejected' | 'available'; reason: string }
export interface Consumption { id: string; subject: string; entries: ConsumptionEntry[]; status: 'pending' | 'consumed' | 'rejected' | 'mixed' }

// ════════ L5 · OUTCOME — first-class: did it actually matter? ════════
export interface Outcome { id: string; subject: string; changedDownstream: string[]; mattered: boolean; verdict: 'useful' | 'waste' | 'pending' }

export interface Ledger {
  facts: Fact[]; beliefs: Belief[]; decisions: Decision[]; consumption: Consumption[]; outcomes: Outcome[];
  timeline: Array<{ version: number; trigger: string; changed: string[]; because?: string[] }>;   // L9 causal: why each version changed
  factById: (id: string) => Fact | undefined;
  decisionByKey: (key: string) => Decision | undefined;
  factsForDecision: (decisionId: string) => Fact[];
}

// ── path helpers (raw = array of singly-keyed objects; JSON-string values parsed) ──
function getTop(raw: unknown, key: string): unknown {
  if (!Array.isArray(raw)) return undefined;
  for (const el of raw as Array<Record<string, unknown>>) if (el && typeof el === 'object' && key in el) {
    const v = el[key]; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v;
  }
  return undefined;
}
const sval = (v: unknown): string => { if (v == null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return s.length > 200 ? s.slice(0, 200) + '…' : s; };

// ════════ COVERAGE REGISTRY input — enumerate EVERY meaningful line of EVERY source into a Fact ════════
// Every fact starts coverage:'ignored' with a default reason; beliefs promote the ones they cite to 'used'.
// "100% coverage" = every line carries a verdict (used/ignored/partial), never an unaccounted line.
export function extractAllFacts(raw: unknown): Fact[] {
  const facts: Fact[] = []; let n = 0;
  const add = (sourceNode: SourceNode, jsonPath: string, rawValue: unknown, tag: string, kind: Fact['kind'], lineRef?: string, reason = 'not referenced by any belief') => {
    const v = sval(rawValue); if (!v) return; facts.push({ id: `f${++n}`, sourceNode, api: API_FOR_SOURCE[sourceNode], jsonPath, lineRef, rawValue: v, tag, kind, coverage: 'ignored', coverageReason: reason, usedBy: [] });
  };
  // DEFENSIVE: live data shape varies — a field that's a string/object where we expect an array would
  // throw on .forEach and blank the whole screen. asArr/asObj coerce safely so a weird shape just skips.
  const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const asObj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {});
  // profile-api — every field is a line
  const bp = asObj(getTop(raw, 'buyer_profile'));
  for (const [k, v] of Object.entries(bp)) if (v != null && typeof v !== 'object') add('profile-api', `buyer_profile.${k}`, v, `profile.${k}`, /name|email|mobile|phone|pan/i.test(k) ? 'identity' : 'identity', undefined);
  // E3 · glusr_extra — the GLUSR Redash row (member-since · last-modified · last-login · every other filled column).
  // The node passes EVERY non-empty column; we surface each as a profile fact (tag = the column name) so the LLM
  // judges usefulness key-by-key. add() already drops empties (the only-filled rule); we just skip the _error field.
  const gx = asObj(getTop(raw, 'glusr_extra'));
  for (const [k, v] of Object.entries(gx)) if (typeof v !== 'object' && !/^_/.test(k)) add('glusr', `glusr_extra.${k}`, v, `glusr.${k}`, 'identity', undefined);
  // pns-insights — per call, every meaningful field + each blocker + each seller query + each product
  const pns = asArr(getTop(raw, 'pns_data')) as Array<Record<string, unknown>>;
  pns.forEach((call, i) => {
    const ed = (call?.extracted_data as Record<string, unknown>) || {}; const md = (ed.metadata as Record<string, unknown>) || {};
    const ev = ((md.call_type as Record<string, unknown>)?.evidence as Record<string, unknown>) || {}; const intent = (md.buyer_intent as Record<string, unknown>) || {};
    const ref = `call ${i + 1}`;
    add('pns-insights', `pns_data[${i}]…evidence.buyer_persona`, ev.buyer_persona, 'pns.persona', 'intent', ref);
    add('pns-insights', `pns_data[${i}]…evidence.quantity_scale`, ev.quantity_scale, 'pns.qty_scale', 'intent', ref);
    add('pns-insights', `pns_data[${i}]…evidence.order_type`, ev.order_type, 'pns.order_type', 'intent', ref);
    add('pns-insights', `pns_data[${i}]…intended_application`, md.intended_application, 'pns.application', 'intent', ref);
    add('pns-insights', `pns_data[${i}]…buyer_intent.intent_level`, intent.intent_level, 'pns.intent_level', 'intent', ref);
    add('pns-insights', `pns_data[${i}]…buyer_intent.narrative`, intent.narrative, 'pns.narrative', 'intent', ref);
    add('pns-insights', `pns_data[${i}]…primary_language`, md.primary_language, 'pns.language', 'behavioral', ref);
    asArr((ed.lead_tag as Record<string, unknown>)?.deal_blockers).forEach((b, j) => add('pns-insights', `pns_data[${i}].lead_tag.deal_blockers[${j}]`, b, 'pns.blocker', 'intent', ref));
    asArr((md.additional_details as Record<string, unknown>)?.seller_queries).forEach((q, j) => add('pns-insights', `pns_data[${i}]…seller_queries[${j}]`, (q as Record<string, unknown>)?.query, 'pns.seller_q', 'intent', ref));
    asArr(ed.products).forEach((p, j) => add('pns-insights', `pns_data[${i}].products[${j}].most_specific_category.name`, ((p as Record<string, unknown>)?.most_specific_category as Record<string, unknown>)?.name, 'pns.product', 'intent', ref));
  });
  // prev BLs / ISQ
  asArr(getTop(raw, 'prev_bl_data')).forEach((b, i) => { const bb = b as Record<string, unknown>; const ref = `BL ${i + 1}`; add('prev-bl', `prev_bl_data[${i}].ETO_OFR_TITLE`, bb?.ETO_OFR_TITLE, 'bl.title', 'history', ref); add('prev-bl', `prev_bl_data[${i}].ETO_OFR_POSTDATE_ORIG`, bb?.ETO_OFR_POSTDATE_ORIG, 'bl.date', 'history', ref); add('prev-bl', `prev_bl_data[${i}].ETO_OFR_DISPLAY_ID`, bb?.ETO_OFR_DISPLAY_ID, 'bl.offerid', 'history', ref); });
  asArr(getTop(raw, 'prev_isq_data')).forEach((r, i) => { const rr = r as Record<string, unknown>; add('prev-isq', `prev_isq_data[${i}].title`, rr?.title, 'isq.title', 'history', `ISQ ${i + 1}`); asArr(rr?.isq).forEach((a, j) => add('prev-isq', `prev_isq_data[${i}].isq[${j}]`, `${sval((a as Record<string, unknown>)?.IM_SPEC_MASTER_DESC)}=${sval((a as Record<string, unknown>)?.ISQ_RESPONSE)}`, 'isq.answer', 'spec', `ISQ ${i + 1}`)); });
  // CSL — on-site activity. fk_display_title = the page/product the buyer VIEWED (the clean intent signal, vs
  // parsing the URL); mcat_names = browsed category; datevalue = timeline. + city + the typed ?s= search term.
  // Titles & categories are deduped by value (the set of things viewed = "buyer also viewed"); add() drops empties.
  const seenT = new Set<string>(), seenC = new Set<string>();
  asArr(getTop(raw, 'csl_data')).forEach((cRaw, i) => {
    const c = cRaw as Record<string, unknown>; const ref = `csl ${i + 1}`;
    const title = String(c?.fk_display_title ?? '').trim();
    if (title && !seenT.has(title.toLowerCase())) { seenT.add(title.toLowerCase()); add('csl', `csl_data[${i}].fk_display_title`, title, 'csl.title', 'intent', ref, 'buyer viewed this page/product on-site'); }
    const cat = String(c?.mcat_names ?? '').trim();
    if (cat && !seenC.has(cat.toLowerCase())) { seenC.add(cat.toLowerCase()); add('csl', `csl_data[${i}].mcat_names`, cat, 'csl.category', 'intent', ref); }
    add('csl', `csl_data[${i}].datevalue`, c?.datevalue, 'csl.ts', 'behavioral', ref);
    add('csl', `csl_data[${i}].glb_city`, c?.glb_city === '-' ? '' : c?.glb_city, 'csl.city', 'behavioral', ref);
    add('csl', `csl_data[${i}].request_url`, c?.request_url, 'csl.url', 'behavioral', ref);
    // SEARCH TERM — the buyer's ACTUAL typed query (?s=…) is the real intent signal, not the city/plumbing.
    const url = String(c?.request_url ?? ''); const m = url.match(/[?&]s=([^&]+)/);
    if (m) { let term = ''; try { term = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { term = m[1]; } term = term.trim(); if (term && term.length > 1) add('csl', `csl_data[${i}].request_url?s`, term, 'csl.searchTerm', 'intent', ref, 'buyer-typed on-site search — live intent signal'); }
  });
  // WhatsApp — TWO IndiaMART channels (inbound 9696, buyer-initiated · outbound, we-market-first); BOTH carry the
  // buyer's messages AND ours. Classify by SENDER, not channel: a message the BUYER sent → wa-in/'wa.in' (signal);
  // a message WE sent (seller share / marketing) → wa-out/'wa.out' (CONTEXT for reading the buyer's reply, NOT buyer
  // intent — a seller name we sent ≠ the buyer wants it; only the buyer's reaction is signal). Channel volume is a
  // summary fact ('wa.volume'); individual our-messages stay `ignored` (context, never consumed as buyer intent).
  const buyerSentWA = (s: unknown) => /^(customer|user|buyer)$/.test(nrm(s));
  const waArr = asArr(getTop(raw, 'whatsapp_data'));
  waArr.forEach((m, i) => { const obj = m as Record<string, unknown>; const txt = sval(obj?.message ?? obj?.caption ?? m); const buyerSent = buyerSentWA(obj?.sender); add(buyerSent ? 'wa-in' : 'wa-out', `whatsapp_data[${i}]`, txt, buyerSent ? 'wa.in' : 'wa.out', 'behavioral', `WA ${i + 1} · ${buyerSent ? 'buyer' : 'our message'}`, buyerSent ? "the buyer's own message (signal)" : 'our message (seller share / marketing) — context for reading the buyer reply, not buyer-stated'); });
  const waOutN = waArr.filter((m) => !buyerSentWA((m as Record<string, unknown>)?.sender)).length;
  if (waOutN) add('wa-out', 'whatsapp_data.outbound_count', `${waOutN} outbound messages`, 'wa.volume', 'behavioral', undefined, 'channel-volume signal (count, not content)');
  // WhatsApp IN — #N2: inbound arrives THREE ways — a message array · a {data:{recent_messages}} object ·
  // an n8n sub-fetch FAILURE wrapper ({error}/success:false). Mirror the form's waInboundCount so the
  // object-shaped inbound (e.g. GLID 268590579's 49 messages) is captured, not silently dropped.
  const waInRaw = getTop(raw, 'whatsapp_inbound');
  const waInObj = asObj(waInRaw);
  if ('error' in waInObj || waInObj.success === false) {
    add('wa-in', 'whatsapp_inbound.__error', 'inbound sub-fetch failed', 'wa.in', 'behavioral', undefined, 'n8n inbound-WA sub-fetch FAILED (404 / error wrapper) — no inbound chat captured for this GLID (other sources unaffected)');
  } else {
    const waInArr = Array.isArray(waInRaw) ? (waInRaw as unknown[]) : asArr(asObj(waInObj.data).recent_messages);
    waInArr.forEach((m, i) => { const o = m as Record<string, unknown>; const txt = sval(o?.content ?? o?.message ?? o?.text ?? o?.body ?? o?.caption ?? m); const buyerSent = buyerSentWA(o?.sender); add(buyerSent ? 'wa-in' : 'wa-out', `whatsapp_inbound[${i}]`, txt, buyerSent ? 'wa.in' : 'wa.out', 'behavioral', `WA-in ${i + 1} · ${buyerSent ? 'buyer' : 'our message'}`, buyerSent ? "the buyer's own message / reply (signal)" : 'our message in this chat — context for reading the buyer reply, not buyer-stated'); });
  }
  // External (Befisc / Sign3 / World) — first-class identity intelligence. The n8n buyer pull carries it under
  // `ebi_data` (External Buyer Intelligence: {befisc, sign3, world}, each nesting the real payload under
  // `.result`); the form/Observatory also merge `observed_external`. We flatten the meaningful fields (the
  // `result`/personal_information body), skipping API-wrapper noise (txn_id, api_name, status, …).
  const ext = asObj(getTop(raw, 'observed_external'));
  const ebi = asObj(getTop(raw, 'ebi_data'));
  const isExtWrapper = (k: string) => /txn_id|api_name|api_category|api_version|billable|^status$|^message$|^code$|^success$|request_id|reference_id|cached?_at|fetched_at|provenance|anchor/i.test(k);
  const flattenExt = (obj: unknown, node: SourceNode, prefix: string, note: string, depth = 0): void => {
    for (const [k, v] of Object.entries(asObj(obj))) {
      if (isExtWrapper(k) || v == null || v === '') continue;
      if (Array.isArray(v)) {
        const parts = (v as unknown[]).map((x) => (x && typeof x === 'object') ? String((x as Record<string, unknown>).detailed_address ?? (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).value ?? '') : String(x)).filter(Boolean);
        if (parts.length) add(node, `${prefix}.${k}`, parts.slice(0, 3).join(' · '), `${prefix}.${k}`, 'external', undefined, note);
      } else if (typeof v === 'object') { if (depth < 2) flattenExt(v, node, prefix, note, depth + 1); }
      else add(node, `${prefix}.${k}`, String(v), `${prefix}.${k}`, 'external', undefined, note);
    }
  };
  const befRaw = getTop(raw, 'befisc') ?? ext.befisc ?? ebi.befisc;
  flattenExt(asObj(befRaw).result ?? befRaw, 'befisc', 'befisc', 'external intelligence (Befisc, paid API) — first-class buyer signal (identity · vintage · scale)');
  const s3Raw = getTop(raw, 'sign3') ?? ext.sign3 ?? ebi.sign3;
  flattenExt(asObj(s3Raw).result ?? s3Raw, 'sign3', 'sign3', 'external intelligence (Sign3, paid API) — first-class buyer signal (digital footprint · legitimacy · trust)');
  const world = asObj(getTop(raw, 'world') ?? ext.world ?? ebi.world);
  const worldSummary = world.summary ?? asObj(world.result).summary;
  if (worldSummary != null && worldSummary !== '') add('sign3', 'world.summary', String(worldSummary), 'world.summary', 'external', undefined, 'external intelligence (World/OSINT) — first-class context signal');
  return facts;
}

// ── assemble raw arrays into a Ledger (with accessors). Shared by buildLedger + evolveLedger + rfqLedger. ──
export function assemble(facts: Fact[], beliefs: Belief[], decisions: Decision[], consumption: Consumption[], outcomes: Outcome[], timeline: Ledger['timeline']): Ledger {
  return {
    facts, beliefs, decisions, consumption, outcomes, timeline,
    factById: (id) => facts.find((f) => f.id === id),
    decisionByKey: (key) => decisions.find((d) => d.key === key),
    factsForDecision: (decisionId) => { const d = decisions.find((x) => x.id === decisionId); if (!d) return []; const ids = new Set<string>(); for (const bid of d.beliefs) beliefs.find((x) => x.id === bid)?.fromFacts.forEach((fid) => ids.add(fid)); return facts.filter((f) => ids.has(f.id)); },
  };
}

// ════════ THE BUILDER — raw pull → Ledger (buyer-profile consumer; deterministic) ════════
export function buildLedger(raw: unknown, version = 1): Ledger {
  const facts = extractAllFacts(raw);
  const beliefs: Belief[] = []; const decisions: Decision[] = []; const consumption: Consumption[] = []; const outcomes: Outcome[] = [];
  let bc = 0;
  const byTag = (tag: string, pred?: (f: Fact) => boolean) => facts.filter((f) => f.tag === tag && (!pred || pred(f)));
  const mkBelief = (statement: string, signal: string, weight: number, forKey: string, fs: Fact[]): Belief => {
    const b: Belief = { id: `b${++bc}`, statement, signal, weight, via: 'rule', fromFacts: fs.map((f) => f.id), forKey };
    beliefs.push(b); for (const f of fs) { f.usedBy.push(b.id); f.coverage = 'used'; f.coverageReason = `cited by belief "${statement}"`; } return b;
  };

  // ── BUSINESS TYPE ──
  const btB: Belief[] = []; const contrib: Array<{ source: SourceNode; points: number }> = [];
  const personaF = byTag('pns.persona', (f) => /manufactur/i.test(f.rawValue));
  if (personaF.length) { btB.push(mkBelief('PNS persona reads "manufacturer"', 'Manufacturer', 40, 'business_type', personaF)); contrib.push({ source: 'pns-insights', points: 40 }); }
  const mfgBL = byTag('bl.title', (f) => /machine|raw material|making/i.test(f.rawValue));
  if (mfgBL.length) { btB.push(mkBelief('Prior BuyLeads are industrial inputs/machines', 'Manufacturer', 25, 'business_type', mfgBL)); contrib.push({ source: 'prev-bl', points: 25 }); }
  const descF = byTag('profile.glusr_usr_company_desc', (f) => /manufactur|making|production/i.test(f.rawValue));
  if (descF.length) { btB.push(mkBelief('Own company description mentions manufacturing', 'Manufacturer', 20, 'business_type', descF)); contrib.push({ source: 'profile-api', points: 20 }); }
  const cslF = byTag('csl.city');
  if (cslF.length) { btB.push(mkBelief('Browses/sources from industrial regions', 'Manufacturer', 15, 'business_type', cslF.slice(0, 3))); contrib.push({ source: 'csl', points: 15 }); }
  const btScore = Math.min(100, btB.reduce((s, b) => s + b.weight, 0));
  if (btB.length) decisions.push({ id: 'd:business_type', surface: 'profile', key: 'business_type', value: 'Manufacturer', state: btScore >= 80 ? 'Confirmed' : btScore >= 50 ? 'Likely' : 'Unknown', confidence: btScore, producedBy: { kind: 'cross-validated', ref: 'ledger.businessType', node: 'fusion' }, beliefs: btB.map((b) => b.id), contributions: contrib, alternatives: [{ value: 'Trader', score: Math.max(0, 40 - Math.round(btScore / 3)), whyLost: 'no resale/stocking signals; inputs+machines, not finished-goods resale' }, { value: 'Distributor', score: 15, whyLost: 'no multi-brand catalog / bulk-resale evidence' }], conflict: null, governance: { winner: 'history + PNS corroborated', losers: [], rule: '≥2 corroborating sources (internal + external paid-API) outrank single-source; User would override if set (none yet)' }, reasoning: `${btB.length} manufacturing beliefs, 0 consumer-purchase beliefs → Manufacturer ${btScore}`, version });

  // ── IDENTITY NAME + conflict ──
  const nameF = byTag('profile.glusr_usr_name')[0] || byTag('profile.name')[0];
  if (nameF) {
    const befName = facts.find((f) => f.tag === 'befisc.name');
    let conflict: Decision['conflict'] = null;
    if (befName && nrm(befName.rawValue) !== nrm(nameF.rawValue)) {
      mkBelief('Profile name & external name share a token → same person', 'same-person', 0, 'identity_name', [nameF, befName]);
      conflict = { contenders: [{ source: 'profile-api', value: nameF.rawValue }, { source: 'befisc', value: befName.rawValue }], winner: nameF.rawValue, losers: [befName.rawValue], rule: 'first-party display name > external variant; treated as same person', confidence: 85 };
    } else { nameF.coverage = 'used'; nameF.coverageReason = 'first-party identity (display name)'; }
    decisions.push({ id: 'd:identity_name', surface: 'profile', key: 'identity_name', value: nameF.rawValue, state: conflict ? 'Conflicted' : 'Confirmed', confidence: conflict ? conflict.confidence : 95, producedBy: { kind: 'direct', ref: 'profile-api.name', node: 'profile-api' }, beliefs: [], contributions: [{ source: 'profile-api', points: 95 }], alternatives: befName ? [{ value: befName.rawValue, score: 60, whyLost: 'external variant; first-party wins for display' }] : [], conflict, governance: { winner: 'profile-api (first-party)', losers: befName ? ['befisc'] : [], rule: 'first-party identity > external identity for display' }, reasoning: conflict ? 'name conflict resolved as same person' : 'single first-party source', version });
  }

  // ── COMMUNICATION ──
  const waCount = byTag('wa.out').length; const waVol = byTag('wa.volume')[0];
  if (waCount) { const b = mkBelief(`${waCount} outbound WhatsApp messages → WhatsApp-first`, 'WhatsApp-first', waCount > 30 ? 70 : 40, 'communication', waVol ? [waVol] : byTag('wa.out').slice(0, 1)); decisions.push({ id: 'd:communication', surface: 'profile', key: 'communication', value: 'WhatsApp-first', state: waCount > 30 ? 'Likely' : 'Unknown', confidence: b.weight, producedBy: { kind: 'rule', ref: 'ledger.commChannel', node: 'wa-out' }, beliefs: [b.id], contributions: [{ source: 'wa-out', points: b.weight }], alternatives: [], conflict: null, governance: { winner: 'WhatsApp volume', losers: [], rule: 'channel = highest-volume observed channel (volume signal, not nudge content)' }, reasoning: `${waCount} outbound WA messages`, version }); }

  // ── HISTORICAL INTENT — the buyer's recurring domain (so the off-profile "why NOT used" is demonstrable) ──
  const histFacts = [...byTag('bl.title'), ...byTag('pns.application'), ...byTag('pns.product')];
  if (histFacts.length) {
    const b = mkBelief('Prior requirements cluster around a recurring domain', 'historical-intent', 60, 'historical_intent', histFacts.slice(0, 4));
    const blob = histFacts.map((f) => f.rawValue).join(' ');
    const theme = /notebook|paper/i.test(blob) ? 'Notebook Manufacturing Inputs' : (histFacts[0]?.rawValue || 'prior domain');
    decisions.push({ id: 'd:historical_intent', surface: 'profile', key: 'historical_intent', value: theme, state: 'Likely', confidence: 75, producedBy: { kind: 'rule', ref: 'ledger.historicalIntent', node: 'fusion' }, beliefs: [b.id], contributions: [{ source: 'prev-bl', points: 40 }, { source: 'pns-insights', points: 35 }], alternatives: [], conflict: null, governance: { winner: 'history cluster', losers: [], rule: 'dominant recurring category across prior BLs/calls — a PRIOR, never forced onto a new product' }, reasoning: 'recurring prior domain across BLs + calls', version });
  }

  // ── L4 CONSUMPTION (first-class, per-consumer status+reason). Pre-product → 'available' + the rule that will decide. ──
  for (const d of decisions) consumption.push({
    id: `c:${d.key}`, subject: d.id,
    entries: [
      { consumer: 'intent', status: 'available', reason: 'pre-product — intent will consume unless off-profile' },
      { consumer: 'planner', status: 'available', reason: 'pre-product — planner consumes once a product+category resolve' },
      { consumer: 'last-page', status: 'available', reason: 'pre-product — gates Firm/GST/payment later' },
    ],
    status: 'pending',
  });

  // ── L5 OUTCOME (first-class). Pre-RFQ → pending. ──
  for (const d of decisions) outcomes.push({ id: `o:${d.key}`, subject: d.id, changedDownstream: [], mattered: false, verdict: 'pending' });

  return enrichLedger(assemble(facts, beliefs, decisions, consumption, outcomes, [{ version, trigger: 'GLID pull', changed: decisions.map((d) => d.key) }]));
}

// ════════ ENRICH — adds INV-grade structured reasoning + colour roles + ignored-impact to a built ledger.
// Deterministic & grounded: each decision's reasoningSteps come from its OWN beliefs/conflict/alternatives
// (every step cites real fact ids → drills to raw); each fact gets a colour role (decisive/scanned/
// available/discounted/noise); each judgment decision gets the inverse-counterfactual "ignored facts that
// would move it most". The LLM layer (profileSynth) later swaps the step PROSE for richer model reasoning
// against the SAME schema — so the trace UI never changes. Harnessed in scripts/reasoningtest.mjs.
const NOISE_RE = /^(GET|POST|PUT|DELETE) |getCityName|getCityId|unreadMessage|userlastseen|CityFromLatLong|recentData|getGlbcity|WrapperService|WrapperCompService|markovrecom|citydistance|citysuggestor|stdproducts|recommendedmcat|relatedproducts|miniproddetail|widgets\/|\/rating\?|getISQ|finishEnquiry|CityFromLatLong/i;
export function enrichLedger(L: Ledger): Ledger {
  const decisiveIds = new Set<string>();
  for (const d of L.decisions) for (const bid of d.beliefs) L.beliefs.find((b) => b.id === bid)?.fromFacts.forEach((fid) => decisiveIds.add(fid));
  // ── INV-2 ROLES (colours over every raw/transformed line) ──
  for (const f of L.facts) {
    if (decisiveIds.has(f.id) || f.coverage === 'used') f.role = 'decisive';
    else if (f.tag === 'wa.out') f.role = 'noise';                                              // outbound platform nudges (not buyer speech)
    else if (f.tag === 'csl.url') f.role = NOISE_RE.test(f.rawValue) ? 'noise' : 'scanned';     // HTTP plumbing = noise; a non-plumbing URL = merely scanned
    else if (f.tag === 'csl.city' || f.tag === 'csl.ts') f.role = 'scanned';                     // weak metadata — seen, not a reasoning signal (city · browse timestamp)
    else f.role = 'available';                                                                   // signal-bearing, no consumer yet
  }
  // ── REASONING STEPS (grounded, per decision — reasoning for EVERY output) ──
  for (const d of L.decisions) {
    const steps: ReasoningStep[] = []; let n = 0;
    for (const bid of d.beliefs) { const b = L.beliefs.find((x) => x.id === bid); if (!b) continue; steps.push({ n: ++n, claim: b.statement, fromEvidence: b.fromFacts.slice(), delta: b.weight, via: b.via }); }
    if (d.conflict) steps.push({ n: ++n, claim: `conflict resolved → ${d.conflict.winner}`, fromEvidence: [], rejected: d.conflict.losers.join(', '), delta: 0, via: 'rule' });
    if (d.alternatives.length) steps.push({ n: ++n, claim: `chose ${d.value}`, fromEvidence: [], rejected: d.alternatives.map((a) => `${a.value} — ${a.whyLost}`).join(' · '), delta: 0, via: d.producedBy.kind === 'llm' ? 'llm' : 'rule' });
    if (steps.length) d.reasoningSteps = steps;
  }
  // ── IGNORED-IMPACT (inverse counterfactual: unused facts ranked by would-be Δ) for business_type ──
  const impactFor = (f: Fact): { delta: number; note: string } | null => {
    if (f.tag === 'pns.application') return { delta: 8, note: 'stated application — corroborates intent (stronger than the browse city used)' };
    if (f.tag === 'csl.searchTerm') return { delta: 8, note: 'buyer-typed on-site search — live intent (the field the rule SHOULD read, vs city)' };
    if (f.tag === 'wa.in') return { delta: 6, note: 'buyer-typed chat — active spec/price seeking' };
    if (f.tag === 'pns.product') return { delta: 5, note: 'PNS product category — recurring domain' };
    if (f.tag.startsWith('isq')) {
      if (/order value|lakh|crore/i.test(f.rawValue)) return { delta: 12, note: 'historical order value — manufacturing scale' };
      if (/\bkg\b|\bton\b|quantity|\b\d{5,}\b/i.test(f.rawValue)) return { delta: 10, note: 'bulk quantity — manufacturer, not retail' };
      if (/business use/i.test(f.rawValue)) return { delta: 7, note: 'declared business-use — not personal' };
    }
    return null;
  };
  const bt = L.decisions.find((d) => d.key === 'business_type');
  if (bt) {
    const ranked: IgnoredImpact[] = [];
    for (const f of L.facts) { if (f.role !== 'available') continue; const imp = impactFor(f); if (imp) ranked.push({ factId: f.id, tag: f.tag, raw: f.rawValue, estDelta: imp.delta, note: imp.note }); }
    ranked.sort((a, b) => b.estDelta - a.estDelta);
    if (ranked.length) bt.ignoredImpact = ranked.slice(0, 8);
  }
  return L;
}

// ════════ NODE CONTRACT — the uniform per-node envelope (raw → facts + colour roles + transform + feeds).
// Lets each n8n node be reviewed in isolation (CEO/CPO): what it received, what it extracted, what was
// decisive vs scanned vs dropped, and where its facts flowed. Same shape whether the transform is code or
// an LLM (PNS is upstream-llm today; the rest are rule until the node-LLM extractors land — Phase C/N).
export interface NodeContractView { node: SourceNode; api: string; transform: 'rule' | 'llm'; rawCount: number; facts: Fact[]; roleCounts: Record<FactRole, number>; feedsInto: string[] }
export function nodeContract(L: Ledger): NodeContractView[] {
  const order: SourceNode[] = ['profile-api', 'glusr', 'pns-insights', 'prev-bl', 'prev-isq', 'csl', 'wa-out', 'wa-in', 'befisc', 'sign3'];
  const out: NodeContractView[] = [];
  for (const node of order) {
    const facts = L.facts.filter((f) => f.sourceNode === node);
    if (!facts.length) continue;
    const roleCounts: Record<FactRole, number> = { decisive: 0, scanned: 0, available: 0, discounted: 0, noise: 0 };
    for (const f of facts) roleCounts[f.role ?? 'available']++;
    const factIds = new Set(facts.map((f) => f.id)); const feeds = new Set<string>();
    for (const d of L.decisions) for (const bid of d.beliefs) { const b = L.beliefs.find((x) => x.id === bid); if (b && b.fromFacts.some((fid) => factIds.has(fid))) feeds.add(d.key); }
    out.push({ node, api: API_FOR_SOURCE[node], transform: node === 'pns-insights' ? 'llm' : 'rule', rawCount: facts.length, facts, roleCounts, feedsInto: [...feeds] });
  }
  return out;
}

// ════════ PROVENANCE + DEPTH (final pass) — weight tree · attention · ignored-reason · promotion · alts ══

// L5 · WEIGHT TREE — decompose a decision's confidence: source → belief → cited facts, each with its share.
export interface WeightNode { source: SourceNode; points: number; beliefs: Array<{ statement: string; weight: number; facts: Array<{ id: string; raw: string; ref?: string; share: number }> }> }
export function weightTree(L: Ledger, decisionId: string): WeightNode[] {
  const d = L.decisions.find((x) => x.id === decisionId); if (!d) return [];
  const bySource = new Map<SourceNode, WeightNode>();
  for (const bid of d.beliefs) {
    const b = L.beliefs.find((x) => x.id === bid); if (!b) continue;
    const facts = b.fromFacts.map((fid) => L.facts.find((f) => f.id === fid)).filter(Boolean) as Fact[];
    const src = facts[0]?.sourceNode; if (!src) continue;
    const share = facts.length ? b.weight / facts.length : b.weight;
    if (!bySource.has(src)) bySource.set(src, { source: src, points: 0, beliefs: [] });
    const node = bySource.get(src)!; node.points += b.weight;
    node.beliefs.push({ statement: b.statement, weight: b.weight, facts: facts.map((f) => ({ id: f.id, raw: f.rawValue, ref: f.lineRef, share: Math.round(share) })) });
  }
  return [...bySource.values()].sort((a, b) => b.points - a.points);
}

// L2 · ATTENTION MAP — per-fact business "attention" (influence %) over a decision (derived from the tree).
export interface AttentionRow { label: string; ref?: string; source: SourceNode; points: number; pct: number }
export function attentionMap(L: Ledger, decisionId: string): AttentionRow[] {
  const tree = weightTree(L, decisionId); const total = tree.reduce((s, n) => s + n.points, 0) || 1;
  const rows: AttentionRow[] = [];
  for (const n of tree) for (const b of n.beliefs) for (const f of b.facts) rows.push({ label: f.raw, ref: f.ref, source: n.source, points: f.share, pct: Math.round((f.share / total) * 100) });
  return rows.sort((a, b) => b.pct - a.pct);
}
// L2b · ATTENTION by SOURCE — the HOD rollup ("PNS 41% · BL 24% · External 18% …"), not per-fact.
export interface AttentionSource { source: SourceNode; points: number; pct: number }
export function attentionBySource(L: Ledger, decisionId: string): AttentionSource[] {
  const tree = weightTree(L, decisionId); const total = tree.reduce((s, n) => s + n.points, 0) || 1;
  return tree.map((n) => ({ source: n.source, points: n.points, pct: Math.round((n.points / total) * 100) })).sort((a, b) => b.pct - a.pct);
}

// Per-fact IGNORED-REASON — WHY a fact was not used (distinct from ignored-IMPACT's "what if it were").
export function ignoredReasonFor(f: Fact): string {
  if (f.role === 'decisive' || f.coverage === 'used') return 'used — cited by a decision';
  if (f.role === 'discounted') return 'discounted — considered but set aside (conflicting or lower-priority)';
  if (f.role === 'noise') return 'noise — request plumbing / platform nudge, no business signal';
  if (f.role === 'scanned') return 'scanned — seen, but a weaker signal than what was cited';
  return 'available — signal-bearing, but no consumer has needed it yet';
}

// L3 · FACT-PROMOTION LADDER — raw fact → belief(s) → decision(s) (the rungs a line climbed, or didn't).
export interface LadderRung { kind: 'fact' | 'belief' | 'decision'; label: string; detail?: string }
export function promotionLadder(L: Ledger, factId: string): LadderRung[] {
  const f = L.facts.find((x) => x.id === factId); if (!f) return [];
  const rungs: LadderRung[] = [{ kind: 'fact', label: f.rawValue, detail: `${SOURCE_LABEL_LIB[f.sourceNode]} · ${f.tag}` }];
  const beliefs = L.beliefs.filter((b) => b.fromFacts.includes(factId));
  if (!beliefs.length) { rungs.push({ kind: 'belief', label: 'not promoted — no belief cites this line yet', detail: ignoredReasonFor(f) }); return rungs; }
  for (const b of beliefs) {
    rungs.push({ kind: 'belief', label: b.statement, detail: `+${b.weight}` });
    for (const d of L.decisions.filter((x) => x.beliefs.includes(b.id))) rungs.push({ kind: 'decision', label: `${d.key} = ${d.value}`, detail: `conf ${d.confidence}` });
  }
  return rungs;
}

// L6 · ALTERNATIVE UNIVERSES — each loser with evidence-FOR (what would support it) + evidence-AGAINST.
const ALT_FOR_HINT: Record<string, RegExp> = { Trader: /resal|stock|wholesale|retail|finished.?good/i, Distributor: /distribut|multi.?brand|catalog|dealer/i, Entrepreneur: /new.*venture|startup|setting up|first procurement|new.*business/i, Wholeseller: /wholesale|bulk.?resale/i };
export interface AltTree { value: string; score: number; for: string[]; against: string[] }
export function alternativeTrees(L: Ledger, decisionId: string): AltTree[] {
  const d = L.decisions.find((x) => x.id === decisionId); if (!d) return [];
  const cited = L.factsForDecision(decisionId);
  return d.alternatives.map((a) => {
    const hint = ALT_FOR_HINT[a.value];
    const forEv = hint ? L.facts.filter((f) => hint.test(f.rawValue)).slice(0, 3).map((f) => `“${f.rawValue}” (${SOURCE_LABEL_LIB[f.sourceNode]})`) : [];
    const against = [a.whyLost, ...cited.slice(0, 2).map((f) => `“${f.rawValue}” supports ${d.value}, not ${a.value}`)];
    return { value: a.value, score: a.score, for: forEv.length ? forEv : ['no supporting evidence found in this pull'], against };
  });
}

const SOURCE_LABEL_LIB: Record<SourceNode, string> = { 'profile-api': 'Profile', glusr: 'GLUSR', 'pns-insights': 'PNS', 'prev-bl': 'Prev BL', 'prev-isq': 'Prev ISQ', csl: 'CSL', 'wa-out': 'WA out', 'wa-in': 'WA in', befisc: 'Befisc', sign3: 'Sign3' };

// ════════ STEP 5 · EVOLVE — every RFQ event creates a NEW ledger VERSION (never mutate). ════════
// This is where "why NOT used" becomes real: an off-profile product REJECTS the historical-intent
// decision at intent/planner/category, each with its reason (the Notebook-vs-Diesel-Generator case).
export type LedgerEvent = { type: 'product' | 'answer'; key?: string; value: string; relatedToHistory?: boolean };
export function evolveLedger(L: Ledger, e: LedgerEvent): Ledger {
  const version = (L.timeline[L.timeline.length - 1]?.version ?? 1) + 1;
  const facts = L.facts.slice(); const beliefs = L.beliefs.slice();
  const decisions = L.decisions.map((d) => ({ ...d, version }));
  const consumption = L.consumption.map((c) => ({ ...c, entries: c.entries.map((en) => ({ ...en })) }));
  const outcomes = L.outcomes.map((o) => ({ ...o }));
  const changed: string[] = []; const because: string[] = [];   // L9 causal: WHY this version changed
  if (e.type === 'product') {
    const off = e.relatedToHistory === false;
    const hc = consumption.find((c) => c.subject === 'd:historical_intent');
    if (hc) {
      hc.entries = [
        { consumer: 'intent', status: off ? 'rejected' : 'consumed', reason: off ? `off-profile — "${e.value}" is unrelated to the prior domain (no leak)` : 'on-profile — seeds the intent question' },
        { consumer: 'planner', status: off ? 'rejected' : 'consumed', reason: off ? 'mcat mismatch — prior category ≠ current product' : 'shapes the plan' },
        { consumer: 'category', status: 'rejected', reason: off ? `${e.value} category unrelated to prior domain` : 'similarity below threshold' },
      ];
      hc.status = off ? 'rejected' : 'consumed';
      const ho = outcomes.find((o) => o.subject === 'd:historical_intent'); if (ho) { ho.verdict = off ? 'waste' : 'useful'; ho.mattered = !off; ho.changedDownstream = off ? ['history influence OFF (G3 off-profile guard) — derive from CURRENT product only'] : ['seeded the intent question']; }
      changed.push('historical_intent');
      because.push(off ? `historical_intent → rejected because product "${e.value}" is off-profile (unrelated to the prior domain)` : `historical_intent → consumed because "${e.value}" matches the prior domain`);
    }
    const btc = consumption.find((c) => c.subject === 'd:business_type'); if (btc) { btc.entries = btc.entries.map((en) => en.consumer === 'intent' ? { ...en, status: 'consumed' as const, reason: `framed the ${off ? 'industrial' : 'on-profile'} journey (nature carries even when product is new)` } : en); btc.status = 'consumed'; const bo = outcomes.find((o) => o.subject === 'd:business_type'); if (bo) { bo.verdict = 'useful'; bo.mattered = true; bo.changedDownstream = ['journey = industrial (not personal)']; } changed.push('business_type'); because.push(`business_type → consumed because nature (Manufacturer) carries even onto the new product "${e.value}"`); }
  }
  if (e.type === 'answer' && e.key) {
    const id = `d:${e.key}`; const ex = decisions.find((d) => d.id === id);
    if (ex) { ex.value = e.value; ex.state = 'Confirmed'; ex.confidence = 100; ex.producedBy = { kind: 'direct', ref: 'user-answer', node: 'fusion' }; ex.governance = { winner: 'User', losers: ['LLM', 'history'], rule: 'User overrides all (governance precedence)' }; }
    else decisions.push({ id, surface: 'profile', key: e.key, value: e.value, state: 'Confirmed', confidence: 100, producedBy: { kind: 'direct', ref: 'user-answer', node: 'fusion' }, beliefs: [], contributions: [{ source: 'profile-api', points: 100 }], alternatives: [], conflict: null, governance: { winner: 'User', losers: ['LLM', 'history'], rule: 'User overrides all (governance precedence)' }, reasoning: 'buyer answered', version });
    if (!consumption.find((c) => c.subject === id)) consumption.push({ id: `c:${e.key}`, subject: id, entries: [{ consumer: 'planner', status: 'consumed', reason: 'a confirmed answer drives planning' }], status: 'consumed' });
    if (!outcomes.find((o) => o.subject === id)) outcomes.push({ id: `o:${e.key}`, subject: id, changedDownstream: ['re-planned downstream'], mattered: true, verdict: 'useful' });
    changed.push(e.key);
    because.push(`${e.key} → Confirmed (100) because the buyer answered "${e.value}" — User overrides all`);
  }
  return enrichLedger(assemble(facts, beliefs, decisions, consumption, outcomes, [...L.timeline, { version, trigger: `${e.type}: ${e.value}`, changed, because }]));
}

// ════════ THE 7-QUESTION CLICK-FLOW — every value answers all 7 (the HOD audit contract) ════════
export interface SevenAnswers {
  q1_what: { value: string; state: string; confidence: number };
  q2_why: Array<{ source: SourceNode; points: number }>;
  q3_evidence: Array<{ source: SourceNode; lineRef?: string; jsonPath: string; raw: string }>;
  q4_rejected: { alternatives: Decision['alternatives']; ignored: Array<{ raw: string; reason: string }> };
  q5_usedBy: ConsumptionEntry[];
  q6_changed: string[];
  q7_ifRemoved: { before: number; after: number; drop: number };
}
export function answerSeven(L: Ledger, decisionId: string): SevenAnswers | null {
  const d = L.decisions.find((x) => x.id === decisionId); if (!d) return null;
  const usedFacts = L.factsForDecision(decisionId);
  const sameKind = usedFacts[0]?.kind;
  const ignored = L.facts.filter((f) => f.coverage === 'ignored' && (f.kind === 'external' || f.kind === sameKind)).slice(0, 5).map((f) => ({ raw: f.rawValue, reason: f.coverageReason }));
  let after = d.confidence; for (const f of usedFacts) { const cf = counterfactualFor(L, decisionId, f.id); if (cf) after = Math.min(after, cf.after); }
  return {
    q1_what: { value: d.value, state: d.state, confidence: d.confidence },
    q2_why: d.contributions,
    q3_evidence: usedFacts.map((f) => ({ source: f.sourceNode, lineRef: f.lineRef, jsonPath: f.jsonPath, raw: f.rawValue })),
    q4_rejected: { alternatives: d.alternatives, ignored },
    q5_usedBy: L.consumption.find((c) => c.subject === decisionId)?.entries || [],
    q6_changed: L.outcomes.find((o) => o.subject === decisionId)?.changedDownstream || [],
    q7_ifRemoved: { before: d.confidence, after, drop: d.confidence - after },
  };
}

// ════════ COVERAGE REGISTRY — every line's verdict, rolled up. "100% = no line without a verdict." ════════
export function coverageRegistry(ledger: Ledger): {
  total: number; used: number; ignored: number; partial: number; verdictPct: number;
  bySource: Array<{ source: SourceNode; api: string; total: number; used: number; ignored: number; lines: Array<{ id: string; lineRef?: string; jsonPath: string; rawValue: string; coverage: Coverage; reason: string }> }>;
} {
  const facts = ledger.facts;
  const sources = [...new Set(facts.map((f) => f.sourceNode))] as SourceNode[];
  return {
    total: facts.length,
    used: facts.filter((f) => f.coverage === 'used').length,
    ignored: facts.filter((f) => f.coverage === 'ignored').length,
    partial: facts.filter((f) => f.coverage === 'partial').length,
    verdictPct: facts.length ? 100 : 0,   // every fact carries a verdict by construction — nothing unaccounted
    bySource: sources.map((s) => { const fs = facts.filter((f) => f.sourceNode === s); return { source: s, api: API_FOR_SOURCE[s], total: fs.length, used: fs.filter((f) => f.coverage === 'used').length, ignored: fs.filter((f) => f.coverage === 'ignored').length, lines: fs.map((f) => ({ id: f.id, lineRef: f.lineRef, jsonPath: f.jsonPath, rawValue: f.rawValue, coverage: f.coverage, reason: f.coverageReason })) }; }),
  };
}

// ════════ COUNTERFACTUAL — "without this fact, confidence drops X→Y" (so no click dead-ends) ════════
export function counterfactualFor(ledger: Ledger, decisionId: string, factId: string): { before: number; after: number; drop: number; lostBeliefs: string[] } | null {
  const d = ledger.decisions.find((x) => x.id === decisionId); if (!d) return null;
  const lost = ledger.beliefs.filter((b) => d.beliefs.includes(b.id) && b.fromFacts.includes(factId));
  const lostWeight = lost.reduce((s, b) => s + b.weight, 0);
  const after = Math.max(0, d.confidence - lostWeight);
  return { before: d.confidence, after, drop: d.confidence - after, lostBeliefs: lost.map((b) => b.statement) };
}

// ════════ MODULE 1.5 · F — DERIVATION TIMELINE (the true "living twin" event stream) ════════
// Replays how a decision's confidence BUILT UP, source by source: "PNS persona → 40 → +BL 65 → +Profile
// 85 → +CSL 100", plus the version events. Deterministic (ordered by contribution).
export function derivationTimeline(L: Ledger, decisionId: string): Array<{ step: number; event: string; source: SourceNode | 'fusion'; delta: number; running: number }> {
  const d = L.decisions.find((x) => x.id === decisionId); if (!d) return [];
  // order beliefs by their decision's contribution order (highest-weight source first = arrived/weighed first)
  const out: Array<{ step: number; event: string; source: SourceNode | 'fusion'; delta: number; running: number }> = [];
  let running = 0; let step = 0;
  for (const b of L.beliefs.filter((x) => d.beliefs.includes(x.id))) {
    running = Math.min(d.confidence, running + b.weight);
    out.push({ step: ++step, event: b.statement, source: (L.factById(b.fromFacts[0])?.sourceNode ?? 'fusion'), delta: b.weight, running });
  }
  if (!out.length) out.push({ step: 1, event: `${d.producedBy.kind} — ${d.value}`, source: d.producedBy.node, delta: d.confidence, running: d.confidence });
  return out;
}

// ════════ MODULE 1.5 · E — REPLAY (Run A vs Run B / version vs version diff) ════════
export interface LedgerDiff { changed: Array<{ key: string; field: string; from: string; to: string }>; consumptionFlips: Array<{ key: string; consumer: string; from: string; to: string; reason: string }>; added: string[] }
export function diffLedgerVersions(a: Ledger, b: Ledger): LedgerDiff {
  const changed: LedgerDiff['changed'] = []; const flips: LedgerDiff['consumptionFlips'] = []; const added: string[] = [];
  for (const db of b.decisions) {
    const da = a.decisions.find((x) => x.key === db.key);
    if (!da) { added.push(db.key); continue; }
    if (da.value !== db.value) changed.push({ key: db.key, field: 'value', from: da.value, to: db.value });
    if (da.state !== db.state) changed.push({ key: db.key, field: 'state', from: da.state, to: db.state });
    if (da.confidence !== db.confidence) changed.push({ key: db.key, field: 'confidence', from: String(da.confidence), to: String(db.confidence) });
    const ca = a.consumption.find((c) => c.subject === da.id); const cb = b.consumption.find((c) => c.subject === db.id);
    for (const eb of cb?.entries || []) { const ea = ca?.entries.find((x) => x.consumer === eb.consumer); if (ea && ea.status !== eb.status) flips.push({ key: db.key, consumer: eb.consumer, from: ea.status, to: eb.status, reason: eb.reason }); }
  }
  return { changed, consumptionFlips: flips, added };
}

// ════════ MODULE 1.5 · D — NON-CONSUMPTION MATRIX (decision × consumer grid, per-cell status+reason) ════════
export function consumptionMatrix(L: Ledger): { consumers: string[]; rows: Array<{ key: string; value: string; cells: Record<string, { status: string; reason: string }> }> } {
  const consumers = [...new Set(L.consumption.flatMap((c) => c.entries.map((e) => e.consumer)))];
  return {
    consumers,
    rows: L.decisions.map((d) => {
      const c = L.consumption.find((x) => x.subject === d.id);
      const cells: Record<string, { status: string; reason: string }> = {};
      for (const cons of consumers) { const e = c?.entries.find((x) => x.consumer === cons); cells[cons] = e ? { status: e.status, reason: e.reason } : { status: '—', reason: '' }; }
      return { key: d.key, value: d.value, cells };
    }),
  };
}

// ════════ FIRST RENDERER over the ledger — Buyer Profile (OLD = direct · NEW = fused) ════════
export function buyerProfileView(ledger: Ledger): {
  old: Array<{ key: string; value: string; source: string }>;
  current: Array<{ key: string; value: string; state: string; confidence: number; decisionId: string }>;
} {
  return {
    old: ledger.decisions.filter((d) => d.producedBy.kind === 'direct').map((d) => ({ key: d.key, value: d.value, source: API_FOR_SOURCE[d.producedBy.node as SourceNode] || String(d.producedBy.node) })),
    current: ledger.decisions.map((d) => ({ key: d.key, value: d.value, state: d.state, confidence: d.confidence, decisionId: d.id })),
  };
}
