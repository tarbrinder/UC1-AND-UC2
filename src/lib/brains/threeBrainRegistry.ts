// ─── THREE-BRAIN REGISTRY ───────────────────────────────────────────────────────────────────────
// One uniform contract for the THREE intelligences that drive the RFQ journey: the BUYER brain (who they are,
// from the LLM-native extract twin), the CATEGORY brain (what this product class demands, from the category
// distill), and the RFQ brain (the requirement being composed). Built so that the moment Category-intelligence
// is plugged, all three align via a single deterministic join (`alignBrains`) → the per-question provenance
// chain that IS the RFQ journey. No new LLM calls here — pure adapters over artifacts the app already produces.
//
// Design notes:
// - IAttribute is the lowest common denominator the existing FinalAttr/ExtractAttr already satisfy — the buyer
//   brain is a near-passthrough; only CATEGORY needs lifting (today it carries seller_frequency only, no state).
// - Adapters read DEFENSIVELY (unknown-typed for category/rfq) so this module has no import cycle with the
//   form/category libs and stays unit-testable in isolation.
// - SUPPRESSION RULE (the load-bearing alignment decision): suppress an RFQ question ONLY when the buyer fact is
//   state==='Confirmed' AND fresher than the category distill — NEVER on a low-frequency (Unknown) category spec
//   alone. This is what stops the never-re-ask guardrail from silently dropping a real question.

import type { FinalAttr } from '../synthesisEngine';

export type BrainKind = 'buyer' | 'category' | 'rfq';
export type AttrState = 'Confirmed' | 'Likely' | 'Conflicted' | 'Unknown';
export type Freshness = 'Fresh' | 'Moderate' | 'Stale' | 'Unknown';

export interface IEvidence {
  source: string;            // n8n node name | 'derived' | 'category-distill'
  signal: string;            // the concrete observation
  confidence: number;        // 0-100
  date?: string;             // ISO/display, '' if undated
  stability?: number;        // 0-100 (consistency over time)
  contradictions_count?: number;
  last_seen?: string;
}
export interface IAttribute {
  key: string;
  label: string;
  value: string;
  state: AttrState;
  confidence: number;        // 0-100
  sources: string[];
  evidence: IEvidence[];     // >=1 whenever state !== 'Unknown'
  freshness: Freshness;
  stability?: number;
  contradictions_count?: number;
  reasoning: Array<{ claim: string; evidence: string[]; rejected?: string }>;
}
export interface IBrain {
  kind: BrainKind;
  id: string;                // glid | mcat_id | `${glid}:${mcat_id}:${session_id}`
  built_at: string;          // ISO
  version: number;
  attributes: IAttribute[];
  confidence_overall: number;
  explicit_unknowns: string[];
  explicit_negatives: string[];
  contradictions: Array<{ a: string; b: string; resolution?: string }>;
}
export interface IBuyerBrain extends IBrain {
  kind: 'buyer';
  anchors?: Record<string, unknown> | null;
  source_registry?: Record<string, Record<string, unknown>> | null;
  source_priority?: Record<string, unknown> | null;
}
export interface ICategoryBrain extends IBrain {
  kind: 'category';
  mcat_id: string;
  distill_date?: string;
}
export interface IRfqBrain extends IBrain {
  kind: 'rfq';
  ask: string[];             // questions still being asked
  known_dropped: Array<{ key: string; reason: string }>; // the guardrail audit trail
}
export interface ThreeBrainAlignment {
  built_at: string;
  provenance_chain: Array<{
    rfq_key: string;
    rfq_value?: string;
    buyer_evidence?: IAttribute;
    category_evidence?: IAttribute;
    reasoning: string;
    suppressed: boolean;
    suppression_reason?: string;
  }>;
  cross_brain_contradictions: Array<{ a: string; b: string; note: string }>;
  coverage: { rfq_keys: number; matched_buyer: number; matched_category: number; suppressed: number; orphaned: number };
}

// ── helpers ──
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const freshFromDays = (days: number | undefined): Freshness => (days == null || Number.isNaN(days)) ? 'Unknown' : days < 30 ? 'Fresh' : days < 90 ? 'Moderate' : 'Stale';
// state from a distill frequency band — documented as confidence-IN-DISTILL, not confidence-in-truth.
export function stateFromFrequency(freqPct: number): AttrState { return freqPct >= 80 ? 'Confirmed' : freqPct >= 50 ? 'Likely' : 'Unknown'; }
const stateRank: Record<AttrState, number> = { Unknown: 0, Conflicted: 1, Likely: 2, Confirmed: 3 };

