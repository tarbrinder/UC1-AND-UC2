// ─── Requirement Brain — frontend contract + client ──────────────────────────
// The Decision Layer of bi-requirement-brain (n8n). The engine RESOLVEs the target
// requirement, filters buyer history by RELEVANCE, reconciles conflicts, plans the
// ≤3 non-spec-first gaps, scores intent×certainty, and emits DECISION OBJECTS — the
// UI's only input. The form renders decisions; it never re-derives them.
// Fabrication firewall: a field reaches a seller only if buyer-stated or buyer-confirmed.
import { api } from '../api';
import fixtures from './requirementBrainFixtures.json';

export type DecisionAction =
  | 'PREFILL'          // STATED fact — editable fact chip
  | 'CONFIRM'          // OBSERVED (browsing) — "from your browsing, confirm?"
  | 'ASK'              // a real gap — question chip (non-spec first)
  | 'SUGGEST'          // INFERRED category norm — unselected ghost chip
  | 'RESOLVE_CONFLICT' // two of the buyer's own signals disagree — A/B, nothing preselected
  | 'OFFER'            // L3 project — dismissable strip, never merged into the primary
  | 'SUPPRESS';        // noise/junk — logged, never rendered

export type DecisionUi = 'fact_chip' | 'confirm_chip' | 'question_chip' | 'ghost_chip' | 'ab_conflict' | 'dismissable_strip' | 'hidden';
export type Freshness = 'fresh' | 'warm' | 'old' | 'expired' | 'unknown';
export type EntryMode = 'repost' | 'confirm_draft' | 'gap_question' | 'multi_chooser' | 'blank_multimodal';

export interface ConflictOption { value: string; source: string; evidence?: string }
export interface Decision {
  field: string;
  action: DecisionAction;
  value?: string;
  options?: (string | ConflictOption)[];
  reason?: string;
  why?: string;
  kind?: 'spec' | 'non_spec';
  evidence?: string[];
  confidence?: number;
  freshness?: Freshness;
  ui: DecisionUi;
  priority: number;
}

// ── The engine's 3-part contract (ChatGPT-review): Decision Objects are the ONLY thing the UI renders;
//    metadata carries render hints; observability is debug-only. The UI never sees CSL/PNS/RFQ/WhatsApp.
export interface NodeHealth { status: 'green' | 'amber' | 'red'; count: number }
export interface Recommendation { product: string; mcat?: string; status?: string; age_days?: number | null; is_expired?: boolean; repostable?: boolean; image?: string | null; specs?: { name: string; value: string }[]; action: 'enrich' | 'repost' | 'new' }
export interface DecisionSummary {
  evidence: number; total_decisions: number; by_action: Record<string, number>;
  questions_avoided: number; questions_generated: number; conflicts_resolved: number;
  suggestions_offered: number; suppressed: number;
}
/** One truth atom — what a decision's `evidence: ["ev_7"]` actually POINTS AT. Emitted by engine v7+;
 *  before that the ids were dangling (the debug trail showed "ev_7" and could never resolve it). */
export interface EvidenceAtom {
  id: string; req?: number; field?: string; value?: unknown;
  tier?: 'stated' | 'observed' | 'inferred' | 'noise' | string;
  source?: string;                 // e.g. "posted+discussed_wa" — WHICH source(s) produced this atom
  age_days?: number | null; freshness?: string; confidence?: number;
  used_because?: string;           // why it was admitted
  ignored_because?: string;        // why it was dropped (the firewall's audit trail)
}
export interface RequirementBrainPayload {
  decisions: Decision[];
  metadata: {
    glid: string;
    entry_mode: EntryMode;
    primary: { product: string; mcat?: string; status?: string; age_days?: number } | null;
    intent: { level: 'high' | 'medium' | 'low'; why?: string };
    certainty: 'high' | 'medium' | 'low' | 'none';
    discreet?: boolean;
    kyb_unlock: { state: 'verified' | 'on_file' | 'offer' | 'suppressed'; badge?: boolean; ask?: string | null; when?: string; benefit?: string; discreet?: boolean; why?: string };
    seller_header: { confirmed_fields: number; intent: string; certainty: string; context: string };
    project: { detected: boolean; items?: string[] };
    recommendations?: Recommendation[];
    buyer_memory?: { recent_searches: string[]; viewed: { name: string; image?: string | null; mcat?: string | number }[] };
    category?: { mcat_id: string | number; calls?: number; b2b_b2c?: unknown; personas?: unknown; keywords?: string[]; top_specs?: { q: string; pct?: number; vals?: string[] }[] } | null;
    buyer_facts?: { member_since?: string; has_gst?: boolean; gst_verified?: boolean; city?: string; state?: string; business_type?: string; total_requirements?: number; total_calls?: number };
    versions: { brain: string; planner: string; adapter: string };
  };
  observability: {
    decision_summary: DecisionSummary;
    node_health: Record<string, NodeHealth>;
    node_raw?: Record<string, unknown>;   // per-source raw payload for debug drill-down
    evidence?: EvidenceAtom[];            // engine v7+: resolves every decision's ev_N (absent on older engines)
    suppressed?: { i: number; product?: string; why: string }[];
    planner_gate: string;
    evidence_count: number;
  };
}

const HOOK = 'bi-requirement-brain';

/** Normalize either contract into the v2 {decisions, metadata, observability} shape.
 *  Tolerates the live v1 (flat) endpoint until the v2 workflow is re-imported. */
