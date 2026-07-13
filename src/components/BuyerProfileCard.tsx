// ─── TrustSEAL Buyer Profile — CARD (presentational, owner §1 reference layout) ──────────────────────────────
// Reads ONLY the normalized BuyerProfileModel (never raw JSON paths) so a schema tweak touches parseBuyerProfile,
// not this file. Every value is a Field carrying provenance → the card renders the right marker (inferred badge for
// web_osint/LLM synthesis, "derived" for encoded rules, ✓✓ for cross-source agreement) and an explicit muted
// "Not available" state when a field has no source. NO fabricated data reaches the screen.
// Icons are lucide-react SVGs (v1.17.0 has no brand icons → the 4 socials use tiny inline brand glyphs).
import { useMemo } from 'react';
import { User, Building2, Calendar, MapPin, Factory, Globe, Star, IndianRupee, CreditCard, CircleDot, ShieldCheck, ExternalLink, Mail, Users, Fingerprint, FileText, type LucideIcon } from 'lucide-react';
import { parseBuyerProfile, bucketPlatforms, type BuyerProfileModel, type Field, type LabeledField, type IdentitySignals, type PanBlock, type MobileRow } from '../lib/buyerProfileModel';
import { deriveEnrichmentSignals } from '../lib/enrichmentSignals';
import { runInference } from '../lib/inferenceEngine';

// ── provenance markers ───────────────────────────────────────────────────────────────────────────────────────
function Marker({ f }: { f: Field }) {
  if (!f.present) return null;
  // owner: GLADMIN card shows VALUES ONLY — the inferred/derived/composed provenance chips are removed (they belong in
  // the BuyLead debug view). The ONLY marker kept is ✓✓ = agreed by ≥2 sources (a trust signal a buyer-facing reader wants).
  if (f.provenance === 'triangulated') return <span title={f.note || 'Confirmed by 2 independent sources'} className="ml-1 text-[9px] text-emerald-600 cursor-help" aria-label="verified by two sources">✓✓</span>;
  return null;
}

// value or the explicit muted empty-state — NEVER a fake-looking placeholder
function Val({ f, link }: { f: Field; link?: boolean }) {
  // Amit (demo): never a silent blank — every "Not available" carries WHY (hover), so nothing looks unexplained.
  if (!f.present || f.value == null) return <span title={f.source && f.source !== '—' ? `Not available — could not enrich: ${f.source}` : 'Not available — no source for this field in the pipeline yet'} className="text-gray-300 italic cursor-help decoration-dotted underline-offset-2 underline">Not available</span>;
  // link-ify only a real URL/domain — a presence-only value like "Present" (Sign3 social) must render as plain text,
  // never href="https://Present".
  const looksUrl = link && /^https?:\/\/|^[\w-]+(\.[\w-]+)+/.test(f.value);
  const body = looksUrl
    ? <a href={/^https?:\/\//.test(f.value) ? f.value : `https://${f.value}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline break-all">{f.value}</a>
    : <span className="text-gray-800">{f.value}</span>;
  return <span className="break-words">{body}<Marker f={f} /></span>;
}

// ── icons — lucide line-icons; the 4 social brands are tiny inline SVGs (lucide v1.17.0 dropped brand marks) ────
const Icon = ({ Ic }: { Ic: LucideIcon }) => <Ic className="w-3.5 h-3.5 shrink-0 text-gray-400" strokeWidth={2} />;
type BrandIcon = (p: { className?: string }) => React.ReactElement;
const FacebookI: BrandIcon = ({ className }) => <svg viewBox="0 0 24 24" fill="currentColor" className={className}><path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.9h2.54V9.85c0-2.51 1.49-3.9 3.78-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.87h2.78l-.44 2.9h-2.34V22c4.78-.79 8.44-4.94 8.44-9.94Z"/></svg>;
const InstagramI: BrandIcon = ({ className }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>;
const LinkedinI: BrandIcon = ({ className }) => <svg viewBox="0 0 24 24" fill="currentColor" className={className}><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.66H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.8 0 0 .78 0 1.75v20.5C0 23.22.8 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.75V1.75C24 .78 23.2 0 22.22 0Z"/></svg>;
const TwitterI: BrandIcon = ({ className }) => <svg viewBox="0 0 24 24" fill="currentColor" className={className}><path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.63 7.58H.48l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93Zm-1.29 19.5h2.04L6.48 3.24H4.29L17.61 20.65Z"/></svg>;
const SocialKV = ({ Brand, label, f }: { Brand: BrandIcon; label: string; f: Field }) => (
  <div className="flex items-start gap-2 py-1">
    <Brand className="w-3.5 h-3.5 shrink-0 text-gray-400" />
    <span className="w-40 shrink-0 text-[12px] font-semibold text-gray-700">{label}</span>
    <span className="flex-1 min-w-0 text-[12px]"><Val f={f} link /></span>
  </div>
);

function KV({ Ic, label, f, link }: { Ic: LucideIcon; label: string; f: Field; link?: boolean }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <Icon Ic={Ic} />
      <span className="w-40 shrink-0 text-[12px] font-semibold text-gray-700">{label}</span>
      <span className="flex-1 min-w-0 text-[12px]"><Val f={f} link={link} /></span>
    </div>
  );
}

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[11px] font-bold tracking-wide text-blue-700 uppercase mt-3 mb-1">{children}</div>
);
const ColTitle = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[13px] font-bold text-gray-800 uppercase tracking-wide border-b-2 border-gray-200 pb-1.5 mb-2">{children}</div>
);

