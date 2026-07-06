// ─── BUYER TWIN STORE — the production buyer-twin cache (runs the ONE extract synthesis once per GLID) ──────────
// V10 (owner-locked): "n8n → LLM, nothing in between." EVERY real buyer pull (V3, V4, Observatory) flows through
// enrichment.fetchEnrichment, which fires ensureMergedTwin(glid, raw). We bundle the source SUMMARIES (no regex, no
// arithmetic, no persona) and fire the ONE extract LLM call (the sole twin authority), then cache the twin per GLID.
// Idempotent (one LLM call per GLID; retry only on error). Consumers + the Observatory + the form read it via
// getMergedTwin(glid)/waitForMergedTwin so they all show the SAME twin. There is NO arithmetic fallback anywhere
// (owner #1): a genuine miss (no key / non-rich shape / empty LLM out) yields an HONEST empty entry, and the form's
// resolveExtractTwin returns null on that → the caller's own legacy prefill is the only safety net.

import { buildPrunePrompt, applyPrune, synthEval, type FinalAttr, type SynthEval } from './synthesisEngine';
import { pruneTwinLLM, extractBuyerProfileLLM, hasGeminiKey } from './gemini';
import { bundleFromResponse, buildExtractPrompt, extractedToFinals, type RichResponse } from './buyerProfileExtract';

// rich bi-user-insights shape detector (inlined to avoid a static import cycle with enrichment.ts)
const isRichShape = (raw: unknown): boolean => !!raw && typeof raw === 'object' && !Array.isArray(raw) && 'sources' in (raw as Record<string, unknown>) && typeof (raw as { sources?: unknown }).sources === 'object';

export interface MergedTwinEntry {
  glid: string;
  status: 'loading' | 'done' | 'error' | 'no-key';
  finals: FinalAttr[];
  evalSummary: SynthEval;
  ms: number;
  ts: number;
}

const cache = new Map<string, MergedTwinEntry>();
// upgrade-on-web bookkeeping (P1b): the fast pull gates web_osint OFF and builds the twin first; the later full pull
// carries web. Without this, ensureMergedTwin's idempotency makes the full pull a no-op → web NEVER reaches the extract
// LLM in the dashboard. We rebuild ONCE when a web-bearing pull follows a web-less twin. runToken drops any stale
// completion (the in-flight fast run) so it can't overwrite the newer web-aware result.
const builtWithWeb = new Set<string>();
const upgradedOnce = new Set<string>();
const runToken = new Map<string, number>();
// "web ran with content" — a non-empty web_osint summary OR any citation/proof row (fast pull → absent/empty → false).
function hasWebContent(raw: unknown): boolean {
  const s = (raw && typeof raw === 'object') ? (raw as { sources?: Record<string, unknown> }).sources : undefined;
  const w = (s && typeof s === 'object') ? (s as Record<string, unknown>).web_osint : undefined;
  if (!w || typeof w !== 'object') return false;
  const wo = w as Record<string, unknown>;
  const sum = (wo.summary && typeof wo.summary === 'object') ? wo.summary as Record<string, unknown> : {};
  const basis = Array.isArray(wo.basis) ? wo.basis : (Array.isArray(wo.proofs) ? wo.proofs : []);
  const sumKeys = Object.keys(sum).filter((k) => { const v = sum[k]; return v != null && v !== '' && !(Array.isArray(v) && v.length === 0); });
  return sumKeys.length > 0 || basis.length > 0;
}
export function getMergedTwin(glid: string): MergedTwinEntry | undefined { return cache.get(String(glid || '')); }
// Poll the cache until the eager extract/merged synthesis SETTLES (done/error/no-key) or the deadline passes —
// lets the P1 cutover read the finished twin without HARD-blocking the form (caller renders progressively + falls
// back to legacy/arithmetic on timeout). Returns whatever entry exists at timeout (possibly still 'loading').
export async function waitForMergedTwin(glid: string, timeoutMs = 30000): Promise<MergedTwinEntry | undefined> {
  const key = String(glid || '').trim();
  if (!key) return undefined;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const e = cache.get(key);
    if (e && (e.status === 'done' || e.status === 'error' || e.status === 'no-key')) return e;
    if (Date.now() >= deadline) return e;
    await new Promise((r) => setTimeout(r, 120));
  }
}

