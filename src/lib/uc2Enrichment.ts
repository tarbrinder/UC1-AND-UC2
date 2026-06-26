// ─── UC2 · REQUIREMENT ENRICHMENT / CORRECTION (before → after) ──────────────────────────────────────
// UC2 shows, on the SAME L6 Buylead card, what the requirement looked like as BASE TRUTH (BuyLead ⨝ ISQ ⨝
// resolved-RFQ-category) vs what it looks like AFTER our AI-assisted application enriches/corrects it:
//   • CORRECT  — cross out a wrong/loose title · category · location · spec value, put the right one.
//   • ADD      — surface specs the buyer never filled but the requirement needs (NEW badge).
//   • DERIVE   — Products-of-Interest + Available channels + the whole buyer profile are AI-DERIVED ("new").
// V1 ships a DUMMY generator so the before→after UI can be demoed end-to-end; swap `buildUC2Enrichment`
// for a real Gemini round-trip (a `buildUC2Prompt` over the same bundle) later — the render layer is final.
// GENERIC ONLY — never hardcode a category/spec name (owner rule); added specs are universal procurement
// attributes, corrections are generic string normalisations or a passed-in alternate value.

export interface UC2Edit { from: string; to: string; reason: string }                 // a corrected scalar field
export interface UC2SpecEdit { k: string; kind: 'unchanged' | 'corrected' | 'added'; from?: string; to: string; reason?: string }
export interface UC2Enrichment {
  isDummy: boolean;                       // true until the real enrichment LLM is wired
  summary: string;                        // one-line before→after headline
  title?: UC2Edit;                        // present ONLY when corrected
  category?: UC2Edit;
  location?: UC2Edit;
  specs: UC2SpecEdit[];                   // every spec, tagged unchanged | corrected | added
  poiNew: boolean;                        // Products of Interest is AI-derived
  profileNew: boolean;                    // Available + buyer-profile block is AI-derived
  counts: { corrected: number; added: number; derived: number };
}

export interface UC2Input {
  title?: string; category?: string; location?: string;
  specs: Array<{ k: string; v: string; filledBy?: string }>;
  altLocation?: string;                   // a more-specific/active location (PNS/external) — drives a location correction if it differs
  addSpecs?: string[];                    // generic procurement spec keys the AI suggests adding (NOT category-specific)
  derivedCount?: number;                  // # of AI-derived profile/availability fields (for the summary)
}

// O27 — PURE-LLM CONTRACT: the no-key fallback must NOT fabricate any deterministic edit. "Original" must equal
// the base truth verbatim until the real LLM enrichment runs (no merges, no normalisations, no location overwrite,
// no cross-out). So this fallback emits every spec as `unchanged` and corrects nothing — all changes come ONLY from
// the grounded LLM path (mergeUC2LLM). It exists purely so the L6 card renders the base requirement when no key.
export function buildUC2Enrichment(input: UC2Input): UC2Enrichment {
  const specs: UC2SpecEdit[] = input.specs.map((s) => ({ k: s.k, kind: 'unchanged' as const, to: s.v }));
  return {
    isDummy: true,
    summary: 'Before → After: enrichment not run (no LLM key) — showing the requirement verbatim',
    specs, poiNew: false, profileNew: false, counts: { corrected: 0, added: 0, derived: 0 },
  };
}

// ═══ UC2 REAL PATH (LLM enrichment) — grounded in the fN bundle, mirrors offerEnrich discipline ═══════════════
// One Gemini call reconstructs the buyer's TRUE requirement and CORRECTS/ENRICHES only Title · Category · Location
// · Specs. Buyer PROFILE is NOT re-derived — passed as CONTEXT (cite its [fN]). Every change must cite ≥1 buyer
// signal id from the SAME fN universe the L5 twin uses (synthCtx.bundle.evidence). Confidence gate + hallucination
// guard ported from offerEnrich; output projects to the UC2Enrichment render contract (L6) + a richer debug shape.
export const UC2_PROMPT_VERSION = 'uc2Enrich.v3'; // v3: PRODUCT-LINE LOCK (machine lead ≠ paper lead — never retitle/recategorise across product lines or graft cross-product specs) + category zero-overlap merge guard. v2: pure-LLM · location-lock + Sourcing Preference · PNS hero→specs · qty-conflict · age/gender

