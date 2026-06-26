// ─── AI INSPECTOR DATA LAYER (V4) ───────────────────────────────────────────────────────────────
// PURE, deterministic, NO LLM. Turns a hovered/pinned element key ("intent", "planner-q:pq-1",
// "spec:Rated Power", "lastpage:payment", "profile") + the form's already-computed state into a typed
// InspectorPayload: decision · evidence · alternatives · suppressed · confidence · source · prompt ·
// tokens · cost · latency · cache · freshness · failure-mode. The AIInspector component just renders it.
// This is the brain ChatGPT/the review asked for: every interactive element becomes inspectable.

export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'info';
export interface InspectorRow { label: string; value?: string; score?: number; sub?: string; tone?: Tone }
export interface InspectorSection { title: string; rows: InspectorRow[] }
export interface InspectorPayload {
  kind: string;
  title: string;
  decision: string;          // the chosen value / headline
  decisionTone: Tone;
  sections: InspectorSection[];
}

// ── the bundle the V4 component feeds in (built from its live state) ──
export interface InspectorState {
  intent?: {
    value: string | null; journey: string; question: string; confidence: number; source: string; locked: boolean;
    candidates?: Array<{ label: string; score: number; reason: string }> | null;
    decision?: { registry?: { value: string; confidence: number } | null; twin?: { value: string; confidence: number; offProfile: boolean } | null; llm?: { value: string; confidence: number } | null; chosenValue: string | null; threshold?: number } | null;
  };
  planner?: { archetype?: string; questions: Array<{ id: string; label: string; tier?: string; priority?: number; reason?: string; groundedIn?: string }>; considered?: Array<{ label: string; score: number; reason: string }> | null; twinResolved?: string[]; twinMode?: string; budgetUsed?: number; budgetMax?: number };
  category?: { status: string; score: number; band: string; consume: boolean; fuse: boolean; criticals?: Array<{ name: string; seller_frequency?: number | null; maps_to_isq?: string }>; blockers?: Array<{ label: string; frequency?: number }>; applications?: string[]; calls?: number; cache?: string; buildAge?: string; version?: string };
  specs?: Array<{ name: string; value?: string; source?: string; status?: string; priority?: number; sellerFreq?: number; reason?: string }>;
  logistics?: Record<string, { value: string; confidence: number; reason: string }>;
  buyer?: { persona?: string; nature?: string; authority?: string; maturity?: string; urgency?: string; twinConfidence?: number; evidenceCount?: number; verified?: boolean; offProfile?: boolean;
    // OLD = API-direct persona (no LLM, straight from the pull); the rest of this object is the NEW LLM-deduced profile.
    apiPersona?: { type?: string; scale?: string; repeatBuyer?: boolean; multiSku?: boolean; whatsappAffinity?: string } };
  llmCalls?: Array<{ label: string; ms: number; model: string; promptVersion?: string; promptTokens?: number; completionTokens?: number; costUsd?: number }>;
  confidence?: { buyer?: number; category?: number; intent?: number; specs?: number; planner?: number; overall?: number };
  overrides?: Array<{ field: string; suggested: string; chosen: string }>;
  // per-element deep detail (the "one-click on every element" ask): raw prompt I/O per LLM label + fact lineage
  llmRaw?: Record<string, { input?: string; output?: string; at: number }>;
  lineage?: Array<{ fact: string; jsonPath: string; api: string | null; value: string | null; sourceNode: string | null; execution: string | null }>;
}

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const fmtCost = (c?: number) => (typeof c === 'number' ? `$${c.toFixed(5)}` : '—');
const bandTone = (band?: string): Tone => (band === 'rich' ? 'good' : band === 'thin' ? 'warn' : 'bad');

// Tier-B FAILURE-MODE classification — the risk a reviewer should worry about for THIS RFQ state.
function failureMode(state: InspectorState): { risk: Tone; label: string } {
  const c = state.category; const conf = state.confidence || {};
  const qCount = state.planner?.questions?.length ?? 0;
  if ((conf.buyer ?? 100) < 35 && (conf.category ?? 100) < 35) return { risk: 'bad', label: 'HIGH · thin evidence (cold buyer + empty category)' };
  if (c && c.status === 'hit' && c.band === 'empty') return { risk: 'warn', label: 'MEDIUM · weak category confidence — buyer-only' };
  if (qCount > 3) return { risk: 'warn', label: `MEDIUM · over-questioning (${qCount} > 3 cap)` };
  if ((conf.overall ?? 0) >= 65) return { risk: 'good', label: 'LOW · grounded decisions' };
  return { risk: 'info', label: 'LOW · nominal' };
}