// ── a labeled section that HIDES empty rows (owner: "hide empty rows completely") — and hides its own title when the
// whole section is empty. `extra` (e.g. a deterministic Business-Nature row) renders after the inferred rows. ────────
function Section({ title, rows, extra }: { title: string; rows: LabeledField[]; extra?: React.ReactNode }) {
  const present = rows.filter((o) => o.field.present);
  if (!present.length && !extra) return null;
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      {present.map((o) => <KV key={o.label} Ic={CircleDot} label={o.label} f={o.field} />)}
      {extra}
    </>
  );
}

// ── Digital Footprint — SEGMENTED chips from the deterministic signals we hold (owner: "segment it"). Government =
// GST/Udyam/EPFO present · B2B marketplace = IndiaMART storefront · Consumer = Sign3 phone-linked consumer platforms.
// Only non-empty buckets render. (Business-presence socials are rendered as rows above.) ───────────────────────────
function FootprintChips({ m }: { m: BuyerProfileModel }) {
  const gov = [m.company.gst.present && 'GST', m.company.udyam.present && 'Udyam', m.epfo?.present && 'EPFO'].filter(Boolean) as string[];
  // audit BPC-84: shared bucket map → the card + BuyLead surface the same set from identical social_platforms data.
  const pb = bucketPlatforms(m.socialPlatforms);
  const consumer = pb.consumer;
  const b2b = [m.catalogueLink.present && 'IndiaMART', ...pb.b2b].filter(Boolean) as string[];
  if (!gov.length && !consumer.length && !b2b.length) return null;
  const chip = (label: string, tone: string) => <span key={label} className={`text-[9px] px-1.5 py-px rounded border ${tone}`}>{label}</span>;
  const Row = ({ label, items, tone }: { label: string; items: string[]; tone: string }) => items.length ? (
    <div className="flex flex-wrap gap-1 items-center"><span className="text-[9px] text-gray-400 w-24 shrink-0">{label}</span>{items.map((x) => chip(x, tone))}</div>
  ) : null;
  return (
    <div className="mt-1.5 space-y-1 border-t border-gray-100 pt-1.5">
      <Row label="B2B marketplace" items={b2b} tone="bg-teal-50 text-teal-700 border-teal-200" />
      <Row label="Government" items={gov} tone="bg-emerald-50 text-emerald-700 border-emerald-200" />
      <Row label="Consumer" items={consumer} tone="bg-amber-50 text-amber-700 border-amber-200" />
    </div>
  );
}

// ── header stat tile — now on WHITE (dark-on-light), moved out of the navy band (owner §2/§7) ───────────────────
function StatTile({ label, value, note, tone }: { label: string; value: number | null; note: string; tone: string }) {
  return (
    <div className="flex-1 px-3 py-2 text-center" title={note}>
      <div className={`mx-auto mb-1 w-7 h-7 rounded-full flex items-center justify-center ${tone}`}>
        <span className="w-2 h-2 rounded-full bg-white" />
      </div>
      <div className="text-xl font-bold text-gray-900 leading-none tabular-nums">{value == null ? '—' : value}</div>
      <div className="text-[10px] text-gray-500 mt-0.5 leading-tight">{label}</div>
    </div>
  );
}

// ── requirement-activity chart (div bars — no charting dep; sparse months stay at 0, never faked) ───────────────
function ActivityChart({ months, note }: { months: { month: string; count: number }[]; note: string }) {
  if (!months.length) return <div className="text-[11px] text-gray-400 italic py-4 text-center">No dated requirements to chart.</div>;
  const max = Math.max(1, ...months.map((m) => m.count));
  return (
    <div>
      <div className="flex items-end gap-3 h-28 px-1 pt-2 border-b border-gray-200">
        {months.map((m) => (
          <div key={m.month} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0">
            <span className="text-[10px] font-semibold text-emerald-700 tabular-nums">{m.count}</span>
            <div className="w-full max-w-[28px] rounded-t bg-emerald-500" style={{ height: `${Math.round((m.count / max) * 88)}px` }} title={`${m.count} BuyLead${m.count === 1 ? '' : 's'} in ${m.month}`} />
          </div>
        ))}
      </div>
      <div className="flex gap-3 px-1 mt-1">
        {months.map((m) => <div key={m.month} className="flex-1 text-center text-[9px] text-gray-500 min-w-0 truncate">{m.month}</div>)}
      </div>
      <div className="text-[9px] text-gray-400 mt-1.5 flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-emerald-500" /> BuyLeads · {note}</div>
    </div>
  );
}

