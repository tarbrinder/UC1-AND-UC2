// ── ATTRIBUTE RULEBOOK ────────────────────────────────────────────────────────
// FROZEN 2026-07-08. Every LLM-inferred attribute references ONE of the 7 Source
// Policies (sourcePolicies.ts) for its source ORDER, plus an optional AttributeRule
// for the special LOGIC a plain ordering cannot express (entity-char, qty-rollup,
// 7-day cadence, explicit-only→needs_input, verified-address lock, recency). This
// replaces the previous 28 bespoke priority chains — 7 policies to maintain, not 28.
//
// Rendered in the debug drill next to the LLM's ACTUAL reasoning so a reviewer can
// eyeball-match "what policy it should have followed" against "what it reasoned".
// Deterministic parser facts carry NO rulebook row (they are single-source, not
// priority-weighted): company/registered-name, GST/GSTIN/PAN/constitution/reg-date/
// address, registered operating location, member-since/tenure, mobiles, Udyam block,
// socials, Google rating, requirement activity, verified-business flag.

import { POLICIES, policyOrderText, SOURCE_AUTHORITY, REQUIREMENT_PATTERN, type PolicyId } from './sourcePolicies';

// The special-logic layer — the 9 attributes whose logic is more than source order.
export type AttributeRuleId =
  | 'entity_char'
  | 'qty_rollup'
  | 'own_qty_cadence'
  | 'cadence_7d'
  | 'explicit_only_needsinput'
  | 'explicit_only_urgency'
  | 'language_buyer_authored'
  | 'verified_address_lock'
  | 'recency_ignore_expiry';

export const ATTRIBUTE_RULE_TEXT: Record<AttributeRuleId, string> = {
  entity_char: 'DETERMINISTIC ENTITY SIGNAL: the PAN 4th-char / the entity char in the GSTIN classifies the legal entity — C/F/T/H ⇒ B2B (high confidence); P ⇒ a lean-B2C HINT only (an individual can still run a registered business, so it defers to PNS / a clear business persona / a GSTIN).',
  qty_rollup: 'Classify EACH requirement retail-vs-wholesale from its PRODUCT + QUANTITY (category-relative — never a hard-coded number). Roll up: >66% wholesale → "Mostly wholesale", >66% retail → "Mostly retail", else "Mixed". Entity type breaks a near-50/50 tie only. Omit if fewer than 2 requirements carry a usable product+qty.',
  own_qty_cadence: "procurement_model=Bulk REQUIRES the buyer's OWN commercial-scale order quantity (never inferred from listed-seller / registered-entity status). A same requirement re-posted within ~7 days is a RE-SEARCH (supplier not yet found), NOT Recurring.",
  cadence_7d: 'Recurring ONLY when distinct BuyLeads are spaced >7 days apart; a re-post within ~7 days is a re-search, not recurring. Scoped to THIS requirement, shown with it.',
  explicit_only_needsinput: 'Emit ONLY on an explicit buyer statement (PNS/call or WhatsApp); otherwise OMIT — it surfaces in the needs_input list, never guessed.',
  explicit_only_urgency: 'Emit ONLY when a delivery timeframe is explicitly stated (buyer statement / ISQ field); if absent, OMIT and emit urgency instead.',
  language_buyer_authored: 'Responsiveness grounded in REAL two-way behaviour (a one-tap auto-reply + a low campaign response-rate are NOT "responsive"). Language emitted ONLY from a buyer-authored message or spoken words — never our outbound campaigns or auto-generated enquiry text.',
  verified_address_lock: 'VERIFIED-ADDRESS LOCK: a Befisc/Sign3/GST address that AGREES with the registered Profile city CONFIRMS the operating city — do NOT flip on a spoken "near the seller" (that is a sourcing hint). PAN-only / no verified address ⇒ the registered city is a STRONG anchor; never promote a browse/BuyLead/SIM sourcing city to operating.',
  recency_ignore_expiry: 'Judge from CURRENT-STAGE signals only; an OLD / expired lead is PAST demand and NEVER lowers current intent. Dormant only when there are NO live signals at all. Do not call "Hot" off a single one-tap "YES".',
};

