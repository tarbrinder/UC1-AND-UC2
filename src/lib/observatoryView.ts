// ─── OBSERVATORY VIEW (P1 adapter) — makes observatory.ts + qualityGates.ts CONSUMED, not dead code ──
// PURE · deterministic · NO LLM · NO infra. Turns the form's live InspectorState (what V4 already
// computes) + a few raw form fields into (a) the Decision Ledger and (b) one InspectorPayload whose
// sections ARE the answers to the canonical trust/value/governance questions (L11–L20) plus the
// bl_quality deterministic gates (P0.5). The AIInspector renders it with the SAME <Body> renderer —
// zero new rendering code. Each section is tagged with the Q-number(s) it answers so none goes missing.
//
// Honesty rule (kept from the whole project): where a true answer needs OUTCOME telemetry we don't have
// yet (L13 "was the question wasteful", L19 prediction-vs-outcome), the row is labelled STRUCTURAL /
// PREDICTED — never presented as a measured outcome. E2 replay + L19 closed-loop are infra-gated.

import type { InspectorPayload, InspectorSection, InspectorRow, InspectorState, Tone } from './inspectorData';
import {
  createLedger, type Decision, type Ledger,
  PRECEDENCE, resolveConflict, readyVerdict, riskProfile, safeguardsFired, type Safeguard,
  nonConsumptionMatrix, answerImpact,
  evidenceSufficiency, robustness, confidenceFormula,
  dependencyImpact, deterministicVsAI, sourceROI, costPerUse, topImpact, impactDiff,
} from './observatory';
import { detectPII, extractGSTIN, looksLikeSeller, productNameQuality, absurdQuantity, orderValue } from './qualityGates';
import { allLineage } from './lineage';
import { diffRuns, type RunSnapshot } from './replay';
import { deepSections, type TwinLike, type RequirementLike, type OutcomeLike } from './observatoryDeep';

