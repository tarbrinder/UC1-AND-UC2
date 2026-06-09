# RFQ "Buyer Twin Engine" — Exhaustive Workflow, Branches & RAW Prompts

> Built by reading the source directly (not memory). Prompts are transcribed **verbatim** from
> `src/lib/gemini.ts`. Flow/guards are quoted from `src/components/RFQModalV3.tsx`,
> `src/lib/enrichment.ts`, `src/lib/coverage.ts`, `src/lib/externalRun.ts`.
> Purpose: (a) a single map a reviewer can trust end-to-end, (b) the RAW prompts for ChatGPT/Gemini
> review (§3), (c) a self-driven gap hunt (§7) answering the 5 open questions (§8).

---

## §0 — How this is "100% accurate"

- **Prompts (§3)** are copy-pasted from the template literals in `gemini.ts`. Where a prompt
  interpolates a variable (`${args.x}`), the variable is named inline. Nothing paraphrased.
- **Triggers/guards** are quoted `if (...) return;` lines from the actual effects/handlers.
- Line numbers drift as code changes, so this doc keys on **function names + verbatim guards**
  (stable) rather than line numbers.
- Anything I could NOT verify from source is marked **⚠ UNVERIFIED**.

There are **14 LLM call sites**, **2 deterministic engines** (Coverage Registry, External runner),
**3 entry modalities** (text / image / voice), and **3 form steps**.

---

## §1 — The stage machine (steps + fire order)

Three steps: **0** product entry → **1** specs → **2** delivery/contact → OTP → submit.

```
STEP 0  (product + qty + page-1 intent)
  ├─ product typed/selected  → handleProductCommit() → fetch ISQ specs (isqSpecs)
  │     └─ on product change: getSpecHints + classifyFieldTypes  (LLM ×2)
  ├─ GLID pulled (debug)     → fetchEnrichment() → deriveEnrichment() (deterministic)
  │     ├─ deriveBuyerProfile (LLM)   ─┐ both fire in PARALLEL, non-blocking
  │     ├─ deriveBuyerTwin    (LLM)   ─┘
  │     └─ runExternal()  (Befisc/Sign3/World — non-blocking, debug)   [E]
  ├─ qty entered (if unitOptions exist)   → gates the intent question
  ├─ deriveIntent (LLM)  → page-1 intent chips / "we understood X" confirm
  └─ Continue → GATE: blocks until intent triggered → ensureReqPlan (FIRST planner, LLM)

STEP 1  (specs: top-3 + "more")
  ├─ planner_pending? → renderSpecProgress (smart checklist) else specs
  ├─ buyer picks a lead spec → inferSpecsFromApplication (CASCADE, LLM) fills dependents
  ├─ "Not sure?" per spec   → explainSpec (LLM, on demand)
  ├─ image upload           → analyzeImage (LLM) → fill specs
  ├─ Help box (text/mic)    → inferSpecsFromApplication / voiceToSpecs (LLM)
  ├─ wizard panel opens     → refineQuestions (LLM, adaptive look-ahead)
  └─ intent answered late   → P6 re-rank planRequirement (LLM) "Re-planned after…"

STEP 2  (delivery + payment + contact)
  ├─ on entry → deduceLogistics (LLM): prefill ≥0.8, ask the rest
  ├─ confirmable summaries (Firm/GST/Payment/Delivery)
  └─ Get Quotes → OTP (static) → finalizeRequirement → summarizeRequirement (LLM) → submit
```

### Effects, in the order they typically fire (all in `RFQModalV3.tsx`)