export interface RulebookEntry {
  /** always 'LLM' — the attribute is inferred, not a parser fact */
  engine: 'LLM';
  policyId: PolicyId;
  /** the policy's human label, e.g. "Identity & Business Classification" */
  policy: string;
  /** one-line policy philosophy */
  philosophy: string;
  /** the policy's source-priority chain, verbatim — the "expected logic" the LLM should follow */
  priority: string;
  /** freshness applies (behaviour/intent) vs pinned (registrations) */
  freshnessSensitive: boolean;
  /** the special-logic rule id, if this attribute has one */
  rule?: AttributeRuleId;
  /** the special-logic rule text (shown as "rule:" in the debug banner) */
  note?: string;
}

// Attribute → { policy, rule? }. Covers every emitted attribute (kept 1:1 with the extract key enum — no fixed count in the comment so it can't drift), grouped WHO/WHAT/HOW/WHERE/WHY/RISK.
export const ATTR_POLICY: Record<string, { policy: PolicyId; rule?: AttributeRuleId }> = {
  // ── WHO · Identity ──────────────────────────────────────────────────────
  business_persona: { policy: 'IDENTITY' },
  business_type: { policy: 'IDENTITY' },
  sub_industry: { policy: 'IDENTITY' },
  scale: { policy: 'IDENTITY' },
  business_stage: { policy: 'IDENTITY' },
  buyer_maturity: { policy: 'IDENTITY' },
  business_story: { policy: 'IDENTITY' },
  decision_maker: { policy: 'IDENTITY' },
  annual_turnover: { policy: 'IDENTITY' },
  // ── WHAT · Procurement ──────────────────────────────────────────────────
  products_of_interest: { policy: 'PROCUREMENT' },
  procurement_model: { policy: 'PROCUREMENT', rule: 'own_qty_cadence' },
  purchase_frequency: { policy: 'PROCUREMENT', rule: 'cadence_7d' },
  annual_procurements: { policy: 'PROCUREMENT' },
  procurement_approach: { policy: 'PROCUREMENT' },
  use_case: { policy: 'PROCUREMENT' },
  // ── HOW · Buying Behaviour ──────────────────────────────────────────────
  price_vs_quality: { policy: 'BEHAVIOUR' },
  preferred_suppliers: { policy: 'BEHAVIOUR' },
  procurement_challenge: { policy: 'BEHAVIOUR' },
  communication: { policy: 'BEHAVIOUR', rule: 'language_buyer_authored' },
  payment_mode: { policy: 'BEHAVIOUR', rule: 'explicit_only_needsinput' },
  delivery_timeline: { policy: 'BEHAVIOUR', rule: 'explicit_only_urgency' },
  urgency: { policy: 'BEHAVIOUR' },
  // ── WHY · Intent ────────────────────────────────────────────────────────
  buyer_intent: { policy: 'INTENT', rule: 'recency_ignore_expiry' },
  business_objective: { policy: 'INTENT' },
  deal_readiness: { policy: 'INTENT' },
  // ── WHERE · Market ──────────────────────────────────────────────────────
  location_sourcing_preference: { policy: 'MARKET', rule: 'verified_address_lock' },
  sourcing_channel: { policy: 'MARKET' },
  sales_geography: { policy: 'MARKET' },
  target_customers: { policy: 'MARKET' },
  selling_channel: { policy: 'MARKET' },
  // ── RISK · Trust ────────────────────────────────────────────────────────
  identity_confidence: { policy: 'TRUST' },
  digital_footprint: { policy: 'TRUST' },
  // ── Business Classification ─────────────────────────────────────────────
  retail_wholesale: { policy: 'CLASSIFICATION', rule: 'qty_rollup' },
  b2b_b2c: { policy: 'CLASSIFICATION', rule: 'entity_char' },
  primary_language: { policy: 'CLASSIFICATION', rule: 'language_buyer_authored' },
};

/** Return the resolved rulebook entry (policy + expected chain + special rule) for
 *  an attribute key, or null when the attribute is deterministic (a parser fact) and
 *  carries no priority chain. Tolerant of unknown / future keys. */
export function rulebookFor(key: string | undefined | null): RulebookEntry | null {
  if (!key) return null;
  const m = ATTR_POLICY[key];
  if (!m) return null;
  const p = POLICIES[m.policy];
  return {
    engine: 'LLM',
    policyId: m.policy,
    policy: p.label,
    philosophy: p.philosophy,
    priority: policyOrderText(m.policy),
    freshnessSensitive: p.freshnessSensitive,
    rule: m.rule,
    note: m.rule ? ATTRIBUTE_RULE_TEXT[m.rule] : undefined,
  };
}

