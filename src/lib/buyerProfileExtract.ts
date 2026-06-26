// ─── BUYER PROFILE EXTRACTOR (LLM-native, NO regex facts) ───────────────────────────────────────────────────
// The "no facts regex" path the owner locked: feed the WHOLE rich n8n response (bi-user-insights — per-source
// summaries) to ONE exhaustive LLM call that extracts the buyer profile, per field { value · state · confidence ·
// sources · evidence · reasoning }. It REUSES the existing render/trace/eval contracts — output maps to FinalAttr
// (synthesisEngine), evidence is the SAME evidence_id (fN) scheme assembleBundle uses, so evMapAll / verifyLLMOutput
// / synthEval / the per-attribute drill all keep working. The deterministic regex/persona path stays as the fallback.
//
// KEY DESIGN: the citable EVIDENCE is the source SUMMARIES flattened (pure structural walk — NOT regex tag-mining).
// The model cites fN ids that resolve to a real summary line, so grounding + the hallucination guard are honest.
// Deterministic + harnessed in scripts/extracttest.mjs (only the gemini round-trip is async/env-gated).

import type { SynthBundle } from './profileSynth';
import type { FinalAttr } from './synthesisEngine';
import type { SynthLLMOut } from './gemini';
import { attrMeta } from './personaRegistry';

export const EXTRACT_PROMPT_VERSION = 'extract-v4'; // v4: removed repeat_buyer · next_best_seller_action · purchasing_power(→deterministic) · urgency; added buyer_maturity · purchase_frequency · delivery_timeline(explicit-only) · digital_footprint; WhatsApp location → evidence; expired leads = NEUTRAL (content still used, expiry never discards data)

// the new n8n response shape (bi-user-insights): { glid, fetched_at, derived_anchors, sources:{ key:{summary,raw} } }
export interface RichResponse { glid?: string | number; fetched_at?: string; derived_anchors?: Record<string, unknown>; sources?: Record<string, { summary?: unknown; raw?: unknown } | unknown>; }
// one LLM attribute — a strict SUPERSET of SynthLLMOut's attribute (adds state/sources/evidence). reasoning_steps
// drive grounding exactly like the synthesis path, so the per-attribute reasoning drill + grounded badge work free.
export interface ExtractAttr { key: string; value: string; state?: BuyerFieldState; confidence: number; grounded?: boolean; sources?: string[]; evidence?: string[]; reasoning_steps?: Array<{ claim: string; from_evidence?: string[]; rejected?: string; delta?: number }>; }
export interface ExtractBuyerProfileOut { attributes: ExtractAttr[] }
export type BuyerFieldState = 'Confirmed' | 'Likely' | 'Conflicted' | 'Unknown';

// human label for each source key (for the catalog + evidence display)
const SRC_LABEL: Record<string, string> = {
  csl: 'CSL · on-site behaviour', pns: 'PNS · sales calls (spoken)', rfq: 'Previous BuyLeads', isq: 'Previous ISQ specs',
  whatsapp_conversations: 'WhatsApp (buyer messages = signal · ours = context)', whatsapp_inbound: 'WhatsApp inbound',
  profile: 'Profile (identity)', usersince: 'GLUSR (tenure)', befisc: 'Befisc (observed external)', sign3: 'Sign3 (observed external)',
  // V10 (owner): the n8n now merges the redundant feeds + triangulates identity before the LLM ever sees them
  requirement: 'Requirement · BuyLeads + answered-ISQ pool (status · recency · category-named)', whatsapp: 'WhatsApp · one timeline (buyer = signal · ours = context)',
  identity: 'Identity · triangulated name/location/income (Profile ⊕ Befisc ⊕ Sign3)',
};
// plumbing/meta keys inside summaries that are not buyer evidence
const SKIP_KEY = /^(observed_only|txn_id|api_category|api_name|billable|datetime|message|parse_ok|parse_error|status|fetched_at|glid|csl_activity)$/i;

