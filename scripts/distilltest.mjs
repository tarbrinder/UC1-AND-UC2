// Deterministic test for P2.2 repeat-purchase detection — GENERIC token-overlap of the
// current product vs prior buy-lead titles. NO category literals (the standing rule): the
// same ≥4-char token-overlap works for any product, exactly like personaSpecMatch.

// Mirrors src/lib/enrichment.ts coreTokens: ≥3 chars + plural-stem + function-word
// stopwords. The ≥4 floor used to drop "lug" and split a returning buyer in two.
const STOP = new Set(['for', 'the', 'and', 'with', 'from', 'your', 'our', 'this', 'that', 'any', 'all', 'per', 'via', 'new', 'use']);
const singularize = (w) => {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
};
const toks = (s) => {
  const out = new Set();
  for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(singularize(w));
  }
  return out;
};
const repeat = (product, blTitles) => {
  const cur = toks(product);
  if (!cur.size) return null;
  for (const t of blTitles) {
    const tt = toks(t);
    if ([...cur].some((x) => tt.has(x))) return t;
  }
  return null;
};

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

ok('tyre polish ↔ prior "Tyre Polish" → repeat', repeat('tyre polish', ['Tyre Polish', '350 Cst Silicone Oil']) === 'Tyre Polish');
ok('notebook raw material ↔ "Notebook Making Machine" → repeat (shared token "notebook")', repeat('notebook raw material', ['Notebook Making Machine']) === 'Notebook Making Machine');
ok('diesel generator ↔ unrelated history → null (no replenishment claim)', repeat('diesel generator', ['Tyre Polish', 'Acid Slurry']) === null);
// #1 THE cable-lug regression: plural + 3-char head must connect to the singular history.
ok('#1 "cable lugs" ↔ prior "Panel Lug" → repeat (plural + 3-char head, the bug)', repeat('cable lugs', ['Panel Lug']) === 'Panel Lug');
ok('#1 singular "cable lug" ↔ "Panel Lug" → repeat', repeat('cable lug', ['Panel Lug']) === 'Panel Lug');
ok('#1 3-char heads now match — "oil" ↔ "Silicone Oil" (was dropped by the ≥4 floor)', repeat('oil', ['Silicone Oil']) === 'Silicone Oil');
ok('2-char tokens still ignored — "ss" does not bridge "ss pipe" ↔ "ss wire"', repeat('ss pipe', ['ss wire']) === null);
ok('plural-stem does not over-merge — "pins" stems to "pin", "pinch" stays', repeat('pins', ['Pinch Valve']) === null);
ok('case-insensitive', repeat('TYRE POLISH', ['tyre polish']) === 'tyre polish');
ok('category-agnostic — works for an unrelated product too', repeat('hydraulic pump', ['Hydraulic Pump Seals']) === 'Hydraulic Pump Seals');
ok('no prior history → null', repeat('tyre polish', []) === null);

// F2: business_type designation guard — a job TITLE (Owner/Proprietor/Director…) is never a
// business type; it leaked through on weak/partial Twin pulls. The guard rejects designations.
const isDesignation = (s) => /^(owner|proprietor|partner|director|ceo|cfo|coo|md|managing director|founder|co[-\s]?founder|manager|self|individual|buyer|purchaser|head|president|vp|employee)$/i.test(String(s).trim());
ok('F2: "Owner" rejected as business_type', isDesignation('Owner') === true);
ok('F2: "Proprietor" rejected', isDesignation('Proprietor') === true);
ok('F2: "Managing Director" rejected', isDesignation('Managing Director') === true);
ok('F2: "Manufacturer" kept (real business type)', isDesignation('Manufacturer') === false);
ok('F2: "Trader" kept', isDesignation('Trader') === false);
ok('F2: "Wholesaler" kept', isDesignation('Wholesaler') === false);

console.log(`\ndistilltest (P2.2 repeat + F2 designation-guard): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
