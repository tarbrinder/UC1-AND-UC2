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

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** GET JSON with a hard failure on non-2xx so callers can show real errors. */
export async function getJSON<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api(path), init);
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/** POST JSON with a hard failure on non-2xx. */
export async function postJSON<T = unknown>(path: string, body: unknown): Promise<T> {
  return getJSON<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
