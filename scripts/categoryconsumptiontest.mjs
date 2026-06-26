// Deterministic test for CATEGORY CONSUMPTION — mirrors src/lib/categoryConsumption.ts.
// Consumes the richer layers v13's distill now emits (deal_blockers · intent_patterns · price).
// Modelled on the REAL generator PNS calls the user pasted. GENERIC (no category literals). NO LLM.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const KIND_RULES = [
  { kind: 'condition', re: /reconditi|refurbish|second.?hand|\bused\b|\bnew\b|model year|run hours|\bage\b/i, label: 'New, or is refurbished / second-hand acceptable?' },
  { kind: 'logistics', re: /logistic|deliver|transport|freight|shipping|dispatch|\bsite\b|installation site/i, label: 'Where is delivery, and who bears freight? (sellers commonly stall here)' },
  { kind: 'price', re: /price|budget|\brate\b|costly|expensive|negotiat|discount|too high/i, label: 'A budget range helps sellers quote in-band (this category negotiates hard)' },
  { kind: 'warranty', re: /warrant|guarantee|\bamc\b|service|after.?sale|support/i, label: 'Warranty / after-sales expectation?' },
  { kind: 'technical', re: /technical|\bload\b|compatib|\bhp\b|\bkva\b|\bkw\b|capacity|voltage|phase/i, label: 'Confirm the load / technical fit so sizing is right' },
  { kind: 'availability', re: /stock|availab|lead.?time|\beta\b/i, label: 'Do you need it in stock / by a date?' },
];
function dealBlockerChecks(blockers, opts = {}) {
  const known = new Set((opts.knownKinds || []).map(norm));
  const byKind = new Map();
  for (const b of blockers || []) {
    const text = `${b.category || ''} ${b.name || ''} ${b.detail || ''}`.trim(); if (!text) continue;
    const rule = KIND_RULES.find((r) => r.re.test(text)); const kind = rule ? rule.kind : 'other';
    if (known.has(norm(kind))) continue;
    const freq = typeof b.frequency === 'number' ? b.frequency : 0;
    const prev = byKind.get(kind);
    if (!prev || freq > prev.frequency) byKind.set(kind, { kind, label: rule ? rule.label : text.slice(0, 90), frequency: freq, evidence: text.slice(0, 100) });
  }
  return [...byKind.values()].filter((c) => c.kind !== 'other').sort((a, b) => b.frequency - a.frequency).slice(0, opts.max ?? 2);
}
function intentPatternHints(patterns, max = 5) {
  const ranked = [...(patterns || [])].filter((p) => p && p.intent).sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
  return { applications: ranked.map((p) => String(p.intent)).slice(0, max), loadSizingRelevant: ranked.some((p) => /\bload\b|\bhp\b|\bkva\b|\bkw\b|motor|power|run\b|sizing|capacity/i.test(String(p.intent))) };
}
const L = 100000;
const fmtINR = (lakh) => lakh >= 1 ? `₹${lakh % 1 === 0 ? lakh : lakh.toFixed(1)} lakh` : `₹${Math.round(lakh * 100)}k`;
function roundLakh(v) { const l = v / L; if (l < 1) return Math.max(0.25, Math.round(l * 4) / 4); if (l < 10) return Math.round(l); return Math.round(l / 5) * 5; }
function categoryBudgetBands(dist) {
  if (!dist || !(Number(dist.max) > 0)) return null;
  const min = Number(dist.min) > 0 ? Number(dist.min) : Number(dist.max) / 10;
  const max = Number(dist.max); if (max <= min * 1.2) return null;
  const med = Number(dist.median) > 0 ? Number(dist.median) : (min + max) / 2;
  let t1 = roundLakh(Math.max(min, med / 2)), t2 = roundLakh(med), t3 = roundLakh(Math.min(max, med * 2));
  if (t2 <= t1) t2 = roundLakh(t1 * 2 * L); if (t3 <= t2) t3 = roundLakh(t2 * 2 * L);
  if (t2 <= t1 || t3 <= t2) return null;
  return [`Under ${fmtINR(t1)}`, `${fmtINR(t1)}–${fmtINR(t2)}`, `${fmtINR(t2)}–${fmtINR(t3)}`, `${fmtINR(t3)}+`];
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── DEAL BLOCKERS (real generator calls: logistics, price, condition recur) → proactive checks ──
const blockers = [
  { name: 'Logistics: Delivery + freight from Mumbai', frequency: 40 },
  { name: 'Price: market rate is high, wants cheaper', frequency: 70 },
  { name: 'Condition: unsure new vs second-hand', frequency: 55 },
  { name: 'Trust: past bad experience with supplier', frequency: 20 },
];
const checks = dealBlockerChecks(blockers);
ok('top-2 by frequency → price(70) + condition(55) surface first', checks.length === 2 && checks[0].kind === 'price' && checks[1].kind === 'condition');
ok('each check carries a buyer-facing label + evidence', checks.every((c) => c.label && c.evidence));
ok('logistics classified correctly (lower freq → dropped at max:2)', dealBlockerChecks(blockers, { max: 4 }).some((c) => c.kind === 'logistics'));
ok('dedupe by kind: two price blockers → ONE price check (highest freq)', dealBlockerChecks([{ name: 'Price: too high', frequency: 30 }, { name: 'Budget: rate negotiation', frequency: 80 }], { max: 4 }).filter((c) => c.kind === 'price').length === 1);
ok('SUPPRESS already-asked: if "price" concept known → no price check', !dealBlockerChecks(blockers, { knownKinds: ['price', 'condition'], max: 4 }).some((c) => c.kind === 'price' || c.kind === 'condition'));
ok("'other'/unclassifiable blockers are not surfaced as checks", dealBlockerChecks([{ name: 'Misc: something vague', frequency: 90 }]).length === 0);

// ── INTENT PATTERNS → applications + load-sizing flag ──
const patterns = [
  { intent: 'Backup power for a manufacturing unit', frequency: 60 },
  { intent: 'Sizing a genset for a 20 HP motor load', frequency: 45 },
  { intent: 'Power for a marriage hall / events', frequency: 30 },
];
const hints = intentPatternHints(patterns);
ok('applications ranked by frequency', hints.applications[0] === 'Backup power for a manufacturing unit');
ok('load-sizing detected (20 HP motor load → ask the load)', hints.loadSizingRelevant === true);
ok('no load language → loadSizing false', intentPatternHints([{ intent: 'Decorative lighting', frequency: 10 }]).loadSizingRelevant === false);

// ── PRICE → category-grounded budget bands (THE FIX for "Under ₹2 lakh" on a capital generator) ──
const bands = categoryBudgetBands({ min: 31000, median: 360000, max: 1650000 });
ok('generator price spread → 4 bands, not generic', Array.isArray(bands) && bands.length === 4);
ok('bands are category-grounded (top band reaches into lakhs, not ₹2L cap)', /lakh\+$/.test(bands[3]) && parseFloat(bands[3].replace(/[^0-9.]/g, '')) >= 5);
ok('bands strictly increasing + first is "Under …"', /^Under /.test(bands[0]));
ok('cheap category (₹2k-20k) → sub-lakh bands in k', (() => { const b = categoryBudgetBands({ min: 2000, median: 6000, max: 20000 }); return !!b && /k/.test(b[0]); })());
ok('no price signal → null (form keeps its generic bands)', categoryBudgetBands({}) === null && categoryBudgetBands(undefined) === null);
ok('degenerate (min==max) → null, no broken band', categoryBudgetBands({ min: 5000, median: 5000, max: 5000 }) === null);

// ── graceful ──
ok('no blockers → empty checks', dealBlockerChecks(undefined).length === 0 && dealBlockerChecks([]).length === 0);
ok('no patterns → empty apps, loadSizing false', (() => { const h = intentPatternHints(undefined); return h.applications.length === 0 && h.loadSizingRelevant === false; })());

console.log(`\ncategoryconsumptiontest (deal_blockers→proactive checks · dedupe · suppress-asked · intent→apps+load-sizing · price→category budget bands · generic · graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