// the prompt/tokens/cost/latency section for a given LLM label (deriveIntent / planRequirement / …)
function promptSection(state: InspectorState, label: string): InspectorSection | null {
  const calls = (state.llmCalls || []).filter((c) => c.label === label);
  if (!calls.length) return null;
  const c = calls[calls.length - 1];
  const tok = (c.promptTokens || 0) + (c.completionTokens || 0);
  return {
    title: 'Prompt · cost · latency',
    rows: [
      { label: 'prompt', value: `${label} ${c.promptVersion || ''}`.trim(), tone: 'info' },
      { label: 'model', value: c.model || '—' },
      { label: 'tokens', value: tok ? `${tok} (${c.promptTokens || 0}→${c.completionTokens || 0})` : '—' },
      { label: 'cost', value: fmtCost(c.costUsd) },
      { label: 'latency', value: typeof c.ms === 'number' ? `${Math.round(c.ms)}ms` : '—' },
    ],
  };
}

// RAW prompt INPUT → OUTPUT for a label (the "actual payload, not a summary" ask — Q18/Q19 per element).
function rawIOSection(state: InspectorState, label: string): InspectorSection | null {
  const io = state.llmRaw?.[label];
  if (!io || (!io.input && !io.output)) return null;
  return {
    title: `Raw prompt I/O · ${label}`,
    rows: [
      { label: 'INPUT', value: (io.input || '—').slice(0, 400), tone: 'muted', sub: 'actual payload sent to the model' },
      { label: 'OUTPUT', value: (io.output || '—').slice(0, 400), tone: 'info', sub: 'raw model response' },
    ],
  };
}

// FACT LINEAGE for the buyer brain — each fact → exact JSON field → value → emitting n8n node (Q2/Q3/Q4 per element).
function lineageSection(state: InspectorState): InspectorSection | null {
  const ln = state.lineage || [];
  if (!ln.length) return null;
  return {
    title: '🧬 Raw lineage (fact → JSON field → node)',
    rows: ln.slice(0, 12).map((l) => ({
      label: l.fact, value: l.value ?? '—', tone: 'good' as Tone,
      sub: `${l.api ? l.api + ' · ' : ''}${l.jsonPath}${l.sourceNode ? ' · node ' + l.sourceNode : ' · (enable E1 for node)'}${l.execution ? ' · exec ' + l.execution : ''}`,
    })),
  };
}

// ── INTENT ──────────────────────────────────────────────────────────────────────────────────────
function intentPayload(state: InspectorState): InspectorPayload {
  const i = state.intent!;
  const sections: InspectorSection[] = [];
  // Alternatives — the LLM's self-scored end-use ranking ("Manufacturing 92 / Commercial 71 / Residential 12")
  if (i.candidates && i.candidates.length) {
    sections.push({ title: 'Alternatives considered (LLM-scored)', rows: i.candidates.map((c, n) => ({ label: `${n + 1}. ${c.label}`, score: c.score, sub: c.reason, tone: norm(c.label) === norm(i.value || '') ? 'good' : 'muted' })) });
  }
  // Source race — registry > on-profile twin > llm > ask
  if (i.decision) {
    const d = i.decision; const bar = d.threshold ?? 80; const rows: InspectorRow[] = [];
    if (d.registry) rows.push({ label: 'Registry (prior)', value: d.registry.value, score: d.registry.confidence, tone: d.registry.confidence >= bar ? 'good' : 'muted', sub: d.registry.confidence >= bar ? 'CHOSEN — top precedence' : `below ${bar} bar` });
    if (d.twin) rows.push({ label: 'Buyer Twin (active-intent)', value: d.twin.value, score: d.twin.confidence, tone: d.twin.offProfile ? 'bad' : d.twin.confidence >= bar ? 'good' : 'muted', sub: d.twin.offProfile ? 'OFF_PROFILE — never used (no leak)' : d.twin.confidence >= bar ? 'eligible' : `below ${bar} bar` });
    if (d.llm) rows.push({ label: 'LLM derivation', value: d.llm.value, score: d.llm.confidence, tone: d.llm.confidence >= bar ? 'good' : 'muted', sub: d.llm.confidence >= bar ? 'eligible' : `below ${bar} bar → ask` });
    if (rows.length) sections.push({ title: `Source precedence (bar ${bar})`, rows });
  }
  sections.push({ title: 'Evidence', rows: [
    { label: 'journey', value: i.journey || '—' },
    { label: 'question', value: i.question || '—' },
    { label: 'source', value: i.source + (i.locked ? ' · 🔒 locked (buyer-picked)' : ' · soft (derived)') },
  ] });
  const ps = promptSection(state, 'deriveIntent'); if (ps) sections.push(ps);
  const rio = rawIOSection(state, 'deriveIntent'); if (rio) sections.push(rio);
  return { kind: 'intent', title: '🎯 INTENT DECISION', decision: i.value || (i.question ? 'asking the buyer' : 'deriving…'), decisionTone: i.value ? 'good' : 'info', sections };
}

