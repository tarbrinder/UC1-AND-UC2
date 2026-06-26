// ─── PROVENANCE PARTITION — what the BUYER said vs what IndiaMART fabricated / sent ───────────────────────────
// The rule (user-locked): only what the BUYER originated feeds inference — what they SAID / SEARCHED / ANSWERED,
// and the buyer's OWN WhatsApp messages / replies (wa-in · either of the two channels). CONTEXT-ONLY
// (platform_generated · shown so the LLM can INTERPRET the buyer's reply, but NEVER cited as buyer intent, never
// carried into a deduction or a corrected offer): OUR WhatsApp messages (wa-out — seller shares / marketing; a
// seller name + location WE sent ≠ the buyer wants it — only the buyer's reaction is signal), sellers WE matchmade,
// specs WE deduced (Probable Order Value / Requirement Type). WhatsApp is split by SENDER, not channel (both the
// inbound-9696 and outbound channels carry the buyer's messages AND ours). One classifier, every block. NO hardcoding.

import type { Fact, Ledger } from './ledger';

export type Origin = 'buyer_originated' | 'platform_generated';
export interface FactOrigin { origin: Origin; reason: string }

// A spec the PLATFORM deduced rather than the buyer answered — IndiaMART derives these from behaviour; the buyer
// never typed them. Generic phrase match (no product/category terms); mirrors the n8n E2 strip already in the UI.
export const PLATFORM_DEDUCED_RE = /probable order value|probable requirement type|requirement type\b|business use\b/i;
// matchmaking artifacts — sellers WE matched / recommended (the buyer never asked for them). Stays excluded.
const PLATFORM_TAG_RE = /match(?:ed)?[\s_-]*sellers?|sellers?[\s_-]*match|matchmak|recommend(?:ed)?[\s_-]*sellers?/i;

export function classifyFact(f: Fact): FactOrigin {
  if (PLATFORM_TAG_RE.test(f.tag) || PLATFORM_TAG_RE.test(f.rawValue)) return { origin: 'platform_generated', reason: 'matched seller — IndiaMART matchmade this; the buyer never asked for it' };
  if (/isq|spec/i.test(f.tag) && PLATFORM_DEDUCED_RE.test(f.rawValue)) return { origin: 'platform_generated', reason: 'platform-deduced spec — derived by IndiaMART, the buyer never stated it' };
  if (f.sourceNode === 'wa-out') return { origin: 'platform_generated', reason: 'OUR WhatsApp message (seller share / marketing) — context for reading the buyer reply, never buyer intent' };
  if (f.sourceNode === 'wa-in') return { origin: 'buyer_originated', reason: "the buyer's own WhatsApp message / reply — signal" };
  return { origin: 'buyer_originated', reason: `buyer signal · ${f.sourceNode}` };
}

// Cross-cutting CONFLICT-RESOLUTION order (user-locked) — when buyer signals DISAGREE, the higher one wins.
// Consumed verbatim by every enrichment prompt (profile twin · offer · requirement · RFQ form) so they resolve
// conflicts identically. The WhatsApp tier is the BUYER'S own replies (our messages are context, not in this
// race). External (Befisc/Sign3) stays first-class/never-discounted; this only orders ties.
export const SIGNAL_PRIORITY = "PNS call (spoken) > WhatsApp (the buyer's own messages / replies) > external identity (Befisc / Sign3) > on-site search (CSL) > prior requirement / past ISQ";

export interface Partition { buyer: Fact[]; platform: Fact[]; reasonById: Record<string, string>; originById: Record<string, Origin> }

export function partitionLedger(L: Ledger): Partition {
  const buyer: Fact[] = []; const platform: Fact[] = [];
  const reasonById: Record<string, string> = {}; const originById: Record<string, Origin> = {};
  for (const f of L.facts) {
    const { origin, reason } = classifyFact(f);
    reasonById[f.id] = reason; originById[f.id] = origin;
    (origin === 'platform_generated' ? platform : buyer).push(f);
  }
  return { buyer, platform, reasonById, originById };
}

// convenience for inference engines: ONLY the buyer-originated facts (the half that may feed a deduction).
export function buyerFacts(L: Ledger): Fact[] { return partitionLedger(L).buyer; }
export function isBuyerOriginated(f: Fact): boolean { return classifyFact(f).origin === 'buyer_originated'; }

export interface ProvenanceSummary { total: number; buyer: number; platform: number; platformReasons: string[] }
export function provenanceSummary(L: Ledger): ProvenanceSummary {
  const p = partitionLedger(L);
  return { total: L.facts.length, buyer: p.buyer.length, platform: p.platform.length, platformReasons: [...new Set(p.platform.map((f) => p.reasonById[f.id]))] };
}
