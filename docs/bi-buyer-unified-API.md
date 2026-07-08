# `bi-buyer-unified` — Buyer Intelligence API

One call → a complete, policy-grounded buyer profile for an IndiaMART buyer (GLID). It is **pure backend**: the n8n workflow pulls every source, reconciles them, and runs **one server-side LLM** (Gemini 2.5 Flash) to produce a **FIXED attribute schema** — the *same keys every call*. The hit just fills them. No client-side LLM, no per-call schema drift.

> **Fixed-attributes contract.** The set of possible attributes below (32) is frozen. A given call returns the **grounded subset** — each attribute the engine could support from evidence, with its confidence. Un-groundable attributes are **omitted, never guessed** (the un-answered important ones come back in `needs_input[]`). So treat every documented key as *optional-present*; you never get a key that isn't in this catalog.

---

## Endpoint

```
GET  {API_BASE}/api/imworkflow/webhook/bi-buyer-unified?glid=<GLID>&fast=1
```

| Param | Req | Notes |
|---|---|---|
| `glid` | yes | IndiaMART buyer GLID, e.g. `268590579` |
| `fast` | rec | `1` = fast tier (Web-OSINT + Udyam gated off). The standalone card uses **fast-only**. Same keys as full; fast just grounds fewer when web/Udyam are absent. |

- **Latency:** fast tier ≈ 2–3 min (live multi-source pull + the server LLM). Single blocking response.
- **Webhook path is stable** (`bi-buyer-unified`) across versions.

---

## Response envelope

```jsonc
{
  "glid": "268590579",
  "buyer":   { "<attribute>": { …attribute object… }, … },   // INFERENCE layer — the fixed intelligence schema (LLM)
  "sources": { "<sourceKey>": { "summary": {…}, "raw": {…} }, … },  // FACT layer — deterministic registry + activity
  "needs_input": [ { "attribute": "payment_mode", "missing_reason": "…", "best_next_question": "…" }, … ]
}
```

Two layers, deliberately separate:
- **`buyer{}`** = the **inferred** intelligence (the 32 attributes). Every value is grounded + carries confidence + the sources it used.
- **`sources{}`** = the **deterministic** facts (GST/PAN/Udyam registries, requirement activity, WhatsApp counts, socials…) — never invented, straight from the pull. The 1-pager card renders these directly and overlays `buyer{}` on top.

### The attribute object (shape of every `buyer.<key>`)

```jsonc
{
  "value": "Individual · early-stage manufacturer of paper notebooks",
  "confidence": 88,                    // integer 0–100  (== confidence_breakdown.final)
  "confidence_breakdown": {            // self-reported components (see § Confidence)
    "source_quality": 85, "agreement": 90, "freshness": 90, "conflict_penalty": 0, "final": 88
  },
  "policy": "IDENTITY",                // which Source Policy governed this attribute (see § Policies)
  "reason": "GST absent; persona from repeated notebook-machine BuyLeads + PAN=Individual → early-stage manufacturer",
  "grounded": true,                    // is every word of value supported by cited evidence?
  "sources": ["Requirement", "IndiaMART Buyer Profile", "PAN"]   // the sources actually USED
}
```
The debug UI additionally *derives* Available → Used → Ignored → Roles per attribute from `policy` + `sources` + what's present in the pull — you don't need to send that; it's computable from this object.

---

## The fixed attribute catalog (32)

Grouped WHO / WHAT / HOW / WHERE / WHY / RISK. Each references **one policy** (source order) below.

### WHO — identity (Policy: IDENTITY)
| key | what it tells you | shape / enum |
|---|---|---|
| `business_persona` | one-line "who this buyer is" headline | free text (`<role> · <industry>`) |
| `business_type` | the single business-role token | Manufacturer / Wholesaler / Distributor / Trader / Retailer / Importer-Exporter / Service Provider |
| `sub_industry` | specific industry / sub-sector | free text |
| `scale` | business size band | Micro / Small / Medium / Large |
| `business_stage` | life-stage token | Recently Established / Growing / Established (or "early-stage") |
| `buyer_maturity` | early-stage vs established (kept ≡ business_stage) | "early-stage business" / "established business" |
| `business_story` | one-sentence narrative (no legal name) | free text |
| `decision_maker` | who decides the purchase | owner / purchase-manager / factory / family-business |
| `annual_turnover` | inferred turnover **band** (omitted if only a GST-filed figure) | e.g. "₹1–5 Cr" |

### WHAT — procurement (Policy: PROCUREMENT)
| key | what it tells you | shape / enum |
|---|---|---|
| `products_of_interest` | the buyer's product lines (top 3, ranked, with specs) | free text list |
| `procurement_model` | one-off vs recurring vs bulk | One-time / Recurring / Bulk |
| `purchase_frequency` | how often they buy this line | One-time / Occasional / Recurring (+ cadence) |
| `annual_procurements` | inferred yearly volume / spend **band** | e.g. "~₹10–15 lakh/yr" |
| `procurement_approach` | how methodical / comparison-heavy | free text |

### HOW — buying behaviour (Policy: BEHAVIOUR)
| key | what it tells you | shape / enum |
|---|---|---|
| `price_vs_quality` | price-driven vs quality-driven | Price-sensitive / Balanced / Quality-led |
| `preferred_suppliers` | preferred supplier kind | free text |
| `procurement_challenge` | the main blocker | price / availability / supplier / delivery / specification / trust |
| `communication` | channel + responsiveness + language | free text (language only from buyer-authored) |
| `payment_mode` | payment preference | Advance / Credit / COD / … — **explicit-only, else → needs_input** |
| `delivery_timeline` | required delivery timeframe | explicit only, else → `urgency` |
| `urgency` | time-pressure (fallback for delivery_timeline) | Low / Medium / High |