export interface UC2Evidence { evidence_id: string; node: string; tag?: string; raw: string } // mirror synthCtx.bundle.evidence
export interface UC2Context {
  selReq: { title?: string; category?: string; categoryId?: string; location?: string; specs: Array<{ k: string; v: string; filledBy?: string }>; specsStatus?: string; description?: string };
  profile: Array<{ key: string; label: string; value: string }>; // subset of `finals` — corroboration context, NOT re-derived
  evidence: UC2Evidence[];                                        // the fN grounding universe (synthCtx.bundle.evidence)
  addSpecs: string[];                                             // category criticals the requirement is missing (resolved.addedSpecs)
  anchors?: { city?: string; state?: string };                   // derived_anchors — location ground truth
  external?: { age?: string; gender?: string; incomeBand?: string }; // O36 — deterministic external context (Befisc) for the LLM's reasoning (e.g. young, first-venture)
}
// richer per-edit, surfaced in the UC2·debug band (confidence/grounded/evidence/reason)
export interface UC2EditFull { field: string; group: 'title' | 'category' | 'location' | 'spec'; kind: 'kept' | 'corrected' | 'added'; from: string; to: string; confidence: number; grounded: boolean; applied: boolean; evidence: UC2Evidence[]; reason: string }
export interface UC2Eval { changed: number; corrected: number; added: number; groundedPct: number; hallucinations: number; leaks: number; llmApplied: boolean; verdict: 'strong' | 'mixed' | 'thin' | 'no-llm' }
export interface UC2LLMField { field?: string; group?: string; action?: string; kind?: string; from?: string; value?: string; to?: string; confidence?: number; grounded?: boolean; evidence_ids?: string[]; reason?: string }
export interface UC2LLMOut { edits: UC2LLMField[] }
export interface UC2Result { enrichment: UC2Enrichment; edits: UC2EditFull[]; eval: UC2Eval; promptVersion: string }

