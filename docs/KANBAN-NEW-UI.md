# Kanban — New Buyer-Persona UI (parallel track)

> User directive: **new UI — do NOT change any current stuff. No GitHub sync — none.**
> Board owner: @chief · Created by @steve · Cards assignee = bot responsible.
> **Detailed spec:** `.hermes/plans/2026-08-19_buyer-persona-360-ui.md` (mockup decomposition, data contract, card acceptance criteria). Every card owner reads it first.
> **Source of truth:** `n8n/Buyer-intelligence.json` (webhook `buyer-intelligence`) — user-confirmed. Async workflow is context only.
> **Guard base:** local commit `9d3fede` (K-6, not pushed). All persona360 diffs are measured against it.

## To Do
- [ ] **K-4 · Setup + handoff docs** — @librarian
      README-style section for running the new UI alongside the current one (route
      `?persona360=1`, fixture vs live mode), plus handoff notes once K-5 lands.
      Preserve: Buyer-intelligence.json is sole source of truth; unavailable scores show
      pending/unavailable, never invented; no GitHub sync; baseline `9d3fede` is the guard base.

## In Progress
- [ ] **K-5 · Build page** — @steve — **UNBLOCKED** (K-2 ∧ K-6 done)
      New files only under `src/components/persona360/` + `src/lib/persona360Types.ts` +
      `src/fixtures/persona360Fixture.ts`; ONLY allowed existing-file diff = `src/App.tsx`
      +2 lines (`?persona360=1` gate). Work against design doc `docs/persona360-design.md`
      (§7 fixture contract) + audit `docs/persona360-data-audit.md`. 9-task sequence with
      per-task commits is in the plan. tsc -b in background. Commit locally only — NO push.
- [ ] **K-7 · Live wiring — persona360 off buyer-persona-async** — @steve (build) · @doraemon (trigger path) · @batman (contract QA) — chief-authorized 2026-08
      User task: main-screen buyer-persona input box → GET `/api/imworkflow/webhook/buyer-persona-async`
      → response rendered on `?persona360=1`. New files: `PersonaLauncherDock.tsx`, `persona360/Persona360LivePage.tsx`,
      `lib/persona360Live.ts` (adapter sources{} → Persona360Data), `lib/__tests__/persona360Live.test.ts` (RED ✓ @batman),
      `fixtures/persona360-live-sample.json` (@doraemon, real wire capture). App.tsx allowed ~4 additive lines (gate swap + dock).
      Trigger = `buyer-persona-async` per explicit user instruction — see Notes. Commit locally only — NO push.
      **Status:** @doraemon DONE — receiver+tunnel alive (https://sleeps-handmade-wages-making.trycloudflare.com), real wire fixtures committed local main@10b01a4 (final 107KB + 10 partials; glid 268590579/fast, 2026-08-18 run), source order + cache-gate contract (nocache=1, key res:{glid}:{tier}, 24h TTL) documented.
      **⚠ BLOCKER (external):** shared n8n webhook unresponsive since ~15min pre-report — GET returns HTTP-000 (TCP connects in <100ms, 0 bytes; chief independently reproduced 10s timeout). 5 attempts failed; background nocache=1 retry live. Live e2e DEFERRED until recovery — fixture-driven verification is the interim gate.
- [ ] **K-3 · QA & no-touch guardrails** — @batman (RED done → execute after K-7)
      Guard: `git diff 9d3fede --stat` may only show new persona360 paths + `src/App.tsx` ≤ ~4 lines
      (K-7 extension, chief-authorized); existing params (`?profile=`, `?async=1`, `?async-profile=1`, `?rfq=*`) behave identically.
      Known pre-existing base failure `substringGuard.test.ts` (3 subtests, inspectorData/observatoryView/rfqEvals) =
      repo hygiene, NOT a K-7 blocker; excluded from Steve's gate, re-verified by @chief at final gate.

## Review
- [ ] **K-1 · Data-source & gap audit** — @scout — delivered `docs/persona360-data-audit.md`
- [ ] **K-2 · UI architecture & design tokens** — @doraemon — delivered `docs/persona360-design.md`
      (component tree, token map, VerifyStatus→badge map §4, per-column states §6, fixture contract §7)

## Done
- [x] **K-6 · Clean-tree baseline commit** — @steve — `9d3fede` local on `main`, not pushed (verified by @chief: `git status` clean).
- [x] **K-5 · Build page (fixture-first)** — @steve — `?persona360=1` gate live, 4-band layout, fixture contract §7, `data`/`mode='live'` swap point built in.

## Notes
- Critical path: K-7 (@steve/@doraemon/@batman, parallel) → K-3 execution (@batman) → K-4 (@librarian).
- **K-7 workflow decision (chief, 2026-08):** the user's live-wiring task explicitly names `buyer-persona-async`
  as the trigger and its response as the render source. The board's "source of truth = Buyer-intelligence.json"
  rule stays in force for the fixture/design contract (K-1/K-2/K-5) and for any future buyer-intelligence-based
  variant; it does NOT apply to K-7's trigger. Consequence (verified in the ASYNC export): the async final payload
  is final-assemble `sources{}` WITHOUT the 08-parser sections — the adapter derives persona/sourcing/risk/internet
  client-side, and "never invent scores" audit rules apply unchanged. Adapter isolated in `persona360Live.ts`
  precisely so a future buyer-intelligence swap is a one-file change.
- Nothing in the existing app (src/, n8n/, supabase/) is modified by this track.
  That is enforced as a board rule on every card above.
