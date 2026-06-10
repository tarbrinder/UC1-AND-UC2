// ─── Authority engine (P1 · Tier-2 STRUCTURAL inference) ──────────────────────
// Derives the buyer's ROLE IN THE BUYING PROCESS from their DESIGNATION (job title) — a first-party
// signal we already hold (profile.buyer.designation) but never parsed. Sibling of the Nature engine.
//
// THE FOUR ROLES (what they do in a B2B purchase, NOT their category):
//   • decision_maker — owns the budget, can commit (Owner / Director / CEO / Partner / Proprietor)
//   • procurement    — runs the buying process (Purchase / Procurement / Sourcing / Materials / Stores)
//   • researcher     — investigates / specs, advisory (Professor / Scientist / R&D / PhD / Faculty)
//   • influencer     — technical evaluator who recommends + escalates (Manager / Engineer / Officer)
//
// NO CATEGORY HARDCODING: these are UNIVERSAL organisational-role semantics — never product rules.
// ANTI-HALLUCINATION (the Golden Rule): assert only what the TITLE proves.
//   "Professor" → Researcher (high) — NEVER auto a Decision-Maker (the title doesn't prove budget power).
//   "Purchase Manager" → Procurement — the FUNCTION (purchase) outranks the seniority word (manager).
//   No title → unknown (conf 0). Every result carries value + confidence + evidence + source.

export type AuthorityRole = 'decision_maker' | 'procurement' | 'researcher' | 'influencer' | 'unknown';

export interface AuthorityResult {
  authorityRole: AuthorityRole;
  value: string;        // human label ('' for unknown)
  confidence: number;   // 0-100
  evidence: string[];
  source: 'designation';
  title: string;        // the normalised title we classified
}

// Word-boundary patterns per role. Short tokens (md/vp/ceo/pi) use \b so they don't match inside
// other words (e.g. "md" must not fire on "command"). Checked in PRIORITY order (most specific first):
// procurement (the literal buyer) → researcher (academic/R&D) → decision_maker (ownership/board) →
// influencer (generic seniority). First role with a hit wins — a "Purchase Director" is Procurement.
const ROLE_PATTERNS: Array<{ role: Exclude<AuthorityRole, 'unknown'>; label: string; confidence: number; pats: RegExp[] }> = [
  {
    role: 'procurement', label: 'Procurement', confidence: 88,
    pats: [/\bpurchas\w*/, /\bprocure\w*/, /\bsourcing\b/, /\bbuyer\b/, /\bmaterials?\b/, /\bsupply\s*chain\b/, /\bindent\w*/, /\bstores?\b/, /\bvendor\b/, /\bscm\b/],
  },
  {
    role: 'researcher', label: 'Researcher', confidence: 90,
    // \bprof\b also catches "prof." after the dot is stripped by normalisation.
    pats: [/\bprofessor\b/, /\bprof\b/, /\bscientist\b/, /\bresearch\w*/, /\bscholar\b/, /\bph\s*d\b/, /\bfaculty\b/, /\blecturer\b/, /\br\s*&?\s*d\b/, /\bpostdoc\w*/, /\bdean\b/, /\bprincipal\s+investigator\b/, /\bacademic\b/],
  },
  {
    role: 'decision_maker', label: 'Decision-Maker', confidence: 85,
    pats: [/\bowner\b/, /\bproprietor\w*/, /\bfounder\b/, /\bco\s*founder\b/, /\bdirector\b/, /\bmanaging\s+director\b/, /\bmd\b/, /\bceo\b/, /\bcoo\b/, /\bcfo\b/, /\bcto\b/, /\bchair\w*/, /\bpartner\b/, /\bpromoter\b/, /\bpresident\b/, /\bvice\s*president\b/, /\bvp\b/, /\bprincipal\b/],
  },
  {
    role: 'influencer', label: 'Influencer', confidence: 70,
    pats: [/\bmanager\b/, /\bmgr\b/, /\bengineer\b/, /\bengg?\b/, /\bexecutive\b/, /\bofficer\b/, /\bsupervisor\b/, /\btechnician\b/, /\bconsultant\b/, /\bhead\b/, /\blead\b/, /\bcoordinator\b/, /\bincharge\b/, /\bin\s*charge\b/, /\boperator\b/, /\bforeman\b/, /\bdesigner\b/, /\barchitect\b/, /\banalyst\b/, /\bassociate\b/, /\bassistant\b/, /\bexec\b/, /\badmin\w*/],
  },
];

// Normalise: lowercase, strip punctuation to spaces, collapse whitespace. Keeps tokens like "r&d"
// resolvable (we also match the spaced form) and lets \b work on clean word boundaries.
const norm = (s?: string) => (s || '').toLowerCase().replace(/&/g, ' & ').replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function classifyDesignation(designation?: string): AuthorityResult {
  const title = norm(designation);
  const base = (v: Partial<AuthorityResult>): AuthorityResult => ({ authorityRole: 'unknown', value: '', confidence: 0, evidence: [], source: 'designation', title, ...v });
  if (!title) return base({});

  for (const { role, label, confidence, pats } of ROLE_PATTERNS) {
    const hit = pats.find((p) => p.test(title));
    if (hit) {
      return base({
        authorityRole: role,
        value: label,
        confidence,
        evidence: [`designation "${designation!.trim()}" indicates a ${label} role in the buying process`],
      });
    }
  }
  // A title exists but matches no known role token → we have a designation but cannot prove a role.
  return base({ evidence: [`designation "${designation!.trim()}" carries no recognised buying-role signal`] });
}

// Whether this authority is strong enough to shape the RFQ (consume-gate input). unknown never drives.
// Mirrors natureDrives (≥60), so a confident Influencer (70) still informs the plan.
export function authorityDrives(a: AuthorityResult): boolean {
  return a.authorityRole !== 'unknown' && !!a.value && a.confidence >= 60;
}

// One-line planner directive per role — what to ASK / what NOT to assume. Anti-hallucination baked in.
export function authorityPlannerHint(a: AuthorityResult): string {
  switch (a.authorityRole) {
    case 'decision_maker':
      return 'a DECISION-MAKER (owns the budget) — commercial terms, pricing and a direct close are fair game.';
    case 'procurement':
      return 'a PROCUREMENT role (runs the buying process) — expect a PO / rate-contract / tender flow: MOQ, payment terms, vendor compliance are relevant; do NOT pitch as if they are the end-user.';
    case 'researcher':
      return 'a RESEARCHER / technical role (investigates + specs) — be SPEC-PRECISE and advisory; this person may NOT control the budget, so AVOID hard commercial / credit pressure.';
    case 'influencer':
      return 'a likely INFLUENCER (technical evaluator who recommends + escalates) — lead with technical fit; commercials are usually escalated, not closed here.';
    default:
      return '';
  }
}
