// Contract test for the Inference Governance Layer — mirrors src/lib/governance.ts (repo harness
// pattern). Proves the Golden Rule is ENFORCED: no value/evidence ⇒ Unknown (never a guess);
// confidence maps to the 4 states; source weighting stops a lone weak source (CSL) faking confidence.

const GOV_THRESHOLD = { confirmed: 80, likely: 60, weak: 40 };
function govern(i) {
  const evidence = (i.evidence || []).filter(Boolean);
  const value = (i.value || '').trim();
  const conf = Math.max(0, Math.min(100, Math.round(i.confidence || 0)));
  const hasEv = i.hasEvidence !== undefined ? i.hasEvidence : evidence.length > 0;
  if (i.contradicted) return { value: value || 'Unknown', state: 'Contradicted', confidence: conf, source: i.source || '—', evidence };
  if (!value || !hasEv || conf < GOV_THRESHOLD.weak) return { value: 'Unknown', state: 'Unknown', confidence: 0, source: '—', evidence };
  const state = i.userOrVerified || conf >= GOV_THRESHOLD.confirmed ? 'Confirmed' : conf >= GOV_THRESHOLD.likely ? 'Likely' : 'Weak';
  return { value, state, confidence: conf, source: i.source || '—', evidence };
}
const SOURCE_WEIGHT = { PNS: 1.0, ISQ: 0.9, BL: 0.8, History: 0.8, Profile: 0.85, WhatsApp: 0.6, WA: 0.6, CSL: 0.4, External: 0.7, Twin: 0.7, User: 1.0 };
function weightedConfidence(parts) {
  const ps = parts.filter((p) => (p.conf || 0) > 0);
  if (!ps.length) return 0;
  let num = 0, den = 0, maxW = 0;
  for (const p of ps) { const w = SOURCE_WEIGHT[p.source] ?? 0.5; num += w * Math.max(0, Math.min(100, p.conf)); den += w; if (w > maxW) maxW = w; }
  return den ? Math.round((num / den) * maxW) : 0;
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the headline anti-hallucination cases (the tyre buyer's bad deductions) ──
ok('no evidence ⇒ Unknown (kills "WhatsApp-first 75%" with WA affinity=?)', govern({ value: 'WhatsApp-first', confidence: 75, evidence: [] }).state === 'Unknown');
ok('Unknown blanks the value (never renders a guess)', govern({ value: 'WhatsApp-first', confidence: 75, evidence: [] }).value === 'Unknown');
ok('hasEvidence=false forces Unknown even at high confidence', govern({ value: 'Self-sufficient', confidence: 90, evidence: ['x'], hasEvidence: false }).state === 'Unknown');
ok('below the weak floor (conf 30) ⇒ Unknown', govern({ value: 'Low', confidence: 30, evidence: ['scale'] }).state === 'Unknown');

// ── the four states ──
ok('User-stated ⇒ Confirmed regardless of number', govern({ value: 'Manufacturer', confidence: 50, source: 'User', evidence: ['picked'], userOrVerified: true }).state === 'Confirmed');
ok('confidence ≥80 + evidence ⇒ Confirmed', govern({ value: 'Academic', confidence: 95, evidence: ['iitk.ac.in'] }).state === 'Confirmed');
ok('confidence 60-79 + evidence ⇒ Likely', govern({ value: 'Regional', confidence: 70, evidence: ['Auraiya'] }).state === 'Likely');
ok('anti-over-correction: conf 50 ⇒ Weak (NOT Unknown — the Twin must not look dumb)', govern({ value: 'Some scale', confidence: 50, evidence: ['BL volume'] }).state === 'Weak');
ok('contradicted flag ⇒ Contradicted (keeps the value to show the clash)', govern({ value: 'personal', confidence: 90, evidence: ['x'], contradicted: true }).state === 'Contradicted');
ok('Likely keeps its real value + confidence', (() => { const g = govern({ value: 'Regional', confidence: 70, source: 'Twin', evidence: ['Auraiya'] }); return g.value === 'Regional' && g.confidence === 70 && g.source === 'Twin'; })());
ok('exactly at confirmed threshold (80) ⇒ Confirmed', govern({ value: 'x', confidence: 80, evidence: ['e'] }).state === 'Confirmed');
ok('exactly at likely threshold (60) ⇒ Likely', govern({ value: 'x', confidence: 60, evidence: ['e'] }).state === 'Likely');
ok('exactly at weak floor (40) ⇒ Weak', govern({ value: 'x', confidence: 40, evidence: ['e'] }).state === 'Weak');
ok('just below weak floor (39) ⇒ Unknown', govern({ value: 'x', confidence: 39, evidence: ['e'] }).state === 'Unknown');

// ── source weighting: a lone CSL signal can't fake confidence (the tyre case: CSL 73%) ──
ok('CSL-only confidence is down-weighted vs PNS-only', weightedConfidence([{ source: 'CSL', conf: 80 }]) < weightedConfidence([{ source: 'PNS', conf: 80 }]));
ok('PNS dominates a PNS+CSL mix', (() => { const w = weightedConfidence([{ source: 'PNS', conf: 90 }, { source: 'CSL', conf: 10 }]); return w > 55; })());
ok('empty parts ⇒ 0', weightedConfidence([]) === 0);
ok('zero-confidence parts ignored', weightedConfidence([{ source: 'PNS', conf: 0 }]) === 0);
ok('weighting order PNS>ISQ>BL>WA>CSL holds', SOURCE_WEIGHT.PNS > SOURCE_WEIGHT.ISQ && SOURCE_WEIGHT.ISQ > SOURCE_WEIGHT.BL && SOURCE_WEIGHT.BL > SOURCE_WEIGHT.WA && SOURCE_WEIGHT.WA > SOURCE_WEIGHT.CSL);

// ── N5 garbage / keyboard-mash detector (the tyre buyer's company_desc) ──
function looksLikeGibberish(s) {
  const t = (s || '').trim();
  if (t.length < 12) return false;
  const longestToken = t.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
  if (longestToken >= 22) return true;
  const letters = t.replace(/[^a-zA-Z]/g, '');
  const vowels = (t.match(/[aeiouAEIOU]/g) || []).length;
  const vowelRatio = letters.length ? vowels / letters.length : 1;
  return letters.length >= 18 && vowelRatio < 0.22;
}
ok('N5: the tyre buyer mash → gibberish', looksLikeGibberish('okmkml,jguhhvgbnubuybuhbyvygjhbjbyygbjb hjyvygvyyvvgjihuin hbuugiyvgvvgvgbb8i7ygytvvggvuiphyggyvgkhvjgggvgvgvv'));
ok('N5: long unbroken token → gibberish', looksLikeGibberish('asdfghjklqwertyuiopzxcvbnm'));
ok('N5: real company name passes', !looksLikeGibberish('Tyresnmore Online Private Limited'));
ok('N5: real description passes', !looksLikeGibberish('Manufacturer of exercise notebooks and writing paper'));
ok('N5: "IIT Kanpur" passes', !looksLikeGibberish('IIT Kanpur'));
ok('N5: empty/short is NOT flagged (absent, not gibberish)', !looksLikeGibberish('') && !looksLikeGibberish('Auraiya'));

console.log(`\ngovernancetest (Golden Rule enforced · 4 states · no-evidence⇒Unknown · source weighting · N5 gibberish): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
