// ─── L1–L7 + UC3 BANDS (P5/UC3) — the "no black box" Ledger stack, top to bottom ──────────────────────────────
//   L1 nodes/data from n8n (+ per-node __health)        → what we pulled, and did each node succeed
//   L2 WhatsApp + RFQ + PNS readable in the UI          → the raw buyer signals, human-readable
//   L3 everything sent to the LLM (model · tokens · temp)→ the exact context window
//   L4 the raw prompt (system + user)                   → verbatim, nothing hidden
//   L5 output + reasoning + eval + governance + prov.   → the twin, each attribute expandable to its evidence
//   L6 UC1 · sample offer-id profile enrichment + HOD   → a corrected BuyLead, every field expandable
//   L7 UC2 · requirement enrichment (3-brain align)     → the requirement modification + the subtraction math
//   UC3 · open the RFQ form for this buyer (mobile/desktop CTAs → debug mode)
// Each band owns its readable presentation; deep per-deduction drills arrive via `drill` slots from BuyerLedgerView
// (which holds the in-closure renderers). Props are minimal local shapes so these stay pure + independently testable.

import { useState, type ReactNode } from 'react';
import { Smartphone, Mail, Building2, CreditCard, ReceiptText, MessageCircle, User, Cake, Landmark, Factory, type LucideIcon } from 'lucide-react';
import { Band, KV, StatePill, MiniBar, Expand, BandEmpty, type BandTone } from './Band';
import type { UC2Enrichment, UC2Edit, UC2EditFull, UC2Eval } from '../../lib/uc2Enrichment';