### WHY — intent (Policy: INTENT)
| key | what it tells you | shape / enum |
|---|---|---|
| `buyer_intent` | current seriousness + stage (recency-weighted; expired leads never lower it) | Low/Medium/High + Browsing/Comparing/Ready-to-buy |
| `business_objective` | why they're buying | expansion / replacement / maintenance / trading / manufacturing |

### WHERE — market (Policy: MARKET)
| key | what it tells you | shape / enum |
|---|---|---|
| `location_sourcing_preference` | operating city + sourcing cities | free text ("Operates in X · Sources from Y") |
| `sourcing_channel` | how/where they source | free text |
| `sales_geography` | market they sell into | local / regional / national / export |
| `target_customers` | who they sell to (if reseller) | free text |
| `selling_channel` | how they sell onward | free text |

### RISK — trust (Policy: TRUST)
| key | what it tells you | shape / enum |
|---|---|---|
| `identity_confidence` | how corroborated the identity is | High / Medium / Low |
| `digital_footprint` | B2B digital presence verdict (telecom + consumer marketplaces stripped) | Strong / Moderate / Limited |

### Classification (Policy: CLASSIFICATION)
| key | what it tells you | shape / enum |
|---|---|---|
| `retail_wholesale` | buys to retail or to wholesale/resell | Mostly retail / Mostly wholesale / Mixed |
| `b2b_b2c` | B2B or B2C | B2B / B2C |

---

## The 7 Source Policies (how sources are weighed)

Each attribute follows one policy; the policy fixes the **source order** (highest-trust first). Web is a **confidence amplifier only** — never an identity/trust source, and a namesake (unanchored) web hit is withheld.

| Policy | Used by | Order (highest → lowest) |
|---|---|---|
| **IDENTITY** | who/identity + classification-adjacent | GST → Udyam → External (Sign3/Befisc/IDfy) → PNS → Buyer Profile → Requirements → CSL → Web* |
| **PROCUREMENT** | what they buy | PNS → WhatsApp → Requirement+ISQ → CSL → Buyer Profile → Web |
| **BEHAVIOUR** | how they buy | PNS → WhatsApp → Requirements → CSL → Buyer Profile → External |
| **INTENT** | why active now | Recent PNS → Recent Requirements → Recent WhatsApp → Recent CSL → Historical |
| **MARKET** | location / sell-to | Verified GST address → Udyam → stated (PNS) → Requirement cities → CSL → Web* |
| **TRUST** | identity_confidence, digital_footprint | Buyer Profile → GST → PAN → Sign3 → Befisc → Web* |
| **CLASSIFICATION** | retail_wholesale, b2b_b2c | GST → Udyam → Requirements → PNS → Buyer Profile |

`*` Web = amplifier only.

---

## The fact layer (`sources{}`) — what deterministic data is available

`buyer{}` is inference; `sources{}` is the raw truth the card also shows directly. Keys present depend on the buyer:

| source key | provides |
|---|---|
| `identity` / `usersince` | name, city/state, member-since, tenure, emails, mobiles, verified-business flag |
| `gst` / `gst_detail_union` / `gstin_union` | GSTIN, legal & trade name, constitution, nature-of-business, registered address, filing cadence |
| `pan_union` | PAN + entity char (P=Individual, C=Company, F=Firm/LLP…) |
| `udyam` | enterprise_type (MSME size), NIC industry, org type, Udyam reg no, address |
| `external` | Sign3/Befisc verified name, social platforms, telecom circle, breaches |
| `requirement` | BuyLeads + ISQ specs — products, quantities, order value, categories, dates |
| `whatsapp` | buyer turns, products enquired, sellers shared, campaign response-rate |
| `csl` | on-site browsing + supplier-discovery signals |
| `mobiles` | multi-vendor mobile consensus (found_by, agreement) |
| `web_osint` | Parallel + Gemini web (website, socials, industry) — **withheld** unless anchored on a verified company/GSTIN |

---

## `needs_input[]`

For important attributes the engine could **not** ground, it returns the question to ask the buyer instead of guessing:

```jsonc
"needs_input": [
  { "attribute": "payment_mode", "missing_reason": "no payment discussion on any call or chat",
    "best_next_question": "Do you usually buy on advance, credit, or part-payment?" }
]
```

---

## Confidence

`confidence` (and `confidence_breakdown.final`) is a self-reported 0–100 with a visible breakdown:

```
final = round( source_quality/100 × agreement/100 × freshness/100 × 100 ) − conflict_penalty   (clamped 0–100)
```
- **source_quality** — authority of the sources used (GST/Udyam/PAN/PNS high; CSL/Web low)
- **agreement** — how strongly independent sources converge
- **freshness** — recency; **pinned to 100** for IDENTITY / TRUST / CLASSIFICATION / MARKET (verified registrations don't go stale); only bites PROCUREMENT / BEHAVIOUR / INTENT
- **conflict_penalty** — subtracted for contradictions

---

## Notes / guarantees
- **Fixed schema** — the 32 keys above are the complete possible set; a call returns the grounded subset. Never a key outside this list.
- **Never fabricated** — `sources{}` values are raw; `buyer{}` values are grounded (each cites `sources`) or omitted.
- **Fast-only** for the standalone — deterministic, quicker; identical keys to a full pull.
- **PAN-only buyers** (no GST/Udyam) return fewer grounded identity attributes — that's honest, not an error.
- **Namesakes** — an unanchored web match (no verified company/GSTIN) is withheld, so `buyer{}` never carries a wrong-firm attribute.
