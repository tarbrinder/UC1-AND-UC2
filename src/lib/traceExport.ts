// ─── LANGFUSE TRACE EXPORT (V4 · optional, env-gated) ────────────────────────────────────────────
// The ONE thing a custom inspector can't easily do: cross-SESSION history + search + time-series eval
// dashboards (V4 is in-session only). This thin, dependency-free exporter ships the data we already
// capture — LLMCallRecord (model/tokens/cost/latency/version) + eval runs — to Langfuse (open-source,
// self-hostable, no LangChain lock-in). Reads existing state on an interval; NO engine/gemini edits →
// V3 is completely inert. No-op unless VITE_LANGFUSE_* keys are set, so the build is safe by default.
//
// Why Langfuse, not LangSmith: SDK-agnostic (we're not a LangChain app), self-hostable (prod-context
// prompts stay on your infra), and it ingests via a plain REST batch — no heavy dependency.

export interface LangfuseEnv { publicKey?: string; secretKey?: string; host?: string }
export interface ExportRecord { label: string; model: string; ms: number; promptTokens?: number; completionTokens?: number; costUsd?: number; promptVersion?: string; at: number; ok: boolean }
export interface ExportEval { kind: string; pct: number; at: number }
export interface LangfuseEvent { id: string; type: string; timestamp: string; body: Record<string, unknown> }

// SECURITY (audit 2026-07-13, P0): the Langfuse SECRET key must NEVER be read in browser code — doing so compiles it
// into the JS bundle AND every downloaded offline HTML. Reading the whole `import.meta.env` object was worse: Vite
// inlines ALL VITE_ vars when the bare env object is referenced. We now read ONLY the two non-secret vars via static
// per-var access (so Vite inlines only those), and NEVER the secret. Client-side export therefore no-ops; real
// ingestion must run server-side (an n8n webhook that injects LANGFUSE_SECRET_KEY from a non-VITE_ env var).
// ACTION: rotate the Langfuse secret + public keys, since prior builds shipped them.
export function langfuseConfig(): LangfuseEnv {
  return {
    publicKey: import.meta.env.VITE_LANGFUSE_PUBLIC_KEY as string | undefined,
    secretKey: undefined,                                                    // never in the browser — server-side only
    host: (import.meta.env.VITE_LANGFUSE_HOST as string | undefined) || 'https://cloud.langfuse.com',
  };
}
// Client build cannot authenticate to Langfuse without the secret (by design). isExportEnabled stays false in the
// browser so the exporter is inert; a server-side ingester supplies the secret. buildLangfuseBatch remains pure/harnessed.
export function isExportEnabled(cfg: LangfuseEnv): boolean {
  return !!(cfg.publicKey && cfg.secretKey);
}

// PURE: map the records + evals we already have into Langfuse ingestion events. Harnessed.
// One trace per session; each LLM call → a `generation` observation; each eval → a `score`.
export function buildLangfuseBatch(input: {
  records: ExportRecord[];
  evals: ExportEval[];
  sessionId: string;
  traceName: string;
  isoAt: (epochMs: number) => string;
  idgen: (seed: string) => string;
}): LangfuseEvent[] {
  const { records, evals, sessionId, traceName, isoAt, idgen } = input;
  const events: LangfuseEvent[] = [];
  const traceId = idgen('trace:' + sessionId);
  // one trace per session (idempotent upsert by id)
  events.push({ id: idgen('ev:trace:' + sessionId), type: 'trace-create', timestamp: isoAt(records[0]?.at ?? evals[0]?.at ?? 0), body: { id: traceId, name: traceName, sessionId } });
  for (const r of records) {
    events.push({
      id: idgen(`ev:gen:${sessionId}:${r.label}:${r.at}`),
      type: 'generation-create',
      timestamp: isoAt(r.at),
      body: {
        id: idgen(`gen:${sessionId}:${r.label}:${r.at}`), traceId, name: r.label, model: r.model,
        usage: { input: r.promptTokens ?? 0, output: r.completionTokens ?? 0, total: (r.promptTokens ?? 0) + (r.completionTokens ?? 0), unit: 'TOKENS' },
        metadata: { promptVersion: r.promptVersion, latencyMs: Math.round(r.ms), costUsd: r.costUsd, ok: r.ok },
        level: r.ok ? 'DEFAULT' : 'ERROR',
      },
    });
  }
  for (const e of evals) {
    events.push({
      id: idgen(`ev:score:${sessionId}:${e.kind}:${e.at}`),
      type: 'score-create',
      timestamp: isoAt(e.at),
      body: { id: idgen(`score:${sessionId}:${e.kind}:${e.at}`), traceId, name: e.kind, value: e.pct, comment: `${e.kind} eval ${e.pct}%` },
    });
  }
  return events;
}

// ── Runtime: start a poller that ships NEW records/evals to Langfuse. No-op if disabled. V4 calls this
//    on mount; returns a stop() fn. Side-effecting (fetch/interval/Date) — the PURE builder above is tested. ──
export function startTraceExport(opts: {
  getRecords: () => ExportRecord[];
  getEvals: () => ExportEval[];
  sessionId: string;
  traceName: string;
  intervalMs?: number;
}): () => void {
  const cfg = langfuseConfig();
  if (!isExportEnabled(cfg)) return () => {}; // disabled → inert
  let sentRecords = 0, sentEvals = 0, stopped = false;
  const auth = 'Basic ' + btoa(`${cfg.publicKey}:${cfg.secretKey}`);
  const flush = async () => {
    if (stopped) return;
    const allR = opts.getRecords(), allE = opts.getEvals();
    const records = allR.slice(sentRecords), evals = allE.slice(sentEvals);
    if (!records.length && !evals.length) return;
    const batch = buildLangfuseBatch({ records, evals, sessionId: opts.sessionId, traceName: opts.traceName, isoAt: (ms) => new Date(ms || Date.now()).toISOString(), idgen: (s) => `${opts.sessionId}-${s}`.replace(/[^a-zA-Z0-9:_-]/g, '_') });
    try {
      await fetch(`${cfg.host}/api/public/ingestion`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ batch }) });
      sentRecords = allR.length; sentEvals = allE.length;
    } catch { /* best-effort; retry next tick */ }
  };
  const t = setInterval(flush, opts.intervalMs ?? 15000);
  return () => { stopped = true; clearInterval(t); void flush(); };
}
