// FULL per-page decision trace (2026-08-10). For a real buyer (leaves in /tmp/leaf_*.json), runs LLM 1/2/3 in DEBUG
// and the deterministic code layers (dropAnswered, applyBudget), and prints — per page — every candidate question,
// who decided it (LLM prompt vs CODE), which won/lost, and why. Run: PRODUCT="Laddu Packaging Tray" node scripts/debug-trace.mjs
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const DEV = 'http://localhost:5173';
const RFQ_DIR = new URL('../src/lib/rfq/', import.meta.url);
const asDataUrl = (c) => `data:text/javascript;base64,${Buffer.from(c, 'utf8').toString('base64')}`;
const REL = /(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+)\2/; const IMP = /^\s*(?:import|export)\b/;
const named = (src, spec) => { const m = src.match(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*['"]${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]`)); return m ? m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '')).filter(Boolean) : []; };
function load(file, stubs = {}) { const url = new URL(file, RFQ_DIR); const src = readFileSync(url, 'utf8'); const e = process.emitWarning; process.emitWarning = () => {}; const st = stripTypeScriptTypes(src, { mode: 'strip' }); process.emitWarning = e; const code = st.split('\n').map((l) => (IMP.test(l) ? l.replace(REL, (_m, kw, q, sp) => { const s = stubs[sp]; const t = s ? asDataUrl(s(named(src, sp))) : new URL(sp.endsWith('.ts') ? sp : `${sp}.ts`, url).href; return `${kw}${q}${t}${q}`; }) : l)).join('\n'); return import(asDataUrl(code)); }
globalThis.__RAW = [];
const gem = (n) => n.map((x) => (x === 'callLLM' ? `export const callLLM=async(m,o={})=>{const b={model:o.model||'google/gemini-3.5-flash-lite',messages:m,...(o.jsonMode?{response_format:{type:'json_object'}}:{}),temperature:o.temperature??0,...(o.maxTokens?{max_tokens:o.maxTokens}:{}),...(o.reasoningEffort?{reasoning_effort:o.reasoningEffort,allowed_openai_params:['reasoning_effort']}:{})};const r=await fetch(${JSON.stringify(DEV + '/api/llm/chat/completions')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});if(!r.ok)throw new Error('LLM '+r.status);const j=await r.json();const c=j?.choices?.[0]?.message?.content??'';globalThis.__RAW.push({label:o.label,c});return c;}` : `export const ${x}=()=>{};`)).join('\n');

const { runRequirementBrain, runCommercialPlanner, runPersonaPlanner, applyBudget } = await load('llm.ts', { '../gemini': gem });
const { dropAnswered } = await load('plannerController.ts');
const L = (n) => { try { const d = JSON.parse(readFileSync(`/tmp/leaf_${n}.json`, 'utf8')); return Array.isArray(d) ? d[0] : d; } catch { return null; } };
const csl = L('csl'), rfq = L('rfq'), profile = L('profile'), wa = L('wa'), pns = L('pns'), cat = L('cat');
const product = process.env.PRODUCT || 'Laddu Packaging Tray';
const rawFor = (label) => { const r = [...globalThis.__RAW].reverse().find((x) => x.label === label); if (!r) return {}; try { return JSON.parse(r.c); } catch { return {}; } };
const Q = (qs) => (qs || []).map((q) => `    [${q.ui}] «${q.label || q.field}»${q.value ? ` = ${q.value}` : ''}${q.options?.length ? `  {${q.options.slice(0, 5).join(' · ')}}` : ''} (order ${q.order})`).join('\n');
const considered = (meta) => (meta?.considered || []).map((c) => `    ${c.surfaced ? `WON #${c.rank ?? '?'}` : 'dropped'.padEnd(6)} «${c.candidate}»  — ${c.why_ranked || ''}${c.surfaced ? '' : `  [${c.dropped_because || ''}]`}${c.basis ? `  · basis: ${c.basis}` : ''}`).join('\n');
const optionReasoning = (meta) => Object.entries(meta?.reasoning || {}).map(([f, r]) => { const opts = r.options ? Object.entries(r.options).map(([o, why]) => `        ${o} — ${why}`).join('\n') : '        (no per-option reasoning)'; return `    «${f}» (conf ${r.confidence ?? '?'}) — ${r.why || ''}\n${opts}`; }).join('\n');
const bar = (t) => `\n${'━'.repeat(78)}\n${t}\n${'━'.repeat(78)}`;

// ── PAGE 1 · LLM 1 ────────────────────────────────────────────────────────────
console.log(bar(`PAGE 1 · Specifications · decided by LLM 1 (Requirement Brain) + CODE routing`));
const b = await runRequirementBrain({ product, quantity: '500', csl, rfq, profile, whatsapp: wa, pns, buyerSpecs: [], sellerSpecs: (cat?.top_specs || []).map((s) => ({ q: s.q || s.question, pct: s.pct || s.asked_pct, vals: s.vals })) }, 'debug', 'high');
const bmeta = rawFor('requirement-brain')?.page1?.metadata || {};
console.log(`\nLLM 1 understanding: ${b?.brain?.understanding}`);
console.log(`LLM 1 persona_read : ${b?.brain?.persona_read}`);
console.log(`category_trustworthy: ${b?.brain?.category_trustworthy}`);
console.log(`\nLLM 1 → page-1 questions it EMITTED:\n${Q(b?.page1?.questions)}`);
console.log(`\nLLM 1 competition ledger (what it weighed · what won · why):\n${considered(bmeta) || '    (none emitted)'}`);
console.log(`\nknown_truths (facts LLM 1 lifted from the buyer's truth → CODE routes these to prefills / "Also detected"):\n    ${(b?.known_truths || []).map((k) => `${k.key}=${k.value} (${k.source})`).join('\n    ') || '(none)'}`);
console.log(`\nCODE decision (BrainRFQForm consumption loop): each LLM-1 question whose CONCEPT matches a buyer ISQ spec → prefills that chip; else → a generated "aiSpec"; a chip-less ask is dropped; a known_truth matching a spec-concept is deduped, else shown as "Also detected".`);

// ── PAGE 2 · LLM 2 ────────────────────────────────────────────────────────────
console.log(bar(`PAGE 2 · Commercial · decided by LLM 2 + CODE (dropAnswered · applyBudget)`));
const brain = b?.brain || { understanding: '', persona_read: '', category_trustworthy: true, evidence: [] };
const filled = Object.fromEntries((b?.known_truths || []).map((k) => [k.key, k.value]));
const session = { product, quantity: '500', page1: filled, page2: {}, page3: {} };
const page1Shown = [...(b?.page1?.questions || []).flatMap((q) => [q.field, q.label]), ...Object.keys(filled)];
const cxRaw = await runCommercialPlanner({ brain, session, categoryEngine: cat, pns, profile }, 'debug', 'high');
const cxMeta = rawFor('commercial-planner')?.metadata || {};
console.log(`\nINPUTS to LLM 2: real brain · category corpus (${(cat?.top_specs || []).length} specs, personas=${!!cat?.personas}, b2b_b2c=${JSON.stringify(cat?.b2b_b2c)}) · pns · profile`);
console.log(`\nLLM 2 → questions it EMITTED (raw, before code):\n${Q(cxRaw?.questions)}`);
console.log(`\nLLM 2 competition ledger (every candidate incl. category gems · won/dropped · why):\n${considered(cxMeta) || '    (none emitted)'}`);
console.log(`\nLLM 2 per-OPTION reasoning (why each chip / why prefilled):\n${optionReasoning(cxMeta) || '    (none)'}`);
const cxDropped = dropAnswered(cxRaw, session, page1Shown);
const removedCx = (cxRaw?.questions || []).filter((q) => !(cxDropped.questions || []).some((k) => k.field === q.field && k.label === q.label));
console.log(`\nCODE · dropAnswered (concept-dedup vs page-1): REMOVED ${removedCx.length ? removedCx.map((q) => `«${q.label}»`).join(', ') : '(none)'}`);
const cxFinal = applyBudget(cxDropped);
const removedBudget = (cxDropped.questions || []).filter((q) => !(cxFinal.questions || []).some((k) => k === q));
console.log(`CODE · applyBudget (cap asks at 5): CUT ${removedBudget.length ? removedBudget.map((q) => `«${q.label}»`).join(', ') : '(none)'}`);
console.log(`\n➡ FINAL PAGE 2 (renders):\n${Q(cxFinal?.questions)}`);

// ── PAGE 3 · LLM 3 ────────────────────────────────────────────────────────────
console.log(bar(`PAGE 3 · About You · decided by LLM 3 + persona_gate + CODE`));
const psRaw = await runPersonaPlanner({ brain, session, profile, personaGate: null }, 'debug', 'high');
const psMeta = rawFor('persona-planner')?.metadata || {};
console.log(`\nINPUTS to LLM 3: real brain · profile · persona_gate (null here — live it is the assessBulkB2B verdict)`);
console.log(`\nLLM 3 → questions it EMITTED (raw):\n${Q(psRaw?.questions)}`);
console.log(`\nLLM 3 competition ledger:\n${considered(psMeta) || '    (none emitted)'}`);
console.log(`\nLLM 3 per-OPTION reasoning:\n${optionReasoning(psMeta) || '    (none)'}`);
const psShown = [...page1Shown, ...(cxFinal?.questions || []).flatMap((q) => [q.field, q.label])];
const psDropped = dropAnswered(psRaw, session, psShown);
const removedPs = (psRaw?.questions || []).filter((q) => !(psDropped.questions || []).some((k) => k.field === q.field && k.label === q.label));
console.log(`\nCODE · dropAnswered (vs page-1 + page-2): REMOVED ${removedPs.length ? removedPs.map((q) => `«${q.label}»`).join(', ') : '(none)'}`);
const psFinal = applyBudget(psDropped);
console.log(`\n➡ FINAL PAGE 3 (renders):\n${Q(psFinal?.questions)}`);
console.log('\n[done]');
