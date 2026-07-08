// ─── Central API config ──────────────────────────────────────────────────────
// All IndiaMART calls use relative `/api/*` paths. In local dev the Vite proxy
// (see vite.config.ts) forwards them to the right upstreams. When the form is
// embedded in the IndiaMART shell — or deployed behind a gateway on a different
// origin — set VITE_API_BASE to that origin and every call follows. One switch.
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(
  /\/$/,
  ''
);

/** Prefix a relative `/api/*` path with the configured base. */
export const api = (path: string): string => `${API_BASE}${path}`;

// ─── n8n webhook (single source of truth) ─────────────────────────────────────
// One dedicated, collision-proof hook for the live v10.2 workflow (imported from
// ~/Downloads/bi-user-insights-v10x.json — uncapped ISQ + offer_id join + requirement_brain,
// 2026-06-25). EVERY n8n reference (buyer pull · requirement_brain · category modes) hits
// this one path; change it in this one place to re-point them all.
export const N8N_HOOK = 'bi-user-insights-v10x';
// Dedicated hook for the STANDALONE buyer-unified endpoint (pure-backend replica —
// one server LLM fills UC1 + the card; fast/full modes). Consumed by
// enrichment.ts fetchBuyerUnified. Kept separate from N8N_HOOK so the dashboard
// (frontend-LLM) and the standalone (backend-LLM) never collide on one path.
export const BUYER_UNIFIED_HOOK = 'bi-buyer-unified';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** GET JSON with a hard failure on non-2xx so callers can show real errors.
 *  A default timeout (via AbortController) means a slow/hung IndiaMART API FAILS FAST instead of
 *  leaving the form stuck forever ("specs not coming") — callers already catch and degrade gracefully.
 *  The GLID webhook uses a raw fetch (enrichment.ts), so it is unaffected by this. */
export async function getJSON<T = unknown>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(api(path), { ...init, signal: init?.signal ?? ctrl.signal });
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** POST JSON with a hard failure on non-2xx. */
export async function postJSON<T = unknown>(path: string, body: unknown, timeoutMs = 15000): Promise<T> {
  return getJSON<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs);
}