| # | Effect / handler | Fires when | Primary side-effect |
|---|---|---|---|
| 1 | product-commit handler | product committed | fetch ISQ specs; `getSpecHints`+`classifyFieldTypes` |
| 2 | `handleGlidFetch` | Pull clicked (debug) | enrichment + `deriveBuyerProfile` + `deriveBuyerTwin` + `runExternal` |
| 3 | deriveIntent effect | `step≤1 && isqSpecs>0 && qtyReady && !twinPending` | stages `requirementIntent` |
| 4 | who's-buying auto-derive | twin/enrichment present, `!page1Choice` | sets `page1Choice` silently |
| 5 | registry recorder | any of dynQ/specs/deduced/twin change | `coverage.record(...)` (system-of-record) |
| 6 | cadence/budget pre-record (#8) | `buyerProfile` present, conf≥0.6 | records cadence/budget → registry |
| 7 | prefetch planner (#4/#9) | `isqSpecs>0`; **on step 0 waits for intent+twin** | `ensureReqPlan` |
| 8 | cascade | reqPlan + a filled spec/answer signal | `inferSpecsFromApplication` |
| 9 | P6 re-rank | intent/answers land after first plan | `planRequirement` re-rank |
| 10 | refine look-ahead | wizard panel open + frozen | `refineQuestions` |
| 11 | last-page belief | `step===2` | `deduceLogistics` |
| 12 | PII prefill | `enrichment.buyer` present | contact/location/firm prefill (N3 = CSL city) |

---

## §2 — The 14 LLM calls (master table)

Model: `MODEL_FAST` = `google/gemini-2.5-flash-lite`; `MODEL_RICH` = `google/gemini-2.5-flash`.
Every prompt is prepended with `INDIA_CTX` (see §3.0). All calls use `response_format: json_object`.

| # | Function | Model | Stage / trigger | Hard guards (verbatim) | maxTok / temp |
|---|---|---|---|---|---|
| 1 | `deriveIntent` | FAST | step≤1, product+qty in, twin settled | `!QUESTION_ENGINE \|\| !hasGeminiKey() \|\| step > 1 \|\| isqSpecs.length === 0 \|\| !form.productName.trim()` ; `if (!qtyReady) return` ; `if (twinPending) return` ; `if (intentSig.current === sig) return` | 512 / — |
| 2 | `planRequirement` (first) | FAST | `ensureReqPlan` (prefetch/handleNext/enterStep2) | `!QUESTION_ENGINE \|\| !hasGeminiKey() \|\| !form.productName` ; `if (planSig.current === sig) return` ; **step-0 debounce:** `if (step===0 && (!intentSettled \|\| twinPending)) return` | 2048 / 0.2 |
| 3 | `planRequirement` (P6 re-rank) | FAST | intent/answer lands after first plan | `replannedOnce` guard; only when a new strongest signal appears | 2048 / 0.2 |
| 4 | `inferSpecsFromApplication` (cascade) | FAST | a lead spec/answer filled, empty mustHaveSpecs remain | needs signal + empty targets | dflt |
| 5 | `inferSpecsFromApplication` (assist text) | FAST | Help-box submit (text path) | `if (!application) return` ; `!hasGeminiKey()` | dflt |
| 6 | `refineQuestions` | FAST | wizard panel open + frozen + upcoming>0 | `!panelFrozen \|\| !intentSheetOpen` ; `if (!upcoming.length) return` | 1024 / — |
| 7 | `deduceLogistics` | FAST | `step===2`, unfilled logistics fields | `if (step !== 2 ...) return` ; `if (logisticsSig.current === sig \|\| !Object.keys(known).length) return` ; `if (!fields.length) return` | 700 / — |
| 8 | `deriveBuyerProfile` | FAST | GLID pull, has digest | `if (profile.digest && hasGeminiKey() && !ignoreTwin)` | 700 / — |
| 9 | `deriveBuyerTwin` | FAST | GLID pull, has signals | `if (profile.signals?.length && hasGeminiKey() && !ignoreTwin)` | 3000 / 0.2 |
| 10 | `getSpecHints` | FAST | product change, specs present | `if (!form.productName \|\| form.productName === prev) return` ; `if (!displaySpecs.length) return` | dflt |
| 11 | `classifyFieldTypes` | FAST | product change (with getSpecHints) | `if (!isqSpecNames.length) return {preference:[],objective:[]}` | 500 / — |
| 12 | `explainSpec` | FAST/RICH* | "Not sure?" click | toggles closed if open; `!hasGeminiKey()` (*RICH only if a photo is attached) | 800 / — |
| 13 | `voiceToSpecs` | RICH | mic recording finished | `if (!hasGeminiKey()) return` | 2048 / — |
| 14 | `analyzeImage` | RICH | image upload (step0 identify / step1 fill) | `if (!hasGeminiKey() \|\| !base64) return` ; stale-token check `if (token !== analysisToken.current) return` | 1024 / — |
| 15 | `generateEnrichmentQuestions` | FAST | **fallback only** if `planRequirement` returns null | `if (... \|\| dynGenSig.current === sig) return` ; `if (!specs.length) return` | 1500 / — |
| 16 | `summarizeRequirement` | FAST | submit (finalizeRequirement) | `if (!combined) return ''` ; `if (!hasGeminiKey()) return stripPII(combined)` | dflt |

(16 sites; "14 calls" counts the two `inferSpecsFromApplication` paths and two `planRequirement` paths as one function each.)

---

## §3 — RAW PROMPTS (verbatim — for ChatGPT/Gemini review)

### §3.0 — `INDIA_CTX` (prepended to EVERY prompt)
```
CONTEXT — INDIA B2B ONLY. This is IndiaMART, an India business-to-business marketplace. EVERYTHING you output must be in Indian context. MONEY/BUDGET/PRICE: ALWAYS Indian Rupees with the ₹ symbol and Indian numbering — use bands like "Under ₹50,000", "₹50,000–₹2 lakh", "₹2–10 lakh", "₹10 lakh+", "₹1 crore+". Use lakh/crore, NEVER million/billion, NEVER $/USD/"dollar". Places = Indian cities/states; standards = BIS/ISI/IS; norms = GST, Indian trade terms. Never use foreign currencies, units, places, or examples.
```

### §3.1 — `deriveIntent` (FAST, 512 tok) — the page-1 WHY question
Interpolated: `args.productName`, `args.quantity` (now real qty or "not specified yet"), `args.unit`, `args.buyerKind`, `args.twinTruths`.
```
A buyer is starting an RFQ. BEFORE any product spec, ask ONE question that reveals WHY they need this — the single most decisive purpose/end-use driver. Adapt the question AND chips to the buyer's JOURNEY, inferred from the product, quantity and who's buying.
Product: "${args.productName}"
Quantity: ${args.quantity?.trim() ? `${args.quantity} ${args.unit || ''}`.trim() : 'not specified yet'}
Who's buying: ${args.buyerKind || 'unknown'}
${args.twinTruths ? `Known about this buyer (high-confidence — use to pre-judge journey + a derived guess): ${args.twinTruths}` : ''}
RULES:
- ONE question. PLAIN simple English, ≤12 words, no preamble, no jargon, warm and human.
- 3-5 SPECIFIC, mutually-exclusive chips tailored to THIS product + journey (the form adds "Other…").
- It MUST capture end-use / purpose — NOT a spec, NOT quantity / location / budget / timeline / payment.
- "journey": EXACTLY one of: retail | resale | industrial | project | maintenance | personal | unknown.
- DERIVE, don't ask, when the purpose is ALREADY clear: if the PRODUCT NAME itself states the end-use (e.g. "tyre polish for car wash", "school bags for resale") OR the buyer's known truths make it unambiguous (e.g. they only ever buy this for resale), set "derivedIntent" to that purpose with "confidence" 85-95 — the form will show it as a one-tap CONFIRMATION, not a question. If the truths merely hint, set "derivedIntent" with "confidence" 50-80. If genuinely unknown, "" and 0.
EXAMPLES (shape only — do NOT hardcode): Cotton Tote Bag → journey "retail" → "What will you use these bags for?" · ["Retail shopping","Corporate gifting","Event giveaway","Resale","Packaging"]. Industrial Filter → "industrial" → "What's driving this requirement?" · ["New plant","Replacement","Capacity expansion","Maintenance"]. Solar Panel → "project" → "Where will these be installed?" · ["Home rooftop","Commercial building","Industrial plant","Government tender"].
Return ONLY JSON: { "journey":"...", "question":"...", "chips":["..."], "derivedIntent":"", "confidence":0 }
```

### §3.2 — `planRequirement` (FAST, 2048 tok, temp 0.2) — the RFQ shape planner
Interpolated: `args.productName`, `args.mcatType`, `args.quantity`, `args.unit`, `args.application` (now `intentApp + requirementNotes`), `args.buyerKind`, `JSON.stringify(args.isqSpecsWithOptions)`, the `prior` history block, the `bpfLine` (persistent profile), and `twinBlock` (one of fast_track / cold_discover / off_profile). The three twin blocks are inserted verbatim:
```
TWIN CIRCUIT-BREAKER: this buyer HAS a history, but the CURRENT product is OFF-PROFILE (unrelated to what they usually buy). DO NOT assume their usual intent / scale / persona — that history does not apply here. Treat INTENT and SCALE as UNKNOWN and LEAD WITH AN INTENT question to learn what THIS order is for. Leave "twinResolved" empty.
```
```
TWIN FAST-TRACK (buyer confidence ${tw.confidence}/100). These facts are ALREADY KNOWN about this buyer from past behaviour — you MUST NOT ask about ANY of them again: ${tw.known}.
Emit AT MOST ONE short CONFIRM question as the FIRST item (kind:"persona", tier:"intent", placement:"wizard", order:0) that lets them verify in ONE tap — options like ["Yes, same as usual","No — this order is different"]. After it, ask ONLY genuinely-decisive UNKNOWN constraints for THIS order — aim for 1-3 questions TOTAL. CRITICAL: do NOT backfill the freed space with extra spec/persona questions to "use up" the budget — specs are collected on the spec page, not here. A known buyer MUST end up with FEWER question cards than a new buyer. Put EVERY topic you skipped because it was already known into "twinResolved".
```
```
COLD BUYER (confidence ${tw.confidence}/100) — we know very little about them. LEAD WITH INTENT (what is this for?) then SCALE (how big / how much per cycle) as chip questions, BEFORE product specs. Specs are secondary until intent + scale are known.
```
Main body:
```
You are planning an IndiaMART RFQ so a SELLER can decide to serve and quote WITHOUT a discovery call.
NORTH STAR — ASK THE FEWEST QUESTIONS THAT STILL LET A SELLER QUOTE. Every question must earn its place; reducing buyer effort beats collecting more. A KNOWN buyer (Twin fast-track) MUST get fewer questions than a new one — never re-ask what we already know.
HARD CAP — return AT MOST 3 questions, EVER (the buyer already told us WHY via the intent step, so these are only the few decisive UNKNOWN constraints left). Never exceed 3, even for a brand-new buyer. If more than 3 seem useful, keep only the 3 highest-value and drop the rest.
LANGUAGE — write EVERY question label, option chip and leadingQuestion in PLAIN, SIMPLE ENGLISH a busy shop-owner reads in one glance: ≤12 words, ONE idea per question, NO preamble ("Since this is a one-time capital expenditure…"), NO jargon ("replenishment cadence", "capital expenditure"), NO run-on sentences. GOOD: "How often will you buy this?" BAD: "How frequently do you anticipate replenishing this inventory?". Keep it warm and human.
OPTIMISE FOR LEAD QUALIFICATION, NOT SEARCH: rank attributes by which, once known, infers the MOST about the rest of the requirement AND who the buyer is — the single most-inferent attribute leads. (e.g. hair wax "Usage: Salon vs Personal" implies hold / finish / pack-size / pricing → it leads, even though it is a spec.)
Product: "${args.productName}"
Category type: ${args.mcatType || 'unknown'} (P=product, S=service)
Quantity: ${args.quantity || '?'} ${args.unit || ''}
Buyer use-case (if any): "${args.application || ''}"
${buyerKind ? PERSONAL/BUSINESS depth hint : ''}
Category ISQ spec fields WITH options — REFERENCE ONLY (the spec dimension a seller expects; NOT the goal): ${JSON.stringify(args.isqSpecsWithOptions)}
[ + optional BUYER HISTORY block (prior persona/knownSpecs/sellerQuestions/isqAnswers) ]
[ + optional PERSISTENT BUYER PROFILE bpfLine ]
${twinBlock}Think about how THIS trade actually sells, then produce a PLAN:
1. "archetype" — classify by HOW THE TRADE SELLS, never by price or bulk:
   • commodity = standard catalog goods sold by spec/grade (resin, film, valves, fasteners — AND furniture, gifts, stationery, consumables, even in bulk).
   • branded_commodity = a commodity where a specific brand/make/OEM drives the buy.
   • capital = MACHINERY / EQUIPMENT that is installed, commissioned, or has a service life (generator, forklift, compressor, CNC, solar plant). NOT furniture / gifts / stationery / consumables — those are commodity however large the order.
   • made_to_spec = built to the buyer's drawing/spec (custom fabrication, custom packaging).
   • project_service = a service or turnkey scope (installation, AMC, consulting).
   • visual_odd_part = identified mainly from a photo/sample (odd spares).
2. "orderMode": "qualifier_first" if "lead" is a non-spec qualifier; "spec_first" otherwise.
3. "specOrder": ALL ISQ spec field names (exactly as listed above), ranked by a COMBINED score — NOT engineering importance alone. Score each by:
   (a) INFERENCE POWER — how much knowing it collapses uncertainty about the rest of the requirement AND who the buyer is;
   (b) BUYER ANSWERABILITY — how confidently THIS buyer can answer it RIGHT NOW, on their own, without asking a supplier. A buyer readily states what they know from their own INTENT — what it's for, rough size/dimensions, look/appearance, branding need, quantity — but only GUESSES at fine-grained fabrication/material metrics (weights, grades, densities, tolerances) that they'd normally ask a supplier to recommend. Rank decision-driving, highly-answerable attributes ABOVE metrics the buyer would merely guess at;
   (c) INFERABILITY — push DOWN anything that can be inferred later from earlier answers;
   (d) DEPENDENCY — ask drivers before the things they determine.
   The #1 spec must be BOTH high-impact AND high-answerability for this buyer. IMPORTANT EXCEPTION: if the buyer profile/history signals a TECHNICAL or repeat buyer who clearly knows the fabrication metrics (e.g. a manufacturer/OEM with prior specced orders), DO NOT demote those metrics — for them they ARE answerable. This is a per-buyer judgement, never a fixed per-category rule.
3b. "specReasons": an OBJECT mapping EACH specOrder field name → a SHORT (≤12 words), PLAIN-ENGLISH sentence saying WHY it sits at that rank …
4. "lead": the ONE intent-driver to ask FIRST … { "source": "spec" | "qualifier", "ref": "..." }
   LEAD RULE: for capital / project_service / made_to_spec, a USE / SCOPE / COMPLIANCE qualifier … almost ALWAYS outranks a single spec …
   APPLICATION/USAGE RULE (STRICT): if an ISQ spec already captures use/application (a field named like Usage / Application / End Use / Suitable For / Industry), the lead MUST be THAT spec … NEVER create a free-text "primary application / which industry / what will you use it for" qualifier …
5. "leadingQuestion": if lead.source=="qualifier", repeat its text here; else "".
6. "mustHaveSpecs": the top 1-4 DECISIVE specs (a subset of specOrder).
7. "personaOptions": 4-6 CATEGORY-TAILORED buyer types — NOT the generic Manufacturer/Stockist/Reseller/Trader/End User. …
8. "questions": 3-6 non-spec questions a seller in THIS trade asks to qualify the lead — kind "context" or "persona" ONLY. …
   a. CHIPS ONLY — NEVER free text. … If you CANNOT enumerate 3-5 concrete options … DROP the question entirely …
   b. DO THE HARD WORK on options — real, decision-useful buckets, NOT lazy yes/no. …
   c. ALWAYS include a CATEGORY-RELEVANT SCALE question in the buyer's own terms …
   d. Cover the scenario signals this category needs … repeat-vs-one-time cadence, supply-only-vs-install, new-setup-vs-expansion, sample/swatch wanted, project/tender, budget band, brand-or-best-rate …
   e. The form ALREADY collects these as dedicated fields — NEVER ask any of them … quantity / order size; delivery LOCATION …; delivery TIMELINE …; PAYMENT …; GST; firm / company name; phone / email / contact.
   f. Do NOT add a buyer-type / "which best describes you" question — "personaOptions" covers identity …
   g. Do NOT emit kind:"spec" …
   h. TAG each question with "tier": "intent" | "scale" | "constraint" | "spec" … The form surfaces them intent → scale → constraint → spec …
9. "serveSignals": what the seller needs to decide serve/no-serve …
RULES: Category-DEFINING only. No generic chatter, no PII … Do NOT duplicate the ISQ fields … BRAND: if ANY ISQ field is about brand/make/OEM, NEVER add a brand question … QUANTITY is a dedicated field — NEVER a question … EVERY question carries 3-5 real option chips.
Return ONLY JSON: { "archetype": "...", "orderMode": "...", "specOrder": ["..."], "specReasons": {...}, "lead": {...}, "leadingQuestion": "", "mustHaveSpecs": ["..."], "personaOptions": ["..."], "questions": [...], "serveSignals": ["..."], "twinResolved": [] }
```
Post-parse code enforces: drop `kind:'spec'`, chips-only, never re-ask covered fields, never restate a spec; sort by tier (intent→scale→constraint→spec); **cap at 3 (fast_track) or 6 (else)**.

### §3.3 — `inferSpecsFromApplication` (cascade + assist, FAST)
Interpolated: `productName`, `application`, `isqSpecNames`, `isqSpecsWithOptions`.
```
You are a B2B procurement expert for IndiaMART.
Product: "${productName}"
Buyer's use-case / application: "${application}"
Spec fields to fill: ${JSON.stringify(isqSpecNames)}
Allowed options per field: ${JSON.stringify(isqSpecsWithOptions)}

Infer the most likely value for each spec field FROM THE USE-CASE.
Rules:
- Only fill a field if the use-case gives reasonable signal; skip the rest.
- Prefer an EXACT option string when one fits.
- If the buyer EXPLICITLY stated a specific value for a listed field that isn't among its options (e.g., a brand/material/size not in the list), return that exact stated value — it will be saved as a custom "Other" entry. Never invent off-list values the buyer didn't actually state.
- Do not invent fields that aren't listed. Details that don't match any field are ignored here (kept elsewhere).
- HONESTY: these values are DOMAIN INFERENCE (a typical configuration), NOT the buyer's stated requirement. The rationale must reflect that — frame it as what is TYPICAL/COMMON for this product. NEVER write "Buyer's requirement for X" / "Buyer needs X" for a value the buyer did not explicitly state in the use-case; that misrepresents an AI guess as a buyer-stated fact.

Return ONLY JSON:
{
  "specs": { "SpecName": "an exact option, or the buyer's explicit custom value" },
  "rationale": "ONE short sentence framed as typical/common domain inference (e.g. 'Typical for car-wash tyre polish: usually silicon-based, high-gloss, spray form'), NOT as the buyer's stated requirement"
}
```

### §3.4 — `refineQuestions` (FAST, 1024 tok) — adaptive look-ahead
Interpolated: `productName`, `JSON.stringify(known)`, `JSON.stringify(upcoming)`.
```
You are tightening the REMAINING questions of an IndiaMART RFQ for "${args.productName}" using what the buyer has ALREADY told us. Make each upcoming question maximally RELEVANT and SPECIFIC to THIS buyer, in their own trade terms.
Already known — never ask these again, but USE them to specialise: ${JSON.stringify(args.known)}
Upcoming questions to revise (keep each "id" EXACTLY): ${JSON.stringify(args.upcoming)}

For each upcoming id return:
- "label": a sharper question given what we know …
- FOLLOW-UP: treat each upcoming slot as the NEXT question given the LATEST answers — you MAY fully RE-PURPOSE a slot into a more decisive follow-up …
- "options": 3-5 SPECIFIC, mutually-exclusive chips in the buyer's terms … Money = ₹ lakh/crore, never $. NEVER free-text/empty.
- "drop": true if what we now know makes the question pointless or duplicate …
Do NOT add brand-new slots (keep the same ids) … NEVER ask (in ANY phrasing) anything the form already collects: quantity/order-size, delivery LOCATION …, timeline …, payment …, GST, firm name, contact.
LANGUAGE: every label MUST be PLAIN SIMPLE ENGLISH — ≤12 words …
Return ONLY JSON: { "<id>": { "label": "...", "options": ["...","..."], "drop": false } }
```

### §3.5 — `deduceLogistics` (FAST, 700 tok) — last-page belief
Interpolated: `productName`, `JSON.stringify(known)` (now includes `Primary use / intent` — fix #6), `JSON.stringify(fields)`.
```
An India B2B buyer is finishing an RFQ for "${args.productName}". Using ONLY what we already know about them, predict the MOST LIKELY answer to each remaining logistics/profile field — so we can pre-fill it instead of asking.
What we know: ${JSON.stringify(args.known)}
Fields to predict (pick the value from the given options): ${JSON.stringify(args.fields)}

For each field id return { "value": <one of its options>, "confidence": 0-1, "reason": "<=10 words, why" }.
- confidence = how sure you are GIVEN the evidence. Be honest: 0.85+ only with real signal (e.g. repeat commercial buyer → Credit terms; urgent salon restock → Immediate). If you're guessing, use <0.6 and we'll ask.
- value MUST be exactly one of that field's options.
Return ONLY JSON keyed by id: { "<id>": { "value": "...", "confidence": 0.0, "reason": "..." } }
```
Client applies a value to the form ONLY at `confidence ≥ 0.8`; records to the registry ONLY at `≥0.8` (fix #3).

### §3.6 — `deriveBuyerProfile` (FAST, 700 tok) — persistent profile
Interpolated: `digest` (the compact history digest).
```
You are building a PERSISTENT buyer profile for an IndiaMART buyer from the signals below. These describe WHO THE BUYER IS (persists across requirements), NOT today's requirement. Deduce only what the evidence supports; be honest with confidence.
BUYER SIGNALS:
${digest}

Return ONLY JSON. For EACH field pick EXACTLY ONE value from its list — NEVER return the list itself or multiple values; omit a field entirely if there's no signal:
{
  "persona": "<one of: Industrial Buyer, Trader, Wholesaler, Retailer, Shopkeeper, Manufacturer, Business Buyer>",
  "maturity": "<one of: New Buyer, Existing Buyer, Repeat Buyer, Business Setup Phase, Execution Phase>",
  "sourcingStyle": "<one of: catalog_driven, spec_driven, brand_driven, application_driven>",
  "buyingPattern": "<one of: trial_first, bulk_first, inventory_builder, one_time_capex, repeat_procurement>",
  "decisionStyle": "<one of: Needs Guidance, Self Driven, Hybrid>",
  "infoSeeking": "<one of: Low, Medium, High>",
  "supplierPreference": "<one of: Manufacturer Preferred, Trader Preferred, No Preference>",
  "localityPreference": "<one of: Local Only, Regional, Pan India>",
  "engagement": "<one of: WhatsApp Friendly, Image Sharing Buyer, Call First Buyer, Low Response Buyer>",
  "responseSensitivity": "<one of: Low Tolerance For Delay, Patient, Unknown>",
  "multiSku": <true or false>,
  "summary": "<one concise line a seller would value …>",
  "tags": ["<short>","<behaviour>","<tags>"],
  "confidence": <a number from 0 to 1>
}
Evidence cues: many WhatsApp messages → WhatsApp Friendly; asks for images/catalog → Image Sharing Buyer; wants factory visit / local area → Local Only; "waited, bought elsewhere" → Low Tolerance For Delay; >1 distinct category → multiSku true; machine/setup → Business Setup Phase / one_time_capex.
```

### §3.7 — `deriveBuyerTwin` (FAST, 3000 tok, temp 0.2) — the heavy Twin pass
Interpolated: identity facts (city/state/language/verified), `companyDesc`, `historicalCategories`, `intentHistory`, and the dated **SIGNALS pool**. Full prompt:
```
Compile a PERSISTENT BUYER TWIN — who this buyer IS across all requirements (not today's order). This Twin will power every future decision, so it must be EVIDENCE-GROUNDED and UNBIASED.
HARD RULES:
- Use ONLY the SIGNALS below as evidence. NEVER invent a fact or a signal. Copy the cited signal text from the pool.
- For EVERY trait you assert, attach 1-2 evidence items {source, date, signal}. If the signals don't support a trait, OMIT that trait entirely. No receipts → no trait.
- NEVER infer brands / manufacturers / trademarks. This is a marketplace; we must not narrow the seller pool.
- Pick EXACTLY ONE value per trait from its allowed list; never return the list.

IDENTITY (facts): city=${city}, state=${state}, language=${language}, verified=${verified}
COMPANY DESCRIPTION: ${companyDesc || '(none)'}
HISTORICAL CATEGORIES: ${historicalCategories.join('; ') || '(none)'}
INTENT HISTORY (counts): ${JSON.stringify(intentHistory)}
SIGNALS (your only evidence):
${pool}   ← each line: "[i] (source, date) signal"

Each trait is an object: { "value": <pick ONE from its list>, "confidence": <0-100>, "contradictions_count": <…>, "evidence": [ { "source": "<pns|whatsapp|csl|bl_history|isq|profile>", "date": "…", "signal": "<copy a line from SIGNALS>" } ] }.
Worked example … "whatsapp_affinity": { "value": "High", "confidence": 90, … }

Also derive (all grounded in SIGNALS):
- "recent_intent_clusters": GROUP the categories into 2-4 BROAD themes — NEVER one cluster per product …
- "explicit_negative_signals": SHORT strings for HARD CONSTRAINTS the buyer EXPLICITLY stated … Return [] if none — never infer.
- "attribution": { "inferred_product_mapping": "<what the buyer ultimately makes/sources for …; null if unclear>", "confidence": <0-100> }.
- "unknowns": dimensions you have NO signal for …

Return ONLY JSON in EXACTLY this shape (omit any trait you cannot support with a signal):
{
  "business_type": "<PRIMARY role, short label e.g. Manufacturer / Trader / Wholesaler / Retailer / Service Provider>",
  "secondary_roles": ["<additional roles ONLY if clearly multi-role; [] otherwise>"],
  "behavioral": { "whatsapp_affinity": {…}, "catalog_driven": {…}, "image_affinity": {…}, "local_preference": {…}, "response_sensitivity": {…}, "decision_style": {…} },
  "commercial": { "inventory_builder": {…}, "multi_category_buyer": {…}, "bulk_orientation": {…}, "trial_first": {…}, "current_active_intent": { "value": "<short intent label e.g. Manufacturing inputs / Packaging / Resale / Project / Personal>", … } },
  "recent_intent_clusters": [ { "intent": "...", "signal_count": 0, "last_seen": "" } ],
  "explicit_negative_signals": [],
  "attribution": { "inferred_product_mapping": null, "confidence": 0 },
  "unknowns": [],
  "summary": "<one concise seller-valuable line, no PII>"
}
```
Post-parse: every trait value normalised to its own vocab; every evidence item must **substring-match a real pool signal** (anti-fabrication) or the trait is dropped; `business_type` = `llmBT (unless it's a job designation) || descRole(from company_desc regex) || 'Business Buyer'`.

### §3.8 — `getSpecHints` (FAST) — name→spec entailment + redundancy
Interpolated: `productName`, `twinContext` (PII/brand-free), `isqSpecNames`, `isqSpecsWithOptions`.
```
You are a B2B product spec expert for IndiaMART.
Product: "${productName}"
${twinContext ? `Buyer background (use ONLY to make "isqHints" more relevant — do NOT use it to fill "knownFromProductName" … NEVER infer a brand from it): ${twinContext}\n` : ''}ISQ fields: ${JSON.stringify(isqSpecNames)}
Fields with options: ${JSON.stringify(isqSpecsWithOptions)}

Only put a value in "knownFromProductName" if it is UNAMBIGUOUSLY entailed by the product name (e.g. "Stainless Steel Bottle" → Material: Steel). If you are not ~certain, leave it out.
NEVER infer a Brand / Make / Manufacturer / OEM / Model — that narrows the seller pool and is forbidden. NEVER guess.

Return ONLY JSON:
{ "knownFromProductName": { "SpecName": "value UNAMBIGUOUSLY implied by the product name (never a brand)" }, "redundantISQSpecs": ["spec names not applicable for this product"], "isqHints": { "SpecName": "short helpful hint, max 8 words" } }
```

### §3.9 — `classifyFieldTypes` (FAST, 500 tok) — VEKA gate (objective vs preference)
```
For the product "${productName}", classify each ISQ field:
- "preference" = a SELLER/BRAND choice that would NARROW the supplier pool if we assumed it — Brand, Make, Manufacturer, OEM, Model name, proprietary/branded variant. The marketplace must NEVER guess these.
- "objective" = a physical/measurable buyer-owned attribute (size, material, capacity, grade, application, usage, colour, type, dimension).
Fields: ${JSON.stringify(isqSpecNames)}
Return ONLY JSON: { "preference": ["exact field names"], "objective": ["exact field names"] }
```
A regex `PREFERENCE_KEYWORDS` (brand|make|manufacturer|oem|model|…) is a safety net unioned with the LLM result.

### §3.10 — `explainSpec` (FAST, RICH if photo, 800 tok) — "Not sure?" decision guide
```
You are helping a B2B buyer in India choose "${specName}" for "${productName}".
Context — quantity: ${ctx.quantity} ${ctx.unit}; already chosen: ${filled || 'none'}; use-case: "${ctx.application || 'unknown'}".${ctx.twinContext ? ` Buyer background: ${ctx.twinContext}.` : ''}
${options.length ? `Options: ${JSON.stringify(options)}.` : 'This field is free-text (no fixed options).'}

Write a SHORT DECISION GUIDE — "this for this", not a single recommendation:
- Map options (or ranges …) to the scenario each suits best.
- 2–4 buckets. Keep each scenario to a few words, plain language, no jargon.
- If the spec is NOT scenario-driven (e.g., a brand list), put short guidance in "note" … keep buckets minimal.
- Set "likely": true on the ONE bucket that best fits THIS buyer's context …
Return ONLY JSON: { "intro": "1-2 plain lines on what this controls", "buckets": [ { "label": "option or range", "scenario": "who/what it's for", "likely": false } ], "note": "" }
```

### §3.11 — `analyzeImage` (RICH, 1024 tok) — image→specs (with-fields variant)
```
Analyze this product image for B2B procurement.
Product context: ${currentProduct || 'unknown'}${useCase}
Spec fields to fill: ${JSON.stringify(isqFieldNames)}
Available options: ${JSON.stringify(isqFieldOptions)}

Use BOTH the image and the use-case (if given). Only fill fields you have signal for.
Prefer an EXACT option string. If the image/use-case clearly shows a specific value for a listed field that isn't among its options, return that exact value (saved as a custom "Other" entry). Put attributes that don't match any listed field in "additionalSpecifications", not in "specifications".

Return JSON: { "productName": "...", "specifications": { "FieldName": "an exact option, or a clearly-shown custom value" }, "additionalSpecifications": { "AttributeNotInFields": "value" }, "quantity": null, "additionalDetails": "other visible details" }
```
(No-fields variant: a shorter "identify this product + key specs" prompt used at step-0 product identification.)

### §3.12 — `voiceToSpecs` (RICH, 2048 tok) — audio→fields (Hindi/Hinglish-aware)
```
Transcribe this audio and extract B2B procurement details.
${specList}

Return ONLY valid JSON:
{ "rawTranscript": "exact transcription", "productName": …, "quantity": …, "quantityUnit": "Pieces/KG/MT/Litre …",
  "deliveryLocation": "delivery city (handle Hindi/Hinglish: 'मुंबई' / 'Mumbai mein kar do' → Mumbai) or null",
  "deliveryTimeline": "map to EXACTLY one of: Immediate, Within 15 Days, 1 Month, Flexible ('10 days'/'10 दिन के अंदर'/'2 weeks' → Within 15 Days; 'turant'/'urgent' → Immediate; 'mahine bhar' → 1 Month) — or null",
  "paymentTerms": "map to EXACTLY one of: Full Advance, Credit (Post-Delivery), COD, Loan/Finance ('credit'/'udhaar'/'क्रेडिट पे' → Credit (Post-Delivery); 'advance' → Full Advance; 'COD'/'delivery pe payment' → COD) — or null",
  "creditPeriod": "ONLY when payment is credit, map to EXACTLY one of: 15/30/45/60/90 Days — else null",
  "mappedSpecs": { "SpecFieldName": "value" }, "customSpecs": [{ "fieldName": "name", "value": "value" }] }
The audio may be in Hindi, English or Hinglish — transcribe faithfully, then extract. … Map deliveryTimeline/paymentTerms/creditPeriod to the EXACT option strings above (so the form can pre-select them).
```

### §3.13 — `generateEnrichmentQuestions` (FAST, 1500 tok) — FALLBACK only (planner null)
Long prompt (only reached if `planRequirement` returns null). Key rules: chips-only, drop anything in the spec list or covered by a dedicated field, ≤`maxQuestions`, each must be CONTEXT or PERSONA (never a product attribute). (Full text in `gemini.ts` `generateEnrichmentQuestions`.)

### §3.14 — `summarizeRequirement` (FAST) — PII-scrubbed seller line
```
Summarise this B2B buyer's requirement for "${productName}" into ONE short, professional line for suppliers.
Specs chosen: ${specsText || 'none'}.
Buyer's notes: "${notes}".

STRICT RULES:
- Describe the PRODUCT NEED only.
- Remove ALL personal/contact info — no phone, email, name, address, company name, links. (Buyer contact is sold separately as a lead.)
- No fluff. Plain language.
Return ONLY JSON: { "summary": "one concise line" }
```

---

## §4 — Branch matrix (what changes by state)

**Entry modality** × **buyer knowledge** × **planner outcome** × **journey**:

| Axis | Branches | Where decided |
|---|---|---|
| Entry | text-typed · dropdown-select · image-upload · voice (main) · voice (assist) | step-0 handlers |
| Knowledge | cold (no GLID) · enriched on-profile · enriched off-profile · partial-profile (mobile only) · auth-failed | `buildTwinPlanInput.offProfile`, `profileMissing`/`profilePartial` |
| Twin confidence | cold_discover (<50) · fast_track (≥60 & known) · off_profile (circuit-breaker) · none | `planRequirement` twinMode |
| Intent | answered · derived-confirm (≥80) · skipped · failed/empty | `deriveIntent` + gate |
| Planner | ok · fallback `generateEnrichmentQuestions` (null) · timeout (raw spec order) | `ensureReqPlan.then` |
| Cascade | fires (lead spec picked) · 0 (no lead signal) | `inferSpecsFromApplication` effect |
| Last-page | deduced ≥0.8 (summary) · <0.8 (asked) · already filled (skip) | `deduceLogistics` + apply gate |
| Buyer kind | business · personal (→ End User, no firm/GST/credit) · unknown | `page1Choice` auto-derive |
| qty | provided · qty=1 on bulk unit (nudge) · empty (no unit) | step-0 qty field + `qtyReady` |

---

## §5 — Worked dry-runs (traced through the branches)

**DR-1 · cable lug, GLID 185257802 (the case under review), POST-fix.**
Pull → partial profile (mobile 9929163666, name blank → N4 picks "Sanjay" from WA; city blank → N3 picks Jaipur/Kanpur from CSL). `profilePartial=true` → verdict "partial-profile". Twin builds (evidence-volume ~39). `historical_categories` includes **"Panel Lug"** → `coreTokens("cable lug")={cable,lug}` ∩ `coreTokens(hist)⊇{lug}` → **not off-profile** → repeat signal + history note (no "new area"). Intent "Electrical panel building" answered → debounced first plan fires **with** intent → planner asks 1 budget Q → buyer picks Lug Type → cascade fills 9 (rationale "Typically for…"). Last page: Payment=Credit 85% (summary), Timeline 75% → **asked** (not recorded, no contradiction). External panel: Befisc/Sign3 `creds_pending`, World **skipped_low_confidence** (no company/GST anchor). **Edge found → G1, G3 (below).**

**DR-2 · tyre polish, cold (no GLID).** No twin → off-profile note suppressed (renderPage1TwinNote returns null when no twin). deriveIntent derives "car wash" if product name entails it (conf 85 → one-tap confirm). Planner cold_discover path (no twin) → leads intent+scale. Cascade fires on Pack Size pick. **OK.**

**DR-3 · diesel generator, enriched, prior gensets.** On-profile (genset↔generator share "generator"); fast_track if twin conf ≥60 → ≤3 Qs + confirm card. Planner archetype=capital → lead = Usage qualifier. **OK.**

**DR-4 · corporate gifts, business, qty 500 pcs.** archetype=commodity (gifts explicitly commodity in prompt). personaOptions category-tailored. No qty nudge (discrete unit "pieces"). **OK.**

**DR-5 · voice "मुझे 100 किलो जिंजर सीड्स मुंबई में 10 दिन में क्रेडिट 45 दिन".** voiceToSpecs maps qty=100, unit=KG, location=Mumbai, timeline=Within 15 Days, payment=Credit, credit=45 Days → all applied to form (the recent logistics fix). Last page shows them pre-filled. **OK.**

**DR-6 · image-only at step 0 (no typed name).** analyzeImage(no-fields) → productName → handleProductCommit → full pipeline. If unidentifiable → toast "type it". **OK.**

**DR-7 · qty=1 on "TMT Bar" (unit=MT).** Nudge "Just 1 MT?" shows (#7). deriveIntent sees real qty "1" (no fake). **OK; but planner still reasons on qty=1 → G6.**

**DR-8 · planner returns null (LLM hiccup).** `ensureReqPlan.then(null)` → resets sig → `ensureDynQuestions` → `generateEnrichmentQuestions` fallback. **OK (degrades).**

**DR-9 · off-profile true but enrichment HAS the category.** Twin's `historical_categories` came back empty (twin LLM omitted it) but `enrichment.categories` has the match → off-profile STILL fires because `buildTwinPlanInput` only reads the **twin**, not `matchCategory(enrichment)`. **→ G1 (real residual for question A).**

**DR-10 · GLID pull, twin conf 39, profile persona "Manufacturer".** Seller line uses `business_type` (e.g. "Manufacturer"); profile.persona also "Manufacturer" → agree. But if twin business_type="Trader" and profile.persona="Manufacturer" → debug shows "two lenses", and the seller line silently uses business_type only. **→ G3 (question C).**

---

## §6 — Chaos cases (expected behaviour + handling code)

| Case | Expected | Handled by |
|---|---|---|
| No product name on Continue | toast, block | handleNext step-0 guard |
| qty required (unit exists), empty/0 | toast, block | handleNext qty guard |
| qty=1 on bulk unit | soft nudge, allow | #7 nudge |
| Vague product ("material") | commit-validity check; invalid → toast | `committedValid` |
| No GLID | cold flow, no twin notes | `liveTwin()===null` guards |
| GLID auth-failed (empty wrapper) | verdict "profile-auth-failed", form runs cold | `profileMissing` |
| GLID partial (mobile only) | verdict "partial-profile", still enriches | `profilePartial` (#11) |
| whatsapp_inbound 404 wrapper | WA-in = 0 ✗err, not 7 | `waInboundCount` (N2) |
| Twin contradicts user | user overrides (authority 100) | coverage lifecycle |
| LLM key missing | all LLM calls skipped, deterministic form | `hasGeminiKey()` guards |
| Planner timeout / null | fallback generator or raw spec order | `ensureReqPlan.then` |
| Intent derivation fails | `intentResolved.current=true` → Continue unblocks | deriveIntent `.catch` |
| Product changed mid-analysis | stale-token discards old image/spec result | `analysisToken` |
| No ISQ specs for category | skip step 1 → step 2; **no intent question** | `isqSpecs.length===0` → G6 |
| Personal buyer | no firm/GST/credit/cadence Qs | `buyerKind==='personal'` |
| deduceLogistics <0.8 | field asked, NOT recorded/claimed | #3 threshold |
| Voice in Hindi | transcribed + mapped to exact option strings | voiceToSpecs prompt |
| Off-profile (real new area) | circuit-breaker: lead intent, no fast-track | `offProfile` twinBlock |
| Cascade with no lead pick | 0 cascade (acceptable) | cascade signal guard → G6 note |
| External: bare mobile | World **skipped_low_confidence** (no bogus) | `anchorStrength` (E) |
| External: company/GST present | World runs (real OSINT) | `anchorStrength` eligible |

---

## §7 — GAP ANALYSIS (found while building this; ranked)

> Convention: ✅ already fixed (your trace predates it) · 🔴 real open gap · 🟠 quality/debt · 🟡 cosmetic.

**✅ A — "Looks like a new area for you"** — `renderPage1TwinNote` → `buildTwinPlanInput().offProfile`, which now tokenises via the **shared `coreTokens`** (≥3 + plural-stem). For cable lug, `historical_categories` contains "Panel Lug" → overlap on "lug" → off-profile **false**. Your trace is pre-fix. **BUT see G1.**

**🔴 G1 — off-profile reads ONLY the Twin's history, not the enrichment categories.** `buildTwinPlanInput(t, productName)` overlaps `productName` against `t.layer_c.historical_categories + current_active_intent` only. If the Twin LLM returns an empty/sparse `historical_categories` (it can — it's LLM-shaped) while `enrichment.categories` clearly has the match, the buyer is STILL flagged off-profile. The matcher is unified; the **data source isn't**. *Fix:* `offProfile = twinHistMiss && matchCategory(enrichment, productName) == null` — i.e. off-profile only if BOTH the twin history AND the enrichment categories miss. (Small, removes the last "new area" false-positive path.)

**✅ B — planner created before intent.** The prefetch effect now **debounces on step 0** until `intentSettled && !twinPending`, and the Continue **gate** blocks leaving page 1 until intent is triggered. So the first `planRequirement` fires with `application = intentApp + notes`. The P6 re-rank (`replannedOnce`) remains as a fallback for buyers who answer intent *after* the plan, but on the happy path it no longer fires. Your "Re-planned after…" trace is pre-fix. *To prove it live:* the first `logPrompt('planRequirement')` inputs will now show `application="Buyer's stated purpose: … = Electrical panel building."` instead of `application=""`. **BUT see G2.**

**🟠 G2 — three plan-trigger paths.** `planRequirement` is reachable from (1) the debounced prefetch effect, (2) `handleNext`/`enterStep2` imperatively, (3) the P6 re-rank effect. All are `planSig`-guarded so they don't double-fire the *same* signature, but it's three code paths to reason about and a latent source of an extra call when `buyerProfile` lands after the first plan (sig gains `|bpf`). *Fix (debt):* consolidate to one "plan when context settles" effect; keep handleNext as a forced-flush only.

**🔴 G3 — no single canonical buyer-type (question C).** THREE independent values exist: `buyerTwin.layer_a_identity.business_type`, `buyerProfile.persona`, `form.buyerType`. The seller-facing `twinContextLine` uses `business_type` (which defaults to **'Business Buyer'**, never literally "Unknown" — so that exact word in your trace is pre-fix), while the role card / concierge set `form.buyerType`, and the debug shows persona separately. They CAN diverge ("Manufacturer" vs "Trader"). *Fix:* a `canonicalBuyerType()` resolver with fixed precedence `form.buyerType (user/concierge) > twin.business_type > profile.persona`, used by the seller line, the Truth Table, and the debug — one value everywhere. (This is task #50's display half; the full retire-deriveBuyerProfile is larger.)

**✅ D — profile-auth-failed despite mobile.** Fixed (#11): the pull now `JSON.parse`s the `buyer_profile` string, `profileMissing` reads the mobile → `profileAuthFailed=false`, and a new `profilePartial` drives the verdict "partial-profile — mobile present, name/company blank". Pre-fix in your trace.

**✅ E — external visibility.** New **External Pull Health** panel (Befisc/Sign3/World per-source ✓/∅/✗/⏸/⏭/🔒 + latency + anchor + the OSINT gate decision). Built this round; not in your (pre-fix) trace.

**🔴 G12 — NO per-call LLM health (the internal analog of E).** `logPrompt` records each call's *inputs* but not its *outcome*: success/failure, latency, token use, JSON-parse-ok, or whether it returned `null`/`{}`. So "did deriveIntent / planner / cascade / deduce actually succeed on this run?" is not answerable from debug today (you infer it from downstream effects). *Fix (high value, matches your repeated ask):* wrap each `gemini.ts` call so `logPrompt` also stamps `{ ok, ms, bytes, parsed, fellBackTo }`, and add an **"LLM Call Health"** debug panel mirroring the External one. This is the single biggest observability gap.

**🟠 G4 — `deduceLogistics` builds `known` by hand, not from the registry.** Cascade/refine/help all consume `requirementContext()` (registry-as-source-of-truth), but `deduceLogistics` assembles its own `known` map. It now includes intent (#6) but can still miss registry facts (e.g. the pre-recorded cadence #8, or cascade specs not in `form.dynamicSpecs`). *Fix:* feed `requirementContext()` into its `known` too — full consistency, one source.

**🟠 G6 — no-ISQ categories get no intent + qty=1 reasoning.** (a) When `isqSpecs.length===0`, `deriveIntent` is guarded off and the form jumps to step 2 — a service/no-spec product never gets the "why" question. (b) The planner reasons on a literal qty=1 (we stopped faking it for `deriveIntent`, but `planRequirement` still receives `quantity:'1'` when the buyer typed 1). *Fix:* allow intent for no-spec categories (gate on product committed, not on specs); pass a `qtyConfidence:'low'` hint to the planner when `qty<=1 && bulk unit`.

**🟡 G7 — voice `setSpec` vs `applyAiSpec`.** Voice-mapped specs use `setSpec` (direct) rather than `applyAiSpec` (manual-no-overwrite aware). A spoken value can overwrite a manually-picked spec. *Fix:* route voice specs through `applyAiSpec`.

**🟡 G8 — cold-buyer planner generates 6 then panel shows 3.** `planRequirement` caps at 6 for non-fast-track, but `dynCards.slice(0,3)` shows only 3. Wasted generation + the dropped 3 are invisible. *Fix:* cap planner output at 3 for the Intent-First era (the HARD CAP comment already says ≤3), or surface the dropped ones in debug.

**🟡 G9 — twinTruths gate at conf≥40.** `deriveIntent` only feeds twin facts to the chips when `tb.confidence≥40`; below that the chips are generic. Intended, but worth a debug note so a low-evidence buyer's generic chips aren't read as a bug.

---

## §8 — Direct answers to your 5 questions

1. **Why is "Looks like a new area for you" still appearing?** In your trace it's **pre-fix**. Post-fix, `renderPage1TwinNote → buildTwinPlanInput` uses the shared `coreTokens`, and "Panel Lug" is in `historical_categories`, so cable lug is on-profile. **Residual (G1):** off-profile keys only on the Twin's history, not `enrichment.categories` — if the Twin omits the category, it can still misfire. Recommend the G1 belt-and-suspenders fix.

2. **Why is the planner created before intent? Prove the first plan includes intent.** Pre-fix in your trace. Post-fix, the step-0 prefetch is **debounced** (`if (step===0 && (!intentSettled || twinPending)) return`) and the Continue **gate** forces intent first — so the first `planRequirement` runs with `application="Buyer's stated purpose: … = <intent>"`. Proof on a live run = the first `logPrompt('planRequirement')` shows a non-empty `application` and there is **no** "Re-planned after…" event. (Architecture note G2: three trigger paths still exist; consolidating is debt, not a bug.)

3. **Show every code path that determines off-profile; confirm one matcher.** Two computations, both via the **single** `coreTokens` (no local `length>=4` tokenizers remain): `buildTwinPlanInput().offProfile` (used by `renderPage1TwinNote`, `ensureReqPlan`, the deriveIntent twinTruths) and `repeatSignal()`; plus `matchCategory()` (enrichment) and `personaSpecMatch()` also use `coreTokens`. **Matcher: unified ✅. Data source: not (G1).**

4. **Canonical buyer type — why "Manufacturer" and "Unknown" at once?** There are **three** independent values (twin `business_type`, profile `persona`, `form.buyerType`) with **no canonical resolver** — that's the real issue (G3). The literal "Unknown" is NOT produced by current code (`business_type` defaults to "Business Buyer"), so that word is from the pre-fix trace; but the divergence risk is real. Recommend the `canonicalBuyerType()` resolver.

5. **External Pull Health panel — say it explicitly, don't make me infer.** Done (E): the panel prints each source's status (`⏸ creds pending`, `⏭ skipped — low-confidence anchor`, `🟢 ✓ ok · 620ms`, `🔴 ✗ failed`, `🔒 blocked`) + the seed + the OSINT gate decision. **Gap remaining (G12):** the same explicit health does NOT yet exist for the 14 *internal* LLM calls — that's the highest-value observability add.

---

## §9 — Recommended next actions (your call — no code changed in this doc)

Ranked by correctness/trust impact:
1. **G3** canonical buyer-type resolver (one value everywhere).
2. **G1** off-profile also consults `enrichment.categories` (kills the last "new area" path).
3. **G12** LLM Call Health panel (per-call ok/latency/parse) — directly answers "did the calls succeed".
4. **G4** route `deduceLogistics.known` through `requirementContext()`.
5. **G6/G7/G8** the smaller consistency items.

Everything in §3 is copy-paste ready for ChatGPT/Gemini review.