// ── flatten a source SUMMARY into citable evidence lines (pure structural — NO regex extraction) ──
function flattenInto(node: unknown, src: string, path: string, push: (src: string, tag: string, raw: unknown) => void): void {
  if (node == null || node === '' || node === false) return;
  if (Array.isArray(node)) {
    node.forEach((el, i) => {
      if (el && typeof el === 'object') flattenInto(el, src, path ? `${path}[${i}]` : `[${i}]`, push);
      else if (el != null && el !== '') push(src, path || 'item', el);
    });
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) { if (SKIP_KEY.test(k)) continue; flattenInto(v, src, path ? `${path}.${k}` : k, push); }
    return;
  }
  push(src, path || 'value', node);
}

// ── SELF-DESCRIBING composers (owner: "f44='true' is useless — i don't see all my intended data here") ──
// The generic structural walk exploded each requirement/timeline turn into bare leaf scalars ("true", "30",
// "21-MAY-26") that carry no context. For the two merged sources the buyer profile leans on most, emit ONE rich,
// human-readable line per unit so a single cited fN carries ALL the intended data (title · category · status ·
// expiry · recency · specs · note for a lead; sender · kind · text for a WhatsApp turn). Everything else still
// uses flattenInto. This makes both the LLM input AND the L5 citation drill legible.
const _obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const _arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const _s = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();

function composeRequirements(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const sum = _obj(summary);
  const reqs = _arr(sum.requirements);
  if (!reqs.length) return false; // v9.5 shape (items/answered_specs) → let flattenInto handle it
  reqs.forEach((it, i) => {
    const r = _obj(it);
    const title = _s(r.title) || _s(r.category) || 'requirement';
    const expired = r.is_expired === true || /expired/i.test(_s(r.status));
    const parts: string[] = [`BuyLead "${title}"`];
    if (_s(r.category) && _s(r.category) !== title) parts.push(`category ${_s(r.category)}`);
    parts.push(`status ${_s(r.status) || (expired ? 'expired' : 'active')}`);
    parts.push(expired ? 'EXPIRED (past demand — not a current-intent signal)' : 'ACTIVE');
    if (r.recency_days != null && _s(r.recency_days)) parts.push(`age ${_s(r.recency_days)}d`);
    if (_s(r.posted)) parts.push(`posted ${_s(r.posted)}`);
    if (_s(r.expiry)) parts.push(`expiry ${_s(r.expiry)}`);
    const specs = _obj(r.specs); const specStr = Object.entries(specs).map(([k, v]) => `${k}=${_s(v)}`).filter((x) => !/=$/.test(x)).join(', ');
    if (specStr) parts.push(`specs: ${specStr}`);
    if (_s(r.description)) parts.push(`note: "${_s(r.description)}"`);
    push(src, `requirement[${i}]${expired ? '·expired' : ''}`, parts.join(' · '));
  });
  // deterministic products-of-interest (BuyLead titles + answered-ISQ categories) as ONE line the LLM confirms
  const poi = _arr(sum.products_of_interest).map(_s).filter(Boolean);
  if (poi.length) push(src, 'products_of_interest', poi.join(' · '));
  const counts: string[] = [];
  if (sum.active_count != null) counts.push(`active ${_s(sum.active_count)}`);
  if (sum.total_count != null || sum.count != null) counts.push(`total ${_s(sum.total_count ?? sum.count)}`);
  if (counts.length) push(src, 'requirement_counts', counts.join(' · '));
  return true;
}

