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
- [ ] **K-3 · QA & no-touch guardrails** — @batman (draft now, execute after K-5)
      Review K-1 audit + K-2 design (both in Review below). Guard: `git diff 9d3fede --stat`
      may only show new persona360 paths + `src/App.tsx` ≤ +2 lines; existing params
      (`?profile=`, `?async=1`, `?async-profile=1`, `?rfq=*`) behave identically.

## Review
- [ ] **K-1 · Data-source & gap audit** — @scout — delivered `docs/persona360-data-audit.md`
- [ ] **K-2 · UI architecture & design tokens** — @doraemon — delivered `docs/persona360-design.md`
      (component tree, token map, VerifyStatus→badge map §4, per-column states §6, fixture contract §7)

## Done
- [x] **K-6 · Clean-tree baseline commit** — @steve — `9d3fede` local on `main`, not pushed (verified by @chief: `git status` clean).

## Notes
- Critical path: K-5 (@steve) → K-3 execution (@batman) → K-4 (@librarian).
- Nothing in the existing app (src/, n8n/, supabase/) is modified by this track.
  That is enforced as a board rule on every card above.
