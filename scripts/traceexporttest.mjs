// Deterministic test for the Langfuse trace exporter — mirrors the PURE bits of src/lib/traceExport.ts
// (buildLangfuseBatch + isExportEnabled). Proves: disabled-by-default (no keys → no-op), and the
// records+evals we already capture map to valid Langfuse ingestion events (trace + generations + scores). NO LLM, NO network.

function isExportEnabled(cfg) { return !!(cfg.publicKey && cfg.secretKey); }
function buildLangfuseBatch(input) {
  const { records, evals, sessionId, traceName, isoAt, idgen } = input;
  const events = [];
  const traceId = idgen('trace:' + sessionId);
  events.push({ id: idgen('ev:trace:' + sessionId), type: 'trace-create', timestamp: isoAt(records[0]?.at ?? evals[0]?.at ?? 0), body: { id: traceId, name: traceName, sessionId } });
  for (const r of records) events.push({ id: idgen(`ev:gen:${sessionId}:${r.label}:${r.at}`), type: 'generation-create', timestamp: isoAt(r.at), body: { id: idgen(`gen:${sessionId}:${r.label}:${r.at}`), traceId, name: r.label, model: r.model, usage: { input: r.promptTokens ?? 0, output: r.completionTokens ?? 0, total: (r.promptTokens ?? 0) + (r.completionTokens ?? 0), unit: 'TOKENS' }, metadata: { promptVersion: r.promptVersion, latencyMs: Math.round(r.ms), costUsd: r.costUsd, ok: r.ok }, level: r.ok ? 'DEFAULT' : 'ERROR' } });
  for (const e of evals) events.push({ id: idgen(`ev:score:${sessionId}:${e.kind}:${e.at}`), type: 'score-create', timestamp: isoAt(e.at), body: { id: idgen(`score:${sessionId}:${e.kind}:${e.at}`), traceId, name: e.kind, value: e.pct } });
  return events;
}

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── disabled by default (safe build) ──
ok('no keys → export DISABLED (no-op, V3-safe default)', !isExportEnabled({ host: 'x' }));
ok('public only → still disabled', !isExportEnabled({ publicKey: 'pk' }));
ok('both keys → enabled', isExportEnabled({ publicKey: 'pk', secretKey: 'sk' }));

// ── batch shape ──
const iso = (ms) => new Date(ms).toISOString();
const idgen = (s) => 'sess1-' + s.replace(/[^a-zA-Z0-9:_-]/g, '_');
const batch = buildLangfuseBatch({
  sessionId: 'sess1', traceName: 'RFQ V4 · Diesel Generator', isoAt: iso, idgen,
  records: [
    { label: 'deriveIntent', model: 'gemini-2.5-flash-lite', ms: 1820.6, promptTokens: 1400, completionTokens: 420, costUsd: 0.0006, promptVersion: 'intent-v5', at: 1700000000000, ok: true },
    { label: 'planRequirement', model: 'gemini-2.5-flash-lite', ms: 2400, promptTokens: 2000, completionTokens: 300, costUsd: 0.0009, promptVersion: 'plan-v7', at: 1700000001000, ok: false },
  ],
  evals: [{ kind: 'RFQ Quality', pct: 87, at: 1700000002000 }, { kind: 'Lead Quality', pct: 72, at: 1700000002500 }],
});
ok('one trace-create event', batch.filter((e) => e.type === 'trace-create').length === 1);
ok('one generation per LLM call (2)', batch.filter((e) => e.type === 'generation-create').length === 2);
ok('one score per eval (2)', batch.filter((e) => e.type === 'score-create').length === 2);
const gen = batch.find((e) => e.body.name === 'deriveIntent');
ok('generation carries model + token usage', gen.body.model === 'gemini-2.5-flash-lite' && gen.body.usage.total === 1820);
ok('generation carries promptVersion + cost + latency metadata', gen.body.metadata.promptVersion === 'intent-v5' && gen.body.metadata.costUsd === 0.0006 && gen.body.metadata.latencyMs === 1821);
ok('failed call → level ERROR', batch.find((e) => e.body.name === 'planRequirement').body.level === 'ERROR');
ok('all generations + scores share the session traceId', (() => { const tid = batch.find((e) => e.type === 'trace-create').body.id; return batch.filter((e) => e.type !== 'trace-create').every((e) => e.body.traceId === tid); })());
const score = batch.find((e) => e.type === 'score-create');
ok('score carries eval name + numeric value', score.body.name === 'RFQ Quality' && score.body.value === 87);
ok('event ids are sanitized (no spaces/colons-in-name issues)', batch.every((e) => /^[a-zA-Z0-9:_-]+$/.test(e.id)));

// ── empty → just the trace shell (graceful) ──
ok('empty records+evals → only the trace shell', buildLangfuseBatch({ records: [], evals: [], sessionId: 's', traceName: 't', isoAt: iso, idgen }).length === 1);

console.log(`\ntraceexporttest (Langfuse exporter · disabled-by-default · LLM records→generations · evals→scores · session trace · sanitized ids · graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
