# Buyer-Persona 360 UI — Implementation Plan (parallel track)

> **For Hermes:** Execute via the team Kanban (`docs/KANBAN-NEW-UI.md`). This plan specs the cards; each card owner works only inside its boundary.

**Goal:** Build the proposed buyer-persona dashboard (mockup: `docs/buyer-persona-ui.webp`) as a NEW page — zero changes to existing pages, workflows, or behavior.

**Architecture:** Additive query-param route following the repo's established App.tsx gate pattern (`?profile=`, `?async=1` …). One new top-level page component + a component folder + a typed fixture. Fixture-first so design/build is never blocked on backend; live wiring to the **`Buyer-intelligence` workflow** (`n8n/Buyer-intelligence.json`, webhook `buyer-intelligence`) is a later, isolated task. NOT buyer-persona-async — user-confirmed.

**Tech stack:** React + Vite + TS (existing), Tailwind (existing), hand-rolled SVG for the grouped bar chart (no new deps), recharts NOT added (YAGNI).

---

## Ground rules (board-level, enforced on every card)

1. **No modifications to existing behavior.** Only allowed diff to an existing file: `src/App.tsx` — exactly 2 added lines (1 import, 1 gate). Everything else = new files only.
2. New code lives in: `src/components/persona360/` (+ `src/lib/persona360Types.ts`, `src/fixtures/persona360Fixture.ts`).
3. `n8n/`, `supabase/`, all other `src/` files are frozen for this track.
4. Verification of rule 1: `git diff --stat` at review time must show only new files + `src/App.tsx` (+2 lines).
5. `tsc -b` takes minutes on this machine — always background it (`process wait`), never foreground.

## The mockup, decomposed (build reference)

Screen = single buyer-360 detail view. Sections in visual order:

| # | Section | Key content |
|---|---------|-------------|
| 0 | Trust strip | `trustScore` slider-like control, value 46 |
| H | Header (navy) | Name, GLID badge, orange `VBB REPEAT BUYER` badge, one-line description, meta row (age/gender · member since · masked phone · masked email); right: trust ring 46/100 + recommendation "Verify before push" + 3 signal bullets (Identity clear / Financial chain / Behavior genuine) |
| 1 | PERSONA | Assigned-persona card (82% match, primary "Raw Material Processing Machinery", alt "Component & Machinery Manufacturer"), Industry, Stage of business (segmented scale Startup→Enterprise, est. size), Turnover (₹8–10L declared + red "Company turnover not declared"), Buying entity (Proprietor unregistered, masked PAN) |
| 2 | SOURCING | Price-vs-quality gradient slider ("Price-led" + evidence note), Annual procurement ₹18–25L (est. from basket), Order pattern 1–2/yr capex, Procurement cities share bars (Delhi 42% / Rajkot 33% / Ahmedabad 25%, note "All delivered to Kanpur"), Products of interest (3 ranked items) |
| 3 | RISK & FRAUD | Risk score 58/100 + band WATCH, SM risk Low (no adverse mentions), Rating & grade 3.8 · B (6 supplier ratings), Financial verification rows (Balance sheet: Notified/red · Cheque: No bounce/green · Credit: Unrated/gray), Fraud read callout panel (pale pink, red rule) |
| 4 | INTERNET PROFILE | Status rows w/ colored dots (GST not registered · PNS profiling active w/ call stats · no entity match · no company history · no web/social presence), VERIFIED tag row (Mobile, Email, PAN, Name green; GST, Udyam gray), Profile completeness 44% + missing list (GST, Turnover, Business type, TrustScale) |
| 5 | ENGAGEMENT (6 mo) | 4 metric cards (Sellers connected 34 · Calls 27 · Enquiries 20 · BuyLeads 27), grouped monthly bar chart Mar–Aug (navy Calls / blue Enquiries / orange BuyLeads) + annotation "one buying burst in May, steady follow-up since" |

Color semantics: navy=primary, blue=activity, orange=caution/action, green=positive/verified, red=missing/concern, gray=unknown/unrated. Status taxonomy (verified / not registered / no match / active / notified / no bounce / unrated / missing) must be a shared TS union — not free strings.

## Data contract sketch (`src/lib/persona360Types.ts`)

```ts
export type VerifyStatus = 'verified' | 'not_registered' | 'no_match' | 'active'
  | 'notified' | 'no_bounce' | 'unrated' | 'missing' | 'no_presence' | 'not_checked';

export interface Persona360Data {
  glid: string;
  identity: { name: string; badges: string[]; description: string;
    age?: number; gender?: string; memberSince?: string;
    phoneMasked?: string; emailMasked?: string; };
  trust: { score: number; max: 100; recommendation: string;
    signals: { label: string; state: 'good' | 'caution' | 'bad' }[]; };
  persona: { primary: string; matchPct: number; alternate?: string;
    industry: string; industrySecondary?: string;
    stage: 'startup' | 'sme' | 'mid' | 'enterprise'; stageEstimate?: string;
    turnover: { display: string; declared: boolean; warning?: string };
    entity: { type: string; detail?: string; panMasked?: string }; };
  sourcing: { priceQuality: { label: string; position: number; evidence?: string };
    annualProcurement: { display: string; basis: string };
    orderPattern: { display: string; note: string };
    cities: { name: string; sharePct: number }[]; deliveryNote?: string;
    products: string[]; };
  risk: { score: number; band: string; smRisk: string; smNote?: string;
    rating?: { value: number; grade: string; count: number };
    financial: { label: string; status: VerifyStatus }[];
    fraudRead: { verdict: string; detail: string }; };
  internet: { rows: { label: string; sub: string; state: 'good' | 'caution' | 'bad' }[];
    verifiedTags: { name: string; verified: boolean }[];
    completeness: { pct: number; missing: string[] }; };
  engagement: { windowMonths: number; metrics: { label: string; value: number }[];
    monthly: { month: string; calls: number; enquiries: number; buyleads: number }[];
    annotation?: string; };
}
```