const nrm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ── the raw form fields the gates need, on top of the already-computed InspectorState ──
export interface ObservatoryInput {
  state: InspectorState;
  productName?: string;
  categoryName?: string;
  quantity?: number;
  unit?: string;
  freeText?: string;            // requirementNotes (+ voice transcript) — scanned for PII / seller-intent / GSTIN
  productPrices?: string[];     // any price strings the buyer saw (for the price-as-qty rule)
  mcatMedianPrice?: number;     // category median (POV) — optional; gate degrades gracefully if absent
  mcatQ1?: number; mcatQ3?: number;
  gstOnFile?: boolean; companyOnFile?: boolean;
  serverTrace?: ServerTrace | null;  // n8n E1 `_trace` from the buyer-pull response (null when E1 inactive)
  raw?: unknown;                     // the buyer-pull raw JSON — for the fact→JSON-path→node lineage (P1)
  llmRaw?: Record<string, { input?: string; output?: string; at: number }>;  // raw prompt I/O per call (P2)
  runs?: RunSnapshot[];              // persisted run snapshots — for Replay A↔B diff (P5)
  twin?: TwinLike | null;            // BuyerTwin — for brain-construction (W1)
  requirement?: RequirementLike | null;  // ResolvedRequirement — active/superseded facts (W1)
  contradictions?: { count?: number; items?: string[] } | null;  // requirement contradictions (W1 · Q73/74)
  specOrder?: string[];              // reprioritised spec order — for spec-reasoning ranks (W2)
  outcome?: OutcomeLike | null;      // real lead/call outcome — outcome-value (W7); null = awaiting feed
}
// shape of the n8n E1 `_trace` (mirrors src/lib/enrichment.ts ServerTrace) — kept local to avoid a cycle
export interface ServerTrace { schema?: string; summary?: { trace_id?: string; session_id?: string; execution_id?: string | null; node_count?: number; nodes_ok?: number; nodes_missing?: number; total_items?: number; emitted_at?: string }; nodes?: Array<{ node?: string; status?: string; items_out?: number; confidence?: number | null; latency_ms?: number | null; output_keys?: string[] }> }

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · BUILD THE LEDGER — every deduction in the live state becomes a first-class Decision (P0).
// ════════════════════════════════════════════════════════════════════════════════════════════════
export function buildLedger(state: InspectorState): Ledger {
  const led = createLedger();
  const i = state.intent;
  if (i) led.add({
    id: 'intent', surface: 'intent',
    producedBy: { kind: i.locked ? 'user' : 'llm', ref: 'deriveIntent' },
    value: i.value, state: i.value ? (i.locked ? 'Confirmed' : 'Likely') : 'Unknown', confidence: i.confidence,
    evidence: (i.candidates || []).map((c) => ({ source: 'LLM', rawLine: `${c.label} (${c.score})`, used: nrm(c.label) === nrm(i.value), reason: c.reason })),
    consumers: ['planner', 'specs', 'matching', 'summary'], consumed: !!i.value,
  });
  const b = state.buyer;
  if (b && (b.nature || b.persona)) led.add({
    id: 'buyer', surface: 'profile', producedBy: { kind: 'api', ref: 'enrichment' },
    value: b.nature || b.persona, state: b.verified ? 'Confirmed' : 'Likely', confidence: b.twinConfidence,
    consumers: ['intent', 'planner', 'logistics', 'specs'], consumed: true,
  });
  const c = state.category;
  if (c && c.status === 'hit') led.add({
    id: 'category', surface: 'category', producedBy: { kind: 'node', ref: 'category-build' },
    value: c.band, confidence: c.score, state: c.consume ? 'Likely' : 'Weak',
    consumers: c.consume ? ['specs', 'planner'] : [], consumed: !!c.consume,
  });
  for (const q of state.planner?.questions || []) led.add({
    id: `planner:${q.id}`, surface: 'planner',
    producedBy: { kind: q.groundedIn ? 'code' : 'llm', ref: 'planRequirement' },
    value: q.label, confidence: q.priority, consumers: [], consumed: true,
    evidence: q.groundedIn ? [{ source: q.groundedIn, rawLine: q.reason || q.label, used: true }] : [],
  });
  for (const s of state.specs || []) {
    const src = s.source || 'unknown';
    const kind: Decision['producedBy']['kind'] = src === 'user' || src === 'buyer' ? 'user' : /cascade|infer|deduc/.test(src) ? 'code' : 'api';
    led.add({ id: `spec:${s.name}`, surface: 'spec', producedBy: { kind, ref: src }, value: s.value ?? '(asked)', confidence: s.priority, consumers: ['matching', 'summary'], consumed: !!s.value });
  }
  for (const [k, d] of Object.entries(state.logistics || {})) led.add({
    id: `logi:${k}`, surface: 'last-page', producedBy: { kind: 'code', ref: 'deduceLogistics' },
    value: d.value, confidence: d.confidence, consumers: ['summary'], consumed: true,
    evidence: [{ source: 'deduceLogistics', rawLine: d.reason, used: true }],
  });
  return led;
}

