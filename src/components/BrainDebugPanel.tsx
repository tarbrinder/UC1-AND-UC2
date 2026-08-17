// ─── Brain Debug / Observability panel (shared across all surfaces) ──────────
// The eval/evidence harness, modelled on the profile-enrichment + buyer-ledger debug:
//  · every LLM call — model · in/out tokens · ms · $cost, expand → full system+user prompt + output
//  · per-node data + health — expand → the raw each source returned
//  · decision summary + routing + suppressed audit trail
// Right rail, collapsible section headers, expand-to-last-row. Reads live LLM telemetry.
//
// PLAIN-LANGUAGE PASS (owner, 2026-08-13): "Debug CEO version has to be super clear, no cryptic words... click a
// reasoning line number → take me to that source, expand it, highlight that line... keep it simple even a kid can
// understand but keep a little CEO-worthy detail." Three additions make that concrete:
//   · CiteCtx + CiteText/EvidenceList — every "<source>:Lnn — <fact>" evidence string becomes a clickable chip that
//     jumps to and highlights the exact numbered line inside that LLM call's USER prompt (the fenced input really
//     is the only place a line number is authoritative — see resolveFenceLine below for why the Sources panel's
//     RAW/CLEANED blobs are deliberately NOT the jump target).
//   · Term/Section `hint` — plain words lead, the technical name (TUS/BES/…) rides along in a tooltip for whoever
//     wants it, never the reverse.
//   · PageFlow / AuditRow — a per-page "what happened, in one sentence" narrative and a BL-audit self-check.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { getLLMHealth, getLLMRaw, getLLMRawById, onLLMActivity } from '../lib/gemini';
import { getSourceHealth } from '../lib/rfq/dataLayer';
import { buildRunTrace, PERSONA_DEPTH, PERSONA_LABEL, type Persona } from '../lib/rfq/debugTrace';
import { canonConcept } from '../lib/rfq/plannerController';
import { buildLadder, STAGE_META, type Cell as LadderCellData, type FacetLadder, type Mark } from '../lib/consumptionLadder';
import { decisionRoutingReport } from '../lib/brains/formAdapter';
import type { RequirementBrainPayload, Decision } from '../lib/brains/requirementBrain';

const DOT: Record<string, string> = { green: 'bg-teal-500', amber: 'bg-amber-400', red: 'bg-red-500' };
// Fabrication-firewall tiers, colour-coded so a fabricated/inferred atom can never be mistaken for a stated one.
const TIER_COLOR: Record<string, string> = {
  stated: 'bg-teal-100 text-teal-700', observed: 'bg-amber-100 text-amber-700',
  inferred: 'bg-indigo-100 text-indigo-700', noise: 'bg-red-100 text-red-600',
};
const ACTION_COLOR: Record<string, string> = {
  PREFILL: 'bg-teal-100 text-teal-800', CONFIRM: 'bg-amber-100 text-amber-800', ASK: 'bg-blue-100 text-blue-800',
  SUGGEST: 'bg-gray-100 text-gray-600', RESOLVE_CONFLICT: 'bg-red-100 text-red-800', OFFER: 'bg-indigo-100 text-indigo-800', SUPPRESS: 'bg-gray-100 text-gray-400 line-through',
};

function Row({ head, sub, tone, children, mono, forceOpen }: { head: React.ReactNode; sub?: React.ReactNode; tone?: string; children?: React.ReactNode; mono?: boolean; forceOpen?: boolean }) {
  // CLICK-TO-SOURCE (#4): `open` is DERIVED, not synchronised — no effect needed. Until the reader manually
  // touches this row, it just follows `forceOpen` (a citation click targeting it opens it; the panel's focus
  // moving to a different row lets it fall closed again). The moment the reader clicks it themselves, `manual`
  // takes over and wins from then on, exactly like an ungated collapsible.
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? !!forceOpen;
  return (
    <div className="border-b border-gray-50 last:border-0">
      <button onClick={() => setManual(!open)} className="flex w-full items-center gap-2 py-1.5 text-left">
        {tone && <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone] ?? 'bg-gray-300'}`} />}
        <span className="min-w-0 flex-1 truncate">{head}</span>
        {sub}
        <span className="shrink-0 text-[11px] text-gray-300">{open ? '▾' : '▸'}</span>
      </button>
      {open && children ? <div className={`mb-1.5 ${mono ? 'font-mono' : ''}`}>{children}</div> : null}
    </div>
  );
}
function Pre({ v }: { v: unknown }) {
  // #5 — a scroll container, never a hard cut: everything is here, just scroll for it. Bumped from a cramped 14rem
  // so "expand" reads as expand, not a keyhole.
  return <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 px-2 py-1.5 text-[10px] leading-relaxed text-gray-600">{typeof v === 'string' ? v : JSON.stringify(v, null, 1)}</pre>;
}
function Section({ title, count, hint }: { title: string; count?: number | string; hint?: string }) {
  return (
    <p className="mt-3 mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
      <span>{title}{count != null ? ` · ${count}` : ''}</span>
      {hint && <span title={hint} className="cursor-help lowercase text-gray-300">ⓘ</span>}
    </p>
  );
}
// A plain word/phrase that carries the jargon term + its one-line meaning in a tooltip, instead of leading with the
// acronym. "Keep simple language — TUS/SUS/BES can't be understood" (owner) — so the acronym rides along, it never leads.
function Term({ children, def }: { children: React.ReactNode; def: string }) {
  return <span title={def} className="cursor-help underline decoration-dotted decoration-gray-300">{children}</span>;
}

// Shared globalThis shapes — named once so BrainDebugPanel, PageFlow and AuditChecklist all read the SAME contract
// instead of three slightly-different inline casts. Every field is optional: these are read off `window`, published
// by a form that may not have reached that step yet, so every consumer below guards with `?.`.
export interface LiveState {
  product?: string; quantity?: string; unit?: string; specs?: Record<string, string>; commercial?: Record<string, string>; persona?: Record<string, string>;
  contactName?: string; userLocation?: string; deliveryLocation?: string; mcatId?: string; mcatMismatch?: boolean; catName?: string;
  allSpecEntries?: Array<[string, string]>; extraSpecs?: Record<string, string>; requirementNotes?: string;
}
export interface ConsumptionState {
  at?: number; product?: string; category_trustworthy?: boolean;
  page1?: { field: string; ui: string; matched?: string; action: string }[];
  knownTruths?: { key: string; value: string; action: string }[];
}
export interface CategoryPub { mcatId?: string; full?: Record<string, unknown> | null; distilled?: { q: string; pct?: number; vals?: string[] }[] | null; }

// ─── CLICK-TO-SOURCE (#4) ──────────────────────────────────────────────────────
// Every evidence string the LLMs emit in AI-Debug is "<fence-tag>:Lnn — <fact>" (see llm.ts DEBUG_SUFFIX /
// fenceNumbered) — the model is CITING an exact line of its OWN line-numbered USER prompt. That is the one place a
// line number is authoritative: the Sources panel's RAW/CLEANED blobs are a DIFFERENT object at a different
// processing stage (e.g. <truth_csl> is the CSL leaf's raw `summary`, while the Sources panel's own "raw" is the
// whole HTTP body and its "cleaned" is a THIRD, filtered shape) — pretending a line number lines up between them
// would be a fabricated precision this codebase's own ethos forbids. So the jump target is always the citing LLM
// call's own USER prompt; a plain-language hint (TAG_HINT) tells you which real-world source that fence came from.
type Jump = { call: string; tag: string; line: number } | null;
const CiteCtx = createContext<{ jump: Jump; cite: (call: string, tag: string, line: number) => void } | null>(null);

const TAG_HINT: Record<string, string> = {
  truth_csl: 'what he searched for / looked at before this form',
  truth_rfq: 'requirements he posted before',
  truth_enquiries: 'sellers he messaged directly', enquiries: 'sellers he messaged directly',
  truth_profile: 'his IndiaMART account record', buyer_profile: 'his IndiaMART account record',
  truth_whatsapp: 'what he typed on WhatsApp',
  truth_pns: 'what he said on a phone call', pns: 'call insights',
  category_engine: 'what sellers in this category usually ask',
  requirement_brain: "our AI's own read of him, from the previous step",
  page1_state: 'what he already answered on the specs page',
  page2_state: 'what he already answered on the buying-details page',
  page3_state: 'what he already answered on the about-you page',
  persona_gate: 'a rule-based check of how big/serious a buyer he is',
  buyer_signals: 'his own WhatsApp / call / browsing signals',
  buyer_specs_schema: 'the standard question list for this category',
  seller_specs: 'specs sellers in this category ask about',
  browsed_specs: 'the category he actually browsed',
  already_filled: 'values we already had before this AI step',
  product: 'the product name and quantity he entered',
  buyer_session_input: 'what he just told us THIS session — his chat, mic and photo (the freshest signal, fed straight to LLM 1)',
};

// ─── SOURCES — plain "what this is for" + endpoint + cleaning code (#3) ────────────────────────────────────────────
// One row per leaf webhook (src/lib/rfq/dataLayer.ts), matched against the `source` label recordSource() stamps
// (e.g. "CSL · bi-csl-parser", "PNS · bi-pns-insights (api)"). RAW = exactly what that n8n webhook returned; CLEANED
// = what the named function turned it into, and why. Kept here (not imported) because it is display copy, not logic.
const SOURCE_INFO: Array<{ match: RegExp; what: string; endpoint: string; cleanFn: string; cleanFile: string; why: string }> = [
  { match: /^CSL/, what: 'What he searched for and which product pages he opened on IndiaMART before filling this form.', endpoint: '/api/imworkflow/webhook/bi-csl-parser', cleanFn: 'fetchCsl()', cleanFile: 'src/lib/rfq/dataLayer.ts', why: 'keeps only the product names/images/specs he actually viewed or searched, dropping the rest of the tracking log' },
  { match: /^RFQ/, what: 'Requirements he has posted before, and sellers he has personally messaged.', endpoint: '/api/imworkflow/webhook/bi-rfq-details', cleanFn: 'fetchRfq() + parseEnquiries()', cleanFile: 'src/lib/rfq/dataLayer.ts + enquiryParse.ts', why: "turns his past posts into a plain {product, specs} list and pulls out the sellers he personally contacted (his strongest 'I want this' signal)" },
  { match: /^Profile/, what: 'His IndiaMART account — company, city, GST status, how active he is.', endpoint: '/api/imworkflow/webhook/bi-bpod', cleanFn: 'fetchProfile()', cleanFile: 'src/lib/rfq/dataLayer.ts', why: 'passed through as-is — the AI reads the account record directly, nothing is stripped' },
  { match: /^WhatsApp/, what: 'What he has typed to us or to a seller on WhatsApp.', endpoint: '/api/imworkflow/webhook/bi-whatsapp', cleanFn: 'fetchWhatsapp()', cleanFile: 'src/lib/rfq/dataLayer.ts', why: 'passed through as-is — only HIS OWN messages count as intent, our replies are context, never his voice' },
  { match: /^PNS/, what: 'What he said out loud on a phone call to a seller.', endpoint: '/api/imworkflow/webhook/bi-pns-insights', cleanFn: 'fetchPnsInsights()', cleanFile: 'src/lib/rfq/dataLayer.ts', why: 'counts how many call rows came back and checks that against his account\'s own call counter, so a silent zero is never mistaken for "he made no calls"' },
];
const sourceInfoFor = (label: string) => SOURCE_INFO.find((i) => i.match.test(label));

/** Find the ABSOLUTE line (1-based, matching what <Pre>/<LinedBlock> render) inside the full `user` prompt string
 *  that corresponds to local line `n` of the fenced `<tag>` block — fenceNumbered() restarts numbering at L1 for
 *  EVERY tag, so "L7" only means something once you know which tag it is L7 *of*. Returns null if the tag/line
 *  cannot be found (a stale citation from a different run, or the raw I/O was never captured) — we say so in the
 *  UI rather than silently pointing at the wrong place. */
function resolveFenceLine(user: string | undefined, tag: string, n: number): number | null {
  if (!user) return null;
  const lines = user.split('\n');
  let inside = false; let local = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === `<${tag}>`) { inside = true; local = 0; continue; }
    if (t === `</${tag}>`) { inside = false; continue; }
    if (inside) { local++; if (local === n) return i + 1; }
  }
  return null;
}

/** Renders text with any inline "<tag>:Lnn" citations turned into click targets (there can be more than one in a
 *  single string, e.g. a planner's `basis`: "category_engine:L12 asked_pct 78 + page1_state:L4 Weight=1 kg").
 *  `callLabel` names WHICH LLM call this text belongs to, so a click knows whose prompt to search. */
function CiteText({ text, callLabel }: { text: string; callLabel?: string }) {
  const ctx = useContext(CiteCtx);
  const re = /([a-z0-9_]+):L(\d+)/gi;
  const parts: React.ReactNode[] = [];
  let last = 0; let m: RegExpExecArray | null; let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const tag = m[1]; const line = Number(m[2]); const hint = TAG_HINT[tag];
    parts.push(
      callLabel ? (
        <button key={key++} type="button" onClick={() => ctx?.cite(callLabel, tag, line)}
          title={`See ${tag} line ${line} in the prompt${hint ? ` — ${hint}` : ''}`}
          className="rounded bg-indigo-50 px-1 font-mono text-[8.5px] text-indigo-600 hover:bg-indigo-100 hover:underline">
          {tag}:L{line}
        </button>
      ) : (
        <span key={key++} title={hint} className="rounded bg-indigo-50 px-1 font-mono text-[8.5px] text-indigo-600">{tag}:L{line}</span>
      ),
    );
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(<span key={key}>{text.slice(last)}</span>);
  return <>{parts}</>;
}

/** The USER-prompt renderer for an LLM call: one line per DOM row (never one giant text blob) so a citation click
 *  can scroll to and flash the EXACT cited line — the concrete answer to "highlight that line of prompt". */
function LinedBlock({ text, highlightLine }: { text: string; highlightLine?: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightLine == null) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-ln="${highlightLine}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightLine, text]);
  const lines = text.split('\n');
  return (
    <div ref={ref} className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-gray-600">
      {lines.map((ln, i) => (
        <div key={i} data-ln={i + 1} className={i + 1 === highlightLine ? '-mx-0.5 rounded bg-amber-200/80 px-0.5 ring-1 ring-amber-400' : undefined}>{ln.length ? ln : ' '}</div>
      ))}
    </div>
  );
}

// ─── WS-2 / WS-3: structured planner debug (reasoning+evidence-with-lines · competition ledger · needs_input) ──────
type ReasoningEntry = { why?: string; confidence?: number; evidence?: unknown; source?: string; options?: Record<string, string> };
type Considered = { candidate?: string; surfaced?: boolean; rank?: number; dropped_because?: string; basis?: string; why_ranked?: string };
type NeedsInput = { attribute?: string; missing_reason?: string; best_next_question?: string };
type PlanMeta = { reasoning?: Record<string, ReasoningEntry>; considered?: Considered[]; needs_input?: NeedsInput[] };
// Evidence atoms are "<source>:Lnn — <fact>" (WS-2). Each is now a CLICK TARGET (#4): clicking jumps to and
// highlights that exact line inside the citing LLM call's own prompt. `callLabel` says which call that is.
function EvidenceList({ ev, callLabel }: { ev: unknown; callLabel?: string }) {
  const arr = Array.isArray(ev) ? ev : (ev ? [ev] : []);
  if (!arr.length) return null;
  return <ul className="mt-0.5 space-y-0.5">{arr.map((e, i) => {
    const s = typeof e === 'string' ? e : JSON.stringify(e);
    return <li key={i} className="text-[9.5px] leading-snug text-gray-500"><CiteText text={s} callLabel={callLabel} /></li>;
  })}</ul>;
}
function MetaDebug({ meta, callLabel }: { meta?: PlanMeta; callLabel?: string }) {
  if (!meta) return null;
  const reasoning = meta.reasoning ?? {}; const rkeys = Object.keys(reasoning);
  const considered = Array.isArray(meta.considered) ? meta.considered : []; const needs = Array.isArray(meta.needs_input) ? meta.needs_input : [];
  if (!rkeys.length && !considered.length && !needs.length) return null;
  return (<>
    {rkeys.length > 0 && (<>
      <Section title="per-field reasoning + evidence" count={rkeys.length} />
      <div className="space-y-1">{rkeys.map((fk) => { const r = reasoning[fk]; return (
        <div key={fk} className="rounded-lg border border-gray-100 bg-gray-50/60 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5"><span className="min-w-0 flex-1 text-[11px] font-medium text-gray-800">{fk}</span>{typeof r?.confidence === 'number' && <span className="shrink-0 text-[9px] text-gray-500">conf {r.confidence}</span>}</div>
          {r?.why && <p className="mt-0.5 text-[10px] text-gray-600">{String(r.why)}</p>}
          <EvidenceList ev={r?.evidence} callLabel={callLabel} />
          {r?.source && <p className="text-[9px] text-gray-400">source: {String(r.source)}</p>}
          {r?.options && Object.keys(r.options).length > 0 && (
            <div className="mt-1 border-t border-gray-100 pt-1 space-y-0.5">
              <p className="text-[8.5px] uppercase tracking-wide text-gray-400">options — why offered / why (not) filled</p>
              {Object.entries(r.options).map(([opt, note]) => (
                <p key={opt} className="text-[9.5px] leading-snug text-gray-500"><span className={`font-medium ${/^\s*picked/i.test(String(note)) ? 'text-teal-700' : /^\s*dropped/i.test(String(note)) ? 'text-gray-400' : 'text-gray-700'}`}>{opt}</span> — {String(note)}</p>
              ))}
            </div>
          )}
        </div>
      ); })}</div>
    </>)}
    {considered.length > 0 && (<>
      <Section title="question competition — what competed · what won · why" count={considered.length} />
      {/* basis = WHICH input drove the candidate (cited source:Lnn, or own_knowledge). A surfaced question with no
          basis is one we cannot explain — called out in amber rather than rendered as if it were justified. */}
      <div className="space-y-1">{considered.map((c, i) => (
        <div key={i} className={`rounded-lg border px-2.5 py-1.5 ${c.surfaced ? 'border-teal-100 bg-teal-50/30' : 'border-gray-100 bg-gray-50/50'}`}>
          <div className="flex items-center gap-2">
            <span className={`shrink-0 text-[9px] font-mono ${c.surfaced ? 'text-teal-700' : 'text-gray-400'}`}>{c.surfaced ? `#${c.rank ?? '?'} won` : 'dropped'}</span>
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-gray-800" title={c.candidate}>{c.candidate}</span>
          </div>
          {c.basis ? <EvidenceList ev={[c.basis]} callLabel={callLabel} /> : c.surfaced ? <p className="mt-0.5 text-[9px] text-amber-600">no basis cited — unexplained</p> : null}
          {c.why_ranked && <p className="mt-0.5 text-[9.5px] leading-snug text-gray-600">{String(c.why_ranked)}</p>}
          {!c.surfaced && c.dropped_because && <p className="mt-0.5 text-[9.5px] leading-snug text-gray-400">{String(c.dropped_because)}</p>}
        </div>
      ))}</div>
    </>)}
    {needs.length > 0 && (<>
      <Section title="needs input — couldn't ground; ask the buyer" count={needs.length} />
      <div className="space-y-1">{needs.map((n, i) => (
        <div key={i} className="rounded-lg border border-amber-100 bg-amber-50/40 px-2.5 py-1.5">
          <div className="text-[11px] font-medium text-gray-800">{n.attribute}</div>
          {n.missing_reason && <p className="mt-0.5 text-[10px] text-gray-500">{String(n.missing_reason)}</p>}
          {n.best_next_question && <p className="text-[10px] text-teal-700">→ {String(n.best_next_question)}</p>}
        </div>
      ))}</div>
    </>)}
  </>);
}
// One planner's structured debug: its questions (+chips) then the reasoning/competition/needs_input tables. Parsed from
// the captured raw output so the panel stays self-contained. Renders nothing until that planner has actually run.
function PlannerDebugBlock({ title, rawOut, callLabel }: { title: string; rawOut?: string; callLabel?: string }) {
  if (!rawOut) return null;
  let plan: { questions?: Array<Record<string, unknown>>; metadata?: PlanMeta } | null = null;
  try { plan = JSON.parse(rawOut); } catch { return <p className="mt-2 text-[10px] text-amber-600">{title}: output did not parse as JSON.</p>; }
  const qs = plan?.questions ?? []; const meta = plan?.metadata;
  const hasMeta = !!meta && ((!!meta.reasoning && Object.keys(meta.reasoning).length > 0) || (Array.isArray(meta.considered) && meta.considered.length > 0) || (Array.isArray(meta.needs_input) && meta.needs_input.length > 0));
  if (!qs.length && !hasMeta) return null;
  return (<>
    <Section title={title} count={qs.length ? `${qs.length} questions` : undefined} />
    {qs.length > 0 && <div className="space-y-1">{qs.map((q, i) => (
      <div key={i} className="rounded-lg border border-gray-100 bg-gray-50/60 px-2.5 py-1.5">
        <div className="flex items-start gap-1.5">
          <span className="shrink-0 rounded bg-gray-200 px-1 text-[9px] font-bold uppercase text-gray-600">{String(q.ui ?? 'ask')}</span>
          <span className="min-w-0 flex-1 text-[11px] font-medium text-gray-800">{String(q.label ?? q.field ?? '')}</span>
        </div>
        {Array.isArray(q.options) && q.options.length > 0 && <div className="mt-0.5 flex flex-wrap gap-1">{(q.options as unknown[]).map((o, j) => <span key={j} className="rounded bg-white px-1 text-[9px] text-gray-500 ring-1 ring-gray-200">{String(o)}</span>)}</div>}
        {q.value ? <p className="mt-0.5 text-[10px] text-teal-700">value: {String(q.value)}</p> : null}
      </div>
    ))}</div>}
    <MetaDebug meta={meta} callLabel={callLabel} />
  </>);
}

