// ── SOURCE POLICIES ─────────────────────────────────────────────────────────
// The FROZEN architecture of the Buyer-Intelligence engine. Instead of 28 bespoke
// per-attribute priority chains we maintain SEVEN reusable Source Policies. Every
// attribute references ONE policy (see attributeRulebook.ts) + an optional
// AttributeRule for the special logic a plain ordering can't express.
//
// Owner-confirmed 2026-07-08. Web is NEVER an identity/trust source — only a
// confidence amplifier when it matches a hard anchor (GST/PAN/name/city).
//
// This module is a LEAF (no imports) so it can be referenced from the prompt
// builders, the deterministic debug/health layer, and the card overlay alike —
// the ONE place both the dashboard (frontend LLM) and the standalone (n8n LLM)
// derive their ordering from, keeping the two surfaces in lock-step.

export type PolicyId = 'IDENTITY' | 'PROCUREMENT' | 'BEHAVIOUR' | 'INTENT' | 'MARKET' | 'TRUST' | 'CLASSIFICATION';

// The role a piece of evidence plays for a given attribute (contextual — the SAME
// source can be Primary under one policy and Corroborative under another).
export type EvidenceRole =
  | 'Primary'          // decides the attribute when present
  | 'Authoritative'    // a verified registration that owns this field
  | 'Behavioural'      // spoken / written buyer behaviour
  | 'Historical'       // a repeated pattern over time (e.g. ≥3 requirements)
  | 'Interest'         // browsing / discovery signal only
  | 'Corroborative'    // agrees → raises confidence, cannot decide alone
  | 'Supporting'       // adds explanation, never changes the verdict
  | 'Conflict'         // disagrees → lowers confidence, enters the contradiction ledger
  | 'Ignored'          // available but intentionally not used (higher-priority evidence won)
  | 'Missing';         // an expected source was unavailable → confidence reduced

export interface Policy {
  id: PolicyId;
  label: string;
  /** source names, highest-trust FIRST. Names match the closed source catalog used in prompts. */
  order: string[];
  /** one-line philosophy shown in debug + baked into the prompt */
  philosophy: string;
  /** does recent evidence outrank old? true for behaviour/intent/procurement; false for registrations */
  freshnessSensitive: boolean;
  /** whether web search can amplify confidence (never decides) */
  webRole: 'amplifier' | 'none';
}

export const POLICIES: Record<PolicyId, Policy> = {
  IDENTITY: {
    id: 'IDENTITY',
    label: 'Identity & Business Classification',
    order: ['GST', 'Udyam', 'External (Sign3 / Befisc / IDfy)', 'PNS', 'IndiaMART Buyer Profile', 'Requirements', 'CSL', 'Web (amplifier)'],
    philosophy: 'Who the buyer IS comes from verified registrations, never from browsing. Web only raises confidence when it matches a hard anchor (GST / PAN / name / city) — it never sets identity.',
    freshnessSensitive: false,
    webRole: 'amplifier',
  },
  PROCUREMENT: {
    id: 'PROCUREMENT',
    label: 'Procurement Intelligence',
    order: ['PNS', 'WhatsApp', 'Requirement + ISQ', 'CSL', 'IndiaMART Buyer Profile', 'Web'],
    philosophy: "What they buy: trust the buyer's OWN words (spoken on PNS calls, typed on WhatsApp) over a system-interpreted RFQ. A single RFQ can be mis-classified; a repeated RFQ pattern is strong historical evidence.",
    freshnessSensitive: true,
    webRole: 'none',
  },
  BEHAVIOUR: {
    id: 'BEHAVIOUR',
    label: 'Buying Behaviour',
    order: ['PNS', 'WhatsApp', 'Requirements', 'CSL', 'IndiaMART Buyer Profile', 'External (Sign3 / Befisc)'],
    philosophy: 'How they buy comes from conversations, not registrations.',
    freshnessSensitive: true,
    webRole: 'none',
  },
  INTENT: {
    id: 'INTENT',
    label: 'Intent',
    order: ['Recent PNS', 'Recent Requirements', 'Recent WhatsApp', 'Recent CSL', 'Historical activity'],
    philosophy: "Why they're active NOW: recent activity always outweighs old. An expired / old lead is past demand — it never lowers current intent.",
    freshnessSensitive: true,
    webRole: 'none',
  },
  MARKET: {
    id: 'MARKET',
    label: 'Market & Location',
    order: ['Verified GST address', 'Udyam', 'Buyer-stated location (PNS)', 'Requirement search-cities', 'CSL', 'Web (amplifier)'],
    philosophy: 'Where they operate / sell into: a verified registered address is decisive, then the buyer’s own stated location, then behavioural search-cities. A "near the seller" mention is sourcing, not operating.',
    freshnessSensitive: false,
    webRole: 'amplifier',
  },
  TRUST: {
    id: 'TRUST',
    label: 'Trust & Verification',
    order: ['IndiaMART Buyer Profile', 'GST', 'PAN', 'Sign3', 'Befisc', 'Web (amplifier)'],
    philosophy: 'How sure we are it is a real, correctly-identified business: multi-vendor agreement on name + city. Web only corroborates.',
    freshnessSensitive: false,
    webRole: 'amplifier',
  },
  CLASSIFICATION: {
    id: 'CLASSIFICATION',
    label: 'Business Classification',
    order: ['GST', 'Udyam', 'Requirements', 'PNS', 'IndiaMART Buyer Profile'],
    philosophy: 'B2B/B2C and retail/wholesale: the legal entity + registrations decide; requirements and calls corroborate.',
    freshnessSensitive: false,
    webRole: 'none',
  },
};