// small builders
const row = (label: string, value?: string, tone?: Tone, sub?: string, score?: number): InspectorRow => ({ label, value, tone, sub, score });
const sec = (title: string, rows: InspectorRow[]): InspectorSection => ({ title, rows: rows.length ? rows : [row('—', 'no data for this lens yet', 'muted')] });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE REPORT — one payload, sections = the L11–L20 + quality-gate answers.
// ════════════════════════════════════════════════════════════════════════════════════════════════
export function observatoryReport(input: ObservatoryInput): InspectorPayload {
  const { state } = input;
  const led = buildLedger(state);
  const all = led.all();
  const sections: InspectorSection[] = [];

  // ── P0.5 · QUALITY GATES (bl_quality deterministic port) ──────────────────────────────────────
  {
    const rows: InspectorRow[] = [];
    const pnq = productNameQuality(input.productName || '', input.categoryName || '');
    rows.push(row('product name', input.productName || '—', pnq.issue ? 'warn' : 'good', pnq.issue ? pnq.note : 'specific enough'));
    const ft = input.freeText || '';
    const pii = detectPII(ft);
    rows.push(row('PII in free-text', pii.found ? pii.kinds.join(', ') : 'none', pii.found ? 'warn' : 'good', pii.found ? 'debug mode — flagged, not scrubbed' : undefined));
    const gst = extractGSTIN(ft);
    if (gst) rows.push(row('GSTIN found', gst, 'info', 'usable fact (not just PII to drop)'));
    if (looksLikeSeller(ft)) rows.push(row('seller-intent', 'flagged', 'bad', 'free-text reads like a seller, not a buyer'));
    const q = Number(input.quantity) || 0;
    const aq = absurdQuantity({ quantity: q, productPrices: input.productPrices, mcatQ1: input.mcatQ1, mcatQ3: input.mcatQ3, gstOnFile: input.gstOnFile, companyOnFile: input.companyOnFile });
    rows.push(row('quantity sanity', q ? `${q}${input.unit ? ' ' + input.unit : ''}` : '—', aq.absurd ? 'bad' : 'good', aq.absurd ? aq.reasons[0] : (q > 1000 ? 'large but plausible' : 'within normal range')));
    if (input.mcatMedianPrice && q) { const ov = orderValue(q, input.mcatMedianPrice); rows.push(row('order value (POV)', `₹${Math.round(ov.pov).toLocaleString('en-IN')}`, ov.heavyCheck ? 'warn' : 'info', `qty × ₹${input.mcatMedianPrice} median${ov.heavyCheck ? ' · heavy-order review' : ''}`)); }
    else rows.push(row('order value (POV)', '—', 'muted', 'no category median price wired (E2)'));
    sections.push(sec('🔎 Quality gates (P0.5 · bl_quality)', rows));
  }

  // ── 🛰 SERVER TRACE (n8n · E1) — REAL per-node trace from the webhook response, when E1 is active ──
  {
    const st = input.serverTrace;
    if (st && (st.nodes?.length || st.summary)) {
      const s = st.summary || {};
      const rows: InspectorRow[] = [
        row('source', 'n8n · E1 NodeRun (server-grounded)', 'good', `session ${s.session_id ?? '—'} · exec ${s.execution_id ?? '—'}`),
        row('nodes', `${s.nodes_ok ?? 0} ok / ${s.nodes_missing ?? 0} missing`, s.nodes_missing ? 'warn' : 'good', `${s.total_items ?? 0} items total`),
      ];
      for (const n of (st.nodes || []).slice(0, 12)) {
        const lat = n.latency_ms != null ? `${Math.round(n.latency_ms)}ms · ` : '';
        const tail = n.confidence != null ? `confidence ${n.confidence}` : (n.output_keys && n.output_keys.length ? n.output_keys.slice(0, 6).join(', ') : '');
        rows.push(row(
          n.node || '—',
          n.status === 'ok' ? `${n.items_out ?? 0} items` : 'missing',
          n.status === 'ok' ? 'good' : 'muted',
          (lat + tail) || undefined,
          typeof n.confidence === 'number' ? n.confidence : undefined,
        ));
      }
      if ((st.nodes || []).length && (st.nodes || []).every((n) => n.latency_ms == null)) rows.push(row('⏱ durations', 'not measured', 'muted', 'enable the E1.5 per-node timer in n8n for real latencies (Q37/38)'));
      sections.push(sec('🛰 Server trace (n8n · E1)', rows));
    } else {
      sections.push(sec('🛰 Server trace (n8n · E1)', [row('status', 'not active', 'muted', 'no `_trace` in the last pull — enable the E1 node in n8n to populate this (client reconstruction above is unaffected)')]));
    }
  }

  // ── 🧬 RAW LINEAGE (P1 · Gap 1+2) — fact → exact JSON path → value → emitting n8n node → execution ──
  {
    const lineage = allLineage(input.raw, input.serverTrace);
    if (lineage.length) {
      const rows: InspectorRow[] = lineage.slice(0, 16).map((l) => row(
        l.fact, l.value ?? '—', 'good',
        `${l.api ? l.api + ' · ' : ''}${l.jsonPath} · node: ${l.sourceNode ?? '(enable E1 to map)'}${l.execution ? ' · exec ' + l.execution : ''}`,
      ));
      sections.push(sec('🧬 Raw lineage (fact → JSON path → node)', rows));
    } else {
      sections.push(sec('🧬 Raw lineage (fact → JSON path → node)', [row('status', input.raw ? 'no mapped facts in this pull' : 'no buyer pull yet', 'muted', 'pull a buyer → each fact shows its exact JSON field + value (+ n8n node when E1 is on)')]));
    }
  }

  // ── L20 · GOVERNANCE — who is ALLOWED to decide (Q61–Q70) ─────────────────────────────────────
  {
    const rows: InspectorRow[] = [];
    rows.push(row('precedence (Q63)', PRECEDENCE.join(' < '), 'info', 'higher wins — User overrides everything; LLM lowest above fallback'));
    // Q69 READY gate (the real planner gate, surfaced)
    const ready = readyVerdict([
      { name: 'Buyer pulled', required: true, met: !!(state.buyer?.nature || state.buyer?.persona) },
      { name: 'Category resolved', required: true, met: state.category?.status === 'hit' },
      { name: 'Intent decided', required: false, met: !!state.intent?.value },
    ]);
    rows.push(row('READY to plan? (Q69)', ready.ready ? 'YES' : `NO — missing ${ready.missing.join(', ')}`, ready.ready ? 'good' : 'warn', 'planner may not run before category resolves'));
    // Q61 overrides → User wins (real, from the override tracker)
    for (const o of state.overrides || []) {
      const r = resolveConflict({ field: o.field, contenders: [{ source: 'LLM', value: o.suggested }, { source: 'User', value: o.chosen }] });
      rows.push(row(`conflict · ${o.field} (Q61)`, `${o.suggested} → ${o.chosen}`, 'warn', r.rule));
    }
    // Q64/Q65 safeguards fired (trust panel) — derived from real state
    const guards: Safeguard[] = [];
    if (state.buyer?.offProfile) guards.push({ name: 'off-profile suppression', fired: true, subject: 'Buyer Twin', reason: 'current product unrelated to history → twin intent NOT used (no leak)' });
    if (state.intent && !state.intent.value && state.intent.question) guards.push({ name: 'low-confidence → ask', fired: true, subject: 'Intent', reason: 'below bar → asked the buyer instead of guessing' });
    for (const [, d] of Object.entries(state.logistics || {})) if (d.confidence < 70) { guards.push({ name: 'recommend-not-autofill', fired: true, subject: 'Logistics', reason: `confidence ${d.confidence}% < 70 → asked to confirm, not silently filled` }); break; }
    for (const g of safeguardsFired(guards)) rows.push(row(`safeguard · ${g.subject} (Q64)`, g.name, 'good', g.reason));
    // Q66/67/68 FMEA + blast radius + irreversibility — cascades from real consumer counts
    const risk = riskProfile(all.filter((d) => (d.consumers || []).length > 0).map((d) => ({
      decision: d.id, failureMode: d.producedBy.kind === 'llm' ? 'LLM mis-derivation' : d.producedBy.kind === 'api' ? 'stale/empty source' : 'wrong rule branch',
      blastRadius: ((d.consumers || []).length >= 3 ? 'Very High' : (d.consumers || []).length === 2 ? 'High' : 'Medium') as 'Low' | 'Medium' | 'High' | 'Very High',
      cascadesInto: d.consumers || [], irreversible: false,
    })));
    for (const r of risk.slice(0, 4)) rows.push(row(`risk · ${r.decision} (Q66-68)`, `${r.blastRadius}${r.irreversible ? ' · IRREVERSIBLE' : ''}`, r.irreversible ? 'bad' : r.blastRadius === 'Very High' ? 'warn' : 'muted', `if wrong → cascades into ${r.cascadesInto.join(', ')}`));
    sections.push(sec('⚖️ Governance · who may decide (L20 · Q61-70)', rows));
  }

  // ── L11 · NON-CONSUMPTION MATRIX with REAL per-engine reasons (P3 · Gap 4 — "what DIDN'T happen, why") ──
  {
    const rows: InspectorRow[] = [];
    const cat = state.category; const buyer = state.buyer;
    // (a) Buyer Twin active-intent → Intent engine: the off-profile safeguard is the real reject reason
    if (buyer && (buyer.nature || buyer.persona)) {
      const off = !!buyer.offProfile;
      rows.push(row('Buyer active-intent → Intent', off ? '✗ rejected' : '✓ consumed', off ? 'bad' : 'good', off ? 'off-profile: current product unrelated to buyer history → not leaked into intent' : 'on-profile → fed the intent decision'));
    }
    // (b) Category brain → Specs/Planner: the real reason is the confidence gate (consume/fuse)
    if (cat && cat.status === 'hit') {
      const used = !!cat.consume;
      rows.push(row('Category brain → Specs/Planner', used ? '✓ consumed' : '✗ rejected', used ? 'good' : 'bad', used ? `confidence ${cat.score} ≥ gate → fused` : `confidence ${cat.score} (${cat.band}) below gate → NOT fused (similarity/density too low)`));
    } else if (cat) {
      rows.push(row('Category brain → Specs/Planner', '✗ not available', 'muted', cat.status === 'building' ? 'still building (cold cache)' : 'no category resolved (new/unmapped)'));
    }
    // (c) Each critical spec → mapped to an asked spec/question, or the real reason it wasn't
    const askedNames = new Set([...(state.specs || []).map((s) => nrm(s.name)), ...(state.planner?.questions || []).map((q) => nrm(q.label))]);
    for (const crit of (cat?.criticals || []).slice(0, 6)) {
      const key = nrm(crit.maps_to_isq || crit.name);
      const consumed = askedNames.has(key) || [...askedNames].some((a) => a.includes(key) || key.includes(a));
      const m = nonConsumptionMatrix(crit.name, [
        { consumer: 'Specs', available: true, consumed, reason: consumed ? 'mapped to an asked spec' : 'no ISQ mapping in this MCAT' },
        { consumer: 'Planner', available: true, consumed, reason: consumed ? 'surfaced as a question' : !cat?.consume ? 'category not fused (below gate)' : 'below priority cut' },
      ]);
      const why = consumed ? 'reached a consumer' : !cat?.consume ? 'category not fused → critical never reached specs/planner' : m.everywhereRejected ? 'no ISQ mapping + below priority cut' : 'partially used';
      rows.push(row(`  ${crit.name}`, consumed ? '✓ consumed' : '✗ unused', consumed ? 'good' : 'bad', why));
    }
    if (!rows.length) rows.push(row('status', 'no facts available yet', 'muted', 'pull a buyer / resolve a category to populate'));
    sections.push(sec('🚫 Non-consumption · real reasons (L11 · P3 · Q14)', rows));
  }

  // ── L12 · OUTPUT-ACCEPTANCE LEDGER (P2 · Gap 3) — per LLM call: produced → accepted → rejected (why)
  //    + the raw INPUT/OUTPUT JSON. Covers deriveIntent (candidates) AND planRequirement (questions). ──
  {
    const rows: InspectorRow[] = [];
    const llmRaw = input.llmRaw || {};
    // INTENT — candidates produced; chosen accepted; rest rejected (below the bar)
    const cands = state.intent?.candidates || [];
    if (cands.length) {
      const bar = state.intent?.decision?.threshold ?? 80;
      const chosen = nrm(state.intent?.value || '');
      const accepted = cands.filter((c) => nrm(c.label) === chosen);
      const rejected = cands.filter((c) => nrm(c.label) !== chosen);
      rows.push(row('deriveIntent', `produced ${cands.length} · accepted ${accepted.length} · rejected ${rejected.length}`, 'info', `bar ${bar}`));
      for (const r of rejected.slice(0, 4)) rows.push(row(`  ✗ ${r.label}`, `score ${r.score}`, 'warn', r.score < bar ? `below bar ${bar}` : 'not the winner', r.score));
      const io = llmRaw['deriveIntent']; if (io) rows.push(row('  raw I/O', 'in→out captured', 'muted', `IN: ${(io.input || '').slice(0, 90)}… · OUT: ${(io.output || '').slice(0, 90)}…`));
    }
    // PLANNER — questions asked (accepted) vs considered/suppressed (rejected, with the real reason)
    const asked = state.planner?.questions || [];
    const suppressed = state.planner?.considered || [];
    if (asked.length || suppressed.length) {
      const produced = asked.length + suppressed.length;
      rows.push(row('planRequirement', `produced ${produced} · accepted ${asked.length} · rejected ${suppressed.length}`, 'info', `budget ${state.planner?.budgetMax ?? 3}`));
      for (const s of suppressed.slice(0, 6)) rows.push(row(`  ✗ ${s.label}`, `score ${s.score}`, 'warn', s.reason || 'suppressed', s.score));
      const io = llmRaw['planRequirement']; if (io) rows.push(row('  raw I/O', 'in→out captured', 'muted', `IN: ${(io.input || '').slice(0, 90)}… · OUT: ${(io.output || '').slice(0, 90)}…`));
    }
    if (!rows.length) rows.push(row('status', 'no LLM output yet', 'muted', 'derive intent / plan to populate the acceptance ledger'));
    sections.push(sec('📥 Output-acceptance ledger (L12 · P2 · Q5/Q27)', rows));
  }

  // ── L13 · WASTE-QUESTION (Q58 — STRUCTURAL: grounded vs ungrounded; true waste needs outcome telemetry) ──
  {
    const rows: InspectorRow[] = [];
    for (const q of (state.planner?.questions || []).slice(0, 6)) {
      const changed = q.groundedIn ? [q.groundedIn] : [];
      const a = answerImpact(q.label, changed);
      rows.push(row(q.label, a.useful ? 'grounded' : 'ungrounded', a.useful ? 'good' : 'warn', a.useful ? `ties to ${changed.join(', ')}` : 'no upstream grounding — candidate waste (confirm w/ outcomes)'));
    }
    sections.push(sec('🗑 Waste-question · STRUCTURAL (L13 · Q58)', rows));
  }

  // ── L14 · SUFFICIENCY · ROBUSTNESS · CONFIDENCE-FORMULA (Q43/Q45/Q50) ──────────────────────────
  {
    const needed = (state.specs || []).length + (state.planner?.questions || []).length || 6;
    const received = state.buyer?.evidenceCount ?? all.filter((d) => d.consumed).length;
    const suff = evidenceSufficiency(received, needed, state.confidence?.overall ?? 0);
    // robustness of the headline identity — count distinct backing sources actually present
    const idSources = [state.buyer?.verified ? 'VerifiedAPI' : '', state.buyer?.nature ? 'Enrichment' : '', (state.intent?.candidates?.length ? 'LLM' : ''), state.category?.status === 'hit' ? 'Category' : ''].filter(Boolean);
    const rob = robustness(idSources);
    // confidence formula from the real component scores
    const conf = state.confidence || {};
    const parts = [
      { source: 'buyer', points: Math.round((conf.buyer ?? 0) * 0.4) },
      { source: 'category', points: Math.round((conf.category ?? 0) * 0.25) },
      { source: 'intent', points: Math.round((conf.intent ?? 0) * 0.2) },
      { source: 'specs', points: Math.round((conf.specs ?? 0) * 0.15) },
    ].filter((p) => p.points > 0);
    const f = confidenceFormula(parts);
    sections.push(sec('📐 Sufficiency · robustness · formula (L14 · Q43/45/50)', [
      row('evidence sufficiency (Q43)', `${suff.coveragePct}% (${received}/${needed})`, suff.sufficient ? 'good' : 'warn', `confidence capped at ${suff.cappedConfidence}`),
      row('robustness (Q45)', rob.fragile ? 'FRAGILE' : `${idSources.length} sources`, rob.fragile ? 'bad' : 'good', rob.note, rob.score),
      row('confidence (Q50)', f.breakdown, 'info', 'additive — drop a source, watch it fall'),
    ]));
  }

  // ── L15 · COUNTERFACTUAL / DETERMINISTIC-vs-AI (Q44/Q60) ──────────────────────────────────────
  {
    const dva = deterministicVsAI(all);
    const di = dependencyImpact('Intent', ['LLM', state.intent?.decision?.twin ? 'Twin' : '', state.intent?.decision?.registry ? 'Registry' : ''].filter(Boolean), 'LLM');
    sections.push(sec('🔀 Counterfactual · det-vs-AI (L15 · Q44/60)', [
      row('survives w/o LLM (Q60)', `${dva.survives.length} of ${all.length} decisions`, dva.survives.length > dva.lost.length ? 'good' : 'warn', `${dva.lost.length} are AI-only: ${dva.lost.map((d) => d.id).join(', ') || 'none'}`),
      row('drop LLM from intent (Q44)', di.survives ? `survives via ${di.remaining.join(', ')}` : 'intent DIES — LLM-only', di.survives ? 'good' : 'bad'),
    ]));
  }

  // ── L16 · ROI / VALUE (Q48/Q52/Q57) ───────────────────────────────────────────────────────────
  {
    const facts = all.map((d) => ({ source: d.producedBy.kind, used: (d.consumers || []).length > 0 && !!d.consumed }));
    const roi = sourceROI(facts);
    const totalCost = (state.llmCalls || []).reduce((s, x) => s + (x.costUsd || 0), 0);
    const uses = all.reduce((s, d) => s + (d.consumers || []).length, 0);
    const cpu = costPerUse(totalCost, uses);
    const top = topImpact(all).slice(0, 3);
    sections.push(sec('💰 ROI · value (L16 · Q48/52/57)', [
      ...roi.slice(0, 4).map((r) => row(`ROI · ${r.source} (Q48)`, `${r.roiPct}% used`, r.roiPct >= 50 ? 'good' : 'warn', `${r.used}/${r.contributed} decisions consumed`, r.roiPct)),
      row('cost / use (Q52)', `$${cpu.perUse.toFixed(6)}`, 'info', `$${totalCost.toFixed(5)} over ${uses} downstream uses`),
      row('top-impact (Q57)', top.map((t) => `${t.id} (${t.impact})`).join(', ') || '—', 'info', 'ranked by # of downstream consumers'),
    ]));
  }

  // ── L17 · IMPACT-DIFF (Q49 — on an override, what changed vs what did NOT) ─────────────────────
  {
    const before: Record<string, unknown> = {}; const after: Record<string, unknown> = {};
    for (const o of state.overrides || []) { before[o.field] = o.suggested; after[o.field] = o.chosen; }
    const diff = impactDiff(before, after);
    sections.push(sec('🔧 Impact-diff (L17 · Q49)', [
      row('changed', diff.changed.map((c) => `${c.field}: ${c.from}→${c.to}`).join('; ') || 'none', diff.changed.length ? 'warn' : 'good'),
      row('unchanged', diff.notChanged.join(', ') || (state.overrides?.length ? '—' : 'no overrides yet'), 'muted'),
    ]));
  }

  // ── P4 · IMPACT-DIFF · COUNTERFACTUAL (Gap 5 — "with X vs without X → delta", was the input USEFUL?)
  //    Deterministic, derived from THIS run's grounding (not a live planner re-run, which needs an LLM call). ──
  {
    const asked = state.planner?.questions || [];
    const askedCount = asked.length;
    const twinSaved = state.planner?.twinResolved?.length || 0;
    const catGrounded = asked.filter((q) => /categor/i.test(q.groundedIn || '')).length;
    const criticals = state.category?.criticals?.length || 0;
    const rows: InspectorRow[] = [];
    // Buyer Twin: questions it pre-resolved would otherwise be asked → real counterfactual on the ask-count
    if (twinSaved || askedCount) {
      const without = askedCount + twinSaved;
      const pct = without > 0 ? Math.round((twinSaved / without) * 100) : 0;
      rows.push(row('Buyer Twin', `with ${askedCount} asked · without ${without}`, twinSaved ? 'good' : 'muted', twinSaved ? `saved ${twinSaved} questions (${pct}% fewer) — twin already knew them` : 'no questions pre-resolved by the twin'));
    }
    // Category: grounded questions + critical specs it surfaced → vanish without it
    if (state.category?.status === 'hit') {
      const used = !!state.category.consume;
      rows.push(row('Category brain', used ? `+${catGrounded} grounded Qs · +${criticals} critical specs` : 'not fused → contributed 0', used ? 'good' : 'warn', used ? 'without category these would fall back to generic asks' : `confidence ${state.category.score} below gate → no measurable impact this run`));
    }
    rows.push(row('basis', 'this run\'s grounding', 'muted', 'deterministic delta (live with/without re-run = P4.5, needs a 2nd planner call)'));
    sections.push(sec('🔬 Impact-diff · counterfactual (P4 · Gap 5)', rows));
  }

  // ── P5 · REPLAY (Gap 6) — diff the two most recent runs (intent / category / questions changed) ──
  {
    const runs = input.runs || [];
    if (runs.length >= 2) {
      const a = runs[runs.length - 2]; const b = runs[runs.length - 1];
      const d = diffRuns(a, b);
      const rows: InspectorRow[] = d.rows.map((r) => row(r.field, `${r.a} → ${r.b}`, r.changed ? 'warn' : 'muted', r.changed ? 'changed' : 'same'));
      if (d.questionsAdded.length) rows.push(row('Qs added', d.questionsAdded.join(', '), 'good'));
      if (d.questionsRemoved.length) rows.push(row('Qs removed', d.questionsRemoved.join(', '), 'bad'));
      if (!d.anyChange) rows.push(row('verdict', 'no change between runs', 'good', 'stable / reproducible'));
      sections.push(sec(`🔁 Replay · ${a.label} → ${b.label} (P5 · Gap 6)`, rows));
    } else {
      sections.push(sec('🔁 Replay (P5 · Gap 6)', [row('runs captured', String(runs.length), 'muted', runs.length ? 'need ≥2 runs to diff — pull another buyer' : 'no runs snapshotted yet — each completed run is saved automatically')]));
    }
  }

  // ── W1/W2/W7 · DEEP LAYERS — brain construction, spec reasoning, outcome scaffold ──
  sections.push(...deepSections({
    twin: input.twin, requirement: input.requirement, contradictions: input.contradictions,
    specOrder: input.specOrder, specs: state.specs, outcome: input.outcome,
  }));

  const overall = state.confidence?.overall;
  return {
    kind: 'observatory',
    title: '🛰 AI PROCUREMENT OBSERVATORY',
    decision: `${all.length} decisions tracked · overall ${overall ?? '—'}`,
    decisionTone: 'info',
    sections,
  };
}
