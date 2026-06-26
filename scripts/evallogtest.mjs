// Deterministic test for EVAL-OVER-TIME trend math — mirrors src/lib/evalLog.ts (pure part).
// Drift across runs + per-version regression detection. NO LLM, NO storage.

function evalTrend(runs) {
  const empty = { runs: 0, avgSystem: 0, avgBusiness: 0, firstSystem: 0, lastSystem: 0, systemDelta: 0, byVersion: {}, regression: false };
  if (!runs.length) return empty;
  const avg = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
  const sys = runs.map((r) => r.systemPct), biz = runs.map((r) => r.businessPct);
  const byVersion = {};
  for (const v of new Set(runs.map((r) => r.promptsVersion || '?'))) {
    const rs = runs.filter((r) => (r.promptsVersion || '?') === v);
    byVersion[v] = { runs: rs.length, avgSystem: avg(rs.map((r) => r.systemPct)), avgBusiness: avg(rs.map((r) => r.businessPct)) };
  }
  const overall = avg(sys);
  const regression = Object.values(byVersion).some((v) => v.runs >= 2 && v.avgSystem <= overall - 8);
  return { runs: runs.length, avgSystem: overall, avgBusiness: avg(biz), firstSystem: sys[0], lastSystem: sys[sys.length - 1], systemDelta: sys[sys.length - 1] - sys[0], byVersion, regression };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// stable runs across one version
const stable = [{ systemPct: 90, businessPct: 80, promptsVersion: 'v1' }, { systemPct: 88, businessPct: 82, promptsVersion: 'v1' }, { systemPct: 91, businessPct: 79, promptsVersion: 'v1' }];
const t1 = evalTrend(stable);
ok('stable: avg system ~90', t1.avgSystem === 90 && t1.runs === 3);
ok('stable: small drift, no regression', Math.abs(t1.systemDelta) <= 3 && t1.regression === false);

// a NEW version regresses (drops system ~15 pts) — must be flagged
const regressed = [...stable, { systemPct: 72, businessPct: 70, promptsVersion: 'v2' }, { systemPct: 70, businessPct: 68, promptsVersion: 'v2' }];
const t2 = evalTrend(regressed);
ok('regression: v2 (2 runs, ~71) flagged below overall', t2.regression === true);
ok('regression: byVersion isolates v1 (high) vs v2 (low)', t2.byVersion.v1.avgSystem > t2.byVersion.v2.avgSystem + 8);
ok('regression: drift is negative (last < first)', t2.systemDelta < 0);
ok('regression: per-version run counts correct', t2.byVersion.v1.runs === 3 && t2.byVersion.v2.runs === 2);

// a single bad run on a new version (only 1 run) → NOT flagged as regression (needs ≥2 to be a pattern)
const oneOff = [...stable, { systemPct: 50, businessPct: 50, promptsVersion: 'v3' }];
ok('single low run (1 sample) → not a regression (noise, not a pattern)', evalTrend(oneOff).regression === false);

// business pct tracked independently
ok('business avg tracked separately', t1.avgBusiness === 80);

// graceful
ok('empty → zeros, no throw', evalTrend([]).runs === 0 && evalTrend([]).regression === false);
ok('missing version → grouped under "?"', evalTrend([{ systemPct: 80, businessPct: 70 }]).byVersion['?'].runs === 1);

console.log(`\nevallogtest (eval-over-time: drift · per-version avg · regression detection (≥2 runs, ≥8pt drop) · single-run noise guard · graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
