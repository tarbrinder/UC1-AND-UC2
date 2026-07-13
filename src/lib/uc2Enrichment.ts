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

import type { ReactNode } from 'react';
export interface UC2Edit { from: string; to: string; reason: string; drill?: ReactNode }                 // a corrected scalar field (drill = the full rich reasoning, attached in the view layer)
export interface UC2SpecEdit { k: string; kind: 'unchanged' | 'corrected' | 'added'; from?: string; to: string; reason?: string; drill?: ReactNode }
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
export const UC2_PROMPT_VERSION = 'uc2Enrich.v10'; // v10: plain-layman-English rewrite (no jargon/Amit/Hindi; every rule + JSON key preserved, adversarially verified 10/10). v9: DATE-MATCHED CALL transcript block (nearest call to the requirement date = strongest enrichment signal). v8: §H "Preferred sourcing city". v7: CLEAN values ("to" = crisp value/range only; conflict/verify/recommend notes go in "reason"). v6: simple India-B2B English reasons/confidence text (professional, not casual). v5: plain-English first pass. v4: per-edit confidence_reason + to_100 (why this %, what would make it 100). v3: PRODUCT-LINE LOCK (machine lead ≠ paper lead — never retitle/recategorise across product lines or graft cross-product specs) + category zero-overlap merge guard. v2: pure-LLM · location-lock + Sourcing Preference · PNS hero→specs · qty-conflict · age/gender

export interface UC2Evidence { evidence_id: string; node: string; tag?: string; raw: string } // mirror synthCtx.bundle.evidence
export interface UC2Context {
  selReq: { title?: string; category?: string; categoryId?: string; location?: string; specs: Array<{ k: string; v: string; filledBy?: string }>; specsStatus?: string; description?: string };
  profile: Array<{ key: string; label: string; value: string }>; // subset of `finals` — corroboration context, NOT re-derived
  evidence: UC2Evidence[];                                        // the fN grounding universe (synthCtx.bundle.evidence)
  addSpecs: string[];                                             // category criticals the requirement is missing (resolved.addedSpecs)
  anchors?: { city?: string; state?: string };                   // derived_anchors — location ground truth
  external?: { age?: string; gender?: string; incomeBand?: string }; // O36 — deterministic external context (Befisc) for the LLM's reasoning (e.g. young, first-venture)
  matchedCall?: { date: string; topic?: string; transcript: string; daysApart?: number }; // V11 — the call transcript NEAREST this requirement's date (date-matched), the strongest enrichment signal
}
// richer per-edit, surfaced in the UC2·debug band (confidence/grounded/evidence/reason)
export interface UC2EditFull { field: string; group: 'title' | 'category' | 'location' | 'spec'; kind: 'kept' | 'corrected' | 'added'; from: string; to: string; confidence: number; grounded: boolean; applied: boolean; evidence: UC2Evidence[]; reason: string; confidenceReason?: string; to100?: string }
export interface UC2Eval { changed: number; corrected: number; added: number; groundedPct: number; hallucinations: number; leaks: number; llmApplied: boolean; verdict: 'strong' | 'mixed' | 'thin' | 'no-llm' }
export interface UC2LLMField { field?: string; group?: string; action?: string; kind?: string; from?: string; value?: string; to?: string; confidence?: number; grounded?: boolean; evidence_ids?: string[]; reason?: string; confidence_reason?: string; to_100?: string }
export interface UC2LLMOut { edits: UC2LLMField[] }
export interface UC2Result { enrichment: UC2Enrichment; edits: UC2EditFull[]; eval: UC2Eval; promptVersion: string }

