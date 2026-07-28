// ─── Brain Debug / Observability panel (shared across all surfaces) ──────────
// The eval/evidence harness, modelled on the profile-enrichment + buyer-ledger debug:
//  · every LLM call — model · in/out tokens · ms · $cost, expand → full system+user prompt + output
//  · per-node data + health — expand → the raw each source returned
//  · decision summary + routing + suppressed audit trail
// Right rail, collapsible section headers, expand-to-last-row. Reads live LLM telemetry.
import { useEffect, useState } from 'react';
import { getLLMHealth, getLLMRaw, onLLMActivity, type LLMCallRecord } from '../lib/gemini';
import { besReport } from '../lib/bes';
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

function Row({ head, sub, tone, children, mono }: { head: React.ReactNode; sub?: React.ReactNode; tone?: string; children?: React.ReactNode; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-50 last:border-0">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 py-1.5 text-left">
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
  return <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 px-2 py-1.5 text-[10px] leading-relaxed text-gray-600">{typeof v === 'string' ? v : JSON.stringify(v, null, 1)}</pre>;
}
function Section({ title, count }: { title: string; count?: number | string }) {
  return <p className="mt-3 mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{title}{count != null ? ` · ${count}` : ''}</p>;
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

export default function BrainDebugPanel({ p, onClose }: { p: RequirementBrainPayload; onClose: () => void }) {
  const [, force] = useState(0);
  useEffect(() => onLLMActivity(() => force((n) => n + 1)), []); // re-render as LLM calls land
  const m = p.metadata, o = p.observability, ds = o.decision_summary;
  const health = getLLMHealth(); const raw = getLLMRaw();
  const llm = [...health].sort((a, b) => b.at - a.at);
  const totalTok = llm.reduce((s, r) => s + (r.promptTokens ?? 0) + (r.completionTokens ?? 0), 0);
  const totalCost = llm.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const nodeHealth = o.node_health ?? {}; const nodeRaw = (o.node_raw ?? {}) as Record<string, unknown>;
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
    <div className="h-full overflow-y-auto bg-white text-[12.5px] text-gray-700">
      <div className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 font-bold text-gray-900">🔬 Observability &amp; eval</h2>
          <button onClick={onClose} className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-200">✕</button>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          <span className={healthyN === Object.keys(nodeHealth).length ? 'text-teal-700' : 'text-amber-700'}>{healthyN}/{Object.keys(nodeHealth).length} nodes</span>
          {' · '}{ds.evidence} evidence → {ds.total_decisions} decisions · {llm.length} LLM calls · {totalTok.toLocaleString()} tok · ${totalCost.toFixed(4)} · {m.versions?.brain}
        </p>
      </div>

      <div className="px-4 pb-6">
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

        {/* LLM CALLS — the eval harness: prompt · tokens · ms · cost, expand → full I/O */}
        <Section title="LLM calls (prompt · tokens · latency · cost)" count={llm.length} />
        {llm.length === 0 ? <p className="text-[11px] text-gray-400">no LLM calls yet this session.</p> : llm.map((r: LLMCallRecord, i) => {
          const io = raw[r.label];
          return (
            <Row key={i} tone={r.ok ? 'green' : 'red'}
              head={<span className="font-medium text-gray-800">{r.label}</span>}
              sub={<span className="shrink-0 text-[10px] text-gray-400">{(r.promptTokens ?? 0)}→{(r.completionTokens ?? 0)}t · {r.ms}ms{r.costUsd ? ` · $${r.costUsd.toFixed(4)}` : ''}</span>}>
              <div className="text-[10px] text-gray-400">{r.model} · maxTok {r.maxTokens} · temp {r.temperature ?? 'default'} · {r.promptVersion ?? ''}</div>
              {io?.system && <><div className="mt-1 text-[10px] font-semibold text-gray-500">SYSTEM</div><Pre v={io.system} /></>}
              {io?.user && <><div className="mt-1 text-[10px] font-semibold text-gray-500">USER (input)</div><Pre v={io.user} /></>}
              {io?.output && <><div className="mt-1 text-[10px] font-semibold text-gray-500">OUTPUT</div><Pre v={io.output} /></>}
              {!io && <p className="text-[10px] text-gray-400">raw I/O not captured for this call.</p>}
            </Row>
          );
        })}

        {/* BUYER EFFORT SCORE — the second KPI. TUS asks "did we use the truth"; BES asks "did we make him
            work for what we already knew". Lower is better, and the two are read TOGETHER: a TUS win bought
            by asking three more questions is not a win. Live counters, no network, no field values. */}
        {(() => {
          const b = besReport();
          if (!b.shown && !b.answered) return null;
          return (<>
            <Section title="buyer effort score — lower is better" count={b.score} />
            <div className="rounded-lg bg-gray-50 px-2.5 py-2">
              <p className="text-[10.5px] text-gray-600">
                {b.answered} answered of {b.shown} shown
                {b.answerRate != null && <span className={b.answerRate < 0.5 ? ' text-amber-600' : ' text-teal-700'}> · {Math.round(b.answerRate * 100)}% answer rate</span>}
                {b.seconds != null && <span className="text-gray-400"> · {b.seconds}s to submit</span>}
              </p>
              {b.answerRate != null && b.answerRate < 0.5 && (
                <p className="mt-0.5 text-[10px] text-amber-600">More than half of what we showed went unanswered — screen the buyer paid for and we got nothing from.</p>
              )}
              <div className="mt-1.5 space-y-0.5">
                {b.contributions.map((c) => (
                  <div key={c.event} className="flex items-center gap-2 text-[10px]">
                    <span className="w-24 shrink-0 text-gray-500">{c.event.replace('_', ' ')}</span>
                    <span className="w-8 shrink-0 text-right text-gray-400">×{c.n}</span>
                    <span className="h-1.5 rounded-full bg-teal-400" style={{ width: `${Math.min(100, (c.cost / Math.max(b.score, 1)) * 100)}%` }} />
                    <span className="shrink-0 text-gray-400">{c.cost}</span>
                  </div>
                ))}
              </div>
              {b.counts.correction > 0 && (
                <p className="mt-1 text-[10px] text-amber-600">⚠ {b.counts.correction} correction{b.counts.correction > 1 ? 's' : ''} — we prefilled a value the buyer had to change. Each is a wrong prefill, not just effort.</p>
              )}
            </div>
          </>);
        })()}

        {/* UNDERSTAND + the question-competition ledger (planner v2). Parsed from the curated-planner raw
            output rather than prop-threaded, so the panel stays self-contained. This is the answer to
            "why was this question asked, what competed with it, and which source drove it". */}
        {(() => {
          const out = raw['curated-planner']?.output;
          if (!out) return null;
          let plan: { understanding?: Record<string, unknown>; considered?: Record<string, unknown>[] } | null = null;
          try { plan = JSON.parse(out); } catch { return <p className="mt-2 text-[10px] text-amber-600">curated-planner output did not parse as JSON.</p>; }
          const u = plan?.understanding, considered = plan?.considered;
          if (!u && !considered) return null;
          // empty array = the planner explicitly said "none"; undefined = it never answered. Different things.
          const list = (v: unknown) => (Array.isArray(v) ? v : []);
          const Line = ({ k, v }: { k: string; v: unknown }) => {
            if (v === undefined) return <p className="text-[10px] text-gray-300">{k}: <span className="italic">not answered</span></p>;
            const arr = Array.isArray(v) ? v : null;
            if (arr && !arr.length) return <p className="text-[10px] text-gray-400">{k}: none</p>;
            return <p className="text-[10.5px] leading-snug text-gray-600"><span className="text-gray-400">{k}:</span> {arr ? arr.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' · ') : String(v)}</p>;
          };
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
          </>);
        })()}

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
      </div>
    </div>
  );
}
