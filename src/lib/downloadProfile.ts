// ─── Downloadable, self-contained buyer-profile snapshot (owner: "make this page downloadable, whole page + data
// sources, expandable, offline") ───────────────────────────────────────────────────────────────────────────────
// Builds ONE standalone .html string: inline CSS (no Tailwind dep so it renders anywhere/offline), the parsed
// TrustSEAL summary, every data source as an expandable <details> of pretty raw JSON, health + timing, and the full
// enrichment JSON embedded in a <script type="application/json"> for completeness. The requirement-enrichment CTA is
// intentionally OMITTED — it needs the live app/proxy/auth and can't run from a file:// origin (owner-confirmed).
import { parseBuyerProfile, type Field } from './buyerProfileModel';
import { getLLMRaw } from './gemini';
import { getServerTrace } from './enrichment';

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const fv = (f: Field): string => (f && f.present && f.value != null ? esc(f.value) : '<i class="na">Not available</i>');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

export function buildProfileHtml(rich: unknown, glid: string, stampIso: string, extras?: { llmRaw?: Record<string, unknown>; serverTrace?: unknown }): string {
  const m = parseBuyerProfile(rich);
  const sources = obj(obj(rich).sources);
  const llmRaw = obj(extras?.llmRaw);
  const health = Array.isArray(obj(rich).__health) ? obj(rich).__health as Array<Record<string, unknown>> : [];
  const trace = extras?.serverTrace;
  const timing = Array.isArray(obj(rich).pipeline_timing) ? obj(rich).pipeline_timing as Array<Record<string, unknown>> : [];
  const totalS = obj(rich).total_pull_s;

  const kv = (label: string, f: Field) => `<div class="row"><span class="k">${esc(label)}</span><span class="v">${fv(f)}${f.inferred ? '<span class="badge inf">inferred</span>' : f.provenance === 'derived' ? '<span class="badge der">derived</span>' : f.provenance === 'triangulated' ? '<span class="tick">✓✓</span>' : ''}</span></div>`;

  const tiles = m.header.tiles.map((t) => `<div class="tile"><div class="tnum">${t.value == null ? '&mdash;' : t.value}</div><div class="tlbl">${esc(t.label)}</div></div>`).join('');

  const overview = [...m.overview, ...m.procurement, ...m.market].map((o) => kv(o.label, o.field)).join('');

  const companyRows = [
    kv('GST', m.company.gst), kv('GST status', m.company.gstStatus), kv('Trade / Company name', m.company.tradeName),
    kv('Constitution', m.company.constitution), kv('Registration date', m.company.regDate), kv('Principal address', m.company.principalAddress),
  ].join('');

  const identity = m.company.identity;
  const identityBlock = identity ? `<div class="sub ${identity.conflict ? 'warn' : ''}"><div class="subh">Identity Signals${identity.conflict ? ' ⚠ same mobile, two names — shown, not auto-resolved' : ''}</div>${identity.registered ? `<div>Registered contact: <b>${esc(identity.registered.name)}</b> <span class="dim">(${esc(identity.registered.source)})</span></div>` : ''}${identity.bankLinked ? `<div>Phone-linked bank identity: <b>${esc(identity.bankLinked.name)}</b> <span class="dim">(${esc(identity.bankLinked.source)}${identity.bankLinked.confidence ? `, conf ${identity.bankLinked.confidence}` : ''})</span></div>` : ''}</div>` : '';

  const pans = m.company.pans;
  const panBlock = pans && (pans.primary || pans.alternates.length) ? `<div class="sub"><div class="subh">PAN</div>${pans.primary ? `<div><code>${esc(pans.primary.value)}</code> ${(pans.primary.agreementCount ?? 0) >= 2 ? `<span class="tick">✓✓ ${pans.primary.agreementCount} vendors</span>` : '<span class="badge der">single source</span>'}</div>` : ''}${pans.alternates.map((a) => `<div class="dim">also observed: <code>${esc(a.value)}</code> (${esc(a.source)})</div>`).join('')}${pans.note ? `<div class="dim">${esc(pans.note)}</div>` : ''}</div>` : '';

  const mobiles = m.company.mobiles.length ? `<div class="sub"><div class="subh">Linked mobiles</div>${m.company.mobiles.map((x) => `<code>${esc(x.value)}</code> ${x.agreementCount >= 2 ? `<span class="tick">✓✓ ${esc(x.foundBy.join('+'))}</span>` : `<span class="dim">single · ${esc(x.foundBy.join('+') || '?')}</span>`}`).join(' &nbsp; ')}</div>` : '';

  const social = [kv('Website', m.social.website), kv('Facebook', m.social.facebook), kv('Instagram', m.social.instagram), kv('LinkedIn', m.social.linkedin), kv('Twitter/X', m.social.twitter)].join('');
  const products = m.products.length ? `<ul class="prod">${m.products.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '<i class="na">Not available</i>';

  const timingRows = timing.map((t) => `<tr><td>${esc(t.node)}</td><td>${t.status && t.status !== 'ok' ? `<span class="dim">${esc(t.status)}</span>` : 'ok'}</td><td class="num">${esc(t.done_at_s)}s</td></tr>`).join('');

  // every data source → an expandable raw-JSON block (the "data sources, expandable" the owner wants offline)
  const srcOrder = Object.keys(sources);
  const sourceBlocks = srcOrder.map((k) => {
    const node = obj(sources[k]);
    const h = obj('__health' in node ? node.__health : obj(node.summary).__health);
    const ok = h.ok !== false; const st = esc(h.status || '');
    return `<details class="src"><summary><span class="dot ${ok ? 'g' : 'r'}"></span><b>${esc(k)}</b>${st && st !== 'success' ? `<span class="badge ${st === 'error' ? 'inf' : 'der'}">${st}</span>` : ''}</summary><pre>${esc(JSON.stringify(node, null, 2))}</pre></details>`;
  }).join('');

  // LLM prompts/outputs (verbatim — "the LLM code, input, output"), each expandable
  const llmBlocks = Object.keys(llmRaw).map((label) => { const o = obj(llmRaw[label]); return `<details class="src"><summary><b>🧠 LLM · ${esc(label)}</b> <span class="dim">${esc(o.model)}${o.promptVersion ? ' · ' + esc(o.promptVersion) : ''}</span></summary><div style="padding:8px 10px"><div class="subh">system prompt</div><pre>${esc(o.system || o.input)}</pre><div class="subh">user (evidence bundle)</div><pre>${esc(o.user)}</pre><div class="subh">output (verbatim)</div><pre>${esc(o.output)}</pre></div></details>`; }).join('');
  const healthBlock = health.length ? `<table><tr><td><b>node</b></td><td><b>ok</b></td><td><b>status</b></td><td><b>count</b></td></tr>${health.map((h) => `<tr><td>${esc(h.node)}</td><td>${h.ok === false ? '✗' : '✓'}</td><td>${esc(h.status || '')}</td><td class="num">${esc(h.count ?? '')}</td></tr>`).join('')}</table>` : '';
  const traceBlock = trace ? `<details class="src"><summary><b>n8n server trace</b></summary><pre>${esc(JSON.stringify(trace, null, 2))}</pre></details>` : '';
  const bizStory = m.businessStory ? `<div class="story"><div class="subh">Business Story <span class="badge der">composed</span></div><p>${esc(m.businessStory.text)}</p></div>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrustSEAL Buyer Profile — ${esc(m.header.company.value || glid)} (GLID ${esc(glid)})</title>
<style>
  :root{--navy:#0b1f4d;--gold:#f5b301;--ink:#1f2937;--dim:#6b7280;--line:#e5e7eb;--sky:#0284c7;--emer:#059669;--amber:#b45309;}
  *{box-sizing:border-box} body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);margin:0;background:#f8fafc;padding:16px}
  .wrap{max-width:1100px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .hdr{background:linear-gradient(90deg,#0b1f4d,#132c63);color:#fff;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .hdr .s{width:24px;height:24px;border-radius:50%;background:var(--gold);color:var(--navy);font-weight:800;display:flex;align-items:center;justify-content:center}
  .hdr .title{font-weight:700} .hdr .title .g{color:var(--gold)}
  .tiles{margin-left:auto;display:flex;gap:0}
  .tile{padding:0 16px;text-align:center;border-left:1px solid rgba(255,255,255,.15)} .tile:first-child{border-left:0}
  .tnum{font-size:20px;font-weight:700} .tlbl{font-size:10px;color:rgba(255,255,255,.7)}
  .name{padding:12px 16px;border-bottom:1px solid var(--line)} .name h2{margin:0;font-size:22px} .name .meta{color:var(--dim);margin-top:4px}
  .name .glid{color:var(--sky);font-weight:600}
  .cols{display:grid;grid-template-columns:30% 40% 30%;gap:20px;padding:16px}
  @media(max-width:820px){.cols{grid-template-columns:1fr}.tiles{margin-left:0}}
  .col h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink);border-bottom:2px solid var(--line);padding-bottom:6px;margin:0 0 8px}
  .sech{font-size:11px;font-weight:700;text-transform:uppercase;color:var(--sky);margin:12px 0 4px}
  .row{display:flex;gap:8px;padding:3px 0} .row .k{width:44%;font-weight:600;color:#374151} .row .v{flex:1;word-break:break-word}
  .na{color:#cbd5e1;font-style:italic} code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
  .badge{font-size:9px;padding:1px 5px;border-radius:4px;margin-left:4px;vertical-align:middle;border:1px solid}
  .badge.inf{background:#f0f9ff;color:var(--sky);border-color:#bae6fd} .badge.der{background:#f3f4f6;color:var(--dim);border-color:#e5e7eb}
  .tick{color:var(--emer);font-weight:700;margin-left:4px}
  .sub{margin-top:8px;border:1px solid var(--line);border-radius:8px;padding:8px} .sub.warn{border-color:#fcd34d;background:#fffbeb}
  .subh{font-size:10px;font-weight:700;text-transform:uppercase;color:#4b5563;margin-bottom:3px} .dim{color:var(--dim);font-size:11px}
  .story{background:#eff6ff;border:1px solid #dbeafe;border-radius:8px;padding:8px;margin-bottom:8px} .story p{margin:2px 0 0}
  .prod{margin:0;padding-left:16px;columns:2} .prod li{font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:11px} td{padding:2px 4px;border-bottom:1px solid #f1f5f9} .num{text-align:right;font-variant-numeric:tabular-nums}
  .sources{padding:0 16px 16px} .sources h3{font-size:12px;text-transform:uppercase;color:var(--ink);border-bottom:2px solid var(--line);padding-bottom:6px}
  details.src{border:1px solid var(--line);border-radius:8px;margin:6px 0;background:#fafafa} details.src>summary{cursor:pointer;padding:6px 10px;list-style:none;font-size:12px;display:flex;align-items:center;gap:6px}
  details.src pre{margin:0;padding:8px 10px;background:#0b1020;color:#c7d2fe;font-size:11px;overflow:auto;max-height:420px;border-top:1px solid var(--line)}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block} .dot.g{background:var(--emer)} .dot.r{background:#e11d48}
  .bar{padding:8px 16px;background:#f8fafc;border-top:1px solid var(--line)}
  .bar button{font:inherit;cursor:pointer;background:#fff;border:1px solid var(--line);border-radius:6px;padding:4px 10px;margin-right:6px}
  .foot{padding:8px 16px;color:var(--dim);font-size:10px;border-top:1px solid var(--line)}
</style></head><body><div class="wrap">
  <div class="hdr"><span class="s">S</span><span class="title">TrustSEAL <span class="g">Buyer Profile</span></span><div class="tiles">${tiles}</div></div>
  <div class="name"><h2>${esc(m.header.company.value || 'Company not available')}</h2><div class="meta">👤 ${fv(m.header.contactName)} &nbsp;|&nbsp; 📅 Member Since: <b>${m.header.tenureYears != null ? esc(m.header.tenureYears) + ' Years' : (m.header.memberSince.present ? esc(m.header.memberSince.value) : '—')}</b> &nbsp;|&nbsp; GLID: <span class="glid">${esc(glid)}</span></div></div>
  <div class="cols">
    <div class="col"><h3>Buyer Details</h3>${bizStory}<div class="sech">Business Overview / Procurement / Market</div>${overview}</div>
    <div class="col"><h3>Company Details</h3>${companyRows}${panBlock}${identityBlock}${mobiles}${timingRows ? `<div class="sech">Pipeline timing (total ${esc(totalS ?? '?')}s)</div><table>${timingRows}</table>` : ''}</div>
    <div class="col"><h3>Social Media Presence</h3>${social}<div class="sech">Products of Interest</div>${products}</div>
  </div>
  <div class="bar"><button onclick="document.querySelectorAll('details.src').forEach(d=>d.open=true)">Expand all sources</button><button onclick="document.querySelectorAll('details.src').forEach(d=>d.open=false)">Collapse all</button></div>
  <div class="sources"><h3>Data Sources — raw (expandable)</h3>${sourceBlocks}</div>
  ${llmBlocks ? `<div class="sources"><h3>LLM prompts &amp; outputs (verbatim)</h3>${llmBlocks}</div>` : ''}
  ${healthBlock ? `<div class="sources"><h3>Node health</h3>${healthBlock}</div>` : ''}
  ${traceBlock ? `<div class="sources"><h3>Server trace</h3>${traceBlock}</div>` : ''}
  <div class="foot">Snapshot generated ${esc(stampIso)} · offline copy · <span class="badge inf">inferred</span>=web/LLM · <span class="tick">✓✓</span>=≥2 sources agree · requirement-enrichment CTA omitted (needs the live app). Full pull JSON embedded below.</div>
  <script type="application/json" id="enrichment-data">${JSON.stringify(rich).replace(/</g, '\\u003c')}</script>
</div></body></html>`;
}

// trigger a browser download of the self-contained snapshot
export function downloadProfileHtml(rich: unknown, glid: string): void {
  const stampIso = new Date().toISOString();
  // gather the whole debug picture at click-time: the LLM prompts/outputs + the n8n server trace (health + timing
  // already ride on `rich`). This makes the offline file the WHOLE view, not just the card.
  let extras: { llmRaw?: Record<string, unknown>; serverTrace?: unknown } = {};
  try { extras = { llmRaw: getLLMRaw() as Record<string, unknown>, serverTrace: getServerTrace() }; } catch { /* noop */ }
  const html = buildProfileHtml(rich, glid, stampIso, extras);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `buyer-profile-${glid || 'snapshot'}-${stampIso.slice(0, 10)}.html`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ─── FULLY-INTERACTIVE offline download (P4) ──────────────────────────────────────────────────────────────────
// Fetches the pre-built single-file app shell (public/offline-shell.html, made by `npm run build:offline`), injects
// this GLID's snapshot as window.__EMBEDDED_PULL in the <head> (so it's set BEFORE the app's module boots), and
// downloads it. Opening that file offline boots the SAME app from the baked-in data → every band/JSON-tree/expander/
// scroll works exactly like live (no network, no LLM). If the shell isn't built yet, falls back to the static digest.
function triggerDownload(html: string, name: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export async function downloadInteractiveHtml(snapshot: { glid?: string; stampIso?: string }, opts?: { fallbackRich?: unknown }): Promise<void> {
  const glid = snapshot.glid || 'snapshot';
  const stampIso = snapshot.stampIso || new Date().toISOString();
  const day = stampIso.slice(0, 10);
  // safe embed: escape </script> and any < so the JSON can't break out of the <script> tag
  const inject = `\n<script>window.__EMBEDDED_PULL = ${JSON.stringify(snapshot).replace(/</g, '\\u003c')};</script>\n`;
  try {
    const res = await fetch(`/offline-shell.html?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('offline-shell.html ' + res.status);
    let shell = await res.text();
    if (!/id="root"/.test(shell) || !/<script/i.test(shell)) throw new Error('offline-shell.html is not a built app bundle');
    // Inject a REGULAR (non-deferred) script right after <head> so window.__EMBEDDED_PULL is set DURING parse — before
    // the app's deferred module bundle executes. (Injecting at </head> would land AFTER the module script → too late.)
    shell = /<head[^>]*>/i.test(shell) ? shell.replace(/<head[^>]*>/i, (m) => m + inject) : (inject + shell);
    triggerDownload(shell, `buyer-${glid}-${day}.html`);
    return;
  } catch (e) {
    // shell not generated yet → static digest so the button still yields a file, + a clear how-to.
    try {
      const extras = { llmRaw: getLLMRaw() as Record<string, unknown>, serverTrace: getServerTrace() };
      triggerDownload(buildProfileHtml(opts?.fallbackRich, glid, stampIso, extras), `buyer-profile-${glid}-${day}.html`);
    } catch { /* noop */ }
    try { console.warn('[downloadInteractiveHtml] /offline-shell.html unavailable — run `npm run build:offline` to enable the fully-interactive download. Downloaded the static digest instead.', e); } catch { /* noop */ }
    try { window.alert('Downloaded the static digest.\n\nFor the FULLY-INTERACTIVE offline copy (all bands & expanders, exactly like live), run `npm run build:offline` once to generate the app shell, then click Download again.'); } catch { /* noop */ }
  }
}