export const UC2_ENRICH_SYSTEM = [
  "Your job: work out what the buyer on this Indian business-to-business online marketplace is REALLY trying to buy right now, then FIX or ADD DETAIL to ONLY the request's own fields — its Title, its product Category, its Location, and its Specs (the product's technical details, such as size, grade, or quantity).",
  "(A business-to-business marketplace is a website where companies buy from and sell to each other, rather than selling to ordinary shoppers. 'Category' here means the marketplace's own product-category label that the item is filed under.)",
  "The buyer's PROFILE — who they are, their industry, and so on — has ALREADY been worked out separately. Do NOT work it out again. It is given to you only as background to cross-check against, and you MAY refer to its evidence-line ids if you use it. (Evidence-line ids are the small tags written like [f12] that label each piece of evidence given to you further down.)",
  "",
  "SETTING — INDIA ONLY (the IndiaMART marketplace). All money is in rupees, written ₹ / lakh / crore; all places are in India; never use $ or US dollars.",
  "",
  "WHAT YOU ARE GIVEN:",
  "- THE RECORDED REQUEST (treat this as the starting facts): the buyer's posted purchase enquiry combined with their answers to the marketplace's standard product questions — that is, the title, the category and its id number, the location, the specs (each shown as key: value, plus a note of who filled it in), the enquiry's status, and how old it is.",
  "- BUYER-PROFILE BACKGROUND: the buyer's persona/industry, the products they are interested in, where they prefer to source from, their buying intent, and their spending power.",
  "- CATEGORY MUST-HAVES: the specs that this product category usually needs.",
  "- EVIDENCE LINES, each tagged like [f...]: the buyer's searches logged on the site, their WhatsApp messages, a write-up of a recorded phone call with the buyer, and their earlier requests.",
  "Work out what the buyer ACTUALLY wants — not merely what the form happened to capture.",
  "",
  "RULES FOR EACH FIELD:",
  "- STAY ON THE SAME PRODUCT (read this FIRST — this rule cannot be broken): one buyer often has SEVERAL SEPARATE requests going at once — for example, a request for a 'Notebook Making MACHINE' AND a completely separate request for 'Notebook RAW PAPER'. You are improving exactly ONE of these requests. NEVER re-title or re-categorise THIS request into a DIFFERENT kind of product, and NEVER copy another product's specs onto it. A machine request gets machine specs (such as automation grade, components, cutting size); a raw-material request gets material specs (such as GSM — paper weight in grams per square metre — grade, and price per kg). Evidence that is about a DIFFERENT product than this request does NOT belong to this request — leave it for that other request. For example, a '1300 pieces/hour Notebook Making Machine' request must stay a machine and must not be turned into paper.",
  "- TITLE: change ONLY a word that the evidence DIRECTLY contradicts (swap out just that one wrong word and keep the rest of the title's wording), and only within THIS request's product type. OR, if the title is a single word or is gibberish, you may build a clearer title (up to 6 words) using THIS request's OWN specs. NEVER switch the product itself (for example, do NOT change a 'Notebook Making Machine' title into 'Notebook Raw Material Paper').",
  "- CATEGORY: only correct a category that is gibberish or clearly wrong, replacing it with the RIGHT category for THIS request's OWN product. If the recorded category is merely a sub-type, variant, component, or accessory of the right one, leave it as-is (mark it 'kept'). NEVER change the category to a DIFFERENT kind of product (a machine category must not become a raw-material category, and vice versa).",
  "- LOCATION (FIXED — NEVER replace): the buyer's own recorded city (where they operate) stays EXACTLY as written. NEVER output a 'corrected' location that swaps the buyer's city for a seller's city, a sourcing city, or a city mentioned on a call (for example, do NOT change 'Auraiya' into 'Kanpur'). Instead, when the buyer wants to SOURCE from one or more other cities, ADD a spec named exactly 'Preferred sourcing city' with kind 'added', listing those cities (backed by evidence, separated by commas). The buyer's own location and their preferred sourcing city are two SEPARATE things.",
  "- SPECS:",
  "  (a) do NOT treat 'joining a value with its unit' as a correction — putting a number and its unit together is just formatting, not a real change. Only record a spec edit when the VALUE itself genuinely changes and the evidence backs it.",
  "  (b) only replace a spec value that the evidence directly contradicts.",
  "  (c) ADD a must-have spec for this category if the buyer answered it somewhere else or said it on a call — but the value MUST be backed by a cited piece of evidence.",
  "  (d) if a spec has different values across different pieces of evidence, give a RANGE.",
  "  (e) QUANTITY CONFLICT: when the posted quantity and a spoken or typed quantity are meaningfully different (for example, 100000 kg posted versus 0.5–1 ton mentioned on a call), do NOT quietly keep just one of them. Set 'to' to ONLY the clean recommended value or range (prefer the SMALLER commitment — a trial or first order rather than a bulk order — e.g. '0.5–1 ton (trial)'), and put the explanation of the clash ('posted X versus spoken Y — please verify; recommending the smaller trial order') in 'reason', NOT inside 'to'.",
  "KEEP 'to' CLEAN: 'to' is the headline value the reader sees — keep it tidy (just the value, unit, or range). ALL commentary — clashes, 'please verify', 'we recommend…', and why the value changed — goes in 'reason', and must NEVER be tacked onto 'to'.",
  "",
  "STRONGEST SIGNALS — PHONE CALLS AND WHATSAPP (use them ONLY when they are about THIS request's product — keep following the 'stay on the same product' rule): what the buyer SAID on a recorded phone call is the strongest kind of evidence, but only apply such a signal to THIS request if it actually describes THIS request's product. For a raw-material / paper request: fold in a spoken target price (e.g. '₹45–52/kg'), quantity, GSM / grade, the intended use, and the buyer's typed WhatsApp enquiry (e.g. 'Notebook Copy Raw Material, 54/75 GSM'). For a machine request: do NOT add paper price / GSM / grade — those belong to the SEPARATE raw-material request, not to the machine. A strong signal about a different product than this request is left for that other request and is never attached here.",
  "",
  "SAFETY RULES (these cannot be broken):",
  "- If a field is '(none)' or blank, NEVER invent a value — output kind 'kept'.",
  "- Only flag a DIRECT contradiction. If the buyer offered several options and the one that was recorded is among them, that is fine — mark it 'kept' (correct as-is).",
  "- These ways of writing dimensions all mean the same thing: '10x10' = '10 into 10' = '10×10' = '10 by 10' = '10*10' — never 'correct' one of these into another.",
  "- NO MAKING THINGS UP: every 'corrected' or 'added' value MUST cite at least one evidence-line id and have grounded=true. Use a confidence of 70 or more only when at least 2 pieces of evidence agree, or one strong spoken (phone-call) signal supports it. If nothing supports a change, output kind 'kept' (do not change or add anything).",
  "- Be cautious: when in doubt, keep things as they are. Do NOT re-judge the buyer's profile, their selling intent, or any personal or private information — those are handled elsewhere.",
  "",
  "HOW TO SET CONFIDENCE (a number from 0 to 100): start from the quality of the evidence, add for how trustworthy the source is (a spoken phone call and a WhatsApp message written by the buyer are the most trustworthy), add for different sources agreeing with each other, then subtract for contradictions and for missing evidence. Use 70 or more only when at least 2 pieces of evidence agree, OR one strong spoken (phone-call) signal supports it.",
  "",
  "OUTPUT — reply with strict JSON only, one entry for every field you looked at or added, and nothing else:",
  "{ \"edits\": [ { \"group\": \"title|category|location|spec\", \"field\": \"<the spec key, or the group name for title/category/location>\",",
  "  \"kind\": \"kept|corrected|added\", \"from\": \"<the old value; use '' when kind is added>\", \"to\": \"<the new value or range>\",",
  "  \"confidence\": 0-100, \"confidence_reason\": \"<ONE plain line saying WHY you chose this number, following the confidence rule above>\",",
  "  \"to_100\": \"<the single thing that would raise confidence to 100 — e.g. 'a 2nd source confirming', 'an explicit buyer statement', 'a live (non-expired) lead'; use \\\"\\\" if it is already 100>\",",
  "  \"grounded\": true|false, \"evidence_ids\": [\"f12\",\"f30\"], \"reason\": \"<1-2 sentences>\" } ] }",
  "Cite ONLY the buyer-signal evidence-line ids that actually appear in the EVIDENCE LINES section.",
  "PLAIN, PROFESSIONAL ENGLISH: write 'reason', 'confidence_reason', and 'to_100' in clear, professional English suited to Indian business readers — simple but not casual or sloppy, and never in Hindi; do not stack up jargon, and do not add parenthetical asides. (Spec keys and their values stay technical and exactly as-is; only the explanation text uses this plain wording.)"
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
    ...(ctx.matchedCall && ctx.matchedCall.transcript
      ? ['', `DATE-MATCHED CALL (${ctx.matchedCall.date}${ctx.matchedCall.daysApart != null ? ` · ${ctx.matchedCall.daysApart}d from this requirement` : ''}${ctx.matchedCall.topic ? ` · ${ctx.matchedCall.topic}` : ''}) — the buyer's SPOKEN words nearest this requirement; the STRONGEST enrichment signal. Use it to fix/add specs (qty, grade, delivery, payment) the buyer actually stated; cite it.`, `  "${ctx.matchedCall.transcript}"`]
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

const GATE_LO = 70; // audit 2026-07-13: aligned with offerEnrich (≥70 apply) — a medium-confidence (50-69) edit no longer OVERWRITES a buyer-recorded field; it is held. Owner data-honesty: don't overwrite the buyer's own words on a medium guess.
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
      // must arrive as an ADDED "Preferred sourcing city" spec instead.) Demote any location 'corrected' to kept.
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
      editsFull.push({ field: e.field || group, group, kind: applied ? kind : (wantsChange ? 'kept' : kind), from, to, confidence: conf, grounded, applied, evidence: ev, reason, confidenceReason: e.confidence_reason ? String(e.confidence_reason) : undefined, to100: e.to_100 ? String(e.to_100) : undefined });
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

  // audit P2: count corrected/added from what is ACTUALLY RENDERED (specOut + the title/category/location edits), not
  // from editsFull — a 'corrected' spec whose field matched no base key was counted but never shown, overstating "N corrected".
  const corrected = specOut.filter((x) => x.kind === 'corrected').length + [titleE, catE, locE].filter(Boolean).length;
  const added = specOut.filter((x) => x.kind === 'added').length;
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
