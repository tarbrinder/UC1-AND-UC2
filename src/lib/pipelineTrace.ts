// ─── PIPELINE TRACE (Master-Observatory foundation) — the OTEL-style span model the timeline renders over ───
// One ORDERED list of spans = the buyer's state evolving through the WHOLE pipeline spine:
//   Stage 0 Pull → [source spans] · 1 Synthesis · 2 Twin · 3 Requirement · 4 Intent · 5 Planner · 6 RFQ · 7 Outcome
// Every view (vertical timeline · pinned twin · System DAG) is just a RENDERER over this list. Stages that have
// not run yet (Intent/Planner/RFQ/Outcome live in the RFQ flow) are emitted as HONEST `pending` spine stages —
// the spine is always complete; modules light up as they run. Use-cases 2 & 3 populate them later, no re-wiring.
// This is the LangSmith/Langfuse pattern: a span tree underneath, swappable views on top.
//
// Each span carries (LangSmith/Langfuse "observation" fields + our differentiator):
//   • cooked       — structured OUTPUT of the stage (the VIEW attaches per-source raw JSON from the live pull)
//   • transformed  — true = reshaped/distilled · false = passthrough extraction (the "unchanged" marker)
//   • reasoning    — grounded steps (fusion) · decisions — decision ids produced here (view renders full chain)
//   • scores       — attached metrics (Langfuse "scores")
//   • twinAfter    — CUMULATIVE buyer-twin snapshot AFTER this span (items added here flagged isNew). The pinned
//                    rail reads twinAfter of the in-view span → the twin GROWS as you scroll. This evolving
//                    belief-state is the protagonist; LangSmith/Langfuse/Langflow don't show it, we do.
// Pure + deterministic (no LLM, no fetch). Mirrored by scripts/pipelinetest.mjs.

import type { Ledger, SourceNode, ReasoningStep, Fact } from './ledger';
import type { Persona } from './personaRegistry';

export type SpanKind = 'pull' | 'source' | 'fuse' | 'twin' | 'enrichment' | 'requirement' | 'intent' | 'planner' | 'rfq' | 'outcome';
export interface TwinItem { k: string; v: string; isNew?: boolean }
export interface TwinSection { group: string; items: TwinItem[] }
export interface CookedRow { label: string; value: string; role?: string }
export interface SpanScore { label: string; value: string }
export interface TraceSpan {
  id: string;
  parentId: string | null;
  kind: SpanKind;
  stageNo: number;               // 0..7 — the spine position (source spans share the Pull stage's 0)
  stage: string;                 // human label, e.g. "Pull Sources", "Buyer Synthesis"
  source?: SourceNode;           // set on source spans (links back to the Evidence Graph / node card)
  status: 'ok' | 'empty' | 'server';
  pending: boolean;              // true = stage hasn't run yet (RFQ-flow stages) — honest spine placeholder
  transformed: boolean;          // true = reshaped/distilled · false = passthrough extraction (unchanged)
  note: string;                  // one-line "what happened (or what will happen) here"
  cooked: CookedRow[];           // structured output of this stage
  reasoning?: ReasoningStep[];   // grounded steps (fusion)
  decisions?: string[];          // decision ids produced here (fusion) — view renders the full chain per id
  scores?: SpanScore[];          // attached metrics
  twinAfter: TwinSection[];      // CUMULATIVE twin snapshot after this span (items added HERE flagged isNew)
}
export interface PipelineTrace { useCase: string; glid?: string; spans: TraceSpan[] }

export interface BuildOpts {
  glid?: string;
  requirements?: Array<{ title: string; specCount: number; hasBL: boolean; hasISQ: boolean }>;
  journey?: { arc: string; maturity: string; steps: number };
  // the MERGED twin (arithmetic + LLM synthesis). When present it REPLACES the persona-only deduced attrs in
  // the Fusion/Twin snapshots — so the pinned twin "refreshes" with the LLM-merged result after the call.
  deduced?: Array<{ key: string; label: string; group: string; value: string; confidence: number; provenance?: string }>;
}

// Fixed pull order (parallel fan-out under the Pull span). Only sources with facts become spans.
const ORDER: SourceNode[] = ['profile-api', 'glusr', 'pns-insights', 'prev-bl', 'prev-isq', 'csl', 'wa-in', 'wa-out', 'befisc', 'sign3'];
// honest passthrough-vs-transform: PNS is LLM-distilled upstream; WhatsApp is cleaned/normalised; the rest are
// read field-as-is (extraction passthrough). Drives the "unchanged · no formatting" marker the user asked for.
const TRANSFORMED: Record<SourceNode, boolean> = { 'profile-api': false, glusr: false, 'pns-insights': true, 'prev-bl': false, 'prev-isq': false, csl: false, 'wa-in': true, 'wa-out': true, befisc: false, sign3: false };
// which twin SECTION each source feeds (so the evolving twin groups raw evidence sensibly)
const TWIN_SECTION: Record<SourceNode, string> = { 'profile-api': 'Identity', glusr: 'Identity', 'pns-insights': 'Sales calls', 'prev-bl': 'Requirements', 'prev-isq': 'Requirements', csl: 'Browsing', 'wa-in': 'Chat', 'wa-out': 'Chat', befisc: 'External', sign3: 'External' };
const LABEL: Record<SourceNode, string> = { 'profile-api': 'Profile API', glusr: 'GLUSR · Account', 'pns-insights': 'PNS Call Insights', 'prev-bl': 'Previous BuyLeads', 'prev-isq': 'Previous ISQ', csl: 'CSL Browse/Search', 'wa-in': 'WhatsApp In', 'wa-out': 'WhatsApp Out', befisc: 'Befisc · External Identity', sign3: 'Sign3 · Social Presence' };

