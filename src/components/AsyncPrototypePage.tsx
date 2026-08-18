import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Clock3, Copy, ExternalLink, RadioTower, Send, Server, XCircle, Zap } from 'lucide-react';
import { LOCAL_RECEIVER_URL, loadCallbackUrl, preflightCallbackUrl, saveCallbackUrl } from '../lib/asyncCallback';

type CallbackStatus = 'partial' | 'complete' | 'processing' | 'error' | string;

type CallbackEvent = {
  readonly id: string;
  readonly job_id?: string;
  readonly source?: string;
  readonly status?: CallbackStatus;
  readonly timestamp?: string;
  readonly received_at?: string;
  readonly data?: unknown;
  readonly error?: unknown;
};

type StartResponse = {
  readonly job_id?: string;
  readonly status?: string;
  readonly [key: string]: unknown;
};

const DEFAULT_GLID = '268590579';
const DEFAULT_TIER = 'fast';
const ASYNC_WEBHOOK_PATH = '/api/imworkflow/webhook/buyer-persona-async';
const ASYNC_WEBHOOK_URL = 'https://imworkflow.intermesh.net/webhook/buyer-persona-async';

function toEventId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isCallbackEvent(value: unknown): value is CallbackEvent {
  return Boolean(value && typeof value === 'object');
}

function statusClasses(status: CallbackStatus | undefined): string {
  switch (status) {
    case 'complete':
      return 'bg-green-50 text-green-700 border-green-200';
    case 'partial':
      return 'bg-teal-50 text-teal-700 border-teal-200';
    case 'processing':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'error':
      return 'bg-red-50 text-red-700 border-red-200';
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200';
  }
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function getStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = Object.entries(value).find(([entryKey]) => entryKey === key);
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function getArrayField(value: unknown, key: string): readonly unknown[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = Object.entries(value).find(([entryKey]) => entryKey === key);
  return Array.isArray(entry?.[1]) ? entry[1] : undefined;
}

function ensureEventId(event: CallbackEvent): CallbackEvent {
  return event.id ? event : { ...event, id: toEventId() };
}

function mergeEvents(current: readonly CallbackEvent[], incoming: readonly CallbackEvent[]): readonly CallbackEvent[] {
  const seen = new Set<string>();
  return [...incoming, ...current].filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  }).slice(0, 30);
}

