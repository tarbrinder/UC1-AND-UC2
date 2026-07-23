// ── Unified analytics emitter ─────────────────────────────────────────────────────────────────────
// ONE funnel sink for the RFQ forms (Simple + Standard). Replaces the three dead/divergent mechanisms
// (utils/analytics.ts gtag stub, utils/funnelEvents.ts localStorage, V3/V4 window.dataLayer) with a single
// emit(). Fixes audit P0-03/P0-04/P1-110/P1-111/P2-224/P2-233.
//
// ⚑ DEV-TODO (analytics sink — owner: "add comments for my developer to resolve"):
//   Today emit() pushes to window.dataLayer (GA4/GTM-ready) AND mirrors to a capped localStorage ring for
//   inspection. NO real backend is wired. Before prod, pick ONE authoritative sink and POST there:
//     • GA4/GTM  → add the gtag/GTM loader to index.html gated on VITE_GA_ID (none configured today), or
//     • n8n / a  /api/events collector → uncomment the navigator.sendBeacon block below and set VITE_EVENTS_URL.
//   Also decide the session/user identity scheme (see SESSION_ID below) — attach GLID for logged-in buyers.
//
// ⚑ PII policy (owner: "ignore PII for now" — do NOT ship raw identity): emit() must NEVER be called with a
//   raw mobile / email / GSTIN. Product name + search query ARE allowed (demand data, not PII — owner-approved).
//   Use hashId() for any identifier you must correlate on. Enforced-by-convention; keep it that way.

const SESSION_ID =
  // per-visit anon id. ⚑ DEV-TODO: replace with a real anon/session-id scheme + GLID for logged-in buyers.
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

const t0 = Date.now(); // module load — used for coarse "since open" timings

/** Non-reversible short hash for any id we must correlate on without shipping the raw value. */
export function hashId(v: string): string {
  let h = 0;
  for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}`;
}

declare global {
  interface Window { dataLayer?: unknown[] }
}

export interface EmitProps { [k: string]: string | number | boolean | null | undefined }

export function emit(event: string, props: EmitProps = {}): void {
  const payload = { event, session_id: SESSION_ID, t_since_load_ms: Date.now() - t0, ...props };
  try {
    // 1) GA4 / GTM dataLayer (works the moment a container/gtag loader is added to index.html).
    (window.dataLayer = window.dataLayer || []).push(payload);
    // 2) Local ring for dev inspection (window.__rfqEvents) — capped, never uploaded.
    const w = window as unknown as { __rfqEvents?: unknown[] };
    (w.__rfqEvents = w.__rfqEvents || []).push(payload);
    if (w.__rfqEvents.length > 300) w.__rfqEvents.shift();
    // 3) ⚑ DEV-TODO: real collector. Uncomment + set VITE_EVENTS_URL to POST the funnel to n8n / /api/events.
    // const url = import.meta.env.VITE_EVENTS_URL;
    // if (url && 'sendBeacon' in navigator) navigator.sendBeacon(url, JSON.stringify(payload));
  } catch { /* analytics must never break the form */ }
}

/** Canonical funnel event names (§8 taxonomy). One taxonomy; `surface` rides as a prop, not a separate stream. */
export const EV = {
  FORM_OPEN: 'rfq_form_open',
  PRODUCT_SEARCH: 'rfq_product_search',
  PRODUCT_COMMITTED: 'rfq_product_committed',
  PRODUCT_COMMIT_FAILED: 'rfq_product_commit_failed',
  INPUT_SOURCE_USED: 'rfq_input_source_used',
  SPEC_PAGE_VIEWED: 'rfq_spec_page_viewed',
  SPEC_FILLED: 'rfq_spec_filled',
  SPEC_DESELECTED: 'rfq_spec_deselected',
  AISPECS_SHOWN: 'rfq_aispecs_shown',
  AISPECS_ANSWERED: 'rfq_aispecs_answered',
  AISPECS_SKIPPED: 'rfq_aispecs_skipped',
  AISPECS_FAILED: 'rfq_aispecs_failed',
  BL_ELIGIBLE: 'rfq_bl_eligible',
  PAGE_TRANSITION: 'rfq_page_transition',
  SCORE_CHANGED: 'rfq_score_changed',
  LOCATION_SET: 'rfq_location_set',
  OTP_REQUESTED: 'rfq_otp_requested',
  OTP_VERIFIED: 'rfq_otp_verified',
  OTP_FAILED: 'rfq_otp_failed',
  REQUIREMENT_SUBMITTED: 'rfq_requirement_submitted',
  FORM_ABANDONED: 'rfq_form_abandoned',
  API_ERROR: 'rfq_api_error',
  TIMING: 'rfq_timing',
} as const;

/** Central failure telemetry — call from every catch (fixes P1-111: failures were silently swallowed). */
export function emitApiError(call: string, err: unknown, extra: EmitProps = {}): void {
  const status = (err && typeof err === 'object' && 'status' in err) ? Number((err as { status: unknown }).status) : undefined;
  emit(EV.API_ERROR, { call, status, message: err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140), ...extra });
}