type Put = (e: MergedTwinEntry) => void;
const empty = (key: string, status: MergedTwinEntry['status']): MergedTwinEntry => ({ glid: key, status, finals: [], evalSummary: synthEval([]), ms: 0, ts: Date.now() });

// THE extract path (the only twin builder) — bundle the source SUMMARIES (no regex/arithmetic/persona), one LLM call,
// map → FinalAttr, SAME prune pass. On any genuine miss (no out / empty / throw) emit an HONEST empty 'error' entry —
// NO arithmetic fallback (owner #1). The form's resolveExtractTwin sees non-done/empty and uses its own legacy prefill.
function runExtractPath(key: string, raw: unknown, put: Put): void {
  let system: string, user: string, evidenceIds: Set<string>;
  try {
    const bundle = bundleFromResponse(raw as RichResponse);
    const r = raw as { derived_anchors?: Record<string, unknown>; source_registry?: Record<string, Record<string, unknown>>; source_priority?: Record<string, unknown> };
    const p = buildExtractPrompt(bundle, r.derived_anchors || null, { source_registry: r.source_registry || null, source_priority: r.source_priority || null });
    system = p.system; user = p.user; evidenceIds = p.evidenceIds;
  } catch { put(empty(key, 'error')); return; }
  put(empty(key, 'loading'));
  const t0 = performance.now();
  extractBuyerProfileLLM(system, user)
    .then(async ({ out }) => {
      let finals = extractedToFinals(out, evidenceIds);
      if (!out || !finals.length) { put(empty(key, 'error')); return; } // honest miss — NO arithmetic fabrication
      const pp = buildPrunePrompt(finals); const keep = await pruneTwinLLM(pp.system, pp.user).catch(() => null); finals = applyPrune(finals, keep);
      put({ glid: key, status: 'done', finals, evalSummary: synthEval(finals), ms: Math.round(performance.now() - t0), ts: Date.now() });
    })
    .catch(() => put(empty(key, 'error')));
}

// Fire the eager extract for this GLID. Non-blocking, idempotent, cached. Safe to call on every pull.
// UPGRADE-ON-WEB (P1b): normally one call per GLID (retry only on error). EXCEPTION — when a web-bearing pull follows a
// twin that was built WITHOUT web, rebuild ONCE so web_osint reaches the extract LLM. The upgrade keeps the existing
// good twin visible (swallows loading/error) and only commits if the web-aware rebuild actually succeeds.
export function ensureMergedTwin(glid: string, raw: unknown): void {
  const key = String(glid || '').trim();
  if (!key || !raw) return;
  const webNow = hasWebContent(raw);
  const existing = cache.get(key);
  if (existing && existing.status !== 'error') {
    const canUpgrade = webNow && existing.status === 'done' && !builtWithWeb.has(key) && !upgradedOnce.has(key);
    if (!canUpgrade) return; // already done/loading with equal-or-better web coverage — true no-op
    upgradedOnce.add(key);   // rebuild ONCE (never loop)
  }
  const isUpgrade = !!(existing && existing.status === 'done');
  const token = (runToken.get(key) || 0) + 1; runToken.set(key, token);
  const put: Put = (e) => {
    if (runToken.get(key) !== token) return;              // a newer run superseded this one — drop the stale completion
    if (isUpgrade && e.status !== 'done') return;         // during an upgrade keep the existing good twin unless the rebuild succeeds
    cache.set(key, e);
    if (webNow && e.status === 'done') builtWithWeb.add(key);
    try { (window as unknown as { __mergedTwin?: MergedTwinEntry }).__mergedTwin = e; } catch { /* noop */ }
  };

  if (!hasGeminiKey()) { put(empty(key, 'no-key')); return; }      // no LLM → honest no-key (no arithmetic)
  if (!isRichShape(raw)) { put(empty(key, 'error')); return; }     // legacy non-rich shape → no extract possible (no arithmetic)
  runExtractPath(key, raw, put);                                   // the ONE path
}
