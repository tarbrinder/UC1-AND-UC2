# Buyer Intelligence — Constitution (v11)

The architectural source-of-truth for the RFQ Buyer-Intelligence pipeline. Five contracts + two matrices + the
pipeline diagram. When a prompt, parser, or source changes, update the relevant contract here FIRST. This is what
keeps the single extract LLM honest and prevents prompt drift (ChatGPT review, adopted).

North-star (locked): **n8n → ONE extract LLM → display, nothing in between. No arithmetic. One prompt.** Per-question
LLM fan-out is explicitly REJECTED — it breaks cross-signal consistency (intent informs persona informs location),
multiplies cost/latency, and violates the one-call lock. Routing is encoded as the Source-Priority Matrix *inside*
the single prompt, not as separate calls.

---

## 1. Architecture (one slide)

```
GLID
 → n8n fetch (8 sources: Profile · Requirement(BL⨝ISQ) · WhatsApp · PNS · CSL · Befisc · Sign3 · GST[v11])
 → per-source PARSERS  (Parser Contract §4)
 → DUMB-MERGE (sync barrier) → final-assemble  → { sources{}, derived_anchors, source_registry, source_priority, requirement_brain }
 → bundleFromResponse → fN evidence bundle
 → ONE extract LLM (Buyer Question Matrix §6 + Source-Priority Matrix §2)   ── label: extractBuyerProfile (extract-v4)
 → extractedToFinals → critic prune → FinalAttr[]  (the Buyer Twin / UC1)
 → UC2 enrichRequirementLLM (uc2Enrich.v2) over the SAME bundle → requirement corrections/adds
 → Buyer Ledger (UC1 right card) + Requirement card (UC2 left) + UC3 form
 ⟂ side-rails: deterministic decoders (PAN/GST) · crawler (sellerVerify, frontend, async) · raw-decode ladder
```

---

## 2. Source-Priority Matrix (who wins, per dimension — higher wins)

| Dimension | Priority order |
|---|---|
| persona / maturity | PNS (spoken) > Identity > External(Befisc/Sign3) > CSL |
| intent | PNS > WhatsApp(buyer) > Requirement(BL/ISQ) > CSL |
| requirement (specs) | Requirement(BL⨝ISQ) > PNS |
| location / sourcing | PNS > Befisc/Sign3 > WhatsApp(buyer-stated/"near me"/seller cities) > CSL > Profile |
| trust / identity | Identity(Profile⊕Befisc⊕Sign3) > External > PNS |
| price / quantity | PNS(spoken) ≈ WhatsApp(typed) > Requirement(posted ISQ) — on conflict, SHOW both, recommend the lower trial |

The live pipeline also ships `source_priority` (authoritative); `renderSourceGuide` prefers it and overrides this
static copy when present.

---

## 3. Source Contract (authoritative-for / NOT)

| Source | Authoritative for | NOT authoritative for | Trust |
|---|---|---|---|
| **Profile / GLUSR** | Identity, email, mobile, registered city, member-since/tenure | business type, intent, urgency, persona | high (self-declared) |
| **Requirement (BL⨝ISQ)** | declared demand, answered specs, category names, recency/status | current intent off an EXPIRED lead (expiry = neutral, not negative; content still usable) | high |
| **PNS (spoken calls)** | intent, requirement narrative, persona, maturity, location, price/qty/GSM, applications | identity verification | high (buyer spoke) |
| **WhatsApp (one timeline)** | buyer turns = real signal (typed enquiries, location, objections) | side:ours (our pitches) = context only, never intent | medium |
| **CSL** | on-site search/browse behaviour | anything when empty (no >30-day data ≠ bug) | medium |
| **Befisc (external)** | verified name, income band, age/gender/DOB, PAN, precise address | primary intent (corroboration only) | high (observed) |
| **Sign3 (external)** | verified name, social-platform PRESENCE, telecom circle | per-platform tenure ("since N years" is NOT in data) | high (observed) |
| **GST (Mobile→GST, v11)** | registered-business signal, GST state, embedded PAN | intent | high (KYB) |