// ─── Consumption Ladder rendering ────────────────────────────────────────────
// A dense matrix in a ~380px rail: stage INITIALS as column heads (legend below the table), one glyph
// per cell, everything else in the tooltip and the expanded row. The glyph vocabulary is deliberately
// small and the two ambiguous states are visually distinct from the two definite ones:
//   ✓ reached   ◐ reached but only some fields survived   ✗ stopped here   – not applicable
//   ? not computable (NEVER a ✗ — absence of evidence is not evidence of absence)   ⋯ unverified
//   ~ suffix    this cell came from a heuristic, not from an accounting record
const MARK_GLYPH: Record<Mark, { g: string; c: string }> = {
  yes: { g: '✓', c: 'text-teal-600' },
  no: { g: '✗', c: 'text-red-500' },
  na: { g: '–', c: 'text-gray-300' },
  unknown: { g: '?', c: 'text-amber-500' },
  unverified: { g: '⋯', c: 'text-gray-400' },
};
function LadderCell({ c }: { c: LadderCellData }) {
  const partial = c.mark === 'yes' && c.of != null && c.n != null && c.n < c.of;
  const g = partial ? { g: '◐', c: 'text-amber-600' } : MARK_GLYPH[c.mark];
  const n = c.mark === 'yes' && c.of == null && c.n != null && c.n > 0 ? (c.n > 99 ? '99+' : String(c.n)) : '';
  return (
    <span title={c.why} className={`inline-flex w-[22px] shrink-0 items-baseline justify-center align-middle ${g.c}`}>
      <span className="text-[10px] leading-none">{g.g}</span>
      {n && <span className="text-[7px] leading-none text-gray-400">{n}</span>}
      {c.soft && <span className="text-[7px] leading-none text-gray-300">~</span>}
    </span>
  );
}
function LadderRow({ f }: { f: FacetLadder }) {
  const [open, setOpen] = useState(false);
  const badBridge = !!f.bridge && !f.bridge.ok && f.carriedData;
  const broke = (f.diesAt && f.diesAt !== 'parsed') || badBridge;
  return (
    <div className={`border-b border-gray-50 last:border-0 ${broke ? 'bg-red-50/40' : ''}`}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-px py-1 text-left">
        <span className={`min-w-0 flex-1 truncate pr-1 text-[10px] ${broke ? 'font-medium text-red-700' : 'text-gray-600'}`} title={f.id}>
          {badBridge && <span title={f.bridge!.why} className="mr-0.5 text-red-500">⛓</span>}{f.label}
        </span>
        {STAGE_META.map((s) => <LadderCell key={s.key} c={f.stages[s.key]} />)}
      </button>
      {open && (
        <div className="mb-1.5 space-y-1 rounded bg-gray-50 px-2 py-1.5">
          <p className="font-mono text-[9px] text-gray-400">{f.id}</p>
          {f.note && <p className="text-[9.5px] leading-snug text-indigo-700">{f.note}</p>}
          {f.bridge && (
            <p className={`text-[9.5px] leading-snug ${f.bridge.ok ? 'text-gray-500' : 'text-red-700'}`}>
              <span className="mr-1 text-gray-400">bridge</span>{f.bridge.why}
            </p>
          )}
          {STAGE_META.map((s) => {
            const c = f.stages[s.key];
            return (
              <p key={s.key} className="text-[9.5px] leading-snug text-gray-500">
                <span className="mr-1 inline-block w-[54px] shrink-0 text-gray-400">{s.name}</span>
                <LadderCell c={c} />{' '}
                {c.why}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── PAGE-BY-PAGE STORY (#2, owner) ────────────────────────────────────────────
// "For each page what is happening, that part of debug should be visible." One plain sentence per form page — what
// we did, and (where there's a real reason) why — read straight off the same telemetry the rest of the panel uses:
// the captured LLM output for that page's planner, the LLM-1→form consumption ledger, and the live form state.
// Deliberately BEFORE the technical scorecard, so the plain narrative is what a CEO sees first.
function countUiSplit(output: string | undefined, nestedUnderPage1: boolean): { asked: number; filled: number } | null {
  if (!output) return null;
  try {
    const j = JSON.parse(output) as Record<string, unknown>;
    const qs = (nestedUnderPage1 ? (j.page1 as { questions?: unknown } | undefined)?.questions : j.questions) as Array<{ ui?: string }> | undefined;
    if (!Array.isArray(qs)) return null;
    const asked = qs.filter((q) => q.ui === 'ask').length;
    return { asked, filled: qs.length - asked };
  } catch { return null; }
}
function PageFlow({ sources, raw, live, consumption }: {
  sources: { source: string; ok: boolean }[]; raw: Record<string, { output?: string } | undefined>;
  live?: LiveState; consumption?: ConsumptionState;
}) {
  const okN = sources.filter((s) => s.ok).length;
  // Prefer the form's own consumption ledger (the authoritative record of what it DID with LLM 1's verdict);
  // fall back to re-parsing the captured output only if that ledger hasn't been published yet this session.
  let trustworthy: boolean | undefined = consumption?.category_trustworthy;
  if (trustworthy === undefined) {
    try { trustworthy = (JSON.parse(raw['requirement-brain']?.output ?? '{}') as { brain?: { category_trustworthy?: boolean } })?.brain?.category_trustworthy; } catch { /* not run / not parseable yet */ }
  }
  const p1 = countUiSplit(raw['requirement-brain']?.output, true);
  const p2 = countUiSplit(raw['commercial-planner']?.output, false);
  const p3 = countUiSplit(raw['persona-planner']?.output, false);
  const hasContact = !!live?.contactName?.trim();
  const hasLoc = !!(live?.deliveryLocation?.trim() || live?.userLocation?.trim());
  const rows: { page: string; sentence: string; why?: string }[] = [
    {
      page: 'Before he picked a product',
      sentence: sources.length
        ? `We looked at ${okN} of ${sources.length} things we already know about him — his past searches, past requirements, his account, WhatsApp and his calls — before asking him anything.`
        : 'No history checks have run yet this session.',
    },
    {
      page: 'Specifications (page 1)',
      sentence: p1 ? `We asked him ${p1.asked} question${p1.asked === 1 ? '' : 's'} and filled in ${p1.filled} for him from what we already knew.` : 'Not reached yet this session.',
      why: p1 ? (trustworthy === false
        ? "The product category didn't look right for what he's buying, so we used what he searched for / browsed instead of the usual question list."
        : 'The usual question list for this category matched what he needs.') : undefined,
    },
    {
      page: 'Buying details (page 2)',
      sentence: p2 ? `We asked ${p2.asked} question${p2.asked === 1 ? '' : 's'} about things like delivery, payment and how he buys, and filled in ${p2.filled} from what we already knew.` : 'Not reached yet this session.',
      why: p2 ? 'We only ask what his history and page-1 answers could not already tell us.' : undefined,
    },
    {
      page: 'About the buyer (page 3)',
      sentence: p3 ? `We asked ${p3.asked} question${p3.asked === 1 ? '' : 's'} about his business, and filled in ${p3.filled} from what we already knew.` : 'Not reached yet this session.',
      why: p3 ? 'How established his account is (age, past orders, past calls) decides whether we ask or already assume this.' : undefined,
    },
    {
      page: 'Contact & about you (last page)',
      sentence: (hasContact || hasLoc)
        ? `We confirmed ${[hasContact && 'his name', hasLoc && 'his delivery location'].filter(Boolean).join(' and ') || 'his details'}.`
        : 'Not reached yet this session.',
    },
  ];
  return (<>
    <Section title="What happened, page by page" count={rows.length} hint="One plain sentence per form page — what we did there, and why." />
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.page} className="rounded-lg border border-gray-100 bg-gray-50/60 px-2.5 py-2">
          <p className="text-[11px] font-semibold text-gray-800">{r.page}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-gray-600">{r.sentence}</p>
          {r.why && <p className="mt-0.5 text-[10px] leading-snug text-gray-400">Why: {r.why}</p>}
        </div>
      ))}
    </div>
  </>);
}

// ─── BL-AUDIT SELF-CHECK (#66, owner) ──────────────────────────────────────────
// The basics every buy-lead needs, graded against THIS live session — read from window.__rfqLive / __rfqCategory /
// __rfqConsumption (all optional-chained: a missing global must never throw). PASS/CHECK/FAIL + one plain reason.
type AuditStatus = 'pass' | 'warn' | 'fail' | 'na';
function AuditRow({ label, status, reason }: { label: string; status: AuditStatus; reason: string }) {
  const badge: Record<AuditStatus, string> = { pass: 'bg-teal-100 text-teal-800', warn: 'bg-amber-100 text-amber-800', fail: 'bg-red-100 text-red-800', na: 'bg-gray-100 text-gray-500' };
  const word: Record<AuditStatus, string> = { pass: 'PASS', warn: 'CHECK', fail: 'FAIL', na: 'N/A' };
  return (
    <div className="flex items-start gap-2 rounded-lg border border-gray-100 bg-gray-50/60 px-2.5 py-1.5">
      <span className={`mt-px shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${badge[status]}`}>{word[status]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-gray-800">{label}</p>
        <p className="mt-0.5 text-[10px] leading-snug text-gray-500">{reason}</p>
      </div>
    </div>
  );
}
function AuditChecklist({ live, catPub, consumption }: { live?: LiveState; catPub?: CategoryPub; consumption?: ConsumptionState }) {
  const name = live?.contactName?.trim() ?? '';
  const loc = live?.deliveryLocation?.trim() || live?.userLocation?.trim() || '';
  const mcatId = catPub?.mcatId ?? live?.mcatId;
  const trustworthy = consumption?.category_trustworthy;
  const mismatch = !!live?.mcatMismatch;
  const specCount = live?.allSpecEntries?.length ?? 0;
  const qty = live?.quantity?.trim() ?? ''; const unit = live?.unit?.trim() ?? '';
  const title = live?.product?.trim() ?? '';
  const kts = consumption?.knownTruths ?? [];
  const routed = kts.filter((k) => k.action === 'keptAlsoDetected' || k.action === 'routedToQuantity').length;
  const droppedContext = kts.filter((k) => k.action === 'droppedNonSpec').length;

  const rows: { label: string; status: AuditStatus; reason: string }[] = [
    { label: 'Buyer name (at least 3 letters)', status: name.length >= 3 ? 'pass' : name.length > 0 ? 'warn' : 'fail',
      reason: name ? `Captured "${name}" (${name.length} character${name.length === 1 ? '' : 's'}).` : "No name yet — sellers won't know who to quote." },
    { label: 'Location', status: loc ? 'pass' : 'fail',
      reason: loc ? `Set to "${loc}".` : 'No delivery or buyer location captured yet.' },
    { label: 'Product category (MCAT)', status: mismatch ? 'fail' : trustworthy === false ? 'warn' : mcatId ? 'pass' : 'na',
      reason: mismatch ? 'The system flagged that the category looks wrong for this product — worth a human glance.'
        : trustworthy === false ? "The AI judged the category's usual question list untrustworthy for this buyer and used browsed/generated specs instead."
        : mcatId ? `Category ${mcatId} looked right for this product.` : 'No category resolved yet this session.' },
    { label: 'Specifications captured', status: specCount > 0 ? 'pass' : 'warn',
      reason: specCount > 0 ? `${specCount} spec value${specCount === 1 ? '' : 's'} captured. (This check only confirms something was captured — it cannot see which specs this category treats as mandatory.)` : 'No specification values captured yet.' },
    { label: 'Quantity and unit', status: qty && unit ? 'pass' : qty || unit ? 'warn' : 'fail',
      reason: qty && unit ? `${qty} ${unit}.` : qty ? `Quantity "${qty}" captured, but no unit.` : unit ? `Unit "${unit}" set, but no quantity.` : 'No quantity or unit captured yet.' },
    { label: 'Requirement title', status: title ? 'pass' : 'fail',
      reason: title ? `"${title}".` : 'No product/title captured yet.' },
    { label: 'Extra AI-detected info routed correctly', status: kts.length === 0 ? 'na' : 'pass',
      reason: kts.length === 0 ? 'The AI found no extra facts beyond the standard specs this run.' : `${routed} extra fact${routed === 1 ? '' : 's'} kept/routed (e.g. to "also detected" or quantity), ${droppedContext} identity/context fact${droppedContext === 1 ? '' : 's'} correctly kept OFF the spec list.` },
  ];
  const passN = rows.filter((r) => r.status === 'pass').length;
  return (<>
    <Section title="Buy-lead audit self-check" count={`${passN}/${rows.length} pass`} hint="The basics every buy-lead needs, graded against THIS session." />
    <div className="space-y-1">{rows.map((r) => <AuditRow key={r.label} {...r} />)}</div>
  </>);
}

export default function BrainDebugPanel({ p, onClose }: { p: RequirementBrainPayload; onClose: () => void }) {
  const [, force] = useState(0);
  useEffect(() => onLLMActivity(() => force((n) => n + 1)), []); // re-render as LLM calls land
  // Persona switch (RFQ-DEBUG-PLAN.md §Combined): one control sets DEFAULT depth — CEO opens on the Story card,
  // Engineer on the raw mechanics; everyone can scroll past their default into the deeper sections. Persisted so a
  // reviewer keeps their lens across the panel's re-mounts.
  const [persona, setPersona] = useState<Persona>(() => { try { return (localStorage.getItem('rfqDebugPersona') as Persona) || 'pm'; } catch { return 'pm'; } });
  const pickPersona = (x: Persona) => { setPersona(x); try { localStorage.setItem('rfqDebugPersona', x); } catch { /* private mode */ } };
  const depth = PERSONA_DEPTH[persona];
  const m = p.metadata, o = p.observability, ds = o.decision_summary;
  const health = getLLMHealth(); const raw = getLLMRaw(); const rawById = getLLMRawById();
  // #79/owner: LLM 4 (profile-synth) is gone from debug — filter its records out of the whole panel (calls list, token/
  // cost totals, trace, replay) so it neither shows nor counts. It still runs debug-only in the form but nothing reads it.
  const llm = [...health].filter((r) => r.label !== 'profile-synth').sort((a, b) => b.at - a.at);
  // I-fix: the per-field consumption ledger published by BrainRFQForm (LLM 1 output → form action → why).
  const consumption = (globalThis as unknown as { __rfqConsumption?: ConsumptionState }).__rfqConsumption;
  const ktVerdict = new Map((consumption?.knownTruths ?? []).map((k) => [k.key, k.action]));
  const totalTok = llm.reduce((s, r) => s + (r.promptTokens ?? 0) + (r.completionTokens ?? 0), 0);
  // The COMPLETE category corpus (owner: "all of it is rendered in the debug, like all questions from 1 till last").
  const catPub = (globalThis as unknown as { __rfqCategory?: CategoryPub }).__rfqCategory;
  // WS-5: which of the three LLMs a call belongs to (grouping the flat call list), and the SOURCES that fed it —
  // parsed straight from the fence tags in the captured USER prompt so "which sources went into each call" is exact,
  // not inferred. `empty` = the fence rendered `(none)`, so the chip greys out (source present but carried no data).
  const llmGroup = (label: string) => label === 'requirement-brain' ? 'LLM 1 · Requirement Brain' : label === 'commercial-planner' ? 'LLM 2 · Commercial' : label === 'persona-planner' ? 'LLM 3 · Persona' : 'Other calls';
  const LLM_GROUPS = ['LLM 1 · Requirement Brain', 'LLM 2 · Commercial', 'LLM 3 · Persona', 'Other calls'];
  const sourcesOf = (user?: string): { tag: string; empty: boolean }[] => {
    if (!user) return [];
    const out: { tag: string; empty: boolean }[] = []; const re = /<([a-z0-9_]+)>\n([\s\S]*?)\n<\/\1>/g; let m: RegExpExecArray | null;
    while ((m = re.exec(user))) out.push({ tag: m[1], empty: m[2].trim() === '(none)' });
    return out;
  };
  const SourceChips = ({ user }: { user?: string }) => { const s = sourcesOf(user); if (!s.length) return null; return (
    <div className="mt-1 flex flex-wrap items-center gap-1"><span className="text-[9px] uppercase tracking-wide text-gray-400">sources</span>{s.map((x) => <span key={x.tag} className={`rounded px-1 py-0.5 text-[9px] font-mono ${x.empty ? 'bg-gray-100 text-gray-400' : 'bg-teal-50 text-teal-700'}`}>{x.tag}{x.empty ? ' ∅' : ''}</span>)}</div>
  ); };
  const totalCost = llm.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  // #G — the LIVE leaf + 3-LLM telemetry (not the retired monolith payload): sources light up as they return,
  // and the live form state is published to window.__rfqLive by BrainRFQForm.
  const sources = getSourceHealth();
  // The persona rollups (L1 Story / L2 Scorecard) are one pure aggregation over the three telemetry streams the panel
  // already holds — LLM call records + captured raw I/O (planner outputs) + source health. debugTrace.ts owns the math.
  const trace = buildRunTrace(llm, raw, sources, canonConcept);
  // The brain's plain-language understanding (for the CEO Story card) — lifted from the captured LLM-1 output.
  const brainUnderstanding = (() => { try { const j = JSON.parse(raw['requirement-brain']?.output || '{}'); return (j?.brain?.understanding || j?.page1?.brain?.understanding || '') as string; } catch { return ''; } })();
  // #8 (owner) — LLM 1's FULL read (understanding / persona / category-trust / evidence), parsed at TOP LEVEL so it can
  // render as the panel's LEAD card (was buried inside the understand IIFE). null until LLM 1 resolves → the card shows
  // a waiting state instead of a blank top. Mirrors the brainUnderstanding parse above; same requirement-brain output.
  const brainRead = (() => { try { const j = JSON.parse(raw['requirement-brain']?.output || '{}'); const b = j?.brain ?? j?.page1?.brain; return (b && typeof b === 'object') ? b as { understanding?: string; persona_read?: string; category_trustworthy?: boolean; evidence?: string[] } : null; } catch { return null; } })();
  // REPLAY BUNDLE (#8, Engineer) — serialise the exact inputs+telemetry of THIS run so a bug reproduces offline
  // (the manual `scripts/*-probe.mjs` flow, as a one-click download). User-initiated; nothing leaves the machine.
  const exportReplay = () => {
    const glid = (globalThis as unknown as { __rfqGlid?: string }).__rfqGlid;
    const bundle = { schema: 'rfq-replay/1', glid, product: (globalThis as unknown as { __rfqLive?: { product?: string } }).__rfqLive?.product,
      sources: sources.map((s) => ({ source: s.source, ok: s.ok, ms: s.ms, raw: s.raw, cleaned: s.cleaned })),
      llm: llm.map((r) => ({ label: r.label, ms: r.ms, status: r.status, model: r.model, costUsd: r.costUsd, parseOk: r.parseOk })),
      raw, live: (globalThis as unknown as { __rfqLive?: unknown }).__rfqLive, category: catPub, trace };
    try {
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `rfq-replay-${glid || 'run'}.json`; a.click(); URL.revokeObjectURL(url);
    } catch { /* download blocked — noop */ }
  };
  // Widened for the BL-audit self-checklist (#66, owner) — BrainRFQForm now also publishes contactName/
  // userLocation/deliveryLocation/mcatId/mcatMismatch/allSpecEntries/extraSpecs/requirementNotes here. Every read
  // below is `?.`-guarded so an older/partial publish (or a session that hasn't reached that field yet) never throws.
  const live = (globalThis as unknown as { __rfqLive?: LiveState }).__rfqLive;
  const rfqGlid = (globalThis as unknown as { __rfqGlid?: string }).__rfqGlid;
  // CLICK-TO-SOURCE state (#4) — which citation was last clicked, shared by every evidence chip via CiteCtx.
  const [jump, setJump] = useState<Jump>(null);
  const cite = (call: string, tag: string, line: number) => setJump({ call, tag, line });
  const nodeHealth = o.node_health ?? {}; const nodeRaw = (o.node_raw ?? {}) as Record<string, unknown>;
  // #4d — the engine-era sections (decision summary · consumption ladder · node data · decisions · routing) only
  // make sense for a LEGACY monolith payload. On the 3-LLM leaf flow (?rfq=brain) there are no engine decisions or
  // node-health, so those sections are hidden — otherwise they render "0/0 nodes · 0 decisions" + an all-"?" ladder
  // describing a retired pipeline. The live flow is the Sources / LLM-calls / Requirement-Brain / form-state sections.
  const hasEngine = p.decisions.length > 0 || Object.keys(nodeHealth).length > 0;
  const healthyN = Object.values(nodeHealth).filter((h) => h.status === 'green').length;
  const shown = p.decisions.filter((d) => d.action !== 'SUPPRESS');
  const suppressed = p.decisions.filter((d) => d.action === 'SUPPRESS');
  // Evidence dictionary (engine v7+). `evIndex` null ⇒ older engine emitted only a count, so ev_N can't resolve —
  // we say so in the UI rather than rendering a dead id that looks like a working audit trail.
  const evAtoms = o.evidence ?? [];
  const evIndex = evAtoms.length ? new Map(evAtoms.map((a) => [a.id, a])) : null;
  const evUsed = new Set(p.decisions.flatMap((d) => d.evidence ?? []));   // atoms that actually reached a decision
  // Map an atom back to the node that produced it. atom.source is the SIGNAL vocabulary
  // (posted/viewed/searched/discussed_wa/interested) or a '+'-joined cluster; node keys are csl/rfq/whatsapp/…
  const nodeOf = (a: { source?: string }): string => {
    const s = String(a.source ?? '');
    if (/posted/.test(s)) return 'rfq';
    if (/discussed_wa|whatsapp/.test(s)) return 'whatsapp';
    if (/viewed|searched/.test(s)) return 'csl';
    if (/interested|profile|kyb/.test(s)) return 'profile';
    if (/call|pns|vani/.test(s)) return 'calls';
    if (/categor/.test(s)) return 'category';
    return '';
  };

  return (
    <CiteCtx.Provider value={{ jump, cite }}>
    <div className="h-full overflow-y-auto bg-white text-[12.5px] text-gray-700">
      <div className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 font-bold text-gray-900">🔬 Observability &amp; eval</h2>
          <button onClick={onClose} className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-200">✕</button>
        </div>
        {/* Persona lens — sets which layer opens by default (L1 Story · L2 Scorecard · L3 Decision-trace + mechanics). */}
        <div className="mt-1.5 flex items-center gap-1">
          <span className="text-[9px] uppercase tracking-wide text-gray-400">lens</span>
          {(['ceo', 'coo', 'hod', 'pm', 'engineer'] as Persona[]).map((x) => (
            <button key={x} onClick={() => pickPersona(x)}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition ${persona === x ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
              {PERSONA_LABEL[x]}
            </button>
          ))}
          <span className="ml-auto text-[9px] text-gray-400">L{depth}</span>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          <span className={sources.length && sources.every((s) => s.ok) ? 'text-teal-700' : 'text-amber-700'}>{sources.filter((s) => s.ok).length}/{sources.length} sources</span>
          {' · '}{llm.length} AI calls · {totalTok.toLocaleString()} words read · ${totalCost.toFixed(4)}
          {hasEngine && <> · <span className={healthyN === Object.keys(nodeHealth).length ? 'text-teal-700' : 'text-amber-700'}>{healthyN}/{Object.keys(nodeHealth).length} nodes</span> · {ds.evidence} evidence → {ds.total_decisions} decisions · {m.versions?.brain}</>}
        </p>
      </div>

      <div className="px-4 pb-6">
        {/* ══ #8 (owner) · LLM 1'S READ — the panel's LEAD card, distinct indigo accent, at the very top. Moved up
            out of the understand IIFE so the first thing the reviewer sees is the brain's read of this buyer. ══════ */}
        <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50/50 px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700">requirement brain — LLM 1&apos;s read of this buyer</p>
          {brainRead ? (
            <div className="mt-1 space-y-1">
              {brainRead.understanding && <p className="text-[10.5px] leading-snug text-gray-700"><span className="text-gray-400">understanding:</span> {brainRead.understanding}</p>}
              {brainRead.persona_read && <p className="text-[10.5px] leading-snug text-gray-700"><span className="text-gray-400">persona read:</span> {brainRead.persona_read}</p>}
              {brainRead.category_trustworthy !== undefined && <p className="text-[10.5px] text-gray-700"><span className="text-gray-400">category trustworthy:</span> {String(brainRead.category_trustworthy)}</p>}
              {Array.isArray(brainRead.evidence) && brainRead.evidence.length > 0 && (
                <div className="text-[10.5px] leading-snug text-gray-700"><span className="text-gray-400">evidence:</span> <EvidenceList ev={brainRead.evidence} callLabel="requirement-brain" /></div>
              )}
            </div>
          ) : <p className="mt-1 text-[10.5px] italic text-gray-400">waiting for LLM 1&apos;s read…</p>}
        </div>

        {/* ══ #2 (owner) · ARCHITECTURE REVIEW — how the pipeline fires (always visible) + THIS run's story detail
            (collapsed by default). Merges the old "How the AI fires" explainer with the LAYER-1 STORY card. ══════════ */}
        <Section title="Architecture review" />
        <div className="rounded-lg border border-gray-100 bg-gray-50 px-2.5 py-2 text-[10px] leading-relaxed text-gray-500">
          <span className="font-semibold text-gray-600">How the AI fires:</span> mic / photo / chat first pull just the product + quantity (LLM&nbsp;0), and committing the product loads the category’s spec list.
          Everything he gives on the landing — chat, mic, photo, typed — is bundled and handed to <b className="text-gray-700">LLM&nbsp;1</b> the moment he <b>lands on page&nbsp;1</b>; it prefills the specs (quantity included, even for unit-less categories) and decides the questions.
          <b className="text-gray-700">LLM&nbsp;2</b> (buying details) fires when he <b>lands on page&nbsp;2</b>, and <b className="text-gray-700">LLM&nbsp;3</b> (about-you) when he <b>lands on page&nbsp;3</b> — each takes LLM&nbsp;1’s read + the form filled so far (see <span className="font-mono">page1_state</span> / <span className="font-mono">page2_state</span> in their prompts below), so page&nbsp;3 sees the most. Look for <span className="font-mono">buyer_session_input</span> in LLM&nbsp;1’s prompt.
        </div>
        {trace.story.total > 0 && (
          <Row head={<span className="text-[11px] font-medium text-gray-700 tabular-nums">This run · {trace.story.knew} of {trace.story.total} known — we asked only {trace.story.asked}</span>}>
            <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-gray-50 to-white p-3">
              {brainUnderstanding && <p className="text-[11.5px] leading-snug text-gray-600">{brainUnderstanding}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${trace.story.invented === 0 ? 'bg-teal-100 text-teal-800' : 'bg-red-100 text-red-800'}`}>
                  {trace.story.invented === 0 ? '✓ Nothing made up' : `⚠ ${trace.story.invented} value(s) we could not back up`}
                </span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">a form no other buyer gets</span>
              </div>
              {depth <= 1 && trace.story.prefilledFields.length > 0 && (
                <p className="mt-1.5 text-[10px] text-gray-400">knew: {trace.story.prefilledFields.slice(0, 8).join(' · ')}{trace.story.prefilledFields.length > 8 ? ' …' : ''}</p>
              )}
            </div>
          </Row>
        )}

        {/* ══ PAGE-BY-PAGE STORY (#2, owner) — "for each page what is happening" in one plain sentence, before the
            technical scorecard. Sits right after the CEO headline number so the CEO's real ask (what happened, on
            each page, and why) is answered before anything acronym-shaped shows up. */}
        <PageFlow sources={sources} raw={raw} live={live} consumption={consumption} />

        {/* ══ BL-AUDIT SELF-CHECK (#66, owner) — the basics every buy-lead needs, graded against THIS live session. ══ */}
        <AuditChecklist live={live} catPub={catPub} consumption={consumption} />

        {/* ══ LAYER 2 · SCORECARD (HOD / COO) — the rollup + the exceptions, not per-question ══════════════════════
            TUS↑ (truth utilised) · BES↓ (buyer effort proxy) · per-source contribution · cost/latency · what failed.
            For the CEO lens (depth 1) this collapses to the single KPI line; HOD/COO/PM/Engineer see the full card.
            Plain words lead now — TUS/BES/etc ride along in a tooltip for whoever wants the technical name (#1). */}
        <div className={`mt-2 rounded-xl border border-gray-200 bg-white p-2.5 ${depth <= 1 ? 'opacity-70' : ''}`}>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
            <Term def="Techs call this TUS (Truth Utilisation Score) — the share of everything we filled in that came from what we already knew about him, rather than asking.">
              <b className="text-teal-700 tabular-nums">Used what we knew: {trace.kpi.tusPct}%</b>
            </Term>
            <Term def="Techs call this BES (Buyer Effort Score) — a rough points-total for how much clicking/typing/correcting we made him do. Lower is better.">
              <span className="text-gray-500">Buyer effort <b className="text-gray-800 tabular-nums">{trace.kpi.besProxy}</b></span>
            </Term>
            <span className={sources.every((s) => s.ok) && sources.length ? 'text-teal-700' : 'text-amber-700'}>{sources.filter((s) => s.ok).length}/{sources.length} sources</span>
            <span className={trace.gates.fabrications === 0 && trace.gates.dedupViolations === 0 && trace.ops.parseFailures === 0 ? 'text-gray-500' : 'text-red-700'}>
              <Term def="A prefilled value with no evidence behind it — a made-up answer.">{trace.gates.fabrications} made up</Term>
              {' · '}
              <Term def="The same question shown to him more than once.">{trace.gates.dedupViolations} repeated</Term>
              {' · '}
              <Term def="The AI answered, but we could not read/parse what it sent back.">{trace.ops.parseFailures} unreadable</Term>
            </span>
            <span className="text-gray-500 tabular-nums">${trace.ops.totalCostUsd.toFixed(4)}</span>
            <span className="text-gray-500 tabular-nums">{(trace.ops.llmMs / 1000).toFixed(1)}s thinking time</span>
            {trace.ops.slowestSource && <span className="text-gray-400">slowest to answer: {trace.ops.slowestSource.source} {trace.ops.slowestSource.ms}ms</span>}
          </div>
          {depth >= 2 && (<>
            {/* per-source contribution — the "every source must contribute or it's a red row" invariant */}
            <div className="mt-2 flex flex-wrap gap-1">
              {trace.contribution.map((c) => (
                <span key={c.source} className={`rounded px-1.5 py-0.5 text-[9px] font-mono ${c.ok ? 'bg-teal-50 text-teal-700' : 'bg-red-50 text-red-600'}`}>{c.source} {c.ok ? `${c.ms}ms` : '∅'}</span>
              ))}
              {trace.contribution.length === 0 && <span className="text-[10px] text-gray-400">no sources fetched yet</span>}
            </div>
            {/* exceptions only — the 3 things that went wrong this run */}
            {trace.exceptions.length > 0 && (
              <ul className="mt-2 space-y-0.5 border-t border-gray-100 pt-1.5">
                {trace.exceptions.map((e, i) => <li key={i} className="text-[10px] text-red-600">⚠ {e}</li>)}
              </ul>
            )}
            {trace.exceptions.length === 0 && <p className="mt-1.5 text-[10px] text-teal-700">✓ no exceptions this run</p>}
            <button onClick={exportReplay} className="mt-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] font-medium text-gray-600 hover:bg-gray-100">
              ⬇ Copy replay bundle (JSON)
            </button>
          </>)}
        </div>

        {/* ── DATA FLOW (this session) — the LIVE leaf + 3-LLM architecture in FORM ORDER (owner 2026-07-30) ──────
            Landing/commit SOURCES (green the moment each returns, with raw · cleaned · latency) → what LLM 1/2/3
            were handed + returned (the "LLM calls" section below shows each prompt+output in fire order). The
            engine-era sections further down (consumption ladder / node data / decisions) are INERT on ?rfq=brain —
            they read the retired monolith payload, hence "0/0 nodes". */}
        <Section title="Where his information came from" count={`${sources.filter((s) => s.ok).length}/${sources.length} answered`}
          hint="Every place we checked for facts about this buyer before asking him anything ourselves. RAW = exactly what came back; CLEANED = what we made of it, by which code, and why." />
        {sources.length === 0 ? <p className="text-[11px] text-gray-400">no leaf sources fetched yet this session.</p> : sources.map((s, i) => {
          // #15 + #12 (deep-audit 2026-08-12): a CONTRADICTED row (0 rows but the profile says calls exist) is a RED
          // upstream/auth failure — visually distinct from an honestly-quiet buyer (amber, profile agrees). A silently
          // downgraded PNS 'full' request also carries a chip so the panel never asserts transcription that did not run.
          const cl = (s.cleaned && typeof s.cleaned === 'object') ? s.cleaned as Record<string, unknown> : null;
          const contradicted = cl?.contradicted === true;
          const quiet = !s.ok && !contradicted && /profile agrees|no calls/i.test(String(cl?.verdict ?? ''));
          const downgraded = cl?.downgraded === true;
          const tone = contradicted ? 'red' : s.ok ? 'green' : quiet ? 'amber' : 'red';
          const info = sourceInfoFor(s.source); // #3 — plain "what for" + endpoint + which code cleaned it + why
          return (
          <Row key={i} tone={tone}
            head={<span className="font-medium text-gray-800">{s.source}
              {contradicted && <span className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[9px] font-semibold text-red-700">CONTRADICTED · profile {String(cl?.profile_claims_calls ?? '?')} calls, API 0</span>}
              {downgraded && <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-semibold text-amber-700">full→{String(cl?.mode_effective ?? 'api')} · not supported</span>}
            </span>}
            sub={<span className="shrink-0 text-[10px] text-gray-400">{s.ms}ms{contradicted ? ' · CONTRADICTED' : quiet ? ' · quiet (profile agrees)' : s.ok ? '' : ' · empty/err'}</span>}>
            {info && <p className="mb-1.5 text-[10.5px] leading-snug text-gray-600">{info.what}</p>}
            <div className="text-[10px] font-semibold text-gray-500">RAW <span className="font-normal text-gray-400">— straight off the n8n endpoint, nothing changed</span></div>
            {info && <p className="mb-0.5 font-mono text-[9.5px] text-gray-400">{info.endpoint}{rfqGlid ? `?glid=${rfqGlid}` : ''}</p>}
            <Pre v={s.raw} />
            <div className="mt-2 text-[10px] font-semibold text-gray-500">CLEANED <span className="font-normal text-gray-400">— what the form actually used</span></div>
            {info && <p className="mb-0.5 text-[9.5px] leading-snug text-gray-500"><span className="text-gray-400">cleaned by</span> <span className="font-mono">{info.cleanFn}</span> <span className="text-gray-400">in</span> <span className="font-mono">{info.cleanFile}</span> <span className="text-gray-400">—</span> {info.why}</p>}
            <Pre v={s.cleaned} />
          </Row>
          );
        })}


        {/* ENGINE-ERA sections (decision summary · consumption ladder) — legacy monolith payload only; hidden on
            the 3-LLM leaf flow so the panel doesn't show "0 decisions" + an all-"?" ladder for a retired pipeline. */}
        {hasEngine && (<>
        {/* DECISION SUMMARY */}
        <Section title="decision summary" />
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded bg-teal-100 px-1.5 py-0.5 text-[10px] font-semibold text-teal-800">{ds.questions_avoided} avoided</span>
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">{ds.questions_generated} asked</span>
          {ds.conflicts_resolved > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800">{ds.conflicts_resolved} conflict</span>}
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600">{ds.suggestions_offered} suggested</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">{ds.suppressed} suppressed</span>
        </div>

        {/* CONSUMPTION LADDER — the instrument that makes the next data-consumption gap self-reporting.
            Every one of this codebase's shipped consumption bugs was the same disease at a different rung:
            parsed-then-dropped, accepted-and-never-passed, decided-and-never-rendered, green-on-empty.
            One row per source-facet, one column per stage. A facet that reaches a stage and STOPS is the
            whole point, so it is tinted red and named in the headline. Nothing here is allowed to flatter
            us: a stage we cannot compute renders '?', never a ✓ and never a ✗. */}
        {(() => {
          const pio = raw['curated-planner'];
          const lad = buildLadder(p, pio?.user, pio?.output);
          const name = (f: FacetLadder) => f.id;
          const groups: { node: string; label: string; rows: FacetLadder[] }[] = [];
          for (const f of lad.facets) {
            const key = f.node ?? 'client';
            const g = groups.find((x) => x.node === key);
            if (g) g.rows.push(f); else groups.push({ node: key, label: key === 'client' ? 'client-side inputs (not in the brain payload)' : key === 'profile' ? 'profile enrichment' : key, rows: [f] });
          }
          const dieNames = lad.dying.map(name);
          return (<>
            <Section title="consumption ladder — where each signal stops" count={`${lad.facets.length} facets`} />

            {/* THE KPI. `M` is deliberately the facets that actually CARRIED DATA — a source that returned
                nothing has not "died", it was simply empty, and mixing the two would hide the real number. */}
            <div className={`rounded-lg px-2.5 py-2 ${lad.dying.length ? 'bg-red-50' : 'bg-teal-50'}`}>
              <p className={`text-[15px] font-bold leading-none ${lad.dying.length ? 'text-red-700' : 'text-teal-700'}`}>
                {lad.dying.length} <span className="text-[11px] font-normal text-gray-500">of {lad.m}</span>
              </p>
              <p className="mt-0.5 text-[10.5px] leading-snug text-gray-700">
                facets carried real data and <span className="font-semibold">die before reaching a decision</span>
                {lad.unverifiable.length ? <span className="text-gray-500"> · {lad.unverifiable.length} more unverifiable</span> : null}
              </p>
              {dieNames.length > 0 && (
                <p className="mt-1 font-mono text-[9.5px] leading-relaxed text-red-700">{dieNames.join(' · ')}</p>
              )}
              {lad.unverifiable.length > 0 && (
                <p className="mt-1 text-[9.5px] leading-snug text-amber-700">
                  ? {lad.unverifiable.map(name).join(' · ')} — {!lad.hasEvidenceDict ? 'the engine emitted no evidence dictionary, so decisions[].evidence ids dangle and engine-side attribution is unauditable.' : ''}{!lad.plannerRun ? ' No curated-planner call has been captured this session, so the planner columns cannot be read yet — pick a product and they fill in.' : ''}
                </p>
              )}
              {lad.notRendered.length > 0 && (
                <p className="mt-1 text-[10px] leading-snug text-red-700">
                  ⚠ {lad.notRendered.length} of the {lad.reachedDecision.length} facets that DID reach a decision are never rendered: <span className="font-mono">{lad.notRendered.map(name).join(' · ')}</span> — decided and thrown away.
                </p>
              )}
              {/* The bridge count is the one break that is provable with NO live planner run: node_raw is a
                  debug channel, and what the planner is fed comes out of metadata.* via brainToSeed. */}
              {lad.brokenBridges.length > 0 && (
                <p className="mt-1 text-[10px] leading-snug text-red-700">
                  ⛓ {lad.brokenBridges.length} facet{lad.brokenBridges.length === 1 ? ' is' : 's are'} rich in node_raw but dead in the <span className="font-mono">metadata.*</span> slot the form adapter actually reads: <span className="font-mono">{lad.brokenBridges.map((f) => `${name(f)}→${f.bridge?.via}`).join(' · ')}</span>. Provable without a planner run.
                </p>
              )}
              {lad.dying.length === 0 && lad.unverifiable.length === 0 && lad.notRendered.length === 0 && lad.brokenBridges.length === 0 && (
                <p className="mt-1 text-[10px] text-teal-700">Every facet that carried data reached a decision and a control. Re-check when a source is added.</p>
              )}
            </div>

            {/* Column heads — stage initials, hover for the full definition of how each is computed. */}
            <div className="mt-2 flex items-center gap-px border-b border-gray-200 pb-1">
              <span className="min-w-0 flex-1 pr-1 text-[9px] uppercase tracking-wide text-gray-400">facet</span>
              {STAGE_META.map((s) => (
                <span key={s.key} title={`${s.name} — ${s.how}`} className="w-[22px] shrink-0 text-center text-[8.5px] font-semibold text-gray-500">{s.abbr}</span>
              ))}
            </div>

            {groups.map((g) => (
              <div key={g.node}>
                <p className="mt-1.5 text-[9px] font-semibold uppercase tracking-wide text-gray-400">{g.label}</p>
                {g.rows.map((f) => <LadderRow key={f.id} f={f} />)}
              </div>
            ))}

            <Row head={<span className="text-[10px] text-gray-500">legend · how each column is computed</span>}>
              <div className="space-y-1 rounded bg-gray-50 px-2 py-1.5">
                <p className="text-[9.5px] text-gray-600">
                  <span className="text-teal-600">✓</span> reached ·{' '}
                  <span className="text-amber-600">◐</span> reached, but only some of the facet&apos;s fields survived ·{' '}
                  <span className="text-red-500">✗</span> stopped here ·{' '}
                  <span className="text-gray-300">–</span> not applicable ·{' '}
                  <span className="text-amber-500">?</span> not computable ·{' '}
                  <span className="text-gray-400">⋯</span> unverified ·{' '}
                  <span className="text-gray-400">~</span> heuristic, not an accounting record ·{' '}
                  <span className="text-red-500">⛓</span> broken bridge
                </p>
                <p className="text-[9.5px] leading-snug text-gray-500">
                  <span className="font-semibold text-gray-600">⛓ bridge</span> — node_raw is a DEBUG channel; what the planner is fed is built by brainToSeed out of <span className="font-mono">metadata.*</span>. A facet can be an honest Parsed ✓ and still be dead on arrival because its metadata slot is empty. This break is provable with no planner run at all, and it does not show up in any column.
                </p>
                <p className="text-[9.5px] leading-snug text-gray-500">
                  <span className="font-semibold">?</span> is never a failure claim. A stage we cannot compute is rendered <span className="font-semibold">?</span> — never ✓ and never ✗ — because absence of evidence is not evidence of absence. Click any row for the per-stage reason.
                </p>
                {STAGE_META.map((s) => (
                  <p key={s.key} className="text-[9.5px] leading-snug text-gray-500">
                    <span className="mr-1 font-semibold text-gray-600">{s.abbr} {s.name}</span> — {s.how}
                  </p>
                ))}
                <p className="text-[9.5px] leading-snug text-amber-700">
                  Submitted and Seller-saw are ⋯ for every facet by design. Nothing in this client records WHICH values left in the submitted RFQ, and no seller-side signal reaches it at all — so they are left unverified rather than guessed. A submitted-payload snapshot would make the first column real.
                </p>
              </div>
            </Row>
          </>);
        })()}
        </>)}

        {/* CATEGORY CORPUS — the complete bi-category-brain payload, EVERY spec question 1→last (not a preview), each
            with asked_pct + the real top_values, plus the four sections the distilled {q,pct,vals} contract used to
            drop (personas · keywords · b2b_b2c · top_products) and the coverage counters the numbers rest on.
            Feeds LLM 2 (Commercial) ONLY — by owner decision the Brain and Persona planners are category-free. */}
        {catPub && (catPub.full || catPub.distilled?.length) && (() => {
          const full = catPub.full ?? {};
          const specs = (Array.isArray(full.top_specs) ? full.top_specs : []) as Array<{ question?: string; asked_pct?: number; top_values?: Array<{ value?: string; count?: number }> }>;
          const rows = specs.length ? specs : (catPub.distilled ?? []).map((d) => ({ question: d.q, asked_pct: d.pct, top_values: (d.vals ?? []).map((v) => ({ value: v })) }));
          const arr = (k: string) => (Array.isArray(full[k]) ? full[k] as unknown[] : []);
          const analyzed = full.calls_analyzed as number | undefined; const received = full.rows_received as number | undefined; const unparsed = full.rows_unparsed as number | undefined;
          // #5 (owner): the whole corpus (numbered questions + coverage + raw payload) behind ONE collapsed header.
          return (
            <div className="mt-2">
            <Row head={<span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">category corpus + raw (LLM 2 input) · {rows.length} questions</span>}>
            <div className="mb-1 mt-1 text-[10px] text-gray-500">
              mcat {catPub.mcatId || '—'}
              {analyzed != null && <> · <span className="text-gray-700">{analyzed} calls analysed</span></>}
              {received != null && <> of {received} rows{unparsed ? <span className="text-amber-600"> · {unparsed} unparsed</span> : null}</>}
              {!catPub.full && <span className="text-amber-600"> · full payload absent — showing the distilled top_specs only</span>}
            </div>
            <div className="space-y-0.5">{rows.map((s, i) => (
              <div key={i} className="flex items-start gap-2 text-[10.5px]">
                <span className="w-5 shrink-0 text-right font-mono text-[9px] text-gray-400">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="text-gray-800">{s.question}</span>
                  {Array.isArray(s.top_values) && s.top_values.length > 0 && (
                    <span className="ml-1 text-[9px] text-gray-500">{s.top_values.map((v) => v?.value).filter(Boolean).join(' · ')}</span>
                  )}
                </span>
                {s.asked_pct != null && <span className={`shrink-0 text-[9px] font-mono ${s.asked_pct >= 50 ? 'text-teal-700' : 'text-gray-400'}`}>{s.asked_pct}%</span>}
              </div>
            ))}</div>
            {/* SERVER-side truncation: the n8n node emits topN(specs,15). At exactly 15 the tail is almost certainly cut. */}
            {rows.length >= 15 && <p className="mt-1 text-[9.5px] leading-snug text-amber-700">⚠ {rows.length} specs = the n8n <span className="font-mono">topN(specs,15)</span> cap. Themes ranked 16+ never left the workflow, so their absence here is NOT evidence sellers don&apos;t ask them. Raising the cap is a server-side change.</p>}
            <div className="mt-1 space-y-0.5">
              {(['personas', 'keywords', 'top_products'] as const).map((k) => arr(k).length > 0 && (
                <p key={k} className="text-[9.5px] leading-snug text-gray-600"><span className="text-gray-400">{k}:</span> {arr(k).map((x) => (x && typeof x === 'object' ? String((x as { persona?: string }).persona ?? JSON.stringify(x)) : String(x))).join(' · ')}</p>
              ))}
              {!!full.b2b_b2c && typeof full.b2b_b2c === 'object' && Object.keys(full.b2b_b2c as object).length > 0 && (
                <p className="text-[9.5px] text-gray-600"><span className="text-gray-400">b2b_b2c:</span> {Object.entries(full.b2b_b2c as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}</p>
              )}
            </div>
            <Row head={<span className="text-[10px] text-gray-500">raw category payload (nothing hidden)</span>}><Pre v={full} /></Row>
            </Row>
            </div>
          );
        })()}

        {/* LLM CALLS — grouped by LLM 1 / 2 / 3 / 4. Per call: effort + tokens + cost, sources-used chips, and the
            complete SYSTEM + USER + OUTPUT (untrimmed — the Pre block scrolls, and the input cap is a 60k backstop).
            The USER prompt renders one line per row (LinedBlock, #4/#5) so a citation click elsewhere in the panel
            can jump straight here, force this row open, and flash the exact cited line. */}
        <Section title="Every time we asked the AI something" count={llm.length}
          hint="SYSTEM = the instructions we gave it. USER = the facts we handed it. OUTPUT = what it answered." />
        {llm.length === 0 ? <p className="text-[11px] text-gray-400">no LLM calls yet this session.</p> : LLM_GROUPS.map((grp) => {
          const rows = llm.map((r, i) => [r, i] as const).filter(([r]) => llmGroup(r.label) === grp);
          if (!rows.length) return null;
          return (
            <div key={grp}>
              <p className="mt-2.5 mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700/80">{grp} · {rows.length}</p>
              {rows.map(([r, i]) => {
                const io = (r.id != null && rawById[r.id]) ? rawById[r.id] : raw[r.label]; // H-fix: per-call I/O (by id), byLabel only as offline/seed fallback
                // #4 — if the last-clicked citation belongs to THIS call, force the row open and resolve its local
                // "Lnn" (numbered fresh inside every fence tag) to the absolute line LinedBlock renders.
                const targeted = jump?.call === r.label;
                const userLine = targeted ? resolveFenceLine(io?.user, jump!.tag, jump!.line) : null;
                return (
                  <Row key={i} tone={r.ok ? 'green' : 'red'} forceOpen={targeted}
                    head={<span className="font-medium text-gray-800">{r.label}</span>}
                    sub={<span className="shrink-0 text-[10px] text-gray-400">{(r.promptTokens ?? 0)}→{(r.completionTokens ?? 0)}t · {r.ms}ms{r.costUsd ? ` · $${r.costUsd.toFixed(4)}` : ''}</span>}>
                    {/* effort is the live confirmation the page -1 selector reached the wire (WS-1 verify): reasoning_effort
                        as ACTUALLY sent — `—` means the gateway stripped it (400/422 compat path), not that none was chosen. */}
                    <div className="text-[10px] text-gray-400">{r.model} · <Term def="How much the AI 'thought' before answering.">effort</Term> <span className={`font-semibold ${r.reasoningEffort ? 'text-teal-700' : 'text-amber-600'}`}>{r.reasoningEffort ?? '— (stripped)'}</span> · maxTok {r.maxTokens} · <Term def="Randomness — 0 means the same input always gets the same answer.">temp</Term> {r.temperature ?? 'default'} · {r.promptVersion ?? ''}</div>
                    <SourceChips user={io?.user} />
                    {io?.system && <><div className="mt-1 text-[10px] font-semibold text-gray-500">SYSTEM <span className="font-normal text-gray-400">— our instructions to the AI</span></div><Pre v={io.system} /></>}
                    {io?.user && <><div className="mt-1 text-[10px] font-semibold text-gray-500">USER <span className="font-normal text-gray-400">— the facts we handed it (the complete prompt)</span></div><LinedBlock text={io.user} highlightLine={userLine} /></>}
                    {targeted && io?.user && userLine == null && <p className="mt-0.5 text-[9.5px] text-amber-600">Couldn't find {jump!.tag}:L{jump!.line} in this call's prompt — it may be from a different run.</p>}
                    {io?.output && <><div className="mt-1 text-[10px] font-semibold text-gray-500">OUTPUT <span className="font-normal text-gray-400">— what it answered</span></div><Pre v={io.output} /></>}
                    {!io && <p className="text-[10px] text-gray-400">raw I/O not captured for this call.</p>}
                  </Row>
                );
              })}
            </div>
          );
        })}

        {/* CONSUMPTION LEDGER (I-fix) — LLM 1's output → what the form DID with each field → WHY. The owner's
            "debug follows the form hierarchy: supposed-to vs did vs why". Ungated — works on the 3-LLM leaf flow. */}
        {consumption && ((consumption.page1?.length ?? 0) > 0 || (consumption.knownTruths?.length ?? 0) > 0) && (<>
          <Section title="What the form did with each AI answer, and why" count={(consumption.page1?.length ?? 0) + (consumption.knownTruths?.length ?? 0)} />
          <div className="mb-1 text-[10px] text-gray-400">
            <Term def={`Raw flag: category_trustworthy = ${String(consumption.category_trustworthy)}`}>{consumption.category_trustworthy === false ? 'The category looked wrong for this product, so page 1 was built from what he browsed/searched.' : 'The standard question list for this category was used for page 1.'}</Term>
          </div>
          <div className="space-y-0.5">
            {(consumption.page1 ?? []).map((c, i) => (
              <div key={`c1-${i}`} className="flex items-center gap-2 text-[10.5px]">
                <span className="shrink-0 rounded bg-gray-200 px-1 text-[9px] font-bold uppercase text-gray-600">{c.ui}</span>
                <span className="min-w-0 flex-1 truncate text-gray-700" title={c.field}>{c.field}{c.matched ? ` → ${c.matched}` : ''}</span>
                <span className={`shrink-0 text-[9px] ${/drop|skip/i.test(c.action) ? 'text-gray-400' : 'text-teal-700'}`}>{c.action}</span>
              </div>
            ))}
            {(consumption.knownTruths ?? []).map((c, i) => (
              <div key={`kt-${i}`} className="flex items-center gap-2 text-[10.5px]">
                <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] font-bold uppercase text-amber-700">KT</span>
                <span className="min-w-0 flex-1 truncate text-gray-600" title={c.key}>{c.key}: {c.value}</span>
                <span className={`shrink-0 text-[9px] ${/drop|skip/i.test(c.action) ? 'text-gray-400' : 'text-teal-700'}`}>{c.action}</span>
              </div>
            ))}
          </div>
        </>)}


        {/* UNDERSTAND + the question-competition ledger (planner v2). Parsed from the curated-planner raw
            output rather than prop-threaded, so the panel stays self-contained. This is the answer to
            "why was this question asked, what competed with it, and which source drove it". */}
        {(() => {
          // #4 — prefer LLM 1 (requirement-brain); fall back to the retired curated-planner shape if a stale run is present.
          const out = raw['requirement-brain']?.output ?? raw['curated-planner']?.output;
          if (!out) return null;
          let plan: { brain?: { understanding?: string; persona_read?: string; category_trustworthy?: boolean; evidence?: string[] }; page1?: { questions?: Array<Record<string, unknown>>; metadata?: { reasoning?: Record<string, { why?: string; confidence?: number; evidence?: unknown; source?: string }>; considered?: Array<{ candidate?: string; surfaced?: boolean; rank?: number; dropped_because?: string }>; needs_input?: Array<{ attribute?: string; missing_reason?: string; best_next_question?: string }> } }; known_truths?: Array<Record<string, unknown>>; understanding?: Record<string, unknown>; considered?: Record<string, unknown>[] } | null = null;
          try { plan = JSON.parse(out); } catch { return <p className="mt-2 text-[10px] text-amber-600">LLM output did not parse as JSON.</p>; }
          const u = plan?.understanding, considered = plan?.considered;
          if (!plan?.brain && !u && !considered) return null; // #4 — a requirement-brain payload has neither `u` nor `considered`; do NOT bail before the brain branch below
          // empty array = the planner explicitly said "none"; undefined = it never answered. Different things.
          const list = (v: unknown) => (Array.isArray(v) ? v : []);
          const Line = ({ k, v }: { k: string; v: unknown }) => {
            if (v === undefined) return <p className="text-[10px] text-gray-300">{k}: <span className="italic">not answered</span></p>;
            const arr = Array.isArray(v) ? v : null;
            if (arr && !arr.length) return <p className="text-[10px] text-gray-400">{k}: none</p>;
            return <p className="text-[10.5px] leading-snug text-gray-600"><span className="text-gray-400">{k}:</span> {arr ? arr.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' · ') : String(v)}</p>;
          };
          // #4 — LLM 1 (requirement-brain) shape: render its brain + Page-1 payload + known-truths. The old
          // curated-planner competition ledger / candidate pool below belong to a retired architecture and only
          // render if a legacy curated-planner run is somehow still in the buffer.
          if (plan?.brain) {
            const qs = plan.page1?.questions ?? []; const kt = plan.known_truths ?? [];
            // #8 (owner): the brain's read (understanding / persona / category-trust / evidence) now renders as the
            // panel's LEAD card at the very top (see `brainRead` above) — only the page-1 pre-bake + known-truths stay here.
            return (<>
              {qs.length > 0 && (<>
                <Section title="page 1 — what LLM 1 pre-baked" count={qs.length} />
                <div className="space-y-1">
                  {qs.map((q, i) => (
                    <div key={i} className="rounded-lg border border-gray-100 bg-gray-50/60 px-2.5 py-1.5">
                      <div className="flex items-start gap-1.5">
                        <span className="shrink-0 rounded bg-gray-200 px-1 text-[9px] font-bold uppercase text-gray-600">{String(q.ui ?? 'ask')}</span>
                        <span className="min-w-0 flex-1 text-[11px] font-medium text-gray-800">{String(q.label ?? q.field ?? '')}</span>
                      </div>
                      {q.value ? <p className="mt-0.5 text-[10px] text-teal-700">value: {String(q.value)}</p> : null}
                    </div>
                  ))}
                </div>
              </>)}
              {kt.length > 0 && (<>
                <Section title="known truths — LLM 1 emitted · form verdict" count={kt.length} />
                {kt.map((k, i) => { const v = ktVerdict.get(String(k.key)); return (
                  <p key={i} className="flex items-center gap-2 text-[10.5px] text-gray-600">
                    <span className="min-w-0 flex-1 truncate"><span className="text-gray-400">{String(k.key)}:</span> {String(k.value)}</span>
                    {v && <span className={`shrink-0 text-[9px] ${/drop|skip/i.test(v) ? 'text-gray-400' : 'text-teal-700'}`}>{v}</span>}
                  </p>
                ); })}
                <p className="mt-0.5 text-[9px] text-gray-400">P-fix: verdict = what the form actually did. Not every emitted truth is a spec — identity/context is dropped by design (owner firewall).</p>
              </>)}
              {(() => {
                // O-fix: render the debug prompt's per-field metadata.reasoning as a structured table (was only visible
                // as raw JSON inside the OUTPUT expander). Commercial/Persona reasoning stays visible in their raw OUTPUT.
                const reasoning = plan?.page1?.metadata?.reasoning; const rkeys = reasoning ? Object.keys(reasoning) : [];
                if (!rkeys.length) return null;
                return (<>
                  <Section title="per-field reasoning (AI-Debug)" count={rkeys.length} />
                  <div className="space-y-1">{rkeys.map((fk) => { const r = reasoning![fk]; return (
                    <div key={fk} className="rounded-lg border border-gray-100 bg-gray-50/60 px-2.5 py-1.5">
                      <div className="flex items-center gap-1.5"><span className="min-w-0 flex-1 text-[11px] font-medium text-gray-800">{fk}</span>{typeof r?.confidence === 'number' && <span className="shrink-0 text-[9px] text-gray-500">conf {r.confidence}</span>}</div>
                      {r?.why && <p className="mt-0.5 text-[10px] text-gray-600">{String(r.why)}</p>}
                      <EvidenceList ev={r?.evidence} callLabel="requirement-brain" />
                      {r?.source && <p className="text-[9px] text-gray-400">source: {String(r.source)}</p>}
                    </div>
                  ); })}</div>
                </>);
              })()}
              {(() => {
                // Provenance (owner Q4): the candidate POOL LLM 1 chose from + why each surfaced/dropped, and what it
                // could NOT ground (needs_input → the question to ask). Debug-only; sits under the reasoning table.
                const considered = plan?.page1?.metadata?.considered ?? [];
                const needs = plan?.page1?.metadata?.needs_input ?? [];
                if (!considered.length && !needs.length) return null;
                return (<>
                  {considered.length > 0 && (<>
                    <Section title="candidate pool — what LLM 1 weighed for Page 1" count={considered.length} />
                    <div className="space-y-0.5">{considered.map((c, i) => (
                      <div key={`cons-${i}`} className="flex items-center gap-2 text-[10.5px]">
                        <span className={`shrink-0 text-[9px] font-mono ${c.surfaced ? 'text-teal-700' : 'text-gray-400'}`}>{c.surfaced ? `#${c.rank ?? '?'}` : 'dropped'}</span>
                        <span className="min-w-0 flex-1 truncate text-gray-700" title={c.candidate}>{c.candidate}</span>
                        {!c.surfaced && c.dropped_because && <span className="shrink-0 text-[9px] text-gray-400 truncate max-w-[45%]" title={c.dropped_because}>{c.dropped_because}</span>}
                      </div>
                    ))}</div>
                  </>)}
                  {needs.length > 0 && (<>
                    <Section title="needs input — couldn't ground; ask the buyer" count={needs.length} />
                    <div className="space-y-1">{needs.map((n, i) => (
                      <div key={`ni-${i}`} className="rounded-lg border border-amber-100 bg-amber-50/40 px-2.5 py-1.5">
                        <div className="text-[11px] font-medium text-gray-800">{n.attribute}</div>
                        {n.missing_reason && <p className="mt-0.5 text-[10px] text-gray-500">{String(n.missing_reason)}</p>}
                        {n.best_next_question && <p className="text-[10px] text-teal-700">→ {String(n.best_next_question)}</p>}
                      </div>
                    ))}</div>
                  </>)}
                </>);
              })()}
              {/* WS-3: LLM 2 (Commercial) + LLM 3 (Persona) structured debug — questions · reasoning+evidence ·
                  question-competition ledger · needs_input. Each self-gates: renders only once that planner has run
                  (page 2 / page 3). Category insights feed LLM 2 only (owner: no brain/persona routing) and are
                  visible in full inside LLM 2's USER prompt + its `category_engine` source chip above. */}
              {/* (also rendered OUTSIDE this branch below, so LLM 2/3 debug survives an unparseable LLM 1) */}
            </>);
          }
          return (<>
            {u && (<>
              <Section title="understand — the planner's read of this buyer" />
              <div className="space-y-1 rounded-lg bg-gray-50 px-2.5 py-2">
                <Line k="wants" v={u.what_they_want} />
                <Line k="situation" v={u.buyer_situation} />
                <Line k="already known" v={u.already_known} />
                <Line k="contradictions" v={u.contradictions} />
                <Line k="stale" v={u.stale} />
                <Line k="worth confirming" v={u.worth_confirming} />
                <Line k="useless here" v={u.useless} />
              </div>
            </>)}
            {list(considered).length > 0 && (<>
              <Section title="questions that competed — why each won or lost" count={`${list(considered).filter((c) => c.outcome === 'asked').length} asked / ${list(considered).length}`} />
              <div className="space-y-1">
                {list(considered).sort((a, b) => Number(a.rank ?? 99) - Number(b.rank ?? 99)).map((c, i) => {
                  const asked = c.outcome === 'asked';
                  return (
                    <div key={i} className={`rounded-lg border px-2.5 py-1.5 ${asked ? 'border-teal-200 bg-teal-50/50' : 'border-gray-100 bg-gray-50/60'}`}>
                      <div className="flex items-start gap-1.5">
                        <span className={`shrink-0 rounded px-1 text-[9px] font-bold ${asked ? 'bg-teal-600 text-white' : 'bg-gray-200 text-gray-500'}`}>{asked ? 'ASKED' : 'DROPPED'}</span>
                        <span className="min-w-0 flex-1 text-[11px] font-medium text-gray-800">{String(c.q ?? '')}</span>
                        <span className="shrink-0 text-[9px] text-gray-400">#{String(c.rank ?? '?')} · {String(c.score ?? '?')}</span>
                      </div>
                      {c.why_ranked ? <p className="mt-0.5 text-[10px] text-gray-500">↳ {String(c.why_ranked)}</p> : null}
                      {!asked && c.dropped_because ? <p className="text-[10px] text-amber-600">↳ dropped: {String(c.dropped_because)}</p> : null}
                      {c.from_source ? <p className="text-[9.5px] text-gray-400">source: {String(c.from_source)}</p> : null}
                    </div>
                  );
                })}
              </div>
            </>)}
            {/* ── THE FULL CANDIDATE POOL → what the planner did with EACH candidate (owner 2026-07-29) ──────────
                The competition ledger above shows what COMPETED; this shows the whole pool the planner was handed —
                category's top seller-asked questions, the seller-flagged specs, and the buyer's own ISQ specs — so
                the ones it IGNORED are visible too (the ledger can't show those). Parsed from the planner's OWN
                input fences (raw['curated-planner'].user) + verdict cross-referenced against its output. This is
                the answer to "show me all the candidate questions and why each was chosen, dropped, or invented." */}
            {(() => {
              const pin = raw['curated-planner']?.user;
              if (!pin) return null;
              const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
              const pAny = (plan ?? {}) as Record<string, unknown>;
              const prefills = list(pAny.prefills), preAns = list(pAny.pre_answered);
              const consideredArr = list(considered) as Record<string, unknown>[];
              // The planner (v8+) tags each considered question with `from_ref` = the EXACT candidate it was built
              // from. That is the ONLY reliable way to map a re-phrased question ("How many compartments?") back to
              // its raw candidate ("Cavity Count") — a name-substring match falsely reports "NOT USED" for specs the
              // planner really asked under a different phrasing (verified). So: map by from_ref; and only assert
              // NOT USED when the planner actually emitted from_ref (else we cannot know — show a neutral dash).
              const hasFromRef = consideredArr.some((c) => typeof c.from_ref === 'string' && (c.from_ref as string).trim());
              const verdict = (label: string): { tag: string; cls: string; why: string } => {
                const n = norm(label);
                const c = consideredArr.find((x) => typeof x.from_ref === 'string' && norm(x.from_ref) === n);
                if (c) return c.outcome === 'asked'
                  ? { tag: 'ASKED', cls: 'bg-teal-600 text-white', why: String(c.why_ranked ?? '') }
                  : { tag: 'DROPPED', cls: 'bg-amber-100 text-amber-700', why: String(c.dropped_because ?? '') };
                // buyer specs the planner prefilled / pre-answered are matched by field name (those DO align with ISQ names)
                if (prefills.some((p) => norm((p as Record<string, unknown>).field) === n) || preAns.some((p) => norm((p as Record<string, unknown>).q) === n)) return { tag: 'PREFILLED', cls: 'bg-gray-200 text-gray-600', why: 'already known — not asked' };
                if (hasFromRef) return { tag: 'NOT USED', cls: 'bg-gray-100 text-gray-400', why: 'handed to the planner, not chosen' };
                return { tag: '—', cls: 'bg-gray-50 text-gray-300', why: 'verdict unavailable (planner output pre-dates from_ref)' };
              };
              const block = (tag: string): unknown[] => {
                const m = pin.match(new RegExp('<' + tag + '>\\n([\\s\\S]*?)\\n</' + tag + '>'));
                if (!m || m[1].trim() === '(none)') return [];
                try { const j = JSON.parse(m[1].trim()); return Array.isArray(j) ? j : []; }
                catch { return m[1].trim().split(/\n|·/).map((s) => s.split(':')[0].trim()).filter(Boolean); }   // buyer-spec text fallback
              };
              const cat = block('seller_top_questions').map((x) => (typeof x === 'string' ? { label: x } : { label: String((x as Record<string, unknown>).q ?? ''), pct: (x as Record<string, unknown>).pct }));
              const seller = block('seller_flagged_specs').map((x) => ({ label: typeof x === 'string' ? x : String((x as Record<string, unknown>).name ?? '') }));
              const buyer = block('page1_buyer_specs').map((x) => ({ label: typeof x === 'string' ? x : String((x as Record<string, unknown>).name ?? '') }));
              if (!cat.length && !seller.length && !buyer.length) return null;
              const Pool = ({ title, items }: { title: string; items: { label: string; pct?: unknown }[] }) => items.filter((i) => i.label).length === 0 ? null : (
                <div className="mt-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{title} · {items.filter((i) => i.label).length}</p>
                  <div className="mt-1 space-y-0.5">
                    {items.filter((i) => i.label).map((i, k) => { const v = verdict(i.label); return (
                      <div key={k} className="flex items-start gap-1.5">
                        <span className={`mt-px shrink-0 rounded px-1 text-[8.5px] font-bold ${v.cls}`}>{v.tag}</span>
                        <span className="min-w-0 flex-1 text-[10.5px] text-gray-700">{i.label}{i.pct != null ? <span className="text-gray-400"> · {String(i.pct)}%</span> : null}{v.why ? <span className="text-gray-400"> — {v.why}</span> : null}</span>
                      </div>
                    ); })}
                  </div>
                </div>
              );
              return (<>
                <Section title="candidate pool — every question handed to the planner, and its verdict" count={`${cat.length + seller.length + buyer.length} candidates`} />
                <Pool title="category top questions (what sellers ask here)" items={cat} />
                <Pool title="seller-flagged specs" items={seller} />
                <Pool title="buyer's own specs" items={buyer} />
                <p className="mt-1 text-[9.5px] text-gray-400">NOT USED = the planner was handed it but did not ask, prefill, or drop-with-reason it — the case to scrutinise. — = verdict unavailable (a planner run older than the from_ref tag; re-run to populate).</p>
              </>);
            })()}
          </>);
        })()}

        {/* LLM 2 / LLM 3 planner debug — deliberately OUTSIDE the LLM-1 parse block above. It used to live inside the
            `plan?.brain` branch, so a missing or unparseable requirement-brain output took the two planner traces down
            with it — losing the debug for pages 2 and 3 in exactly the situation you most need it. Each block
            self-gates on its own captured output. */}
        <PlannerDebugBlock title="LLM 2 · Commercial — planner debug" rawOut={raw['commercial-planner']?.output} callLabel="commercial-planner" />
        <PlannerDebugBlock title="LLM 3 · Persona — planner debug" rawOut={raw['persona-planner']?.output} callLabel="persona-planner" />

        {/* ENGINE-ERA node/decision sections — legacy monolith payload only; hidden on the 3-LLM leaf flow. */}
        {hasEngine && (<>
        {/* NODE DATA + HEALTH — RAW first, then what the RFQ actually CONSUMED from it (owner, 2026-07-28).
            "Raw" alone can't answer the real question: of everything this source returned, what did we USE?
            The USED half is derived from the evidence dictionary (engine v7+) by matching atom.source to the
            node, so it is the engine's own accounting, not a re-guess here. */}
        <Section title="node data · raw returned, and what the RFQ used" count={`${healthyN}/${Object.keys(nodeHealth).length} healthy`} />
        {Object.entries(nodeHealth).map(([name, h]) => {
          const used = evAtoms.filter((a) => nodeOf(a) === name);
          const usedInDecision = used.filter((a) => evUsed.has(a.id));
          return (
          <Row key={name} tone={h.status}
            head={<span className="font-medium capitalize text-gray-700">{name === 'profile' ? 'profile enrichment' : name}</span>}
            sub={<span className="shrink-0 text-[11px] text-gray-400">
              {h.count}{evAtoms.length ? <span className={usedInDecision.length ? 'text-teal-600' : 'text-amber-600'}> · {usedInDecision.length} used</span> : null}
            </span>}>
            <div className="mt-1 text-[10px] font-semibold text-gray-500">USED BY THIS RFQ{evAtoms.length ? ` · ${usedInDecision.length} of ${used.length} atoms reached a decision` : ''}</div>
            {!evAtoms.length ? (
              <p className="px-2 py-1 text-[10px] text-amber-600">engine predates v7 — no evidence dictionary, so "what we used" can't be computed.</p>
            ) : !used.length ? (
              <p className="px-2 py-1 text-[10px] text-gray-400">nothing from this source became a truth atom
                {h.count ? ' — it returned data but no consumer read it.' : '.'}</p>
            ) : (
              <div className="space-y-0.5 px-2 py-1">
                {used.map((a) => (
                  <p key={a.id} className={`text-[9.5px] leading-snug ${evUsed.has(a.id) ? 'text-gray-600' : 'text-gray-400'}`}>
                    {evUsed.has(a.id) ? <span className="text-teal-600">●</span> : <span className="text-gray-300">○</span>}{' '}
                    <span className={`rounded px-1 text-[8.5px] font-semibold ${TIER_COLOR[String(a.tier)] ?? 'bg-gray-100 text-gray-500'}`}>{a.tier}</span>{' '}
                    <span className="font-medium">{a.field}</span>{a.value != null && a.value !== '' ? <> = {String(a.value)}</> : null}
                    {!evUsed.has(a.id) && <span className="text-amber-600"> · {a.ignored_because || 'built but never reached a decision'}</span>}
                  </p>
                ))}
              </div>
            )}
            <div className="mt-2 text-[10px] font-semibold text-gray-500">RAW</div>
            <Pre v={nodeRaw[name] ?? '(no raw — re-import the engine for node_raw)'} />
          </Row>
          );
        })}

        {/* ROUTING */}
        <Section title="routing" />
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded bg-teal-100 px-1.5 py-0.5 text-[10px] font-semibold text-teal-800">entry {m.entry_mode}</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">intent {m.intent.level}</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">certainty {m.certainty}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${o.planner_gate === 'ok' ? 'bg-teal-100 text-teal-800' : 'bg-amber-100 text-amber-800'}`}>gate {o.planner_gate}</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">kyb {m.kyb_unlock.state}</span>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">{m.intent.why}</p>
        <p className="mt-0.5 font-medium text-gray-900">{m.primary?.product ?? '(cold — no primary)'} <span className="text-[10px] font-normal text-gray-400">mcat {m.primary?.mcat ?? '—'}</span></p>

        {/* DECISIONS */}
        <Section title="decisions" count={shown.length} />
        <div className="space-y-1">
          {shown.map((d: Decision, i) => (
            <div key={i} className="rounded-lg border border-gray-100 bg-gray-50/60 px-2.5 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${ACTION_COLOR[d.action]}`}>{d.action}</span>
                <span className="font-medium text-gray-800">{d.field}</span>{d.value && <span className="text-gray-500">= {d.value}</span>}
                {d.kind && <span className="rounded bg-gray-100 px-1 text-[9px] text-gray-500">{d.kind}</span>}
              </div>
              {(d.reason || d.why) && <p className="mt-0.5 text-[10px] text-gray-500">{d.reason || d.why}</p>}
              {/* WHY THIS DECISION — resolve every ev_N into the actual truth atom it points at (engine v7+).
                  Before v7 the engine emitted only a COUNT, so these ids were dangling and the trail was cosmetic. */}
              {d.evidence?.length ? (
                evIndex
                  ? <div className="mt-1 space-y-0.5">
                      {d.evidence.map((id) => {
                        const a = evIndex.get(id);
                        if (!a) return <p key={id} className="text-[9px] text-red-400">{id} — not in evidence dictionary</p>;
                        return (
                          <p key={id} className="text-[9.5px] leading-snug text-gray-500">
                            <span className="rounded bg-white px-1 font-mono text-[8.5px] text-gray-400 ring-1 ring-gray-200">{id}</span>{' '}
                            <span className={`rounded px-1 text-[8.5px] font-semibold ${TIER_COLOR[String(a.tier)] ?? 'bg-gray-100 text-gray-500'}`}>{a.tier}</span>{' '}
                            <span className="font-medium text-gray-700">{a.field}</span>
                            {a.value != null && a.value !== '' ? <> = {String(a.value)}</> : null}
                            {a.source ? <> · <span className="text-gray-400">via {a.source}</span></> : null}
                            {a.freshness ? <> · {a.freshness}{a.age_days != null ? ` ${a.age_days}d` : ''}</> : null}
                            {a.used_because ? <><br /><span className="text-gray-400">↳ {a.used_because}</span></> : null}
                            {a.ignored_because ? <><br /><span className="text-amber-600">↳ dropped: {a.ignored_because}</span></> : null}
                          </p>
                        );
                      })}
                    </div>
                  : <p className="text-[9px] text-gray-400">evidence: {d.evidence.join(', ')} <span className="text-amber-500">· unresolvable — engine predates v7 (no evidence dictionary)</span></p>
              ) : null}
            </div>
          ))}
        </div>

        {/* EVIDENCE LEDGER — every atom the engine built, used or not. The Know/Use/Ignore view. */}
        {evAtoms.length > 0 && (<>
          <Section title="evidence ledger — every truth atom" count={`${evAtoms.length} · ${evUsed.size} used / ${evAtoms.length - evUsed.size} unused`} />
          <div className="space-y-0.5">
            {evAtoms.map((a) => (
              <p key={a.id} className={`text-[9.5px] leading-snug ${evUsed.has(a.id) ? 'text-gray-600' : 'text-gray-400'}`}>
                <span className="rounded bg-gray-50 px-1 font-mono text-[8.5px] ring-1 ring-gray-200">{a.id}</span>{' '}
                <span className={`rounded px-1 text-[8.5px] font-semibold ${TIER_COLOR[String(a.tier)] ?? 'bg-gray-100 text-gray-500'}`}>{a.tier}</span>{' '}
                {evUsed.has(a.id) ? <span className="text-teal-600">●</span> : <span className="text-gray-300">○</span>}{' '}
                <span className="font-medium">{a.field}</span>{a.value != null && a.value !== '' ? <> = {String(a.value)}</> : null}
                {a.source ? <span className="text-gray-400"> · via {a.source}</span> : null}
                {!evUsed.has(a.id) && a.ignored_because ? <span className="text-amber-600"> · {a.ignored_because}</span> : null}
              </p>
            ))}
          </div>
        </>)}

        {/* DECISION ROUTING — the firewall's accounting record. Every engine Decision Object either rendered
            somewhere or appears here WITH a reason. Before this, ASK/RESOLVE_CONFLICT/SUGGEST/OFFER were all
            dropped in the adapter with no trace: _seed.gaps and _seed.conflicts had zero readers anywhere in
            src/. A decision that vanishes without a reason is now a visible defect, not an invisible one. */}
        {(() => {
          const routes = decisionRoutingReport();
          if (!routes.length) return null;
          const lost = routes.filter((r) => !r.rendered);
          return (<>
            <Section title="decision routing — every engine decision accounted for"
              count={`${routes.length - lost.length}/${routes.length} rendered`} />
            <div className="space-y-0.5">
              {routes.map((r) => (
                <div key={r.id} className={`rounded px-2 py-1 text-[10px] leading-snug ${r.rendered ? 'bg-teal-50/50' : 'bg-amber-50/60'}`}>
                  <span className={`mr-1 rounded px-1 text-[8.5px] font-bold ${ACTION_COLOR[r.action] ?? 'bg-gray-100 text-gray-500'}`}>{r.action}</span>
                  <span className="font-medium text-gray-800">{r.field}</span>
                  {r.q && r.q !== r.field ? <span className="text-gray-500"> → “{r.q}”</span> : null}
                  <br />
                  <span className={r.rendered ? 'text-teal-700' : 'text-amber-700'}>
                    {r.rendered ? `↳ ${r.where}` : `↳ not shown — ${r.reason || 'NO REASON GIVEN (defect)'}`}
                  </span>
                </div>
              ))}
            </div>
          </>);
        })()}

        {/* SUPPRESSED — split, because the old single "never shown" header was FALSE (owner caught it).
            Two different layers suppress for two different reasons and only one of them is truly never shown:
             · a SUPPRESS decision (noise spec) really is dropped entirely — firewall.
             · a "browsing-only" requirement is only excluded from the DECISION layer. It is still offered as a
               Source card in the chooser AND still sent to the planner LLM in `basket`/also_sourcing. Labelling
               that "never shown" made a live, buyer-visible product look like it had been discarded. */}
        <Section title="suppressed — dropped by the firewall, never shown" count={suppressed.length} />
        {suppressed.length
          ? suppressed.map((d, i) => <p key={`d${i}`} className="text-[10.5px] text-gray-500"><span className="text-gray-400 line-through">{d.field}</span> — {d.reason}</p>)
          : <p className="text-[10.5px] text-gray-400">none</p>}

        <Section title="not decision-worthy — still shown as a Source card + sent to the planner" count={o.suppressed?.length ?? 0} />
        {(o.suppressed ?? []).map((s, i) => (
          <p key={`s${i}`} className="text-[10.5px] text-gray-500">
            <span className="text-gray-600">{s.product ?? `req#${s.i}`}</span>
            <span className="ml-1 rounded bg-gray-100 px-1 text-[9px] text-gray-500">card + LLM input</span> — {s.why}
          </p>
        ))}
        {!(o.suppressed?.length) && <p className="text-[10.5px] text-gray-400">none</p>}

        <p className="mt-3 text-[10px] text-gray-400">brain {m.versions?.brain} · planner {m.versions?.planner} · adapter {m.versions?.adapter}</p>
        </>)}
      </div>
    </div>
    </CiteCtx.Provider>
  );
}
