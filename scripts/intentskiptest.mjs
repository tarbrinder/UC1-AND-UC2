// Contract test for the INTENT ask/confirm/skip POLICY (pilot audit — "intent-skip matrix").
// Whether the page-1 intent is ASKED, auto-CONFIRMED, or SKIPPED is decided across several places
// (deriveIntent, the Continue intent-gate, the Skip button, handleRepost). This file pins the
// INTENDED matrix as ONE deterministic policy so the behaviour can't silently drift, and documents
// the precedence. Mirrors the rules commented at the intent gate in RFQModalV3.tsx.
//
// Precedence (first match wins):
//   1. repost              → skip     (re-posting a known requirement; no fresh "why")
//   2. intentInProductText → skip     (buyer already typed the purpose explicitly)
//   3. offProfile          → ask      (diverges from history → discover, never assume a persona)
//   4. contradiction       → ask      (signals disagree → ask the smallest clarifier)
//   5. twinConf ≥ 80       → confirm  (Twin confidently knows → one-tap confirm, not a blank ask)
//   6. productImpliesIntent→ confirm  (product strongly implies the use → confirm)
//   7. otherwise           → ask      (cold / new / low-confidence buyer)

function intentDecision(ctx = {}) {
  if (ctx.repost) return 'skip';
  if (ctx.intentInProductText) return 'skip';
  if (ctx.offProfile) return 'ask';
  if (ctx.contradiction) return 'ask';
  if ((ctx.twinConf || 0) >= 80) return 'confirm';
  if (ctx.productImpliesIntent) return 'confirm';
  return 'ask';
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the 8 canonical matrix rows ──
ok('New cold buyer → ask', intentDecision({ coldNew: true }) === 'ask');
ok('Product implies intent (strong) → confirm', intentDecision({ productImpliesIntent: true }) === 'confirm');
ok('Re-post → skip', intentDecision({ repost: true }) === 'skip');
ok('Explicit requirement typed in product text → skip', intentDecision({ intentInProductText: true }) === 'skip');
ok('Off-profile purchase → ask', intentDecision({ offProfile: true }) === 'ask');
ok('Contradictory signals → ask', intentDecision({ contradiction: true }) === 'ask');
ok('Low confidence → ask', intentDecision({ twinConf: 40 }) === 'ask');
ok('High Twin confidence → confirm', intentDecision({ twinConf: 90 }) === 'confirm');

// ── precedence / conflict resolution (the tricky combinations) ──
ok('repost BEATS off-profile (repost → skip even if off-profile)', intentDecision({ repost: true, offProfile: true }) === 'skip');
ok('off-profile BEATS high Twin confidence (discover, do not assume)', intentDecision({ offProfile: true, twinConf: 95 }) === 'ask');
ok('contradiction BEATS high Twin confidence (ask the clarifier)', intentDecision({ contradiction: true, twinConf: 95 }) === 'ask');
ok('explicit-in-text BEATS off-profile (already stated → skip)', intentDecision({ intentInProductText: true, offProfile: true }) === 'skip');
ok('high Twin conf BEATS productImpliesIntent (both → confirm, no double)', intentDecision({ twinConf: 85, productImpliesIntent: true }) === 'confirm');
ok('no signals at all → ask (safe default)', intentDecision({}) === 'ask');

// G (notebook-paper bug): a high-conf Twin active-intent must WIN over an ambiguous product surface
// ("notebook paper" could read as retail/record-keeping), shown as a one-tap CONFIRMATION — and it
// must NEVER auto-skip the question. 'confirm' = a derived, editable suggestion; the CURRENT
// requirement always overrides (the buyer can Change it). It is never silently auto-accepted.
ok('G: Twin active-intent (95) wins over ambiguous product surface → confirm', intentDecision({ twinConf: 95 }) === 'confirm');
ok('G: a confident Twin NEVER auto-skips the intent (stays confirmable)', intentDecision({ twinConf: 99 }) !== 'skip');

// G2 (notebook-paper "resale" bug): which derived VALUE is shown as the confirmation. ON-PROFILE the
// evidence-backed Twin active-intent beats a one-shot LLM guess; OFF-PROFILE the LLM wins; a CURRENT
// (registry) answer always wins. Mirrors the precedence in the deriveIntent result handler.
function pickIntentValue(c = {}) {
  if (c.regKnown) return c.regVal;                       // current/registry answer always wins
  if (c.twinKnown && !c.offProfile) return c.twinVal;    // on-profile: evidence-backed Twin beats LLM
  if (c.derivedKnown) return c.derivedVal;               // off-profile / no twin: product-specific LLM
  return null;                                            // G3: OFF-profile → NEVER fall back to the Twin (ask)
}
ok('G2: on-profile, Twin "Notebook Manufacturing Inputs" beats LLM "resale"',
  pickIntentValue({ twinKnown: true, twinVal: 'Notebook Manufacturing Inputs', offProfile: false, derivedKnown: true, derivedVal: 'resale' }) === 'Notebook Manufacturing Inputs');
ok('G2: OFF-profile, the product-specific LLM derivation wins (Twin irrelevant to a new area)',
  pickIntentValue({ twinKnown: true, twinVal: 'Notebook Manufacturing Inputs', offProfile: true, derivedKnown: true, derivedVal: 'Office furniture' }) === 'Office furniture');
ok('G2: a CURRENT (registry) answer overrides both Twin and LLM',
  pickIntentValue({ regKnown: true, regVal: 'Custom printed notebooks', twinKnown: true, twinVal: 'Notebook Manufacturing Inputs', derivedKnown: true, derivedVal: 'resale' }) === 'Custom printed notebooks');
ok('G2: no Twin, LLM only → LLM derivation', pickIntentValue({ derivedKnown: true, derivedVal: 'School notebooks' }) === 'School notebooks');
ok('G2: nothing confident → null (ask the chip question)', pickIntentValue({}) === null);

// G3 (potatoes bug): OFF-profile, the Twin's historical intent must NEVER be used — not even as a
// fallback when the LLM is unsure. An electronics buyer asking for "potatoes" must NOT autofill
// "desktop peripherals"; with no confident product derivation, we ASK (value null). Weight current →
// stitch history only if related → else persist with the current requirement.
ok('G3: off-profile + Twin known + LLM unsure → ask (NO twin leak, was "potatoes for desktop peripherals")',
  pickIntentValue({ twinKnown: true, twinVal: 'Desktop Peripherals', offProfile: true, derivedKnown: false }) === null);
ok('G3: off-profile + Twin known + LLM confident → LLM product derivation (still no twin)',
  pickIntentValue({ twinKnown: true, twinVal: 'Desktop Peripherals', offProfile: true, derivedKnown: true, derivedVal: 'Processing for snacks' }) === 'Processing for snacks');
ok('G3: on-profile + Twin known → Twin still wins (relation exists)',
  pickIntentValue({ twinKnown: true, twinVal: 'Notebook Manufacturing Inputs', offProfile: false, derivedKnown: true, derivedVal: 'resale' }) === 'Notebook Manufacturing Inputs');

// ── PERSONAL-JOURNEY GUARD (the Jaiveer bug): a BUSINESS buyer or a BULK/WHOLESALE order can NEVER be
// "personal". Mirrors the deriveIntent backstop — when the model slips, return null (→ planner-first)
// rather than ask a wrong "for personal use?" question. ──
const personalAllowed = (journey, buyerKind, orderScale) => {
  if (journey !== 'personal') return true; // non-personal journeys always pass
  return !(buyerKind === 'business' || orderScale === 'bulk' || orderScale === 'wholesale');
};
ok('PJ: business buyer + personal journey → BLOCKED (Jaiveer: notebook maker, paper)', personalAllowed('personal', 'business', 'wholesale') === false);
ok('PJ: 10,000 kg (wholesale) personal → BLOCKED even if buyer-kind unknown', personalAllowed('personal', undefined, 'wholesale') === false);
ok('PJ: bulk order personal → BLOCKED', personalAllowed('personal', undefined, 'bulk') === false);
ok('PJ: genuine personal (single qty, non-business) → ALLOWED', personalAllowed('personal', 'personal', 'single') === true);
ok('PJ: personal (small, unknown kind) → ALLOWED', personalAllowed('personal', undefined, 'small') === true);
ok('PJ: business + industrial journey → unaffected (only personal is guarded)', personalAllowed('industrial', 'business', 'wholesale') === true);
ok('PJ: business + resale journey → unaffected', personalAllowed('resale', 'business', 'bulk') === true);

console.log(`\nintentskiptest (intent ask/confirm/skip policy matrix + personal-journey guard): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
