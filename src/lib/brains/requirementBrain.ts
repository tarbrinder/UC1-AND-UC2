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
    buyer_memory?: { recent_searches: string[]; viewed: { name: string; image?: string | null; mcat?: string | number; specs?: { name: string; value: string }[] }[] };
    category?: { mcat_id: string | number; calls?: number; b2b_b2c?: unknown; personas?: unknown; keywords?: string[]; top_specs?: { q: string; pct?: number; vals?: string[] }[] } | null;
    buyer_facts?: { member_since?: string; has_gst?: boolean; gst_verified?: boolean; city?: string; state?: string; business_type?: string; total_requirements?: number; total_calls?: number; browse_city?: string; browse_also_seen?: string[]; searched_cities?: string[] };
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

/** Bridge the buyer's requirement list + viewed products from the RAW source nodes into
 *  metadata.recommendations / metadata.buyer_memory — the slots the landing actually reads.
 *
 *  Root cause of "even if n8n ran, my prev requirements and viewed products are not coming"
 *  (owner 2026-07-29): a LIVE engine payload carries the requirements in observability.node_raw.rfq
 *  and the viewed products in the profile node's products_of_interest, but normalize() historically
 *  mapped NEITHER into metadata.* — so recs came back empty and the landing showed nothing. Fixtures
 *  were unaffected because they are pre-baked with metadata.recommendations. This is the same
 *  "rich in node_raw, dead in the metadata slot" break the debug panel already warns about.
 *
 *  Runs ONLY when metadata.recommendations is empty, so a payload that DID carry them is never
 *  second-guessed. Node keys are matched defensively (rfq by name, products_of_interest by scan) so
 *  a renamed node still bridges. mcat is usually absent on an rfq row — the form resolves it from the
 *  product name on pick (commitProduct), so a missing mcat here is not a blocker. */
/** Location-conflict signal (#1/#2, 2026-08-10): lift the CSL browse city (where the buyer is actually browsing FROM,
 *  distinct from his registered/delivery city) onto buyer_facts so the spec page can compare it against the profile
 *  city and, on a district mismatch, prompt for the real location. Non-destructive: only sets keys when present. */
function hydrateLocationSignals(p: RequirementBrainPayload): void {
  const nr = (p.observability?.node_raw ?? {}) as Record<string, unknown>;
  const csl = (nr.csl && typeof nr.csl === 'object') ? (nr.csl as Record<string, unknown>) : {};
  const bl = (csl.browse_location && typeof csl.browse_location === 'object') ? (csl.browse_location as Record<string, unknown>) : {};
  const browseCity = typeof bl.city === 'string' ? bl.city.trim() : '';
  const alsoSeen = Array.isArray(bl.also_seen_in) ? (bl.also_seen_in as unknown[]).map((x) => String(x).trim()).filter(Boolean) : [];
  // searched_cities was the "CSL gap G2" the code flagged: the buyer SEARCHED/TARGETED a city (e.g. Dimapur for GLID
  // 253102197) but it was dropped, so the conflict detector never saw it. Now mapped through as a TARGET signal.
  const searched = Array.isArray(bl.searched_cities) ? (bl.searched_cities as unknown[]).map((x) => String(x).trim()).filter(Boolean) : [];
  if (!browseCity && !alsoSeen.length && !searched.length) return;
  p.metadata.buyer_facts = { ...(p.metadata.buyer_facts ?? {}), ...(browseCity ? { browse_city: browseCity } : {}), ...(alsoSeen.length ? { browse_also_seen: alsoSeen } : {}), ...(searched.length ? { searched_cities: searched } : {}) };
}