// ── PLANNER QUESTION ──────────────────────────────────────────────────────────────────────────────
function plannerPayload(state: InspectorState, key: string): InspectorPayload {
  const p = state.planner!; const q = p.questions.find((x) => x.id === key || norm(x.label) === norm(key));
  const sections: InspectorSection[] = [];
  if (q) {
    sections.push({ title: 'Why selected', rows: [
      { label: 'priority', value: typeof q.priority === 'number' ? String(q.priority) : '—', score: q.priority, tone: 'good' },
      { label: 'tier', value: q.tier || '—' },
      { label: 'reason', value: q.reason || '—' },
      { label: 'grounded in', value: q.groundedIn || '—', tone: q.groundedIn ? 'info' : 'warn' },
    ] });
  }
  // Suppression ledger — what the planner weighed but dropped (the "why wasn't Site-Ready asked" answer)
  if (p.considered && p.considered.length) {
    sections.push({ title: 'Suppressed / considered (lost)', rows: p.considered.map((c) => ({ label: c.label, score: c.score, sub: c.reason, tone: 'bad' })) });
  }
  // Sibling questions (the rest of the asked set)
  const siblings = p.questions.filter((x) => x !== q);
  if (siblings.length) sections.push({ title: 'Other asked questions', rows: siblings.map((s) => ({ label: s.label, score: s.priority, tone: 'muted' })) });
  if (p.twinResolved && p.twinResolved.length) sections.push({ title: 'Twin already knew (not asked)', rows: p.twinResolved.map((t) => ({ label: t, tone: 'good' })) });
  // Question budget (used vs the 3-cap) + missing-question ledger ("wanted to ask, lacked confidence")
  const used = p.questions.length; const max = p.budgetMax ?? 3;
  sections.push({ title: 'Question budget', rows: [
    { label: 'used / max', value: `${used} / ${max}`, tone: used <= max ? 'good' : 'bad' },
    { label: 'suppressed', value: String(p.considered?.length ?? 0), tone: 'muted' },
  ] });
  const lowConf = (p.considered || []).filter((c) => c.score < 60);
  if (lowConf.length) sections.push({ title: 'Wanted to ask, lacked confidence', rows: lowConf.map((m) => ({ label: m.label, score: m.score, sub: m.reason, tone: 'warn' })) });
  const ps = promptSection(state, 'planRequirement'); if (ps) sections.push(ps);
  const rio = rawIOSection(state, 'planRequirement'); if (rio) sections.push(rio);
  return { kind: 'planner-q', title: '🧭 PLANNER QUESTION', decision: q ? q.label : 'question', decisionTone: 'good', sections };
}

