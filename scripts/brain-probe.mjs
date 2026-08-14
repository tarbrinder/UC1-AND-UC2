// Real-brain probe (2026-08-10): runs the REAL runRequirementBrain over a real buyer's LIVE truth (pre-fetched leaf
// JSON in /tmp/leaf_*.json), then the real planners — to see whether LLM-1 produces a RICH understanding and whether
// the planners then get intelligent. Replicates the live brain inputs without the slow monolith. Run: node scripts/brain-probe.mjs
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const DEV = 'http://localhost:5173';
const RFQ_DIR = new URL('../src/lib/rfq/', import.meta.url);
const asDataUrl = (c) => `data:text/javascript;base64,${Buffer.from(c, 'utf8').toString('base64')}`;
const RELATIVE_SPEC = /(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+)\2/;
const IS_IMPORT = /^\s*(?:import|export)\b/;
const namedImports = (src, spec) => { const m = src.match(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*['"]${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]`)); return m ? m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '')).filter(Boolean) : []; };
function loadRfqModule(file, stubs = {}) {
  const url = new URL(file, RFQ_DIR); const src = readFileSync(url, 'utf8');
  const emit = process.emitWarning; process.emitWarning = () => {}; const stripped = stripTypeScriptTypes(src, { mode: 'strip' }); process.emitWarning = emit;
  const code = stripped.split('\n').map((line) => (IS_IMPORT.test(line) ? line.replace(RELATIVE_SPEC, (_m, kw, q, spec) => { const st = stubs[spec]; const t = st ? asDataUrl(st(namedImports(src, spec))) : new URL(spec.endsWith('.ts') ? spec : `${spec}.ts`, url).href; return `${kw}${q}${t}${q}`; }) : line)).join('\n');
  return import(asDataUrl(code));
}
const geminiReal = (named) => named.map((n) => (n === 'callLLM'
  ? `export const callLLM = async (messages, opts = {}) => { const body = { model: opts.model || 'google/gemini-3.5-flash-lite', messages, ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}), temperature: opts.temperature ?? 0, ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}), ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort, allowed_openai_params: ['reasoning_effort'] } : {}) }; const r = await fetch(${JSON.stringify(DEV + '/api/llm/chat/completions')}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error('LLM ' + r.status); const j = await r.json(); return j?.choices?.[0]?.message?.content ?? ''; }`
  : `export const ${n} = (...a) => {};`)).join('\n');

const { runRequirementBrain, runCommercialPlanner, runPersonaPlanner } = await loadRfqModule('llm.ts', { '../gemini': geminiReal });
const L = (n) => { try { const d = JSON.parse(readFileSync(`/tmp/leaf_${n}.json`, 'utf8')); return Array.isArray(d) ? d[0] : d; } catch { return null; } };
const csl = L('csl'), rfq = L('rfq'), profile = L('profile'), wa = L('wa'), pns = L('pns'), cat = L('cat');
const sellerSpecs = (cat?.top_specs || []).map((s) => ({ q: s.question || s.q || s.spec || s.name, pct: s.asked_pct || s.pct, vals: s.top_values || s.vals })).filter((x) => x.q);
const product = process.env.PRODUCT || 'Laddu Packaging Tray';
const brainInput = { product, quantity: '500', csl, rfq, profile, whatsapp: wa, pns, buyerSpecs: [], sellerSpecs };

console.log(`\n### LLM-1 Requirement Brain — real truth for the buyer, product "${product}"`);
const res = await runRequirementBrain(brainInput, 'debug', 'high').catch((e) => ({ __err: String(e) }));
if (res?.__err) { console.log('BRAIN ERR:', res.__err); process.exit(1); }
console.log('understanding :', res?.brain?.understanding || '(EMPTY)');
console.log('persona_read  :', res?.brain?.persona_read || '(EMPTY)');
console.log('cat_trustworthy:', res?.brain?.category_trustworthy);
console.log('known_truths  :', (res?.known_truths || []).map((k) => `${k.key}=${k.value}`).join(' · ') || '(none)');
console.log('page1 Qs      :', (res?.page1?.questions || []).map((q) => `${q.ui}«${q.label}»`).join('  ') || '(none)');

const brain = res?.brain || { understanding: '', persona_read: '', category_trustworthy: true, evidence: [] };
const session = { product, quantity: '500', page1: {}, page2: {}, page3: {} };
const cx = await runCommercialPlanner({ brain, session, categoryEngine: cat, pns, profile }, 'prod', 'high').catch((e) => ({ __err: String(e) }));
const ps = await runPersonaPlanner({ brain, session, profile, personaGate: null }, 'prod', 'high').catch((e) => ({ __err: String(e) }));
console.log('\n### with THAT real brain:');
console.log('PAGE 2:', cx?.__err ? 'ERR ' + cx.__err : (cx?.questions || []).map((q) => `${q.ui}«${q.label}»`).join('  '));
console.log('PAGE 3:', ps?.__err ? 'ERR ' + ps.__err : (ps?.questions || []).map((q) => `${q.ui}«${q.label}»`).join('  '));
console.log('[done]');
