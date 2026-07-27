// ─── RFQ special-case demo GLIDs ─────────────────────────────────────────────
// Curated from the 100 audited buyers (engine + reasoning). One tap loads each scenario.
// `instant` GLIDs have an offline fixture (render immediately); others fetch live (~50s,
// heavy buyers fall back to bi-buyer-brain direct). Full 4-5-per-case sets live in
// ~/Downloads/RFQ-USECASE-GLIDS.md.
export interface UseCase { label: string; glid: string; note: string; instant?: boolean }

export const USE_CASES: UseCase[] = [
  { label: 'Conflict (500L vs 1000L)', glid: '140092812', instant: true, note: 'call says 500L, viewed 1000L — A/B resolver' },
  { label: 'Project / factory setup', glid: '106815489', instant: true, note: 'GST-verified — packaging line, 6 related needs' },
  { label: 'B2C / discreet', glid: '244092512', instant: true, note: 'personal, KYB-free, quiet flow' },
  { label: 'Repost (heavy, all expired)', glid: '268590579', note: 'Jaiveer — notebook-unit setup, no GST (fallback)' },
  { label: 'GST unlock (business, no GST)', glid: '114449705', note: 'Hotel Hill View — offer GST for wholesale' },
  { label: 'Mixed (active + expired)', glid: '12268156', note: 'Nalanda Mobile Store — enrich + repost' },
  { label: 'Wrong-category risk', glid: '154357970', note: 'latest-search would misroute' },
  { label: 'No category brain', glid: '271739981', note: 'niche mcat — non-spec questions only' },
  { label: 'Noise-suppressed', glid: '131410806', note: 'junk profile fields hidden, logged' },
  { label: 'Multi-need chooser', glid: '42049584', note: 'gift-hamper / packaging — two live needs' },
];