function composeWhatsApp(summary: unknown, src: string, push: (src: string, tag: string, raw: unknown) => void): boolean {
  const sum = _obj(summary);
  const tl = _arr(sum.timeline);
  if (!tl.length) return false; // legacy shape → flattenInto
  tl.forEach((t, i) => {
    const o = _obj(t);
    const text = _s(o.text); if (!text) return;
    const side = /buyer/i.test(_s(o.side)) ? 'buyer' : 'ours';
    const kind = _s(o.kind) || 'message';
    const ts = _s(o.ts) ? ` @${_s(o.ts)}` : '';
    push(src, `wa[${i}]·${side}`, `[${side} · ${kind}${ts}] "${text}"${side === 'ours' ? '  (OUR outbound — context only, NOT buyer intent)' : ''}`);
  });
  const taps = _arr(sum.button_taps).map(_s).filter(Boolean);
  if (taps.length) push(src, 'button_taps', `buyer tapped: ${taps.join(' · ')}`);
  const enq = _arr(sum.products_enquired).map(_s).filter(Boolean);
  if (enq.length) push(src, 'products_enquired', `buyer enquired: ${enq.join(' · ')}`);
  // WhatsApp LOCATION → first-class evidence (owner: WA location must reach the LLM, not stay buried in raw turns).
  // buyer-stated location / "Located near me" / sourcing hints + the cities of sellers the buyer engaged with.
  const loc = _arr(sum.location_preference).map(_s).filter(Boolean);
  if (loc.length) push(src, 'location_preference', `buyer location / sourcing hint(s): ${loc.join(' · ')}`);
  const sc = _arr(sum.seller_cities).map(_s).filter(Boolean);
  if (sc.length) push(src, 'seller_cities', `cities of sellers the buyer engaged: ${sc.join(' · ')}`);
  const c = _obj(sum.counts);
  if (Object.keys(c).length) push(src, 'wa_counts', Object.entries(c).map(([k, v]) => `${k} ${_s(v)}`).join(' · '));
  return true;
}

// ── build the SynthBundle (catalog + fN evidence + empty arithmeticPrior) from the rich response SUMMARIES ──
export function bundleFromResponse(resp: RichResponse): SynthBundle {
  const sources = (resp && typeof resp === 'object' && resp.sources && typeof resp.sources === 'object') ? resp.sources as Record<string, { summary?: unknown }> : {};
  const evidence: SynthBundle['evidence'] = [];
  const perSource: Record<string, number> = {};
  let n = 0;
  const push = (src: string, tag: string, raw: unknown) => {
    const v = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (!v || v === '-' || v === 'null' || v === 'undefined') return;
    evidence.push({ evidence_id: `f${++n}`, node: SRC_LABEL[src] || src, tag, raw: v, role: 'available' }); // V10 (owner #4/#13): NO per-line cap — a GSM value / sourcing city / trial qty buried past char 220 must reach the LLM. Cost optimized LATER.
    perSource[src] = (perSource[src] || 0) + 1;
  };
  // derived_anchors → first-class identity evidence (so identity fields can cite them)
  if (resp.derived_anchors && typeof resp.derived_anchors === 'object') flattenInto(resp.derived_anchors, 'profile', 'anchor', push);
  // V10 (owner: "nothing in between"): when the n8n emits the MERGED sources, the LLM sees ONLY them — the legacy
  // split feeds are superseded (they're still emitted for back-compat display consumers, but feeding both would
  // double-count the same BuyLeads/WA turns and inflate the context). Merged absent ⇒ fall back to the legacy keys.
  const superseded = new Set<string>();
  if (sources.requirement) { superseded.add('rfq'); superseded.add('isq'); }
  if (sources.whatsapp) { superseded.add('whatsapp_conversations'); superseded.add('whatsapp_inbound'); }
  for (const [src, val] of Object.entries(sources)) {
    if (superseded.has(src)) continue;
    const summary = (val && typeof val === 'object' && 'summary' in (val as Record<string, unknown>)) ? (val as { summary?: unknown }).summary : val;
    // self-describing composers for the two merged sources (one rich line per lead / per turn); else generic walk
    if (src === 'requirement' && composeRequirements(summary, src, push)) continue;
    if (src === 'whatsapp' && composeWhatsApp(summary, src, push)) continue;
    flattenInto(summary, src, '', push);
  }
  const catalog = Object.keys(perSource).map((src) => ({ node: SRC_LABEL[src] || src, api: 'bi-user-insights_my', transform: 'llm' as const, rawCount: perSource[src], roles: { available: perSource[src] } }));
  return { catalog, evidence, arithmeticPrior: [] };
}

