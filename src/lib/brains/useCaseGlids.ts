// ─── RFQ special-case demo GLIDs ─────────────────────────────────────────────
// Curated from the 100 audited buyers (engine + reasoning). One tap loads each scenario.
// `instant` GLIDs have an offline fixture (render immediately); others fetch live (~50s,
// heavy buyers fall back to bi-buyer-brain direct). Full 4-5-per-case sets live in
// ~/Downloads/RFQ-USECASE-GLIDS.md.
export interface UseCase { label: string; glid: string; note: string; instant?: boolean }

// ⚠️ NOTES RE-BASED 2026-08-01. Several described ENGINE-ERA behaviour that the 3-LLM rewrite retired, which made
// the scenario list actively misleading — the FIRST button advertised an "A/B resolver" whose UI is unreachable
// (`engineDecisions` is always empty on this flow), so the first thing anyone clicked promised a feature that
// cannot render. Notes now describe what the 3-LLM flow (LLM 1 brain → LLM 2 commercial → LLM 3 persona) actually
// does with each buyer. Keep them honest: a note is documentation, and a wrong one costs a debugging session.
export const USE_CASES: UseCase[] = [
  { label: 'Conflicting quantities', glid: '140092812', instant: true, note: 'call says 500L, viewed 1000L — LLM 1 must not silently pick one (A/B resolver UI is retired)' },
  { label: 'Project / factory setup', glid: '106815489', instant: true, note: 'GST-verified — packaging line, 6 related needs' },
  { label: 'B2C / discreet', glid: '244092512', instant: true, note: 'personal, KYB-free — persona page should stay individual, no GST' },
  { label: 'Repost (heavy, all expired)', glid: '268590579', note: 'Jaiveer — notebook-unit setup, no GST' },
  { label: 'GST unlock (business, no GST)', glid: '114449705', note: 'Hotel Hill View — GST asked on the persona page' },
  { label: 'Mixed (active + expired)', glid: '12268156', note: 'Nalanda Mobile Store — repost + fresh product' },
  { label: 'Wrong-category risk', glid: '154357970', note: 'latest-search would misroute — exercises the CSL-collision mcat swap' },
  { label: 'Category brain empty', glid: '271739981', note: 'niche mcat — LLM 2 gets no corpus, should fall back to own_knowledge' },
  { label: 'Noisy profile', glid: '131410806', note: 'junk profile fields — must not surface as detected specs' },
  { label: 'Multi-need chooser', glid: '42049584', note: 'gift-hamper / packaging — two live needs on the landing' },
];
