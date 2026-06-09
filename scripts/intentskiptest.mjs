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

console.log(`\nintentskiptest (intent ask/confirm/skip policy matrix): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