export default function AsyncPrototypePage() {
  const [glid, setGlid] = useState(DEFAULT_GLID);
  const [tier, setTier] = useState(DEFAULT_TIER);
  const [callbackUrl, setCallbackUrl] = useState(() => loadCallbackUrl());
  const [events, setEvents] = useState<readonly CallbackEvent[]>([]);
  const [startResponse, setStartResponse] = useState<StartResponse | null>(null);
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'sent' | 'failed'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    const stream = new EventSource(`${LOCAL_RECEIVER_URL}/events`);
    stream.onmessage = (message) => {
      const parsed: unknown = JSON.parse(message.data);
      if (!isCallbackEvent(parsed)) return;
      setEvents((current) => mergeEvents(current, [ensureEventId(parsed)]));
    };
    stream.onerror = () => {
      setError('Callback receiver is not reachable. Start it with npm run callback:receiver.');
    };
    return () => stream.close();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadHistory(): Promise<void> {
      try {
        const response = await fetch(`${LOCAL_RECEIVER_URL}/history`);
        if (!response.ok) return;
        const body: unknown = await response.json();
        const historyEvents = (getArrayField(body, 'events') ?? []).filter(isCallbackEvent).map(ensureEventId);
        if (!cancelled && historyEvents.length > 0) {
          setEvents((current) => mergeEvents(current, historyEvents));
        }
      } catch (caught) {
        if (!(caught instanceof Error)) throw caught;
      }
    }

    void loadHistory();
    const timer = window.setInterval(() => void loadHistory(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const asyncQueryString = useMemo(() => {
    const params = new URLSearchParams({ glid, tier, callback_url: callbackUrl.trim() });
    return params.toString();
  }, [callbackUrl, glid, tier]);

  const curlCommand = useMemo(() => {
    return `curl "${ASYNC_WEBHOOK_URL}?${asyncQueryString}"`;
  }, [asyncQueryString]);

  const completedCount = events.filter((event) => event.status === 'complete').length;
  const partialCount = events.filter((event) => event.status === 'partial').length;

  async function startAsyncJob(): Promise<void> {
    setSubmitState('submitting');
    setError('');
    setStartResponse(null);
    try {
      // Dead-tunnel guard — same preflight as the profile page: verify the public callback URL
      // round-trips to the local receiver before firing n8n (a stale trycloudflare URL would
      // otherwise POST partials into the void with zero feedback here).
      const cb = callbackUrl.trim();
      if (!(await preflightCallbackUrl(cb))) {
        setSubmitState('failed');
        setError('Callback URL is not reaching this machine (dead tunnel?). Restart it with `npm run callback:tunnel`, paste the new URL it prints, and try again. n8n was NOT fired.');
        return;
      }
      saveCallbackUrl(cb);
      // GET — the webhook is GET-registered on the shared n8n (POST → 404).
      const response = await fetch(`${ASYNC_WEBHOOK_PATH}?${asyncQueryString}`);
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(`n8n returned ${response.status}`);
      }
      setStartResponse({
        job_id: getStringField(body, 'job_id'),
        status: getStringField(body, 'status') ?? 'accepted',
        payload: body,
      });
      setSubmitState('sent');
    } catch (caught) {
      setSubmitState('failed');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function copyCurl(): Promise<void> {
    await navigator.clipboard.writeText(curlCommand);
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-gradient-to-b from-[#f0f4f8] to-[#e8edf2] px-4 py-10 sm:py-16">
      <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-8">
        <section className="flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-teal-500 shadow-lg">
            <RadioTower className="h-8 w-8 text-white" />
          </div>
          <h1 className="mt-6 max-w-[17rem] text-3xl font-extrabold text-gray-900 sm:max-w-full sm:text-5xl">Async Streaming Prototype</h1>
          <p className="mt-3 max-w-[17rem] text-base leading-relaxed text-gray-500 sm:max-w-2xl sm:text-lg">
            Fire the Intermesh test async webhook, send callbacks to this machine, and watch partial buyer-persona
            payloads arrive before the final LLM narrative.
          </p>
          <a
            href={window.location.pathname}
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-teal-700 hover:text-teal-800"
          >
            <ExternalLink className="h-4 w-4" />
            Buyer Intelligence home
          </a>
        </section>

        <section className="grid w-full max-w-[22rem] min-w-0 grid-cols-[minmax(0,1fr)] gap-4 sm:mx-auto sm:max-w-full lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-teal-600" />
                <h2 className="text-lg font-bold text-gray-800">Start async pull</h2>
              </div>

              <div className="mt-5 space-y-4 text-left">
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Buyer GLID</span>
                  <input
                    value={glid}
                    onChange={(event) => setGlid(event.target.value.replace(/[^0-9]/g, ''))}
                    className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100"
                    placeholder="268590579"
                  />
                </label>

                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Tier</span>
                  <select
                    value={tier}
                    onChange={(event) => setTier(event.target.value)}
                    className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100"
                  >
                    <option value="fast">fast</option>
                    <option value="full">full</option>
                  </select>
                </label>

                <div className="rounded-xl border border-teal-100 bg-teal-50/70 p-3">
                  <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-teal-700">Callback URL sent to webhook</span>
                    <input
                      value={callbackUrl}
                      onChange={(event) => setCallbackUrl(event.target.value)}
                      className="mt-2 w-full rounded-xl border border-teal-200 bg-white px-3 py-2.5 font-mono text-sm text-teal-900 outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100"
                      placeholder="https://your-tunnel.ngrok-free.app"
                    />
                  </label>
                </div>

                <button
                  type="button"
                  onClick={() => void startAsyncJob()}
                  disabled={!glid.trim() || !callbackUrl.trim() || submitState === 'submitting'}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-teal-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                  {submitState === 'submitting' ? 'Starting job...' : 'POST to test webhook'}
                </button>

                {error && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Server className="h-5 w-5 text-indigo-600" />
                  <h2 className="text-lg font-bold text-gray-800">Local receiver</h2>
                </div>
                <span className="rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                  port 3457
                </span>
              </div>
              <div className="mt-4 rounded-xl bg-gray-900 p-3 text-left">
                <code className="block whitespace-pre-wrap break-words text-[12px] leading-relaxed text-gray-100">
                  npm run callback:receiver
                </code>
              </div>
              <button
                type="button"
                onClick={() => void copyCurl()}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:border-teal-300 hover:text-teal-700"
              >
                <Copy className="h-4 w-4" />
                Copy direct curl
              </button>
            </div>
          </div>

          <div className="min-w-0 space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <MetricCard Icon={Clock3} label="Job status" value={startResponse?.status ?? submitState} />
              <MetricCard Icon={Activity} label="Partials" value={String(partialCount)} />
              <MetricCard Icon={CheckCircle2} label="Complete" value={String(completedCount)} />
            </div>

            {startResponse && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-left">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Early response</p>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[12px] text-amber-950">
                  {prettyJson(startResponse)}
                </pre>
              </div>
            )}

            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-bold text-gray-800">Callback stream</h2>
                <span className="text-[12px] font-semibold text-gray-400">{events.length} events</span>
              </div>

              <div className="mt-4 space-y-3">
                {events.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-8 text-center text-sm text-gray-500">
                    Waiting for n8n to POST partial source payloads to {callbackUrl.trim() || LOCAL_RECEIVER_URL}.
                  </div>
                ) : (
                  events.map((event) => <CallbackEventRow key={event.id} event={event} />)
                )}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function MetricCard({ Icon, label, value }: { readonly Icon: typeof Activity; readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-gray-400">
        <Icon className="h-4 w-4" />
        <p className="text-[11px] font-semibold uppercase tracking-wide">{label}</p>
      </div>
      <p className="mt-2 truncate text-xl font-extrabold text-gray-900">{value}</p>
    </div>
  );
}

function CallbackEventRow({ event }: { readonly event: CallbackEvent }) {
  const StatusIcon = event.status === 'complete' ? CheckCircle2 : event.status === 'error' ? XCircle : Activity;
  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-4 text-left shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-gray-800">{event.source ?? 'unknown source'}</p>
          <p className="mt-0.5 text-[12px] text-gray-400">{event.received_at ?? event.timestamp ?? 'no timestamp'}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusClasses(event.status)}`}>
          <StatusIcon className="h-3.5 w-3.5" />
          {event.status ?? 'received'}
        </span>
      </div>
      {event.job_id && <p className="mt-2 break-all font-mono text-[11px] text-gray-400">job_id: {event.job_id}</p>}
      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-gray-50 p-3 text-[12px] leading-relaxed text-gray-700">
        {prettyJson(event)}
      </pre>
    </article>
  );
}