// ── GLOBAL "AUTHORITATIVE FOR" TABLE ────────────────────────────────────────
// The readable summary a reviewer scans to answer "why didn't we use CSL for
// identity?" — because CSL is authoritative only for browsing interest + supplier
// discovery, NOT for identity or classification. Contextual per-attribute roles
// (see EvidenceRole) refine this, but this table is the at-a-glance contract.
export const SOURCE_AUTHORITY: Record<string, string> = {
  'IndiaMART Buyer Profile': 'Identity, member-since, verification status',
  'GST': 'Business type, constitution, industry, registered address',
  'Udyam': 'Scale (MSME band), industry (NIC), organization type',
  'PAN': 'Legal entity class, identity',
  'Requirements': 'Products, quantities, procurement history',
  'ISQ': 'Technical specs, delivery, payment, application',
  'PNS': 'Intent, buying behaviour, communication, decision-maker',
  'WhatsApp': 'Behaviour, language, objections, responsiveness',
  'CSL': 'Browsing interest, supplier discovery',
  'Sign3': 'Digital presence, socials',
  'Befisc': 'KYB verification (identity / PAN / GST)',
  'IDfy': 'KYB verification (PAN↔GST link, GST certificate, EPFO)',
  'Web': 'Supporting evidence / confidence amplifier only',
};

// ── REQUIREMENTS-DYNAMIC RULE ───────────────────────────────────────────────
// A single RFQ is only Supporting evidence (it may be mis-classified / vague).
// A repeated, consistent RFQ pattern is Primary historical procurement evidence.
// Owner-confirmed threshold 2026-07-08.
export const REQUIREMENT_PATTERN = {
  minDistinct: 3,   // ≥3 distinct (non-re-search) requirements …
  windowDays: 30,   // … spanning ≥30 days …
  sameClusterOnly: true, // … in the same category cluster ⇒ Primary; else Supporting.
} as const;

// ── STRUCTURED CONFIDENCE ───────────────────────────────────────────────────
// Confidence is no longer one opaque number. The LLM SELF-REPORTS the breakdown
// (owner choice 2026-07-08) so the debug screen can show WHY a number is what it
// is. Final = source_quality × agreement × freshness − conflict_penalty (the LLM
// applies the formula; the UI renders the components). Freshness is pinned to 100
// for non-freshness-sensitive policies (a GST registration does not go stale).
export interface ConfidenceBreakdown {
  source_quality: number;    // 0-100 — trust/authority of the sources actually used
  agreement: number;         // 0-100 — how strongly the sources agree
  freshness: number;         // 0-100 — recency (100 when the policy is not freshness-sensitive)
  conflict_penalty: number;  // 0-100 — subtracted for contradictions
  final: number;             // 0-100 — the reported final confidence
}

/** A confidence value may be the legacy bare number (old snapshots) or the new
 *  breakdown. Consumers should use confidenceFinal() to read the scalar. */
export type ConfidenceValue = number | ConfidenceBreakdown;

export function isConfidenceBreakdown(c: unknown): c is ConfidenceBreakdown {
  return !!c && typeof c === 'object' && typeof (c as ConfidenceBreakdown).final === 'number';
}

/** Read the single 0-100 scalar from either shape (tolerant of nulls). */
export function confidenceFinal(c: ConfidenceValue | null | undefined): number {
  if (isConfidenceBreakdown(c)) return Math.round(c.final) || 0;
  return typeof c === 'number' ? Math.round(c) || 0 : 0;
}

// ── PER-ATTRIBUTE PROVENANCE (self-reported by the LLM, all tolerant/optional) ──
// This is what powers the debug panel's Available → Used → Ignored → Agreement →
// Contradictions story and directly answers "we had this data — why not used?".
export interface SourceIgnored { source: string; reason: string }
export interface EvidenceRoleTag { source: string; role: EvidenceRole }
export interface AgreementInfo { score: number; agreeing: string[]; conflicting: string[] }
export interface AttributeProvenance {
  policy?: string;                 // the policy the LLM applied, e.g. "IDENTITY"
  sources_available?: string[];    // every source present in the pull that could bear on this attribute
  sources_used?: string[];         // the sources the value was actually derived from
  sources_ignored?: SourceIgnored[]; // available-but-not-used, each with a reason
  evidence_roles?: EvidenceRoleTag[]; // contextual role per source (Primary/Corroborative/…)
  agreement?: AgreementInfo;       // cross-source agreement score + who agreed / conflicted
  contradictions?: string[];       // plain-language conflicts that reduced confidence
}

export function policyFor(id: PolicyId): Policy { return POLICIES[id]; }

/** Human-readable priority chain for a policy — used verbatim in the debug rulebook. */
export function policyOrderText(id: PolicyId): string {
  return POLICIES[id].order.join(' > ');
}
