// ─── CATEGORY CONFIDENCE — "how much should we trust this category's intelligence?" ───────────
// The Antique-Door (0 calls → empty) vs Diesel-Generator (76 calls → rich) split proved the RFQ
// needs a first-class signal that decides: consume the category heavily, lean on it lightly, or
// IGNORE it and fall back to buyer-only reasoning. This is the gate that must exist BEFORE any
// buyer×category fusion — otherwise fusion multiplies mediocre/empty intelligence on long-tail
// categories.
//
// Scored from STRUCTURAL facts (call volume, critical-spec count + freq + ISQ mapping, intent
// patterns, deal blockers, price spread) — NOT the distill's self-reported `confidence`, which is
// miscalibrated (Diesel self-reported 4/100 while being objectively rich). Pure · deterministic · NO LLM.

export interface CategoryPayload {
  critical_specs?: Array<{ name?: string; seller_frequency?: number | null; maps_to_isq?: string }>;
  intent_patterns?: Array<unknown>;
  deal_blockers?: Array<unknown>;
  price_distribution_inr?: { min?: number; median?: number; max?: number } | null;
  calls_analyzed?: number;
  [k: string]: unknown;
}

export type CategoryBand = 'rich' | 'thin' | 'empty';
export interface CategoryConfidence {
  score: number;          // 0-100 — how trustworthy/complete this category's intelligence is
  band: CategoryBand;     // rich (consume + fuse) · thin (consume, no fuse) · empty (ignore → buyer-only)
  consume: boolean;       // band !== 'empty' — may the form use category signals at all?
  fuse: boolean;          // band === 'rich' — may buyer×category fusion drive question framing?
  signals: {              // the components, for the debug trace
    calls: number; criticals: number; criticalsWithFreq: number; criticalsMapped: number;
    intents: number; blockers: number; priceUsable: boolean;
  };
  reason: string;         // one-line human explanation
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);

export function categoryConfidence(payload: CategoryPayload | null | undefined): CategoryConfidence {
  const ci = payload || {};
  const cs = Array.isArray(ci.critical_specs) ? ci.critical_specs.filter((c) => c && (c.name || c.maps_to_isq)) : [];
  // Distinguish "explicitly 0 calls" (genuine no-data → empty) from "calls field absent" (older/partial
  // cache → don't penalise; rely on the criticals). callsKnown===false ⇒ calls treated as unknown (−1).
  const callsKnown = typeof ci.calls_analyzed === 'number';
  const calls = callsKnown ? num(ci.calls_analyzed) : -1;
  const criticalsWithFreq = cs.filter((c) => num(c.seller_frequency) > 0).length;
  const criticalsMapped = cs.filter((c) => c.maps_to_isq && String(c.maps_to_isq).trim()).length;
  const intents = Array.isArray(ci.intent_patterns) ? ci.intent_patterns.length : 0;
  const blockers = Array.isArray(ci.deal_blockers) ? ci.deal_blockers.length : 0;
  const p = ci.price_distribution_inr;
  const priceUsable = !!p && num(p.max) > 0 && num(p.max) > num(p.min);
  const signals = { calls: Math.max(calls, 0), criticals: cs.length, criticalsWithFreq, criticalsMapped, intents, blockers, priceUsable };

  // EMPTY — nothing to consume. No critical_specs at all, OR an EXPLICIT 0 calls (the Antique-Door
  // case: the category built but had no evidence base). A missing calls field (calls === -1) is NOT
  // empty — we trust the criticals and just forgo the call-volume bonus. Buyer-only from here.
  if (cs.length === 0 || calls === 0) {
    return { score: 0, band: 'empty', consume: false, fuse: false, signals, reason: cs.length === 0 ? 'no critical_specs — category empty' : 'no PNS calls — category empty' };
  }

  // Weighted structural score (max 100). critical_specs dominate; the rest are completeness bonuses.
  const criticalScore = (Math.min(cs.length, 8) / 8) * 35;
  const freqScore = (criticalsWithFreq / cs.length) * 15;
  const isqScore = (criticalsMapped / cs.length) * 15;
  const intentScore = (Math.min(intents, 5) / 5) * 10;
  const blockerScore = (Math.min(blockers, 4) / 4) * 10;
  const priceScore = priceUsable ? 10 : 0;
  const callsScore = (Math.min(Math.max(calls, 0), 30) / 30) * 5; // unknown calls (−1) → 0 bonus, not a penalty
  const score = Math.round(criticalScore + freqScore + isqScore + intentScore + blockerScore + priceScore + callsScore);

  const band: CategoryBand = score >= 65 ? 'rich' : score >= 30 ? 'thin' : 'empty';
  const reason = `${cs.length} criticals (${criticalsMapped} ISQ-mapped) · ${intents} intents · ${blockers} blockers · ${priceUsable ? 'price✓' : 'no price'} · ${calls} calls`;
  return { score, band, consume: band !== 'empty', fuse: band === 'rich', signals, reason };
}

// Compact debug line.
export function categoryConfidenceLine(c: CategoryConfidence): string {
  return `category confidence ${c.score}/100 · ${c.band.toUpperCase()} → ${c.fuse ? 'consume + fuse' : c.consume ? 'consume (no fuse)' : 'IGNORE (buyer-only)'} · ${c.reason}`;
}