---

## 4. Parser Contract (every parser SHALL, before data reaches the LLM)

Remove wrappers · remove IDs/timestamps/parse-flags (plumbing) · resolve enums · resolve MCAT/category NAMES ·
resolve city/product NAMES · merge timelines chronologically · merge RFQ+ISQ on offer_id · normalize units ·
preserve chronology · explain source (every fN tagged with its node) · drop empties · **never silently truncate**
(no per-line cap — a GSM/price/qty buried past char 220 must still reach the LLM). v11 additions: CSL must exclude
the buyer's own glid from viewed-suppliers; WhatsApp must emit `location_preference` + `seller_cities`; WhatsApp
`response_rate` capped ≤100%.

---

## 5. LLM Contract (LLM owns vs deterministic code owns)

- **LLM owns (>1 source ⇒ confidence + grounding + harness + eval):** business_persona, buyer_maturity,
  sub_industry, products_of_interest (ranked), buyer_intent, procurement_model, purchase_frequency,
  price_vs_quality, communication, location_sourcing_preference, delivery_timeline (explicit-only), digital_footprint,
  identity_confidence; and the UC2 requirement corrections/adds. Each self-reports `confidence` 0-100 + `grounded`,
  citing ≥1 fN. Rule: confidence ≥70 only when ≥2 ids agree OR one strong spoken (PNS) id. Ungrounded/below-gate → held.
- **Deterministic code owns (1 source ⇒ `deterministic` badge, NO LLM):** name resolution + confidence band, PAN
  entity (panDecode), GST decode (gstDecode), income/purchasing-power band (Befisc), age/gender/DOB, member-since,
  precise address. These are single-source passthrough — the LLM does no reasoning and must NOT emit them.
- **Provenance rule:** `>1 source → LLM · N src` badge; `1 source → deterministic` badge. This is the dividing line.
- **Confidence logic answer (owner Q):** yes — the LLM gives confidence (self-assessed 0-100, gated by grounding).
  Deterministic facts use a source-trust band instead of a fabricated %.

---

## 6. Buyer Question Matrix (the frozen questions the system answers)

extract-v4 keys: `business_persona`(→"Buyer Persona") · `buyer_maturity`(new-entrant vs established) ·
`sub_industry` · `products_of_interest`(ranked, ≤3 core) · `buyer_intent` · `scale` · `procurement_model` ·
`purchase_frequency` · `communication` · `price_vs_quality` · `delivery_timeline`(explicit-only) ·
`location_sourcing_preference`(operating + all sourcing cities) · `identity_confidence` · `digital_footprint`.
**Removed in v11:** `repeat_buyer`, `next_best_seller_action`, `purchasing_power`(→deterministic), `urgency`(→delivery_timeline).

**Coverage metric (adopted):** Buyer-Question Coverage = answered ÷ askable, alongside grounded% and confidence,
surfaced as the honesty metric (with PNS-coverage: every PNS hero fact consumed / rejected-with-reason / unaccounted).

---

## 7. Where it lives (file map)

- Prompt: `src/lib/buyerProfileExtract.ts` (EXTRACT_BUYER_PROFILE_SYSTEM, bundleFromResponse)
- UC2: `src/lib/uc2Enrichment.ts` (UC2_ENRICH_SYSTEM v2, mergeUC2LLM)
- Deterministic decoders: `src/lib/panDecode.ts`, `src/lib/gstDecode.ts`; name/docs resolve in `src/lib/buyerDetails.ts`
- Crawler: `src/lib/sellerVerify.ts` (frontend, async) + `/api/sellerverify` proxy
- LLM plumbing + raw I/O capture: `src/lib/gemini.ts` (`getLLMRaw` carries raw input + raw output per label)
- n8n: `RFQ Buyer Insights — v11 [bi-user-insights-v10x].json` (webhook path unchanged; GST sub-flow + Befisc/Sign3 retry + CSL self-supplier + WhatsApp fixes)
- Harnesses: `scripts/{extracttest,uc2evaltest,decodetest,attrlineagetest,identitytest}.mjs`

