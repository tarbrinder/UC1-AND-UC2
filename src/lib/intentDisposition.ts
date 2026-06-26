// ─── FIRST-PAGE INTENT LEADERBOARD / DISPOSITION ──────────────────────────────────────────────
// The page-1 intent (the "what's this for?" hero) is decided by a PRECEDENCE race between three
// candidate sources — the Coverage Registry (a prior answer), the Buyer Twin's active-intent, and
// the LLM's one-shot derivation — with the LLM's chips as the ask-fallback. Debug mode used to show
// NOTHING for this on the first page. This lib makes the race legible: for EVERY candidate it shows
// its value, its confidence (the real ranking signal), and its DISPOSITION — CHOSEN, or why it lost
// (BELOW_THRESHOLD / OFF_PROFILE / OVERRIDDEN). Deterministic, no LLM. Mirrors categoryDisposition.

export type IntentDisp = 'CHOSEN' | 'BELOW_THRESHOLD' | 'OFF_PROFILE' | 'OVERRIDDEN' | 'ASK_FALLBACK';
export interface IntentRow {
  source: 'Registry' | 'Twin' | 'LLM' | 'Chip';
  value: string;
  confidence: number;        // ranking signal (0 for chips — they carry no per-chip score yet)
  disposition: IntentDisp;
  reason: string;
}
export interface IntentInput {
  registry?: { value: string; confidence: number } | null; // a prior intent answer (highest precedence)
  twin?: { value: string; confidence: number; offProfile: boolean } | null; // Twin active-intent
  llm?: { value: string; confidence: number } | null;       // deriveIntent's own derivedIntent
  chips: string[];           // the LLM's tap-options (the question shown if no source clears the bar)
  chosenValue: string | null; // the value the form actually used (null → ask the chip question)
  threshold?: number;        // confidence bar to be trusted as a pre-fill (default 80, mirrors the form)
}

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
const isChosen = (v: string, chosen: string | null) => !!chosen && norm(v) === norm(chosen);

// Precedence (mirrors the deriveIntent .then() exactly): registry≥bar > on-profile twin≥bar > llm≥bar > ask.
export function intentLeaderboard(input: IntentInput): IntentRow[] {
  const bar = typeof input.threshold === 'number' ? input.threshold : 80;
  const rows: IntentRow[] = [];

  const regOk = !!input.registry && input.registry.confidence >= bar;
  const twinOk = !!input.twin && input.twin.confidence >= bar && !input.twin.offProfile;
  // who actually won, by precedence
  const winner: IntentRow['source'] | null = regOk ? 'Registry' : twinOk ? 'Twin' : (!!input.llm && input.llm.confidence >= bar) ? 'LLM' : null;

  if (input.registry) {
    const r = input.registry;
    rows.push(r.confidence < bar
      ? { source: 'Registry', value: r.value, confidence: r.confidence, disposition: 'BELOW_THRESHOLD', reason: `prior answer below the ${bar} bar — not trusted as a pre-fill` }
      : { source: 'Registry', value: r.value, confidence: r.confidence, disposition: 'CHOSEN', reason: 'a prior answer at/above the bar — the registry is the source of truth (top precedence)' });
  }
  if (input.twin) {
    const t = input.twin;
    rows.push(
      t.offProfile
        ? { source: 'Twin', value: t.value, confidence: t.confidence, disposition: 'OFF_PROFILE', reason: 'off-profile — a historical intent does not apply to a genuinely new area; never used (no leak)' }
        : t.confidence < bar
          ? { source: 'Twin', value: t.value, confidence: t.confidence, disposition: 'BELOW_THRESHOLD', reason: `active-intent below the ${bar} bar — not trusted` }
          : winner !== 'Twin'
            ? { source: 'Twin', value: t.value, confidence: t.confidence, disposition: 'OVERRIDDEN', reason: 'the registry holds a higher-precedence current answer' }
            : { source: 'Twin', value: t.value, confidence: t.confidence, disposition: 'CHOSEN', reason: 'on-profile, evidence-backed active-intent at/above the bar — a better default than a one-shot guess' });
  }
  if (input.llm && input.llm.value) {
    const l = input.llm;
    rows.push(
      l.confidence < bar
        ? { source: 'LLM', value: l.value, confidence: l.confidence, disposition: 'BELOW_THRESHOLD', reason: `derivation below the ${bar} bar — let the chips do the work (ask, don't pre-fill)` }
        : winner !== 'LLM'
          ? { source: 'LLM', value: l.value, confidence: l.confidence, disposition: 'OVERRIDDEN', reason: winner === 'Registry' ? 'the registry prior wins precedence' : 'the on-profile Twin active-intent wins precedence' }
          : { source: 'LLM', value: l.value, confidence: l.confidence, disposition: 'CHOSEN', reason: 'product-specific derivation at/above the bar (off-profile, or no registry/Twin) — recorded as Intent' });
  }
  // chips are the ask-fallback: the actual question options. They carry no per-chip score (that needs the
  // prompt to emit scores). They are the live question when nothing cleared the bar (chosenValue null).
  for (const c of input.chips || []) {
    if (!c) continue;
    rows.push({ source: 'Chip', value: c, confidence: 0, disposition: 'ASK_FALLBACK', reason: winner ? 'a change-option (a source pre-filled the answer; buyer can still pick this)' : 'a tap-option on the live question (no source cleared the bar → we ask)' });
  }

  // rank: real candidates by confidence desc; the CHOSEN one floats to the very top; chips trail (score-less).
  return rows.sort((a, b) => {
    const ac = isChosen(a.value, input.chosenValue) && a.source !== 'Chip' ? 1 : 0;
    const bc = isChosen(b.value, input.chosenValue) && b.source !== 'Chip' ? 1 : 0;
    if (ac !== bc) return bc - ac;
    if ((a.source === 'Chip') !== (b.source === 'Chip')) return a.source === 'Chip' ? 1 : -1;
    return b.confidence - a.confidence;
  });
}

export function intentSummary(rows: IntentRow[], chosenValue: string | null): string {
  const sources = rows.filter((r) => r.source !== 'Chip');
  const chips = rows.filter((r) => r.source === 'Chip').length;
  const won = rows.find((r) => r.disposition === 'CHOSEN');
  const head = won ? `pre-filled from ${won.source} "${won.value}" (conf ${won.confidence})` : chosenValue ? `pre-filled "${chosenValue}"` : 'asking the buyer (no source cleared the bar)';
  return `${head} · ${sources.length} source candidate${sources.length === 1 ? '' : 's'} · ${chips} chip option${chips === 1 ? '' : 's'}`;
}
