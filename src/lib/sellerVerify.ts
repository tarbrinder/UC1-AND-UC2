// ─── SELLER / ENTITY WEB-VERIFY (crawler / OSINT) — FRONTEND-ONLY async job ───────────────────────────────
// On-demand web-scrape enrichment for a GLID. Fire → poll. Lives in the FRONTEND (NOT n8n) by design: it's a
// slow async job (seconds–minutes) and must never stall the synchronous bi-user-insights pull (the V10 lock).
// Uses the IndiaMART LLM/Gemini key as X-Gemini-Key — but injected SERVER-SIDE by the /api/sellerverify proxy
// (vite.config, from env.LLM_GATEWAY_KEY), NEVER in the browser bundle. The `result` shape is captured on first
// live call; we return it raw so the UI can render whatever the scraper provides. Surfaced BELOW UC2 (owner).

import { api } from './api';

// Public flag (not a secret) — gates whether the OSINT UI is offered; the real key is proxy-injected.
const CRAWLER_ENABLED = ((import.meta.env.VITE_LLM_ENABLED as string) || '').trim() === '1';
export const hasCrawlerKey = (): boolean => CRAWLER_ENABLED;

export interface SellerVerifyState {
  status: 'idle' | 'running' | 'done' | 'failed' | 'no-key';
  jobId?: string;
  result?: unknown;        // raw scraper payload (shape captured on first live call)
  error?: string;
  ms?: number;
  polls?: number;
}

// Fire the scrape job → returns the job id (or null on a shapeless response).
export async function startSellerVerify(glid: string): Promise<string | null> {
  if (!CRAWLER_ENABLED) return null;
  let res: Response;
  try {
    // Fail fast (25s) instead of hanging ~75s on a 502. The verify call should return a job_id quickly.
    res = await fetch(api('/api/sellerverify/api/v2/seller/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // X-Gemini-Key injected server-side by the /api/sellerverify proxy
      body: JSON.stringify({ glid }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const t = e instanceof Error && e.name === 'TimeoutError';
    throw new Error(`seller-verify init ${t ? 'timed out' : 'failed'} — scraper host (34.93.111.50) unreachable from this network (VPN/firewall?)`);
  }
  if (!res.ok) {
    const hint = (res.status === 502 || res.status === 504) ? ' — host unreachable from this network (VPN/firewall?)' : res.status === 401 || res.status === 403 ? ' — X-Gemini-Key rejected (wrong key type?)' : '';
    throw new Error(`seller-verify init ${res.status}${hint}`);
  }
  const j = (await res.json().catch(() => ({}))) as { job_id?: string; jobId?: string; id?: string };
  return j.job_id || j.jobId || j.id || null;
}

// Poll one job-status tick. Tolerant to status spellings (completed/done/success · failed/error).
export async function pollSellerVerifyStatus(jobId: string): Promise<{ done: boolean; failed: boolean; result?: unknown; progress?: unknown }> {
  const res = await fetch(api(`/api/sellerverify/api/v2/seller/status/${encodeURIComponent(jobId)}`));
  if (!res.ok) throw new Error(`seller-verify status ${res.status}`);
  const j = (await res.json().catch(() => ({}))) as { status?: string; result?: unknown; progress?: unknown };
  const s = String(j.status || '').toLowerCase();
  return {
    done: s === 'completed' || s === 'done' || s === 'success' || s === 'finished',
    failed: s === 'failed' || s === 'error',
    result: j.result,
    progress: j.progress,
  };
}

// Fire + poll until done / failed / timeout. A scrape can take a while → maxMs default 120s, pollMs 2.5s.
export async function runSellerVerify(
  glid: string,
  opts?: { maxMs?: number; pollMs?: number; onTick?: (poll: number, progress?: unknown) => void },
): Promise<SellerVerifyState> {
  if (!CRAWLER_ENABLED) return { status: 'no-key' };
  const t0 = Date.now();
  const maxMs = opts?.maxMs ?? 120000;
  const pollMs = opts?.pollMs ?? 2500;
  try {
    const jobId = await startSellerVerify(glid);
    if (!jobId) return { status: 'failed', error: 'no job id returned', ms: Date.now() - t0 };
    let n = 0;
    while (Date.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      const st = await pollSellerVerifyStatus(jobId).catch(() => ({ done: false, failed: false } as { done: boolean; failed: boolean; result?: unknown; progress?: unknown }));
      opts?.onTick?.(++n, st.progress);
      if (st.failed) return { status: 'failed', jobId, ms: Date.now() - t0, polls: n };
      if (st.done) return { status: 'done', jobId, result: st.result, ms: Date.now() - t0, polls: n };
    }
    return { status: 'failed', jobId, error: 'timeout', ms: Date.now() - t0, polls: n };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  }
}
