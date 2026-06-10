// ─── Inference Governance Layer (the Golden Rule, ENFORCED) ───────────────────
// THE keystone. Both pilot cases (notebook→LED, tyre/personal-1000) showed two failure modes:
//   1. attributes rendered as FACT with no evidence (comms "WhatsApp-first 75%" when WA affinity = ?)
//   2. strong signals (income, website, location) sitting UNUSED in debug
// Both violate the Golden Rule: every attribute must carry {value, confidence, evidence, source} and,
// if any is missing, DO NOT CONSUME. This module is the single gate every buyer attribute passes
// through before it can show or drive. It collapses confidence into FOUR buyer-facing states so the
// CEO view and the form speak one language.

export type AttrState = 'Confirmed' | 'Likely' | 'Weak' | 'Unknown' | 'Contradicted';

// Confidence → state. FIVE bands (ChatGPT's anti-over-correction note): don't jump 41% straight to
// "Unknown" or the Twin looks dumb. ≥80 Confirmed · 60-79 Likely · 40-59 Weak signal · <40 Unknown.
export const GOV_THRESHOLD = { confirmed: 80, likely: 60, weak: 40 } as const;

export interface GovernInput {
  value?: string;
  confidence?: number;       // 0-100
  source?: string;
  evidence?: string[];
  hasEvidence?: boolean;     // explicit override: false ⇒ force Unknown even at high confidence
  contradicted?: boolean;    // set by the Contradiction engine — sources disagree
  userOrVerified?: boolean;  // buyer-stated OR 3-source Verified ⇒ Confirmed regardless of the number
}
export interface GovernedAttr {
  value: string;             // 'Unknown' when not evidenced
  state: AttrState;
  confidence: number;
  source: string;
  evidence: string[];
}

// The gate. Anti-hallucination: no value / no evidence / below the floor ⇒ Unknown (never a guess).
export function govern(i: GovernInput): GovernedAttr {
  const evidence = (i.evidence || []).filter(Boolean);
  const value = (i.value || '').trim();
  const conf = Math.max(0, Math.min(100, Math.round(i.confidence || 0)));
  const hasEv = i.hasEvidence !== undefined ? i.hasEvidence : evidence.length > 0;
  if (i.contradicted) return { value: value || 'Unknown', state: 'Contradicted', confidence: conf, source: i.source || '—', evidence };
  // Golden Rule floor: no value / no evidence / below the WEAK floor (40) ⇒ Unknown (never a guess).
  if (!value || !hasEv || conf < GOV_THRESHOLD.weak) return { value: 'Unknown', state: 'Unknown', confidence: 0, source: '—', evidence };
  const state: AttrState =
    i.userOrVerified || conf >= GOV_THRESHOLD.confirmed ? 'Confirmed'
      : conf >= GOV_THRESHOLD.likely ? 'Likely'
        : 'Weak';
  return { value, state, confidence: conf, source: i.source || '—', evidence };
}

// Source weighting (PNS > ISQ > BL > WA > CSL): a lone weak source (e.g. CSL-only, the tyre case)
// must NOT masquerade as high confidence. Used when composing a multi-source confidence.
export const SOURCE_WEIGHT: Record<string, number> = {
  PNS: 1.0, ISQ: 0.9, BL: 0.8, History: 0.8, Profile: 0.85,
  WhatsApp: 0.6, WA: 0.6, CSL: 0.4, External: 0.7, Twin: 0.7, User: 1.0,
};
export function weightedConfidence(parts: Array<{ source: string; conf: number }>): number {
  const ps = parts.filter((p) => (p.conf || 0) > 0);
  if (!ps.length) return 0;
  let num = 0, den = 0, maxW = 0;
  for (const p of ps) { const w = SOURCE_WEIGHT[p.source] ?? 0.5; num += w * Math.max(0, Math.min(100, p.conf)); den += w; if (w > maxW) maxW = w; }
  // Weighted average, then SCALED by the strongest source present — so a lone weak source (CSL 0.4)
  // can never reach high confidence on its own, while a PNS/ISQ-backed mix keeps its strength.
  return den ? Math.round((num / den) * maxW) : 0;
}

// Tiny helper for the CEO view: the icon for a state.
export const STATE_ICON: Record<AttrState, string> = { Confirmed: '✓', Likely: '~', Weak: '◦', Unknown: '?', Contradicted: '⚠' };

// N5 — garbage / keyboard-mash detector. The tyre buyer's company_desc was "okmkml,jguhhvgbnubuy…";
// it must NOT become "evidence". Structural only (no dictionary, no category list): a giant unbroken
// token, or a long consonant-soup with almost no vowels, is gibberish. Real names/descriptions pass.
export function looksLikeGibberish(s?: string | null): boolean {
  const t = (s || '').trim();
  if (t.length < 12) return false; // short strings are absent/odd, not "gibberish evidence"
  const longestToken = t.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
  if (longestToken >= 22) return true; // one enormous unbroken run = keyboard mash
  const letters = t.replace(/[^a-zA-Z]/g, '');
  const vowels = (t.match(/[aeiouAEIOU]/g) || []).length;
  const vowelRatio = letters.length ? vowels / letters.length : 1;
  return letters.length >= 18 && vowelRatio < 0.22; // long consonant soup
}
// Use this when a free-text field feeds an attribute as evidence — returns '' for gibberish.
export function cleanEvidence(s?: string | null): string {
  return looksLikeGibberish(s) ? '' : (s || '');
}
