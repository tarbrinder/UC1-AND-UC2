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
// Inline as a CLASSIC <script> (NOT type=module): the offline build (--mode offline) emits an IIFE chunk with no
// import/export, and Chrome BLOCKS module-script execution from file:// — a classic script is what makes the
// downloaded single-file HTML actually boot when double-clicked. COLLECT here; PLACED AT END OF <body> below —
// classic scripts run synchronously at their position, so the bundle must run AFTER <div id="root"> is parsed
// (else createRoot(#root) throws React #299 → blank page — the exact bug modules dodged via deferral).
const _appScripts = [];
html = html.replace(/<script\b([^>]*?)\ssrc="([^"]+)"([^>]*)><\/script>/gi, (m, pre, src, post) => {
  // NB: the placeholder must NOT contain the literal "</body>" — the app-tags injection below does an
  // `html.replace(/<\/body>/i, …)` and would otherwise match THIS comment's </body> first, burying the
  // whole bundle inside an HTML comment (silent blank page, no error). Keep it </body>-free.
  try { _appScripts.push(escClose(readDist(src), 'script')); inlinedJs++; return '<!-- app bundle inlined before end of body -->'; }
  catch { console.error('  ✗ missing JS asset', src); missing++; return m; }
});
// inline stylesheets
html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/gi, (m, href) => {
  try { inlinedCss++; return `<style>\n${escClose(readDist(href), 'style')}\n</style>`; }
  catch { console.error('  ✗ missing CSS asset', href); missing++; return m; }
});
// modulepreload hints are useless once inlined — drop them so nothing tries to fetch /assets/* offline
html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/gi, '');
// strip crossorigin (meaningless + can trip file:// loading)
html = html.replace(/\scrossorigin(=("|')[^"']*\2)?/gi, '');
// place the inlined app bundle(s) as an INLINE ES-module JUST BEFORE </body>: (a) module scripts defer, and body-end
// placement guarantees #root is parsed before createRoot runs (fixes the React #299 blank); (b) a fully-inlined module
// has NO fetch, so it executes when the file is double-clicked from file:// (unlike a module with a src/imports).
const _appTags = _appScripts.map((c) => `<script type="module">\n${c}\n</script>`).join('\n');
// Function replacement (NOT a string) so `$`-sequences in the minified bundle (React uses `$` as var names heavily —
// e.g. an accidental `$&`/`$\`` in the code) are inserted verbatim instead of being interpreted as replace() patterns.
if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, () => _appTags + '\n</body>');
else html += _appTags;

if (missing || inlinedJs === 0) { console.error(`✗ shell build failed — inlinedJs=${inlinedJs} inlinedCss=${inlinedCss} missing=${missing}`); process.exit(1); }
if (/src="\/assets\/|href="\/assets\//.test(html)) { console.error('✗ shell still references /assets/* — not fully self-contained'); process.exit(1); }
if (/<script[^>]*\ssrc=/i.test(html)) { console.error('✗ shell still has an external <script src> — would fail on file://'); process.exit(1); }

for (const dir of ['public', 'dist']) { try { writeFileSync(join(root, dir, 'offline-shell.html'), html); } catch (e) { if (dir === 'public') throw e; } }
console.log(`✓ offline-shell.html — ${(html.length / 1024).toFixed(0)} KB · inlined ${inlinedJs} script + ${inlinedCss} style · → public/ + dist/`);
