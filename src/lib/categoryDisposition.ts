// ─── CANDIDATE LEADERBOARD / DISPOSITION ──────────────────────────────────────────────────────
// "Decision provenance, not just outputs." For EVERY candidate question the category brain produced
// (critical_specs · deal_blockers · applications), show — deterministically, no LLM — its priority
// (the real seller-frequency signal) and its DISPOSITION: did it become a panel question, or was it
// covered elsewhere (spec page / intent / last page / already known), or DEPRIORITISED (and why)?
// This answers "why wasn't Site-Ready asked?" without guessing: it shows where every insight went.

export type Disposition = 'ASKED' | 'SPEC' | 'INTENT' | 'LAST_PAGE' | 'KNOWN' | 'DEPRIORITIZED';
export interface CandidateRow {
  name: string;
  priority: number;            // ranking signal: seller_frequency (criticals) / frequency (blockers)
  kind: 'critical' | 'blocker' | 'application';
  disposition: Disposition;
  reason: string;
  coveredBy?: string;          // the question/spec/field that covers it (when not ASKED)
}
export interface DispositionInput {
  criticals: Array<{ name?: string; seller_frequency?: number | null; maps_to_isq?: string }>;
  blockers: Array<{ label?: string; kind?: string; frequency?: number }>;
  applications: string[];
  askedLabels: string[];       // the panel questions actually asked
  specNames: string[];         // ISQ spec fields (collected on the spec page)
  intentValue: string;         // the chosen/derived intent
  knownConcepts: string[];     // coverage-registry active concepts (already answered)
  lastPageConcepts?: string[]; // budget/gst/delivery/payment/location/firm (defaulted)
}

const STOP = new Set(['the', 'a', 'for', 'of', 'with', 'and', 'to', 'in', 'your', 'this', 'required', 'requirement', 'need', 'needed', 'type', 'do', 'you', 'how', 'what', 'is', 'are', 'will']);
const toks = (s: string): Set<string> => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t)));
const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// match if they share a meaningful token, or one normalized form contains the other (≥4 chars)
function related(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b);
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  const ta = toks(a), tb = toks(b);
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}
const matchIn = (name: string, list: string[]): string | undefined => list.find((x) => related(name, x));

const DEFAULT_LASTPAGE = ['budget', 'gst', 'delivery', 'payment', 'credit', 'location', 'firm', 'company', 'price'];

export function categoryLeaderboard(input: DispositionInput): CandidateRow[] {
  const lastPage = input.lastPageConcepts && input.lastPageConcepts.length ? input.lastPageConcepts : DEFAULT_LASTPAGE;
  const rows: CandidateRow[] = [];
  const seen = new Set<string>();

  const classify = (name: string, priority: number, kind: CandidateRow['kind'], maps_to_isq?: string): CandidateRow => {
    // 0) applications are INTENT-level by definition (they frame the intent question) — classify first,
    // before spec/asked matching, so a use-case like "Manufacturing backup power" isn't mis-read as the
    // "Rated Power" spec on a shared token.
    if (kind === 'application') return { name, priority, kind, disposition: 'INTENT', reason: 'framed the intent question (use-case)', coveredBy: input.intentValue || 'intent' };
    // 1) already known (coverage registry) — never re-ask
    const knownHit = input.knownConcepts.find((c) => related(name, c));
    if (knownHit) return { name, priority, kind, disposition: 'KNOWN', reason: 'already known/answered', coveredBy: knownHit };
    // 2) it's (or maps to) an ISQ spec → collected on the spec page, not a panel question
    if (maps_to_isq && maps_to_isq.trim()) return { name, priority, kind, disposition: 'SPEC', reason: 'an ISQ spec — collected on the spec page', coveredBy: maps_to_isq };
    const specHit = matchIn(name, input.specNames);
    if (specHit) return { name, priority, kind, disposition: 'SPEC', reason: 'an ISQ spec — collected on the spec page', coveredBy: specHit };
    // 3) became a panel question
    const askedHit = matchIn(name, input.askedLabels);
    if (askedHit) return { name, priority, kind, disposition: 'ASKED', reason: 'asked as a panel question', coveredBy: askedHit };
    // 4) a critical/blocker that overlaps the chosen intent is covered by the intent question
    if (input.intentValue && related(name, input.intentValue)) return { name, priority, kind, disposition: 'INTENT', reason: 'covered by the intent question', coveredBy: input.intentValue };
    // 5) a last-page concept
    const lpHit = matchIn(name, lastPage);
    if (lpHit) return { name, priority, kind, disposition: 'LAST_PAGE', reason: 'handled on the delivery/payment page', coveredBy: lpHit };
    // 6) generated but not surfaced — covered by a sibling question, or below the 3-card cap
    const sibling = input.askedLabels.find((q) => related(name, q));
    if (sibling) return { name, priority, kind, disposition: 'DEPRIORITIZED', reason: 'partially covered by another question', coveredBy: sibling };
    return { name, priority, kind, disposition: 'DEPRIORITIZED', reason: 'below the 3-question cap (lower seller-frequency)' };
  };

  const add = (r: CandidateRow) => { const k = norm(r.name); if (k && !seen.has(k)) { seen.add(k); rows.push(r); } };
  for (const c of input.criticals || []) if (c && c.name) add(classify(c.name, typeof c.seller_frequency === 'number' ? c.seller_frequency : 50, 'critical', c.maps_to_isq));
  for (const b of input.blockers || []) if (b && b.label) add(classify(b.label, typeof b.frequency === 'number' ? b.frequency : 30, 'blocker'));
  for (const a of input.applications || []) if (a) add(classify(a, 40, 'application'));

  return rows.sort((x, y) => y.priority - x.priority);
}

// Compact summary for the panel header.
export function dispositionSummary(rows: CandidateRow[]): string {
  const c = (d: Disposition) => rows.filter((r) => r.disposition === d).length;
  return `${rows.length} candidates · asked ${c('ASKED')} · spec ${c('SPEC')} · intent ${c('INTENT')} · last-page ${c('LAST_PAGE')} · known ${c('KNOWN')} · deprioritised ${c('DEPRIORITIZED')}`;
}
