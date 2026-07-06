// build-offline-shell.mjs (P4) — turn the built dist/ into ONE self-contained HTML the running app can fetch + hand to
// the ⬇ Download button. Inlines the (single-chunk) JS bundle + CSS into dist/index.html and writes public/offline-shell.html
// (served at /offline-shell.html in dev + copied into future builds). Run AFTER `vite build` — the `build:offline` script does both.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const distHtml = join(root, 'dist', 'index.html');
if (!existsSync(distHtml)) { console.error('✗ dist/index.html not found — run `vite build` first (or use `npm run build:offline`).'); process.exit(1); }

const readDist = (ref) => readFileSync(join(root, 'dist', ref.replace(/^\//, '').split('?')[0]), 'utf8');
const escClose = (code, tag) => code.replace(new RegExp('</' + tag, 'gi'), '<\\/' + tag); // stop an inlined </script>/</style> from closing the tag early

let html = readFileSync(distHtml, 'utf8');
let inlinedJs = 0, inlinedCss = 0, missing = 0;

// inline module scripts (Vite prod = a single chunk → one <script type="module" src="/assets/index-*.js">)
html = html.replace(/<script\b([^>]*?)\ssrc="([^"]+)"([^>]*)><\/script>/gi, (m, pre, src, post) => {
  try { const type = /type="module"/.test(pre + post) ? ' type="module"' : ''; inlinedJs++; return `<script${type}>\n${escClose(readDist(src), 'script')}\n</script>`; }
  catch { console.error('  ✗ missing JS asset', src); missing++; return m; }
});
// inline stylesheets
html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/gi, (m, href) => {
  try { inlinedCss++; return `<style>\n${escClose(readDist(href), 'style')}\n</style>`; }
  catch { console.error('  ✗ missing CSS asset', href); missing++; return m; }
});
// modulepreload hints are useless once inlined — drop them so nothing tries to fetch /assets/* offline
html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/gi, '');

if (missing || inlinedJs === 0) { console.error(`✗ shell build failed — inlinedJs=${inlinedJs} inlinedCss=${inlinedCss} missing=${missing}`); process.exit(1); }
if (/src="\/assets\/|href="\/assets\//.test(html)) { console.error('✗ shell still references /assets/* — not fully self-contained'); process.exit(1); }

for (const dir of ['public', 'dist']) { try { writeFileSync(join(root, dir, 'offline-shell.html'), html); } catch (e) { if (dir === 'public') throw e; } }
console.log(`✓ offline-shell.html — ${(html.length / 1024).toFixed(0)} KB · inlined ${inlinedJs} script + ${inlinedCss} style · → public/ + dist/`);
