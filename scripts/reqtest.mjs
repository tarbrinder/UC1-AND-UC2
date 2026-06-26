// Deterministic test for Requirement Stitching (Wave 2C) + Buyer Journey Graph (Wave 2D).
// Proves: BL ⨝ ISQ by title → one requirement (specs + buyer notes), Probable Order Value / Requirement
// Type excluded (business-deduced), unmatched ISQ still a requirement; and the requirement SEQUENCE →
// role tags → an operating arc + maturity. NO LLM.

const nrm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const IGNORE = /probable order value|probable requirement type/i;
const NOTE_KEY = /buyer filled details|i am interested in/i;
function makeReq(title, facts) {
  const specs = [], buyerNotes = [];
  for (const f of facts.filter((x) => x.tag === 'isq.answer')) { const eq = f.rawValue.indexOf('='); if (eq < 0) continue; const k = f.rawValue.slice(0, eq).trim(); const v = f.rawValue.slice(eq + 1).trim(); if (!k || !v) continue; if (IGNORE.test(k)) continue; if (NOTE_KEY.test(k)) { buyerNotes.push(v); continue; } specs.push({ k, v }); }
  return { title, specs, buyerNotes, hasBL: facts.some((f) => f.tag === 'bl.title'), hasISQ: facts.some((f) => f.sourceNode === 'prev-isq'), facts };
}
function buildRequirements(L) {
  const blTitles = L.facts.filter((f) => f.tag === 'bl.title'); const isqFacts = L.facts.filter((f) => f.sourceNode === 'prev-isq');
  const groups = new Map(); for (const f of isqFacts) { const r = f.lineRef || 'ISQ ?'; if (!groups.has(r)) groups.set(r, []); groups.get(r).push(f); }
  const isqByTitle = new Map(); for (const fs of groups.values()) { const t = fs.find((f) => f.tag === 'isq.title')?.rawValue; if (t) isqByTitle.set(nrm(t), fs); }
  const reqs = [], used = new Set();
  for (const bl of blTitles) { const key = nrm(bl.rawValue); const isq = isqByTitle.get(key); if (isq) used.add(key); reqs.push(makeReq(bl.rawValue, [bl, ...(isq || [])])); }
  for (const [key, fs] of isqByTitle) { if (used.has(key)) continue; const t = fs.find((f) => f.tag === 'isq.title')?.rawValue || 'requirement'; reqs.push(makeReq(t, fs)); }
  return reqs;
}
const ROLE_RULES = [[/machine|making/i, 'Machinery'], [/raw material|\bpaper\b|\bmaterial\b|gsm/i, 'Raw material'], [/tipper|chhota hathi|\btempo\b|\btata\b|\bace\b|truck|transport/i, 'Transport'], [/generator|diesel|power|backup/i, 'Power backup'], [/manhole|\bfrp\b|cover|cement|construction/i, 'Construction']];
const roleOf = (t) => { for (const [re, r] of ROLE_RULES) if (re.test(t)) return r; return 'Other'; };
function buildJourney(reqs) {
  const steps = reqs.map((r) => ({ title: r.title, role: roleOf(r.title) })); const roles = [...new Set(steps.map((s) => s.role))]; const has = (r) => roles.includes(r);
  let arc = 'Procurement activity'; if (has('Machinery') && has('Raw material')) arc = 'Setting up + operating a manufacturing unit'; else if (has('Machinery')) arc = 'Acquiring production machinery'; else if (has('Raw material')) arc = 'Procuring production inputs';
  const extras = [has('Transport') ? 'logistics' : '', has('Power backup') ? 'power backup' : '', has('Construction') ? 'facility build-out' : ''].filter(Boolean); if (extras.length) arc += ' + ' + extras.join(' + ');
  const breadth = roles.filter((r) => r !== 'Other').length; const maturity = breadth >= 3 ? 'Expansion phase' : (has('Machinery') && has('Raw material')) ? 'Growing manufacturer' : breadth >= 1 ? 'Emerging manufacturer' : 'Early enquiry';
  return { steps, roles, arc, maturity };
}

