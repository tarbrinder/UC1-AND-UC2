# Seller-Verify API + `iil_customer_tickets` conflict signal — integration runbook

Saved 2026-08-18 (source: Aditya Bhilkar hand-off). Two parts: (1) the entity web-verify crawler API,
(2) the `iil_customer_tickets` buyer↔seller conflict table — and how both become ASYNC-workflow nodes.

---

## 1 · Seller-Verify API (entity web-verify crawler / OSINT)

Verifies whether a GLID is **also a seller** and scrapes its web footprint (site, catalog, contact
traces). Async job pattern: **fire → poll**.

```bash
# 1. Start a verify job for a GLID
curl -s -X POST "http://34.93.111.50/api/v2/seller/verify" \
  -H "Content-Type: application/json" \
  -H "X-Gemini-Key: $SELLER_VERIFY_KEY" \
  -d '{"glid":"48933236"}'
# → { "job_id": "<id>", ... }        (job_id | jobId | id all tolerated by our client)

# 2. Poll job status (returns progress + result once done)
curl -s "http://34.93.111.50/api/v2/seller/status/JOB_ID_HERE"
# → { "status": "running"|"completed"|"failed", "progress": …, "result": <raw scraper payload> }
```

Facts (verified against the live contract in `src/lib/sellerVerify.ts` + this session's probes):

- **Auth**: the only gate is the `X-Gemini-Key` header (the IndiaMART LLM/Gemini gateway key).
- **Timing**: scrape takes seconds–minutes; poll ~2.5 s; client caps at 120 s.
- **Network**: the bare IP `34.93.111.50` is unreachable from office/VPN egress (connection-level
  failure — status 000 from this machine); it answers from the n8n host. The browser never calls it
  directly — the `/api/sellerverify` proxy (vite + server.js) injects `X-Gemini-Key` server-side from
  `env.LLM_GATEWAY_KEY`.
- **Result shape**: raw scraper payload, passed through as-is under `sources.seller_verify.raw` (no
  stable documented schema — the node distills common keys defensively).

### Leakage / issues / improvements

| # | Severity | Issue | Fix |
| --- | --- | --- | --- |
| 1 | HIGH | **Plain HTTP to a bare IP** — the Gemini key and the GLID (PII) transit in cleartext; a bare IP can never do TLS. | Expose an HTTPS hostname (even self-signed behind the gateway) or route via `imworkflow.intermesh.net`; keep the proxy injection either way. |
| 2 | HIGH | **Key shared in chat** ("give this to claude along with a key") — keys pasted into chat/transcripts/tickets leak permanently. | Move keys via env/vault only. This repo already does it right: `LLM_GATEWAY_KEY` env → proxy injects `X-Gemini-Key`; test scripts read `$SELLER_VERIFY_KEY`. Never paste a real key into a curl that gets screenshotted or logged. |
| 3 | MED | **One shared key = zero attribution** — any holder can fire scrapes (Gemini spend) with no per-consumer rate caps, no revocation without rotating for everyone. | Per-consumer keys + per-key job/rate caps + a `/healthz` + usage log on the service. |
| 4 | MED | `/status/<job_id>` auth not verified — if job ids are sequential/guessable, third parties can read scrape results (entity data). | Make job ids unguessable (UUID) and require the key on status reads too. |
| 5 | MED | **Job-result retention unknown** — scraped entity profiles sitting on the scraper host with no stated TTL. | Auto-purge results after N days; document retention. |
| 6 | LOW | Duplicate scrapes for the same GLID (cost + stale inconsistency). | Cache per GLID (TTL days) + idempotency-key header so re-fires return the cached job. |
| 7 | LOW | 502/504 from restricted networks reads as a mystery failure. | Service should publish a health endpoint; clients already hint the VPN cause (`sellerVerify.ts`). |

### n8n node (ASYNC workflow)

`n8n/seller-verify.code.js` — Code node, house contract `{ summary, raw, __health }`. Reads the key
from n8n env (`SELLER_VERIFY_KEY` / `LLM_GATEWAY_KEY` / `LLM_KEY` — set it in the instance env, never
in the node). Fire → poll (≤75 s default, `SELLER_VERIFY_MAX_MS` overridable) → distill. Wire: fan out
from the tier resolver alongside the other sources → into the DUMB-MERGE barrier → register
`seller_verify` in final-assemble's source registry → clone an `emit-prep/emit-post` pair with
`source: 'seller-verify'` for the live-callback stream.

Why it matters for the persona: `buyerprofile.summary.is_also_seller` is the cheap self-declared flag;
this node is the **external confirmation** (real catalog/site found). `conflict_tickets` (below) then
answers "and is that seller side already in disputes?"

---

## 2 · `iil_customer_tickets` — buyer↔seller conflict signal

Live schema (from Redash queries 19334 / 19335 / 12023, data source 13):

- `iil_customer_tickets`: `CUSTOMER_TICKET_ID` · `RESPONDENT_GLUSR_ID` (the **accused** GLID) ·
  `COMPLAINANT_GLUSR_ID` (the **complainant** GLID) · `CUSTOMER_TICKET_STATUS` ·
  `CUSTOMER_TICKET_ISSUEDATE` · `CUSTOMER_TICKET_CLOSEDATE` · `is_ticket_by_sts_owner`
- `iil_customer_tickets_type` (`FK_IIL_CUSTOMER_TICKETS_ID` → ticket, `fk_type_id`, `FK_GROUP_ID`):
  - **`fk_type_id = 181` → `BS_Conflict`** (buyer-seller conflict)
  - **`fk_type_id = 306` → `PreBS_Conflict`** (pre-BS conflict)
  - scope filter: `FK_GROUP_ID = 3`; drop self-raised: `is_ticket_by_sts_owner = 0 OR NULL`

Existing Redash queries worth knowing:

| QID | Name | What |
| --- | --- | --- |
| 12023 | BS Conflict | **Parameterized `{{glid}}`** — count of 181-tickets, 365 d, `respondent_glusr_id = glid`. Usable TODAY. |
| 19334 | Pre_BS&BS_Conflict_Tickets | date-windowed ticket list (181+306), both parties, statuses. |
| 19335 | Count_by_RespondentGlid_… | respondent-ranked counts for a date window. |
| 18211/19405/20301 | Claude - conflict analyzer caller lookup | analyst batch lookups (hardcoded GLID lists) — the team already mines this daily. |

### The two directions that matter for a buyer pull

1. **Buyer as RESPONDENT** (`respondent_glusr_id = glid`) — the buyer *as a seller* is being complained
   about → persona risk / trust flag; pairs with `seller_verify` (confirmed seller side + disputes =
   strong "buyer is really a seller" signal, fraud-adjacent).
2. **Buyer as COMPLAINANT** (`complainant_glusr_id = glid`) — the buyer has filed conflicts against
   specific sellers → that `RESPONDENT_GLUSR_ID` list is a **personalized seller-exclusion list** for
   RFQ routing/curated-seller search (never re-match these two parties), and complaint frequency/recency
   is an engagement/seriousness signal (with a serial-complainer fairness cap so one angry buyer can't
   nuke many sellers' scores).

### v1 → v2 node plan

- **v1 (works today)**: `n8n/conflict-tickets.code.js` fires QID **12023** with `parameters:{glid}`,
  Redash job-poll pattern (same as `csl-enrich-mcat`), reads `total_tickets` →
  `summary.bs_conflict_as_respondent_365d`. Key from n8n env `REDASH_API_KEY` (same key the workflow's
  Redash nodes use — set once in instance env; do NOT hardcode keys in repo files).
- **v2 (create one new Redash query, then only the QID changes)** — both directions, richer shape:

```sql
SELECT ict.CUSTOMER_TICKET_ID,
       CASE WHEN ictt.fk_type_id = 181 THEN 'BS_Conflict' ELSE 'PreBS_Conflict' END AS ticket_type,
       ict.RESPONDENT_GLUSR_ID, ict.COMPLAINANT_GLUSR_ID,
       ict.CUSTOMER_TICKET_STATUS, ict.CUSTOMER_TICKET_ISSUEDATE, ict.CUSTOMER_TICKET_CLOSEDATE
FROM iil_customer_tickets ict
JOIN iil_customer_tickets_type ictt ON ictt.FK_IIL_CUSTOMER_TICKETS_ID = ict.CUSTOMER_TICKET_ID
WHERE ictt.FK_GROUP_ID = 3 AND ictt.fk_type_id IN (181, 306)
  AND (ict.is_ticket_by_sts_owner = 0 OR ict.is_ticket_by_sts_owner IS NULL)
  AND ict.CUSTOMER_TICKET_ISSUEDATE >= current_date - interval '365 days'
  AND (ict.RESPONDENT_GLUSR_ID = '{{glid}}' OR ict.COMPLAINANT_GLUSR_ID = '{{glid}}')
ORDER BY ict.CUSTOMER_TICKET_ISSUEDATE DESC;
```

  Node parses rows into: `as_respondent{count, open, bs, prebs, last_date}` (persona risk),
  `as_complainant{count, conflicted_seller_glids[]}` (the exclusion list), `__health` per house style.

### Wiring + follow-ups

- Both nodes: fan out from the tier resolver → DUMB-MERGE barrier → final-assemble registry →
  `emit-prep/emit-post` pair cloned with `source: 'seller-verify'` / `'conflict-tickets'`.
- Frontend (when the workflow ships them): add to `AsyncBuyerProfilePage` `PIPELINE_SOURCES` +
  `SOURCE_TO_KEY` (`'seller-verify'→'seller_verify'`, `'conflict-tickets'→'conflict_tickets'`), add
  labels to `BuyerLedgerView` `NODE_LABEL`, and consider a "Disputes" lamp on the card's traffic-light
  strip fed by `conflict_tickets.summary.as_respondent`.
- Curated-seller search (UC2): join the `conflicted_seller_glids` exclusion list into
  `curated_seller_search` request params so re-matching conflicted pairs is impossible server-side.
