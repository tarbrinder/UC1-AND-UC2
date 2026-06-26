// ─── Contradiction Engine (L2 · the highest-value new engine) ─────────────────
// Both pilot cases handed us contradictions the system DETECTED but never acted on:
//   • Tarbrinder: "Tyresnmore Pvt Ltd" + "personal" + 1000 tyres + Amritsar/Noida/Bengaluru
//   • Jaiveer:    near-Kanpur seller preference never turned into a supplier-radius question
// This engine turns those clashes into a single POLITE NUDGE (never a block) — a clarifying chip the
// buyer taps. Each nudge carries evidence and (where clean) the form field a tap should write.
//
// Pure · NO LLM · NO category hardcoding — only structural reasoning (entity-name shape, generic
// quantity ceiling, location set-difference, role disagreement). Chaos-safe: missing inputs ⇒ no nudge.

export type ContradictionType = 'location' | 'persona_vs_order' | 'buyer_type' | 'supplier_radius' | 'approval' | 'installation' | 'po_process' | 'scale_vs_role' | 'new_direction';
export interface Nudge {
  type: ContradictionType;
  severity: 'high' | 'medium';
  score: number;   // R2 — priority score; the UI shows only the TOP 1-2 so RFQ friction never returns
  question: string;
  options: string[];
  evidence: string[];
  field?: string; // form field a tap can write (buyerKind / deliveryCity / buyerType / …)
}
export interface ContradictionInput {
  locations?: Array<{ source: string; value: string }>; // profile city, Befisc city/address, CSL city, GST state…
  companyName?: string;
  profileType?: string;     // Retailer / Industrialist / Wholesaler …
  twinType?: string;        // End User / Manufacturer …
  intentType?: string;      // current journey/intent text
  isPersonal?: boolean;     // current buyerKind = personal
  qty?: number;
  unit?: string;
  localPreference?: string;  // High / Regional / Local Only … → supplier-radius nudge (consumption)
  buyerCity?: string;        // to label the radius question
  // R3 — the (previously idle) generation engines, now driving ACTION nudges:
  authorityRole?: string;    // decision_maker / procurement / researcher / influencer (P1 Authority)
  procurementModel?: string; // Capex / Recurring Supply / Project-based … (P2)
  // P3.8 — cross-signal inputs (now that qty-scale + trajectory are consumed):
  orderScale?: string;       // single / small / bulk / wholesale (from classifyOrderScale) — qty magnitude
  offProfileNewProduct?: boolean; // the CURRENT product is unrelated to ALL of this buyer's history (a new line / one-off)
  // P0 identity hierarchy — Nature (email-domain, evidence-gated) is authoritative; when it confidently
  // resolves the buyer type we must NOT raise a "which buyer type?" nudge (it's not ambiguous).
  nature?: string;           // Academic / Research Institution · Government / PSU · Corporate / Business …
  natureConfidence?: number; // 0-100
}
// R2 — base priority per type (a wrong delivery location hurts most; a consumption ask least).
const SEVERITY_SCORE: Record<ContradictionType, number> = {
  location: 9, persona_vs_order: 8, scale_vs_role: 7, approval: 6, installation: 6, new_direction: 6, po_process: 5, buyer_type: 5, supplier_radius: 4,
};

const slug = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Registered-entity name shapes (universal — not categories).
const ENTITY_RE = /\b(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation|enterprises?|industries|traders?|trading|company|co\b|udyog|udhyog|exports?|imports?|solutions?|technologies)\b/i;
// Generic ceiling: more than this many DISCRETE units is atypical for genuine personal use (no category literal).
const PERSONAL_DISCRETE_CEILING = 25;
const UNIT_DISCRETE = /piece|pcs|\bnos?\b|\bunit\b|\bset\b|pair|item|each/i;
const isPersonalish = (i: ContradictionInput) => !!i.isPersonal || /personal|individual|end.?user|home|own use/i.test(i.intentType || '');

