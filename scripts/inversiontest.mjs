// Phase 5b acceptance test (ChatGPT's "biggest recommendation before 5b"):
// MEASURE that a high-confidence buyer gets FEWER questions, that a cold buyer is
// led with intent/scale before specs, and that an off-profile product trips the
// circuit-breaker (no fast-track). Same category, three Twin states.
// Mirrors the twin-aware planRequirement prompt. Run: node scripts/inversiontest.mjs
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^VITE_LLM_KEY=(.*)$/m) || [])[1]?.trim();
const ENDPOINT = 'https://imllm.intermesh.net/v1/chat/completions';

function twinBlock(tw) {
  if (!tw) return '';
  if (tw.offProfile)
    return `\nTWIN CIRCUIT-BREAKER: this buyer HAS a history, but the CURRENT product is OFF-PROFILE (unrelated to what they usually buy). DO NOT assume their usual intent/scale/persona. Treat INTENT and SCALE as UNKNOWN and LEAD WITH AN INTENT question. Leave "twinResolved" empty.\n`;
  if (tw.confidence >= 60 && tw.known)
    return `\nTWIN FAST-TRACK (confidence ${tw.confidence}/100). ALREADY KNOWN — you MUST NOT ask about ANY of these again: ${tw.known}.\nEmit AT MOST ONE short CONFIRM question first (kind:"persona", tier:"intent", order:0) — options like ["Yes, same as usual","No — this order is different"]. Put EVERY skipped topic in "twinResolved". GOAL: fewest questions for a known buyer.\n`;
  if (tw.confidence > 0 && tw.confidence < 50)
    return `\nCOLD BUYER (confidence ${tw.confidence}/100). LEAD WITH INTENT then SCALE as chip questions BEFORE specs.\n`;
  return '';
}

async function plan(product, isq, tw) {
  const prompt = `CONTEXT — INDIA B2B ONLY (₹, lakh/crore).
You are planning an IndiaMART RFQ so a SELLER can quote without a discovery call.
NORTH STAR — ASK THE FEWEST QUESTIONS THAT STILL LET A SELLER QUOTE. A KNOWN buyer must get FEWER questions than a new one — never re-ask what we already know.
Product: "${product}"
ISQ spec fields (reference only): ${JSON.stringify(isq)}
${twinBlock(tw)}
Produce 3-6 non-spec qualifying questions. Each: {label, options(3-5 chips), kind:"context"|"persona", tier:"intent"|"scale"|"constraint"|"spec"}.
TAG tier: intent (what/why for) | scale (how big/volume/cadence) | constraint (compliance/install/sample) | spec (rare).
Never ask quantity / delivery / timeline / payment / GST / brand (dedicated fields). Chips only.
Return ONLY JSON: { "questions": [ {"label":"","options":["",""],"kind":"context","tier":"intent"} ], "twinResolved": [] }`;
  const r = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'google/gemini-2.5-flash-lite', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 1200 }) });
  const j = JSON.parse((await r.json()).choices[0].message.content);
  const TIER = { intent: 0, scale: 1, constraint: 2, spec: 3 };
  // Mirror planRequirement's parse: drop kind:'spec', tier-sort, and the code cap
  // (fast-track → 3, else 6) that makes a known buyer structurally get fewer cards.
  const cap = tw && !tw.offProfile && tw.confidence >= 60 && tw.known ? 3 : 6;
  const questions = (j.questions || [])
    .filter((q) => q && q.label && Array.isArray(q.options) && q.options.length >= 2 && q.kind !== 'spec')
    .sort((a, b) => (TIER[a.tier] ?? 2) - (TIER[b.tier] ?? 2))
    .slice(0, cap);
  return { questions, twinResolved: j.twinResolved || [], tiers: questions.map((q) => q.tier).join('→') };
}

const PRODUCT = 'Corrugated Boxes';
const ISQ = { 'Box Type': ['3 Ply', '5 Ply', '7 Ply'], 'Size': [], 'Printing': ['Yes', 'No'], 'Material': ['Kraft', 'Recycled'] };

const COLD = null;
const WARM = { known: 'business type: Manufacturer · usually buying for: product packaging · scale: High volume · builds inventory (recurring)', confidence: 87, unknowns: [], offProfile: false };
const OFF = { known: 'business type: Manufacturer · usually buying for: industrial pumps and valves', confidence: 87, unknowns: [], offProfile: true };

const cold = await plan(PRODUCT, ISQ, COLD);
const warm = await plan(PRODUCT, ISQ, WARM);
const off = await plan(PRODUCT, ISQ, OFF);

const firstTier = (r) => r.questions[0]?.tier;
console.log(`\n════ FUNNEL INVERSION — "${PRODUCT}" ════`);
console.log(`  COLD  q=${cold.questions.length}  tiers=${cold.tiers}`);
console.log(`  WARM  q=${warm.questions.length}  tiers=${warm.tiers}  skipped=${warm.twinResolved.length} [${warm.twinResolved.join(', ')}]`);
console.log(`  OFF   q=${off.questions.length}  tiers=${off.tiers}  skipped=${off.twinResolved.length}`);
console.log(`  ── known buyer got ${cold.questions.length - warm.questions.length} FEWER card(s) than cold ──\n`);
const checks = [
  ['COLD leads with intent/scale (discover from scratch)', ['intent', 'scale'].includes(firstTier(cold))],
  ['WARM ≤ COLD cards (the North Star — known ⇒ fewer)', warm.questions.length <= cold.questions.length],
  ['WARM capped ≤ 3 cards (code guarantee, no backfill)', warm.questions.length <= 3],
  ['WARM fast-track engaged (twinResolved non-empty)', warm.twinResolved.length > 0],
  ['OFF-PROFILE circuit-breaker held (no fast-track skip)', off.twinResolved.length === 0],
  ['OFF-PROFILE leads with intent (forced discovery)', firstTier(off) === 'intent'],
];
let pass = 0;
for (const [label, ok] of checks) { if (ok) pass++; console.log(`  ${ok ? '✓' : '✗'} ${label}`); }
console.log(`\n════ INVERSION: ${pass}/${checks.length} checks passed ════`);
if (pass !== checks.length) process.exitCode = 1;