// ── SPEC ────────────────────────────────────────────────────────────────────────────────────────
function specPayload(state: InspectorState, key: string, autofilled: boolean): InspectorPayload {
  const s = (state.specs || []).find((x) => norm(x.name) === norm(key) || norm(x.name).includes(norm(key)));
  const sections: InspectorSection[] = [];
  if (s) {
    const src = s.source || 'unknown';
    const isInference = /cascade|inferred|deduc|infer/i.test(src);
    sections.push({ title: 'Decision', rows: [
      { label: 'status', value: s.status || (autofilled ? 'AUTO-FILLED' : 'ASKED'), tone: autofilled ? 'good' : 'info' },
      { label: 'source', value: src, tone: isInference ? 'warn' : src === 'user' || src === 'buyer' ? 'good' : 'info', sub: isInference ? '⚠ inference — not buyer-confirmed' : undefined },
      { label: 'priority', value: typeof s.priority === 'number' ? String(s.priority) : '—', score: s.priority },
      { label: 'seller frequency', value: typeof s.sellerFreq === 'number' ? `${s.sellerFreq}%` : '—' },
      ...(s.value ? [{ label: 'value', value: s.value }] : []),
      ...(s.reason ? [{ label: 'why here', value: s.reason }] : []),
    ] });
  }
  // related specs (the spec order around this one)
  const all = state.specs || [];
  const idx = all.findIndex((x) => x === s);
  const related = idx >= 0 ? all.slice(Math.max(0, idx - 2), idx + 3).filter((x) => x !== s) : all.slice(0, 4);
  if (related.length) sections.push({ title: 'Related specs (rank order)', rows: related.map((r) => ({ label: r.name, score: r.priority, tone: 'muted' })) });
  // raw I/O for the cascade fill that produced auto-filled specs (the "what evidence auto-filled it" ask — Q68)
  const rio = rawIOSection(state, 'inferSpecsFromApplication'); if (rio) sections.push(rio);
  return { kind: autofilled ? 'autofilled-spec' : 'spec', title: autofilled ? '🧩 SPEC · AUTO-FILLED' : '🧩 SPEC DECISION', decision: s ? `${s.name}${s.value ? `: ${s.value}` : ''}` : key, decisionTone: 'info', sections };
}

// ── LAST PAGE (logistics: payment / delivery / gst / credit) ──────────────────────────────────────
function lastpagePayload(state: InspectorState, key: string): InspectorPayload {
  const log = state.logistics || {};
  const entry = log[key] || log[Object.keys(log).find((k) => norm(k).includes(norm(key))) || ''];
  const sections: InspectorSection[] = [];
  if (entry) {
    sections.push({ title: 'Decision', rows: [
      { label: 'suggested', value: entry.value, tone: 'good' },
      { label: 'confidence', value: `${entry.confidence}%`, score: entry.confidence, tone: entry.confidence >= 70 ? 'good' : entry.confidence >= 40 ? 'warn' : 'bad' },
      { label: 'reason', value: entry.reason || '—', tone: 'info' },
      { label: 'mode', value: entry.confidence >= 70 ? 'auto-suggested (recommend)' : 'asked (confirm)', sub: 'never silently auto-filled — buyer confirms' },
    ] });
  } else {
    sections.push({ title: 'Decision', rows: [{ label: key, value: 'asked (no deduction)', tone: 'info', sub: 'no confident signal → collected directly' }] });
  }
  const ps = promptSection(state, 'deduceLogistics'); if (ps) sections.push(ps);
  const rio = rawIOSection(state, 'deduceLogistics'); if (rio) sections.push(rio);
  return { kind: 'lastpage', title: '📦 LOGISTICS DECISION', decision: entry ? `${key}: ${entry.value}` : key, decisionTone: 'info', sections };
}