// ── Identity Signals — structured two-name reconciliation (owner 2026-07-12: no paragraphs on the card).
// Two aligned name rows + a computed match verdict ("likely same person ✓" when one name contains the other's
// tokens, else the family/account-holder caution) + the verified-mobile chips. ─────────────────────────────────
function IdentityPanel({ sig, mobiles }: { sig: IdentitySignals | null; mobiles: MobileRow[] }) {
  if (!sig && !mobiles.length) return null;
  const toks = (s?: string) => (s || '').toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
  const a = toks(sig?.registered?.name), b = toks(sig?.bankLinked?.name);
  // audit BPC-143: SYMMETRIC token-subset (either direction) — one verdict drives BOTH the chip and the container, so a
  // green "same person" chip can never sit inside an amber conflict box (and vice-versa).
  const samePerson = a.length > 0 && b.length > 0 && (a.every((t) => b.includes(t)) || b.every((t) => a.includes(t)));
  const verdict = (sig?.registered && sig?.bankLinked)
    ? (samePerson
      ? { text: 'likely the same person ✓', cls: 'bg-emerald-50 text-emerald-700 border-emerald-300', warn: false }
      : { text: '⚠ verify — phone may belong to a family member / account-holder', cls: 'bg-amber-50 text-amber-800 border-amber-300', warn: true })
    : null;
  // container is amber only when the verdict warns (or, absent a verdict, when the model flagged a conflict).
  const amber = verdict ? verdict.warn : !!sig?.conflict;
  return (
    <div className={`mt-2 rounded-lg border p-2 ${amber ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200 bg-gray-50/60'}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1 flex items-center gap-1.5 flex-wrap">
        Identity
      </div>
      <div className="space-y-0.5">
        {sig?.registered && (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="w-32 shrink-0 text-gray-400">Business contact</span>
            <b className="text-gray-800">{sig.registered.name}</b>
          </div>
        )}
        {sig?.bankLinked && (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="w-32 shrink-0 text-gray-400">Phone-linked bank</span>
            <b className="text-gray-800">{sig.bankLinked.name}</b>
          </div>
        )}
        {mobiles.map((m) => (
          <div key={m.value} className="flex items-center gap-2 text-[11px]">
            <span className="w-32 shrink-0 text-gray-400">📱 Mobile{m.primary ? ' (primary)' : ''}</span>
            <span className="font-mono text-[11px] text-gray-800">{m.value}</span>
            {m.agreementCount >= 2 && <span title="Confirmed by 2+ independent sources" className="text-[9px] text-emerald-600 cursor-help">✓✓</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Conflict B — PAN block ───────────────────────────────────────────────────────────────────────────────────
function PanPanel({ pans }: { pans: PanBlock | null }) {
  if (!pans || (!pans.primary && !pans.alternates.length)) return null;
  return (
    <div className="mt-2 flex items-start gap-2 py-1">
      <Icon Ic={CreditCard} />
      <span className="w-40 shrink-0 text-[12px] font-semibold text-gray-700">PAN</span>
      <div className="flex-1 min-w-0 text-[12px]">
        {pans.primary && (
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-gray-800">{pans.primary.value}</span>
            {(pans.primary.agreementCount ?? 0) >= 2 && <span title="Confirmed by 2+ independent sources" className="text-[9px] text-emerald-600 cursor-help">✓✓</span>}
          </div>
        )}
        {pans.alternates.map((a) => (
          <div key={a.value} className="text-[10.5px] text-gray-500 mt-0.5"><span className="text-gray-400">also observed:</span> <span className="font-mono">{a.value}</span> <span className="text-[9px]">({a.source})</span></div>
        ))}
        {pans.note && <div className="text-[9.5px] text-amber-700/80 mt-0.5">{pans.note}</div>}
      </div>
    </div>
  );
}

// ── Proofs / Sources (#11) — the web citations behind the inferred fields (URL + excerpt + engine confidence) ────

// ── main card ────────────────────────────────────────────────────────────────────────────────────────────────
export default function BuyerProfileCard({ rich, glid, pending, persona }: { rich: unknown; glid: string; pending?: boolean; persona?: string }) {
  const m: BuyerProfileModel = useMemo(() => parseBuyerProfile(rich), [rich]);
  // HOD P-6/P-7/P-8 (2026-07-13): Identity Signals ("how genuine is this buyer?") + What We Enriched ("what NEW value
  // did WE add?") + multi-source validation — derived deterministically from the model, no fabrication.
  const signals = useMemo(() => deriveEnrichmentSignals(m), [m]);
  // HOD P-9/P-10: cook composite intelligence (Trust · Maturity · Readiness · Stability · Growth · Expansion) + trajectory.
  const inference = useMemo(() => runInference(m, signals), [m, signals]);
  if (!m.available) {
    return <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-[12px] text-gray-400">TrustSEAL Buyer Profile — pull a GLID to populate.</div>;
  }
  const tileTones = ['bg-blue-500', 'bg-emerald-500', 'bg-violet-500'];
  const tenure = m.header.tenureYears;
  const enrichedAdded = signals.enriched.filter((e) => e.added);
  return (
    <>
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
      {pending && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-1.5 text-[11px] text-amber-800 flex items-center gap-2">
          <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin shrink-0" />
          <span>Fast profile ready — <b>Web OSINT + Udyam still enriching</b> in the background. Those fields fill in shortly; the requirement-enrichment can be explored now (it doesn't need web data).</span>
        </div>
      )}
      {/* header — left navy badge block (not full-bleed) + activity tiles on white (owner §2/§7) */}
      <div className="px-4 pt-4 pb-1 flex flex-col sm:flex-row items-stretch gap-3">
        <div className="bg-gradient-to-br from-[#0b1f4d] to-[#132c63] rounded-xl px-4 py-3 flex items-center gap-2.5 sm:w-[38%] shrink-0">
          <span className="w-8 h-8 rounded-full bg-amber-400 text-[#0b1f4d] text-[12px] font-black flex items-center justify-center shrink-0">🪪</span>
          <div className="leading-tight min-w-0">
            <div className="text-white font-bold text-[14px] tracking-wide truncate">GLADMIN <span className="text-amber-400">Buyer Profile</span></div>
            {/* verification wording is flag-DRIVEN (never a static "TrustSEAL"): shows the buyer's real tier or "Unverified". */}
            <div className="text-white/60 text-[10px]">{m.verifiedBuyer ? m.verifiedBuyer.label : 'Buyer intelligence'}</div>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Overall Activity <span className="normal-case text-gray-300">· lifetime totals</span></div>
          <div className="flex items-stretch divide-x divide-gray-100 rounded-lg border border-gray-100 bg-gray-50/60">
            {m.header.tiles.map((t, i) => <StatTile key={t.label} label={t.label} value={t.value} note={t.sourceNote} tone={tileTones[i] || 'bg-gray-400'} />)}
          </div>
        </div>
      </div>

      {/* business name row */}
      <div className="px-4 pt-2 pb-2 border-b border-gray-100">
        <div className="flex items-center flex-wrap gap-2">
          <h2 className="text-2xl font-bold text-gray-900 leading-tight">{m.header.company.present ? m.header.company.value : <span className="text-gray-300 italic text-xl">Company not available</span>}<Marker f={m.header.company} /></h2>
          {m.verifiedBuyer && m.verifiedBuyer.tier !== 'unverified' && (
            <span
              title={`IndiaMART verified-business-buyer flag = ${m.verifiedBuyer.flag} · TrustSEAL Buyer (flag 6–9) · Verified Business Buyer (flag 4–5) · Verified Buyer (mobile + email verified)`}
              className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full border ${m.verifiedBuyer.tier === 'fraud' ? 'bg-rose-100 text-rose-700 border-rose-400' : m.verifiedBuyer.tier === 'trustseal' ? 'bg-amber-50 text-amber-700 border-amber-300' : m.verifiedBuyer.tier === 'gst_verified' ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : m.verifiedBuyer.tier === 'verified' ? 'bg-sky-50 text-sky-700 border-sky-300' : 'bg-gray-100 text-gray-600 border-gray-300'}`}>
              {m.verifiedBuyer.tier === 'trustseal' ? '🛡 ' : (m.verifiedBuyer.tier === 'gst_verified' || m.verifiedBuyer.tier === 'verified') ? '✓ ' : ''}{m.verifiedBuyer.label}
            </span>
          )}
        </div>
        {/* Amit (demo): "kis cheez ka dhandha hai" — the ONE plain-language line, front & centre. Prefer the extract-LLM
            business_persona (richest phrasing) when the debug view passes it; else the deterministic headline. */}
        {(() => { const pc = (persona && persona.trim() && !/^(unknown|n\/?a|none|null|undefined|-+|not available)$/i.test(persona.trim())) ? persona.trim() : ''; const head = pc || m.headline; return head ? <p className="mt-1.5 text-[15px] font-bold text-indigo-900 leading-snug bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2">{head}</p> : null; })()}
        {/* meta line — contact · member-since · GLID · location, directly under the persona (owner 2026-07-13: group the
            "who + how long + where" identity line with the name/persona at the very top). */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[12px] text-gray-600">
          <span className="inline-flex items-center gap-1"><Icon Ic={User} />{m.header.contactName.present ? m.header.contactName.value : <span className="text-gray-300 italic">—</span>}</span>
          <span className="text-gray-300">|</span>
          <span className="inline-flex items-center gap-1"><Icon Ic={Calendar} />Member Since: <b className="text-gray-700">{tenure != null ? `${tenure} Year${tenure === 1 ? '' : 's'}` : (m.header.memberSince.present ? m.header.memberSince.value : '—')}</b></span>
          <span className="text-gray-300">|</span>
          <span className="inline-flex items-center gap-1">GLID: <span className="text-blue-600 font-semibold">{glid || m.glid}</span></span>
          {m.header.registeredLocation.present && <><span className="text-gray-300">|</span><span className="inline-flex items-center gap-1" title="Registered operating location (glusr) — the buyer's original city; sourcing cities are listed separately on the requirement"><Icon Ic={MapPin} />{m.header.registeredLocation.value}</span></>}
        </div>
        {/* HOD P-9/P-10/P-12 · SMART INSIGHTS — the top-line "so what?" read, grouped with the name/persona/meta above
            (owner 2026-07-13). Each score is a composite of ≥2 signal families with its evidence in the tooltip; a
            trajectory narrative sits on top. This is the "what NEW insight did AI add?" layer. */}
        {m.available && (inference.scores.length > 0 || inference.trajectory) && (
          <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50/40 px-3 py-2">
            <div className="text-[11px] font-bold uppercase tracking-wide text-indigo-700 flex items-center gap-1 mb-1"><Icon Ic={CircleDot} />Smart Insights</div>
            {inference.trajectory && <p className="text-[11.5px] text-gray-700 leading-snug mb-1.5" title={inference.trajectory.cookedFrom.join(' · ')}>{inference.trajectory.text}</p>}
            <div className="flex flex-wrap gap-1.5">
              {inference.scores.map((s) => (
                <span key={s.key} title={`${s.verdict} — cooked from: ${s.cookedFrom.join(' · ')}`} className={`text-[10.5px] px-2 py-0.5 rounded border ${s.band === 'High' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : s.band === 'Medium' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>{s.label}: <b>{s.band}</b></span>
              ))}
            </div>
          </div>
        )}
        {/* HOD P-6 · IDENTITY SIGNALS — "how genuine is this buyer?" A verification grid + a count-grounded read (no
            fabricated score). Kept ON the card (owner 2026-07-13), directly below the top insight block. */}
        {m.available && (
          <div className="mt-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-600 flex items-center gap-1"><Icon Ic={ShieldCheck} />Identity Signals</span>
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${signals.genuineness.verifiedAnchors >= 4 ? 'bg-emerald-50 text-emerald-700' : signals.genuineness.verifiedAnchors >= 2 ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500'}`} title={signals.genuineness.basis}>{signals.genuineness.label} · {signals.genuineness.verifiedAnchors}/{signals.identity.length}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {signals.identity.map((s) => (
                <span key={s.label} title={s.detail} className={`text-[10.5px] px-2 py-0.5 rounded border ${s.state === 'verified' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : s.state === 'present' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-50 text-gray-400 border-gray-200'}`}>{s.state === 'verified' ? '✓ ' : s.state === 'present' ? '• ' : '– '}{s.label}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 3-column body */}
      {/* fr tracks (not %) so the 3 columns distribute AFTER subtracting gap-x — %-tracks summed to 100% + the 40px
          gap overflowed ~40px and the card's overflow-hidden clipped Column 3's right edge (the "trimmed on right" bug). */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_4fr_3fr] gap-x-5 gap-y-3 p-4">
        {/* ── COLUMN 1 — BUYER DETAILS ── */}
        <div>
          <ColTitle>Buyer Details</ColTitle>
          {m.businessStory && (
            <div className="rounded-lg bg-blue-50/70 border border-blue-100 p-2.5 mb-2">
              <div className="text-[11px] font-bold text-blue-800 mb-0.5">Business Story</div>
              <p className="text-[12px] text-gray-700 leading-snug">{m.businessStory.text}</p>
            </div>
          )}
          {/* DEDUP (owner Layer-2, render-time so the model's index-wiring stays intact):
              · Buyer Snapshot: drop Business Objective (covered by persona/use-case) + Buyer Maturity (== Business Stage; keep Stage, prefer the richer maturity phrasing).
              · Procurement: drop Sourcing Channel (folds into Sourcing cities), Purchase Frequency + Procurement Challenge (→ requirement side on the BuyLead card), Price vs Quality (already covered); MERGE Procurement Approach into Procurement Model.
              · Market: drop Sales Geography (sourcing already covers geography). */}
          {(() => {
            // owner UI-3 / HOD P-2 (2026-07-13): the leftmost SUMMARY (headline + Business Story) must NOT be repeated
            // as key rows. Build the summary text once; drop any key row whose value the summary already states.
            // Conservative: matches only a near-verbatim restatement (normalized substring of the value's lead phrase),
            // so genuinely-new detail is kept.
            const _norm = (x: unknown) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
            const _summaryText = _norm(`${(persona && persona.trim()) || m.headline || ''} ${m.businessStory?.text || ''}`);
            const _saidInSummary = (val: unknown) => { const v = _norm(String(val).split('·')[0]); return v.length >= 4 && _summaryText.includes(v); };
            const dedupeVsSummary = <T extends { field: { present: boolean; value?: unknown } }>(rows: T[]): T[] => rows.filter((r) => !(r.field?.present && _saidInSummary(r.field.value)));
            // Buyer Snapshot: drop Objective + Maturity (Stage keeps the maturity value) + MERGE Intent+Readiness
            // (owner #8: one row — readiness temperature leads, intent stage follows).
            const snapDrop = new Set(['Business Objective', 'Buyer Maturity', 'Deal Readiness']);
            const maturity = m.buyerDetails.find((r) => r.label === 'Buyer Maturity');
            const readiness = m.buyerDetails.find((r) => r.label === 'Deal Readiness');
            const snapRows = m.buyerDetails.filter((r) => !snapDrop.has(r.label)).map((r) => {
              if (r.label === 'Business Stage' && maturity?.field.present) return { label: 'Business Stage', field: maturity.field };
              // TRUE MERGE (owner): ONE value — the descriptive intent stage wins; the readiness temperature is a
              // synonym (Hot ≈ Ready-to-buy), never concatenated alongside it.
              if (r.label === 'Buyer Intent' && r.field.present && readiness?.field.present) { const stage = String(r.field.value).split('·').map((s) => s.trim()).filter((s) => s && !/^(hot|warm|cold)\b/i.test(s)).join(' · '); return { label: 'Buyer Intent', field: { ...r.field, value: stage || String(readiness.field.value).trim() } }; }
              if (r.label === 'Buyer Intent' && !r.field.present && readiness?.field.present) return { label: 'Buyer Intent', field: readiness.field };
              return r;
            });
            // Business Overview: MERGE B2B/B2C ("Business Model") + Retail/Wholesale into ONE classification row (owner #7).
            const rw = m.overview.find((r) => r.label === 'Retail / Wholesale');
            const ovRows = m.overview.filter((r) => r.label !== 'Retail / Wholesale').map((r) => (r.label === 'Business Model' && r.field.present && rw?.field.present) ? { label: 'Business Model', field: { ...r.field, value: `${r.field.value} — ${String(rw.field.value).charAt(0).toLowerCase()}${String(rw.field.value).slice(1)}` } } : (r.label === 'Business Model' && !r.field.present && rw?.field.present) ? { label: 'Business Model', field: rw.field } : r);
            const procDrop = new Set(['Sourcing Channel', 'Purchase Frequency', 'Procurement Challenge', 'Price vs Quality', 'Procurement Approach']);
            const approach = m.procurement.find((r) => r.label === 'Procurement Approach');
            // TRUE MERGE: the approach (richer phrasing, e.g. "planned & recurring") IS the model statement — one value.
            const procRows = m.procurement.filter((r) => !procDrop.has(r.label)).map((r) => { if (r.label === 'Procurement Model' && approach?.field.present) return { label: 'Procurement Model', field: approach.field }; return r; });
            const mktRows = m.market.filter((r) => r.label !== 'Sales Geography');
            return (<>
              <Section title="Buyer Snapshot" rows={dedupeVsSummary(snapRows)} />
              <Section title="Business Overview" rows={dedupeVsSummary(ovRows)} extra={m.businessNature.present ? <KV Ic={Factory} label="Business Nature" f={m.businessNature} /> : null} />
              <Section title="Procurement Profile" rows={dedupeVsSummary(procRows)} />
              <Section title="Market Focus" rows={dedupeVsSummary(mktRows)} />
            </>);
          })()}
        </div>

        {/* ── COLUMN 2 — COMPANY DETAILS ── */}
        <div>
          <ColTitle>Company Details</ColTitle>
          <KV Ic={IndianRupee} label="GST" f={m.company.gst} />
          <div className="flex items-start gap-2 py-1">
            <Icon Ic={ShieldCheck} />
            <span className="w-40 shrink-0 text-[12px] font-semibold text-gray-700">GST Verification Status</span>
            <span className="flex-1 min-w-0 text-[12px]">
              {m.company.gstStatus.present
                ? (() => { const st = String(m.company.gstStatus.value).trim().toLowerCase(); const ok = /^(active|verified)\b/.test(st) && !/\b(in-?active|cancel|suspend|not\s+active|not\s+verified|deactivat)/.test(st); return <span className={ok ? 'text-emerald-600 font-semibold' : 'text-amber-600 font-semibold'}>{ok ? '✓ ' : '⚠ '}{m.company.gstStatus.value}</span>; })()
                : <span className="text-gray-300 italic">Not available</span>}
            </span>
          </div>
          <KV Ic={User} label="Trade Name / Company Name" f={m.company.tradeName} />
          <KV Ic={Building2} label="Constitution of Business" f={m.company.constitution} />
          <KV Ic={Calendar} label="Date of Registration" f={m.company.regDate} />
          <KV Ic={IndianRupee} label="Annual Turnover (GST-declared)" f={m.company.turnoverBand} />
          <KV Ic={MapPin} label="Principal Place of Business" f={m.company.principalAddress} />
          {m.company.principalAddress.alternates?.map((a) => (
            <div key={a.value} className="ml-6 text-[10px] text-gray-400">also seen as <span className="italic">({a.source})</span>: {a.value}</div>
          ))}

          <PanPanel pans={m.company.pans} />
          <IdentityPanel sig={m.company.identity} mobiles={m.company.mobiles} />

          {/* Udyam / MSME — the authoritative govt SIZE band + NIC industry. Renders "Not available" (muted) when the
              buyer has no MSME registration; a size chip + NIC line when present. */}
          <div className="mt-2">
            <div className="flex items-start gap-2 py-1">
              <Icon Ic={Factory} />
              <span className="w-40 shrink-0 text-[12px] font-semibold text-gray-700">Udyam / MSME</span>
              <span className="flex-1 min-w-0 text-[12px]">
                {m.company.udyam.present
                  ? <span className="break-words"><span className="font-mono text-gray-800">{m.company.udyam.regNo.value}</span>{m.company.udyam.enterpriseType.present && <span className="ml-1.5 text-[9px] px-1 rounded bg-amber-50 text-amber-700 border border-amber-200">{m.company.udyam.enterpriseType.value}</span>}<Marker f={m.company.udyam.regNo} /></span>
                  : <Val f={m.company.udyam.regNo} />}
              </span>
            </div>
            {m.company.udyam.present && m.company.udyam.enterpriseName.present && <div className="ml-6 text-[9.5px] text-gray-700 font-medium">{m.company.udyam.enterpriseName.value}</div>}
            {m.company.udyam.present && (m.company.udyam.majorActivity.present || m.company.udyam.organizationType.present) && (
              <div className="ml-6 text-[9.5px] text-gray-500 flex flex-wrap gap-x-2">{m.company.udyam.majorActivity.present && <span>{m.company.udyam.majorActivity.value}</span>}{m.company.udyam.organizationType.present && <span>· {m.company.udyam.organizationType.value}</span>}{m.company.udyam.incorporation.present && <span>· inc {m.company.udyam.incorporation.value}</span>}</div>
            )}
            {m.company.udyam.nicIndustries.length > 0 && <div className="ml-6 text-[9.5px] text-gray-500">NIC: {m.company.udyam.nicIndustries.slice(0, 3).join(' · ')}</div>}
          </div>

          {/* EPFO employer — deterministic size signal (IDfy) */}
          {m.epfo?.present && (
            <div className="flex items-start gap-2 py-1">
              <Icon Ic={Users} />
              <span className="w-40 shrink-0 text-[12px] font-semibold text-gray-700">EPFO Employer</span>
              <span className="flex-1 min-w-0 text-[12px] text-gray-700 break-words">{m.epfo.establishment.value}{m.epfo.employeeCount.present && <span className="ml-1.5 text-[9px] px-1 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">{m.epfo.employeeCount.value} employees</span>}</span>
            </div>
          )}

          {/* ★ Contact & PII — INTERNAL, full deterministic (owner: show everything, unmasked) */}
          <SectionTitle>Contact &amp; PII <span className="float-right normal-case text-[8px] text-amber-500 font-normal">internal</span></SectionTitle>
          <KV Ic={Mail} label="Email" f={m.contact.email} />
          {m.contact.altEmail.present && <KV Ic={Mail} label="Alt Email" f={m.contact.altEmail} />}
          <KV Ic={MapPin} label="Full Address" f={m.contact.fullAddress} />
          {(m.contact.city.present || m.contact.district.present || m.contact.state.present || m.contact.pincode.present) && (
            <div className="ml-6 text-[9.5px] text-gray-500 flex flex-wrap gap-x-2">{m.contact.city.present && <span>{m.contact.city.value}</span>}{m.contact.district.present && <span>· {m.contact.district.value}</span>}{m.contact.state.present && <span>· {m.contact.state.value}</span>}{m.contact.pincode.present && <span>· {m.contact.pincode.value}</span>}</div>
          )}
          {(m.contact.dob.present || m.contact.gender.present || m.contact.age.present || m.contact.incomeBand.present) && (
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5 ml-6 text-[11px] text-gray-600">
              {m.contact.dob.present && <span>DOB: <b className="text-gray-800">{m.contact.dob.value}</b></span>}
              {m.contact.age.present && <span>Age: <b className="text-gray-800">{m.contact.age.value}</b></span>}
              {m.contact.gender.present && <span>Gender: <b className="text-gray-800">{m.contact.gender.value}</b></span>}
              {m.contact.incomeBand.present && <span>Income: <b className="text-gray-800">₹{m.contact.incomeBand.value}</b></span>}
            </div>
          )}
          {m.aadhaar?.present && <KV Ic={Fingerprint} label="Aadhaar" f={m.aadhaar.value} />}
          {m.catalogueLink.present && <KV Ic={ExternalLink} label="IndiaMART Catalogue" f={m.catalogueLink} link />}

          {/* GST Registry Detail — full GST-advance, expandable (internal) */}
          {m.gstDetail && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] font-semibold text-gray-600 flex items-center gap-1.5 select-none"><Icon Ic={FileText} />GST Registry Detail <span className="text-[9px] font-normal text-gray-400">taxpayer · filing · signatories · SAC</span></summary>
              <div className="ml-6 mt-1 space-y-0.5 text-[10.5px] text-gray-600">
                {m.gstDetail.taxpayerType && <div>Taxpayer type: <b className="text-gray-800">{m.gstDetail.taxpayerType}</b></div>}
                {m.gstDetail.filing.latest && <div>Latest filing: {m.gstDetail.filing.latest}{m.gstDetail.filing.count ? ` · ${m.gstDetail.filing.count} returns` : ''}</div>}
                {m.gstDetail.filing.types.length > 0 && <div>Return types: {m.gstDetail.filing.types.join(', ')}</div>}
                {m.gstDetail.signatories.length > 0 && <div>Signatories: {m.gstDetail.signatories.join(', ')}</div>}
                {m.gstDetail.sac.length > 0 && <div className="break-words">SAC/HSN: {m.gstDetail.sac.slice(0, 6).map((s) => `${s.code}${s.desc ? ` ${s.desc}` : ''}`).join(' · ')}</div>}
                {(m.gstDetail.email || m.gstDetail.mobile) && <div>GST contact: {[m.gstDetail.email, m.gstDetail.mobile].filter(Boolean).join(' · ')}</div>}
                {(m.gstDetail.centralJurisdiction || m.gstDetail.stateJurisdiction) && <div>Jurisdiction: {[m.gstDetail.centralJurisdiction, m.gstDetail.stateJurisdiction].filter(Boolean).join(' | ')}</div>}
                {m.gstDetail.complianceRating && <div>Compliance rating: {m.gstDetail.complianceRating}</div>}
                {m.gstDetail.turnover && <div>Aggregate turnover: {m.gstDetail.turnover}</div>}
                {m.gstDetail.cancellationDate && <div className="text-rose-600">Registration cancelled: {m.gstDetail.cancellationDate}</div>}
                {m.gstDetail.eInvoice && <div>e-Invoice: {m.gstDetail.eInvoice}</div>}
              </div>
            </details>
          )}

          <SectionTitle>Requirement Activity <span className="normal-case text-gray-400 font-normal">· recent months</span> {m.requirementActivity.total != null && <span className="float-right normal-case text-gray-500 font-normal">Total (lifetime): {m.requirementActivity.total}</span>}</SectionTitle>
          <ActivityChart months={m.requirementActivity.months} note={m.requirementActivity.note} />
        </div>

        {/* ── COLUMN 3 — SOCIAL / PRODUCTS / PLAN ── */}
        <div>
          <ColTitle>Digital Footprint</ColTitle>
          {/* Business presence — hide-empty (only present socials render; saves ~80% space on sparse buyers) */}
          {m.social.website.present && <KV Ic={Globe} label="Website" f={m.social.website} link />}
          {m.social.facebook.present && <SocialKV Brand={FacebookI} label="Facebook" f={m.social.facebook} />}
          {m.social.instagram.present && <SocialKV Brand={InstagramI} label="Instagram" f={m.social.instagram} />}
          {m.social.linkedin.present && <SocialKV Brand={LinkedinI} label="LinkedIn" f={m.social.linkedin} />}
          {m.social.twitter.present && <SocialKV Brand={TwitterI} label="Twitter / X" f={m.social.twitter} />}
          {m.googleBusiness?.exists && m.googleBusiness.rating && (
            <KV Ic={Star} label={m.googleBusiness.kind === 'maps_contributor' ? 'Google Maps profile' : 'Google Business'} f={{ value: m.googleBusiness.rating, present: true, provenance: 'inferred', source: m.googleBusiness.kind === 'maps_contributor' ? 'Sign3 · Google-Maps contributor profile' : 'web_osint', inferred: true, note: m.googleBusiness.kind === 'maps_contributor' ? 'personal Google-Maps contributor profile (phone-linked) — its pin may sit in a different city than the registered address; not the firm\'s verified Google Business listing' : undefined }} />
          )}
          {/* segmented footprint buckets from deterministic signals (Government / B2B marketplace / Consumer) */}
          <FootprintChips m={m} />
          {/* audit P2: surface EVERY Sign3 phone-linked platform (not just the 4 CONSUMER + 4 social ones) so a buyer with
              only e.g. a Paytm/WhatsApp presence isn't a Digital-Footprint title over nothing, and the empty-state stays honest. */}
          {/* audit (workflow regression catch): exclude the B2B-bucket keys too — FootprintChips already renders them in
              the 'B2B marketplace' row via bucketPlatforms, so without this they double-render (chip + 'also linked'). */}
          {(() => { const shown = new Set(['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TWITTER', 'X', 'AMAZON', 'FLIPKART', 'SNAPDEAL', 'MYNTRA', 'TRADEINDIA', 'EXPORTERSINDIA', 'ALIBABA']); const other = m.socialPlatforms.filter((p) => !shown.has(p)); return other.length ? (<div className="flex flex-wrap gap-1 mt-1"><span className="text-[9px] text-gray-400 self-center">also linked:</span>{other.map((p) => <span key={p} className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-600 capitalize">{p.toLowerCase()}</span>)}</div>) : null; })()}
          {!m.social.website.present && !m.social.facebook.present && !m.social.instagram.present && !m.social.linkedin.present && !m.social.twitter.present && !(m.googleBusiness?.exists && m.googleBusiness.rating) && !m.company.gst.present && !m.company.udyam.present && !m.epfo?.present && !m.catalogueLink.present && !m.socialPlatforms.length && <div className="text-[11px] text-gray-300 italic">No web / social / registry footprint detected.</div>}


          <SectionTitle>Products of Interest</SectionTitle>
          {m.products.length ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              {m.products.map((p, i) => <div key={`${p}-${i}`} className="text-[11px] text-gray-700 flex items-start gap-1"><span className="text-gray-300">•</span><span className="break-words">{p}</span></div>)}
            </div>
          ) : <div className="text-[11px] text-gray-300 italic">Not available</div>}

          {/* Latest-requirement section REMOVED from the GLADMIN card (owner 2026-07-12) — the requirement lives on
              the BuyLead card; this card is the buyer, not the lead. */}

          {/* TrustSEAL Buyer Plan REMOVED (audit 2026-07-13, P1 + HOD no-fabrication): the card was rendering a fabricated
              "Plan Type: TrustSEAL Verified" for EVERY buyer, contradicting the model's plan:null contract. There is no
              plan data in the pipeline, so we show nothing rather than a sample value. Re-add only when a real plan feed exists. */}
        </div>
      </div>

      {/* Proofs/Sources REMOVED from the buyer-facing card (owner) — web citations live in the BuyLead card's debug view. */}
      <div className="px-4 pb-2 text-[9px] text-gray-400 border-t border-gray-100 pt-1.5">
        <span className="text-emerald-600">✓✓</span> = agreed by ≥2 sources · <span className="italic">Not available</span> = no source field (never fabricated)
      </div>
    </div>

      {/* HOD P-7/P-8 · WHAT WE ENRICHED — deliberately OUTSIDE the card (owner 2026-07-13): a collapsed, muted "receipt"
          of what NEW value WE generated this pull (not raw DB fields) + multi-source verification. Not part of the main
          card body; open it only to audit what enrichment ran. */}
      {m.available && (enrichedAdded.length > 0 || signals.multiSource.length > 0) && (
        <details className="mt-2 rounded-lg border border-dashed border-violet-200 bg-violet-50/30 px-3 py-2">
          <summary className="cursor-pointer list-none text-[11px] font-bold uppercase tracking-wide text-violet-600 flex items-center gap-1"><Icon Ic={Star} />What We Enriched <span className="text-[10px] font-normal text-violet-400">· {enrichedAdded.length} sources added intelligence · click to expand</span></summary>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
            {enrichedAdded.map((e) => (<div key={e.label} className="text-[10.5px] text-gray-700 flex items-baseline gap-1"><span className="text-emerald-600">✓</span><span className="font-medium">{e.label}</span><span className="text-gray-400 truncate" title={e.note}>— {e.note}</span></div>))}
          </div>
          {signals.multiSource.length > 0 && (
            <div className="mt-2 pt-1.5 border-t border-violet-200/60">
              <div className="text-[9px] uppercase tracking-wide text-violet-600 font-semibold mb-0.5">Multi-source verified</div>
              {signals.multiSource.map((f) => (<div key={f.fact} className="text-[10.5px] text-gray-700"><b>{f.fact}:</b> {f.value} <span className="text-emerald-700 font-semibold">✓✓ verified from {f.sources.length} independent sources</span> <span className="text-gray-400">({f.sources.join(' · ')})</span></div>))}
            </div>
          )}
        </details>
      )}
    </>
  );
}