/** The attribute keys that reference each policy — used by the prompt builder to
 *  print "these attributes follow Policy X" once, instead of repeating per attribute. */
export function attributesByPolicy(): Record<PolicyId, string[]> {
  const out = { IDENTITY: [], PROCUREMENT: [], BEHAVIOUR: [], INTENT: [], MARKET: [], TRUST: [], CLASSIFICATION: [] } as Record<PolicyId, string[]>;
  for (const [attr, m] of Object.entries(ATTR_POLICY)) out[m.policy].push(attr);
  return out;
}

/** Generate the "# SOURCE POLICIES" prompt section from the canonical data — so the
 *  prompt can NEVER drift from sourcePolicies.ts / ATTR_POLICY. Injected into BOTH the
 *  frontend extract prompt AND the n8n buyer-unified prompt (identical text ⇒ the
 *  dashboard and the standalone obey the same rules). */
export function buildPolicySection(): string {
  const byPolicy = attributesByPolicy();
  const order: PolicyId[] = ['IDENTITY', 'PROCUREMENT', 'BEHAVIOUR', 'INTENT', 'MARKET', 'TRUST', 'CLASSIFICATION'];
  const lines: string[] = [];
  lines.push('# SOURCE POLICIES (FROZEN — how to weigh sources)');
  lines.push('Do NOT invent a source order per attribute. Every attribute below follows ONE of these 7 reusable policies. The policy fixes the SOURCE ORDER (highest-trust first, "A > B" means A wins a conflict); the per-attribute note in # QUESTIONS refines only the special LOGIC. WEIGH sources by policy order + authority — never merely COUNT how many mention a thing. Web (Parallel Google + Gemini web) is NEVER an identity/trust source — it is a CONFIDENCE AMPLIFIER only: when it matches a hard anchor (GST / PAN / legal name / city) it RAISES confidence; it never sets or overrides a verified fact.');
  lines.push('');
  for (const id of order) {
    const p = POLICIES[id];
    lines.push(`POLICY ${id} — ${p.label}`);
    lines.push(`  order: ${p.order.join(' > ')}`);
    lines.push(`  freshness: ${p.freshnessSensitive ? 'RECENT evidence outranks old (freshness bites)' : 'freshness = 100 (verified registrations do not go stale)'}`);
    lines.push(`  why: ${p.philosophy}`);
    lines.push(`  attributes: ${(byPolicy[id] || []).join(', ')}`);
    lines.push('');
  }
  lines.push('AUTHORITATIVE FOR — what each source OWNS. This is how you answer "we had this data, why didn\'t we use it?": a source outside its authority is at most Corroborative/Supporting for an attribute, never Primary.');
  for (const [src, owns] of Object.entries(SOURCE_AUTHORITY)) lines.push(`  ${src}: ${owns}`);
  lines.push('');
  lines.push('EVIDENCE ROLES — tag EACH source you consider, per attribute (the role is contextual — the same source can be Primary here and Corroborative there):');
  lines.push('  Primary (decides the value) · Authoritative (a verified registration that owns the field) · Behavioural (spoken/written buyer behaviour) · Historical (a repeated pattern over time) · Interest (browsing/discovery only) · Corroborative (agrees → raises confidence, cannot decide alone) · Supporting (adds explanation, never changes the verdict) · Conflict (disagrees → lowers confidence, list it in contradictions) · Ignored (available but a higher-priority source won — give the reason) · Missing (an expected source was absent → lower confidence).');
  lines.push('');
  lines.push(`REQUIREMENTS ARE DYNAMIC: a SINGLE requirement is only SUPPORTING evidence (one RFQ can be mis-classified — a vague title, a wrong category). But >=${REQUIREMENT_PATTERN.minDistinct} DISTINCT (non-re-search) requirements in the same category cluster spanning >=${REQUIREMENT_PATTERN.windowDays} days = PRIMARY historical procurement evidence — trust the repeated pattern. So do not treat "Requirements" as uniformly weak: weak for one lead, strong as a consistent pattern.`);
  lines.push('');
  lines.push('CROSS-SOURCE CORROBORATION drives confidence: it is not only "which source is highest" but "which OTHER sources agree". Three independent sources agreeing (e.g. GST=Manufacturer + a repeated Requirement pattern + a PNS "we manufacture") is HIGH confidence because they converge — record them in agreement.agreeing. Sources that disagree go in agreement.conflicting AND contradictions, and LOWER confidence.');
  return lines.join('\n');
}