// ── BUYER PROFILE / PERSONA ────────────────────────────────────────────────────────────────────────
function profilePayload(state: InspectorState): InspectorPayload {
  const b = state.buyer || {};
  const sections: InspectorSection[] = [{ title: 'Buyer Brain', rows: [
    { label: 'identity', value: b.nature || b.persona || '—' },
    { label: 'authority', value: b.authority || '—' },
    { label: 'maturity', value: b.maturity || '—' },
    { label: 'urgency', value: b.urgency || '—' },
    { label: 'verified', value: b.verified ? 'yes' : 'no', tone: b.verified ? 'good' : 'muted' },
    { label: 'evidence', value: typeof b.evidenceCount === 'number' ? `${b.evidenceCount} signals` : '—' },
    { label: 'twin confidence', value: typeof b.twinConfidence === 'number' ? String(b.twinConfidence) : '—', score: b.twinConfidence, tone: (b.twinConfidence ?? 0) >= 65 ? 'good' : 'warn' },
    ...(b.offProfile ? [{ label: 'off-profile', value: 'current product unrelated to history', tone: 'warn' as Tone }] : []),
  ] }];
  // OLD (API-direct, no LLM) → NEW (LLM-deduced) — the buyer-profile evolution the user asked for
  if (b.apiPersona) {
    const o = b.apiPersona;
    sections.push({ title: '🔁 Buyer profile: OLD (API-direct) → NEW (deduced)', rows: [
      { label: 'OLD · direct', value: [o.type, o.scale && `scale ${o.scale}`, o.repeatBuyer && 'repeat', o.multiSku && 'multi-SKU', o.whatsappAffinity && `WA ${o.whatsappAffinity}`].filter(Boolean).join(' · ') || '—', tone: 'muted', sub: 'straight from the pull — no LLM' },
      { label: 'NEW · deduced', value: [b.nature || b.persona, b.maturity, b.authority].filter(Boolean).join(' · ') || '—', tone: 'good', sub: 'deriveBuyerProfile (LLM) — see raw I/O below' },
    ] });
  }
  const ls = lineageSection(state); if (ls) sections.push(ls);
  const rio = rawIOSection(state, 'deriveBuyerProfile'); if (rio) sections.push(rio);
  return { kind: 'profile', title: '🧠 BUYER BRAIN', decision: b.nature || b.persona || 'buyer', decisionTone: 'info', sections };
}

// ── the dispatcher ──
export function buildInspectorPayload(target: string | null, state: InspectorState): InspectorPayload | null {
  if (!target) return null;
  const [kind, ...rest] = target.split(':'); const key = rest.join(':');
  switch (kind) {
    case 'intent': case 'intent-chip': return state.intent ? intentPayload(state) : null;
    case 'planner-q': case 'planner-option': return state.planner ? plannerPayload(state, key) : null;
    case 'spec': return specPayload(state, key, false);
    case 'autofilled-spec': return specPayload(state, key, true);
    case 'lastpage': return lastpagePayload(state, key);
    case 'persona': case 'profile': case 'requirement': case 'confirm': return profilePayload(state);
    default: return null;
  }
}

// ── GLOBAL SUMMARY (the default right-pane view when nothing is hovered) ──
export function globalSummary(state: InspectorState): InspectorPayload {
  const c = state.category; const conf = state.confidence || {};
  const totalCost = (state.llmCalls || []).reduce((s, x) => s + (x.costUsd || 0), 0);
  const sections: InspectorSection[] = [];
  sections.push({ title: 'Confidence breakdown', rows: [
    { label: 'buyer', value: conf.buyer != null ? String(conf.buyer) : '—', score: conf.buyer },
    { label: 'category', value: conf.category != null ? String(conf.category) : '—', score: conf.category },
    { label: 'intent', value: conf.intent != null ? String(conf.intent) : '—', score: conf.intent },
    { label: 'specs', value: conf.specs != null ? String(conf.specs) : '—', score: conf.specs },
    { label: 'planner', value: conf.planner != null ? String(conf.planner) : '—', score: conf.planner },
    { label: 'OVERALL', value: conf.overall != null ? String(conf.overall) : '—', score: conf.overall, tone: 'info' },
  ] });
  if (c) sections.push({ title: 'Category', rows: [
    { label: 'status', value: c.status },
    { label: 'band', value: `${c.band} (${c.score})`, tone: bandTone(c.band) },
    { label: 'consume / fuse', value: `${c.consume ? 'yes' : 'no'} / ${c.fuse ? 'yes' : 'no'}` },
    { label: 'calls', value: c.calls != null ? String(c.calls) : '—' },
    ...(c.cache ? [{ label: 'cache', value: c.cache, tone: /hit/i.test(c.cache) ? 'good' : 'muted' as Tone }] : []),
    ...(c.buildAge ? [{ label: 'built', value: c.buildAge }] : []),
    ...(c.version ? [{ label: 'distill', value: c.version }] : []),
  ] });
  // Tier-B failure-mode + Tier-A human-override tracker
  const fm = failureMode(state);
  sections.push({ title: 'Risk / failure-mode', rows: [{ label: 'risk', value: fm.label, tone: fm.risk }] });
  if (state.overrides && state.overrides.length) sections.push({ title: 'Human overrides (AI → buyer changed)', rows: state.overrides.map((o) => ({ label: o.field, value: `${o.suggested} → ${o.chosen}`, tone: 'warn' })) });
  sections.push({ title: 'LLM activity', rows: [
    { label: 'calls', value: String((state.llmCalls || []).length) },
    { label: 'total cost', value: fmtCost(totalCost) },
  ] });
  return { kind: 'summary', title: '📋 EXECUTIVE SUMMARY', decision: c ? `${c.band} category · overall ${conf.overall ?? '—'}` : 'awaiting signals', decisionTone: 'info', sections };
}