function hydrateLandingFromNodeRaw(p: RequirementBrainPayload): void {
  hydrateLocationSignals(p);   // ALWAYS run (before the recommendations early-return) — the location-conflict signal
  //                              is independent of whether the landing recommendations slot is already populated.
  if (p.metadata.recommendations?.length) return;
  const nr = (p.observability?.node_raw ?? {}) as Record<string, unknown>;
  const vals = Object.values(nr);
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  const recs: Recommendation[] = [];
  const seen = new Set<string>();

  // Requirements — prefer the `rfq` node, else the first node value that is an array of {product}.
  const reqArr = (Array.isArray(nr.rfq) ? nr.rfq
    : vals.find((v) => Array.isArray(v) && (v as unknown[]).some((x) => !!x && typeof x === 'object' && 'product' in (x as object)))) as Array<Record<string, unknown>> | undefined;
  for (const it of Array.isArray(reqArr) ? reqArr : []) {
    const product = str(it.product); if (!product) continue;
    const key = product.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    const status = str(it.status);
    const expired = !!it.is_expired || /expired/i.test(status ?? '');
    const specs = Array.isArray(it.specs)
      ? (it.specs as Array<Record<string, unknown>>).map((s) => ({ name: String(s?.name ?? ''), value: String(s?.value ?? '') })).filter((s) => s.name && s.value)
      : undefined;
    recs.push({
      product, mcat: str(it.category_id) ?? str(it.mcat),
      status, age_days: typeof it.recency_days === 'number' ? it.recency_days : null,
      is_expired: expired, repostable: true, specs,
      action: (/approv|pending|open/i.test(status ?? '') && !expired) ? 'enrich' : 'repost',
    });
  }

  // Viewed / browsed. PREFER the CSL node's viewed list — csl-enrich-prod1's Redash pc_item enrichment
  // carries a real specs[] per product (owner: "I don't see specs — did CSL not provide? we have Redash").
  // It DOES; the specs live at node_raw.csl.viewed and were simply never read here (the landing bridge read
  // profile.products_of_interest, which is mcat-INTEREST level: name/image/mcat only, no specs). Fall back to
  // products_of_interest only when CSL carries nothing. action 'new'.
  const cslNode = (nr.csl && typeof nr.csl === 'object') ? (nr.csl as Record<string, unknown>) : {};
  const cslViewed = (Array.isArray(cslNode.viewed) ? cslNode.viewed
    : Array.isArray(cslNode.viewed_products) ? cslNode.viewed_products : []) as Array<Record<string, unknown>>;
  const poiHost = vals.find((v) => !!v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).products_of_interest)) as Record<string, unknown> | undefined;
  const poi = (poiHost?.products_of_interest ?? []) as Array<Record<string, unknown>>;
  const viewedSrc = cslViewed.length ? cslViewed : poi;
  const specsOf = (v: Record<string, unknown>) => Array.isArray(v.specs)
    ? (v.specs as Array<Record<string, unknown>>).map((s) => ({ name: String(s?.name ?? ''), value: String(s?.value ?? '') })).filter((s) => s.name && s.value)
    : undefined;
  const mcatOf = (v: Record<string, unknown>) => str(v.mcat) ?? str(v.mcat_id)
    ?? (typeof v.mcat === 'number' ? v.mcat : typeof v.mcat_id === 'number' ? v.mcat_id : undefined);
  const viewed: { name: string; image?: string | null; mcat?: string | number; specs?: { name: string; value: string }[] }[] = [];
  for (const v of Array.isArray(viewedSrc) ? viewedSrc : []) {
    const name = str(v.name); if (!name) continue;
    const mcat = mcatOf(v);
    const image = str(v.image) ?? null;
    const specs = specsOf(v);
    viewed.push({ name, image, mcat, specs });
    const key = name.toLowerCase();
    if (seen.has(key)) {
      // NAME↔CATEGORY COLLISION (owner 2026-07-30, "Tasty Three in One": a toffee the buyer browsed, mcat 55260,
      // WITH image + food ISQ — colliding with a mis-categorised RFQ requirement, mcat 2416 "Transformers", no
      // image). Owner policy (Option C): the RFQ card keeps winning the slot, but graft the CSL twin's image (and
      // specs, if the RFQ carried none) onto it so the offer image is NEVER lost to the collision. The mcat-level
      // reconciliation (feeding LLM 1 the CSL food ISQ when category_trustworthy=false) is the other half.
      const twin = recs.find((r) => r.product.toLowerCase() === key);
      if (twin) {
        if (!twin.image && image) twin.image = image;
        if ((!twin.specs || !twin.specs.length) && specs?.length) twin.specs = specs;
      }
      continue;   // already a posted requirement → don't also list it as a viewed tile
    }
    seen.add(key);
    recs.push({ product: name, mcat: mcat != null ? String(mcat) : undefined, image, specs, action: 'new' });
  }

  if (recs.length) p.metadata.recommendations = recs;
  if (viewed.length && !p.metadata.buyer_memory) p.metadata.buyer_memory = { recent_searches: [], viewed };
}

// STEP-0 PROFILE THREADING (2026-08-11): bpod → node_raw.profile + metadata.buyer_facts. The pure mappers live in
// ./bpodMap (dependency-free so the test suite can load them; requirementBrain pulls in ../api which the loader
// cannot). Re-exported here because the gate imports them alongside normalize().
export { bpodToProfileNode, bpodToBuyerFacts } from './bpodMap';

