import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CheckCircle2, ChevronDown, ChevronRight, Clock3, Loader2, Radio, Send, Wifi, WifiOff } from 'lucide-react';
import BuyerLedgerView from './BuyerLedgerView';
import { LOCAL_RECEIVER_URL, loadCallbackUrl, preflightCallbackUrl, saveCallbackUrl } from '../lib/asyncCallback';

type CallbackEvent = {
  readonly id: string;
  readonly job_id?: string;
  readonly source?: string;
  readonly status?: string;
  readonly timestamp?: string;
  readonly received_at?: string;
  readonly data?: unknown;
};

const DEFAULT_GLID = '268590579';
const ASYNC_WEBHOOK_PATH = '/api/imworkflow/webhook/buyer-persona-async';

const PIPELINE_SOURCES = [
  { key: 'identity', label: 'Identity' },
  { key: 'external', label: 'External' },
  { key: 'pan-compile', label: 'PAN' },
  { key: 'mobile-compile', label: 'Mobile' },
  { key: 'gst-consensus', label: 'GST' },
  { key: 'pns-parser', label: 'PNS Insights' },
  { key: 'requirement', label: 'Requirements' },
  { key: 'websearch-parse', label: 'Web Search' },
  { key: 'udyam-parse', label: 'Udyam' },
  { key: 'csl-merge', label: 'CSL Merge' },
] as const;

const SOURCE_TO_KEY: Record<string, string> = {
  'identity': 'identity',
  'external': 'external',
  'pan-compile': 'pan_union',        // final-assemble emits the wrapper under pan_union (not 'pan')
  'mobile-compile': 'mobiles',       // final-assemble emits the wrapper under mobiles (not 'mobile')
  'gst-consensus': 'gst_detail_union', // the consensus node IS gst_detail_union (not gst_cert_idfy)
  'pns-parser': 'pns',
  'requirement': 'requirement',
  'websearch-parse': 'web_osint',
  'udyam-parse': 'udyam',
  'csl-merge': 'csl',
};

// The pan/mobile compile nodes emit ONE ITEM PER ROW (a bare array of {pan,…}/{mobile,…} rows); final-assemble
// wraps them into {summary:{rows,primary,count}, rows, __health}. Mirror that wrapper here so the progressive
// sources match the final payload's shape (the ledger reads sources.pan_union.rows / sources.mobiles.summary.primary).
function wrapRowsPartial(source: string, data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  if (source === 'pan-compile') {
    const rows = data.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !!((x as Record<string, unknown>).pan));
    const primary = rows.find((r) => Number(r.agreement_count ?? 0) >= 2) ?? rows[0] ?? null;
    return { summary: { rows, primary: primary?.pan ?? null, count: rows.length }, rows, __health: { node: 'pan_union', ok: rows.length > 0, status: rows.length ? 'success' : 'no_data', count: rows.length } };
  }
  if (source === 'mobile-compile') {
    const rows = data.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !!((x as Record<string, unknown>).mobile));
    const primary = rows.find((r) => r.is_primary === true) ?? rows[0] ?? null;
    return { summary: { rows, primary: primary?.mobile ?? null, count: rows.length }, rows, __health: { node: 'mobiles', ok: rows.length > 0, status: rows.length ? 'success' : 'no_data', count: rows.length } };
  }
  return data;
}

const TIERS = ['superfast', 'fast', 'normal'] as const;
type Tier = (typeof TIERS)[number];