export function normalize(raw: unknown): RequirementBrainPayload {
  const r = raw as Record<string, unknown>;
  if (r && r.metadata && r.decisions) return raw as RequirementBrainPayload; // already v2
  const decisions = (r?.decisions as Decision[]) ?? [];
  const by: Record<string, number> = {};
  for (const d of decisions) by[d.action] = (by[d.action] ?? 0) + 1;
  const tr = (r?.__trace as { evidence_count?: number; planner_gate?: string }) ?? {};
  return {
    decisions,
    metadata: {
      glid: (r?.glid as string) ?? '',
      entry_mode: (r?.entry_mode as EntryMode) ?? 'blank_multimodal',
      primary: (r?.primary as RequirementBrainPayload['metadata']['primary']) ?? null,
      intent: (r?.intent as RequirementBrainPayload['metadata']['intent']) ?? { level: 'low' },
      certainty: (r?.certainty as RequirementBrainPayload['metadata']['certainty']) ?? 'none',
      discreet: (r?.discreet as boolean) ?? false,
      kyb_unlock: (r?.kyb_unlock as RequirementBrainPayload['metadata']['kyb_unlock']) ?? { state: 'suppressed' },
      seller_header: (r?.seller_header as RequirementBrainPayload['metadata']['seller_header']) ?? { confirmed_fields: 0, intent: 'low', certainty: 'none', context: 'standalone' },
      project: (r?.project as RequirementBrainPayload['metadata']['project']) ?? { detected: false },
      versions: { brain: (r?.__build as string) ?? 'v1', planner: 'v1', adapter: 'v1' },
    },
    observability: {
      decision_summary: {
        evidence: tr.evidence_count ?? 0, total_decisions: decisions.filter((d) => d.action !== 'SUPPRESS').length, by_action: by,
        questions_avoided: (by.PREFILL ?? 0) + (by.CONFIRM ?? 0), questions_generated: by.ASK ?? 0,
        conflicts_resolved: by.RESOLVE_CONFLICT ?? 0, suggestions_offered: by.SUGGEST ?? 0, suppressed: by.SUPPRESS ?? 0,
      },
      node_health: {},
      evidence: (r?.evidence as EvidenceAtom[]) ?? undefined,   // v1 never carried it; v7+ does
      suppressed: (r?.suppressed as RequirementBrainPayload['observability']['suppressed']) ?? [],
      planner_gate: tr.planner_gate ?? 'unknown',
      evidence_count: tr.evidence_count ?? 0,
    },
  };
}

/** Resilience fallback: when the (3-level-nested) requirement-brain returns blank for a heavy buyer,
 *  hit bi-buyer-brain DIRECTLY (2 levels, reliable) and build the repost/enrich chooser from its requirements.
 *  Gives a working repost/enrich flow (product+mcat seed) even when the full engine chain flakes. */
export async function fetchBuyerBrainRecommendations(glid: string, timeoutMs = 60000): Promise<RequirementBrainPayload | null> {
  try {
    const url = api(`/api/imworkflow/webhook/bi-buyer-brain?glid=${encodeURIComponent(glid)}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const bb = (await res.json()) as { requirements?: { product: string; mcat?: string; status?: string; recency_days?: number; is_expired?: boolean; repostable?: boolean; confidence?: number }[] };
    const reqs = (bb.requirements ?? []).filter((r) => r.product);
    if (!reqs.length) return null;
    const recommendations: Recommendation[] = reqs.slice(0, 8).map((r) => ({
      product: r.product, mcat: r.mcat, status: r.status, age_days: r.recency_days ?? null,
      is_expired: !!r.is_expired, repostable: !!r.repostable,
      action: (/approv|pending|open/i.test(String(r.status ?? '')) && !r.is_expired) ? 'enrich' : r.repostable || r.is_expired ? 'repost' : 'new',
    }));
    const p = normalize({}); // empty v2 shell
    p.metadata.glid = glid;
    p.metadata.recommendations = recommendations;
    p.metadata.entry_mode = 'multi_chooser';
    return p;
  } catch { return null; }
}

/** Live pull. pns='api' = fast (PNS API insights only, no transcription); 'full' = API + VANI + PNS transcripts. */
export async function fetchRequirementBrain(glid: string, opts?: { pns?: 'api' | 'full'; timeoutMs?: number }): Promise<RequirementBrainPayload> {
  const pns = `&pns=${opts?.pns ?? 'api'}`;   // n8n calls-call reads ?pns to skip/run the slow transcription
  const url = api(`/api/imworkflow/webhook/${HOOK}?glid=${encodeURIComponent(glid)}${pns}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(opts?.timeoutMs ?? (opts?.pns === 'full' ? 150000 : 60000)) });
  if (!res.ok) throw new Error(`requirement-brain ${res.status}`);
  return normalize(await res.json());
}

/** Real engine outputs (from the 100-buyer validation) for offline preview + tests. */
export function fixture(glid: keyof typeof fixtures | string): RequirementBrainPayload | null {
  return (fixtures as Record<string, RequirementBrainPayload>)[glid] ?? null;
}
export const fixtureGlids = Object.keys(fixtures);

/** Buyer-facing provenance phrasing (WhatsApp-prompt register — never expose CSL/mcat/observed). */
export function provenanceLabel(d: Decision): string {
  const src = (d.evidence?.length ? d.reason : d.reason) ?? '';
  if (d.action === 'PREFILL') return d.reason || 'from your requirement';
  if (d.action === 'CONFIRM') return 'from your browsing — confirm?';
  if (d.action === 'SUGGEST') return d.reason || 'common in this category';
  return src;
}
