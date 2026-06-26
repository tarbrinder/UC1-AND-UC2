// Deterministic test for attributeLineage.ts (logic replicated in JS, per convention). Proves the winner is the
// most-authoritative CITED source, supporters are the rest, conflicts come from reasoning_steps.rejected, and
// deterministic attrs (no llm) are labelled as such. NO LLM, NO fetch. `node scripts/attrlineagetest.mjs`.

const RANK = [[/PNS/i, 6], [/WhatsApp/i, 5], [/Identity|Profile/i, 4], [/external|Befisc|Sign3/i, 4], [/GST/i, 4], [/Requirement|BuyLead|ISQ/i, 3], [/CSL/i, 2]];
const rank = (l) => { for (const [re, n] of RANK) if (re.test(l)) return n; return 1; };
const short = (l) => String(l || '').split(/[·(⊕]/)[0].trim();
function attributeLineage(f, resolveNode) {
  const steps = f.llm?.reasoning || []; const ids = []; const nodes = new Set(); const conflicts = new Set();
  for (const s of steps) { for (const id of (s.evidence || [])) { ids.push(id); const n = resolveNode(id); if (n) nodes.add(short(n)); } if (s.rejected) conflicts.add(String(s.rejected)); }
  const ranked = [...nodes].sort((a, b) => rank(b) - rank(a));
  return { question: f.label, finalValue: f.value, confidence: f.confidence, provenance: f.llm ? 'llm' : 'deterministic', winningSource: ranked[0] || (f.llm ? 'LLM (no cited source)' : 'deterministic (single source)'), supportingSources: ranked.slice(1), conflictingSources: [...conflicts], evidenceIds: [...new Set(ids)], llmDecision: steps[0]?.claim || f.value, grounded: f.llm?.grounded !== false };
}

const resolve = (id) => ({ f57: 'PNS · sales calls (spoken)', f7: 'Requirement · BuyLeads + answered-ISQ pool', f6: 'CSL · on-site behaviour' }[id]);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } };

// the Jaiveer persona case: PNS persona wins over Requirement + CSL supporters; "Entrepreneur" was the ruled-out alt
{
  const f = { label: 'Buyer Persona', value: 'Manufacturer · Paper & Notebook', confidence: 91, llm: { grounded: true, reasoning: [
    { claim: "PNS explicitly identifies persona 'Manufacturer'", evidence: ['f57'], rejected: 'Entrepreneur (call 4 — setting up a unit)' },
    { claim: 'BuyLeads + CSL cluster on notebook/paper', evidence: ['f7', 'f6'] },
  ] } };
  const lin = attributeLineage(f, resolve);
  ok('winner = PNS (most authoritative cited)', lin.winningSource === 'PNS');
  ok('supporters = Requirement + CSL (short labels)', lin.supportingSources.includes('Requirement') && lin.supportingSources.includes('CSL'));
  ok('conflict captured from rejected', lin.conflictingSources.some((c) => /Entrepreneur/.test(c)));
  ok('provenance llm · grounded', lin.provenance === 'llm' && lin.grounded === true);
  ok('evidence ids deduped', lin.evidenceIds.length === 3);
}
// deterministic attr (no llm) → labelled deterministic
{
  const lin = attributeLineage({ label: 'PAN entity', value: 'Individual', confidence: 100 }, resolve);
  ok('deterministic attr → provenance deterministic', lin.provenance === 'deterministic' && /single source/.test(lin.winningSource));
}

console.log(`\nattribute-lineage harness: ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
