// ─── ASYNC streaming harness — shared callback-URL plumbing for both async pages ─────────────────────────────
// The n8n ASYNC workflow POSTs partials to a `callback_url` that must reach THIS machine. A laptop behind NAT
// needs a cloudflared quick tunnel → http://localhost:3457 (`npm run callback:tunnel`). Quick-tunnel URLs are
// EPHEMERAL: every cloudflared restart (or laptop sleep) mints a new one and the old URL silently dies — n8n then
// POSTs into the void and the UI sits at 0/10 forever (the exact "many changes but the screen never updates"
// failure: n8n executes, callbacks leave, nothing arrives). So the pages PING the callback_url through the public
// tunnel and require the ping to arrive at the LOCAL receiver BEFORE firing n8n — a dead tunnel becomes an
// actionable error instead of a silent hang. The last-used URL is kept in localStorage so a working setup
// survives reloads, and the preflight re-validates it on every pull.
export const LOCAL_RECEIVER_URL = 'http://localhost:3457';

// Default PUBLIC tunnel URL for the receiver. EPHEMERAL: dies on every cloudflared restart / laptop
// sleep — after `npm run callback:tunnel`, paste the new printed URL HERE (and clear the page's
// stored value or rely on the preflight error to notice). The preflight catches a stale value.
export const DEFAULT_CALLBACK_URL = 'https://hampton-increasing-colorado-come.trycloudflare.com';

const CALLBACK_URL_STORAGE_KEY = 'async-callback-url';

export function loadCallbackUrl(): string {
  try {
    return window.localStorage.getItem(CALLBACK_URL_STORAGE_KEY) ?? DEFAULT_CALLBACK_URL;
  } catch {
    return DEFAULT_CALLBACK_URL;
  }
}

export function saveCallbackUrl(url: string): void {
  try {
    window.localStorage.setItem(CALLBACK_URL_STORAGE_KEY, url);
  } catch {
    /* private mode / storage disabled — preflight still guards every pull */
  }
}

type ReceiverEvent = { readonly source?: string; readonly data?: unknown };

async function receiverHistory(): Promise<readonly ReceiverEvent[]> {
  try {
    const res = await fetch(`${LOCAL_RECEIVER_URL}/history`);
    if (!res.ok) return [];
    const body = (await res.json()) as { events?: unknown };
    if (!Array.isArray(body?.events)) return [];
    return body.events.filter((e): e is ReceiverEvent => !!e && typeof e === 'object');
  } catch {
    return [];
  }
}

// POST a nonce ping to `callbackUrl` and watch the local receiver for it. True only on a full
// public round trip: browser → cloudflare edge → tunnel → localhost:3457 → /history.
export async function preflightCallbackUrl(callbackUrl: string, timeoutMs = 6000): Promise<boolean> {
  const url = callbackUrl.trim();
  if (!/^https?:\/\//i.test(url)) return false;
  const nonce = `pf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + timeoutMs;
  try {
    // A fetch rejection (network/CORS) does NOT prove the ping never arrived — poll history anyway.
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ping', source: '_preflight', data: { nonce } }),
    });
  } catch {
    /* fall through to the history poll */
  }
  while (Date.now() < deadline) {
    const events = await receiverHistory();
    const hit = events.some((e) => {
      if (e.source !== '_preflight') return false;
      const d = e.data as { nonce?: unknown } | null | undefined;
      return !!d && typeof d === 'object' && d.nonce === nonce;
    });
    if (hit) return true;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return false;
}
