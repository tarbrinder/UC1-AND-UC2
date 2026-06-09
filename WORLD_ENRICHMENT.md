# World Enrichment — connecting the RFQ to the buyer's outside world (design + status)

> Befisc + Sign3 (Profile Advance) + GST→HSN + company OSINT. **Standalone module built; NOT wired into the form** — placement decided after your ChatGPT/Gemini review. No fixes to existing flow.

---

## 1. The idea

The Twin today knows the buyer's IndiaMART behaviour. This adds the buyer's **real-world business identity** — what they actually trade in (HSN), their scale (GST turnover band), MSME status, and public footprint — so the RFQ understands *why* they're buying. Demonstrated live below.

**The chain** (all from one input — the buyer's mobile, already in our dump as `glusr_usr_ph_mobile`):

```
mobile ──► Mobile→GST (#47) ──► GSTIN
                                  ├─► GST→MCC (#53)      → Type of Goods + HSN + MCC   (what they trade in)
                                  └─► GST (Advance) (#40) → turnover band · SAC/HSN · compliance · addresses
mobile ──► Mobile→Udyam (#72)  → MSME: enterprise type · NIC activity
company ─► OSINT (public web)  → business summary · product lines · "is also a seller?"
[gated]  Profile Advance (#98/C9S1) → personal: name/DOB/income/addresses/alt-phones/PAN  (OFF by default)
```

The GST/Udyam/HSN steps run **in parallel** off the GSTIN (`fetchWorldContext`, `Promise.all`).

---

## 2. What's LIVE vs BLOCKED (probed today)

| | Status |
|---|---|
| `prod.smartauth.co/C9S1` (Profile Advance) | ✅ **LIVE** — returns `{status:401,"Authkey missing or invalid"}` (proves endpoint + shape; just needs key) |
| `prod.smartauth.co/TGAG` (Udyam) | ✅ **LIVE** — same 401 |
| **Befisc/smartauth authkey** | ❌ **MISSING** — not in `.env` (only `VITE_LLM_KEY`). Needed for every call. |
| **Per-API endpoint codes** for Mobile→GST / GST→MCC / GST-Advance | ❌ **NOT in the shared PDFs** — only `/C9S1` + `/TGAG` are. The I/O *contracts* are documented; the codes live in your Befisc console. |
| Mobile source in our dump | ✅ Confirmed `glusr_usr_ph_mobile` (e.g. 6732501 → `9910110910`). Same field for 64573225 → its mobile (you gave `8860600800`). |
| Enrichment webhook (n8n) | ⚠ **DOWN right now** — GET→200/0 bytes, POST→500 for all GLIDs (worked earlier today). Needs re-activation to fetch any GLID's company/GST live. |

**To run the real chain I need from you:** (1) the **authkey**, (2) the **endpoint codes** for the GST/mobile APIs (or confirm the base+codes), (3) the **webhook back up** (to pull company name for OSINT + mobile per GLID).

---

## 3. Live OSINT demo (the part I *could* run — on a buyer already on disk: 6732501)

Input: **Nanda Traders / "CutPit Bags" / Gurugram** (from the dump). Public web search returned:
- Confirmed entity: Nanda Traders, Rajeev Nanda, C-56 Sector 45, Gurugram 122003.
- **This buyer is ALSO an IndiaMART seller** — live catalog: Cutpit Wooden Designer Bags (₹1800), Natural Fibre Bags (₹999), Wooden Ladies Bags (₹2500).
- Product lines: PU-leather / canvas / felt **ladies' bags**; eco-friendly positioning.
- **Inference**: when this buyer posts an RFQ, they're sourcing **manufacturing inputs** (PU leather, canvas, felt, zippers, hardware, packaging) — a massive context lift for the planner.

Sources: indiamart.com/nanda-traders-gurgaon/aboutus.html · indiamart.com/proddetail/cutpit-wooden-designer-bags-21303850612.html · …natural-fibre-bags-21308910473.html · …wooden-ladies-bags-21308910697.html

This is the proof that "connect the RFQ to the buyer's world" works and is high-value.

---

## 4. What was built (`src/lib/worldEnrichment.ts` + `scripts/worldtest.mjs`)

- `fetchWorldContext({mobile, gstin?, companyName?, city?, authkey, endpoints, includePersonal?, osintFn?})` → `WorldContext` (business + osint + gated personal + per-step status + confidence). Parallel, never-throws, partial-tolerant.
- `worldToTwinSignals(world)` → only **business** signals for the Twin: `trades_in · hsn[] · business_nature · gst_verified · is_also_seller · osint_summary`. **No turnover figures, no contact, no personal data** crosses this boundary.
- `scripts/worldtest.mjs` — readiness probe (ran ✅) + full-chain runner gated on `SMARTAUTH_KEY` + endpoint-code env vars.

---

## 5. Privacy / compliance — two tiers, deliberate

- **BUSINESS tier** (GST/HSN/turnover-band/Udyam/OSINT): appropriate B2B context → feeds the Twin; **only HSN/sector** is seller-facing (turnover stays internal).
- **PERSONAL tier** (Profile Advance: name, DOB, **income**, home addresses, alt personal phones, PAN): **OFF by default** (`includePersonal:false`); consent-gated (the API requires `consent:Y`); under India's **DPDP Act** this needs a lawful basis. **Recommendation: do NOT feed personal-tier into the Twin or sellers** — keep it KYC-ops/debug only, server-side.
- **PROD**: this MUST run **server-side** — keys + the returned PII can never reach the browser (same rule as the enrichment webhook).

---

## 6. Open questions for the ChatGPT/Gemini review (placement)

1. **Where in the flow** to compile world-context: at GLID-resolve (alongside the Heavy Twin, server-side) is the natural home — it's heavy + cacheable per buyer.
2. **What to surface**: feed HSN/sector/"is-also-seller" into the planner's twin context; show a seller-safe line ("sources bag-making inputs") in the requirement? Never the turnover/personal.
3. **Personal tier**: include at all, or business-only? (My default: business-only.)
4. **OSINT engine**: LLM-knowledge vs a real search API (Serp/Bing) server-side.