// ── INSPECTOR SEARCH — the "trace search" (ChatGPT's bonus): type "site ready" and find it EVERYWHERE
//    it was generated / asked / suppressed / known across the whole RFQ. The procurement equivalent of
//    a LangSmith trace search. PURE. Searches every surface in the InspectorState. ──
export interface SearchHit { surface: string; label: string; disposition: string; detail?: string; tone: Tone }
export function searchInspector(state: InspectorState, termRaw: string): SearchHit[] {
  // token-OR match: "site ready" finds "Site readiness" (matches on the `site` token) — substring alone
  // would miss it ("ready" ≠ "readiness"). Each whitespace token (≥2 chars) is matched as a substring.
  const tokens = String(termRaw || '').toLowerCase().split(/\s+/).map(norm).filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  const hit = (s?: string) => { if (!s) return false; const n = norm(s); return tokens.some((t) => n.includes(t)); };
  const out: SearchHit[] = [];
  for (const c of state.intent?.candidates || []) if (hit(c.label)) out.push({ surface: 'Intent', label: c.label, disposition: norm(c.label) === norm(state.intent?.value || '') ? 'CHOSEN' : 'candidate', detail: `score ${c.score}`, tone: norm(c.label) === norm(state.intent?.value || '') ? 'good' : 'muted' });
  for (const q of state.planner?.questions || []) if (hit(q.label)) out.push({ surface: 'Planner', label: q.label, disposition: 'ASKED', detail: `priority ${q.priority ?? '—'}`, tone: 'good' });
  for (const c of state.planner?.considered || []) if (hit(c.label)) out.push({ surface: 'Planner', label: c.label, disposition: 'SUPPRESSED', detail: c.reason, tone: 'bad' });
  for (const t of state.planner?.twinResolved || []) if (hit(t)) out.push({ surface: 'Planner', label: t, disposition: 'KNOWN (not asked)', tone: 'good' });
  for (const c of state.category?.criticals || []) if (hit(c.name)) out.push({ surface: 'Category', label: c.name, disposition: 'critical-spec', detail: `freq ${c.seller_frequency ?? '—'}`, tone: 'muted' });
  for (const b of state.category?.blockers || []) if (hit(b.label)) out.push({ surface: 'Category', label: b.label, disposition: 'deal-blocker', detail: `freq ${b.frequency ?? '—'}`, tone: 'muted' });
  for (const a of state.category?.applications || []) if (hit(a)) out.push({ surface: 'Category', label: a, disposition: 'application', tone: 'muted' });
  for (const s of state.specs || []) if (hit(s.name)) out.push({ surface: 'Spec', label: s.name, disposition: s.status || (s.value ? 'FILLED' : 'ASKED'), detail: s.value, tone: s.source && /infer|cascade|deduc/.test(s.source) ? 'warn' : 'info' });
  for (const [k, d] of Object.entries(state.logistics || {})) if (hit(k) || hit(d.value)) out.push({ surface: 'Logistics', label: k, disposition: 'deduced', detail: `${d.value} (${d.confidence}%)`, tone: 'info' });
  return out;
}
