// ─── EVAL-OVER-TIME PERSISTENCE ──────────────────────────────────────────────────────────────
// ChatGPT: "scores over time." Append each RFQ's eval bundle to a rolling local log so DRIFT across
// runs and prompt-versions is visible — a regression shows as a score drop tied to a specific
// promptsVersion. Storage is localStorage (browser); the TREND math is pure (harnessed).

export interface EvalRun {
  ts: number;
  product?: string;
  promptsVersion?: string;     // the form-prompt build that produced this run
  systemPct: number;          // system eval %
  businessPct: number;        // business (leading + outcome) eval %
  outcomeScore?: number;      // the grounded outcome dimension
  scorecardPct?: number;      // utilization scorecard %
  categoryBand?: string;      // rich/thin/empty
}

const KEY = '__rfqEvalLog';
const CAP = 200;

export function pushEvalRun(run: EvalRun): void {
  try {
    const cur: EvalRun[] = JSON.parse(localStorage.getItem(KEY) || '[]');
    cur.push(run);
    const trimmed = cur.slice(-CAP);
    localStorage.setItem(KEY, JSON.stringify(trimmed));
    (window as unknown as { __evalLog?: EvalRun[] }).__evalLog = trimmed;
  } catch { /* storage unavailable — non-fatal */ }
}
export function getEvalRuns(): EvalRun[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

export interface EvalTrend {
  runs: number;
  avgSystem: number; avgBusiness: number;
  firstSystem: number; lastSystem: number; systemDelta: number; // drift over the window
  byVersion: Record<string, { runs: number; avgSystem: number; avgBusiness: number }>;
  regression: boolean; // a version whose avg system is materially below the overall avg
}
export function evalTrend(runs: EvalRun[]): EvalTrend {
  const empty: EvalTrend = { runs: 0, avgSystem: 0, avgBusiness: 0, firstSystem: 0, lastSystem: 0, systemDelta: 0, byVersion: {}, regression: false };
  if (!runs.length) return empty;
  const avg = (a: number[]) => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
  const sys = runs.map((r) => r.systemPct);
  const biz = runs.map((r) => r.businessPct);
  const byVersion: EvalTrend['byVersion'] = {};
  for (const v of new Set(runs.map((r) => r.promptsVersion || '?'))) {
    const rs = runs.filter((r) => (r.promptsVersion || '?') === v);
    byVersion[v] = { runs: rs.length, avgSystem: avg(rs.map((r) => r.systemPct)), avgBusiness: avg(rs.map((r) => r.businessPct)) };
  }
  const overall = avg(sys);
  // regression = a version with ≥2 runs whose avg system is ≥8 pts below the overall average.
  const regression = Object.values(byVersion).some((v) => v.runs >= 2 && v.avgSystem <= overall - 8);
  return { runs: runs.length, avgSystem: overall, avgBusiness: avg(biz), firstSystem: sys[0], lastSystem: sys[sys.length - 1], systemDelta: sys[sys.length - 1] - sys[0], byVersion, regression };
}
