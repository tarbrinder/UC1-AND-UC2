import http from 'node:http';

const PORT = Number.parseInt(process.env.CALLBACK_PORT ?? '3457', 10);
const clients = new Set();
const history = [];

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function publish(event) {
  history.unshift(event);
  history.splice(300);
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(frame);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
    });
    clients.add(res);
    for (const event of [...history].reverse()) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    req.on('close', () => {
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    // last_event_at makes a silently-dead tunnel obvious at a glance: if it is hours old while n8n
    // is executing, callbacks are NOT arriving (stale trycloudflare URL) — the exact failure the
    // pages' preflight guards against.
    sendJson(res, 200, { ok: true, clients: clients.size, received: history.length, last_event_at: history[0]?.received_at ?? null });
    return;
  }

  if (req.method === 'GET' && req.url === '/history') {
    sendJson(res, 200, { events: history });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 404, { error: 'POST callbacks to /, GET /events for the live stream.' });
    return;
  }

  try {
    const rawBody = await readBody(req);
    const parsed = rawBody ? JSON.parse(rawBody) : {};
    const event = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      received_at: new Date().toISOString(),
      ...parsed,
    };
    publish(event);
    console.log(`[${event.status ?? 'received'}] ${event.source ?? 'unknown'} ${event.job_id ?? ''}`);
    sendJson(res, 200, { ok: true });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(`callback parse failed: ${message}`);
    sendJson(res, 400, { ok: false, error: message });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Callback receiver port ${PORT} is already in use. Reuse the running receiver or set CALLBACK_PORT to another port.`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`Callback receiver on http://localhost:${PORT}`);
  console.log(`SSE stream on http://localhost:${PORT}/events`);
});