export const UC2_ENRICH_SYSTEM = [
  "You RECONSTRUCT the buyer's TRUE current requirement for an India B2B marketplace, then CORRECT or ENRICH only",
  'the requirement fields — Title · Category (MCAT) · Location · Specs. The buyer PROFILE is already built — do NOT',
  're-derive it; it is given only as CONTEXT/corroboration (you MAY cite its [fN] ids).',
  '',
  'CONTEXT — INDIA B2B ONLY (IndiaMART). Money in ₹/lakh/crore; places Indian; never $/USD.',
  '',
  'INPUTS: BASE-TRUTH REQUIREMENT (the recorded BuyLead ⨝ ISQ: title, category+id, location, specs{key:value,filledBy},',
  'status, age) · BUYER-PROFILE CONTEXT (persona/industry, products_of_interest, location_sourcing_preference, intent,',
  'purchasing_power) · CATEGORY CRITICALS (specs this MCAT usually needs) · EVIDENCE LINES [fN] (CSL searches, WhatsApp,',
  'PNS call narrative, prior requirements). Reconstruct what the buyer ACTUALLY wants — NOT what the form captured.',
  '',
  'FIELD RULES:',
  '- PRODUCT-LINE LOCK (read FIRST — non-negotiable): a buyer often holds SEVERAL DISTINCT requirements at once — e.g. a',
  '  "Notebook Making MACHINE" requirement AND a separate "Notebook RAW PAPER" requirement. You are enriching exactly ONE',
  '  lead. NEVER retitle or recategorise THIS lead into a DIFFERENT product line, and NEVER graft another product line\'s',
  '  specs onto it. A MACHINE lead gets machine specs (automation grade · components · cutting size); a RAW-MATERIAL lead',
  '  gets material specs (GSM · grade · ₹-per-kg). Evidence about a DIFFERENT product than this lead is NOT this',
  '  requirement — leave it for that lead. The "1300Pcs/Hr Notebook Making Machine" lead must stay a machine, not become paper.',
  '- TITLE: fix ONLY a term the evidence DIRECTLY contradicts (replace just the conflicting term, keep structure) and ONLY',
  '  within THIS lead\'s product line; OR enrich a 1-word / gibberish title from THIS lead\'s OWN specs into ≤6 words. NEVER',
  '  switch the product (do NOT turn a "Notebook Making Machine" title into "Notebook Raw Material Paper").',
  '- CATEGORY: correct ONLY a gibberish / clearly-wrong category to the RIGHT one for THIS lead\'s OWN product. A sub-type /',
  '  variant / component / accessory of the recorded category → kept. NEVER change the category to a DIFFERENT product line',
  '  (a machine category must not become a raw-material category, or vice-versa).',
  '- LOCATION (LOCKED — NEVER overwrite): the recorded operating/buyer city stays VERBATIM. NEVER emit a "corrected"',
  '  location that replaces the buyer\'s city with a seller / sourcing / call city (e.g. do NOT turn "Auraiya" into',
  '  "Kanpur"). Instead, when the buyer SOURCES from one or more different cities, ADD a spec named exactly',
  '  "Sourcing Preference" with kind "added" listing those cities (grounded, comma-separated). The requirement',
  '  location and the sourcing preference are two SEPARATE things.',
  '- SPECS: (a) do NOT "merge" a value + its unit as a correction — value/unit display-joining is formatting, not a',
  '  change; only emit a spec edit for a REAL, evidence-grounded value change. (b) replace-only a spec value the',
  '  evidence directly contradicts; (c) ADD a category-critical spec the buyer answered elsewhere or stated on a call —',
  '  the value MUST be evidence-cited; (d) if a spec varies across signals → output a RANGE; (e) QUANTITY CONFLICT: when',
  '  the posted quantity and a spoken/typed quantity diverge materially (e.g. 100000 kg posted vs 0.5–1 ton on a call),',
  '  do NOT silently keep one — emit the spec showing BOTH with a "(conflict — verify; recommend the lower trial)" note',
  '  and prefer the LOWER commitment (a trial / first order over bulk) as the recommended value.',
  '',
  'DECISIVE PNS + WHATSAPP HERO SIGNALS (integrate ONLY when they pertain to THIS lead\'s product — respect the',
  'PRODUCT-LINE LOCK): spoken-call signals are the strongest, but apply a hero signal to THIS lead ONLY if it describes',
  'THIS lead\'s product. For a RAW-MATERIAL / paper lead: fold in spoken TARGET PRICE ("₹45–52/kg"), QUANTITY, GSM / grade,',
  'INTENDED APPLICATION, and the WhatsApp TYPED ENQUIRY ("Notebook Copy Raw Material, 54/75 GSM"). For a MACHINE lead: do',
  'NOT add paper price / GSM / grade — those belong to the SEPARATE raw-material requirement, not the machine. A hero',
  'signal for a different product than this lead is left for that lead (never grafted on here).',
  '',
  'GUARDS (non-negotiable):',
  '- (none) / blank → NEVER invent a value; emit kind "kept".',
  '- Only flag a DIRECT contradiction. Buyer gave multiple options and one was captured → kept (correct).',
  '- Dimension notation is equivalent: "10x10" = "10 into 10" = "10×10" = "10 by 10" = "10*10" — never "correct" these.',
  '- HALLUCINATION GUARD: every "corrected"/"added" value MUST cite ≥1 [fN] and grounded=true; confidence ≥70 only when',
  '  ≥2 signals agree or one strong spoken (call) signal. No supporting signal → emit kind "kept" (do not change/add).',
  '- Conservative: when unsure, keep. Do NOT re-judge profile / selling-intent / PII (handled elsewhere).',
  '',
  'OUTPUT — strict JSON, one entry per field you assessed or added, nothing else:',
  '{ "edits": [ { "group": "title|category|location|spec", "field": "<spec key, or the group name for title/category/location>",',
  '  "kind": "kept|corrected|added", "from": "<old value, \'\' for added>", "to": "<new value or range>",',
  '  "confidence": 0-100, "grounded": true|false, "evidence_ids": ["f12","f30"], "reason": "<1-2 sentences>" } ] }',
  'Cite ONLY buyer-signal [fN] ids that appear in EVIDENCE LINES.',
].join('\n');

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function buildUC2Prompt(ctx: UC2Context): { system: string; user: string; evidenceIds: string[] } {
  const sr = ctx.selReq;
  const anchorLoc = [ctx.anchors?.city, ctx.anchors?.state].filter(Boolean).join(', ');
  const user = [
    'BASE-TRUTH REQUIREMENT (recorded BuyLead ⨝ ISQ — reconstruct the TRUE requirement):',
    `  title: ${sr.title || '(none)'}`,
    `  category (MCAT): ${sr.category || '(none)'}${sr.categoryId ? ` [#${sr.categoryId}]` : ''}`,
    `  location (recorded): ${sr.location || '(none)'}${anchorLoc && norm(anchorLoc) !== norm(sr.location || '') ? `  · identity anchor: ${anchorLoc}` : ''}`,
    ...(sr.specs.length ? sr.specs.map((s) => `  spec · ${s.k}: ${s.v}${s.filledBy && s.filledBy !== 'buyer' ? ` (${s.filledBy}-filled)` : ''}`) : ['  specs: (none)']),
    sr.description ? `  buyer note: ${sr.description}` : '',
    '',
    'BUYER-PROFILE CONTEXT (already extracted for the twin — corroboration only, do NOT re-derive; cite [fN] if used):',
    ...(ctx.profile.length ? ctx.profile.map((p) => `  ${p.label}: ${p.value}`) : ['  (none)']),
    ...(ctx.external && (ctx.external.age || ctx.external.gender || ctx.external.incomeBand)
      ? [`  external (deterministic — reasoning context only): ${[ctx.external.age && `age ${ctx.external.age}`, ctx.external.gender, ctx.external.incomeBand && `income ${ctx.external.incomeBand}`].filter(Boolean).join(' · ')}`]
      : []),
    '',
    ctx.addSpecs.length ? `CATEGORY CRITICALS (specs this MCAT usually needs — ADD only if buyer evidence supports a value): ${ctx.addSpecs.join(' · ')}` : '',
    '',
    'EVIDENCE LINES — cite these ids (the ONLY evidence you may use):',
    ...ctx.evidence.map((e) => `  [${e.evidence_id}] (${e.node}${e.tag ? '/' + e.tag : ''}) ${e.raw}`),
    '',
    'Reconstruct: fix category mismatch first, then title, location, and specs (merge value+unit, replace-only on contradiction, ADD category-criticals the evidence supports, RANGE when specs vary). Return the JSON.',
  ].filter((l) => l !== '').join('\n');
  return { system: UC2_ENRICH_SYSTEM, user, evidenceIds: ctx.evidence.map((e) => e.evidence_id) };
}

const GATE_LO = 50; // ≥LO apply · below → keep raw (no change shown)
function resolveUC2Evidence(ids: string[] | undefined, byId: Map<string, UC2Evidence>): { ev: UC2Evidence[]; leaks: number } {
  const ev: UC2Evidence[] = []; let leaks = 0;
  for (const id of ids || []) { const e = byId.get(id); if (e) ev.push(e); else leaks++; }
  return { ev, leaks };
}

export function mergeUC2LLM(ctx: UC2Context, out: UC2LLMOut | null): UC2Result {
  const byId = new Map(ctx.evidence.map((e) => [e.evidence_id, e] as const));
  const editsFull: UC2EditFull[] = [];
  let leaks = 0;
  const norms = new Set(ctx.selReq.specs.map((s) => norm(s.k)));

  if (out && Array.isArray(out.edits)) {
    for (const e of out.edits) {
      const group = (['title', 'category', 'location', 'spec'].includes(String(e.group)) ? e.group : 'spec') as UC2EditFull['group'];
      const rawKind = String(e.kind || e.action || 'kept');
      const kind = (['kept', 'corrected', 'added'].includes(rawKind) ? rawKind : 'kept') as UC2EditFull['kind'];
      const { ev, leaks: lk } = resolveUC2Evidence(e.evidence_ids, byId); leaks += lk;
      const conf = typeof e.confidence === 'number' ? Math.max(0, Math.min(100, e.confidence)) : 0;
      const grounded = !!e.grounded && ev.length > 0;
      const to = String(e.to ?? e.value ?? '');
      const from = String(e.from ?? '');
      // O28 LOCATION LOCK — never apply a location *overwrite*; the operating city is immutable. (A sourcing city
      // must arrive as an ADDED "Sourcing Preference" spec instead.) Demote any location 'corrected' to kept.
      const locationOverwrite = group === 'location' && kind === 'corrected';
      // PRODUCT-LINE LOCK (backstop) — block a category "correction" that shares NO ≥4-char token with the recorded
      // category: that's a product-line switch (e.g. "Notebook Making Machines" → "Raw Paper Material"), not a refinement.
      const tok = (s: string): Set<string> => new Set((String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g)) || []);
      const recCat = tok(ctx.selReq.category || '');
      const categorySwitch = group === 'category' && kind === 'corrected' && recCat.size > 0 && ![...tok(to)].some((t) => recCat.has(t));
      // hallucination guard + confidence gate: a change is APPLIED only when grounded AND conf ≥ LO and it has a value.
      const wantsChange = (kind === 'corrected' || kind === 'added') && !!to;
      const applied = wantsChange && grounded && conf >= GATE_LO && !locationOverwrite && !categorySwitch;
      const reason = `${String(e.reason || '')}${locationOverwrite ? ' · [location-lock: never overwrite operating city — surface as Sourcing Preference]' : ''}${categorySwitch ? ' · [product-line lock: category correction shares no token with the recorded product — blocked as a cross-product switch]' : ''}`.trim();
      editsFull.push({ field: e.field || group, group, kind: applied ? kind : (wantsChange ? 'kept' : kind), from, to, confidence: conf, grounded, applied, evidence: ev, reason });
    }
  }

  // project applied edits → the UC2Enrichment render contract (what L6 draws)
  const pick = (g: string) => editsFull.find((x) => x.group === g && x.applied && (x.kind === 'corrected'));
  const titleE = pick('title'); const catE = pick('category'); const locE = pick('location');
  const specEdits = editsFull.filter((x) => x.group === 'spec');
  const specOut: UC2SpecEdit[] = [];
  // start from base specs, applying corrections by key
  for (const s of ctx.selReq.specs) {
    const corr = specEdits.find((x) => x.applied && x.kind === 'corrected' && norm(x.field) === norm(s.k));
    if (corr) specOut.push({ k: s.k, kind: 'corrected', from: corr.from || s.v, to: corr.to, reason: corr.reason });
    else specOut.push({ k: s.k, kind: 'unchanged', to: s.v });
  }
  // added specs (not already present)
  for (const x of specEdits) if (x.applied && x.kind === 'added' && !norms.has(norm(x.field))) specOut.push({ k: x.field, kind: 'added', to: x.to, reason: x.reason });

  const corrected = editsFull.filter((x) => x.applied && x.kind === 'corrected').length;
  const added = editsFull.filter((x) => x.applied && x.kind === 'added').length;
  const ev = uc2Eval(editsFull, leaks, !!out);
  const derived = ctx.profile.length; // Available + profile rows are AI-derived (framed "new")
  const parts: string[] = [];
  if (corrected) parts.push(`${corrected} corrected`);
  if (added) parts.push(`${added} spec${added === 1 ? '' : 's'} added`);
  parts.push(`${derived} field${derived === 1 ? '' : 's'} AI-derived`);
  const enrichment: UC2Enrichment = {
    isDummy: false,
    summary: out ? `Before → After: ${parts.join(' · ')}` : 'Before → After: enrichment unavailable (no LLM key)',
    title: titleE ? { from: titleE.from || ctx.selReq.title || '', to: titleE.to, reason: titleE.reason } : undefined,
    category: catE ? { from: catE.from || ctx.selReq.category || '', to: catE.to, reason: catE.reason } : undefined,
    location: locE ? { from: locE.from || ctx.selReq.location || '', to: locE.to, reason: locE.reason } : undefined,
    specs: specOut, poiNew: true, profileNew: true,
    counts: { corrected, added, derived },
  };
  return { enrichment, edits: editsFull, eval: ev, promptVersion: UC2_PROMPT_VERSION };
}

export function uc2Eval(edits: UC2EditFull[], leaks: number, llmApplied: boolean): UC2Eval {
  const attempts = edits.filter((x) => x.kind === 'corrected' || x.kind === 'added' || (!x.applied && (x.to && x.to !== x.from)));
  const changed = edits.filter((x) => x.applied && (x.kind === 'corrected' || x.kind === 'added'));
  const corrected = edits.filter((x) => x.applied && x.kind === 'corrected').length;
  const added = edits.filter((x) => x.applied && x.kind === 'added').length;
  const groundedPct = attempts.length ? Math.round((attempts.filter((x) => x.grounded).length / attempts.length) * 100) : 100;
  const hallucinations = attempts.filter((x) => !x.grounded).length;
  const verdict: UC2Eval['verdict'] = !llmApplied ? 'no-llm' : (groundedPct >= 80 && hallucinations === 0 && leaks === 0) ? 'strong' : groundedPct < 50 ? 'thin' : 'mixed';
  return { changed: changed.length, corrected, added, groundedPct, hallucinations, leaks, llmApplied, verdict };
}