The fixture (`src/fixtures/persona360Fixture.ts`) encodes the mockup's exact values (GLID 268590579, Jayveer Singh, all numbers above) so pixel-compare against the webp is possible.

## Card-by-card plan (maps 1:1 to the Kanban)

### K-1 · Data-source & gap audit — @scout (starts now)
**Note: @user has corrected the source of truth — the current workflow is `n8n/Buyer-intelligence.json` (webhook `buyer-intelligence`), NOT buyer-persona-async. Audit against Buyer-intelligence. Your earlier async-oriented findings remain useful context but do not drive this build.**
Deliver `docs/persona360-data-audit.md`:
- For every field group above, mark: EXISTS (which node: identity / external / pns / requirement / web_osint / gst / pan / udyam / csl / conflict-tickets / profile-llm) / PARTIAL / MISSING.
- Key confirmations already made by @chief from the workflow JSON: the `08 — Intelligence Parser` node already regroups flat attributes into the exact 4 sections the mockup shows (**Persona / Sourcing / Risk / Internet Profile**), with Risk carrying deterministic source flags (never LLM-scored) + conflict_tickets count; trust summary is emitted by the `external` node (Befisc + Sign3).
- Still to resolve: trust/risk *scores* (mockup wants numeric 46/58 — current parser appears flag-based; what computes numbers?), monthly engagement aggregation (Mar–Aug calls/enquiries/buyleads — any node return per-month counts? pns-insights? BL profile? whatsapp-conversations?), supplier ratings (3.8·B, 6 ratings), credit exposure / cheque history / balance-sheet statuses, "PNS profiling active" call stats (pns-insights1/p2 should have these), profile-completeness % + missing-field list.
- End with a field→node mapping table and a "contract gaps" list (what Buyer-intelligence would need to add later to fill the mockup 100%).
Acceptance: every section 0–5 in the table above has a row; no "unknown" left that a repo/doc read could answer.

### K-2 · UI architecture & design tokens — @doraemon (starts now, parallel to K-1)
Deliver `docs/persona360-design.md`:
- Component tree: `Persona360Page` → TrustStrip / PersonaHeader(+TrustRing) / PersonaCol / SourcingCol / RiskCol / InternetCol / EngagementSection(+MonthlyBars svg).
- Layout spec (grid: 4 columns + bottom band), spacing, the color→semantic token table, the VerifyStatus→badge-style map.
- Responsive fallback (columns stack) and empty/loading/error states per column (each column must render standalone from fixture even if a sibling's data is absent).
- NO file writes outside docs/ — this card produces zero src changes.
Acceptance: a builder can implement every section from the doc without re-viewing the webp.

### K-5 · Build — @steve (after K-1 ∧ K-2; card now spec'd)
Task sequence, each its own commit:
1. `src/lib/persona360Types.ts` + `src/fixtures/persona360Fixture.ts` (mockup values).
2. `src/components/persona360/Persona360Page.tsx` shell + App.tsx 2-line additive gate `?persona360=1` (placed with the other gates, before `MainApp` fallthrough, after existing gates → existing routes untouched).
3. Header + TrustRing (SVG ring, score, recommendation, signal bullets).
4. Persona column. 5. Sourcing column (gradient slider = positioned marker on CSS gradient; city share bars).
6. Risk column (status badge component keyed on VerifyStatus union; fraud callout).
7. Internet column (dot rows, tag row, completeness bar).
8. Engagement (metric cards + hand-rolled grouped SVG bar chart w/ legend + annotation).
9. Async wiring (isolated): fetch layer mirroring `AsyncBuyerProfilePage.tsx` webhook/callback pattern, fixture fallback when unreachable — NO n8n changes.
Verify each task: `tsc -b` in background; visual diff vs webp section by section.

### K-3 · QA & no-touch guard — @batman (test plan during K-2; execution after K-5)
- Guard: `git diff --stat` shows only new files + App.tsx ≤ +2 lines; grep proves no existing route/param behavior changed (`?profile=`, `?async=1`, `?async-profile=1`, `?rfq=*` all behave identically).
- Functional checklist per section 0–5 vs fixture; chart values; badge colors vs status taxonomy; error/empty states; tsc -b clean.

### K-4 · Docs & handoff — @librarian (after K-3)
- README section: route (`?persona360=1&glid=…`), fixture vs live mode, how it runs alongside current pages, board decisions log.

## Risks / open questions
- **Reachability requires touching App.tsx (2 additive lines)** — the only "change" to an existing file; it's the repo's established pattern. Strict-zero-touch alternative (separate Vite HTML entry) touches `vite.config.ts` instead — worse. Decision needed from @user (recommended: App.tsx gate).
- Backend contract for ~60% of fields is unverified until K-1 lands → fixture-first keeps this off the critical path.
- Chart hand-rolled to avoid a new dependency; if @user prefers recharts, that's a scope add.
