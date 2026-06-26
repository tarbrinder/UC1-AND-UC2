// Deterministic test for the BUYER STORY / product trajectory (P2.7) — mirrors src/lib/trajectory.ts.
// The system knew categories individually but never as a SEQUENCE. This orders them into a timeline,
// computes a coarse shape, and gates the (LLM) narrative on ≥2 distinct points. The arc is a SOFT
// planner signal, never a hard fact. NO LLM, NO network here (the narrative pass is tested separately).

function orderTrajectory(categories) {
  const byCat = new Map();
  for (const c of categories || []) {
    const mcat = (c?.mcat || '').trim();
    if (!mcat) continue;
    const key = mcat.toLowerCase();
    const rd = typeof c?.recencyDays === 'number' ? c.recencyDays : undefined;
    const prev = byCat.get(key);
    if (!prev) byCat.set(key, { mcat, recencyDays: rd });
    else if (typeof rd === 'number' && (prev.recencyDays == null || rd < prev.recencyDays)) prev.recencyDays = rd;
  }
  return [...byCat.values()].sort((a, b) => (b.recencyDays ?? -1) - (a.recencyDays ?? -1));
}
function trajectoryShape(categories) {
  const all = (categories || []).map((c) => (c?.mcat || '').trim().toLowerCase()).filter(Boolean);
  if (all.length === 0) return 'none';
  const distinct = new Set(all);
  if (distinct.size === 1) return all.length > 1 ? 'repeat' : 'single';
  return 'diversifying';
}
function hasStory(categories) {
  return new Set((categories || []).map((c) => (c?.mcat || '').trim().toLowerCase()).filter(Boolean)).size >= 2;
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the headline case: a factory-setup arc, oldest → newest ──
const setup = [
  { mcat: 'Paper', recencyDays: 20 },
  { mcat: 'Notebook Making Machine', recencyDays: 180 },
  { mcat: 'Notebook Raw Material', recencyDays: 90 },
];
const ordered = orderTrajectory(setup).map((s) => s.mcat);
ok('orders OLDEST → NEWEST (Machine 180d → Raw Material 90d → Paper 20d)', JSON.stringify(ordered) === JSON.stringify(['Notebook Making Machine', 'Notebook Raw Material', 'Paper']));
ok('setup sequence is "diversifying" (≥2 distinct categories)', trajectoryShape(setup) === 'diversifying');
ok('setup sequence HAS a story (≥2 distinct points)', hasStory(setup) === true);

// ── repeat / replenishment: same category over time ──
const repeat = [{ mcat: 'Diesel Generator', recencyDays: 10 }, { mcat: 'Diesel Generator', recencyDays: 200 }, { mcat: 'diesel generator', recencyDays: 100 }];
ok('repeated category → "repeat" shape', trajectoryShape(repeat) === 'repeat');
ok('repeat de-dups to ONE timeline step (keeps most-recent touch 10d)', (() => { const t = orderTrajectory(repeat); return t.length === 1 && t[0].recencyDays === 10; })());
ok('a single repeated category is NOT a story (one distinct point)', hasStory(repeat) === false);

// ── single / empty ──
ok('one category → "single"', trajectoryShape([{ mcat: 'TMT Bar', recencyDays: 5 }]) === 'single');
ok('one category → no story', hasStory([{ mcat: 'TMT Bar' }]) === false);
ok('no categories → "none"', trajectoryShape([]) === 'none');
ok('no categories → no story (cold buyer, nothing to narrate)', hasStory([]) === false);

// ── robustness ──
ok('empty/blank mcats are dropped', orderTrajectory([{ mcat: '' }, { mcat: '  ' }, { mcat: 'Cable' }]).length === 1);
ok('undated entries sort to the recent end (recencyDays ?? -1)', (() => { const t = orderTrajectory([{ mcat: 'A', recencyDays: 100 }, { mcat: 'B' }]); return t[0].mcat === 'A' && t[1].mcat === 'B'; })());
ok('the LLM narrative is GATED off below 2 distinct points (no story from one datum)', hasStory([{ mcat: 'X', recencyDays: 1 }]) === false && hasStory([{ mcat: 'X' }, { mcat: 'Y' }]) === true);
ok('case-insensitive de-dup (Diesel Generator == diesel generator)', orderTrajectory([{ mcat: 'Diesel Generator' }, { mcat: 'diesel generator' }]).length === 1);

console.log(`\ntrajectorytest (P2.7 buyer story: chronological timeline · shape · ≥2-distinct story gate · de-dup · soft-signal): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
