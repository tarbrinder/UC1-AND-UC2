# Kanban — New Buyer-Persona UI (parallel track)

> User directive: **new UI — do NOT change any current stuff.**
> Board owner: @chief · Created by @steve · Cards assignee = bot responsible.
> **Detailed spec:** `.hermes/plans/2026-08-19_buyer-persona-360-ui.md` (mockup decomposition, data contract, card acceptance criteria). Every card owner reads it first.
> **Source of truth:** `n8n/Buyer-intelligence.json` (webhook `buyer-intelligence`) — user-confirmed. Async workflow is context only.

## Backlog
- [ ] **K-6 · Clean-tree baseline commit** — @steve — **BLOCKER, do first**
      Working tree is dirty (12 modified + many untracked incl. n8n/, .hermes/, docs/).
      Commit or stash existing local work so the no-touch guard (`git diff` = only new files +
      `src/App.tsx` +2) is provable. No new-UI code until this lands.

## To Do
- [ ] **K-3 · QA & no-touch guardrails** — @batman
      Guard checklist proving existing pages/workflows untouched (only allowed existing-file
      diff: `src/App.tsx` +2 lines; `git diff --stat` proof at review). Draft during K-2,
      execute after K-5. Also: spot-check K-1 audit (now in Review) — especially the
      "scores not emitted / show pending, never invent" claims.
- [ ] **K-4 · Setup + handoff docs** — @librarian
      README-style section for running the new UI alongside the current one (route
      `?persona360=1`, fixture vs live mode), plus handoff notes once K-2/K-5 land.
      Preserve: Buyer-intelligence.json is sole source of truth; unavailable scores show
      pending/unavailable, never invented; baseline-before-code rule.

## In Progress

## Review
- [ ] **K-2 · UI architecture & design tokens** — @doraemon — **DELIVERED** `docs/persona360-design.md`
      (component tree, navy/orange token map scoped to persona360/, VerifyStatus→badge styles,
      per-section geometry + exact fixture values, empty/error/pending states; audit gaps render
      `pending`, never invented). Zero src/ writes. Awaiting @steve build acceptance.
- [ ] **K-1 · Data-source & gap audit** — @scout — **DELIVERED** `docs/persona360-data-audit.md`
      (4 sections map directly; numeric trust/risk scores NOT emitted; monthly engagement +
      completeness need formulas; PNS call stats from pns-parser.summary). Awaiting @batman spot-check.

## Done
- (empty)

## Notes
- K-5 (build, @steve) unblocked when: K-2 delivered ∧ K-6 baseline landed. The 9-task
  commit-by-commit sequence is in the plan.
- Nothing in the existing app (src/, n8n/, supabase/) is modified by this track.
  That is enforced as a board rule on every card above.