/** Normalize either contract into the v2 {decisions, metadata, observability} shape.
 *  Tolerates the live v1 (flat) endpoint until the v2 workflow is re-imported. */
export function normalize(raw: unknown): RequirementBrainPayload {
  const r = raw as Record<string, unknown>;
  if (r && r.metadata && r.decisions) { const p = raw as RequirementBrainPayload; hydrateLandingFromNodeRaw(p); return p; } // already v2 — but still bridge node_raw→recommendations if the engine left that slot empty
  const decisions = (r?.decisions as Decision[]) ?? [];
  const by: Record<string, number> = {};
  for (const d of decisions) by[d.action] = (by[d.action] ?? 0) + 1;
  const tr = (r?.__trace as { evidence_count?: number; planner_gate?: string }) ?? {};
  const built: RequirementBrainPayload = {
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
      // STEP 0 (2026-08-11): a flat leaf payload may now carry buyer_facts (city/state + bulk-gate signals mapped
      // from bi-bpod). hydrateLocationSignals below merges any browse_city on top; both are non-destructive.
      buyer_facts: (r?.buyer_facts as RequirementBrainPayload['metadata']['buyer_facts']) ?? undefined,
      versions: { brain: (r?.__build as string) ?? 'v1', planner: 'v1', adapter: 'v1' },
    },
    observability: {
      decision_summary: {
        evidence: tr.evidence_count ?? 0, total_decisions: decisions.filter((d) => d.action !== 'SUPPRESS').length, by_action: by,
        questions_avoided: (by.PREFILL ?? 0) + (by.CONFIRM ?? 0), questions_generated: by.ASK ?? 0,
        conflicts_resolved: by.RESOLVE_CONFLICT ?? 0, suggestions_offered: by.SUGGEST ?? 0, suppressed: by.SUPPRESS ?? 0,
      },
      node_health: {},
      node_raw: (r?.node_raw as Record<string, unknown>) ?? undefined,   // so the landing bridge can mine a flat payload too
      evidence: (r?.evidence as EvidenceAtom[]) ?? undefined,   // v1 never carried it; v7+ does
      suppressed: (r?.suppressed as RequirementBrainPayload['observability']['suppressed']) ?? [],
      planner_gate: tr.planner_gate ?? 'unknown',
      evidence_count: tr.evidence_count ?? 0,
    },
  };
  hydrateLandingFromNodeRaw(built);
  return built;
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

/** Live pull. pns='api' = fast (PNS API insights only, no transcription); 'full' = API + VANI + PNS transcripts.
 *  anchorMcat/anchorReq (owner 2026-07-29, the anchor P0): the requirement the buyer actually chose to repost.
 *  The engine (v17+) picks its PRIMARY from these when present — mcat first, product name as fallback — instead of
 *  its source-count score, which could anchor the wrong requirement (Notebook when he reposted a Tata). Absent ⇒
 *  the engine falls back to its scoring exactly as before, so an old client / a cold landing is unaffected. */
export async function fetchRequirementBrain(glid: string, opts?: { pns?: 'api' | 'full'; timeoutMs?: number; anchorMcat?: string; anchorReq?: string }): Promise<RequirementBrainPayload> {
  const pns = `&pns=${opts?.pns ?? 'api'}`;   // n8n calls-call reads ?pns to skip/run the slow transcription
  const anchor = `${opts?.anchorMcat ? `&anchor_mcat=${encodeURIComponent(opts.anchorMcat)}` : ''}${opts?.anchorReq ? `&anchor_req=${encodeURIComponent(opts.anchorReq)}` : ''}`;
  const url = api(`/api/imworkflow/webhook/${HOOK}?glid=${encodeURIComponent(glid)}${pns}${anchor}`);
  // Timeout budget. Measured COLD pulls (owner 2026-07-29): a fast pns=api pull is 55–99s for a heavy buyer, so
  // the old 60s api ceiling aborted real live pulls mid-flight — the buyer was silently pinned to the fixture
  // (this was the 268590579 ERR_ABORTED). 120s covers the observed cold worst case; the instant fixture still
  // paints first, so this only lets the live upgrade land instead of being abandoned. full keeps 150s (transcripts).
  const res = await fetch(url, { signal: AbortSignal.timeout(opts?.timeoutMs ?? (opts?.pns === 'full' ? 150000 : 120000)) });
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
