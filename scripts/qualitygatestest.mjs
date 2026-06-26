// Deterministic test for the quality gates — mirrors src/lib/qualityGates.ts (ported from bl_quality).
// PII/GSTIN regex · selling-intent · product-name quality · absurd-quantity · price parser · POV. NO LLM.

const PII = { mobileCC: /\+91[\s-]?[6-9]\d{9}/, mobile: /\b0?[6-9]\d{9}\b/, email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, gstin: /\b\d{2}[a-z]{5}\d{4}[a-z][a-z0-9]z[a-z0-9]\b/i, card: /\b(?:\d[\s-]*?){13,16}\b/ };
function detectPII(text) { const t = String(text || ''); const kinds = []; if (PII.mobileCC.test(t) || PII.mobile.test(t)) kinds.push('mobile'); if (PII.email.test(t)) kinds.push('email'); if (PII.gstin.test(t)) kinds.push('gstin'); if (PII.card.test(t)) kinds.push('card'); if (/facebook|linkedin|instagram/i.test(t)) kinds.push('social'); return { found: kinds.length > 0, kinds }; }
function extractGSTIN(text) { const m = String(text || '').toUpperCase().match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/); return m ? m[0] : null; }
const SELLING_KEYWORDS = ['i want to sale', 'available for sale', 'we manufacture', 'we deal in', 'we are manufacturers of', 'bulk quantity ready for dispatch'];
function looksLikeSeller(text) { const t = String(text || '').toLowerCase(); return SELLING_KEYWORDS.some((kw) => t.includes(kw)); }
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
function productNameQuality(name, category = '') { const n = String(name || '').trim(); const wc = words(n).length; if (wc === 0) return { issue: 'trivial' }; if (category && n.toLowerCase() === category.toLowerCase()) return { issue: 'matches-category' }; if (wc === 1) return { issue: 'one-word' }; if (wc < 3 && !category) return { issue: 'trivial' }; return { issue: null }; }
const MULT = { lakh: 1e5, lac: 1e5, crore: 1e7, cr: 1e7 };
function parsePriceINR(s) { if (!s || !String(s).trim()) return null; const m = String(s).match(/[₹Rs.\s]*([\d,.]+)\s*(lakh|lac|crore|cr)?/i); if (!m) return null; const v = parseFloat(m[1].replace(/,/g, '')); if (!Number.isFinite(v)) return null; return v * (MULT[(m[2] || '').toLowerCase()] || 1); }
const ABSURD_QTY_THRESHOLD = 1000;
function absurdQuantity(i) { const q = Number(i.quantity) || 0; const reasons = []; if (q <= ABSURD_QTY_THRESHOLD) return { absurd: false, reasons: [] }; if (Math.trunc(q) % 10 !== 0) reasons.push('non-round'); for (const p of i.productPrices || []) { const parsed = parsePriceINR(String(p)); if (parsed != null && Math.trunc(parsed) === Math.trunc(q)) { reasons.push('matches a product price'); break; } } if (i.mcatQ1 && i.mcatQ3 && i.mcatQ1 > ABSURD_QTY_THRESHOLD && q >= i.mcatQ1 && q <= i.mcatQ3 && !i.gstOnFile && !i.companyOnFile) reasons.push('within category price band'); return { absurd: reasons.length > 0, reasons }; }
function orderValue(quantity, median) { const q = Number(quantity) || 0; return { pov: q * (Number(median) || 0), heavyCheck: q >= ABSURD_QTY_THRESHOLD }; }

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// PII
ok('PII: mobile detected', detectPII('call me at 9876543210').kinds.includes('mobile'));
ok('PII: +91 mobile detected', detectPII('+91 9876543210').kinds.includes('mobile'));
ok('PII: email detected', detectPII('mail jay@x.com').kinds.includes('email'));
ok('PII: GSTIN detected', detectPII('gst 09ABCDE1234F1Z5 hai').kinds.includes('gstin'));
ok('PII: social detected', detectPII('see facebook.com/abc').kinds.includes('social'));
ok('PII: clean text → none', detectPII('need 5 kVA diesel generator').found === false);
// GSTIN extract (usable fact, not just scrub)
ok('GSTIN extract returns the gstin', extractGSTIN('my gst is 09ABCDE1234F1Z5') === '09ABCDE1234F1Z5');
ok('GSTIN extract null when absent', extractGSTIN('no gst here') === null);
// selling intent
ok('seller: "we manufacture" flagged', looksLikeSeller('we manufacture diesel gensets') === true);
ok('buyer: "need a generator" not flagged', looksLikeSeller('need a 5 kVA generator') === false);
// product-name quality
ok('name: one word flagged', productNameQuality('machine').issue === 'one-word');
ok('name: == category flagged', productNameQuality('Generator', 'Generator').issue === 'matches-category');
ok('name: good 3-word ok', productNameQuality('5 kVA diesel generator').issue === null);
// price parser
ok('price parse ₹ 8 Lakh → 800000', parsePriceINR('₹ 8 Lakh / Piece') === 800000);
ok('price parse ₹ 1.45 Crore → 14500000', parsePriceINR('₹ 1.45 Crore') === 14500000);
ok('price parse ₹ 200 → 200', parsePriceINR('₹ 200 / Kg') === 200);
// absurd quantity
ok('qty ≤1000 never absurd', absurdQuantity({ quantity: 500 }).absurd === false);
ok('qty non-round 43869 → absurd', absurdQuantity({ quantity: 43869 }).absurd === true);
ok('qty 800000 matches a viewed price → absurd', absurdQuantity({ quantity: 800000, productPrices: ['₹ 8 Lakh / Piece'] }).absurd === true);
ok('qty 10000 round, no price match → not absurd', absurdQuantity({ quantity: 10000 }).absurd === false);
ok('qty within MCAT IQR + no GST/company → absurd', absurdQuantity({ quantity: 16000, mcatQ1: 12000, mcatQ3: 20000, gstOnFile: false, companyOnFile: false }).absurd === true);
ok('qty within IQR but GST on file → not flagged by rule 3', absurdQuantity({ quantity: 16000, mcatQ1: 12000, mcatQ3: 20000, gstOnFile: true }).reasons.every((r) => r !== 'within category price band'));
// POV
ok('POV = qty × median; heavy when ≥1000', orderValue(50, 16000).pov === 800000 && orderValue(50, 16000).heavyCheck === false && orderValue(2000, 100).heavyCheck === true);

console.log(`\nqualitygatestest (bl_quality port · PII/GSTIN regex · selling-intent · product-name quality · absurd-quantity 3 rules · ₹-lakh/crore parser · POV): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
