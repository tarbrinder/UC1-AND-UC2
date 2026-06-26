// Deterministic test for the Provenance Partition (mirrors provenance.ts). Proves: only BUYER-originated facts
// feed inference; PLATFORM-generated facts (our outbound, matched sellers, platform-deduced specs, system tags)
// are split out with a reason. NO live code import — this is the canonical mirror, run with `node scripts/provenance.mjs`.

const PLATFORM_DEDUCED_RE = /probable order value|probable requirement type|requirement type\b|business use\b/i;
const PLATFORM_TAG_RE = /match(?:ed)?[\s_-]*sellers?|sellers?[\s_-]*match|matchmak|recommend(?:ed)?[\s_-]*sellers?/i;
// user-locked: WhatsApp BOTH directions feed inference; only matched sellers + deduced specs are excluded.
const SIGNAL_PRIORITY = 'PNS call (spoken) > WhatsApp (inbound + outbound messages) > external identity (Befisc / Sign3) > on-site search (CSL) > prior requirement / past ISQ';

function classifyFact(f) {
  if (PLATFORM_TAG_RE.test(f.tag) || PLATFORM_TAG_RE.test(f.rawValue)) return { origin: 'platform_generated', reason: 'matched seller' };
  if (/isq|spec/i.test(f.tag) && PLATFORM_DEDUCED_RE.test(f.rawValue)) return { origin: 'platform_generated', reason: 'platform-deduced spec' };
  if (f.sourceNode === 'wa-out') return { origin: 'platform_generated', reason: 'our WhatsApp message (context, not buyer intent)' };
  return { origin: 'buyer_originated', reason: `buyer · ${f.sourceNode}` };
}
function partition(facts) {
  const buyer = [], platform = [];
  for (const f of facts) (classifyFact(f).origin === 'platform_generated' ? platform : buyer).push(f);
  return { buyer, platform };
}

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}`); } };

const F = (sourceNode, tag, rawValue) => ({ sourceNode, tag, rawValue });

// — classifier —
ok('OUR WhatsApp message (seller share) → context (platform)', classifyFact(F('wa-out', 'wa.msg', 'Here are seller details: ABC Traders, Mumbai')).origin === 'platform_generated');
ok("buyer's WhatsApp reply → signal (buyer)", classifyFact(F('wa-in', 'wa.msg', 'haan ji, quote bhej do')).origin === 'buyer_originated');
ok('matched-seller tag → platform', classifyFact(F('csl', 'matched_seller', 'ABC Traders')).origin === 'platform_generated');
ok('matched-seller in value → platform', classifyFact(F('pns-insights', 'note', 'recommended seller: XYZ')).origin === 'platform_generated');
ok('deduced ISQ (Probable Order Value) → platform', classifyFact(F('prev-isq', 'isq.answer', 'Probable Order Value=Rs 70 Lakh')).origin === 'platform_generated');
ok('deduced ISQ (Requirement Type) → platform', classifyFact(F('prev-isq', 'isq.answer', 'Probable Requirement Type=Business Use')).origin === 'platform_generated');
ok('real ISQ answer → buyer', classifyFact(F('prev-isq', 'isq.answer', 'Automation Grade=Semi-Automatic')).origin === 'buyer_originated');
ok('CSL search → buyer', classifyFact(F('csl', 'csl.searchterm', 'notebook making machine kanpur')).origin === 'buyer_originated');
ok('prev BL → buyer', classifyFact(F('prev-bl', 'bl.title', '1300Pcs/Hr Notebook Making Machine')).origin === 'buyer_originated');
ok('PNS persona → buyer', classifyFact(F('pns-insights', 'pns.persona', 'industrial manufacturer')).origin === 'buyer_originated');
ok('external (sign3) → buyer-side (feeds inference)', classifyFact(F('sign3', 'sign3.social', 'Flipkart, Facebook')).origin === 'buyer_originated');
ok('profile identity → buyer', classifyFact(F('profile-api', 'profile.city', 'Auraiya')).origin === 'buyer_originated');

// — partition over a mixed ledger —
const facts = [
  F('csl', 'csl.searchterm', 'notebook making machine'),
  F('wa-out', 'wa.msg', 'Did you connect with the seller?'),
  F('prev-isq', 'isq.answer', 'Probable Order Value=Rs 70 Lakh'),
  F('prev-isq', 'isq.answer', 'Automation Grade=Semi-Automatic'),
  F('csl', 'matched_seller', 'ABC Traders'),
  F('pns-insights', 'pns.intent', 'wants bulk machines'),
];
const p = partition(facts);
ok('partition buyer count = 3', p.buyer.length === 3);
ok('partition platform count = 3 (our WA + deduced + matched)', p.platform.length === 3);
ok('platform excludes the real ISQ answer', p.platform.every((f) => !/Automation Grade/.test(f.rawValue)));
ok('our WhatsApp message → context (platform); buyer messages stay signal', p.platform.some((f) => f.sourceNode === 'wa-out') && p.buyer.every((f) => f.sourceNode !== 'wa-out'));

// — conflict-resolution order (user-locked): PNS > WhatsApp(in+out) > external > CSL > prev-bl/isq —
ok('SIGNAL_PRIORITY: PNS before WhatsApp', SIGNAL_PRIORITY.indexOf('PNS') < SIGNAL_PRIORITY.indexOf('WhatsApp'));
ok('SIGNAL_PRIORITY: WhatsApp before external', SIGNAL_PRIORITY.indexOf('WhatsApp') < SIGNAL_PRIORITY.indexOf('external'));
ok('SIGNAL_PRIORITY: external before CSL', SIGNAL_PRIORITY.indexOf('external') < SIGNAL_PRIORITY.indexOf('CSL'));
ok('SIGNAL_PRIORITY: CSL before prior requirement', SIGNAL_PRIORITY.indexOf('CSL') < SIGNAL_PRIORITY.indexOf('prior requirement'));

console.log(`\nprovenance: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