const F = (sourceNode, tag, rawValue, lineRef) => ({ sourceNode, tag, rawValue, lineRef });
const L = { facts: [
  F('prev-bl', 'bl.title', '1300Pcs/Hr Notebook Making Machine', 'BL 1'),
  F('prev-bl', 'bl.title', 'Exercise Notebook Raw Material', 'BL 2'),
  F('prev-bl', 'bl.title', 'Tata Chhota Hathi', 'BL 3'),
  F('prev-isq', 'isq.title', '1300Pcs/Hr Notebook Making Machine', 'ISQ 1'),
  F('prev-isq', 'isq.answer', 'Automation Grade=Semi-Automatic', 'ISQ 1'),
  F('prev-isq', 'isq.answer', 'Cutting Machine Size=32 inch', 'ISQ 1'),
  F('prev-isq', 'isq.answer', 'Buyer Filled Details=Send kro', 'ISQ 1'),
  F('prev-isq', 'isq.answer', 'Probable Order Value=Rs. 70 - 74 Lakh', 'ISQ 1'),
  F('prev-isq', 'isq.answer', 'Probable Requirement Type=Business Use', 'ISQ 1'),
  F('prev-isq', 'isq.title', 'Exercise Notebook Raw Material', 'ISQ 2'),
  F('prev-isq', 'isq.answer', 'GSM=100 GSM', 'ISQ 2'),
  F('prev-isq', 'isq.answer', 'Quantity=100000', 'ISQ 2'),
  F('prev-isq', 'isq.title', 'Standalone ISQ Only', 'ISQ 3'),   // no BL → still a requirement
  F('prev-isq', 'isq.answer', 'Color=White', 'ISQ 3'),
] };

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const reqs = buildRequirements(L);
const machine = reqs.find((r) => /Notebook Making Machine/.test(r.title));
const journey = buildJourney(reqs);

ok('one requirement per BL + the unmatched ISQ (4 total)', reqs.length === 4);
ok('machine requirement stitched BL + ISQ', machine.hasBL && machine.hasISQ);
ok('specs carried (Automation Grade, Cutting Machine Size)', machine.specs.some((s) => s.k === 'Automation Grade' && s.v === 'Semi-Automatic') && machine.specs.some((s) => s.k === 'Cutting Machine Size'));
ok('Probable Order Value + Requirement Type EXCLUDED (business-deduced)', machine.specs.every((s) => !/probable/i.test(s.k)));
ok('Buyer Filled Details → buyer notes (not a spec)', machine.buyerNotes.includes('Send kro') && machine.specs.every((s) => s.k !== 'Buyer Filled Details'));
ok('unmatched ISQ ("Standalone") still a requirement', reqs.some((r) => /Standalone/.test(r.title) && r.hasISQ && !r.hasBL));
ok('journey tags roles (Machinery + Raw material + Transport)', journey.roles.includes('Machinery') && journey.roles.includes('Raw material') && journey.roles.includes('Transport'));
ok('journey arc = manufacturing unit + logistics', /manufacturing unit/.test(journey.arc) && /logistics/.test(journey.arc));
ok('maturity inferred (Expansion phase · 3+ roles)', journey.maturity === 'Expansion phase');
// Business Story — Requirements + Journey + persona headline → one executive line
const story = (() => { const headline = 'Industrial notebook manufacturer'; const line = reqs.length ? `${headline} — ${journey.arc}. ${reqs.length} requirements on record → ${journey.maturity}.` : `${headline} — awaiting requirement history.`; return { headline, timeline: journey.steps, arc: journey.arc, line, requirements: reqs.length }; })();
ok('business story = one executive line (headline + arc + req count + maturity)', /Industrial notebook manufacturer/.test(story.line) && /manufacturing unit/.test(story.line) && /Expansion phase/.test(story.line) && story.timeline.length === reqs.length);

console.log(`\nreqtest (Wave 2C requirement stitching · BL⨝ISQ by title · business-deduced excluded + 2D buyer journey · role tags · arc · maturity): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
