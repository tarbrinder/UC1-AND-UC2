# ASYNC streaming — local setup runbook

The two async pages fire the shared-n8n workflow `buyer-persona-async` and render the partial
callbacks it POSTs as each source completes:

- `?async=1` — QA page: raw callback event stream + copy-paste curl.
- `?async-profile=1` — async Buyer Profile: source chips + progressive ledger, same data path.

## Two commands, one order

```bash
npm run callback:receiver   # local receiver on http://localhost:3457 (SSE /events · /history · /health)
npm run callback:tunnel     # cloudflared quick tunnel → :3457, prints https://…trycloudflare.com
```

Start the receiver first, then the tunnel. The tunnel URL is baked in as the default in
`src/lib/asyncCallback.ts` (`DEFAULT_CALLBACK_URL`) — after a tunnel restart, update that constant
(the preflight will flag it if you forget). A verified URL is remembered in localStorage and takes
precedence, so clear the field or the browser storage when switching tunnels.

## Why the pull button "pings" first

Both pages run a preflight before firing n8n: they POST a nonce ping through the public tunnel and
require it to appear in the receiver's `/history` within ~6s. If it doesn't, the pull aborts with an
explicit error and **n8n is never fired**. Without this, a dead tunnel produces the silent failure
where n8n executes "fine", the receiver gets nothing, and the page sits at `0/10 sources` forever.

## Webhook method: GET

`buyer-persona-async` on the shared n8n is GET-registered (`POST` → 404 "not registered for POST
requests"). All parameters (`glid`, `tier`, `callback_url`) ride the query string:

```bash
curl "https://imworkflow.intermesh.net/webhook/buyer-persona-async?glid=268590579&tier=fast&callback_url=https://<tunnel>.trycloudflare.com"
# → {"job_id":"…","status":"processing"} — partials POST back as each source completes (~2.5 min for `fast`)
```

## Quick triage

| Symptom | Check |
| --- | --- |
| Pull aborts: "Callback URL is not reaching this machine" | Tunnel dead → `npm run callback:tunnel`, paste new URL |
| Page open but SSE badge grey | Receiver down → `npm run callback:receiver` |
| n8n executed but receiver empty | `curl localhost:3457/health` → `last_event_at` hours old? Stale tunnel (above) |
| Duplicate partials in the stream | Known n8n-side double-POST (retries); the pages dedupe — harmless |

Note: multiple `cloudflared.exe` processes each own a DIFFERENT quick-tunnel URL — check
`wmic process where "name='cloudflared.exe'" get CommandLine` and keep one tunnel per port.