// ── (A) BUYER BRAIN — near-passthrough from the extract twin's FinalAttr[] ──
export function buyerBrainFromFinals(
  finals: FinalAttr[],
  opts: { glid: string; nowIso: string; anchors?: Record<string, unknown> | null; source_registry?: Record<string, Record<string, unknown>> | null; source_priority?: Record<string, unknown> | null; evMap?: Map<string, { node: string; raw: string }> } = { glid: '', nowIso: '' },
): IBuyerBrain {
  const evMap = opts.evMap;
  const attributes: IAttribute[] = (finals || []).filter((f) => f && f.key).map((f) => {
    const reasoning = (f.llm?.reasoning || []).map((r) => ({ claim: r.claim, evidence: r.evidence || [], rejected: r.rejected }));
    const evidence: IEvidence[] = reasoning.flatMap((r) => (r.evidence || []).map((id) => {
      const e = evMap?.get(id);
      return { source: e?.node || 'derived', signal: e?.raw || id, confidence: f.confidence };
    }));
    const state: AttrState = f.state || (f.value && !/^(unknown|—|-|n\/?a|none)$/i.test(String(f.value).trim()) ? (f.confidence >= 70 ? 'Confirmed' : f.confidence >= 50 ? 'Likely' : 'Unknown') : 'Unknown');
    return { key: f.key, label: f.label || f.key, value: String(f.value ?? ''), state, confidence: clamp(f.confidence || 0), sources: (f.llm ? ['llm'] : ['arithmetic']), evidence, freshness: 'Unknown' as Freshness, reasoning };
  });
  const shown = attributes.filter((a) => a.state !== 'Unknown');
  return {
    kind: 'buyer', id: opts.glid || '', built_at: opts.nowIso || '', version: 1, attributes,
    confidence_overall: shown.length ? clamp(shown.reduce((s, a) => s + a.confidence, 0) / shown.length) : 0,
    explicit_unknowns: attributes.filter((a) => a.state === 'Unknown').map((a) => a.key),
    explicit_negatives: [],
    contradictions: attributes.filter((a) => a.reasoning.some((r) => r.rejected)).map((a) => ({ a: a.key, b: a.reasoning.find((r) => r.rejected)?.rejected || '', resolution: a.value })),
    anchors: opts.anchors ?? null, source_registry: opts.source_registry ?? null, source_priority: opts.source_priority ?? null,
  };
}

// ── (B) CATEGORY BRAIN — lift the frequency-only critical_specs into stated IAttributes ──
// `intel` is the CategoryIntel object (read defensively). Each critical spec carries seller_frequency (0-100 or count).
export function categoryBrainFromIntel(intel: unknown, mcatId: string, nowIso = ''): ICategoryBrain {
  const ci = obj(intel);
  const distillDate = (ci.distill_date || ci.built_at || ci.cached_at) as string | undefined;
  const days = distillDate ? Math.round((Date.parse(nowIso || '') - Date.parse(String(distillDate))) / 86_400_000) : undefined;
  const specs = arr(ci.critical_specs).length ? arr(ci.critical_specs) : arr(ci.known_specs);
  const attributes: IAttribute[] = specs.map((sp) => {
    const s = obj(sp);
    const name = String(s.name || s.spec || s.key || '');
    const freqRaw = Number(s.seller_frequency ?? s.frequency ?? s.cnt ?? 0);
    const freqPct = freqRaw > 100 ? 100 : freqRaw <= 1 ? Math.round(freqRaw * 100) : freqRaw; // tolerate 0-1, 0-100, or counts
    const state = stateFromFrequency(freqPct);
    return {
      key: 'cat_' + name.toLowerCase().replace(/\s+/g, '_'), label: name, value: String(s.value || s.options || ''),
      state, confidence: clamp(freqPct), sources: ['category-distill'],
      evidence: [{ source: 'category-distill', signal: `seller_frequency=${freqRaw}${s.source_node ? ' · ' + s.source_node : ''}`, confidence: clamp(freqPct), date: distillDate }],
      freshness: freshFromDays(days),
      reasoning: [{ claim: `Asked by ${freqRaw} of the seller cohort for this category`, evidence: [] }],
    };
  });
  return {
    kind: 'category', id: mcatId, mcat_id: mcatId, distill_date: distillDate, built_at: nowIso, version: 1, attributes,
    confidence_overall: attributes.length ? clamp(attributes.reduce((s, a) => s + a.confidence, 0) / attributes.length) : 0,
    explicit_unknowns: [], explicit_negatives: [], contradictions: [],
  };
}

