// ─── Brain Debug / Observability panel (shared across all surfaces) ──────────
// The eval/evidence harness, modelled on the profile-enrichment + buyer-ledger debug:
//  · every LLM call — model · in/out tokens · ms · $cost, expand → full system+user prompt + output
//  · per-node data + health — expand → the raw each source returned
//  · decision summary + routing + suppressed audit trail
// Right rail, collapsible section headers, expand-to-last-row. Reads live LLM telemetry.
import { useEffect, useState } from 'react';
import { getLLMHealth, getLLMRaw, onLLMActivity, type LLMCallRecord } from '../lib/gemini';
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