---

## 8. FROZEN — Buyer Question Matrix (full table)

| Question (key) | Owner | Primary → fallback sources | Parser | LLM vs deterministic | Confidence |
|---|---|---|---|---|---|
| business_persona ("Buyer Persona") | LLM | PNS → BuyLead/ISQ cluster → CSL | merge/normalize | LLM | formula §9 |
| buyer_maturity (new-entrant/established) | LLM | PNS seller-discovery Qs → narrative | merge | LLM | formula §9 |
| products_of_interest (ranked ≤3) | LLM | Requirement → PNS → WhatsApp(buyer) | RFQ⨝ISQ, names | LLM | formula §9 |
| buyer_intent (Low/Med/High + stage) | LLM | PNS → WhatsApp(buyer) → CSL → fresh BL | timeline | LLM | formula §9 |
| location_sourcing_preference (operating + all sourcing cities) | LLM | PNS → Befisc/Sign3 → WhatsApp → CSL → Profile | resolve cities | LLM | formula §9 |
| procurement_model · purchase_frequency | LLM | PNS order_types → BL cadence | — | LLM | formula §9 |
| price_vs_quality | LLM | WhatsApp objections + PNS rate-talk | — | LLM | formula §9 |
| delivery_timeline (EXPLICIT only) | LLM | spec/ISQ field or buyer-stated date | — | LLM (omit if absent) | formula §9 |
| communication | LLM | PNS lang + WhatsApp responsiveness | — | LLM | formula §9 |
| digital_footprint | LLM | Identity member-since + Sign3 presence + circle | — | LLM (presence-only; no fake tenure) | formula §9 |
| identity_confidence | LLM | Profile ⊕ Befisc ⊕ Sign3 agreement | — | LLM | formula §9 |
| **name** | det. | Profile ⊕ external verified | resolveBuyerName | deterministic (+band) | source band |
| **purchasing_power (income)** | det. | Befisc income (single source) | — | deterministic | source band |
| **PAN entity / GST** | det. | Befisc/identity → panDecode/gstDecode | decode | deterministic | source band |
| **age / gender / DOB / member-since / address** | det. | Befisc / Profile (single source) | — | deterministic | source band |

## 9. FROZEN — Confidence Formula
`confidence = evidence_quality + source_authority(PNS/WhatsApp-buyer highest) + cross_source_agreement − contradictions − missing_evidence`.
Bands: 2+ high-authority sources agree → 85–95 · one strong spoken (PNS) → 75–90 · single weak/indirect → 50–70 · contradicted/thin → <50 (grounded:false). LLM self-reports this (gated by grounding). Deterministic facts show a **source-trust band** (verified-external vs self-declared), not a model %.

## 10. FROZEN — Parser Contract (Drops / Keeps / Transforms)
- **Drops:** wrappers · ids · timestamps · parse flags · plumbing (`SKIP_KEY`) · empties · the buyer's own glid from CSL viewed-suppliers.
- **Keeps:** every buyer-originated value (no per-line truncation) · chronology · status/recency · `side:buyer` vs `side:ours`.
- **Transforms / Resolves:** enum→label · MCAT→category name · city/product id→name · RFQ⨝ISQ on offer_id · units normalized · `response_rate` capped ≤100 · WhatsApp `location_preference`+`seller_cities` emitted · GST via Mobile→GST.
- **Never:** reasons, ranks, or invents. Reasoning is the LLM's job only.

## 11. Attribute Lineage (why THIS answer won)
For every LLM attribute, `attributeLineage.ts` structures: **Question → Winning Source (most-authoritative cited) → Supporting Sources → Conflicting Sources (ruled-out alternatives) → Evidence ids → LLM decision → Final + Confidence**. Rendered as a one-line strip in the cleaned reasoning drill; distinct from provenance (where) — this is *why it won*. Harness: `scripts/attrlineagetest.mjs`.
