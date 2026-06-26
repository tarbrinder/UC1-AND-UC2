// ─── PNS CALL CARDS (Wave 2B) — flat per-call facts → a readable call card ─────────────────────────────
// The flat "call 1 · persona · call 1 · intent · call 1 · product …" list is machine-friendly, not human-
// friendly. This groups the PNS facts by their call (lineRef) into a card a HOD reads in seconds: persona ·
// summary · need · objections · questions asked · products · signals · transcript-drill. PURE · no LLM.
// Harnessed in scripts/pnstest.mjs.

import type { Ledger, Fact } from './ledger';

export interface PnsSignal { label: string; value: string }
export interface PnsCall {
  call: string; persona?: string; application?: string; intent?: string; orderType?: string; qtyScale?: string; language?: string;
  summary?: string; products: string[]; questions: string[]; blockers: string[]; signals: PnsSignal[]; raw: Fact[];
}

export function buildPnsCards(L: Ledger): PnsCall[] {
  const pns = L.facts.filter((f) => f.sourceNode === 'pns-insights');
  if (!pns.length) return [];
  // group by call (lineRef "call 1"…), preserving first-seen order
  const order: string[] = []; const byCall = new Map<string, Fact[]>();
  for (const f of pns) { const c = f.lineRef || 'call ?'; if (!byCall.has(c)) { byCall.set(c, []); order.push(c); } byCall.get(c)!.push(f); }
  const first = (fs: Fact[], tag: string) => fs.find((f) => f.tag === tag)?.rawValue;
  const allOf = (fs: Fact[], tag: string) => [...new Set(fs.filter((f) => f.tag === tag).map((f) => f.rawValue))];
  return order.map((c) => {
    const fs = byCall.get(c)!;
    const persona = first(fs, 'pns.persona'); const application = first(fs, 'pns.application'); const intent = first(fs, 'pns.intent_level');
    const orderType = first(fs, 'pns.order_type'); const qtyScale = first(fs, 'pns.qty_scale'); const language = first(fs, 'pns.language');
    const summary = first(fs, 'pns.narrative');
    const signals: PnsSignal[] = [];
    if (persona) signals.push({ label: 'Persona', value: persona });
    if (orderType) signals.push({ label: 'Order', value: orderType });
    if (qtyScale) signals.push({ label: 'Scale', value: qtyScale });
    if (intent) signals.push({ label: 'Intent', value: intent });
    return { call: c, persona, application, intent, orderType, qtyScale, language, summary, products: allOf(fs, 'pns.product'), questions: allOf(fs, 'pns.seller_q'), blockers: allOf(fs, 'pns.blocker'), signals, raw: fs };
  });
}
