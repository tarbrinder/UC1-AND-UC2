// ─── Type-E enquiry parser (2026-08-11) ─────────────────────────────────────────
// The RFQ display API (bi-rfq-details → raw.rfq.RESPONSE.DATA.Listing) mixes two record types:
//   TYPE "B" = the buyer's own posted requirements / buyleads  (already surfaced as "Continue where you left off").
//   TYPE "E" = OUTBOUND enquiries he sent to specific SELLERS   (product + seller + status + recency) — the highest-
//              intent signal we have (he reached out, not just browsed). This was being dropped: fetchRfq only read
//              summary.requirements (B-derived), so the seller / geography / intent of every E record never reached
//              the frontend. This PURE parser lifts them out. Dependency-free so the node:test suite can load it.
//
// PII: the E record carries the seller's email (R_EMAIL) and the buyer's own email (SENDEREMAIL) — NEITHER is
// emitted. Only the seller ORG + GLID + the product/status/recency travel (same masking discipline as everywhere).
export interface Enquiry {
  product: string;            // DIR_QUERY_MODREF_NAME — what he enquired about
  seller_org?: string;        // R_ORGANIZATION — the seller he contacted (his de-facto shortlist)
  seller_glid?: string;       // QUERY_RCV_GLUSR_USR_ID — the seller's GLID (for dedup vs seller-search / future enrich)
  seller_city?: string;       // not in the display API (ADDITIONALINFO is null) — reserved for Redash 19404 enrichment
  status?: string;            // Approved / Rejected
  recency_days?: number | null;
  message?: string;           // "I am interested in <product>"
}

const str = (x: unknown): string | undefined => { const v = String(x ?? '').trim(); return v && v.toLowerCase() !== 'null' ? v : undefined; };

/** OFR_DATE "20260520124432" (YYYYMMDDHHMMSS) → days before nowMs. Falls back to null when unparseable. */
function recencyDays(rec: Record<string, unknown>, nowMs: number): number | null {
  const raw = String(rec.OFR_DATE ?? rec.SORTING_ORDER ?? '').trim();
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(t)) return null;
  const d = Math.floor((nowMs - t) / 86_400_000);
  return d >= 0 ? d : 0;
}

/** Parse the RFQ display Listing → the buyer's enquiries, deduped by product (most-recent wins), PII stripped.
 *  `nowMs` is injected (not Date.now()) so the parser is pure + unit-testable. */
export function parseEnquiries(listing: unknown, nowMs: number): Enquiry[] {
  const rows = Array.isArray(listing) ? listing : [];
  const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out: Enquiry[] = [];
  const seen = new Map<string, number>();   // canonical product → index in `out`
  for (const r0 of rows) {
    const r = r0 as Record<string, unknown>;
    if (String(r.TYPE ?? '') !== 'E') continue;   // B records are handled by the requirements path
    const product = str(r.DIR_QUERY_MODREF_NAME);
    if (!product) continue;
    const e: Enquiry = {
      product,
      seller_org: str(r.R_ORGANIZATION) ?? str(r.S_ORGANIZATION),
      seller_glid: str(r.QUERY_RCV_GLUSR_USR_ID),
      status: str(r.STATUS),
      recency_days: recencyDays(r, nowMs),
      message: str(r.MESSAGE),
    };
    const key = canon(product);
    const idx = seen.get(key);
    if (idx == null) { seen.set(key, out.length); out.push(e); }
    else if ((e.recency_days ?? 1e9) < (out[idx].recency_days ?? 1e9)) out[idx] = e;   // keep the more recent enquiry
  }
  return out;
}

/** The RFQ display API's UserDetail block carries the buyer's own city/state — a bonus location source. */
export function parseUserDetail(dataDetail: unknown): { city?: string; state?: string } {
  const u = (dataDetail && typeof dataDetail === 'object') ? (dataDetail as Record<string, unknown>) : {};
  return { city: str(u.GLUSR_CITY), state: str(u.GLUSR_STATE) };
}
