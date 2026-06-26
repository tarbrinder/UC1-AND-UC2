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
import { Band, KV, StatePill, MiniBar, Expand, BandEmpty, type BandTone } from './Band';
import type { UC2Enrichment, UC2Edit, UC2EditFull, UC2Eval } from '../../lib/uc2Enrichment';
import { runSellerVerify, hasCrawlerKey, type SellerVerifyState } from '../../lib/sellerVerify';

// human label for each merged-source key (local copy so this file stays pure — no lib import)
const RAW_SRC_LABEL: Record<string, string> = {
  csl: 'CSL · on-site behaviour', requirement: 'Requirement · BuyLeads ⨝ ISQ', whatsapp: 'WhatsApp · one timeline',
  identity: 'Identity · Profile ⊕ GLUSR', pns: 'PNS · sales calls (spoken)', external: 'External · Befisc ⊕ Sign3 (triangulation)',
};
const srcLabel = (k: string) => RAW_SRC_LABEL[k] || k;
const fmtUsd = (n: number) => (n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(5)}` : '$0');
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
          {evalDetail && <Expand label="eval — grounding · confidence · what the verdict is built on" tone="emerald">{evalDetail}</Expand>}
          {harness && <Expand label="harness & eval-over-time — the offline suites + drift by prompt-version" tone="slate">{harness}</Expand>}
        </>
      )}
    </Band>
  );
}

// ── L1 · NODES & HEALTH ───────────────────────────────────────────────────────────────────────────────────────
export interface HealthRow { node: string; ok: boolean; latency_ms?: number; output_count?: number; source?: string }
// V10 (owner #8): coverage = what the ONE LLM actually SAW (sent) → what it CITED. NOT a dead ledger count.
export interface SourceRow { label: string; sent: number; cited: number }
export function L1Band({ health, sources, cov, endpoint, rich, drill, defaultOpen }: {
  health: HealthRow[]; sources: SourceRow[]; cov: { sent: number; cited: number; noise: number };
  endpoint?: string; rich?: { sources?: Record<string, unknown> } | null; drill?: ReactNode; defaultOpen?: boolean;
}) {
  // owner: "i want to see the raw response HERE, not go to n8n" — every merged source → its {summary, raw} payload, inline
  const rawSources = rich?.sources && typeof rich.sources === 'object' ? Object.entries(rich.sources as Record<string, unknown>) : [];
  const okCount = health.filter((h) => h.ok).length;
  const allOk = health.length > 0 && okCount === health.length;
  const covLine = <>{cov.sent} lines sent to LLM · <span className="text-emerald-700">{cov.cited} cited</span>{cov.noise > 0 && <> · {cov.noise} plumbing excluded</>}</>;
  return (
    <Band code="L1" title="Nodes & Health" subtitle="what n8n pulled · did each node succeed" tone="slate" defaultOpen={defaultOpen}
      status={health.length ? `${okCount}/${health.length} ok` : `${sources.length} sources`} statusTone={allOk ? 'emerald' : health.length ? 'rose' : 'slate'}
      meta={endpoint ? <>endpoint <span className="font-mono text-gray-500">{endpoint}</span> · {covLine}</> : covLine}>
      {health.length > 0 ? (
        <div className="space-y-0.5 mb-2">
          {health.map((h) => (
            <div key={h.node} className="flex items-center gap-2 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${h.ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
              <span className="flex-1 min-w-0 text-gray-700 truncate font-mono text-[10.5px]">{h.node}</span>
              {typeof h.output_count === 'number' && <span className="text-gray-400 shrink-0">{h.output_count} out</span>}
              {typeof h.latency_ms === 'number' && <span className="text-gray-400 shrink-0 tabular-nums">{h.latency_ms} ms</span>}
            </div>
          ))}
        </div>
      ) : <BandEmpty>No per-node __health on this response (the legacy -advanced path doesn't emit it). Source coverage below.</BandEmpty>}
      <Expand label={`LLM citation coverage — ${sources.length} sources · sent → cited`} tone="slate">
        <div className="text-[10px] text-gray-400 mb-1">how much of each source the single extract LLM actually grounded an attribute on (sent = lines shown · cited = lines it referenced).</div>
        {sources.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-[11px] py-0.5">
            <span className="flex-1 min-w-0 text-gray-600 truncate">{s.label}</span>
            <MiniBar pct={s.sent ? (s.cited / s.sent) * 100 : 0} tone={s.cited ? 'emerald' : 'slate'} />
            <span className="text-gray-400 shrink-0 tabular-nums">{s.cited}/{s.sent}</span>
          </div>
        ))}
      </Expand>
      {/* RAW RESPONSE PER NODE — the data, here, no n8n round-trip */}
      {rawSources.length > 0 && (
        <Expand label={`raw response — ${rawSources.length} nodes (summary + raw payload, here)`} tone="slate">
          <div className="text-[10px] text-gray-400 mb-1">exactly what each merged n8n node returned for this pull — <b>summary</b> = the distilled shape the LLM saw · <b>raw</b> = the full pre-distill payload.</div>
          <div className="space-y-1">
            {rawSources.map(([key, node]) => {
              const n = (node && typeof node === 'object') ? node as Record<string, unknown> : {};
              const summary = 'summary' in n ? n.summary : node;
              const raw = 'raw' in n ? n.raw : undefined;
              return (
                <div key={key} className="rounded-lg border border-gray-150 bg-gray-50/50 px-2 py-1">
                  <div className="text-[11px] font-medium text-gray-700">{srcLabel(key)} <span className="text-gray-300 font-normal font-mono text-[9.5px]">{sizeHint(summary)}</span></div>
                  <Expand label="summary (what the LLM saw)" tone="emerald"><pre className="text-[10px] leading-snug whitespace-pre-wrap break-words font-mono text-gray-600 max-h-72 overflow-auto">{JSON.stringify(summary ?? null, null, 2)}</pre></Expand>
                  {raw !== undefined && <Expand label={`raw (pre-distill payload · ${sizeHint(raw)})`} tone="slate"><pre className="text-[10px] leading-snug whitespace-pre-wrap break-words font-mono text-gray-500 max-h-72 overflow-auto">{JSON.stringify(raw, null, 2)}</pre></Expand>}
                </div>
              );
            })}
          </div>
        </Expand>
      )}
      {drill && <div className="mt-2">{drill}</div>}
    </Band>
  );
}

// ── L2 · BUYER SIGNALS (WhatsApp · RFQ · PNS), readable ─────────────────────────────────────────────────────────
export interface SignalChannel { key: string; label: string; count: number; tone: BandTone; sample?: string; body?: ReactNode }
export function L2Band({ channels, defaultOpen }: { channels: SignalChannel[]; defaultOpen?: boolean }) {
  const total = channels.reduce((s, c) => s + c.count, 0);
  return (
    <Band code="L2" title="Buyer signals — readable" subtitle="WhatsApp · RFQ/BLs · PNS calls · external" tone="sky" defaultOpen={defaultOpen}
      status={`${total} signals`} statusTone="sky">
      {channels.length === 0 ? <BandEmpty>No buyer signals pulled yet.</BandEmpty> : (
        <div className="space-y-1.5">
          {channels.map((c) => (
            <div key={c.key} className="rounded-lg border border-gray-150 bg-gray-50/60 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${c.tone === 'sky' ? 'bg-sky-50 text-sky-700 border-sky-200' : c.tone === 'emerald' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : c.tone === 'violet' ? 'bg-violet-50 text-violet-700 border-violet-200' : c.tone === 'amber' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-100 text-gray-600 border-gray-200'}`}>{c.label}</span>
                <span className="text-[11px] text-gray-500 flex-1">{c.count} {c.count === 1 ? 'item' : 'items'}</span>
              </div>
              {c.sample && <div className="text-[10.5px] text-gray-500 mt-1 line-clamp-2">{c.sample}</div>}
              {c.body && <Expand label="open full thread / records" tone="sky">{c.body}</Expand>}
            </div>
          ))}
        </div>
      )}
    </Band>
  );
}