// Group locations, treating containment as the SAME place ("Amritsar" ⊂ "Amritsar, Punjab").
function distinctLocations(locs?: Array<{ source: string; value: string }>) {
  const clean = (locs || []).filter((l) => l && slug(l.value));
  const groups: Array<{ slug: string; label: string; sources: string[] }> = [];
  for (const l of clean) {
    const s = slug(l.value);
    const g = groups.find((x) => x.slug.includes(s) || s.includes(x.slug));
    if (g) { if (s.length > g.slug.length) { g.slug = s; g.label = l.value; } g.sources.push(l.source); }
    else groups.push({ slug: s, label: l.value, sources: [l.source] });
  }
  return groups;
}

export function detectContradictions(i: ContradictionInput): Nudge[] {
  const out: Nudge[] = [];
  const personal = isPersonalish(i);
  // helper: stamp the R2 priority score from the type, so callers can sort + cap.
  const push = (n: Omit<Nudge, 'score'>) => out.push({ ...n, score: SEVERITY_SCORE[n.type] ?? 0 });

  // 1 — LOCATION mismatch (≥2 distinct places across sources) → which to quote/deliver?
  const groups = distinctLocations(i.locations);
  if (groups.length >= 2) {
    push({
      type: 'location', severity: 'high',
      question: 'We found more than one location for you — where should suppliers quote & deliver?',
      options: [...groups.map((g) => g.label).slice(0, 4), 'Other'],
      evidence: groups.map((g) => `${g.label} (${[...new Set(g.sources)].join(', ')})`),
      field: 'deliveryCity',
    });
  }

  // 2 — PERSONA-vs-ORDER (personal order but strong business signals) — CONSOLIDATED so we don't fire
  //     three near-identical "are you really personal?" nudges. Evidence lists every signal that fired.
  if (personal) {
    const ev: string[] = [];
    const entity = ENTITY_RE.test(i.companyName || '');
    if (entity) ev.push(`company "${i.companyName}" looks like a registered business`);
    const businessProfile = !!i.profileType && !/individual|end.?user|personal|consumer/i.test(i.profileType);
    if (businessProfile) ev.push(`profile says "${i.profileType}" (a business role)`);
    const bigQty = (i.qty || 0) > PERSONAL_DISCRETE_CEILING && (!i.unit || UNIT_DISCRETE.test(i.unit));
    if (bigQty) ev.push(`quantity ${i.qty} ${i.unit || ''}`.trim() + ' is high for personal use');
    if (ev.length) push({
      type: 'persona_vs_order', severity: 'high',
      question: 'This is marked personal, but we see business signals — what is it for?',
      options: ['Personal use', 'Business / resale', 'Workshop / fitment', 'Fleet'],
      evidence: ev,
      field: 'buyerKind',
    });
  }

  // 3 — BUYER-TYPE ambiguity (profile role ≠ twin role) — only when the personal nudge didn't already
  //     cover it AND Nature hasn't already RESOLVED the identity. A conf-≥80 academic/government Nature is
  //     authoritative (the email domain answers it) — never ask "which buyer type?" then (the IIT-Kanpur
  //     "Business Buyer vs Manufacturer" nudge, where the real answer was "Research Institution" all along).
  const natureResolved = /academic|research|government|psu/i.test(i.nature || '') && (i.natureConfidence || 0) >= 80;
  if (!natureResolved && !out.some((n) => n.type === 'persona_vs_order') && i.profileType && i.twinType) {
    if (slug(i.profileType) !== slug(i.twinType) && !i.profileType.includes(i.twinType) && !i.twinType.includes(i.profileType)) {
      push({
        type: 'buyer_type', severity: 'medium',
        question: 'We see two buyer types for you — which fits this order?',
        options: [i.profileType, i.twinType, 'Other'],
        evidence: [`profile: ${i.profileType}`, `behaviour twin: ${i.twinType}`],
        field: 'buyerType',
      });
    }
  }

  // 4 — SUPPLIER-RADIUS (CONSUMPTION, not a clash): a confident local preference must DO something (L3).
  if (/high|local|regional/i.test(i.localPreference || '')) {
    const city = (i.buyerCity || '').trim();
    push({
      type: 'supplier_radius', severity: 'medium',
      question: city ? `You usually prefer local suppliers — how far should we look from ${city}?` : 'How far should we look for suppliers?',
      options: city ? [`Near ${city}`, 'Within the state', 'Anywhere in India'] : ['Local only', 'Within the state', 'Anywhere in India'],
      evidence: [`local preference: ${i.localPreference}`, city ? `buyer city: ${city}` : ''].filter(Boolean),
      field: 'supplierRadius',
    });
  }

  // ── R3: the (previously idle) generation engines now DRIVE action nudges ──
  // 5 — Authority = RESEARCHER → likely needs internal approval / a PO before buying.
  if (/researcher/i.test(i.authorityRole || '')) {
    push({
      type: 'approval', severity: 'medium',
      question: 'Does this purchase need internal approval or a PO before you order?',
      options: ['Yes — needs approval', 'No — I can decide', 'Already approved'],
      evidence: ['authority: Researcher (from designation)'],
      field: 'approval',
    });
  }
  // 6 — Procurement model = CAPEX → installation / commissioning usually matters.
  if (/capex/i.test(i.procurementModel || '')) {
    push({
      type: 'installation', severity: 'medium',
      question: 'Will you need installation or commissioning support?',
      options: ['Yes', 'No', 'Not sure yet'],
      evidence: ['procurement model: Capex'],
      field: 'installation',
    });
  }
  // 7 — Authority = PROCUREMENT → a formal PO / tender process is likely.
  if (/procurement/i.test(i.authorityRole || '')) {
    push({
      type: 'po_process', severity: 'medium',
      question: 'Is this a formal PO / tender process, or a direct buy?',
      options: ['PO / tender', 'Direct buy', 'Rate contract'],
      evidence: ['authority: Procurement (from designation)'],
      field: 'po_process',
    });
  }

  // ── P3.8: cross-signal contradictions — using the now-consumed qty-scale + trajectory ──
  // 8 — SCALE-vs-ROLE: a known BULK/wholesale buyer placing a SINGLE / sample-size order. Don't pitch bulk
  //     terms on a 1-piece order — clarify whether it's a sample / trial / own-use this time. (qty scale × role.)
  const bulkRole = /trader|wholesal|distributor|stockist|reseller/i.test(`${i.profileType || ''} ${i.twinType || ''}`);
  if (bulkRole && i.orderScale === 'single' && !personal) {
    push({
      type: 'scale_vs_role', severity: 'medium',
      question: 'This is a much smaller order than usual — what is it for this time?',
      options: ['Sample / trial', 'For own use', 'Same as usual (bulk)', 'New requirement'],
      evidence: [`usual role: ${(i.profileType || i.twinType || '').trim()}`, 'this order: a single / sample quantity'],
      field: 'scale_context',
    });
  }
  // 9 — NEW DIRECTION: the current product is OFF-PROFILE (unrelated to everything this buyer has bought
  //     before) — a new line, a one-off, or a project. Surface it so the plan treats intent as FRESH.
  //     (buyer trajectory / history × the current product.)
  if (i.offProfileNewProduct) {
    push({
      type: 'new_direction', severity: 'medium',
      question: 'This is a new kind of product for you — what is driving it?',
      options: ['A new line / expansion', 'A one-off or project', 'Just trying it out'],
      evidence: ['current product is unrelated to your past categories'],
      field: 'new_direction',
    });
  }

  // R2 — highest-priority first; the UI shows only the top 1-2 so friction never returns.
  return out.sort((a, b) => b.score - a.score);
}
