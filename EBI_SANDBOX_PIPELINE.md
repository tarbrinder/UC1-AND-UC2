# Phase 5e — External Buyer Intelligence (EBI) sandbox

> Connect the RFQ to the buyer's outside world (Sign3 + Befisc + GST→HSN + OSINT), as a **separate, sandboxed layer** — internal behaviour stays the source of truth; external data is *context*. **Nothing wired into the form / Twin / ConciergeChip** (frozen at 5c). Standalone runner: `scripts/ebi_sandbox.mjs`.

## Architecture (per ChatGPT + Gemini review)
```
1. Internal Twin (behaviour) ─┐
                              ├─► 4. Procurement Context Engine ─► Planner
2. External Intelligence (EBI)┘     (industry cluster, confidence, align/shift)
3. Evidence Validation (contradiction scoring) between 1 & 2
```
Data priority: **Tier-1 Procurement** (GST/HSN/NIC/Udyam/turnover) ≫ **Tier-2 Commercial** (website/export) ≫ **Tier-3 Identity** (PAN/DOB/income — sandboxed, never feeds the planner). Schema = `BuyerTwinV13.external_buyer_intelligence` (tiered, each field a `GatedExternalSignal{value,source,confidence,contradiction_triggered}`) + synthesized `procurement_context`.

## Auth — CORRECTED: two separate services (resolved live)
The earlier `Authorization: Basic` confusion is resolved — it was a mislabeled smartauth attempt. The real model, both **verified working**:
- **Befisc** = `https://prod.smartauth.co/<code>`, header **`authkey: BRLN0P7NRSLVD6J`** → Profile Advance (`C9S1`, identity), Udyam (`TGAG`), GST (codes unknown). ✅ authenticates.
- **Sign3** = `https://you.sign3.in/v1/persona`, header **`Authorization: Bearer …`**, body `{"phone"}` — a **separate** service. ✅ `status 2000 SUCCESS` (`footprint=established` on probe).

⚠ **Sign3 is Tier-3 SURVEILLANCE data** (social-media/dating-site presence, data-breach history, linked personal emails) — **~zero RFQ value + high DPDP risk**. The sandbox extracts ONLY a coarse non-identifying footprint bucket and **discards** accounts/breaches/emails/names. **Recommendation: do NOT feed Sign3 persona into the Twin** (legal/privacy should decide whether to use it at all). Both *working* APIs are Tier-3 identity; the high-value **procurement** chain (GST→HSN→Udyam) is still blocked on endpoint codes + Udyam privilege — so procurement value remains unproven (~20%).

## Accountability + debug (added per ChatGPT)
- **`externalEvidenceLedger`** — every external fact tagged `{source, key_used, confidence, fetched_at, raw_value}` (identity redacted; PII to `/tmp` dump only). So "packaging manufacturer" always traces to e.g. `{GST, GSTIN→HSN, 92}`. Type added to `worldEnrichment.ts` (`ExternalEvidenceEntry`).
- **Debug-view mock-up** (ChatGPT layout) printed by the sandbox: Internal Signals (PNS/WA/BL/CSL · conf 95) · External Signals (GST/HSN/Udyam/Sign3/World ✓✗ + conf) · Procurement Context · Derived From — renders perfectly once the GST data flows.

## Honest completion status (ChatGPT's correction)
**Phase 5e ≈ 20%, not 80%.** Proven: mobile auto-extraction, Sign3 *integration path* (auth bifurcated), OSINT (conf 92). **Unproven — the whole value:** Mobile→GST, GST→HSN, GST-Advance, Udyam→NIC. No procurement signal has actually been fetched yet. One successful real GLID→GST→HSN→Udyam run is the gate before any of this is "real."

