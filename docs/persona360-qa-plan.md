# Persona360 — QA & No-Touch Guard Plan (K-3)

> Owner: @batman · Card K-3 on `docs/KANBAN-NEW-UI.md`.
> Guard base: local commit **`9d3fede`** (K-6 baseline, not pushed). Every diff is measured against it.
> Inputs reviewed: plan (`.hermes/plans/2026-08-19_buyer-persona-360-ui.md`), design (`docs/persona360-design.md`), audit (`docs/persona360-data-audit.md`), mockup (`docs/buyer-persona-ui.webp`, visually inspected).

## P0 — No-touch guard (run after EVERY K-5 commit; failure = block)

| # | Check | Command / method | Pass criterion |
|---|-------|------------------|----------------|
| G1 | Diff surface | `git diff 9d3fede --stat` | Only new files under `src/components/persona360/`, `src/lib/persona360Types.ts`, `src/fixtures/persona360Fixture.ts`, plus `src/App.tsx` with **≤ +2 lines** (1 import, 1 gate). Nothing else. |
| G2 | Untracked surface | `git status --porcelain` | Untracked entries only in the new paths above (plus docs/plan files already known). No edits inside `n8n/`, `supabase/`, existing `src/` files. |
| G3 | App.tsx gate placement | read `git diff 9d3fede -- src/App.tsx` | Gate is additive, placed with the other param-gates, before the `MainApp` fallthrough; no existing gate touched. |
| G4 | Route isolation | `grep -n "persona360" src/App.tsx` — exactly one gate line | Existing params (`?profile=`, `?async=1`, `?async-profile=1`, `?rfq=*`) behave identically (verified manually via P1-R). |
| G5 | No npm creep | `git diff 9d3fede -- package.json package-lock.json` | Empty. Hand-rolled SVG per plan §9 — recharts or any new dep is a **fail**. |
| G6 | Baseline is clean | `git diff 9d3fede --stat` run from repo root | Warning-free except known CRLF notice; if baseline itself is dirty, guard is unprovable → block and escalate. |

## P1 — Route regression (manual, existing pages must not change)

| # | Route | Expected |
|---|-------|----------|
| R1 | `?async=1` | Prototype page unchanged — same callback receiver flow, preflight ping, raw event stream. |
| R2 | `?async-profile=1` | Streaming ledger page unchanged. |
| R3 | `?profile=<GLID>` | Standalone buyer profile card unchanged. |
| R4 | `?rfq=*` brain routes | Unchanged. |
| R5 | `?persona360=1` (no glid) | New page renders fixture (or empty/glid-required state — per design; must NOT fall through to MainApp). |
| R6 | no params | MainApp unchanged. |

## P2 — Fixture pixel-parity (mockup `docs/buyer-persona-ui.webp` vs `?persona360=1` fixture mode)

Verified against the webp directly; these exact values must render:

- **TrustStrip**: label `trustScore`, track, knob, value `46`. (Operator/debug strip.)
- **Header**: `Jayveer Singh` + GLID chip `268590579` + orange badge `VBB REPEAT BUYER`; description `Notebook machinery buyer · Kanpur, Uttar Pradesh`; meta `29 · Male` / `3 months` / `6386941152` / `jayveernayak758gna11.com` (as masked in fixture); trust ring `46 of 100`; `TRUST SCORE` label + `Verify before push` (amber); signals: Identity clear (green) · Financials thin (amber) · Behaviour genuine (green).
- **1 · PERSONA**: Assigned-persona navy card `82% match`, primary `Raw Material Processing Manufacturer`, alternate `Component & Machinery Manufacturer`; INDUSTRY `Notebook making machinery` sub `Paper & stationery converting`; STAGE = Startup segment active, note `Micro scale - first plant · <10 people (est.)`; TURNOVER `₹8–10 L declared p.a.` + red warning `Company turnover not declared`; BUYING ENTITY `Proprietor, unregistered` sub `Buys in own name · PAN KDVPS7147Q` (masked per fixture).
- **2 · SOURCING**: Price-vs-quality slider marker near `Lowest price` side with label `Price-led`, evidence `Asks rate first in 8 of 10 enquiries, no brand preference.`; ANNUAL PROCUREMENT `₹18–25 L` sub `est. from basket`; ORDER PATTERN `1–2 / yr` sub `capex, low frequency`; city bars Delhi 42 / Rajkot 33 / Ahmedabad 25 + note `All delivered to Kanpur, Uttar Pradesh`; products ranked 1–3 (`1300 Pcs/Hr notebook making machine` bold first, `Exercise notebook raw material`, `Tata Chhota Hathi tipper body`).
- **3 · RISK & FRAUD**: `RISK SCORE 58 /100` + `WATCH` chip + amber bar; SM RISK `Low` sub `no adverse mentions`; RATING & GRADE `3.8 · B` sub `6 supplier ratings`; FINANCIAL VERIFICATION rows: Balance sheet `Notified` (red pill) / Cheque history `No bounce` (green pill) / Credit exposure `Unrated` (gray pill); FRAUD READ callout (pink fill, red left rule) `No fraud signal — verified identity, consistent enquiries, single intent. Risk is ability to pay, not intent.`
- **4 · INTERNET PROFILE**: dot rows — GST not registered (red, sub `No GSTIN against this PAN`) / PNS profiling active (green, sub `27 calls · avg 2m 10s · answers 84%`) / IINRCA: no entity match (amber, sub `Not a registered company in his name`) / No company history (amber, sub `First IndiaMART account, 3 months old`) / No web or social presence (red, sub `Nothing on Facebook, Instagram, LinkedIn`); VERIFIED pills: Mobile/Email/PAN/Name green; GST/Udyam/TrustSeal gray; PROFILE COMPLETENESS `44%` + bar + `Missing: GST, turnover, business type, TrustSeal`.
- **5 · ENGAGEMENT**: metric cards 34 Sellers connected / 27 Calls made / 20 Enquiries posted / 27 BuyLeads posted; chart title `Monthly demand pattern — one buying burst in May, steady follow-up since`; legend Calls (navy) / Enquiries (blue) / BuyLeads (amber); monthly groups Mar–Aug, May label bold, y-grid 0/4/8/12; fixture monthly rows Mar 2/0/0 · Apr 3/1/1 · May 9/8/10 · Jun 5/4/6 · Jul 4/4/5 · Aug 4/3/5.

Method: side-by-side screenshot vs webp, section by section. Any value drift = fail (fixture must be mockup-exact so future live-mode swaps are diffable).

## P3 — Live mode (K-5 task 9; only if built)

- Webhook `buyer-intelligence` is **GET-registered** (verified in `Buyer-intelligence.json`); POST must 404.
- Parser emits `persona` / `sourcing` / `risk` / `internet_profile` + `__health` / `__sources_present` / `__sources_absent` (verified in workflow code); `pipeline_health` comes from `final-assemble`, not the parser — UI must read the right node.
- **Never-invented-data audit** (design principle 3): trust number, risk number/band, completeness %, monthly buckets, credit/cheque/balance-sheet → `pending` state in live mode when absent. `risk.fraud_seller_detection_score` renders raw 0–1 or `unknown` — **never banded, never 0-when-absent** (workflow's own rule, audit §1).
- Seller-rating label must say seller-side/also-seller, never "buyer trust" (audit §3).
- Empty/loading/error per design §6: column independence — one column's error must not blank siblings.

## P4 — Build hygiene

- `tsc -b` clean — run **in background** (minutes on this machine), `process wait`, never foreground.
- Per-task commits (K-5 sequence 1–9) each re-run P0 G1/G2.
- `VerifyStatus` union is the only badge-key path — grep for hardcoded status strings outside the union.

## P5 — Findings from K-1/K-2 review (already fed to board)

1. **Baseline caveat (G6)**: `docs/KANBAN-NEW-UI.md` was modified after `9d3fede` (chief's board edit) — acceptable since it's a board file, not app code, but every guard run must whitelist it explicitly or chief re-commits the board. Otherwise G1/G2 false-positive.
2. K-1 audit verified against workflow source: claims hold. Parser does NOT emit `pipeline_health` (final-assemble does) — design §6's live source-health panel must account for which response node actually carries it.
3. `profile-bundle` explicitly **bans** LLM emission of `risk_score`, `cheque_risk`, `balance_sheet` etc. — confirms pending-state approach is contract-correct, not just cautious.
