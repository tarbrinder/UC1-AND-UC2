// ── INFERENCE ENGINE (HOD 2026-07-13: P-9 "infer, don't populate" · P-10 "cook 4 signals together" · P-12) ──
// The HOD's headline ask: every card must answer "what NEW insight did AI provide?", not "what DB fields exist?".
// This module COOKS composite intelligence from ≥2 signal families each — Procurement Maturity, Buying Readiness,
// Expansion Indicator, Trust Score, Business Stability, Growth Potential — plus a buyer trajectory narrative.
// GROUNDED + GATED (owner discipline): every score cites the signals it was cooked from, and a score is OMITTED
// entirely when it has no supporting signal (never a fabricated default). Deterministic — no extra LLM call.
import type { BuyerProfileModel, LabeledField } from './buyerProfileModel';
import type { EnrichmentSignals } from './enrichmentSignals';

export type Band = 'Low' | 'Medium' | 'High';
export interface CompositeScore { key: string; label: string; band: Band; verdict: string; cookedFrom: string[] }
export interface Inference {
  scores: CompositeScore[];
  trajectory: { text: string; cookedFrom: string[] } | null;
}

const lf = (rows: LabeledField[], label: string): string => { const r = (rows || []).find((x) => x.label === label && x.field?.present); return r ? String(r.field.value || '') : ''; };
const has = (s: string) => !!s && s.trim().length > 0;