## Live run — GLID 64573225 / mobile 8860600800 (`node scripts/ebi_sandbox.mjs`)
| Branch | Result |
|---|---|
| Internal webhook | ✓ live (5046 b) — **Rajinder Kaur · "Hayden Audio" · New Delhi**; mobile `glusr_usr_ph_mobile` = **8860600800** ✓ (extraction path confirmed) |
| **Profile Advance (Sign3, C9S1)** | ✅ **integration works** — after consent-text fix returned `status 4` (Name-Not-Found for this mobile = auth+consent+call all OK, just no record). 8.7 s. |
| Mobile→Udyam (TGAG) | ✗ **402 no-privilege** — this account lacks the Udyam entitlement |
| Mobile→GST / GST→HSN / GST-Advance | ⏸ **endpoint codes unknown** — skipped gracefully (guessed paths → 403 not-found) |
| **OSINT (web)** | ✅ **high value, works now**: Hayden Audio = New-Delhi **wholesaler/distributor of pro/consumer audio gear** (mics BK-103/105, Bluetooth speakers, X5 studio monitors, mixers, keyboards; site haydenaudio.com + IndiaMART catalog). → buyer **sources audio equipment for resale**. Derived with **no GST**. |
| Pipeline | ✅ completed without crashing; partial-tolerant (your explicit ask) |

**Finding:** OSINT alone already yields strong procurement context (business type + product families) even when GST/Udyam are blocked — it's a viable Tier-1.5 source, not just a fallback.

## Graceful degradation (built in)
Every branch: per-call timeout (`AbortController`, 25 s) + try/catch + status-coded; failure → that branch reported (`unauthorized`/`no-privilege`/`no-record`/`timeout`/`skipped`) and the pipeline continues. Internal-webhook-down, web-unavailable, missing-endpoint-code, missing-key → all degrade to a partial result + a `source availability` map; **never throws**. Identity (Tier-3) is **masked in console by default** (`EBI_MASK_PII`), raw written only to `/tmp/ebi_<glid>.json` on the operator's machine.

## Source-confidence model + per-source debug (your rule)
Every signal is tagged by source trust; the sandbox prints a **per-source fetch breakdown** so debug shows *exactly what came from where*:
- **Authoritative (high):** internal n8n profile/transcript **95** · Sign3 Profile Advance **90** · Befisc GST **92** · Befisc Udyam **90**.
- **OSINT = only as strong as the match key** (`osintMatchConfidence(match_basis)`): unique id (GST/mobile/website/email) → **92** · company-name + website/catalog → **88** · company-name + location → **62** · person name + location → **42 (namesake risk)**.
- Live 64573225 example: `World/OSINT ✓ conf 92 — matched on [company_name, website, marketplace_catalog] (strong id)`; `n8n conf 95 "Hayden Audio"`. Identity (Sign3) stays Tier-3, masked.
- The mobile is **auto-derived from the dump** (`glusr_usr_ph_mobile`) per-GLID — runs from GLID alone, no hardcoded number (works for all 134).

## Blockers — what I need to run the *high-value* chain
1. **GST endpoint codes** (Mobile→GST #47, GST→MCC/HSN #53, GST-Advance #40) — the 4-char `smartauth.co/<code>` values from your Befisc console (only C9S1 + TGAG are in the docs).
2. **Udyam privilege** for the `BRLN…` account (currently 402), if Udyam/NIC is wanted.
3. (Profile Advance already works; it's Tier-3 — low RFQ value, keep sandboxed.)

## Evaluate-before-building (the 4 benchmarks, once GST codes arrive)
Run the full chain on 20–50 GLIDs and ask: did we learn something **new**? did it **improve planning**? did it **reduce questions**? did it **improve supplier matching**? Promote to the Twin only the signals that pass (HSN→industry cluster, enterprise type, turnover band) — and only when they **align** with internal behaviour (contradiction → flag, don't override).

## Build order (when unblocked)
5e.1 Mobile→GST→HSN+Advance · 5e.2 Mobile→Udyam→NIC · 5e.3 OSINT (already proven) · 5e.4 Profile Advance (identity, sandboxed). Then Layer-4 synthesis → review → selectively promote into the Twin.