// ── L3 · LLM INPUT (the ONE call: model · output ceiling · temperature · context · cost) ────────────────────────
// Owner Qs answered in the UI: there is ONE call (system + user are two PARTS of it, see L4); "max tokens" is the
// OUTPUT ceiling, not an input cap (we send everything — no line cap); the per-node "context" is the SOURCE GUIDE
// (expandable); the old "sent / raw" split is gone (no trims → sent==raw, so just the sent line count + its fN drill).
export interface CatalogRow { node: string; label: string; sent: number; raw?: number; transform?: string; evidence?: Array<{ id: string; tag: string; raw: string }> }
export function L3Band({ model, maxTokens, temperature, promptVersion, catalog, signalCount, usage, sourceGuide, defaultOpen }: {
  model?: string; maxTokens?: number; temperature?: number; promptVersion?: string;
  catalog: CatalogRow[]; signalCount: number;
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; ms?: number; costUsd?: number } | null;
  sourceGuide?: ReactNode; defaultOpen?: boolean;
}) {
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
      {sourceGuide && <Expand label="per-node CONTEXT — the SOURCE GUIDE the LLM is given (trust · what each node may influence · conflict priority)" tone="violet">{sourceGuide}</Expand>}
      <Expand label={`evidence sent — ${catalog.length} nodes (expand a node to see its exact fN lines)`} tone="violet" defaultOpen>
        {catalog.length === 0 ? <BandEmpty>Context not built yet.</BandEmpty> : catalog.map((c) => (
          <div key={c.node} className="py-0.5">
            <div className="flex justify-between gap-2 text-[10.5px]">
              <span className="text-gray-500 min-w-0 truncate">{c.label}{c.transform ? <span className="text-gray-300"> · {c.transform}</span> : null}</span>
              <span className="text-gray-600 shrink-0"><b>{c.sent}</b> line{c.sent === 1 ? '' : 's'}</span>
            </div>
            {c.evidence && c.evidence.length > 0 && (
              <Expand label={`${c.evidence.length} line${c.evidence.length === 1 ? '' : 's'} → exact text`} tone="slate">
                {c.evidence.map((e) => (
                  <div key={e.id} className="text-[10px] py-0.5 border-b border-gray-100 last:border-0">
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
export function L4Band({ system, user, output, defaultOpen }: { system?: string; user?: string; output?: string; defaultOpen?: boolean }) {
  const sys = system || ''; const usr = user || ''; const out = output || '';
  const chars = sys.length + usr.length;
  return (
    <Band code="L4" title="Raw prompt — the ONE call" subtitle="system + user are two PARTS of a single chat-completion (not two calls) — nothing hidden" tone="indigo" defaultOpen={defaultOpen}
      status={chars ? `${(chars / 1000).toFixed(1)}k chars` : 'no prompt'} statusTone={chars ? 'indigo' : 'slate'}>
      {!chars ? <BandEmpty>Prompt not built yet (no key, or the LLM hasn't been invoked on this view).</BandEmpty> : (
        <>
          <div className="text-[10px] text-gray-400 mb-1.5"><b>One</b> Gemini call, two parts. <b>system</b> = instructions only (role · frozen use-cases · source guide) — not your data. <b>user</b> = your ENTIRE n8n buyer payload, flattened into numbered lines (fN) the model must cite. So "evidence" = your n8n input; everything buyer-originated IS evidence — the only thing excluded is plumbing (ids · timestamps · parse flags).</div>
          <Expand label={`① system part — ${(sys.length / 1000).toFixed(1)}k chars (instructions / source guide)`} tone="indigo">
            <pre className="text-[10px] leading-snug whitespace-pre-wrap break-words font-mono text-gray-600 max-h-[36rem] overflow-auto">{sys || '(empty)'}</pre>
          </Expand>
          <Expand label={`② user part — ${(usr.length / 1000).toFixed(1)}k chars (the buyer evidence)`} tone="indigo">
            <pre className="text-[10px] leading-snug whitespace-pre-wrap break-words font-mono text-gray-600 max-h-[36rem] overflow-auto">{usr || '(empty)'}</pre>
          </Expand>
          {out && (
            <Expand label={`③ RAW model OUTPUT — ${(out.length / 1000).toFixed(1)}k chars (the verbatim JSON the LLM returned, BEFORE parse → extractedToFinals)`} tone="violet">
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
  const shown = attrs.filter((a) => !a.held);
  const held = attrs.filter((a) => a.held);
  const groups = [...new Set(shown.map((a) => a.group || 'attributes'))];
  return (
    <Band code="L5" title="LLM output — the Buyer Twin" subtitle="reasoning · eval · governance · provenance" tone="emerald" defaultOpen={defaultOpen}
      status={status === 'done' ? `${shown.length} held` : status} statusTone={status === 'done' ? 'emerald' : 'amber'}>
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
          {evalDrill && <Expand label="why these scores — ungrounded · low-confidence · verdict basis" tone="emerald">{evalDrill}</Expand>}
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
                  {drillFor && <Expand label="full reasoning → evidence → raw line" tone="emerald">{drillFor(a.key)}</Expand>}
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
// spec PROVENANCE legend (matches the classic Buylead card): Buyer Filled / Auto-Filled / Agent Filled / Predicted
const FILL_TONE: Record<string, { label: string; cls: string; dot: string }> = {
  buyer: { label: 'Buyer Filled Spec', cls: 'text-emerald-700', dot: 'bg-emerald-500' },
  auto: { label: 'Auto-Filled Spec', cls: 'text-amber-600', dot: 'bg-amber-500' },
  agent: { label: 'Agent Filled', cls: 'text-blue-600', dot: 'bg-blue-500' },
  predicted: { label: 'Predicted', cls: 'text-violet-600', dot: 'bg-violet-500' },
};
const fillTone = (f?: string) => FILL_TONE[f || 'buyer'] || FILL_TONE.buyer;
export interface L6Availability { key: string; label: string; present: boolean; verified: boolean; value: string; externalValue?: string; source: string; note: string }
export interface L6ProfileRow { label: string; value: string; drill?: ReactNode }
export interface L6BuyerDetails { name?: string; memberSince?: string; responseCalls?: number; responseReplies?: number; availability: L6Availability[]; profileRows: L6ProfileRow[] }

// compact channel icons for the "Available" row (matches the classic Buylead-Details card)
const AVAIL_ICON: Record<string, string> = { mobile: '📱', email: '✉️', address: '🏢', pan: '🪪', gst: '🧾', whatsapp: '💬' };

// a clean "Label : value" row; clickable (reveals its drill) when a deduction/source exists, plain otherwise
function DrillRow({ label, value, drill }: { label: ReactNode; value: ReactNode; drill?: ReactNode }) {
  if (!drill) return (<div className="flex items-start gap-2 text-[12px] py-1"><span className="w-40 shrink-0 font-semibold text-gray-700">{label}</span><span className="flex-1 min-w-0 text-gray-700 break-words"><span className="text-gray-400">: </span>{value}</span></div>);
  return (
    <details className="py-0.5 group/dr"><summary className="cursor-pointer list-none flex items-start gap-2 text-[12px] -mx-1 px-1 rounded hover:bg-gray-50"><span className="w-40 shrink-0 font-semibold text-gray-700 group-open/dr:text-indigo-700">{label}</span><span className="flex-1 min-w-0 text-gray-700 break-words"><span className="text-gray-400">: </span>{value}</span></summary><div className="mt-1 ml-2 rounded bg-gray-50 border border-gray-200 p-2 text-[11px]">{drill}</div></details>
  );
}

export function L6Band({ picker, selectedReq, uc2, productsOfInterest, requirementCount, buyerDetails, retailLead, titleDrill, locationDrill, fields, offerEval, enrichControl, defaultOpen }: {
  picker?: ReactNode; selectedReq?: L6Requirement | null; uc2?: UC2Enrichment | null;
  productsOfInterest?: { value: string; changed: boolean; drill?: ReactNode } | null;
  requirementCount?: number; buyerDetails?: L6BuyerDetails | null; retailLead?: boolean;
  titleDrill?: ReactNode; locationDrill?: ReactNode;
  fields: OfferFieldRow[]; offerEval?: { groundedPct: number; hallucinations: number; verdict: string } | null;
  enrichControl?: ReactNode; defaultOpen?: boolean;
}) {
  const ACTION_TONE: Record<string, string> = { kept: 'text-gray-400', corrected: 'text-amber-700', added: 'text-emerald-700', dropped: 'text-rose-600 line-through', suggested: 'text-sky-700' };
  const avail = (buyerDetails?.availability || []).filter((a) => a.present);
  // UC2 · requirement enrichment/correction — base truth ("Original") ⟷ AI-enriched ("AI-Enriched").
  // Owner (v11): UC2 defaults to AI-Enriched (the toggle still lets you flip back to Original/verbatim);
  // UC1 / Buyer Details has no toggle (it is always the AI-derived view).
  const [uc2Mode, setUc2Mode] = useState<'original' | 'enriched'>('enriched');
  const on = !!uc2 && uc2Mode === 'enriched';
  const NewTag = ({ label = 'new' }: { label?: string }) => (<span className="ml-1 align-middle text-[8px] font-bold uppercase tracking-wide text-violet-700 bg-violet-50 border border-violet-200 rounded px-1 py-px">{label}</span>);
  // a corrected scalar: ~~old~~ new, expandable to its reason
  const Corrected = ({ e }: { e: UC2Edit }) => (
    <details className="inline-block align-middle"><summary className="cursor-pointer list-none inline-flex flex-wrap items-baseline gap-1"><span className="line-through text-rose-400">{e.from}</span><span className="text-violet-700 font-semibold">{e.to}</span><NewTag label="corrected" /></summary><div className="mt-1 rounded bg-violet-50 border border-violet-200 p-1.5 text-[10px] text-violet-900">{e.reason}</div></details>
  );
  return (
    <Band code="L6" title="" tone="sky" defaultOpen={defaultOpen}>
      {/* the classic blue "Buylead Details" header bar (BuyLead selector tucked right) */}
      <div className="-mx-3 -mt-1 mb-3 px-4 py-2.5 bg-gradient-to-r from-blue-700 to-blue-500 rounded-t-lg flex items-center justify-between gap-2 flex-wrap">
        <span className="text-white font-bold text-[15px]">Buylead Details</span>
        <div className="flex items-center gap-2">
          {uc2 && (
            <div className="inline-flex rounded-md overflow-hidden border border-white/40 text-[10px] font-semibold shrink-0" title="UC2 — see the requirement before vs after AI enrichment/correction">
              <button type="button" onClick={() => setUc2Mode('original')} className={`px-2 py-0.5 ${!on ? 'bg-white text-blue-700' : 'text-white/90 hover:bg-white/10'}`}>Original</button>
              <button type="button" onClick={() => setUc2Mode('enriched')} className={`px-2 py-0.5 ${on ? 'bg-white text-violet-700' : 'text-white/90 hover:bg-white/10'}`}>AI-Enriched</button>
            </div>
          )}
          {picker}
        </div>
      </div>
      {on && uc2 && (<div className="-mt-1 mb-2 px-1 text-[11px] flex flex-wrap items-center gap-x-1.5"><span className="font-semibold text-violet-700">{uc2.summary}</span>{uc2.isDummy && <span className="text-[9px] text-gray-400">· sample data — real enrichment LLM not yet wired</span>}</div>)}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3 px-1">
        {/* LEFT — the BuyLead */}
        <div>
          {!selectedReq ? <BandEmpty>No requirement selected.</BandEmpty> : (
            <>
              {titleDrill ? (
                <details className="group/t"><summary className="cursor-pointer list-none text-[15px] font-semibold text-indigo-700 underline break-words">{selectedReq.title}</summary><div className="mt-1 rounded bg-gray-50 border border-gray-200 p-2 text-[11px]">{titleDrill}</div></details>
              ) : <div className="text-[15px] font-semibold text-indigo-700 underline break-words">{selectedReq.title}</div>}
              {on && uc2?.title && <div className="text-[12px] mt-0.5 text-gray-600">Title → <Corrected e={uc2.title} /></div>}
              {locationDrill ? (
                <details className="mt-1"><summary className="cursor-pointer list-none text-[12px] text-gray-600 flex flex-wrap items-center gap-x-1.5">{selectedReq.posted && <span>🕐 {selectedReq.posted}</span>}{selectedReq.location && <span className="text-indigo-600 hover:underline">🇮🇳 {selectedReq.location}</span>}</summary><div className="mt-1 rounded bg-gray-50 border border-gray-200 p-2 text-[11px]">{locationDrill}</div></details>
              ) : (
                <div className="text-[12px] text-gray-600 mt-1 flex flex-wrap items-center gap-x-1.5">{selectedReq.posted && <span>🕐 {selectedReq.posted}</span>}{selectedReq.location && <span>🇮🇳 {selectedReq.location}</span>}</div>
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
                        <details><summary className="cursor-pointer list-none"><span className="font-semibold text-gray-700">{s.k}</span><span className="text-gray-400">: </span><span className="line-through text-rose-400">{s.from}</span> <span className="text-violet-700 font-semibold">{s.to}</span><NewTag label="corrected" /></summary>{s.reason && <div className="mt-1 ml-2 rounded bg-violet-50 border border-violet-200 p-1.5 text-[10px] text-violet-900">{s.reason}</div>}</details>
                      ) : s.kind === 'added' ? (
                        <details><summary className="cursor-pointer list-none"><span className="font-semibold text-violet-700">{s.k}</span><span className="text-gray-400">: </span><span className="text-violet-700">{s.to}</span><NewTag /></summary>{s.reason && <div className="mt-1 ml-2 rounded bg-violet-50 border border-violet-200 p-1.5 text-[10px] text-violet-900">{s.reason}</div>}</details>
                      ) : (
                        <><span className="font-semibold text-emerald-700">{s.k}</span> <span className="text-emerald-700">: {s.to}</span></>
                      )}
                    </div>
                  ))}
                  <div className="mt-2 text-[9.5px] text-gray-400"><span className="line-through text-rose-400">struck</span> = old · <span className="text-violet-700">violet</span> = AI corrected/added · green = buyer-filled (kept)</div>
                </div>
              ) : selectedReq.specs && selectedReq.specs.length > 0 ? (
                <>
                  <div className="mt-2 space-y-0.5">{selectedReq.specs.map((s, j) => { const t = fillTone(s.filledBy); return (<div key={j} className="text-[12px]"><span className={`font-semibold ${t.cls}`}>{s.k}</span> <span className={t.cls}>: {s.v}</span></div>); })}</div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gray-500">{Object.values(FILL_TONE).map((t) => (<span key={t.label} className="inline-flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${t.dot}`} />{t.label}</span>))}</div>
                </>
              ) : selectedReq.specsStatus && selectedReq.specsStatus !== 'present' && !selectedReq.buyerInfo && !selectedReq.commercials ? (
                <div className="mt-2 text-[11px] text-gray-400 italic">{selectedReq.specsStatus === 'getisq5_empty_run' ? '⚠ getisq5 returned NOTHING this pull (specs API empty/timed out) — re-pull to fetch ISQ' : selectedReq.specsStatus === 'beyond_fetch_cap' ? 'ISQ specs not fetched for this lead this pull (beyond the per-offer ISQ fetch cap)' : selectedReq.specsStatus === 'not_fetched' ? "no ISQ on file for this lead (getisq5 didn't return it)" : selectedReq.specsStatus === 'none' ? "no ISQ specs — buyer didn't answer the ISQ for this lead" : `no specs (${selectedReq.specsStatus})`}</div>
              ) : null}
            </>
          )}
        </div>
        {/* RIGHT — Buyer Details */}
        {buyerDetails && (
          <div>
            <div className="text-[13px] font-semibold text-indigo-700 underline mb-1">Buyer Details{on && uc2?.profileNew && <NewTag label="AI-derived" />}</div>
            {productsOfInterest && <DrillRow label={<>Products of Interest{on && uc2?.poiNew && <NewTag />}</>} value={productsOfInterest.value || '—'} drill={productsOfInterest.changed ? productsOfInterest.drill : undefined} />}
            {requirementCount != null && <DrillRow label="Requirement till date" value={requirementCount} />}
            {(buyerDetails.responseCalls != null || buyerDetails.responseReplies != null) && <DrillRow label="Response" value={`Calls: ${buyerDetails.responseCalls ?? 0} | Replies: ${buyerDetails.responseReplies ?? 0}`} />}
            {buyerDetails.memberSince && <DrillRow label="Member since" value={buyerDetails.memberSince} />}
            {/* Available — icons only; click an icon to reveal its value · source (✓ profile / ✓✓ external) */}
            <div className="flex items-start gap-2 text-[12px] py-1">
              <span className="w-40 shrink-0 font-semibold text-gray-700">Available{on && <NewTag />}</span>
              <span className="flex-1 min-w-0"><span className="text-gray-400">: </span>
                {avail.length === 0 ? <span className="text-gray-400">—</span> : avail.map((a) => (
                  <details key={a.key} className="inline-block align-middle mr-1.5">
                    <summary className={`cursor-pointer list-none relative inline-flex items-center justify-center w-7 h-7 rounded border text-[13px] ${a.verified ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-gray-50'}`} title={a.label}>{AVAIL_ICON[a.key] || '•'}<span className={`absolute -top-1 -right-1 text-[7px] font-bold ${a.verified ? 'text-emerald-600' : 'text-gray-400'}`}>{a.verified ? '✓✓' : '✓'}</span></summary>
                    <div className="mt-1 rounded bg-gray-50 border border-gray-200 p-1.5 text-[10px] text-gray-600 w-52"><b>{a.label}</b>: {a.value || '—'}<div className="text-gray-500 mt-0.5">{a.note}</div><div className="text-gray-400">source: {a.source}</div></div>
                  </details>
                ))}
              </span>
            </div>
            {/* buyer-profile findings — clean clickable rows right below Available */}
            {buyerDetails.profileRows.map((p, i) => (<DrillRow key={i} label={<>{p.label}{on && <NewTag />}</>} value={p.value || '—'} drill={p.drill} />))}
            {retailLead && <div className="mt-3 inline-block rounded-md bg-amber-50 border border-amber-200 px-2.5 py-1 text-[12px] font-semibold text-amber-800">This might be a retail lead</div>}
          </div>
        )}
      </div>
      {/* one collapsed debug expander (offer-LLM enrichment + correctness) — off the clean card */}
      {(fields.length > 0 || offerEval || enrichControl) && (
        <Expand label="＋ enrichment & correctness (LLM debug)" tone="amber">
          <div className="flex items-center gap-2 mb-1.5">
            {offerEval && (<>
              <span className={`text-[9.5px] px-1.5 py-0.5 rounded border ${offerEval.groundedPct >= 70 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}><b>{Math.round(offerEval.groundedPct)}%</b> grounded</span>
              <span className={`text-[9.5px] px-1.5 py-0.5 rounded border ${offerEval.hallucinations ? 'bg-rose-50 text-rose-600 border-rose-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}><b>{offerEval.hallucinations}</b> hallucination{offerEval.hallucinations === 1 ? '' : 's'}</span>
              <span className={`text-[9.5px] px-1.5 py-0.5 rounded border ${offerEval.verdict === 'strong' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{offerEval.verdict}</span>
            </>)}
            {enrichControl}
          </div>
          {fields.map((f, i) => (
            <div key={`${f.label}-${i}`} className="py-0.5">
              <div className="flex items-start justify-between gap-3 text-[11px]">
                <span className="text-gray-400 shrink-0">{f.label}</span>
                <span className="text-right min-w-0 break-words">{f.before && f.action !== 'kept' && <span className="line-through text-rose-300 mr-1">{f.before}</span>}<span className={ACTION_TONE[f.action] || 'text-gray-700'}>{f.after || '—'}</span><span className="text-[9px] text-gray-300 ml-1">{f.action}</span></span>
              </div>
              {f.drill && <Expand label="reasoning → evidence" tone="amber">{f.drill}</Expand>}
            </div>
          ))}
        </Expand>
      )}
    </Band>
  );
}

// ── UC2 · DEBUG (sits BETWEEN L6/UC1 and L7/UC2) — the AI-assisted-app honesty screen for the enrichment LLM:
// INPUT (exact prompt) · LLM (model/tokens/cost/latency/prompt-ver) · EVAL (grounded%/hallucinations/leaks/verdict)
// · per-edit before→after with cited [fN] evidence. Mirrors the L0 chip style + L6 field-diff. Tone violet (AI accent).
export function UC2DebugBand({ status, model, promptVersion, usage, evalRes, edits, input, rawOutput, coverage, defaultOpen }: {
  status: 'idle' | 'loading' | 'done' | 'no-key';
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
  const statusTxt = status === 'no-key' ? 'no LLM key — dummy fallback' : status === 'loading' ? 'enriching…' : status === 'done' ? `${evalRes?.changed ?? 0} change${(evalRes?.changed ?? 0) === 1 ? '' : 's'}` : 'idle';
  const KIND_TONE: Record<string, string> = { corrected: 'text-violet-700 font-semibold', added: 'text-violet-700 font-semibold', kept: 'text-gray-400' };
  return (
    <Band code="UC2·debug" title="Requirement enrichment — input · LLM · eval" tone="violet" defaultOpen={defaultOpen}
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
            <div className="space-y-0.5">
              {ed.map((e, i) => (
                <details key={i} className="py-0.5">
                  <summary className="cursor-pointer list-none flex items-start justify-between gap-2 text-[11px]">
                    <span className="text-gray-400 shrink-0 w-28 truncate">{e.group}:{e.field}</span>
                    <span className="flex-1 min-w-0 text-right break-words">{e.from && e.kind !== 'kept' && <span className="line-through text-rose-300 mr-1">{e.from}</span>}<span className={KIND_TONE[e.applied ? e.kind : 'kept']}>{e.to || '—'}</span><span className="text-[9px] text-gray-300 ml-1">{e.applied ? e.kind : `${e.kind}·held`}</span> <span className={`text-[9px] ${e.grounded ? 'text-emerald-500' : 'text-rose-400'}`}>{e.confidence}%{e.grounded ? '✓' : '⚠'}</span></span>
                  </summary>
                  <div className="mt-1 ml-2 rounded bg-gray-50 border border-gray-200 p-1.5 text-[10px] text-gray-600">
                    {e.reason && <div className="mb-1">{e.reason}</div>}
                    {e.evidence.length ? e.evidence.map((ev) => <div key={ev.evidence_id} className="font-mono text-[9.5px] text-indigo-500">↳ [{ev.evidence_id}] <span className="text-gray-500">{ev.node}{ev.tag ? ` · ${ev.tag}` : ''}</span>: “{ev.raw.length > 80 ? ev.raw.slice(0, 80) + '…' : ev.raw}”</div>) : <div className="text-rose-400">no evidence cited{e.kind !== 'kept' ? ' — ungrounded (held)' : ''}</div>}
                  </div>
                </details>
              ))}
            </div>
          ) : status === 'done' ? <div className="text-[11px] text-gray-400 italic">No corrections/additions — requirement confirmed clean.</div> : <div className="text-[11px] text-gray-400">{status === 'loading' ? 'running enrichment…' : 'idle'}</div>}
          {input && (input.system || input.user) && (
            <Expand label="＋ prompt input (system · user — exactly what the LLM saw)" tone="violet">
              {input.system && <><div className="text-[9px] uppercase tracking-wide text-gray-400 mt-1">system</div><pre className="whitespace-pre-wrap break-words text-[10px] text-gray-600">{input.system}</pre></>}
              {input.user && <><div className="text-[9px] uppercase tracking-wide text-gray-400 mt-1">user</div><pre className="whitespace-pre-wrap break-words text-[10px] text-gray-600">{input.user}</pre></>}
            </Expand>
          )}
          {rawOutput && (
            <Expand label={`＋ RAW model OUTPUT — ${(rawOutput.length / 1000).toFixed(1)}k chars (verbatim JSON, BEFORE parse → mergeUC2LLM)`} tone="violet">
              <pre className="whitespace-pre-wrap break-words text-[10px] font-mono text-gray-600 max-h-[28rem] overflow-auto">{rawOutput}</pre>
            </Expand>
          )}
        </div>
      )}
    </Band>
  );
}

// ── CRAWLER · web-verify (OSINT) — FRONTEND-only async scrape, rendered as its own block BELOW UC2 (owner) ────────
// On-demand: a button fires runSellerVerify(glid) (fire → poll), kept OUT of the n8n pull so it never stalls the
// synchronous response. Self-contained state. Raw scrape result shown verbatim (shape captured on first live call).
export function CrawlerBand({ glid, defaultOpen }: { glid?: string; defaultOpen?: boolean }) {
  const [st, setSt] = useState<SellerVerifyState>({ status: 'idle' });
  const [tick, setTick] = useState(0);
  const run = () => { if (!glid) return; setSt({ status: 'running' }); setTick(0); runSellerVerify(glid, { onTick: (n) => setTick(n) }).then(setSt).catch((e) => setSt({ status: 'failed', error: String(e) })); };
  const statusTxt = st.status === 'idle' ? 'on-demand' : st.status === 'running' ? `scraping… (${tick})` : st.status;
  return (
    <Band code="OSINT" title="Web verify (crawler) — on-demand entity scrape" tone="slate" defaultOpen={defaultOpen} status={statusTxt} statusTone={st.status === 'done' ? 'indigo' : 'slate'}>
      <div className="text-[10.5px] text-gray-500 mb-1.5">Frontend-only async OSINT scrape for this GLID (fire → poll). Kept OUT of the n8n pull so it never stalls the sync response (V10 lock). Uses the IndiaMART LLM key.</div>
      {!hasCrawlerKey() ? <BandEmpty>No LLM key — crawler disabled (set VITE_LLM_KEY).</BandEmpty> : !glid ? <BandEmpty>No GLID in context.</BandEmpty> : (
        <>
          <button type="button" onClick={run} disabled={st.status === 'running'} className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50">{st.status === 'running' ? 'Scraping…' : st.status === 'done' ? 'Re-run scrape' : `Verify GLID ${glid}`}</button>
          {st.status === 'failed' && <div className="text-[10.5px] text-rose-500 mt-1">failed: {st.error || 'unknown'}{st.ms ? ` (${(st.ms / 1000).toFixed(0)}s)` : ''}</div>}
          {st.status === 'done' && (
            <Expand label={`＋ scrape result${st.ms ? ` · ${(st.ms / 1000).toFixed(0)}s · ${st.polls ?? 0} polls` : ''}`} tone="slate">
              <pre className="whitespace-pre-wrap break-words text-[10px] font-mono text-gray-600 max-h-[28rem] overflow-auto">{(() => { try { return JSON.stringify(st.result, null, 2); } catch { return String(st.result); } })()}</pre>
            </Expand>
          )}
        </>
      )}
    </Band>
  );
}

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
          {dropped.length > 0 && <Expand label={`dropped — proven known, the guardrail (${dropped.length})`} tone="emerald">{dropped.map((d, i) => <div key={i} className="flex justify-between gap-2 text-[10.5px] py-0.5"><span className="text-gray-600">{d.key}</span><span className="text-gray-400">{d.reason}</span></div>)}</Expand>}
          {added.length > 0 && <Expand label={`added from category intel (${added.length})`} tone="sky">{added.map((a, i) => <div key={i} className="text-[11px] text-gray-700 py-0.5">+ {a}</div>)}</Expand>}
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
export function UC3Band({ glid, onOpenForm, defaultOpen }: { glid: string; onOpenForm?: (variant: 'v3' | 'v4', glid: string) => void; defaultOpen?: boolean }) {
  const can = !!onOpenForm && !!glid.trim();
  return (
    <Band code="UC3" title="Open the RFQ form for this buyer" subtitle="prefilled with everything above · debug mode · expandable to last raw line" tone="rose" defaultOpen={defaultOpen}
      status={glid ? `GLID ${glid}` : 'no GLID'} statusTone={can ? 'rose' : 'slate'}>
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
      {!can && <p className="text-[10px] text-gray-400 mt-1.5">{!glid.trim() ? 'Open the Ledger from a staged GLID to enable.' : 'Form launch not wired in this context.'}</p>}
    </Band>
  );
}