const fmtUsd = (n: number) => (n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(5)}` : '$0');

// ── JSON TREE (owner: "raw data as a tree, expandable, better UI than a wall of JSON") — a compact, recursive,
// collapsible view of any payload. Objects/arrays are <details> (top 2 levels open); leaves are colour-typed. ──
export function JsonTree({ data, k, depth = 0, openDepth = 2 }: { data: unknown; k?: string; depth?: number; openDepth?: number }) {
  // Children render ONLY when the node is open (lazy) — so a collapsed subtree costs nothing, and a large raw payload
  // (e.g. hundreds of CSL log rows) doesn't blow up first paint. Width is capped per container to bound the DOM.
  // openDepth (default 2) = how many top levels start open — matches the "top 2 levels open" comment above; callers
  // pass openDepth={99} to fully expand small/critical trees (e.g. tiny API query objects) with zero clicks.
  const [open, setOpen] = useState(depth < openDepth);
  const pad = { paddingLeft: depth ? 10 : 0 };
  const keyLabel = k != null ? <span className="text-slate-500">{k}: </span> : null;
  if (data === null || data === undefined || typeof data !== 'object') {
    const v = data == null ? String(data) : typeof data === 'string' ? `"${data}"` : String(data);
    const tone = typeof data === 'number' ? 'text-emerald-700' : typeof data === 'boolean' ? 'text-violet-700' : data == null ? 'text-gray-400' : 'text-gray-700';
    return <div className="text-[10px] font-mono break-words leading-snug" style={pad}>{keyLabel}<span className={tone}>{v}</span></div>;
  }
  const isArr = Array.isArray(data);
  const entries = isArr ? (data as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return <div className="text-[10px] font-mono text-gray-400 leading-snug" style={pad}>{keyLabel}{isArr ? '[ ]' : '{ }'}</div>;
  const CAP = 200; const shown = entries.length > CAP ? entries.slice(0, CAP) : entries;
  return (
    <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="text-[10px] font-mono leading-snug" style={pad}>
      <summary className="cursor-pointer list-none text-slate-500 hover:text-slate-700 select-none">{keyLabel}<span className="text-gray-400">{isArr ? `[${entries.length}]` : `{${entries.length} ${entries.length === 1 ? 'field' : 'fields'}}`}</span></summary>
      {open && shown.map(([kk, vv]) => <JsonTree key={kk} k={kk} data={vv} depth={depth + 1} openDepth={openDepth} />)}
      {open && entries.length > CAP && <div className="text-[9.5px] text-gray-400" style={{ paddingLeft: 10 }}>… {entries.length - CAP} more (truncated for display)</div>}
    </details>
  );
}

// ── CONFIDENCE CHIP (shared) — the % is no longer a dead number; it click-expands to show HOW it's scored, WHY this
// number, and the single thing that would make it 100. `isLlm=false` → deterministic facts get a source-trust line
// (one verified source, taken at face value — not a probability). reason/to100 are the model's own §9 self-report.
const CONF_CRITERIA_LLM = 'evidence quality + source authority (a spoken PNS call & a WhatsApp message from the buyer rank highest) + cross-source agreement − contradictions − missing evidence';
export function confidenceChip(confidence: number, isLlm: boolean, reason?: string, to100?: string): ReactNode {
  return (
    <details className="inline-block align-baseline">
      <summary className="cursor-pointer list-none inline-flex items-baseline gap-0.5 rounded px-1 text-[10px] tabular-nums text-gray-500 hover:bg-gray-100 hover:text-gray-700" title="why this confidence?">{confidence}%<span className="text-gray-300">▾</span></summary>
      <div className="mt-0.5 rounded bg-gray-50 border border-gray-200 p-1.5 text-[10px] text-gray-700 not-italic font-normal space-y-0.5 max-w-[440px]">
        <div><span className="text-gray-400">how it's scored: </span>{isLlm ? CONF_CRITERIA_LLM : 'deterministic — a single verified source, taken at face value (this is corroboration, not a probability)'}</div>
        {isLlm
          ? (<>
              {reason ? <div><span className="text-gray-400">why {confidence}%: </span>{reason}</div> : <div className="text-gray-400 italic">why: the model didn't return a confidence reason for this attribute</div>}
              {to100 ? <div><span className="text-emerald-600">to reach 100%: </span>{to100}</div> : (confidence < 100 ? <div className="text-gray-400 italic">to 100%: not reported</div> : null)}
            </>)
          : <div><span className="text-emerald-600">to reach 100%: </span>a second independent source agreeing with this one</div>}
      </div>
    </details>
  );
}
const sizeHint = (v: unknown): string => { try { const s = typeof v === 'string' ? v : JSON.stringify(v); const kb = s.length / 1024; const n = Array.isArray(v) ? `${v.length} items · ` : ''; return `${n}${kb >= 1 ? kb.toFixed(1) + ' kb' : s.length + ' chars'}`; } catch { return ''; } };

// ── L0 · LLM RUN STRIP (calls · tokens · cost · eval · harness) — the HOD debug header ──────────────────────────
// Owner: "i don't see reasoning, harnesses, evals, tokens used, cost, input/output tokens — it all has to be here."
export interface L0Call { label: string; model: string; in: number; out: number; reasoning: number; costUsd: number; ms: number; ok: boolean }
export function L0Band({ calls, totals, evalDetail, harness, promptVersion, defaultOpen }: {
  calls: L0Call[];
  totals: { calls: number; in: number; out: number; reasoning: number; costUsd: number; ms: number; grounded?: number; verdict?: string };
  evalDetail?: ReactNode; harness?: ReactNode; promptVersion?: string; defaultOpen?: boolean;
}) {
  const chip = (label: string, v: ReactNode, tone = 'bg-gray-50 text-gray-600 border-gray-200') => <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tone} tabular-nums`}>{label} <b>{v}</b></span>;
  return (
    <Band code="RUN" title="LLM run — tokens · cost · evals · harness" subtitle="every model call this pull, what it cost, how it scored" tone="indigo" defaultOpen={defaultOpen}
      status={`${totals.calls} call${totals.calls === 1 ? '' : 's'} · ${fmtUsd(totals.costUsd)}`} statusTone={totals.calls ? 'indigo' : 'slate'}
      meta={<>{totals.in.toLocaleString()} in → {totals.out.toLocaleString()} out tok{totals.reasoning ? <> · {totals.reasoning.toLocaleString()} reasoning</> : null} · {totals.ms ? `${totals.ms} ms` : '—'}{promptVersion ? <> · prompt <span className="font-mono">{promptVersion}</span></> : null}</>}>
      {calls.length === 0 ? <BandEmpty>No LLM call recorded yet (no key, or the extract hasn't fired on this pull).</BandEmpty> : (
        <>
          <div className="flex flex-wrap gap-1 mb-2">
            {chip('calls', totals.calls)}
            {chip('input', totals.in.toLocaleString(), 'bg-sky-50 text-sky-700 border-sky-200')}
            {chip('output', totals.out.toLocaleString(), 'bg-violet-50 text-violet-700 border-violet-200')}
            {totals.reasoning > 0 && chip('reasoning', totals.reasoning.toLocaleString(), 'bg-violet-50 text-violet-600 border-violet-200')}
            {chip('cost', fmtUsd(totals.costUsd), 'bg-amber-50 text-amber-700 border-amber-200')}
            {chip('latency', `${totals.ms} ms`, 'bg-gray-50 text-gray-600 border-gray-200')}
            {totals.grounded != null && chip('grounded', `${Math.round(totals.grounded)}%`, totals.grounded >= 70 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200')}
            {totals.verdict && chip('verdict', totals.verdict, totals.verdict === 'strong' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200')}
          </div>
          <Expand label={`per-call breakdown — ${calls.length} call${calls.length === 1 ? '' : 's'} (model · tokens · cost · latency)`} tone="indigo" defaultOpen>
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-[9px] uppercase tracking-wide text-gray-400 pb-0.5 border-b border-gray-200"><span className="flex-1">call</span><span className="w-24">model</span><span className="w-20 text-right">in→out</span><span className="w-14 text-right">cost</span><span className="w-12 text-right">ms</span></div>
              {calls.map((c, i) => (
                <div key={`${c.label}-${i}`} className="flex items-center gap-2 text-[10.5px] tabular-nums">
                  <span className="flex-1 min-w-0 truncate text-gray-700">{c.ok ? '✓' : <span className="text-rose-500">✗</span>} {c.label}</span>
                  <span className="w-24 text-gray-400 font-mono text-[9px] truncate">{c.model.replace('google/', '')}</span>
                  <span className="w-20 text-right text-gray-600">{c.in.toLocaleString()}→{c.out.toLocaleString()}{c.reasoning ? <span className="text-gray-300"> +{c.reasoning}</span> : null}</span>
                  <span className="w-14 text-right text-amber-700">{fmtUsd(c.costUsd)}</span>
                  <span className="w-12 text-right text-gray-400">{c.ms}</span>
                </div>
              ))}
            </div>
          </Expand>
          {evalDetail && <Expand label="eval — grounding · confidence · what the verdict is built on" tone="emerald" defaultOpen>{evalDetail}</Expand>}
          {harness && <Expand label="harness & eval-over-time — the offline suites + drift by prompt-version" tone="slate" defaultOpen>{harness}</Expand>}
        </>
      )}
    </Band>
  );
}

// ── L1 · NODES & HEALTH ───────────────────────────────────────────────────────────────────────────────────────
export interface HealthRow { node: string; ok: boolean; latency_ms?: number; output_count?: number; source?: string }
// V10 (owner #8): coverage = what the ONE LLM actually SAW (sent) → what it CITED. NOT a dead ledger count.
export interface SourceRow { label: string; sent: number; cited: number }
// ONE unified node row (owner: "every node in health will have raw what LLM saw, and our readable version"): liveness
// (ok/latency/count) + OUR humanised readable view + the distilled summary the LLM saw + the full raw payload — GST included.
export interface L1NodeRow { key: string; label: string; ok?: boolean; status?: string; latency_ms?: number; output_count?: number; readable?: ReactNode; summary?: unknown; raw?: unknown; input?: unknown }
export function L1Band({ nodes, cov, endpoint, drill, defaultOpen }: {
  nodes: L1NodeRow[]; cov?: { sent: number; cited: number; noise: number } | null;
  endpoint?: string; drill?: ReactNode; defaultOpen?: boolean;
}) {
  // audit ENR-698 / v47: a tier-skipped transcription source (status 'skipped') is NEITHER ok NOR failed — it's neutral,
  // excluded from the ok/known tally so "N/M ok" isn't inflated by a source that deliberately didn't run this tier.
  const okCount = nodes.filter((n) => n.ok === true && n.status !== 'skipped').length;
  const known = nodes.filter((n) => n.ok != null && n.status !== 'skipped').length;
  const allOk = known > 0 && okCount === known;
  const covLine = cov ? <>{cov.sent} lines sent to LLM · <span className="text-emerald-700">{cov.cited} cited</span>{cov.noise > 0 && <> · {cov.noise} plumbing excluded</>}</> : null;
  return (
    <Band code="L1" title="Nodes & Health" subtitle="every node n8n pulled · raw + what the LLM saw + our readable view · did it succeed" tone="slate" defaultOpen={defaultOpen}
      status={known ? `${okCount}/${known} ok` : `${nodes.length} nodes`} statusTone={allOk ? 'emerald' : known ? 'rose' : 'slate'}
      meta={<>{endpoint && <>endpoint <span className="font-mono text-gray-500">{endpoint}</span>{covLine ? ' · ' : ''}</>}{covLine}</>}>
      {nodes.length > 0 ? (
        <div className="space-y-1">
          {nodes.map((n) => {
            const hasBody = n.readable != null || n.summary !== undefined || n.raw !== undefined || n.input !== undefined;
            return (
              <details key={n.key} className="rounded-lg border border-gray-150 bg-gray-50/50">
                <summary className="cursor-pointer list-none flex items-center gap-2 px-2 py-1.5 text-[11px] hover:bg-gray-50">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${n.status === 'skipped' ? 'bg-gray-300' : n.ok === false ? 'bg-rose-500' : n.ok === true ? 'bg-emerald-500' : 'bg-gray-300'}`} title={n.status === 'skipped' ? 'skipped for this tier — not run' : n.ok === false ? 'failed' : n.ok === true ? 'ok' : 'no n8n health signal for this node'} />
                  <span className="flex-1 min-w-0 text-gray-700 truncate font-medium">{n.label}</span>
                  {n.status && n.status !== 'ok' && n.status !== 'success' && <span className={`shrink-0 text-[8.5px] px-1 rounded border ${n.status === 'error' ? 'bg-rose-50 text-rose-600 border-rose-200' : n.status === 'timeout' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>{n.status}</span>}
                  {typeof n.output_count === 'number' && <span className="text-gray-400 shrink-0">{n.output_count} out</span>}
                  {typeof n.latency_ms === 'number' && <span className="text-gray-400 shrink-0 tabular-nums">{n.latency_ms} ms</span>}
                  <span className="shrink-0 text-gray-300 text-[10px]">▾</span>
                </summary>
                <div className="px-2 pb-2 pt-1.5 border-t border-gray-100">
                  {!hasBody ? <div className="text-[10px] text-gray-400">health only — no payload returned for this node.</div> : (<>
                    {/* INPUT — what we SENT this node (query/params/prompt). Default-open so raw input shows at click 2 (owner goal 2). Amber = 'sent', distinct from slate 'returned'. */}
                    {n.input !== undefined && (
                      <Expand label={`raw INPUT — what we sent this node (${sizeHint(n.input)})`} tone="amber" defaultOpen><div className="max-h-72 overflow-auto">{typeof n.input === 'string' ? <div className="text-[10px] font-mono whitespace-pre-wrap break-words">{n.input}</div> : <JsonTree data={n.input} openDepth={99} />}</div></Expand>
                    )}
                    {/* HUMANISED first + default-open — the plain-English card (holds the 🔎 queried line) is no longer 1 click deeper than raw. */}
                    {n.readable != null && <Expand label="our humanised view (plain English)" tone="sky" defaultOpen>{n.readable}</Expand>}
                    {/* RAW OUTPUT — default-open; JsonTree now opens 2 levels deep by default (edit 1). */}
                    {n.raw !== undefined ? (
                      <Expand label={`raw OUTPUT — what n8n returned (${sizeHint(n.raw)})`} tone="slate" defaultOpen><div className="max-h-80 overflow-auto"><JsonTree data={n.raw} /></div></Expand>
                    ) : n.summary !== undefined ? (
                      <Expand label={`data — what the LLM saw (${sizeHint(n.summary)})`} tone="emerald" defaultOpen><div className="max-h-80 overflow-auto"><JsonTree data={n.summary} /></div></Expand>
                    ) : null}
                    {/* Distilled summary alongside raw — also default-open so 'what the LLM saw' is not a 3rd click. */}
                    {n.raw !== undefined && n.summary !== undefined && <Expand label={`what the LLM saw (distilled summary · ${sizeHint(n.summary)})`} tone="emerald" defaultOpen><div className="max-h-72 overflow-auto"><JsonTree data={n.summary} /></div></Expand>}
                  </>)}
                </div>
              </details>
            );
          })}
        </div>
      ) : <BandEmpty>No nodes on this response.</BandEmpty>}
      {drill && <div className="mt-2">{drill}</div>}
    </Band>
  );
}

// ── L2 type retained — the readable per-source bodies now fold into L1Band (Nodes & Health). The standalone L2Band
// was removed in the dashboard restructure; SignalChannel still describes each channel's readable body for L1. ──
export interface SignalChannel { key: string; label: string; count: number; tone: BandTone; sample?: string; body?: ReactNode }

// ── L3 · LLM INPUT (the ONE call: model · output ceiling · temperature · context · cost) ────────────────────────
// Owner Qs answered in the UI: there is ONE call (system + user are two PARTS of it, see L4); "max tokens" is the
// OUTPUT ceiling, not an input cap (we send everything — no line cap); the per-node "context" is the SOURCE GUIDE
// (expandable); the old "sent / raw" split is gone (no trims → sent==raw, so just the sent line count + its fN drill).
export interface CatalogRow { node: string; label: string; sent: number; raw?: number; transform?: string; evidence?: Array<{ id: string; tag: string; raw: string }> }
export function L3Band({ model, maxTokens, temperature, promptVersion, catalog, sources, signalCount, usage, sourceGuide, defaultOpen }: {
  model?: string; maxTokens?: number; temperature?: number; promptVersion?: string;
  catalog: CatalogRow[]; sources?: SourceRow[]; signalCount: number;
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; ms?: number; costUsd?: number } | null;
  sourceGuide?: ReactNode; defaultOpen?: boolean;
}) {
  const [allEv, setAllEv] = useState(false);
  return (
    <Band code="L3" title="Sent to the LLM" subtitle="the ONE extract call · model · context window · cost" tone="violet" defaultOpen={defaultOpen}
      status="1 call · system + user" statusTone="violet"
      meta={<>{signalCount} evidence lines across {catalog.length} nodes · sent in full (no line cap)</>}>
      <div className="grid grid-cols-2 gap-x-4 mb-2">
        <KV k="model" v={model || '—'} mono tone="strong" />
        <KV k="call shape" v="1 call · system + user" />
        <KV k="output ceiling" v={maxTokens != null ? `${maxTokens.toLocaleString()} tok (max OUTPUT, not an input cap)` : '—'} mono />
        <KV k="temperature" v={temperature != null ? String(temperature) : '—'} mono />
        {promptVersion && <KV k="prompt ver" v={promptVersion} mono tone="strong" />}
        {usage && <KV k="tokens" v={`${usage.inputTokens ?? '?'} in · ${usage.outputTokens ?? '?'} out${usage.reasoningTokens ? ` · ${usage.reasoningTokens} reasoning` : ''}`} mono />}
        {usage?.costUsd != null && <KV k="cost" v={fmtUsd(usage.costUsd)} mono />}
        {usage?.ms != null && <KV k="latency" v={`${usage.ms} ms`} mono />}
      </div>
      {sourceGuide && <Expand label="per-node CONTEXT — the SOURCE GUIDE the LLM is given (trust · what each node may influence · conflict priority)" tone="violet" defaultOpen>{sourceGuide}</Expand>}
      {sources && sources.length > 0 && (
        <Expand label={`grounding — how much of each source the LLM actually cited (sent → cited)`} tone="violet">
          <div className="text-[10px] text-gray-400 mb-1">sent = lines shown to the LLM · cited = lines it referenced in an attribute's reasoning. A low bar means the source was sent but barely grounded an answer.</div>
          {sources.map((s) => (
            <div key={s.label} className="flex items-center gap-2 text-[11px] py-0.5">
              <span className="flex-1 min-w-0 text-gray-600 truncate">{s.label}</span>
              <MiniBar pct={s.sent ? (s.cited / s.sent) * 100 : 0} tone={s.cited ? 'emerald' : 'slate'} />
              <span className="text-gray-400 shrink-0 tabular-nums">{s.cited}/{s.sent}</span>
            </div>
          ))}
        </Expand>
      )}
      <Expand label={`evidence sent — ${catalog.length} nodes (expand a node to see its exact fN lines)`} tone="violet" defaultOpen>
        {catalog.length > 0 && <button type="button" onClick={() => setAllEv((v) => !v)} className="mb-1 text-[10px] text-violet-700 hover:underline">{allEv ? '▾ collapse all evidence lines' : '▸ expand all evidence lines'}</button>}
        {catalog.length === 0 ? <BandEmpty>Context not built yet.</BandEmpty> : catalog.map((c) => (
          <div key={c.node} className="py-0.5">
            <div className="flex justify-between gap-2 text-[10.5px]">
              <span className="text-gray-500 min-w-0 truncate">{c.label}{c.transform ? <span className="text-gray-300"> · {c.transform}</span> : null}</span>
              <span className="text-gray-600 shrink-0"><b>{c.sent}</b> line{c.sent === 1 ? '' : 's'}</span>
            </div>
            {c.evidence && c.evidence.length > 0 && (
              <Expand label={`${c.evidence.length} line${c.evidence.length === 1 ? '' : 's'} → exact text`} tone="slate" defaultOpen={allEv}>
                {c.evidence.map((e) => (
                  <div key={e.id} data-fact-id={e.id} className="text-[10px] py-0.5 border-b border-gray-100 last:border-0 scroll-mt-16">
                    <span className="font-mono text-violet-600">[{e.id}]</span> <span className="text-gray-400">{e.tag}</span><div className="text-gray-700 break-words">{e.raw}</div>
                  </div>
                ))}
              </Expand>
            )}
          </div>
        ))}
      </Expand>
    </Band>
  );
}

// ── L4 · RAW PROMPT (system + user, verbatim) ───────────────────────────────────────────────────────────────────
export function L4Band({ system, user, output, rawRequest, defaultOpen }: { system?: string; user?: string; output?: string; rawRequest?: string; defaultOpen?: boolean }) {
  const sys = system || ''; const usr = user || ''; const out = output || ''; const req = rawRequest || '';
  const chars = sys.length + usr.length;
  return (
    <Band code="L4" title="Raw prompt — the ONE call" subtitle="system + user are two PARTS of a single chat-completion (not two calls) — nothing hidden" tone="indigo" defaultOpen={defaultOpen}
      status={chars ? `${(chars / 1000).toFixed(1)}k chars` : 'no prompt'} statusTone={chars ? 'indigo' : 'slate'}>
      {!chars ? <BandEmpty>Prompt not built yet (no key, or the LLM hasn't been invoked on this view).</BandEmpty> : (
        <>
          <div className="text-[10px] text-gray-400 mb-1.5"><b>One</b> Gemini call, two parts. <b>system</b> = instructions only (role · frozen use-cases · source guide) — not your data. <b>user</b> = your ENTIRE n8n buyer payload, flattened into numbered lines (fN) the model must cite. So "evidence" = your n8n input; everything buyer-originated IS evidence — the only thing excluded is plumbing (ids · timestamps · parse flags).</div>
          <Expand label={`① system part — ${(sys.length / 1000).toFixed(1)}k chars (instructions / source guide)`} tone="indigo" defaultOpen>
            <pre className="text-[10px] leading-snug whitespace-pre-wrap break-words font-mono text-gray-600 max-h-[36rem] overflow-auto">{sys || '(empty)'}</pre>
          </Expand>
          <Expand label={`② user part — ${(usr.length / 1000).toFixed(1)}k chars (the buyer evidence)`} tone="indigo" defaultOpen>
            <pre className="text-[10px] leading-snug whitespace-pre-wrap break-words font-mono text-gray-600 max-h-[36rem] overflow-auto">{usr || '(empty)'}</pre>
          </Expand>
          {req && (
            <Expand label={`◆ EXACT INPUT SENT — ${(req.length / 1000).toFixed(1)}k chars (the VERBATIM request body over the wire: model + messages[system,user] + params, as ONE block)`} tone="slate">
              <div className="text-[9px] text-gray-400 mb-1">This is the literal JSON POSTed to the LLM — system + user are NOT clubbed into one string; they're the two <code>messages[]</code> entries the API received. Copy this to reproduce the exact call.</div>
              <pre className="text-[10px] leading-snug whitespace-pre-wrap break-words font-mono text-gray-600 max-h-[40rem] overflow-auto">{req}</pre>
            </Expand>
          )}
          {out && (
            <Expand label={`③ RAW model OUTPUT — ${(out.length / 1000).toFixed(1)}k chars (the verbatim JSON the LLM returned, BEFORE parse → extractedToFinals)`} tone="violet" defaultOpen>
              <pre className="text-[10px] leading-snug whitespace-pre-wrap break-words font-mono text-gray-600 max-h-[36rem] overflow-auto">{out}</pre>
            </Expand>
          )}
        </>
      )}
    </Band>
  );
}

// ── L5 · OUTPUT — the twin (reasoning · eval · governance · provenance), each attribute expandable ──────────────
export interface OutAttr { key: string; label: string; value: string; group?: string; state?: string; confidence: number; provenance: string; grounded?: boolean; held?: boolean; heldReason?: string }
export interface EvalRow { label: string; score: number }
export function L5Band({ attrs, evalRows, evalDrill, prune, status, drillFor, defaultOpen }: {
  attrs: OutAttr[]; evalRows?: EvalRow[]; evalDrill?: ReactNode; prune?: { kept: number; of: number; status?: string }; status: string; drillFor?: (key: string) => ReactNode; defaultOpen?: boolean;
}) {
  const [allOpen, setAllOpen] = useState(false);
  const shown = attrs.filter((a) => !a.held);
  const held = attrs.filter((a) => a.held);
  const groups = [...new Set(shown.map((a) => a.group || 'attributes'))];
  return (
    <Band code="L5" title="LLM output — the Buyer Twin" subtitle="reasoning · eval · governance · provenance" tone="emerald" defaultOpen={defaultOpen}
      status={status === 'done' ? `${shown.length} shown${held.length ? ` · ${held.length} held` : ''}` : status} statusTone={status === 'done' ? 'emerald' : 'amber'}>
      {drillFor && shown.length > 0 && <button type="button" onClick={() => setAllOpen((v) => !v)} className="mb-1 text-[10px] text-emerald-700 hover:underline">{allOpen ? '▾ collapse all reasoning' : '▸ expand all reasoning (raw + evidence)'}</button>}
      {(evalRows && evalRows.length > 0) || prune ? (
        <div className="mb-2">
          <div className="flex flex-wrap items-center gap-2">
            {evalRows?.map((e) => (
              <span key={e.label} className="inline-flex items-center gap-1 text-[10px] text-gray-500">
                {e.label} <MiniBar pct={e.score} tone={e.score >= 70 ? 'emerald' : e.score >= 40 ? 'amber' : 'rose'} /> <span className="tabular-nums text-gray-600">{Math.round(e.score)}</span>
              </span>
            ))}
            {prune && <span className="text-[10px] text-gray-500">critic kept <b className="text-gray-700">{prune.kept}</b>/{prune.of}{prune.status === 'skip' ? ' (no key)' : ''}</span>}
          </div>
          {evalDrill && <Expand label="why these scores — ungrounded · low-confidence · verdict basis" tone="emerald" defaultOpen>{evalDrill}</Expand>}
        </div>
      ) : null}
      {shown.length === 0 ? <BandEmpty>{status === 'done' ? 'No attributes survived the prune pass.' : 'Synthesis in progress…'}</BandEmpty> : (
        <div className="space-y-2">
          {groups.map((g) => (
            <div key={g}>
              <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">{g}</div>
              {shown.filter((a) => (a.group || 'attributes') === g).map((a) => (
                <div key={a.key} className="rounded-lg border border-gray-150 px-2 py-1.5 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-500 shrink-0">{a.label}</span>
                    <span className="flex-1 min-w-0 text-[12px] font-semibold text-gray-800 truncate text-right">{a.value || '—'}</span>
                    {a.state && <StatePill state={a.state} />}
                    <span className="text-[10px] text-gray-400 tabular-nums shrink-0">{a.confidence}%</span>
                    {a.grounded === false && <span className="text-[9px] text-rose-500 shrink-0" title="no matching evidence">⚠</span>}
                  </div>
                  {drillFor && <Expand label="full reasoning → evidence → raw line" tone="emerald" defaultOpen={allOpen}>{drillFor(a.key)}</Expand>}
                </div>
              ))}
            </div>
          ))}
          {held.length > 0 && (
            <Expand label={`${held.length} held (LLM didn't surface / unknown / pruned / ungrounded)`} tone="amber">
              <div className="text-[10px] text-gray-400 mb-1">why each is held back — the governance that keeps the shown twin honest.</div>
              {held.map((a) => (
                <div key={a.key} className="flex justify-between gap-2 text-[10.5px] py-0.5">
                  <span className="text-gray-500 shrink-0">{a.label}</span>
                  <span className="text-gray-400 text-right min-w-0">{a.value || 'no data'} · <span className="text-amber-600">{a.heldReason || a.provenance}</span></span>
                </div>
              ))}
            </Expand>
          )}
        </div>
      )}
    </Band>
  );
}

// ── L6 · UC1 · BUYLEAD DETAILS + BUYER DETAILS — the rich card (owner: "use this UI we already had") ─────────────
export interface OfferFieldRow { label: string; before?: string; after: string; action: string; drill?: ReactNode }
export interface L6Requirement { title: string; posted?: string; expiry?: string; status?: string; isExpired?: boolean; recencyDays?: number; category?: string; location?: string; specs?: Array<{ k: string; v: string; filledBy?: string }>; specsStatus?: string; buyerInfo?: string; commercials?: string }
export interface L6Availability { key: string; label: string; present: boolean; verified: boolean; isNew?: boolean; value: string; externalValue?: string; source: string; note: string }
export interface L6ProfileRow { label: string; value: string; drill?: ReactNode; prov?: 'llm' | 'det' }
export interface L6BuyerDetails { name?: string; company?: { value: string; verified: boolean; drill?: ReactNode }; memberSince?: string; memberSinceDrill?: ReactNode; device?: { value: string; note: string; source?: string }; responseCalls?: number; responseReplies?: number; ageGender?: string; ageGenderDrill?: ReactNode; availability: L6Availability[]; identityConfidence?: { value: string; drill?: ReactNode }; profileRows: L6ProfileRow[]; pii?: { label: string; value: string }[]; footprint?: { bucket: string; items: string[] }[]; allAttrRows?: { label: string; value: string; conf: number; drill?: ReactNode }[] }

// compact channel icons for the "Available" row (matches the classic Buylead-Details card)
// UI-4 (owner 2026-07-13): crisp inline SVGs instead of emoji (emoji rendered blurry / inconsistent across platforms).
const AVAIL_ICON_SVG: Record<string, LucideIcon> = { mobile: Smartphone, email: Mail, address: Building2, pan: CreditCard, gst: ReceiptText, whatsapp: MessageCircle, name: User, age: Cake, company: Landmark, udyam: Factory };
const availIcon = (key: string): ReactNode => { const Ic = AVAIL_ICON_SVG[key]; return Ic ? <Ic size={14} strokeWidth={2} aria-hidden /> : <span>•</span>; };
// device icon by resolved value (§F): WhatsApp → 💬 · any app/mobile-site → 📱 · desktop → 🖥
const deviceIcon = (v: string): string => /whatsapp/i.test(v) ? '💬' : /android|ios|app|mobile/i.test(v) ? '📱' : '🖥';

// a clean "Label : value" row; clickable (reveals its drill) when a deduction/source exists, plain otherwise
function DrillRow({ label, value, drill }: { label: ReactNode; value: ReactNode; drill?: ReactNode }) {
  if (!drill) return (<div className="flex items-start gap-2 text-[12px] py-1"><span className="w-40 shrink-0 font-semibold text-gray-700">{label}</span><span className="flex-1 min-w-0 text-gray-700 break-words"><span className="text-gray-400">: </span>{value}</span></div>);
  return (
    <details className="py-0.5 group/dr"><summary className="cursor-pointer list-none flex items-start gap-2 text-[12px] -mx-1 px-1 rounded hover:bg-gray-50"><span className="w-40 shrink-0 font-semibold text-gray-700 group-open/dr:text-indigo-700">{label}</span><span className="flex-1 min-w-0 text-gray-700 break-words"><span className="text-gray-400">: </span>{value}</span></summary><div className="mt-1 ml-2 rounded bg-gray-50 border border-gray-200 p-2 text-[11px]">{drill}</div></details>
  );
}

export function L6Band({ picker, selectedReq, uc2, productsOfInterest, reqFrequency, reqRows, requirementCount, buyerDetails, retailLead, titleDrill, locationDrill, locationCorrected, fields, offerEval, enrichControl, enrichInput, gstVerified, stillAsk, needsInput, mode: modeProp, onMode, defaultOpen, locked }: {
  picker?: ReactNode; selectedReq?: L6Requirement | null; uc2?: UC2Enrichment | null;
  /** requirement-side buying-behaviour rows (owner 2026-07-12): Use Case · Procurement · Sourcing · Challenge · Price-vs-Quality · Payment · Delivery — rendered on the LEFT under the specs. */
  reqRows?: L6ProfileRow[];
  productsOfInterest?: { value: string; changed: boolean; drill?: ReactNode } | null;
  reqFrequency?: { value: string; drill?: ReactNode } | null;
  requirementCount?: number; buyerDetails?: L6BuyerDetails | null; retailLead?: boolean;
  titleDrill?: ReactNode; locationDrill?: ReactNode; locationCorrected?: { from: string; to: string };
  fields: OfferFieldRow[]; offerEval?: { groundedPct: number; hallucinations: number; verdict: string } | null;
  enrichControl?: ReactNode; gstVerified?: { gstin: string; state: string; entity: string; count: number; list: string[]; advance?: { legalName?: string; tradeName?: string; constitution?: string; status?: string; taxpayerType?: string; registeredAddress?: string; registrationDate?: string; natureOfBusiness?: string[]; sac?: { code: string; desc: string }[]; signatories?: string[]; turnover?: string; email?: string; mobile?: string; centralJurisdiction?: string; stateJurisdiction?: string; filing?: { latest?: string; types: string[]; count: number } } | null } | null; stillAsk?: string[]; needsInput?: Array<{ key: string; label: string; reason: string; question: string }>;
  mode?: 'original' | 'profile' | 'requirement'; onMode?: (m: 'original' | 'profile' | 'requirement') => void; defaultOpen?: boolean;
  /** HOD-UI5: on the dashboard the L6 BuyLead card must be ALWAYS-OPEN (non-collapsible). locked renders a plain container with no open/close control. */
  locked?: boolean;
  enrichInput?: unknown;
}) {
  const ACTION_TONE: Record<string, string> = { kept: 'text-gray-400', corrected: 'text-amber-700', added: 'text-emerald-700', dropped: 'text-rose-600 line-through', suggested: 'text-sky-700' };
  const avail = (buyerDetails?.availability || []).filter((a) => a.present);
  // 3-way view (owner): Original = recorded lead + resolved details, FROZEN (nothing clickable) · Buyer Profile =
  // the AI-built profile with clickable reasoning (default) · Requirement = the AI-corrected/enriched requirement (UC2).
  // Controlled by the parent (mode/onMode) so it can fire the requirement-enrichment LLM only on the Requirement tab.
  const [modeLocal, setModeLocal] = useState<'original' | 'profile' | 'requirement'>('profile');
  const [showPii, setShowPii] = useState(false);   // BL PII click-to-reveal (owner: full unmasked, gated by a click)
  const mode = modeProp ?? modeLocal;
  const setMode = (m: 'original' | 'profile' | 'requirement') => { setModeLocal(m); onMode?.(m); };
  const on = !!uc2 && mode === 'requirement';   // show the UC2-enriched requirement (corrected/added specs)
  // Clickability by tab (owner): Original = nothing · Buyer Profile = RIGHT column only · Requirement = left+right+top.
  const profileClickable = mode !== 'original';   // right column (buyer profile / identity) — Profile + Requirement
  const reqClickable = mode === 'requirement';    // left + top (requirement: title · location · enriched specs)
  // Original = "what we had BEFORE AI": only the recorded lead + raw recorded identity (no AI-extracted profile rows,
  // no Products-of-Interest, no Identity Confidence, no Needs-input; Available is single-tick, no cross-source ✓✓).
  const isOriginal = mode === 'original';
  // GST Verified ribbon — shown ONLY when the GST node returned a GSTIN; right of the "Buyer Details" heading.
  // Expandable (clickable modes) to the decode; a static badge in Original.
  const gstRibbon = !gstVerified ? null : profileClickable ?(
    <details name="avail" className="relative shrink-0">
      <summary className="cursor-pointer list-none inline-flex items-center gap-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-300 px-2 py-0.5 text-[10px] font-bold">🧾 GST Verified{gstVerified.count > 1 ? ` (${gstVerified.count})` : ''} ▾</summary>
      <div className="absolute right-0 mt-1 z-20 w-80 max-h-[28rem] overflow-auto rounded-lg bg-white border border-emerald-200 shadow-lg p-2 text-[10.5px] text-gray-700 font-normal">
        <div className="font-mono text-gray-800 break-all">{gstVerified.gstin}</div>
        <div className="text-gray-500 mt-0.5">{gstVerified.state} · {gstVerified.entity}</div>
        {/* GST-Advance registration record (KYB FFFQ/v2) — the full taxpayer profile, when fetched */}
        {gstVerified.advance && (
          <div className="mt-1.5 border-t border-emerald-100 pt-1.5 space-y-0.5">
            {gstVerified.advance.legalName && <div><span className="text-gray-400">Legal:</span> <b>{gstVerified.advance.legalName}</b></div>}
            {gstVerified.advance.tradeName && gstVerified.advance.tradeName !== gstVerified.advance.legalName && <div><span className="text-gray-400">Trade:</span> {gstVerified.advance.tradeName}</div>}
            {gstVerified.advance.constitution && <div><span className="text-gray-400">Constitution:</span> {gstVerified.advance.constitution}</div>}
            {(gstVerified.advance.status || gstVerified.advance.taxpayerType) && <div><span className="text-gray-400">Status:</span> {[gstVerified.advance.status, gstVerified.advance.taxpayerType].filter(Boolean).join(' · ')}{gstVerified.advance.registrationDate ? ` · since ${gstVerified.advance.registrationDate}` : ''}</div>}
            {gstVerified.advance.natureOfBusiness && gstVerified.advance.natureOfBusiness.length > 0 && <div><span className="text-gray-400">Nature:</span> {gstVerified.advance.natureOfBusiness.join(', ')}</div>}
            {gstVerified.advance.turnover && <div><span className="text-gray-400">Turnover:</span> {gstVerified.advance.turnover}</div>}
            {gstVerified.advance.registeredAddress && <div><span className="text-gray-400">Address:</span> {gstVerified.advance.registeredAddress}</div>}
            {gstVerified.advance.sac && gstVerified.advance.sac.length > 0 && <div className="mt-0.5"><span className="text-gray-400">HSN/SAC:</span><div className="ml-1">{gstVerified.advance.sac.slice(0, 8).map((s) => <div key={s.code} className="text-[9.5px] text-gray-600"><span className="font-mono">{s.code}</span> {s.desc}</div>)}</div></div>}
            {gstVerified.advance.signatories && gstVerified.advance.signatories.length > 0 && <div><span className="text-gray-400">Signatories:</span> {gstVerified.advance.signatories.join(', ')}</div>}
            {gstVerified.advance.filing && gstVerified.advance.filing.count > 0 && <div><span className="text-gray-400">Filing:</span> {gstVerified.advance.filing.latest || `${gstVerified.advance.filing.count} returns`} <span className="text-gray-400">({gstVerified.advance.filing.types.join('/')})</span></div>}
            {(gstVerified.advance.email || gstVerified.advance.mobile) && <div><span className="text-gray-400">Contact:</span> {[gstVerified.advance.email, gstVerified.advance.mobile].filter(Boolean).join(' · ')}</div>}
            {gstVerified.advance.centralJurisdiction && <div className="text-gray-400 text-[9px]">CBIC: {gstVerified.advance.centralJurisdiction}</div>}
            {gstVerified.advance.stateJurisdiction && <div className="text-gray-400 text-[9px]">State: {gstVerified.advance.stateJurisdiction}</div>}
          </div>
        )}
        {gstVerified.list.length > 1 && <div className="mt-1 border-t border-gray-100 pt-1"><span className="text-gray-400">all GSTINs:</span> {gstVerified.list.map((g) => <div key={g} className="font-mono text-[9.5px] text-gray-600 break-all">{g}</div>)}</div>}
        <div className="text-gray-400 mt-1">source: Mobile/Email→GST (KYB){gstVerified.advance ? ' · GST Verification Advance (FFFQ/v2)' : ''}</div>
      </div>
    </details>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-300 px-2 py-0.5 text-[10px] font-bold shrink-0">🧾 GST Verified{gstVerified.count > 1 ? ` (${gstVerified.count})` : ''}</span>
  );
  // a corrected scalar: ~~old~~ new, expandable to its reason
  // ~~old~~ → new, expandable to the FULL reasoning drill (value · confidence · reason · sources). Falls back to the
  // plain reason text if no rich drill was attached.
  const Corrected = ({ e }: { e: UC2Edit }) => (
    <details className="inline-block align-middle"><summary className="cursor-pointer list-none inline-flex flex-wrap items-baseline gap-1"><span className="line-through text-rose-400">{e.from}</span><span className="text-violet-700 font-semibold">{e.to}</span><span className="text-[9px] text-gray-300">▾</span></summary><div className="mt-1 rounded bg-gray-50 border border-gray-200 p-2 text-[10px]">{e.drill || <span className="text-violet-900">{e.reason}</span>}</div></details>
  );
  return (
    <Band code="L6" title="" tone="sky" defaultOpen={defaultOpen} locked={locked}>
      {/* the classic blue "Buylead Details" header bar (BuyLead selector tucked right) */}
      <div className="-mx-3 -mt-1 mb-3 px-4 py-2.5 bg-gradient-to-r from-blue-700 to-blue-500 rounded-t-lg flex items-center justify-between gap-2 flex-wrap">
        <span className="text-white font-bold text-[15px]">Buylead Details</span>
        <div className="flex items-center gap-2">
          {uc2 && (
            <div className="inline-flex rounded-md overflow-hidden border border-white/40 text-[10px] font-semibold shrink-0">
              <button type="button" onClick={() => setMode('original')} title="The recorded lead + resolved buyer details, frozen — nothing expands. The raw picture before any AI." className={`px-2 py-0.5 ${mode === 'original' ? 'bg-white text-blue-700' : 'text-white/90 hover:bg-white/10'}`}>Original</button>
              <button type="button" onClick={() => setMode('profile')} title="AI-built buyer profile — persona, intent, maturity… — every claim clickable to its source." className={`px-2 py-0.5 border-l border-white/30 ${mode === 'profile' ? 'bg-white text-indigo-700' : 'text-white/90 hover:bg-white/10'}`}>Buyer Profile</button>
              <button type="button" onClick={() => setMode('requirement')} title="AI-corrected & enriched requirement — fixed/added specs vs the recorded lead (runs the enrichment LLM)." className={`px-2 py-0.5 border-l border-white/30 ${mode === 'requirement' ? 'bg-white text-violet-700' : 'text-white/90 hover:bg-white/10'}`}>Requirement</button>
            </div>
          )}
          {picker}
        </div>
      </div>
      {/* (declutter) Before→After count line removed — the ~~struck~~→violet coloring already conveys changes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3 px-1">
        {/* LEFT — the BuyLead */}
        <div>
          {!selectedReq ? <BandEmpty>No requirement selected.</BandEmpty> : (
            <>
              {reqClickable && titleDrill ? (
                <details className="group/t"><summary className="cursor-pointer list-none text-[15px] font-semibold text-indigo-700 underline break-words">{selectedReq.title}</summary><div className="mt-1 rounded bg-gray-50 border border-gray-200 p-2 text-[11px]">{titleDrill}</div></details>
              ) : <div className="text-[15px] font-semibold text-indigo-700 break-words">{selectedReq.title}</div>}
              {on && uc2?.title && <div className="text-[12px] mt-0.5 text-gray-600">Title → <Corrected e={uc2.title} /></div>}
              {reqClickable && locationDrill ? (
                <details className="mt-1"><summary className="cursor-pointer list-none text-[12px] text-gray-600 flex flex-wrap items-center gap-x-1.5">{selectedReq.posted && <span>🕐 {selectedReq.posted}</span>}{selectedReq.isExpired ? <span className="text-[10px] px-1 py-0.5 rounded bg-rose-50 text-rose-600 border border-rose-200 font-semibold">EXPIRED</span> : (typeof selectedReq.recencyDays === 'number' && selectedReq.recencyDays >= 0 ? <span className="text-[10px] text-gray-400">{selectedReq.recencyDays}d old</span> : null)}{locationCorrected ? <span className="text-indigo-600">🇮🇳 <span className="line-through text-rose-400">{locationCorrected.from}</span> <span className="text-violet-700 font-semibold">{locationCorrected.to}</span></span> : selectedReq.location && <span className="text-indigo-600 hover:underline">🇮🇳 {selectedReq.location}</span>}</summary><div className="mt-1 rounded bg-gray-50 border border-gray-200 p-2 text-[11px]">{locationDrill}</div></details>
              ) : (
                <div className="text-[12px] text-gray-600 mt-1 flex flex-wrap items-center gap-x-1.5">{selectedReq.posted && <span>🕐 {selectedReq.posted}</span>}{selectedReq.isExpired ? <span className="text-[10px] px-1 py-0.5 rounded bg-rose-50 text-rose-600 border border-rose-200 font-semibold">EXPIRED</span> : (typeof selectedReq.recencyDays === 'number' && selectedReq.recencyDays >= 0 ? <span className="text-[10px] text-gray-400">{selectedReq.recencyDays}d old</span> : null)}{selectedReq.location && <span>🇮🇳 {selectedReq.location}</span>}</div>
              )}
              {on && uc2?.location && <div className="text-[12px] mt-0.5 text-gray-600">🇮🇳 <Corrected e={uc2.location} /></div>}
              {selectedReq.category && selectedReq.category.split('\n').filter(Boolean).map((c, i) => (<div key={i} className="text-[12px] text-gray-700 mt-1.5">{c}</div>))}
              {on && uc2?.category && <div className="text-[12px] mt-0.5 text-gray-600">Category → <Corrected e={uc2.category} /></div>}
              {/* black meta block — Buyer Info / Commercials (standard / derived) */}
              {(selectedReq.buyerInfo || selectedReq.commercials) && (
                <div className="mt-2 space-y-0.5">
                  {selectedReq.buyerInfo && <div className="text-[12px]"><span className="font-semibold text-gray-700">Buyer Info</span> <span className="text-gray-700">: {selectedReq.buyerInfo}</span></div>}
                  {selectedReq.commercials && <div className="text-[12px] flex gap-1"><span className="font-semibold text-gray-700 shrink-0">Commercials</span> <span className="text-gray-700">: {selectedReq.commercials}</span></div>}
                </div>
              )}
              {/* product specs — enriched (corrected/added) when AI-Enriched, else provenance-coloured */}
              {on && uc2 ? (
                <div className="mt-2 space-y-0.5">
                  {uc2.specs.map((s, j) => (
                    <div key={j} className="text-[12px]">
                      {s.kind === 'corrected' ? (
                        <details><summary className="cursor-pointer list-none"><span className="font-semibold text-gray-700">{s.k}</span><span className="text-gray-400">: </span><span className="line-through text-rose-400">{s.from}</span> <span className="text-violet-700 font-semibold">{s.to}</span><span className="text-[9px] text-gray-300 ml-1">▾</span></summary>{(s.drill || s.reason) && <div className="mt-1 ml-2 rounded bg-gray-50 border border-gray-200 p-2 text-[10px]">{s.drill || <span className="text-violet-900">{s.reason}</span>}</div>}</details>
                      ) : s.kind === 'added' ? (
                        <details><summary className="cursor-pointer list-none"><span className="font-semibold text-violet-700">{s.k}</span><span className="text-gray-400">: </span><span className="text-violet-700">{s.to}</span><span className="text-[9px] text-gray-300 ml-1">▾</span></summary>{(s.drill || s.reason) && <div className="mt-1 ml-2 rounded bg-gray-50 border border-gray-200 p-2 text-[10px]">{s.drill || <span className="text-violet-900">{s.reason}</span>}</div>}</details>
                      ) : (
                        <><span className="font-semibold text-emerald-700">{s.k}</span> <span className="text-emerald-700">: {s.to}</span></>
                      )}
                    </div>
                  ))}
                </div>
              ) : selectedReq.specs && selectedReq.specs.length > 0 ? (
                // Original specs render neutral — the old Buyer/Auto/Agent/Predicted fill-colour legend is retired
                // (owner: not required; the card's own consolidated colour key covers what matters).
                <div className="mt-2 space-y-0.5">{selectedReq.specs.map((s, j) => (<div key={j} className="text-[12px]"><span className="font-semibold text-gray-700">{s.k}</span> <span className="text-gray-700">: {s.v}</span></div>))}</div>
              ) : selectedReq.specsStatus && selectedReq.specsStatus !== 'present' ? (   /* audit LB-490: flake/empty status ALWAYS renders (was suppressed when buyerInfo/commercials present, hiding a getisq5 miss) */
                <div className="mt-2 text-[11px] text-gray-400 italic">{selectedReq.specsStatus === 'getisq5_empty_run' ? '⚠ getisq5 returned NOTHING this pull (specs API empty/timed out) — re-pull to fetch ISQ' : selectedReq.specsStatus === 'beyond_fetch_cap' ? 'ISQ specs not fetched for this lead this pull (beyond the per-offer ISQ fetch cap)' : selectedReq.specsStatus === 'not_fetched' ? "no ISQ on file for this lead (getisq5 didn't return it)" : selectedReq.specsStatus === 'none' ? "no ISQ specs — buyer didn't answer the ISQ for this lead" : `no specs (${selectedReq.specsStatus})`}</div>
              ) : null}
              {/* V10 §D — Purchase frequency MOVED here: it's a per-requirement read (how often THEY buy this line), not a buyer-wide trait. LLM-derived (violet), clickable in Profile/Requirement. */}
              {!isOriginal && reqFrequency && (
                <div className="mt-2 text-[12px]">
                  {profileClickable && reqFrequency.drill ? (
                    <details className="inline-block"><summary className="cursor-pointer list-none"><span className="font-semibold text-violet-700">Purchase frequency</span><span className="text-gray-400">: </span><span className="text-violet-700">{reqFrequency.value}</span><span className="text-[9px] text-gray-300 ml-1">▾</span></summary><div className="mt-1 ml-2 rounded bg-gray-50 border border-gray-200 p-2 text-[10px]">{reqFrequency.drill}</div></details>
                  ) : (<><span className="font-semibold text-violet-700">Purchase frequency</span><span className="text-gray-400">: </span><span className="text-violet-700">{reqFrequency.value}</span></>)}
                </div>
              )}
              {/* HOW THIS BUYER BUYS (owner 2026-07-12) — requirement-side behaviour rows moved here from the buyer
                  profile column: they describe how the buyer transacts on THIS kind of requirement, not who they are. */}
              {!isOriginal && reqRows && reqRows.length > 0 && (
                <div className="mt-2 pt-1.5 border-t border-gray-100 space-y-0.5">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">How this buyer buys</div>
                  {reqRows.map((p, i) => (
                    <div key={i} className="text-[12px]">
                      {profileClickable && p.drill ? (
                        <details className="inline-block w-full"><summary className="cursor-pointer list-none"><span className="font-semibold text-violet-700">{p.label}</span><span className="text-gray-400">: </span><span className="text-violet-700">{p.value || '—'}</span><span className="text-[9px] text-gray-300 ml-1">▾</span></summary><div className="mt-1 ml-2 rounded bg-gray-50 border border-gray-200 p-2 text-[10px]">{p.drill}</div></details>
                      ) : (<><span className="font-semibold text-violet-700">{p.label}</span><span className="text-gray-400">: </span><span className="text-violet-700">{p.value || '—'}</span></>)}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        {/* RIGHT — Buyer Details */}
        {buyerDetails && (
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[13px] font-semibold text-indigo-700 underline">Buyer Details</span>
              {gstRibbon}
            </div>
            {/* V10 §B — Company anchor (deterministic, teal). ✓✓ when a GST on file corroborates a registered entity. Shown in every mode (it's recorded identity). */}
            {buyerDetails.company && <DrillRow label={<span className="text-teal-700">Company{!isOriginal && buyerDetails.company.verified && <span className="ml-1 text-emerald-600 text-[9px] font-bold">✓✓</span>}</span>} value={buyerDetails.company.value} drill={profileClickable ? buyerDetails.company.drill : undefined} />}
            {!isOriginal && productsOfInterest && <DrillRow label={<span className="text-violet-700">Products of Interest</span>} value={productsOfInterest.value || '—'} drill={profileClickable ?productsOfInterest.drill : undefined} />}
            {requirementCount != null && <DrillRow label="Requirement till date" value={requirementCount} />}
            {(buyerDetails.responseCalls != null || buyerDetails.responseReplies != null) && <DrillRow label="Response" value={`Calls: ${buyerDetails.responseCalls ?? 0} | Replies: ${buyerDetails.responseReplies ?? 0}`} />}
            {buyerDetails.ageGender && <DrillRow label={<span className="text-teal-700">Age / Gender</span>} value={buyerDetails.ageGender} drill={profileClickable ?buyerDetails.ageGenderDrill : undefined} />}
            {/* V10 §G — Member since: deterministic teal, 100% (GLUSR tenure), never "new". Above Available. */}
            {buyerDetails.memberSince && <DrillRow label={<span className="text-teal-700">Member since</span>} value={buyerDetails.memberSince} drill={profileClickable ? buyerDetails.memberSinceDrill : undefined} />}
            {/* Available — icons only; click an icon to reveal its value · source (✓ profile / ✓✓ external) */}
            <div className="flex items-start gap-2 text-[12px] py-1">
              <span className="w-40 shrink-0 font-semibold text-teal-700">Available</span>
              <span className="flex-1 min-w-0"><span className="text-gray-400">: </span>
                {avail.length === 0 ? <span className="text-gray-400">—</span> : avail.map((a) => profileClickable ?(
                  // name="avail" → exclusive accordion (opening one closes the others); popover is ABSOLUTE so opening
                  // it never reflows / shuffles the icon row (the "random" behaviour the owner hit).
                  // V10 §E: a.isNew (anchor discovered via external, absent from profile) → VIOLET border + violet ✦ tick.
                  <details key={a.key} name="avail" className="relative inline-block align-middle mr-1.5">
                    {/* §E: tick keeps ✓ (single) / ✓✓ (cross-source) — VIOLET (border+tick) carries the NEW axis, NOT a different symbol. */}
                    <summary className={`cursor-pointer list-none relative inline-flex items-center justify-center w-7 h-7 rounded border ${a.isNew ? 'border-violet-300 bg-violet-50 text-violet-700' : a.verified ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-gray-200 bg-gray-50 text-gray-600'}`} title={a.label}>{availIcon(a.key)}<span className={`absolute -top-1 -right-1 text-[7px] font-bold ${a.isNew ? 'text-violet-500' : a.verified ? 'text-emerald-600' : 'text-gray-400'}`}>{a.verified ? '✓✓' : '✓'}</span></summary>
                    {/* §A: deterministic anchors carry a 100% confidence chip (the value is on-file; ✓/✓✓ conveys corroboration). */}
                    {/* audit 2026-07-13 (P1): only on-file/verified anchors carry the deterministic 100% chip. An externally-
                        DISCOVERED anchor (a.isNew) is a lead, not a certainty — its real confidence lives in the note, so
                        we do NOT stamp a hardcoded 100% that contradicts it. */}
                    <div className="absolute left-0 top-full mt-1 z-30 w-52 rounded-lg bg-white border border-gray-200 shadow-lg p-1.5 text-[10px] text-gray-600"><div className="flex items-center gap-1 mb-0.5"><b>{a.label}</b>{a.isNew ? <span className="text-violet-600 font-semibold">NEW · lead</span> : (a.verified ? confidenceChip(100, false) : null)}</div>{a.value || '—'}<div className="text-gray-500 mt-0.5">{a.note}</div><div className="text-gray-400">source: {a.source}</div></div>
                  </details>
                ) : (
                  // Original — static icon, SINGLE tick only (no cross-source ✓✓ and no NEW marker; that's enrichment, shown in Profile)
                  <span key={a.key} className="relative inline-flex items-center justify-center w-7 h-7 rounded border border-gray-200 bg-gray-50 text-gray-600 align-middle mr-1.5" title={a.label}>{availIcon(a.key)}<span className="absolute -top-1 -right-1 text-[7px] font-bold text-gray-400">✓</span></span>
                ))}
                {/* V10 §F — device: which surface the buyer transacted on. Same w-7 h-7 icon-square as the other anchors; expandable (clickable modes) to value · source · note, static icon in Original. */}
                {buyerDetails.device && (profileClickable ? (
                  <details name="avail" className="relative inline-block align-middle mr-1.5">
                    <summary className="cursor-pointer list-none relative inline-flex items-center justify-center w-7 h-7 rounded border border-teal-300 bg-teal-50 text-[13px]" title={`Device: ${buyerDetails.device.value}`}>{deviceIcon(buyerDetails.device.value)}</summary>
                    <div className="absolute left-0 top-full mt-1 z-30 w-52 rounded-lg bg-white border border-gray-200 shadow-lg p-1.5 text-[10px] text-gray-600"><b>Device</b>: {buyerDetails.device.value}<div className="text-gray-500 mt-0.5">{buyerDetails.device.note}</div>{buyerDetails.device.source && <div className="text-gray-400">source: {buyerDetails.device.source}</div>}</div>
                  </details>
                ) : (
                  <span className="relative inline-flex items-center justify-center w-7 h-7 rounded border border-gray-200 bg-gray-50 text-[13px] align-middle mr-1.5" title={`Device: ${buyerDetails.device.value}`}>{deviceIcon(buyerDetails.device.value)}</span>
                ))}
              </span>
            </div>
            {/* DIGITAL FOOTPRINT chips — moved UP next to Available (owner 2026-07-12: "footprint in the available
                section with logo"). Presence-gated chips; click any chip for what it means + where the evidence lives. */}
            {!isOriginal && buyerDetails.footprint && buyerDetails.footprint.length > 0 && (
              <div className="flex items-start gap-2 text-[12px] py-1">
                <span className="w-40 shrink-0 font-semibold text-teal-700">Footprint</span>
                <span className="flex-1 min-w-0 flex flex-wrap gap-1"><span className="text-gray-400">: </span>
                  {buyerDetails.footprint.flatMap((b) => b.items.map((it) => ({ bucket: b.bucket, it }))).map(({ bucket, it }, i) => profileClickable ? (
                    <details key={`${bucket}-${it}-${i}`} name="avail" className="relative inline-block align-middle">
                      <summary className="cursor-pointer list-none px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200 text-[10.5px]">{it}</summary>
                      <div className="absolute left-0 top-full mt-1 z-30 w-56 rounded-lg bg-white border border-gray-200 shadow-lg p-1.5 text-[10px] text-gray-600"><b>{it}</b> · {bucket}<div className="text-gray-500 mt-0.5">observed presence on this platform (phone/registry-linked)</div><div className="text-gray-400 mt-0.5">evidence: Debug band → Sign3 social / web / registry nodes</div></div>
                    </details>
                  ) : (<span key={`${bucket}-${it}-${i}`} className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200 text-[10.5px]" title={bucket}>{it}</span>))}
                </span>
              </div>
            )}
            {/* AI-EXTRACTED rows (profile findings · Needs-input) — hidden in Original (raw view); shown in Buyer Profile / Requirement.
                Identity Confidence ROW dropped (owner #18): the badge/drill already lives on the Available anchors. */}
            {buyerDetails.pii && buyerDetails.pii.length > 0 && (
              <div className="mt-1.5 pt-1.5 border-t border-gray-100">
                <button type="button" onClick={() => setShowPii((v) => !v)} className="text-[10.5px] font-semibold text-teal-700 inline-flex items-center gap-1 hover:underline">
                  <span>{showPii ? '🔓' : '🔒'}</span>{showPii ? 'Hide' : 'Reveal'} contact &amp; PII ({buyerDetails.pii.length})
                </button>
                {showPii && (
                  <div className="mt-1 rounded-lg border border-teal-100 bg-teal-50/40 p-2 space-y-0.5">
                    {buyerDetails.pii.map((p) => (<div key={p.label} className="flex gap-2 text-[10.5px]"><span className="w-24 shrink-0 text-gray-500">{p.label}</span><span className="flex-1 min-w-0 text-gray-800 font-mono break-words">{p.value}</span></div>))}
                  </div>
                )}
              </div>
            )}
            {!isOriginal && buyerDetails.profileRows.map((p, i) => (<DrillRow key={i} label={<span className={p.prov === 'det' ? 'text-teal-700' : 'text-violet-700'}>{p.label}</span>} value={p.value || '—'} drill={profileClickable ?p.drill : undefined} />))}
            {/* #6/#7/#8 — ALL attributes: every extracted key (incl. confidence <50 that is HIDDEN from the UC1 rows above),
                each expandable to its last raw line. The complete inspectable set the owner asked for below UC1. */}
            {!isOriginal && buyerDetails.allAttrRows && buyerDetails.allAttrRows.length > 0 && (
              <details className="mt-1.5 border-t border-gray-100 pt-1.5">
                <summary className="cursor-pointer text-[10px] font-semibold text-gray-500 select-none">All attributes ({buyerDetails.allAttrRows.length}) · full set incl. low-confidence (&lt;50 hidden above) — click any to expand to raw</summary>
                <div className="mt-1 space-y-0.5">
                  {buyerDetails.allAttrRows.map((a, i) => (<DrillRow key={i} label={<span className="text-gray-600">{a.label} <span className={a.conf < 50 ? 'text-rose-400 text-[8px]' : 'text-gray-400 text-[8px]'}>{a.conf}%</span></span>} value={a.value || '—'} drill={a.drill} />))}
                </div>
              </details>
            )}
            {!isOriginal && needsInput && needsInput.length > 0 ? (
              <div className="mt-3 rounded-md bg-amber-50/70 border border-amber-200 px-2.5 py-1.5">
                <div className="text-[11px] font-semibold text-amber-800">Needs input — ask the buyer (+{needsInput.length})</div>
                <div className="mt-1 space-y-1">
                  {needsInput.map((n, i) => (
                    <div key={i} className="text-[10.5px] leading-snug" title={n.reason || undefined}>
                      <span className="font-medium text-amber-800">{n.label}</span>
                      <span className="text-amber-700"> — “{n.question}”</span>
                    </div>
                  ))}
                </div>
                <div className="text-[9px] text-amber-600/80 mt-0.5">the AI could not ground these from the evidence — ask the buyer</div>
              </div>
            ) : (!isOriginal && stillAsk && stillAsk.length > 0 && (
              <div className="mt-3 rounded-md bg-amber-50/70 border border-amber-200 px-2.5 py-1.5">
                <div className="text-[11px] font-semibold text-amber-800">Needs input — ask the buyer (+{stillAsk.length})</div>
                <div className="text-[10.5px] text-amber-700 mt-0.5">{stillAsk.join(' · ')}</div>
                <div className="text-[9px] text-amber-600/80 mt-0.5">not deduced at high confidence — surface these in the form</div>
              </div>
            ))}
            {retailLead && <div className="mt-3 inline-block rounded-md bg-amber-50 border border-amber-200 px-2.5 py-1 text-[12px] font-semibold text-amber-800">This might be a retail lead</div>}
          </div>
        )}
      </div>
      {/* enrich action / outcome banner — always visible (was buried inside the debug expander) */}
      {enrichControl && <div className="mt-2">{enrichControl}</div>}
      {/* consolidated footer legend (subtext, bottom of card) — colours used above, in one place */}
      <div className="mt-2 pt-1.5 border-t border-gray-100 text-[9.5px] text-gray-400 flex flex-wrap gap-x-3 gap-y-0.5">
        <span><span className="line-through text-rose-400">struck</span> = old · <span className="text-violet-700">violet</span> = AI corrected/added · <span className="text-emerald-700">green</span> = buyer-filled (kept)</span>
        <span><span className="text-violet-700 font-semibold">violet key</span> = LLM-derived · <span className="text-teal-700 font-semibold">teal key</span> = deterministic / verified</span>
      </div>
      {/* collapsed run receipt — ONLY what the card itself can't show: eval chips · rejected/dropped edits · raw LLM
          input. Per-field reasoning lives ON the card (click any struck/violet/green value); the duplicate table is gone. */}
      {(() => {
        const appliedRows = fields.filter((f) => f.action === 'corrected' || f.action === 'added');
        const rejected = fields.filter((f) => f.action === 'dropped' || f.action === 'suggested');
        if (!offerEval && appliedRows.length === 0 && rejected.length === 0 && enrichInput === undefined) return null;
        return (
          <Expand label="⚙ enrichment run details" tone="amber">
            {offerEval && (
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`text-[9.5px] px-1.5 py-0.5 rounded border ${offerEval.groundedPct >= 70 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}><b>{Math.round(offerEval.groundedPct)}%</b> grounded</span>
                <span className={`text-[9.5px] px-1.5 py-0.5 rounded border ${offerEval.hallucinations ? 'bg-rose-50 text-rose-600 border-rose-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}><b>{offerEval.hallucinations}</b> hallucination{offerEval.hallucinations === 1 ? '' : 's'}</span>
                <span className={`text-[9.5px] px-1.5 py-0.5 rounded border ${offerEval.verdict === 'strong' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{offerEval.verdict}</span>
              </div>
            )}
            {/* audit P1 (ledgerBands:636): the APPLIED corrected/added edits (before→after + reasoning drill) — previously
                counted in the banner but rendered nowhere in this receipt. */}
            {appliedRows.length > 0 && (
              <div className="mb-1.5">
                <div className="text-[10px] font-semibold text-violet-600">applied to the lead ({appliedRows.length}) — AI corrected/added, grounded in buyer signals</div>
                {appliedRows.map((f, i) => (
                  <div key={`ap-${f.label}-${i}`} className="py-0.5">
                    <div className="flex items-start justify-between gap-3 text-[11px]">
                      <span className="text-gray-400 shrink-0">{f.label}</span>
                      <span className="text-right min-w-0 break-words">{f.before && f.action !== 'kept' && <span className="line-through text-rose-300 mr-1">{f.before}</span>}<span className={ACTION_TONE[f.action] || 'text-gray-700'}>{f.after || '—'}</span><span className="text-[9px] text-gray-300 ml-1">{f.action}</span></span>
                    </div>
                    {f.drill && <Expand label="reasoning → evidence" tone="amber">{f.drill}</Expand>}
                  </div>
                ))}
              </div>
            )}
            {rejected.length > 0 && (
              <div className="mb-1.5">
                <div className="text-[10px] font-semibold text-gray-500">not applied to the lead ({rejected.length}) — assessed by the AI but rejected/removed</div>
                {rejected.map((f, i) => (
                  <div key={`${f.label}-${i}`} className="py-0.5">
                    <div className="flex items-start justify-between gap-3 text-[11px]">
                      <span className="text-gray-400 shrink-0">{f.label}</span>
                      <span className="text-right min-w-0 break-words">{f.before && <span className="line-through text-rose-300 mr-1">{f.before}</span>}<span className={ACTION_TONE[f.action] || 'text-gray-700'}>{f.after || '—'}</span><span className="text-[9px] text-gray-300 ml-1">{f.action}</span></span>
                    </div>
                    {f.drill && <Expand label="reasoning → evidence" tone="amber">{f.drill}</Expand>}
                  </div>
                ))}
              </div>
            )}
            <div className="text-[9.5px] text-gray-400 mb-1">per-field reasoning is on the card itself — click any struck / violet / green value above.</div>
            {enrichInput !== undefined && <Expand label="raw INPUT — enrichment source fields sent to the offer-LLM" tone="slate"><div className="max-h-72 overflow-auto"><JsonTree data={enrichInput} openDepth={99} /></div></Expand>}
          </Expand>
        );
      })()}
    </Band>
  );
}

// ── UC2 · DEBUG (sits BETWEEN L6/UC1 and L7/UC2) — the AI-assisted-app honesty screen for the enrichment LLM:
// INPUT (exact prompt) · LLM (model/tokens/cost/latency/prompt-ver) · EVAL (grounded%/hallucinations/leaks/verdict)
// · per-edit before→after with cited [fN] evidence. Mirrors the L0 chip style + L6 field-diff. Tone violet (AI accent).
export function UC2DebugBand({ reqTitle, status, model, promptVersion, usage, evalRes, edits, input, rawOutput, coverage, defaultOpen }: {
  reqTitle?: string;
  status: 'idle' | 'loading' | 'done' | 'no-key' | 'failed';   // audit 2026-07-13: a failed LLM call must never read as 'done/clean'
  model?: string; promptVersion?: string;
  usage?: { in: number; out: number; reasoning: number; ms: number; costUsd?: number } | null;
  evalRes?: UC2Eval | null; edits?: UC2EditFull[];
  input?: { system?: string; user?: string } | null;
  rawOutput?: string;                                                       // P6 — verbatim model output (before parse)
  coverage?: { consumed: number; unaccounted: number; total: number } | null; // P11 — PNS hero-signal coverage
  defaultOpen?: boolean;
}) {
  const chip = (label: string, v: ReactNode, tone = 'bg-gray-50 text-gray-600 border-gray-200') => <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tone} tabular-nums`}>{label} <b>{v}</b></span>;
  const ed = edits || [];
  const applied = ed.filter((e) => e.applied);   // what actually changed the requirement
  const held = ed.filter((e) => !e.applied);     // assessed but NOT applied (ungrounded / below the confidence gate)
  const statusTxt = status === 'no-key' ? 'no LLM key — dummy fallback' : status === 'failed' ? 'enrichment call failed' : status === 'loading' ? 'enriching…' : status === 'done' ? `${applied.length} applied${held.length ? ` · ${held.length} held` : ''}` : 'idle';
  const KIND_TONE: Record<string, string> = { corrected: 'text-violet-700 font-semibold', added: 'text-violet-700 font-semibold', kept: 'text-gray-400' };
  const editRow = (e: UC2EditFull, i: number, open?: boolean) => (
    <details key={`${e.group}:${e.field}:${e.kind}:${i}`} open={open} className="py-0.5">
      <summary className="cursor-pointer list-none flex items-start justify-between gap-2 text-[11px]">
        <span className="text-gray-400 shrink-0 w-28 truncate">{e.group}:{e.field}</span>
        <span className="flex-1 min-w-0 text-right break-words">{e.from && e.kind !== 'kept' && <span className="line-through text-rose-300 mr-1">{e.from}</span>}<span className={KIND_TONE[e.applied ? e.kind : 'kept']}>{e.to || '—'}</span><span className="text-[9px] text-gray-300 ml-1">{e.applied ? e.kind : `${e.kind}·held`}</span> <span className={`text-[9px] ${e.grounded ? 'text-emerald-500' : 'text-rose-400'}`}>{e.confidence}%{e.grounded ? '✓' : '⚠'}</span></span>
      </summary>
      <div className="mt-1 ml-2 rounded bg-gray-50 border border-gray-200 p-1.5 text-[10px] text-gray-600">
        {e.reason && <div className="mb-1">{e.reason}</div>}
        {/* confidence reasoning — why this %, and what would make it 100 (model's §9 self-report) */}
        <div className="mb-1 border-l-2 border-gray-200 pl-1.5 text-[9.5px] text-gray-500">
          <div><span className="text-gray-400">confidence {e.confidence}% — how it's scored: </span>{CONF_CRITERIA_LLM}</div>
          {e.confidenceReason && <div><span className="text-gray-400">why {e.confidence}%: </span>{e.confidenceReason}</div>}
          {e.to100 && <div><span className="text-emerald-600">to reach 100%: </span>{e.to100}</div>}
        </div>
        {e.evidence.length ? e.evidence.map((ev) => <div key={ev.evidence_id} className="font-mono text-[9.5px] text-indigo-500">↳ [{ev.evidence_id}] <span className="text-gray-500">{ev.node}{ev.tag ? ` · ${ev.tag}` : ''}</span>: “{ev.raw.length > 80 ? ev.raw.slice(0, 80) + '…' : ev.raw}”</div>) : <div className="text-rose-400">no evidence cited{e.kind !== 'kept' ? ' — ungrounded (held)' : ''}</div>}
      </div>
    </details>
  );
  return (
    <Band code="UC2·debug" title={reqTitle ? `Requirement: ${reqTitle}` : 'Requirement enrichment — input · LLM · eval'} subtitle={reqTitle ? 'input · LLM · eval — this requirement only' : undefined} tone="violet" defaultOpen={defaultOpen}
      status={statusTxt} statusTone={status === 'done' ? 'indigo' : 'slate'}
      meta={usage ? <>{usage.in.toLocaleString()} in → {usage.out.toLocaleString()} out tok{usage.reasoning ? <> · {usage.reasoning.toLocaleString()} reasoning</> : null} · {usage.ms ? `${usage.ms} ms` : '—'}{promptVersion ? <> · prompt <span className="font-mono">{promptVersion}</span></> : null}</> : undefined}>
      {status === 'no-key' ? <BandEmpty>No LLM key — UC2 shows the deterministic dummy enrichment. Set VITE_LLM_KEY to run the real grounded enrichment.</BandEmpty> : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {model && chip('model', model, 'bg-slate-50 text-slate-600 border-slate-200')}
            {usage && chip('cost', fmtUsd(usage.costUsd ?? 0), 'bg-amber-50 text-amber-700 border-amber-200')}
            {evalRes && chip('grounded', `${evalRes.groundedPct}%`, evalRes.groundedPct >= 80 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200')}
            {evalRes && chip('hallucinations', evalRes.hallucinations, evalRes.hallucinations ? 'bg-rose-50 text-rose-600 border-rose-200' : 'bg-gray-50 text-gray-500 border-gray-200')}
            {evalRes && chip('leaks', evalRes.leaks, evalRes.leaks ? 'bg-rose-50 text-rose-600 border-rose-200' : 'bg-gray-50 text-gray-500 border-gray-200')}
            {evalRes && chip('verdict', evalRes.verdict, evalRes.verdict === 'strong' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : evalRes.verdict === 'no-llm' ? 'bg-gray-50 text-gray-400 border-gray-200' : 'bg-amber-50 text-amber-700 border-amber-200')}
            {evalRes && chip('changes', `${evalRes.corrected} corrected · ${evalRes.added} added`)}
            {coverage && chip('PNS coverage', `${coverage.consumed}/${coverage.total} used${coverage.unaccounted ? ` · ${coverage.unaccounted} unaccounted` : ''}`, coverage.unaccounted ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200')}
          </div>
          {ed.length > 0 ? (
            <div className="space-y-1.5">
              {applied.length > 0 && (
                <div className="space-y-0.5">
                  <div className="text-[9px] uppercase tracking-wide text-violet-600 font-semibold">Applied to the requirement ({applied.length})</div>
                  {applied.map((e, i) => editRow(e, i, true))}
                </div>
              )}
              {applied.length === 0 && status === 'done' && <div className="text-[11px] text-gray-500 italic">No changes applied — all {held.length} candidate edit{held.length === 1 ? ' was' : 's were'} held (ungrounded or below the confidence gate). The base requirement stands.</div>}
              {held.length > 0 && (
                <details open className="rounded-lg border border-gray-150 bg-gray-50/50">
                  <summary className="cursor-pointer list-none px-2 py-1 text-[10px] text-gray-500">Held / not applied ({held.length}) — assessed but ungrounded or below the confidence gate ▾</summary>
                  <div className="px-2 pb-1.5 space-y-0.5">{held.map((e, i) => editRow(e, i, true))}</div>
                </details>
              )}
            </div>
          ) : status === 'failed' ? <div className="text-[11px] text-rose-600 font-medium">⚠ Enrichment call failed — no verdict. This requirement was NOT checked (do not read as “clean”). Retry the enrichment.</div> : status === 'done' ? <div className="text-[11px] text-gray-400 italic">No corrections/additions — requirement confirmed clean.</div> : <div className="text-[11px] text-gray-400">{status === 'loading' ? 'running enrichment…' : 'idle'}</div>}
          {input && (input.system || input.user) && (
            <Expand label="＋ prompt input (system · user — exactly what the LLM saw)" tone="violet" defaultOpen>
              {input.system && <><div className="text-[9px] uppercase tracking-wide text-gray-400 mt-1">system</div><pre className="whitespace-pre-wrap break-words text-[10px] text-gray-600">{input.system}</pre></>}
              {input.user && <><div className="text-[9px] uppercase tracking-wide text-gray-400 mt-1">user</div><pre className="whitespace-pre-wrap break-words text-[10px] text-gray-600">{input.user}</pre></>}
            </Expand>
          )}
          {rawOutput && (
            <Expand label={`＋ RAW model OUTPUT — ${(rawOutput.length / 1000).toFixed(1)}k chars (verbatim JSON, BEFORE parse → mergeUC2LLM)`} tone="violet" defaultOpen>
              <pre className="whitespace-pre-wrap break-words text-[10px] font-mono text-gray-600 max-h-[28rem] overflow-auto">{rawOutput}</pre>
            </Expand>
          )}
        </div>
      )}
    </Band>
  );
}

// ── CRAWLER · web-verify (OSINT) — FRONTEND-only async scrape, rendered as its own block BELOW UC2 (owner) ────────
// CrawlerBand (Firecrawl on-demand OSINT scrape) REMOVED (owner obs-1, 2026-07-13): the crawler is gone entirely —
// web intelligence now comes ONLY from gweb (Gemini web-search) + Parallel.ai inside the n8n pull. The osintEnrich.ts
// module + gemini.osintSignalsLLM were deleted with it.

// ── L7 · UC2 · REQUIREMENT ENRICHMENT (3-brain alignment + the subtraction math) ────────────────────────────────
export interface ReqRow { key: string; value?: string; reasoning: string; suppressed: boolean; suppressionReason?: string; buyerState?: string; categoryState?: string }
export function L7Band({ rows, added, ask, dropped, coverage, hasBrain, drill, defaultOpen }: {
  rows: ReqRow[]; added: string[]; ask: string[]; dropped: Array<{ key: string; reason: string }>;
  coverage?: { rfq_keys: number; matched_buyer: number; matched_category: number; suppressed: number }; hasBrain?: boolean; drill?: ReactNode; defaultOpen?: boolean;
}) {
  const buyerKnown = coverage?.matched_buyer ?? 0;
  const hasCriticals = rows.length > 0 || ask.length > 0 || dropped.length > 0 || added.length > 0;
  const hasData = hasCriticals || buyerKnown > 0;
  const status = hasCriticals ? `${ask.length} ask · ${dropped.length} dropped` : buyerKnown > 0 ? `${buyerKnown} buyer-known` : hasBrain ? 'brain present · no criticals' : 'awaiting requirement_brain';
  return (
    <Band code="L7" title="UC2 · Requirement enrichment" subtitle="requirement modified after location + profile intelligence" tone="teal" defaultOpen={defaultOpen}
      status={status} statusTone={hasCriticals ? 'teal' : buyerKnown > 0 ? 'amber' : 'slate'}
      meta={coverage ? <>{coverage.rfq_keys} keys · {coverage.matched_buyer} buyer-matched · {coverage.matched_category} category-matched · {coverage.suppressed} suppressed</> : undefined}>
      {!hasData ? <BandEmpty>{hasBrain ? 'requirement_brain present but no category criticals + no buyer-known specs match this ISQ schema yet — category distill is the P7 long pole.' : 'No requirement_brain on this pull (it rides the -advanced dual-fetch). UC2 stays honest when it’s absent.'}</BandEmpty> : (
        <>
          {/* THE SUBTRACTION: ask = (critical + followups) − known */}
          <div className="grid grid-cols-3 gap-2 mb-2 text-center">
            <div className="rounded-lg bg-teal-50 border border-teal-200 py-1.5"><div className="text-[16px] font-bold text-teal-700 tabular-nums">{ask.length}</div><div className="text-[9px] text-teal-600 uppercase tracking-wide">still ask</div></div>
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 py-1.5"><div className="text-[16px] font-bold text-emerald-700 tabular-nums">{dropped.length}</div><div className="text-[9px] text-emerald-600 uppercase tracking-wide">dropped (known)</div></div>
            <div className="rounded-lg bg-sky-50 border border-sky-200 py-1.5"><div className="text-[16px] font-bold text-sky-700 tabular-nums">{added.length}</div><div className="text-[9px] text-sky-600 uppercase tracking-wide">added (intel)</div></div>
          </div>
          {ask.length > 0 && <Expand label={`still ask (${ask.length})`} tone="teal" defaultOpen>{ask.map((q, i) => <div key={i} className="text-[11px] text-gray-700 py-0.5">• {q}</div>)}</Expand>}
          {dropped.length > 0 && <Expand label={`dropped — proven known, the guardrail (${dropped.length})`} tone="emerald" defaultOpen>{dropped.map((d, i) => <div key={i} className="flex justify-between gap-2 text-[10.5px] py-0.5"><span className="text-gray-600">{d.key}</span><span className="text-gray-400">{d.reason}</span></div>)}</Expand>}
          {added.length > 0 && <Expand label={`added from category intel (${added.length})`} tone="sky" defaultOpen>{added.map((a, i) => <div key={i} className="text-[11px] text-gray-700 py-0.5">+ {a}</div>)}</Expand>}
          {rows.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">per-requirement alignment (every deduction → its brains)</div>
              {rows.map((r, i) => (
                <div key={`${r.key}-${i}`} className={`rounded-lg border px-2 py-1.5 mb-1 ${r.suppressed ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-150'}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium text-gray-700 flex-1 min-w-0 truncate">{r.key}{r.value ? <span className="text-gray-400 font-normal"> = {r.value}</span> : null}</span>
                    {r.buyerState && <span title="buyer brain">B:<StatePill state={r.buyerState} /></span>}
                    {r.categoryState && <span title="category distill">C:<StatePill state={r.categoryState} /></span>}
                    {r.suppressed && <span className="text-[9px] text-emerald-600 shrink-0">suppressed</span>}
                  </div>
                  <div className="text-[10.5px] text-gray-500 mt-0.5">{r.reasoning}{r.suppressed && r.suppressionReason ? <span className="text-emerald-600"> — {r.suppressionReason}</span> : null}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {drill && <div className="mt-2">{drill}</div>}
    </Band>
  );
}

// ── UC3 · OPEN THE RFQ FORM FOR THIS BUYER (mobile / desktop CTAs → debug mode) ─────────────────────────────────
export function UC3Band({ glid, onOpenForm, upcoming, defaultOpen }: { glid: string; onOpenForm?: (variant: 'v3' | 'v4', glid: string) => void; upcoming?: boolean; defaultOpen?: boolean }) {
  // `upcoming` (owner): the RFQ-form launch is built + wired but we're not enabling it yet — show it greyed,
  // not-clickable, badged "Upcoming". The onOpenForm wiring is preserved behind the scenes for when we turn it on.
  const can = !upcoming && !!onOpenForm && !!glid.trim();
  return (
    <Band code="UC3" title="Open the RFQ form for this buyer" subtitle={upcoming ? 'upcoming — RFQ form + AI Inspector are built & wired; not enabled here yet' : 'prefilled with everything above · debug mode · expandable to last raw line'} tone="slate" defaultOpen={defaultOpen}
      status={upcoming ? '🔒 Upcoming' : (glid ? `GLID ${glid}` : 'no GLID')} statusTone="slate">
      <div className={upcoming ? 'opacity-50 pointer-events-none select-none' : ''}>
        <p className="text-[11px] text-gray-500 mb-2">Launch the live RFQ for this buyer — the AI Inspector carries the same L1→L7 provenance into the form, every prefill traceable.</p>
        <div className="flex gap-2">
          <button type="button" disabled={!can} onClick={() => onOpenForm?.('v3', glid)}
            className="flex-1 px-3 py-2.5 rounded-xl bg-[#52b788] text-white text-[12px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            📱 Mobile · Voice RFQ (V3)
          </button>
          <button type="button" disabled={!can} onClick={() => onOpenForm?.('v4', glid)}
            className="flex-1 px-3 py-2.5 rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white text-[12px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
            🖥 Desktop · AI Inspector (V4)
          </button>
        </div>
      </div>
      {upcoming ? <p className="text-[10px] text-gray-400 mt-1.5">UC3 is on the roadmap — kept behind the scenes for now.</p> : (!can && <p className="text-[10px] text-gray-400 mt-1.5">{!glid.trim() ? 'Open the Ledger from a staged GLID to enable.' : 'Form launch not wired in this context.'}</p>)}
    </Band>
  );
}