// ── (C) RFQ BRAIN — project the requirement being composed (decisions + ask + dropped) ──
// `state` is the resolved-requirement / rfq-ledger shape (read defensively): { decisions?, ask?, knownDropped?, specOrder? }.
export function rfqBrainFromState(state: unknown, opts: { glid: string; mcatId: string; sessionId: string; nowIso: string }): IRfqBrain {
  const st = obj(state);
  const decisions = arr(st.decisions).length ? arr(st.decisions) : arr(st.specOrder);
  const attributes: IAttribute[] = decisions.map((d) => {
    const o = obj(d);
    const key = String(o.key || o.spec || o.id || '');
    return {
      key, label: String(o.label || key), value: String(o.value ?? ''), state: (o.value ? 'Likely' : 'Unknown') as AttrState,
      confidence: clamp(Number(o.confidence ?? 0)), sources: arr(o.sources).map(String), evidence: [], freshness: 'Fresh',
      reasoning: o.reason ? [{ claim: String(o.reason), evidence: [] }] : [],
    };
  });
  const ask = arr(st.ask).map((x) => (typeof x === 'string' ? x : String(obj(x).key || obj(x).label || ''))).filter(Boolean);
  const dropped = arr(st.knownDropped).map((x) => { const o = obj(x); return { key: String(o.key || o.spec || x), reason: String(o.reason || 'already known') }; });
  return {
    kind: 'rfq', id: `${opts.glid}:${opts.mcatId}:${opts.sessionId}`, built_at: opts.nowIso, version: 1, attributes,
    confidence_overall: 0, explicit_unknowns: ask, explicit_negatives: [], contradictions: [],
    ask, known_dropped: dropped,
  };
}

// ── ALIGN — the deterministic join that produces the RFQ journey's provenance chain ──
export function alignBrains(buyer: IBuyerBrain | null, category: ICategoryBrain | null, rfq: IRfqBrain, nowIso = ''): ThreeBrainAlignment {
  const bByKey = new Map<string, IAttribute>();
  for (const a of buyer?.attributes || []) { bByKey.set(a.key, a); bByKey.set(a.key.replace(/^cat_/, ''), a); }
  const cByLabel = new Map<string, IAttribute>();
  for (const a of category?.attributes || []) cByLabel.set(a.label.toLowerCase(), a);
  const catDistillDays = category?.distill_date ? Math.round((Date.parse(nowIso) - Date.parse(category.distill_date)) / 86_400_000) : undefined;

  const matchBuyer = (k: string): IAttribute | undefined => bByKey.get(k) || bByKey.get(k.replace(/\s+/g, '_').toLowerCase());
  const chain = [...rfq.ask, ...rfq.attributes.map((a) => a.key)].filter((v, i, arr2) => v && arr2.indexOf(v) === i).map((rfqKey) => {
    const rfqAttr = rfq.attributes.find((a) => a.key === rfqKey);
    const be = matchBuyer(rfqKey);
    const ce = cByLabel.get(String(rfqKey).replace(/_/g, ' ').toLowerCase());
    // SUPPRESSION: only when the buyer already CONFIRMED this fact AND it is fresher than the category distill.
    const buyerConfirmed = be && be.state === 'Confirmed';
    const buyerFresher = !ce || be?.freshness === 'Fresh' || (catDistillDays != null && catDistillDays > 30);
    const suppressed = !!(buyerConfirmed && buyerFresher);
    const reasoning = suppressed
      ? `buyer already confirmed "${be?.value}" (${be?.state}) fresher than the category distill → suppress`
      : be ? `buyer=${be.value} (${be.state}) ${ce ? '+ category asks this' : ''} → keep & pre-fill`
      : ce ? `no buyer fact; category cohort asks this (${ce.state}) → ask` : 'no buyer or category signal → ask';
    return { rfq_key: rfqKey, rfq_value: rfqAttr?.value, buyer_evidence: be, category_evidence: ce, reasoning, suppressed, suppression_reason: suppressed ? 'buyer-confirmed + fresher than distill' : undefined };
  });
  // cross-brain contradiction: buyer Confirmed value vs category Confirmed value on the same spec, different values
  const contradictions: ThreeBrainAlignment['cross_brain_contradictions'] = [];
  for (const c of chain) {
    const b = c.buyer_evidence, k = c.category_evidence;
    if (b && k && b.state === 'Confirmed' && k.state === 'Confirmed' && b.value && k.value && b.value.toLowerCase() !== k.value.toLowerCase()) {
      contradictions.push({ a: `buyer:${b.key}=${b.value}`, b: `category:${k.label}=${k.value}`, note: 'buyer wins (first-party > cohort prior)' });
    }
  }
  return {
    built_at: nowIso, provenance_chain: chain, cross_brain_contradictions: contradictions,
    coverage: { rfq_keys: chain.length, matched_buyer: chain.filter((c) => c.buyer_evidence).length, matched_category: chain.filter((c) => c.category_evidence).length, suppressed: chain.filter((c) => c.suppressed).length, orphaned: chain.filter((c) => !c.buyer_evidence && !c.category_evidence).length },
  };
}

export const stateRankOf = (s: AttrState): number => stateRank[s];