export function runInference(m: BuyerProfileModel, signals: EnrichmentSignals): Inference {
  const scores: CompositeScore[] = [];
  if (!m.available) return { scores, trajectory: null };

  const maturity = lf(m.buyerDetails, 'Business Stage') || lf(m.buyerDetails, 'Buyer Maturity');
  const intent = lf(m.buyerDetails, 'Buyer Intent');
  const readiness = lf(m.buyerDetails, 'Deal Readiness') || intent;
  const scale = lf(m.overview, 'Business Scale');
  const turnover = lf(m.overview, 'Annual Turnover');
  const reqTotal = m.requirementActivity?.total || 0;
  const tenure = m.header?.tenureYears ?? null;
  const registered = !!(m.company?.gst?.present || m.company?.udyam?.present);
  const products = (m.products || []).filter(Boolean);
  const va = signals.genuineness.verifiedAnchors;

  const add = (key: string, label: string, band: Band, verdict: string, cookedFrom: string[]) => { if (cookedFrom.length) scores.push({ key, label, band, verdict, cookedFrom }); };

  // 1 · TRUST SCORE — how confident are we the buyer is genuine (identity anchors + platform tier). Always groundable.
  add('trust', 'Trust', va >= 4 ? 'High' : va >= 2 ? 'Medium' : 'Low',
    va >= 4 ? 'Strongly verified across independent registries' : va >= 2 ? 'Partially verified — some anchors confirmed' : 'Thinly verified — few hard anchors',
    [`${va} identity anchors verified`, m.verifiedBuyer?.label].filter(Boolean) as string[]);

  // 2 · PROCUREMENT MATURITY — new-venture vs seasoned buyer (maturity signal + order history + registration).
  {
    const cooked: string[] = [];
    if (has(maturity)) cooked.push(`maturity: ${maturity}`);
    if (reqTotal) cooked.push(`${reqTotal} requirements on record`);
    if (registered) cooked.push('registered business (GST/Udyam)');
    const early = /early|new|setting up|aspir|recently/i.test(maturity);
    const band: Band = early ? 'Low' : (reqTotal >= 3 || registered) ? 'High' : has(maturity) ? 'Medium' : 'Medium';
    add('proc_maturity', 'Procurement Maturity', band,
      early ? 'Early-stage buyer — still establishing procurement patterns' : band === 'High' ? 'Seasoned buyer with an established procurement footprint' : 'Developing procurement maturity', cooked);
  }

  // 3 · BUYING READINESS — how close to a purchase (deal readiness / intent + recent requirement recency).
  {
    const cooked: string[] = [];
    if (has(readiness)) cooked.push(`readiness: ${readiness}`);
    const recentMonths = (m.requirementActivity?.months || []).filter((b) => (b.count || 0) > 0).length;
    if (recentMonths) cooked.push(`active in ${recentMonths} of the last 6 months`);
    const hot = /hot|ready|urgent|immediate/i.test(readiness);
    const warm = /warm|comparing|evaluat|considering/i.test(readiness);
    const band: Band = hot ? 'High' : warm ? 'Medium' : recentMonths >= 2 ? 'Medium' : has(readiness) ? 'Low' : 'Low';
    add('buying_readiness', 'Buying Readiness', band,
      hot ? 'Hot — actively buying now' : warm ? 'Warm — comparing and evaluating' : band === 'Medium' ? 'Moderately active — recent requirements' : 'Cool — no strong recent buying signal', cooked);
  }

  // 4 · BUSINESS STABILITY — how solid the business is (tenure + registration vintage + repeat requirements).
  {
    const cooked: string[] = [];
    if (tenure != null) cooked.push(`${tenure} year${tenure === 1 ? '' : 's'} on the platform`);
    if (registered) cooked.push('GST/Udyam registered');
    if (reqTotal >= 3) cooked.push('repeat requirement history');
    const strong = (tenure != null && tenure >= 2 && registered) || (registered && reqTotal >= 5);
    const band: Band = strong ? 'High' : (registered || (tenure != null && tenure >= 1)) ? 'Medium' : 'Low';
    if (cooked.length) add('stability', 'Business Stability', band,
      strong ? 'Established and stable — multi-year, registered, repeat activity' : band === 'Medium' ? 'Moderately established' : 'Early / limited track record', cooked);
  }

  // 5 · GROWTH POTENTIAL — breadth + scale + recent momentum (category breadth + scale/turnover + recency).
  {
    const cooked: string[] = [];
    const cats = new Set(products.map((p) => p.toLowerCase())).size;
    if (cats) cooked.push(`${cats} product line${cats === 1 ? '' : 's'} of interest`);
    if (has(scale)) cooked.push(`scale: ${scale}`);
    if (has(turnover)) cooked.push(`turnover: ${turnover}`);
    const recent = (m.requirementActivity?.months || []).slice(-2).some((b) => (b.count || 0) > 0);
    if (recent) cooked.push('active in the last 2 months');
    const band: Band = (cats >= 3 && recent) ? 'High' : (cats >= 2 || recent) ? 'Medium' : 'Low';
    if (cooked.length) add('growth', 'Growth Potential', band,
      band === 'High' ? 'Broadening demand across multiple lines with recent momentum' : band === 'Medium' ? 'Some breadth / recent activity' : 'Narrow, low current momentum', cooked);
  }

  // 6 · EXPANSION INDICATOR — is the buyer branching into NEW areas? (product-line breadth as the trajectory signal).
  {
    const cats = [...new Set(products.map((p) => p.trim()).filter(Boolean))];
    if (cats.length >= 2) add('expansion', 'Expansion Indicator', 'High',
      `Sourcing across ${cats.length} distinct product lines — likely diversifying/expanding`, [`product lines: ${cats.slice(0, 4).join(', ')}`]);
    else if (cats.length === 1) add('expansion', 'Expansion Indicator', 'Low',
      'Focused on a single product line', [`product line: ${cats[0]}`]);
  }

  // TRAJECTORY narrative (P-9 "shifted from X to Y") — grounded in the product lines + latest requirement; omit if thin.
  let trajectory: Inference['trajectory'] = null;
  {
    const cats = [...new Set(products.map((p) => p.trim()).filter(Boolean))];
    const latest = m.latestRequirement?.title ? String(m.latestRequirement.title) : '';
    const cooked: string[] = [];
    if (cats.length) cooked.push(`product lines: ${cats.slice(0, 5).join(', ')}`);
    if (latest) cooked.push(`latest requirement: ${latest}`);
    if (cats.length >= 2) {
      trajectory = { text: `Buyer is active across ${cats.length} product areas (${cats.slice(0, 3).join(', ')}${cats.length > 3 ? '…' : ''})${latest ? `, most recently sourcing "${latest}"` : ''} — a diversifying procurement pattern, not a single-product buyer.`, cookedFrom: cooked };
    } else if (cats.length === 1 && latest) {
      trajectory = { text: `Consistent buyer of ${cats[0]}, most recently "${latest}" — a focused, repeat procurement pattern.`, cookedFrom: cooked };
    }
  }

  return { scores, trajectory };
}