const leaf = (f: Fact) => f.lineRef || f.jsonPath.split('.').pop() || f.tag;
const trunc = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + '…' : s);

// Build the buyer-profile → twin trace (Stages 0-3 real) + the honest pending spine (Stages 4-7). The view
// attaches per-source raw JSON (live pull) + latency (getServerTrace); the model stays pure so the harness proves it.
export function buildPipelineTrace(L: Ledger, persona: Persona, opts: BuildOpts = {}): PipelineTrace {
  const { glid, requirements = [], journey } = opts;
  // the deduced attribute set the twin shows: the merged (arithmetic+LLM) result when provided, else persona-only
  const deduced = (opts.deduced && opts.deduced.length) ? opts.deduced : persona.shown.map((a) => ({ key: a.key, label: a.label, group: a.group, value: a.value, confidence: a.confidence, provenance: 'arithmetic' as string | undefined }));
  const spans: TraceSpan[] = [];
  // accumulating twin items, each tagged with the span id that introduced it (→ isNew per snapshot)
  const acc: Array<{ group: string; k: string; v: string; addedBy: string }> = [];
  const snapshot = (thisSpanId: string): TwinSection[] => {
    const byGroup = new Map<string, TwinItem[]>();
    for (const it of acc) {
      if (!byGroup.has(it.group)) byGroup.set(it.group, []);
      byGroup.get(it.group)!.push({ k: it.k, v: it.v, isNew: it.addedBy === thisSpanId });
    }
    return [...byGroup.entries()].map(([group, items]) => ({ group, items }));
  };

  const factsBy = new Map<SourceNode, Fact[]>();
  for (const f of L.facts) { const a = factsBy.get(f.sourceNode) || []; a.push(f); factsBy.set(f.sourceNode, a); }
  const present = ORDER.filter((s) => (factsBy.get(s) || []).length > 0);

  // ── Stage 0 · PULL parent (twin empty — only sources gathered, nothing believed yet) ──
  const pullId = 'span-pull';
  spans.push({ id: pullId, parentId: null, kind: 'pull', stageNo: 0, stage: 'Pull Sources', status: 'ok', pending: false, transformed: false, note: `Pulled ${present.length} of ${ORDER.length} sources for GLID ${glid || '—'}${present.length < ORDER.length ? ` · ${ORDER.length - present.length} returned no data` : ''}`, cooked: present.map((s) => ({ label: LABEL[s], value: `${(factsBy.get(s) || []).length} facts` })), twinAfter: [] });

  // Stage 0 contents · SOURCE spans (parallel children) — each accumulates its raw evidence into the twin
  // show EVERY expected source — including ones that returned no data this pull — so a silent upstream gap (e.g. PNS
  // came back empty) is VISIBLE as "pulled · 0 fields · no data" instead of the node just vanishing from the panel.
  for (const s of ORDER) {
    const facts = factsBy.get(s) || [];
    const id = `span-src-${s}`;
    const cooked: CookedRow[] = facts.slice(0, 10).map((f) => ({ label: leaf(f), value: trunc(f.rawValue), role: f.role }));
    const sect = TWIN_SECTION[s];
    for (const f of facts.slice(0, 6)) acc.push({ group: sect, k: leaf(f), v: trunc(f.rawValue, 40), addedBy: id });
    spans.push({ id, parentId: pullId, kind: 'source', stageNo: 0, stage: LABEL[s], source: s, status: facts.length ? 'ok' : 'empty', pending: false, transformed: TRANSFORMED[s], note: facts.length ? (TRANSFORMED[s] ? 'reshaped / distilled upstream' : 'fields read as-is (passthrough — unchanged)') : 'pulled — 0 fields · this source returned no data in this pull (check the node upstream)', cooked, scores: [{ label: 'facts', value: String(facts.length) }, { label: 'used', value: String(facts.filter((f) => f.coverage === 'used').length) }], twinAfter: snapshot(id) });
  }

  // ── Stage 1 · FUSE — the DEDUCTION (deterministic rules; the live flash-lite call cross-checks it) ──
  const fuseId = 'span-fuse';
  for (const a of deduced) acc.push({ group: `Deduced · ${a.group}`, k: a.label, v: a.value, addedBy: fuseId });
  const allSteps: ReasoningStep[] = L.decisions.flatMap((d) => d.reasoningSteps || []);
  const merged = !!(opts.deduced && opts.deduced.length);
  const llmNew = deduced.filter((a) => a.provenance === 'llm-new').length;
  spans.push({ id: fuseId, parentId: pullId, kind: 'fuse', stageNo: 1, stage: 'Buyer Synthesis', status: 'ok', pending: false, transformed: true, note: merged ? `Arithmetic prior + LLM synthesis → ${deduced.length} merged attributes${llmNew ? ` (${llmNew} LLM-surfaced)` : ''}` : `Rules fused ${L.facts.length} facts → ${deduced.length} attributes · LLM synthesis cross-checks`, cooked: deduced.map((a) => ({ label: a.label, value: `${a.value} (${a.confidence})` })), reasoning: allSteps, decisions: L.decisions.map((d) => d.id), scores: [{ label: 'attributes', value: String(deduced.length) }, { label: 'held back', value: String(persona.hidden.length) }, { label: merged ? 'LLM-surfaced' : 'reasoning steps', value: String(merged ? llmNew : allSteps.length) }], twinAfter: snapshot(fuseId) });

  // ── Stage 2 · ENRICHMENT — the use-case-1 deliverable: existing buyer profile ↔ our enriched twin (before/after).
  //    Comes BEFORE the twin headline: we enrich the on-file profile first, then the completed twin is what falls out. ──
  const enrId = 'span-enrich';
  spans.push({ id: enrId, parentId: null, kind: 'enrichment', stageNo: 2, stage: 'Buyer Profile Enrichment', status: 'ok', pending: false, transformed: true, note: 'Existing buyer profile → enriched twin — what IndiaMART had on file vs what we now know', cooked: persona.shown.map((a) => ({ label: a.label, value: a.value })), scores: [{ label: 'enriched attrs', value: String(persona.shown.length) }], twinAfter: snapshot(enrId) });

  // ── Stage 3 · TWIN — the completed buyer twin (the headline that falls out of the enrichment above) ──
  const twinId = 'span-twin';
  spans.push({ id: twinId, parentId: null, kind: 'twin', stageNo: 3, stage: `Buyer Twin${persona.headline ? ' · ' + persona.headline : ''}`, status: 'ok', pending: false, transformed: false, note: 'Who is this buyer — attributes · confidence · stability · contradictions · risk', cooked: persona.shown.map((a) => ({ label: a.label, value: a.value })), scores: [{ label: 'attributes', value: String(persona.shown.length) }, { label: 'avg conf', value: String(persona.shown.length ? Math.round(persona.shown.reduce((s, a) => s + a.confidence, 0) / persona.shown.length) : 0) }], twinAfter: snapshot(twinId) });

  // ── Stage 4 · REQUIREMENT — offer history stitched (BL+ISQ) → journey arc + maturity ──
  const reqId = 'span-req';
  if (journey) { acc.push({ group: 'Deduced · Journey', k: 'Operating arc', v: journey.arc, addedBy: reqId }); acc.push({ group: 'Deduced · Journey', k: 'Maturity', v: journey.maturity, addedBy: reqId }); }
  spans.push({ id: reqId, parentId: null, kind: 'requirement', stageNo: 4, stage: 'Requirement Intelligence', status: requirements.length ? 'ok' : 'empty', pending: false, transformed: true, note: requirements.length ? `${requirements.length} requirement${requirements.length === 1 ? '' : 's'} stitched (BuyLead + ISQ) → ${journey?.arc || 'arc'}` : 'no prior requirements on record', cooked: requirements.map((r) => ({ label: r.title, value: `${r.specCount} specs${r.hasBL ? ' · BL' : ''}${r.hasISQ ? ' · ISQ' : ''}` })), scores: journey ? [{ label: 'requirements', value: String(requirements.length) }, { label: 'maturity', value: journey.maturity }] : undefined, twinAfter: snapshot(reqId) });

  // ── Stages 5-8 · the RFQ-flow spine (honest pending — these run live when the buyer starts an RFQ) ──
  const pendingStages: Array<{ id: string; kind: SpanKind; stageNo: number; stage: string; note: string }> = [
    { id: 'span-intent', kind: 'intent', stageNo: 5, stage: 'Intent Intelligence', note: 'Intent extraction · signals · evidence · contradictions — runs live in the RFQ flow (seeded by the PNS call intent).' },
    { id: 'span-planner', kind: 'planner', stageNo: 6, stage: 'Planner', note: 'Question generation · category strategy · trade-offs — runs live once intent is known.' },
    { id: 'span-rfq', kind: 'rfq', stageNo: 7, stage: 'RFQ', note: 'The composed RFQ — why every field exists · evidence · confidence — appears once the buyer fills it.' },
    { id: 'span-outcome', kind: 'outcome', stageNo: 8, stage: 'Outcome', note: 'Lead quality · seller outcome · conversion · feedback — awaiting the downstream signal.' },
  ];
  for (const p of pendingStages) spans.push({ id: p.id, parentId: null, kind: p.kind, stageNo: p.stageNo, stage: p.stage, status: 'empty', pending: true, transformed: false, note: p.note, cooked: [], twinAfter: snapshot(p.id) });

  return { useCase: 'Buyer Intelligence (Profile → Twin → RFQ)', glid, spans };
}
