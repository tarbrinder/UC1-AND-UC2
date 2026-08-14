// Validates the fix: does the MONOLITH's metadata.category (what the seed now carries into catCorpus) make LLM 2
// intelligent, vs the DISTILLED feed the form used to pass? Runs runCommercialPlanner both ways on the same buyer.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const DEV = 'http://localhost:5173';
const RFQ_DIR = new URL('../src/lib/rfq/', import.meta.url);
const asDataUrl = (c) => `data:text/javascript;base64,${Buffer.from(c, 'utf8').toString('base64')}`;
const REL = /(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+)\2/; const IMP = /^\s*(?:import|export)\b/;
const named = (src, spec) => { const m = src.match(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*['"]${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]`)); return m ? m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '')).filter(Boolean) : []; };
function load(file, stubs = {}) { const url = new URL(file, RFQ_DIR); const src = readFileSync(url, 'utf8'); const e = process.emitWarning; process.emitWarning = () => {}; const st = stripTypeScriptTypes(src, { mode: 'strip' }); process.emitWarning = e; const code = st.split('\n').map((l) => (IMP.test(l) ? l.replace(REL, (_m, kw, q, sp) => { const s = stubs[sp]; const t = s ? asDataUrl(s(named(src, sp))) : new URL(sp.endsWith('.ts') ? sp : `${sp}.ts`, url).href; return `${kw}${q}${t}${q}`; }) : l)).join('\n'); return import(asDataUrl(code)); }
const gem = (n) => n.map((x) => (x === 'callLLM' ? `export const callLLM=async(m,o={})=>{const b={model:o.model||'google/gemini-3.5-flash-lite',messages:m,...(o.jsonMode?{response_format:{type:'json_object'}}:{}),temperature:o.temperature??0,...(o.maxTokens?{max_tokens:o.maxTokens}:{}),...(o.reasoningEffort?{reasoning_effort:o.reasoningEffort,allowed_openai_params:['reasoning_effort']}:{})};const r=await fetch(${JSON.stringify(DEV + '/api/llm/chat/completions')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});if(!r.ok)throw new Error('LLM '+r.status);const j=await r.json();return j?.choices?.[0]?.message?.content??'';}` : `export const ${x}=()=>{};`)).join('\n');

const { runCommercialPlanner } = await load('llm.ts', { '../gemini': gem });
const d0 = JSON.parse(readFileSync('/tmp/rb.json', 'utf8')); const d = Array.isArray(d0) ? d0[0] : d0;
const mcat = d.metadata.category;                       // what the seed NOW carries into catCorpus (full object)
const distilled = mcat.top_specs || [];                // what the form USED to pass (catTopSpecs — the array only, personas/keywords/b2b_b2c stripped)
const product = d.metadata.primary?.product || 'the product';
const brain = { understanding: `Buyer is purchasing ${product}.`, persona_read: '', category_trustworthy: true, evidence: [] };
const session = { product, quantity: '2', page1: {}, page2: {}, page3: {} };
const line = (cx) => (cx?.questions || []).map((q) => `${q.ui}«${q.label}»`).join('  ');
console.log(`product: ${product} · corpus has personas=${!!mcat.personas} keywords=${!!mcat.keywords} b2b_b2c=${!!mcat.b2b_b2c}`);
console.log('\nOLD (distilled feed — personas/keywords/b2b_b2c stripped):');
console.log('  PAGE 2:', line(await runCommercialPlanner({ brain, session, categoryEngine: distilled, pns: null, profile: null }, 'prod', 'high')));
console.log('\nNEW (full monolith m.category — the fix):');
console.log('  PAGE 2:', line(await runCommercialPlanner({ brain, session, categoryEngine: mcat, pns: null, profile: null }, 'prod', 'high')));
console.log('[done]');
