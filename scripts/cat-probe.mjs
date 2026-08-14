// Category-corpus → page-2/page-3 fidelity probe (2026-08-10).
// Loads the REAL runCommercialPlanner / runPersonaPlanner from src/lib/rfq/llm.ts (via the same type-stripping loader
// the test suite uses), but swaps ../gemini for a callLLM that POSTs through the running dev proxy (localhost:5173,
// which injects the LLM key). For N categories it fetches the live category corpus and prints the questions each
// planner actually produces — so we can see whether the corpus's powerful NON-SPEC insights (land-area / white-labeling
// / certification / warranty) surface on page 2, and what (if anything) reaches page 3.
// Run: node scripts/cat-probe.mjs         (dev server must be up on :5173)
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const DEV = 'http://localhost:5173';
const RFQ_DIR = new URL('../src/lib/rfq/', import.meta.url);
const asDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;
const RELATIVE_SPEC = /(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+)\2/;
const IS_IMPORT_LINE = /^\s*(?:import|export)\b/;
function namedImports(src, spec) {
  const esc = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const m = src.match(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*['"]${esc}['"]`));
  return m ? m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '')).filter(Boolean) : [];
}
function loadRfqModule(file, stubs = {}) {
  const url = new URL(file, RFQ_DIR);
  const src = readFileSync(url, 'utf8');
  const emit = process.emitWarning; process.emitWarning = () => {};
  const stripped = stripTypeScriptTypes(src, { mode: 'strip' }); process.emitWarning = emit;
  const code = stripped.split('\n').map((line) => (IS_IMPORT_LINE.test(line)
    ? line.replace(RELATIVE_SPEC, (_m, kw, q, spec) => {
      const stub = stubs[spec];
      const target = stub ? asDataUrl(stub(namedImports(src, spec))) : new URL(spec.endsWith('.ts') ? spec : `${spec}.ts`, url).href;
      return `${kw}${q}${target}${q}`;
    }) : line)).join('\n');
  return import(asDataUrl(code));
}
// Real transport through the dev proxy.
const geminiReal = (named) => named.map((n) => (n === 'callLLM'
  ? `export const callLLM = async (messages, opts = {}) => {
       const body = { model: opts.model || 'google/gemini-3.5-flash-lite', messages,
         ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
         temperature: opts.temperature ?? 0, ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
         ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort, allowed_openai_params: ['reasoning_effort'] } : {}) };
       const r = await fetch(${JSON.stringify(DEV + '/api/llm/chat/completions')}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
       if (!r.ok) throw new Error('LLM ' + r.status + ' ' + (await r.text()).slice(0,120));
       const j = await r.json(); return j?.choices?.[0]?.message?.content ?? ''; }`
  : `export const ${n} = (...a) => {};`)).join('\n');

const { runCommercialPlanner, runPersonaPlanner } = await loadRfqModule('llm.ts', { '../gemini': geminiReal });

async function resolveMcat(name) {
  try {
    const r = await fetch(`${DEV}/api/imimg/models/mcatid-suggestion.php?search_param=${encodeURIComponent(name)}&modid=MY`);
    const j = await r.json();
    // mcatid-suggestion returns a FLAT object {mcatid, catid, type}, not an array.
    return j?.mcatid || j?.mcat_id || (Array.isArray(j) ? (j[0]?.mcatid || j[0]?.mcat_id) : (j?.suggestions?.[0]?.mcatid || j?.data?.[0]?.mcatid)) || null;
  } catch { return null; }
}
async function corpusFor(mcat) {
  const r = await fetch(`${DEV}/api/imworkflow/webhook/bi-category-brain?mcat_id=${mcat}`);
  const j = await r.json(); return Array.isArray(j) ? j[0] : j;
}
const topSpecNames = (c) => (c?.top_specs || c?.summary?.top_specs || []).map((s) => s.question || s.spec || s.name).filter(Boolean);

const CATS = process.argv.slice(2).length
  ? process.argv.slice(2).map((s) => { const [name, mcat] = s.split(':'); return { name, mcat }; })
  : [
    { name: 'Wall Clock', mcat: '951' }, { name: 'Cement', mcat: '119126' },
    { name: 'TMT Bar' }, { name: 'Diesel Generator' }, { name: 'Ladies Kurti' },
    { name: 'Packaging Box' }, { name: 'Water Storage Tank' }, { name: 'LED Bulb' },
    { name: 'Safety Shoes' }, { name: 'Hydraulic Pump' },
  ];

for (const c of CATS) {
  try {
    const mcat = c.mcat || await resolveMcat(c.name);
    if (!mcat) { console.log(`\n### ${c.name} — could not resolve mcat, skipped`); continue; }
    const corpus = await corpusFor(mcat);
    const specs = topSpecNames(corpus);
    const brain = { understanding: process.env.BRAIN || `A buyer is purchasing ${c.name}.`, persona_read: process.env.PERSONA || '', category_trustworthy: true, evidence: [] };
    const session = { product: c.name, quantity: '100', page1: {}, page2: {}, page3: {} };
    const cx = await runCommercialPlanner({ brain, session, categoryEngine: corpus, pns: null, profile: null }, 'prod', 'high').catch((e) => ({ __err: String(e).slice(0, 100) }));
    const ps = await runPersonaPlanner({ brain, session, profile: null }, 'prod', 'high').catch((e) => ({ __err: String(e).slice(0, 100) }));
    console.log(`\n### ${c.name} (mcat ${mcat}) — corpus top_specs: ${specs.length}`);
    console.log('   corpus non-spec-ish:', specs.filter((s) => /location|land|approval|white ?label|govern|warranty|certif|customi|origin|brand|packag|installation/i.test(s)).slice(0, 12).join(' · ') || '(none matched)');
    console.log('   PAGE 2 (commercial):', cx?.__err ? `ERR ${cx.__err}` : (cx?.questions || []).map((q) => `${q.ui}«${q.label}»`).join('  ') || '(empty)');
    console.log('   PAGE 3 (persona):   ', ps?.__err ? `ERR ${ps.__err}` : (ps?.questions || []).map((q) => `${q.ui}«${q.label}»`).join('  ') || '(empty)');
  } catch (e) { console.log(`\n### ${c.name} — FAILED: ${String(e).slice(0, 160)}`); }
}
console.log('\n[done]');