// ── the exhaustive extraction prompt (source guide · provenance · priority · golden rule · hallucination guard · schema) ──
export const EXTRACT_BUYER_PROFILE_SYSTEM = [
  'You are the BUYER PROFILE EXTRACTOR for an India B2B marketplace (IndiaMART RFQ / BuyLead). From the buyer evidence',
  'below you extract a STRUCTURED BUYER PROFILE — one attribute per line — grounded ONLY in the evidence ids, never invented.',
  '',
  'YOUR JOB (responsibilities — frozen): ANSWER the frozen Buyer Profile questions below. Do NOT summarize, do NOT invent,',
  'do NOT editorialize, do NOT rank beyond what a question asks. Answer ONLY from the supplied evidence ids, and prefer',
  'sources per the priority order stated for each question. Every answer = value + confidence + grounded reasoning citing real fN.',
  '',
  'SOURCE DEFINITIONS (each evidence id is tagged with its source — what the data IS, and how to trust it):',
  '- PNS · sales calls = AI-distilled insights from IndiaMART cloud-telephony recordings of seller↔buyer phone calls — the buyer SPOKE → HIGHEST trust for intent / requirement / location.',
  '- WhatsApp · one timeline = the buyer\'s WhatsApp activity merged into ONE chronological thread. Turns tagged side:buyer (their own messages/enquiries → first-class signal) are interleaved with side:ours (our offers/prompts → CONTEXT only, never the buyer\'s intent).',
  '- CSL · on-site behaviour = the buyer\'s on-site searches + product/category views (a "×N" suffix = repeat count = signal strength).',
  '- Requirement = the buyer\'s posted BuyLeads (the requirement spine: title · status · is_expired · recency_days) plus a SEPARATE pool of the ISQ specs they answered (category NAME + spec values = reusable buyer memory). Each lead carries is_expired + recency_days — an EXPIRED or old lead is NOT a current hot requirement. CRITICAL — expired ≠ ignore: an expired lead\'s specs, category and products REMAIN fully usable buyer-memory evidence (cite them freely for persona / products_of_interest / procurement). "Expired" only means "not a CURRENT-intent signal" — it NEVER means discard or reject the content of that lead.',
  '- identity = name + location + income TRIANGULATED across Profile, Befisc and Sign3, with agreement flags. company_known:false means UNKNOWN — NEVER infer "Individual" from a blank company.',
  '- Profile / GLUSR = the buyer\'s registered identity + account tenure (member-since / last-active).',
  '- Befisc = paid external identity lookup (verified name, income band). Sign3 = paid external digital-footprint / trust (verified name, social-presence count). Income band = a purchasing-power HINT, not a hard driver. (phone_circle / SIM telecom-circle, if ever present, is NOT the buyer\'s location.)',
  '',
  'PRIORITY when evidence conflicts (higher wins): PNS > WhatsApp(buyer) > Befisc/Sign3 > CSL > Requirement(BuyLeads/ISQ).',
  'PROVENANCE: infer ONLY from buyer-originated evidence; never infer a trait from our outbound messages (WhatsApp side:ours = products WE pitched, NOT products the buyer wants), matched sellers,',
  'or platform-deduced fields (Probable Order Value / Requirement Type) — validate against them at most.',
  '',
  'ANSWER THESE FROZEN BUYER USE-CASES (triangulate across the cited sources in the priority order; emit ONE attribute per use-case, combined — do NOT split into redundant rows):',
  '- location_sourcing_preference = where the buyer OPERATES + every distinct city they SOURCE-FROM. Emit BOTH the operating city AND ALL sourcing cities when they differ (e.g. "Operates in Auraiya · Sources from Kanpur, Delhi") — do NOT collapse multiple sourcing cities to one. Priority: PNS > Befisc/Sign3 > WhatsApp(buyer-stated location / "near me" / seller cities) > CSL > Profile.',
  '- business_persona = business_type AND industry as ONE (format "<type> · <industry>", both DERIVED from this buyer\'s own evidence — never a default category). Priority: PNS persona > BuyLead/ISQ product cluster > CSL. (Displayed to the seller as "Buyer Persona".)',
  '- buyer_maturity = the buyer\'s business lifecycle stage: "New-entrant" (setting up a new unit / first venture / just installed machines) vs "Established". Read it from PNS seller-DISCOVERY questions ("Are you setting up a unit or already working?", "Have you installed the machines?", "What business did you do before this?") and "new venture / startup" call narratives. New-entrant ONLY when those signals appear; else Established. (This is the read that distinguishes "Entrepreneur setting up a notebook unit" from a generic "Manufacturer".)',
  '- products_of_interest = the buyer\'s product lines. RANK by relevance to the buyer\'s CURRENT / core line (most recent + repeated categories first); DEMOTE clearly off-core one-offs (e.g. a stray vehicle / hardware lead for a paper buyer). Surface the top 3 most-relevant. If fewer than 3 are clearly on-core, fill with the next best, but mark them as the lower-relevance tail. Cite the evidence ids for each.',
  '- buyer_intent = the buyer\'s CURRENT purchasing SERIOUSNESS + STAGE as ONE read (Low/Medium/High + lifecycle stage: Browsing / Comparing / Ready-to-buy). Read it from CURRENT-STAGE signals ONLY, in this order: PNS call seriousness + callback-urgency (spoken intent is strongest), recent on-site browsing (CSL repeat views = active research), live WhatsApp activity (real enquiries, not one-tap auto-replies), and FRESH (non-expired) BuyLeads. CRITICAL: an EXPIRED or old BuyLead is PAST demand — it is NOT evidence of low intent. Do NOT downgrade to Dormant/Cold merely because the leads are expired; IGNORE expiry as a negative signal and judge intent purely from the live signals above. Only when there are NO live signals at all (no recent calls, no browsing, no live WhatsApp, no fresh leads) is the buyer genuinely Dormant. Equally, do NOT call them "Hot" off a single one-tap WhatsApp "YES" auto-reply.',
  '- identity_confidence = how corroborated the identity is: High when name AND city agree across >=2 of {Profile, Befisc, Sign3}; Medium with one strong verified source; Low otherwise. This is a TRUST signal, not a behavioral trait.',
  '- delivery_timeline = the buyer\'s required DELIVERY timeframe — emit ONLY when EXPLICITLY stated: a spec/ISQ field, or the buyer literally said "same day" / "within 15 days" / "this month" / a date. Output the concrete timeframe verbatim. If it is NOT explicitly stated, OMIT this attribute entirely — do NOT infer it from callback-urgency or general eagerness.',
  '- price_vs_quality = ONE axis (Price-sensitive / Balanced / Quality-led) from WhatsApp objections + PNS rate-talk.',
  '- procurement_model = One-time / Recurring / Bulk (distinct repeat purchases = recurring; same spec re-posted close in time = re-posted, NOT recurring).',
  '- purchase_frequency = how often the buyer procures this line — One-time / Occasional / Recurring (state the cadence when evidenced, e.g. "Recurring · multiple leads over ~3 weeks") — from PNS order_types(Recurring) + the cadence of distinct prior BuyLeads. Recurring ONLY when repeat procurement is actually evidenced.',
  '- communication = preferred channel + responsiveness + language as ONE (e.g. "Phone+WhatsApp · highly responsive · Hindi").',
  '- digital_footprint = the buyer\'s verified digital tenure + presence as ONE: IndiaMART member-since / tenure + social-platform presence (e.g. Instagram, Facebook, Flipkart) + telecom circle, drawn from identity/external. State ONLY what the evidence carries — do NOT invent a per-platform "since N years" if the data has only presence, and do NOT invent a member-since if absent.',
  '(Identity name/mobile/email/GST/PAN, income/purchasing-power band, age/gender/DOB and trust score are handled DETERMINISTICALLY upstream (single-source passthrough) — do NOT emit them here.)',
  '',
  'GOLDEN RULE: if there is no supporting evidence for a use-case, OMIT it (state "Unknown", confidence 0) — NEVER guess.',
  'HALLUCINATION GUARD: every attribute MUST carry reasoning_steps; every step MUST cite >=1 real evidence id (fN).',
  '  Set "grounded": false if the VALUE introduces any term/spec/place NOT present in or entailed by the cited lines',
  '  (e.g. a transliteration, an embellishment, an over-specific number). Only set "grounded": true when every word of the',
  '  value is supported by the cited evidence. confidence >=70 only when >=2 ids agree OR one strong spoken (PNS) id.',
  '  CONFIDENCE FORMULA (interpretable, not a vibe): evidence quality + source authority (PNS / WhatsApp-buyer highest)',
  '  + cross-source agreement − contradictions − missing/weak evidence. So 2+ high-authority sources agree → 85-95; one',
  '  strong spoken (PNS) signal → 75-90; a single weak/indirect signal → 50-70; contradicted or thin → below 50 (grounded likely false).',
  '  India-B2B patterns (trial-before-bulk, price sensitivity, local-supplier preference, recurring procurement) apply ONLY when cited.',
  '',
  'OUTPUT — strict JSON: { "attributes": [ {',
  '  "key": "business_persona|sub_industry|products_of_interest|buyer_intent|buyer_maturity|scale|',
  '          procurement_model|purchase_frequency|communication|price_vs_quality|delivery_timeline|location_sourcing_preference|identity_confidence|digital_footprint",  // V11: identity_confidence = trust signal; NO raw name/PAN/DOB/income as a behavioral attribute (those are deterministic upstream).',
  '  "value": "<concise value>",',
  '  "state": "Confirmed|Likely|Conflicted|Unknown",',
  '  "confidence": 0-100,        // YOUR honest self-assessed confidence',
  '  "grounded": true|false,     // YOUR honest self-assessment: is every word of the value supported by the cited lines?',
  '  "sources": ["PNS","CSL", …],',
  '  "reasoning_steps": [ { "claim": "<why>", "from_evidence": ["f3","f12"], "rejected": "<alt ruled out, optional>", "delta": <+points> } ]',
  '} ] }',
  'Extract every use-case you can ground; OMIT use-cases with no evidence (do not emit Unknown rows). Return ONLY the JSON.',
].join('\n');

