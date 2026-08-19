// Persona360 — LIVE page (sync webhook flow).
// Renders the Buyer Persona 360 UI driven by the n8n `buyer-intelligence` workflow —
// a SYNCHRONOUS webhook: GET /api/imworkflow/webhook/buyer-intelligence?glid=…&tier=…
// returns ONE final JSON (the 08 — Intelligence Parser output) when the pipeline finishes.
// No callback receiver, no tunnel, no SSE, no job_id polling — one pull, one response.
// The response is mapped to Persona360Data via mapFinalToPersona360 (src/lib/persona360Live.ts)
// and rendered by Persona360Page in mode='live'.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Send, Zap } from 'lucide-react';
import Persona360Page from './Persona360Page';
import { deriveColumnStates, mapFinalToPersona360 } from '../../lib/persona360Live';
import { PERSONA360_FIXTURE } from '../../fixtures/persona360Fixture';

// The Buyer-intelligence workflow holds ONE blocking HTTP socket for the whole run
// (sources can take minutes); the Vite proxy allows up to 600s — abort at 11 min like
// the buyer-ledger pull so a dropped socket surfaces as an error instead of a forever spinner.
const PULL_TIMEOUT_MS = 11 * 60 * 1000;
const SYNC_WEBHOOK_PATH = '/api/imworkflow/webhook/buyer-intelligence';
const TIERS = ['superfast', 'fast', 'normal'] as const;
type Tier = (typeof TIERS)[number];

interface LiveView {
  payload: unknown; // 08-parser / final-assemble body
  glid: string;
}

export default function Persona360LivePage() {
  const [glid, setGlid] = useState(() => readGlidParam() || '');
  const [tier, setTier] = useState<Tier>('fast');
  const [fresh, setFresh] = useState(false); // nocache=1 → force a full re-pull
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState<LiveView | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    setElapsed(0);
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
  }, [stopTimer]);

  const pull = useCallback(async (targetGlid: string, targetTier: Tier, forceFresh: boolean) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase('loading');
    setError('');
    setLive(null);
    startTimer();
    try {
      const qs = new URLSearchParams({ glid: targetGlid, tier: targetTier });
      if (forceFresh) qs.set('nocache', '1');
      const res = await fetch(`${SYNC_WEBHOOK_PATH}?${qs.toString()}`, {
        // controller (superseding re-pulls) + hard 11-min cap for a dropped socket
        signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(PULL_TIMEOUT_MS)]),
      });
      if (!res.ok) {
        // The gateway in front of n8n caps the long-held webhook socket (~160s) while the
        // pipeline keeps running server-side and writes its 24h result cache. A 502/504
        // therefore means: re-pull in a bit — the cached result returns near-instantly.
        if (res.status === 502 || res.status === 504) {
          throw new Error(
            `n8n gateway timed out (${res.status}) while the pipeline was still running. The run continues on n8n's side and caches its result — wait a few seconds and pull again (the re-pull will be fast).`,
          );
        }
        throw new Error(`n8n returned ${res.status} ${res.statusText}`);
      }
      const body: unknown = await res.json();
      setLive({ payload: body, glid: targetGlid });
      setPhase('done');
    } catch (err) {
      if (ctrl.signal.aborted) return; // superseded by a newer pull — stay in that pull's phase
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      stopTimer();
    }
  }, [startTimer, stopTimer]);

  // unmount cleanup
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopTimer();
    };
  }, [stopTimer]);

  // auto-pull on mount when ?persona360=1&glid=<value> is present (launcher dock flow)
  const didAutoPull = useRef(false);
  useEffect(() => {
    if (didAutoPull.current) return;
    const qg = readGlidParam();
    if (qg) {
      didAutoPull.current = true;
      const t = setTimeout(() => void pull(qg, 'fast', false), 50);
      return () => clearTimeout(t);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const trigger = () => {
    const g = glid.trim();
    if (!g) return;
    void pull(g, tier, fresh);
  };

  const data = live ? mapFinalToPersona360(live.payload) : PERSONA360_FIXTURE;
  const columnStates = live ? deriveColumnStates(live.payload) : undefined;
  const isLive = phase === 'done' && !!live;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* CONTROL BAR */}
      <div className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 shadow-sm backdrop-blur-sm">
        <div className="mx-auto max-w-[1400px] px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-teal-600" />
              <span className="text-sm font-bold text-gray-800">Buyer Persona 360</span>
            </div>

            <input
              value={glid}
              onChange={(e) => setGlid(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') trigger(); }}
              className="w-32 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm outline-none focus:border-teal-400"
              placeholder="GLID"
              aria-label="GLID"
            />

            <div className="flex overflow-hidden rounded-lg border border-gray-200 text-[11px]">
              {TIERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTier(t)}
                  className={`px-2.5 py-1.5 capitalize transition ${tier === t ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  {t}
                </button>
              ))}
            </div>

            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-gray-600" title="Skip the 24h n8n result cache and force a full re-pull of every source">
              <input
                type="checkbox"
                checked={fresh}
                onChange={(e) => setFresh(e.target.checked)}
                className="h-3.5 w-3.5 accent-teal-600"
              />
              Force fresh
            </label>

            <button
              type="button"
              onClick={trigger}
              disabled={!glid.trim() || phase === 'loading'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {phase === 'loading' ? 'Pulling…' : 'Pull Live'}
            </button>

            {phase === 'done' && isLive && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                <CheckCircle2 className="h-3 w-3" /> live render
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
            <span>
              n8n <b className="font-mono">buyer-intelligence</b> · synchronous webhook · one response
            </span>
            {phase === 'loading' && (
              <span className="inline-flex items-center gap-1 text-teal-700">
                <Loader2 className="h-3 w-3 animate-spin" /> pipeline running… {elapsed}s
              </span>
            )}
            {isLive && (
              <button
                type="button"
                onClick={trigger}
                className="inline-flex items-center gap-1 text-teal-700 underline hover:text-teal-800"
              >
                <RefreshCw className="h-3 w-3" /> re-pull
              </button>
            )}
          </div>

          {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] px-4 py-4">
        {!isLive && phase === 'idle' && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
            Preview — showing the static fixture. Enter a GLID and press “Pull Live” to trigger the
            buyer-intelligence workflow and render its response. The source shown below (Jayveer Singh, 268590579) is the mockup fixture, not live data.
          </div>
        )}
        {phase === 'error' && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
            The pull failed. The n8n gateway caps the long-held webhook socket (~160s), but the pipeline
            keeps running on n8n's side and caches its result for 24h — wait a few seconds and re-pull;
            the re-pull returns the cached result near-instantly. Use Force fresh only to bypass a stale cache.
          </div>
        )}
        <Persona360Page data={data} mode={isLive ? 'live' : 'fixture'} onRetry={isLive ? trigger : undefined} columnStates={columnStates} />
      </div>
    </div>
  );
}

function readGlidParam(): string {
  try {
    return new URLSearchParams(window.location.search).get('glid') || '';
  } catch {
    return '';
  }
}
