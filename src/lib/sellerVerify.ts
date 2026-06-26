// ─── SELLER / ENTITY WEB-VERIFY (crawler / OSINT) — FRONTEND-ONLY async job ───────────────────────────────
// On-demand web-scrape enrichment for a GLID. Fire → poll. Lives in the FRONTEND (NOT n8n) by design: it's a
// slow async job (seconds–minutes) and must never stall the synchronous bi-user-insights pull (the V10 lock).
// Uses the existing IndiaMART LLM key (sent as X-Gemini-Key, browser-side — debug mode). Calls go through the
// /api/sellerverify Vite proxy (CORS-safe). The `result` shape is captured on first live call; we return it raw
// so the UI can render whatever the scraper provides. Surfaced in a dedicated block BELOW UC2 (owner decision).

import { api } from './api';

const KEY = (import.meta.env.VITE_LLM_KEY as string) || '';
export const hasCrawlerKey = (): boolean => Boolean(KEY.trim());

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
  if (!KEY.trim()) return null;
  const res = await fetch(api('/api/sellerverify/api/v2/seller/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gemini-Key': KEY },
    body: JSON.stringify({ glid }),
  });
  if (!res.ok) throw new Error(`seller-verify init ${res.status}`);
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
  if (!KEY.trim()) return { status: 'no-key' };
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