// Date.now() wrapped at module scope — react-hooks/purity flags impure calls inside render-scope
// functions; every call site below is an event handler / interval callback, but the wrapper keeps lint quiet.
const nowMs = (): number => Date.now();

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function AsyncBuyerProfilePage() {
  const [glid, setGlid] = useState(DEFAULT_GLID);
  const [tier, setTier] = useState<Tier>('fast');
  const [callbackUrl, setCallbackUrl] = useState(() => loadCallbackUrl());
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null);
  const [completedAt, setCompletedAt] = useState<number | null>(null);
  const [phase, setPhase] = useState<'idle' | 'submitting' | 'streaming' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [events, setEvents] = useState<readonly CallbackEvent[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const jobIdRef = useRef(jobId);
  useEffect(() => { jobIdRef.current = jobId; }, [jobId]);   // ref write belongs in an effect, not render
  const seenIdsRef = useRef(new Set<string>());
  const doneRef = useRef(false);

  const [progressiveRich, setProgressiveRich] = useState<Record<string, unknown>>({});

  const arrivedSources = useMemo(() => {
    const map = new Map<string, CallbackEvent>();
    for (const e of events) {
      if (e.job_id === jobId && e.source) map.set(e.source, e);
    }
    return map;
  }, [events, jobId]);

  const addEvent = useCallback((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const e = raw as CallbackEvent;
    if (!e.job_id || e.job_id !== jobIdRef.current) return;
    const id = e.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (seenIdsRef.current.has(id)) return;
    seenIdsRef.current.add(id);
    const ev = { ...e, id };
    setEvents((prev) => [ev, ...prev].slice(0, 50));
    if (ev.status === 'complete' && ev.source === 'final') {
      doneRef.current = true;
      const d = ev.data;
      if (d && typeof d === 'object') setProgressiveRich(d as Record<string, unknown>);
      setCompletedAt(Date.now());
      setPhase('done');
    } else if (ev.status === 'partial' && ev.source && ev.data && !doneRef.current) {
      const src = ev.source;                 // hoist — property narrowing does not survive into the setState closure
      const payload = ev.data;
      const sourceKey = SOURCE_TO_KEY[src] || src;
      setProgressiveRich((prev) => {
        const oldSources = (prev.sources && typeof prev.sources === 'object' ? prev.sources : {}) as Record<string, unknown>;
        return { ...prev, sources: { ...oldSources, [sourceKey]: wrapRowsPartial(src, payload) } };
      });
    }
  }, []);

  useEffect(() => {
    const es = new EventSource(`${LOCAL_RECEIVER_URL}/events`);
    es.onopen = () => setSseConnected(true);
    es.onmessage = (msg) => { try { addEvent(JSON.parse(msg.data)); } catch { /* skip */ } };
    es.onerror = () => setSseConnected(false);
    return () => es.close();
  }, [addEvent]);

  useEffect(() => {
    if (!jobId || doneRef.current) return;
    let alive = true;
    const poll = async () => {
      if (doneRef.current) return;
      try {
        const r = await fetch(`${LOCAL_RECEIVER_URL}/history`);
        if (!r.ok) return;
        const body = await r.json();
        const list = Array.isArray(body?.events) ? body.events : [];
        if (alive) list.forEach(addEvent);
      } catch { /* noop */ }
    };
    void poll();
    const t = setInterval(() => void poll(), 3000);
    return () => { alive = false; clearInterval(t); };
  }, [addEvent, jobId]);

  async function startJob() {
    setPhase('submitting');
    setError('');
    setProgressiveRich({});
    setEvents([]);
    setExpandedSource(null);
    setCompletedAt(null);
    seenIdsRef.current = new Set();
    doneRef.current = false;
    try {
      // Dead-tunnel guard — a quick-tunnel URL dies on every cloudflared restart, and n8n would then
      // POST partials into the void while this page hangs at 0/10 forever. Verify the public URL
      // actually round-trips to the local receiver BEFORE firing n8n (no wasted pipeline run).
      const cb = callbackUrl.trim();
      if (!(await preflightCallbackUrl(cb))) {
        setPhase('error');
        setError('Callback URL is not reaching this machine (dead tunnel?). Restart it with `npm run callback:tunnel`, paste the new https://…trycloudflare.com URL it prints into the Callback URL field, and pull again. n8n was NOT fired.');
        return;
      }
      saveCallbackUrl(cb);
      const qs = new URLSearchParams({ glid, tier, callback_url: cb }).toString();
      // GET, not POST — the shared-n8n webhook is GET-registered (a POST returns 404 "not
      // registered for POST requests"). Every parameter rides the query string.
      const res = await fetch(`${ASYNC_WEBHOOK_PATH}?${qs}`);
      const body = await res.json();
      if (!res.ok) throw new Error(`n8n returned ${res.status}`);
      const jid = typeof body?.job_id === 'string' ? body.job_id : null;
      if (!jid) {
        // cache-gate hit: n8n served the cached FULL payload (no job_id — no callbacks will ever come).
        // Render it directly instead of hanging in 'streaming' forever filtering out every callback.
        if (body && typeof body === 'object' && 'sources' in (body as Record<string, unknown>)) {
          setProgressiveRich(body as Record<string, unknown>);
          setCompletedAt(nowMs());
          setPhase('done');
          return;
        }
        throw new Error('n8n response has no job_id (and is not a cached payload)');
      }
      setJobId(jid);
      setJobStartedAt(nowMs());
      setNow(nowMs());            // seed the elapsed clock — first interval tick arrives 500ms later
      setPhase('streaming');
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const arrivedCount = arrivedSources.size - (arrivedSources.has('final') ? 1 : 0);
  const totalSources = PIPELINE_SOURCES.length;
  const hasAnySources = !!progressiveRich.sources && typeof progressiveRich.sources === 'object' && Object.keys(progressiveRich.sources as object).length > 0;
  const [now, setNow] = useState(0);
  const elapsedStr = jobStartedAt ? formatElapsed((completedAt ?? now) - jobStartedAt) : '';

  // Live-updating timer during streaming — Date.now() lives ONLY inside the interval callback (never in
  // render), driving a `now` state so the elapsed readout stays lint-clean.
  useEffect(() => {
    if (phase !== 'streaming' || !jobStartedAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [phase, jobStartedAt]);


  return (
    <div className="min-h-screen bg-gray-50">
      {/* CONTROL BAR */}
      <div className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur-sm shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-teal-600" />
              <span className="text-sm font-bold text-gray-800">Async Buyer Profile</span>
            </div>

            <input
              value={glid}
              onChange={(e) => setGlid(e.target.value.replace(/[^0-9]/g, ''))}
              className="w-28 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm outline-none focus:border-teal-400"
              placeholder="GLID"
            />

            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-[11px]">
              {TIERS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTier(t)}
                  className={`px-2.5 py-1.5 capitalize transition ${tier === t ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  {t}
                </button>
              ))}
            </div>

            <input
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              className="flex-1 min-w-[180px] rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-mono outline-none focus:border-teal-400"
              placeholder="https://…trycloudflare.com (from npm run callback:tunnel)"
            />

            <button
              type="button"
              onClick={() => void startJob()}
              disabled={!glid.trim() || !callbackUrl.trim() || phase === 'submitting'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              <Send className="w-3.5 h-3.5" />
              {phase === 'submitting' ? 'Starting...' : 'Pull Async'}
            </button>

            <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${sseConnected ? 'text-emerald-600' : 'text-gray-400'}`}>
              {sseConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              SSE
            </span>
          </div>
          {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-4">
        {/* IDLE STATE */}
        {phase === 'idle' && (
          <div className="flex items-center justify-center min-h-[60vh] text-center">
            <div>
              <Radio className="w-12 h-12 text-gray-300 mx-auto mb-4" />
              <p className="text-lg font-semibold text-gray-700">Async Buyer Profile</p>
              <p className="text-sm text-gray-400 mt-1 max-w-md">
                Enter a GLID and click "Pull Async" to fire the streaming n8n pipeline.
                Sources arrive in real-time via SSE as each completes.
              </p>
              <p className="text-[11px] text-gray-400 mt-3">
                Needs the callback receiver + public tunnel:{' '}
                <code className="text-gray-600">npm run callback:receiver</code> and{' '}
                <code className="text-gray-600">npm run callback:tunnel</code> — paste the tunnel URL above.
              </p>
            </div>
          </div>
        )}

        {/* STREAMING / DONE STATE */}
        {(phase === 'streaming' || phase === 'done') && (
          <div className="space-y-4">
            {/* PIPELINE PROGRESS */}
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {phase === 'streaming' ? (
                    <Loader2 className="w-4 h-4 text-teal-600 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  )}
                  <span className="text-sm font-bold text-gray-800">
                    {phase === 'streaming' ? 'Pipeline running...' : 'Pipeline complete'}
                  </span>
                  <span className="text-[11px] text-gray-400">GLID {glid} · {tier}</span>
                </div>
                <div className="flex items-center gap-3 text-[11px]">
                  {jobId && <span className="font-mono text-gray-400">job: {jobId}</span>}
                  {elapsedStr && <span className="text-gray-400">{elapsedStr}</span>}
                  <span className="font-semibold text-teal-700">{arrivedCount}/{totalSources} sources</span>
                </div>
              </div>

              {/* PROGRESS BAR */}
              <div className="w-full bg-gray-100 rounded-full h-1.5 mb-3">
                <div
                  className={`h-1.5 rounded-full transition-all duration-500 ${phase === 'done' ? 'bg-emerald-500' : 'bg-teal-500'}`}
                  style={{ width: `${(arrivedCount / totalSources) * 100}%` }}
                />
              </div>

              {/* SOURCE CHIPS */}
              <div className="flex flex-wrap gap-2">
                {PIPELINE_SOURCES.map(({ key, label }) => {
                  const ev = arrivedSources.get(key);
                  const arrived = !!ev;
                  const isExpanded = expandedSource === key;
                  const chipElapsed = arrived && ev?.timestamp && jobStartedAt ? formatElapsed(new Date(ev.timestamp).getTime() - jobStartedAt) : null;
                  return (
                    <button
                      key={key}
                      onClick={() => arrived && setExpandedSource(isExpanded ? null : key)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                        arrived
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 cursor-pointer hover:bg-emerald-100'
                          : phase === 'streaming'
                            ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-default animate-pulse'
                            : 'border-gray-200 bg-gray-50 text-gray-400 cursor-default'
                      }`}
                    >
                      {arrived ? (
                        <CheckCircle2 className="w-3 h-3" />
                      ) : phase === 'streaming' ? (
                        <Clock3 className="w-3 h-3" />
                      ) : (
                        <Activity className="w-3 h-3" />
                      )}
                      {label}
                      {chipElapsed && (
                        <span className="text-[9px] text-emerald-500 ml-0.5">{chipElapsed}</span>
                      )}
                      {arrived && (isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)}
                    </button>
                  );
                })}
              </div>

              {/* EXPANDED SOURCE DATA */}
              {expandedSource && arrivedSources.has(expandedSource) && (
                <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">
                    {expandedSource} · partial data
                  </div>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] text-gray-600 leading-relaxed">
                    {JSON.stringify(arrivedSources.get(expandedSource)?.data, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            {/* GLADMIN BUYER LEDGER VIEW — renders with progressive data */}
            {hasAnySources && (
              <BuyerLedgerView
                glid={glid}
                onClose={() => {/* noop — embedded view */}}
                externalRich={progressiveRich}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
