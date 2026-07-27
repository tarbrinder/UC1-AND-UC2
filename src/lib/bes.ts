// ─── Buyer Effort Score (BES) ────────────────────────────────────────────────
// The second KPI. TUS answers "did we USE the truth we hold"; BES answers "did we make the buyer WORK for
// what we already knew". The Engine optimises TUS ↑ and BES ↓ *together* — because uncertainty can always be
// reduced by asking more questions, and BES is the counter-force that forbids it.
//
//   BES = Σ (effort_i · weight_i)
//
// Not all effort is equal, and that weighting is the whole point:
//   · a CONFIRM tap on prefilled truth is ~free — and it is GOOD, it turns OBSERVED into STATED
//   · a chip selection is light
//   · free text is expensive (typing is the thing buyers abandon over)
//   · an upload is expensive but high-value
//   · a CORRECTION is expensive AND a signal: we prefilled wrong. Weighted hardest for that reason.
//   · a skip is a soft negative — the question wasn't worth answering
//   · every question merely SHOWN costs a little, even unanswered: it is screen the buyer had to read
//
// Deliberately local-only and side-effect free: no network, no PII, no field values — counts and one
// coarse duration. It is a measurement instrument, not another telemetry pipe.

export type BesEvent =
  | 'question_shown'   // a question rendered (chip group, gap, spec field)
  | 'chip'             // tapped an option chip
  | 'confirm'          // accepted a prefilled/observed value as-is
  | 'text'             // typed into a free-text field (counted once per field that ends non-empty)
  | 'upload'           // photo / file
  | 'voice'            // mic clip
  | 'correction'       // changed a value WE had prefilled → our prefill was wrong
  | 'skip'             // explicitly skipped past questions
  | 'backspace';       // cleared a field we had filled

/** Cost per unit of effort. Tuned to the plan's ranking, not measured — treat as a starting calibration. */
export const BES_WEIGHT: Record<BesEvent, number> = {
  confirm: 0.1,        // near-free and desirable
  question_shown: 0.3, // reading cost only
  chip: 1,
  skip: 1.5,
  text: 4,             // typing is what buyers abandon over
  voice: 3,
  upload: 4,
  backspace: 4,
  correction: 6,       // most expensive: effort AND evidence we got it wrong
};

const counts: Record<BesEvent, number> = {
  question_shown: 0, chip: 0, confirm: 0, text: 0, upload: 0, voice: 0, correction: 0, skip: 0, backspace: 0,
};
const textFieldsSeen = new Set<string>();   // 'text' is per-field, not per-keystroke
let startedAt = 0;
let submittedAt = 0;

export function besReset(): void {
  (Object.keys(counts) as BesEvent[]).forEach((k) => { counts[k] = 0; });
  textFieldsSeen.clear();
  startedAt = Date.now();
  submittedAt = 0;
}

/** Record one effort atom. `key` de-dupes per-field events (text/question_shown) so a 12-character
 *  product name is one typing cost, not twelve. */
export function bes(event: BesEvent, key?: string): void {
  if (!startedAt) startedAt = Date.now();
  if (key) {
    const k = `${event}:${key}`;
    if (textFieldsSeen.has(k)) return;
    textFieldsSeen.add(k);
  }
  counts[event] += 1;
}

export function besSubmitted(): void { submittedAt = Date.now(); }

export interface BesReport {
  score: number;                       // the weighted total — LOWER IS BETTER
  counts: Record<BesEvent, number>;
  contributions: { event: BesEvent; n: number; weight: number; cost: number }[];  // what actually cost us
  answered: number;                    // chips + confirms + text + voice + uploads
  shown: number;
  answerRate: number | null;           // answered ÷ shown — a question shown and skipped is wasted screen
  seconds: number | null;              // time-to-submit, null until submitted
}

export function besReport(): BesReport {
  const contributions = (Object.keys(counts) as BesEvent[])
    .map((e) => ({ event: e, n: counts[e], weight: BES_WEIGHT[e], cost: +(counts[e] * BES_WEIGHT[e]).toFixed(2) }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.cost - a.cost);
  const score = +contributions.reduce((s, c) => s + c.cost, 0).toFixed(2);
  const answered = counts.chip + counts.confirm + counts.text + counts.voice + counts.upload;
  const shown = counts.question_shown;
  return {
    score, counts: { ...counts }, contributions, answered, shown,
    answerRate: shown ? +(answered / shown).toFixed(2) : null,
    seconds: submittedAt && startedAt ? Math.round((submittedAt - startedAt) / 1000) : null,
  };
}
