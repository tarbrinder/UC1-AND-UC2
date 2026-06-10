// Contract test for the Authority engine (P1) — mirrors src/lib/authority.ts (repo harness pattern:
// re-implement the pure logic inline, no TS import). Proves designation → buying-role classification
// + the ANTI-HALLUCINATION discipline: assert only what the TITLE proves (a Professor is a Researcher,
// never auto a Decision-Maker), function-word beats seniority-word, no title → unknown.

const ROLE_PATTERNS = [
  { role: 'procurement', label: 'Procurement', confidence: 88, pats: [/\bpurchas\w*/, /\bprocure\w*/, /\bsourcing\b/, /\bbuyer\b/, /\bmaterials?\b/, /\bsupply\s*chain\b/, /\bindent\w*/, /\bstores?\b/, /\bvendor\b/, /\bscm\b/] },
  { role: 'researcher', label: 'Researcher', confidence: 90, pats: [/\bprofessor\b/, /\bprof\b/, /\bscientist\b/, /\bresearch\w*/, /\bscholar\b/, /\bph\s*d\b/, /\bfaculty\b/, /\blecturer\b/, /\br\s*&?\s*d\b/, /\bpostdoc\w*/, /\bdean\b/, /\bprincipal\s+investigator\b/, /\bacademic\b/] },
  { role: 'decision_maker', label: 'Decision-Maker', confidence: 85, pats: [/\bowner\b/, /\bproprietor\w*/, /\bfounder\b/, /\bco\s*founder\b/, /\bdirector\b/, /\bmanaging\s+director\b/, /\bmd\b/, /\bceo\b/, /\bcoo\b/, /\bcfo\b/, /\bcto\b/, /\bchair\w*/, /\bpartner\b/, /\bpromoter\b/, /\bpresident\b/, /\bvice\s*president\b/, /\bvp\b/, /\bprincipal\b/] },
  { role: 'influencer', label: 'Influencer', confidence: 70, pats: [/\bmanager\b/, /\bmgr\b/, /\bengineer\b/, /\bengg?\b/, /\bexecutive\b/, /\bofficer\b/, /\bsupervisor\b/, /\btechnician\b/, /\bconsultant\b/, /\bhead\b/, /\blead\b/, /\bcoordinator\b/, /\bincharge\b/, /\bin\s*charge\b/, /\boperator\b/, /\bforeman\b/, /\bdesigner\b/, /\barchitect\b/, /\banalyst\b/, /\bassociate\b/, /\bassistant\b/, /\bexec\b/, /\badmin\w*/] },
];
const norm = (s) => (s || '').toLowerCase().replace(/&/g, ' & ').replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();
function classifyDesignation(designation) {
  const title = norm(designation);
  const base = (v) => ({ authorityRole: 'unknown', value: '', confidence: 0, evidence: [], source: 'designation', title, ...v });
  if (!title) return base({});
  for (const { role, label, confidence, pats } of ROLE_PATTERNS) {
    if (pats.find((p) => p.test(title))) return base({ authorityRole: role, value: label, confidence, evidence: [`designation "${designation.trim()}" indicates a ${label} role in the buying process`] });
  }
  return base({ evidence: [`designation "${designation.trim()}" carries no recognised buying-role signal`] });
}
const authorityDrives = (a) => a.authorityRole !== 'unknown' && !!a.value && a.confidence >= 60;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the IIT-Kanpur professor (the headline: institution=Academic [Nature], role=Researcher [Authority]) ──
const prof = classifyDesignation('Professor');
ok('Professor → researcher', prof.authorityRole === 'researcher');
ok('Professor: value = Researcher', prof.value === 'Researcher');
ok('Professor: NOT auto a Decision-Maker (anti-hallucination)', prof.authorityRole !== 'decision_maker' && prof.value !== 'Decision-Maker');
ok('Professor: high confidence (≥90)', prof.confidence >= 90);
ok('Professor: drives', authorityDrives(prof));
ok('Assistant Professor → researcher (researcher beats "assistant"→influencer)', classifyDesignation('Assistant Professor').authorityRole === 'researcher');
ok('Research Scholar → researcher', classifyDesignation('Research Scholar').authorityRole === 'researcher');
ok('Scientist → researcher', classifyDesignation('Senior Scientist').authorityRole === 'researcher');
ok('Head, R&D → researcher (R&D beats "head"→influencer)', classifyDesignation('Head, R&D').authorityRole === 'researcher');

// ── procurement (function word beats seniority word) ──
ok('Purchase Manager → procurement (not influencer)', classifyDesignation('Purchase Manager').authorityRole === 'procurement');
ok('Purchase Director → procurement (function beats "director")', classifyDesignation('Purchase Director').authorityRole === 'procurement');
ok('Sourcing Head → procurement', classifyDesignation('Sourcing Head').authorityRole === 'procurement');
ok('Materials Manager → procurement', classifyDesignation('Materials Manager').authorityRole === 'procurement');
ok('Procurement Officer → procurement', classifyDesignation('Procurement Officer').authorityRole === 'procurement');

// ── decision-maker ──
ok('Proprietor → decision_maker', classifyDesignation('Proprietor').authorityRole === 'decision_maker');
ok('Owner → decision_maker', classifyDesignation('Owner').authorityRole === 'decision_maker');
ok('Managing Director → decision_maker', classifyDesignation('Managing Director').authorityRole === 'decision_maker');
ok('CEO → decision_maker', classifyDesignation('CEO & Founder').authorityRole === 'decision_maker');
ok('Director → decision_maker', classifyDesignation('Director').authorityRole === 'decision_maker');
ok('Partner → decision_maker', classifyDesignation('Partner').authorityRole === 'decision_maker');

// ── influencer (generic seniority) ──
ok('Production Engineer → influencer', classifyDesignation('Production Engineer').authorityRole === 'influencer');
ok('Manager → influencer', classifyDesignation('Manager').authorityRole === 'influencer');
ok('influencer confidence is lower (70)', classifyDesignation('Manager').confidence === 70);
ok('influencer drives (≥60)', authorityDrives(classifyDesignation('Manager')));

// ── unknown / golden rule ──
ok('no designation → unknown, conf 0', classifyDesignation('').authorityRole === 'unknown' && classifyDesignation('').confidence === 0);
ok('undefined → unknown', classifyDesignation(undefined).authorityRole === 'unknown');
ok('unknown does NOT drive', !authorityDrives(classifyDesignation('')));
ok('unrecognised title ("Gappa") → unknown but records evidence', (() => { const r = classifyDesignation('Gappa'); return r.authorityRole === 'unknown' && r.evidence.length === 1; })());
ok('"command center" must NOT match md→decision_maker (word boundary)', classifyDesignation('Command Center Lead').authorityRole === 'influencer');

console.log(`\nauthorityenginetest (designation → buying-role · evidence-gated · function>seniority · anti-hallucination): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