// v7 ships `source_registry` (per-source trust + role flags) + `source_priority` (per-dimension order). When present we
// render them as AUTHORITATIVE guidance so the pipeline owns provenance/priority (instead of our static copy drifting).
export interface SourceGuide { source_registry?: Record<string, Record<string, unknown>> | null; source_priority?: Record<string, unknown> | null }
function renderSourceGuide(g?: SourceGuide | null): string {
  if (!g) return '';
  const reg = g.source_registry && typeof g.source_registry === 'object' ? g.source_registry : null;
  const pri = g.source_priority && typeof g.source_priority === 'object' ? g.source_priority : null;
  const out: string[] = [];
  if (reg) {
    out.push('SOURCE GUIDE — AUTHORITATIVE (from the live pipeline; overrides the generic guide; trust + role per source):');
    for (const [k, v] of Object.entries(reg)) {
      const r = v as Record<string, unknown>;
      const inf = ['persona', 'intent', 'requirement_generation', 'trust_score'].filter((d) => r[`should_influence_${d}`] === true).map((d) => d.replace('_generation', '').replace('_score', '')).join('/');
      out.push(`- ${SRC_LABEL[k] || k} [trust:${r.trust_level || '?'}]${r.observed_only ? ' OBSERVED-ONLY (corroboration, never primary intent)' : ''} — ${String(r.purpose || r.description || '')}${inf ? ` · influences: ${inf}` : ' · influences: none'}`);
    }
  }
  if (pri) {
    const fmt = (d: string) => Array.isArray((pri as Record<string, unknown>)[d]) ? ((pri as Record<string, unknown>)[d] as unknown[]).map((x) => SRC_LABEL[String(x)] || String(x)).join(' > ') : null;
    const rows = ['persona', 'intent', 'requirement', 'trust'].map((d) => { const f = fmt(d); return f ? `  ${d}: ${f}` : ''; }).filter(Boolean);
    if (rows.length) { out.push('', 'CONFLICT PRIORITY — AUTHORITATIVE (higher wins; use these orders per dimension):', ...rows); }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

export function buildExtractPrompt(bundle: SynthBundle, anchors?: Record<string, unknown> | null, guide?: SourceGuide | null): { system: string; user: string; evidenceIds: Set<string> } {
  const anchorLine = anchors && Object.keys(anchors).length ? 'IDENTITY ANCHORS (pre-resolved — corroborate, treat as identity not intent): ' + JSON.stringify(anchors) : '';
  const user = [
    renderSourceGuide(guide),
    anchorLine,
    `BUYER EVIDENCE — cite these ids (fN) in from_evidence (the ONLY citable evidence; ${bundle.evidence.length} lines):`,
    ...bundle.evidence.map((e) => `  [${e.evidence_id}] (${e.node} · ${e.tag}) ${e.raw}`),
    '',
    'Extract the buyer profile per the schema. Cite real fN ids in every reasoning step. OMIT ungrounded fields.',
  ].filter(Boolean).join('\n');
  return { system: EXTRACT_BUYER_PROFILE_SYSTEM, user, evidenceIds: new Set(bundle.evidence.map((e) => e.evidence_id)) };
}

// deterministic state when the model omits it (keeps the STATE pill honest)
function deriveState(value: string, confidence: number, grounded: boolean, hasRejected: boolean): BuyerFieldState {
  const v = String(value || '').trim();
  if (!v || /^(unknown|—|-|n\/?a|none)$/i.test(v)) return 'Unknown';
  if (hasRejected) return 'Conflicted';
  if (grounded && confidence >= 70) return 'Confirmed';
  if (grounded && confidence >= 50) return 'Likely';
  return grounded ? 'Likely' : 'Unknown';
}

// ── map the LLM output → FinalAttr[] (mirror of synthesisEngine.llmFinals + the additive `state`) ──
export function extractedToFinals(out: ExtractBuyerProfileOut | SynthLLMOut | null, evidenceIds: Set<string>): FinalAttr[] {
  const attrs = (out && Array.isArray((out as ExtractBuyerProfileOut).attributes)) ? (out as ExtractBuyerProfileOut).attributes : [];
  const finals: FinalAttr[] = [];
  for (const la of attrs as ExtractAttr[]) {
    if (!la || !la.key) continue;
    const steps = la.reasoning_steps || [];
    const cites = steps.flatMap((s) => s.from_evidence || []);
    const idsResolve = cites.length > 0 && cites.every((id) => evidenceIds.has(id)); // code cross-check: do all cited ids exist?
    const resolveCount = cites.filter((id) => evidenceIds.has(id)).length;
    // V10 (owner #12): the model SELF-REPORTS grounded (value-entailment, not just id-existence). Trust it; fall back to
    // the id-resolution cross-check only when the field is absent. confidence is the model's honest self-assessment (no floor).
    const grounded = (typeof la.grounded === 'boolean') ? la.grounded : idsResolve;
    const hasRejected = steps.some((s) => !!s.rejected);
    const reasoning = steps.map((s) => ({ claim: s.claim, evidence: s.from_evidence || [], rejected: s.rejected }));
    const m = attrMeta(la.key);
    const confidence = la.confidence ?? 0;
    const state = (la.state && ['Confirmed', 'Likely', 'Conflicted', 'Unknown'].includes(la.state)) ? la.state : deriveState(la.value, confidence, grounded, hasRejected);
    finals.push({
      key: la.key, label: m.label, group: m.group, value: la.value, confidence,
      provenance: 'llm-confirmed', state,
      method: `LLM extraction (${EXTRACT_PROMPT_VERSION}) — self-grounded:${grounded} · cited ${cites.length} id(s), ${resolveCount} resolve${la.sources && la.sources.length ? ' · sources: ' + la.sources.join(', ') : ''}`,
      llm: { value: la.value, confidence, reasoning, grounded },
    });
  }
  return finals;
}
