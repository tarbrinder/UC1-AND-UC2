// ─── MCAT SANITY (fly-ash class) ────────────────────────────────────────────────
// First-layer, deterministic guard for the "product resolved to a WRONG category" defect (owner #65). The resolver
// takes the suggestion API's suggestion[0] blindly; when the committed product name shares NO meaningful word with the
// resolved mcat_name AND no independent signal corrected it, the match is probably wrong (e.g. "fly ash" → "Concrete
// Admixture"). We only ever SURFACE a soft "right category?" nudge — never auto-change (fabrication firewall).
//
// Mirrors the CONSERVATIVE contract of the production title_mcat_mismatch.py: do NOT flag when the title is a sub-type,
// variant, brand or model of the category — only a clear, zero-overlap mismatch. Exact TOKEN match only (never substring
// — "ash" ⊄ "washing"; that containment class has bitten this repo repeatedly), with light plural tolerance.
//
// KNOWN LIMIT: a SEMANTIC mismatch that still shares a word ("BOPP tape" → "Boob Tape") or a brand/model-only name with
// no category word ("Kirloskar 5kVA" → "Diesel Generator") is out of scope here — those need the LLM layer (a port of
// title_mcat_mismatch.py's prompt). This deterministic pass catches the common zero-overlap case at zero cost/latency.

const STOP = new Set([
  'for', 'and', 'the', 'with', 'type', 'grade', 'of', 'in', 'a', 'an', 'material', 'product', 'products',
  'item', 'items', 'new', 'used', 'high', 'low', 'buy', 'sell', 'best', 'price', 'set', 'kit', 'pcs',
  'piece', 'pieces', 'quality', 'other', 'others',
]);

const norm = (t: string): string => t.replace(/s$/, '');   // light plural fold: bar/bars, tape/tapes

const toks = (s: string): string[] =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((t) => t.length >= 3 && !STOP.has(t));

/**
 * True when the product name plausibly belongs to the mcat_name (shares at least one meaningful token, plural-tolerant).
 * Conservative: with too little signal (empty tokens on either side) it returns plausible=true — never flag on thin input.
 */
export function mcatPlausible(productName: string, mcatName: string): { plausible: boolean; reason: string } {
  const p = toks(productName);
  const m = toks(mcatName);
  if (!p.length || !m.length) return { plausible: true, reason: 'insufficient tokens to judge' };
  const mSet = new Set(m.map(norm));
  const overlap = p.some((t) => mSet.has(norm(t)));
  if (overlap) return { plausible: true, reason: 'product shares a word with the category' };
  return { plausible: false, reason: `“${productName.trim()}” shares no word with category “${mcatName.trim()}”` };
}
