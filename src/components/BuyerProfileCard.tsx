// ─── TrustSEAL Buyer Profile — CARD (presentational, owner §1 reference layout) ──────────────────────────────
// Reads ONLY the normalized BuyerProfileModel (never raw JSON paths) so a schema tweak touches parseBuyerProfile,
// not this file. Every value is a Field carrying provenance → the card renders the right marker (inferred badge for
// web_osint/LLM synthesis, "derived" for encoded rules, ✓✓ for cross-source agreement) and an explicit muted
// "Not available" state when a field has no source. NO fabricated data reaches the screen.
// Icons are lucide-react SVGs (v1.17.0 has no brand icons → the 4 socials use tiny inline brand glyphs).
import { useMemo } from 'react';
import { User, Building2, Calendar, MapPin, Factory, Globe, Star, IndianRupee, CreditCard, CircleDot, ShoppingBag, ShieldCheck, ExternalLink, type LucideIcon } from 'lucide-react';
import { parseBuyerProfile, type BuyerProfileModel, type Field, type IdentitySignals, type PanBlock, type MobileRow } from '../lib/buyerProfileModel';

// ── provenance markers ───────────────────────────────────────────────────────────────────────────────────────
function Marker({ f }: { f: Field }) {
  if (!f.present) return null;
  if (f.inferred || f.provenance === 'inferred') {
    return <span title={`Derived from web sources (web_osint · LLM synthesis${f.confidence ? ` · confidence ${f.confidence}` : ''}) — not a registry record`} className="ml-1 inline-flex items-center align-middle text-[8px] px-1 py-px rounded bg-sky-50 text-sky-600 border border-sky-200 cursor-help">inferred</span>;
  }
  if (f.provenance === 'derived') return <span title={f.note || 'Encoded rule, not a fetched fact'} className="ml-1 text-[8px] px-1 py-px rounded bg-gray-100 text-gray-500 border border-gray-200 cursor-help">derived</span>;
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

// ── Conflict A — Identity Signals ────────────────────────────────────────────────────────────────────────────
function IdentityPanel({ sig, mobiles }: { sig: IdentitySignals | null; mobiles: MobileRow[] }) {
  if (!sig && !mobiles.length) return null;
  return (
    <div className={`mt-2 rounded-lg border p-2 ${sig?.conflict ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200 bg-gray-50/60'}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1 flex items-center gap-1">
        Identity Signals{sig?.conflict && <span className="text-[9px] font-semibold text-amber-700 normal-case">⚠ same mobile, two names — shown, not auto-resolved</span>}
      </div>
      {sig?.registered && <div className="text-[11px] text-gray-700"><span className="text-gray-400">Registered business contact:</span> <b>{sig.registered.name}</b> <span className="text-[9px] text-gray-400">({sig.registered.source})</span></div>}
      {sig?.bankLinked && <div className="text-[11px] text-gray-700"><span className="text-gray-400">Phone-linked bank identity:</span> <b>{sig.bankLinked.name}</b> <span className="text-[9px] text-gray-400">({sig.bankLinked.source}{sig.bankLinked.confidence ? ` · confidence ${sig.bankLinked.confidence}` : ''})</span></div>}
      {mobiles.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {mobiles.map((m) => (
            <span key={m.value} title={`found by: ${m.foundBy.join(', ') || 'unknown'}`} className={`text-[9.5px] font-mono px-1.5 py-px rounded border cursor-help ${m.agreementCount >= 2 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
              {m.value}{m.primary ? ' ·primary' : ''} {m.agreementCount >= 2 ? `✓✓ ${m.foundBy.join('+')}` : `single · ${m.foundBy.join('+') || '?'}`}
            </span>
          ))}
        </div>
      )}
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
            {(pans.primary.agreementCount ?? 0) >= 2
              ? <span title={`found by ${pans.primary.foundBy?.join(', ')}`} className="text-[9px] px-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 cursor-help">✓✓ {pans.primary.agreementCount} vendors</span>
              : <span className="text-[9px] px-1 rounded bg-amber-50 text-amber-700 border border-amber-200">single source</span>}
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
function ProofsSection({ proofs }: { proofs: BuyerProfileModel['proofs'] }) {
  if (!proofs.length) return null;
  return (
    <div className="px-4 pb-2">
      <details>
        <summary className="cursor-pointer list-none text-[11px] font-bold text-blue-700 uppercase tracking-wide flex items-center gap-1.5 select-none">
          <ShieldCheck className="w-3.5 h-3.5 text-blue-600" /> Proofs / Sources <span className="text-gray-400">({proofs.length})</span>
          <span className="text-[9px] font-normal text-gray-400 normal-case">— web citations behind the inferred fields</span>
        </summary>
        <div className="mt-1.5 space-y-1.5">
          {proofs.map((p, i) => (
            <div key={`${p.field}-${i}`} className="text-[10px] text-gray-600 border-l-2 border-blue-100 pl-2">
              <div className="flex items-center flex-wrap gap-1.5">
                <span className="font-semibold text-gray-700">{p.field.replace(/_/g, ' ')}</span>
                {p.confidence && <span className="text-[8px] px-1 rounded bg-gray-100 text-gray-500 border border-gray-200">web-conf {p.confidence}</span>}
                {p.url && <a href={/^https?:\/\//.test(p.url) ? p.url : `https://${p.url}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-0.5 truncate max-w-[260px]"><ExternalLink className="w-2.5 h-2.5 shrink-0" />{p.url.replace(/^https?:\/\//, '')}</a>}
              </div>
              {p.excerpt && <div className="text-gray-400 italic mt-0.5 line-clamp-2">“{p.excerpt}”</div>}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

// ── main card ────────────────────────────────────────────────────────────────────────────────────────────────
export default function BuyerProfileCard({ rich, glid, pending, persona }: { rich: unknown; glid: string; pending?: boolean; persona?: string }) {
  const m: BuyerProfileModel = useMemo(() => parseBuyerProfile(rich), [rich]);
  if (!m.available) {
    return <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-[12px] text-gray-400">TrustSEAL Buyer Profile — pull a GLID to populate.</div>;
  }
  const tileTones = ['bg-blue-500', 'bg-emerald-500', 'bg-violet-500'];
  const tenure = m.header.tenureYears;
  const lr = m.latestRequirement;
  return (
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
          <span className="w-8 h-8 rounded-full bg-amber-400 text-[#0b1f4d] text-[13px] font-black flex items-center justify-center shrink-0">S</span>
          <div className="leading-tight min-w-0">
            <div className="text-white font-bold text-[15px] tracking-wide truncate">TrustSEAL <span className="text-amber-400">Buyer Profile</span></div>
            <div className="text-white/60 text-[10px]">Verified buyer intelligence</div>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Overall Activity (Last 6 Months)</div>
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
              title={`IndiaMART verified-business-buyer flag = ${m.verifiedBuyer.flag} (6–9 = TrustSEAL buyer · 4/5 = GST-verified)`}
              className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full border ${m.verifiedBuyer.tier === 'trustseal' ? 'bg-amber-50 text-amber-700 border-amber-300' : m.verifiedBuyer.tier === 'gst_verified' ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-gray-100 text-gray-600 border-gray-300'}`}>
              {m.verifiedBuyer.tier === 'trustseal' ? '🛡 TrustSEAL Buyer' : m.verifiedBuyer.tier === 'gst_verified' ? '✓ GST-Verified Business' : m.verifiedBuyer.label}
            </span>
          )}
        </div>
        {/* Amit (demo): "kis cheez ka dhandha hai" — the ONE plain-language line, front & centre. Prefer the extract-LLM
            business_persona (richest phrasing) when the debug view passes it; else the deterministic headline. */}
        {((persona && persona.trim()) || m.headline) && <p className="mt-1 text-[15px] font-semibold text-indigo-900 leading-snug">{(persona && persona.trim()) || m.headline}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[12px] text-gray-600">
          <span className="inline-flex items-center gap-1"><Icon Ic={User} />{m.header.contactName.present ? m.header.contactName.value : <span className="text-gray-300 italic">—</span>}</span>
          <span className="text-gray-300">|</span>
          <span className="inline-flex items-center gap-1"><Icon Ic={Calendar} />Member Since: <b className="text-gray-700">{tenure != null ? `${tenure} Year${tenure === 1 ? '' : 's'}` : (m.header.memberSince.present ? m.header.memberSince.value : '—')}</b></span>
          <span className="text-gray-300">|</span>
          <span className="inline-flex items-center gap-1">GLID: <span className="text-blue-600 font-semibold">{glid || m.glid}</span></span>
          {m.header.registeredLocation.present && <><span className="text-gray-300">|</span><span className="inline-flex items-center gap-1" title="Registered operating location (glusr) — the buyer's original city; sourcing cities are listed separately on the requirement"><Icon Ic={MapPin} />{m.header.registeredLocation.value}</span></>}
        </div>
      </div>

      {/* 3-column body */}
      <div className="grid grid-cols-1 lg:grid-cols-[30%_40%_30%] gap-x-5 gap-y-3 p-4">
        {/* ── COLUMN 1 — BUYER DETAILS ── */}
        <div>
          <ColTitle>Buyer Details</ColTitle>
          {m.businessStory && (
            <div className="rounded-lg bg-blue-50/70 border border-blue-100 p-2.5 mb-2">
              <div className="text-[11px] font-bold text-blue-800 mb-0.5 flex items-center gap-1">Business Story <span title="Composed from fields we hold (not a literal API record, not a live LLM call)" className="text-[8px] px-1 rounded bg-white text-blue-500 border border-blue-200 cursor-help font-normal normal-case">composed</span></div>
              <p className="text-[12px] text-gray-700 leading-snug">{m.businessStory.text}{m.businessStory.inferredParts.length > 0 && <span title={`inferred parts: ${m.businessStory.inferredParts.join(', ')} (web_osint)`} className="ml-1 text-[8px] px-1 rounded bg-sky-50 text-sky-600 border border-sky-200 cursor-help align-middle">inferred: {m.businessStory.inferredParts.join(', ')}</span>}</p>
            </div>
          )}
          <SectionTitle>Business Overview</SectionTitle>
          {m.overview.map((o) => <KV key={o.label} Ic={CircleDot} label={o.label} f={o.field} />)}
          <SectionTitle>Procurement Profile</SectionTitle>
          {m.procurement.map((o) => <KV key={o.label} Ic={CircleDot} label={o.label} f={o.field} />)}
          <SectionTitle>Market Focus</SectionTitle>
          {m.market.map((o) => <KV key={o.label} Ic={CircleDot} label={o.label} f={o.field} />)}
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
                ? <span className={/active|verified/i.test(String(m.company.gstStatus.value)) ? 'text-emerald-600 font-semibold' : 'text-amber-600 font-semibold'}>{/active|verified/i.test(String(m.company.gstStatus.value)) ? '✓ ' : ''}{m.company.gstStatus.value}</span>
                : <span className="text-gray-300 italic">Not available</span>}
            </span>
          </div>
          <KV Ic={User} label="Trade Name / Company Name" f={m.company.tradeName} />
          <KV Ic={Building2} label="Constitution of Business" f={m.company.constitution} />
          <KV Ic={Calendar} label="Date of Registration" f={m.company.regDate} />
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
            {m.company.udyam.present && (m.company.udyam.majorActivity.present || m.company.udyam.organizationType.present) && (
              <div className="ml-6 text-[9.5px] text-gray-500 flex flex-wrap gap-x-2">{m.company.udyam.majorActivity.present && <span>{m.company.udyam.majorActivity.value}</span>}{m.company.udyam.organizationType.present && <span>· {m.company.udyam.organizationType.value}</span>}{m.company.udyam.incorporation.present && <span>· inc {m.company.udyam.incorporation.value}</span>}</div>
            )}
            {m.company.udyam.nicIndustries.length > 0 && <div className="ml-6 text-[9.5px] text-gray-500">NIC: {m.company.udyam.nicIndustries.slice(0, 3).join(' · ')}</div>}
          </div>

          <SectionTitle>Requirement Activity (Last 6 Months) {m.requirementActivity.total != null && <span className="float-right normal-case text-gray-500 font-normal">Total: {m.requirementActivity.total}</span>}</SectionTitle>
          <ActivityChart months={m.requirementActivity.months} note={m.requirementActivity.note} />
        </div>

        {/* ── COLUMN 3 — SOCIAL / PRODUCTS / PLAN ── */}
        <div>
          <ColTitle>Social Media Presence</ColTitle>
          <KV Ic={Globe} label="Website" f={m.social.website} link />
          <SocialKV Brand={FacebookI} label="Facebook" f={m.social.facebook} />
          <SocialKV Brand={InstagramI} label="Instagram" f={m.social.instagram} />
          <SocialKV Brand={LinkedinI} label="LinkedIn" f={m.social.linkedin} />
          <SocialKV Brand={TwitterI} label="Twitter / X" f={m.social.twitter} />
          {m.googleBusiness?.exists && m.googleBusiness.rating && (
            <KV Ic={Star} label={m.googleBusiness.kind === 'maps_contributor' ? 'Google Maps profile' : 'Google Business'} f={{ value: m.googleBusiness.rating, present: true, provenance: 'inferred', source: m.googleBusiness.kind === 'maps_contributor' ? 'Sign3 · Google-Maps contributor profile' : 'web_osint', inferred: true, note: m.googleBusiness.kind === 'maps_contributor' ? 'personal Google-Maps contributor profile (phone-linked) — its pin may sit in a different city than the registered address; not the firm\'s verified Google Business listing' : undefined }} />
          )}

          <SectionTitle>Products of Interest</SectionTitle>
          {m.products.length ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              {m.products.map((p, i) => <div key={`${p}-${i}`} className="text-[11px] text-gray-700 flex items-start gap-1"><span className="text-gray-300">•</span><span className="break-words">{p}</span></div>)}
            </div>
          ) : <div className="text-[11px] text-gray-300 italic">Not available</div>}
          {m.productsOffered.length > 0 && <div className="text-[9px] text-gray-400 mt-1">({m.productsOffered.length} products offered-to-buyer also on file — hidden by default; enquired-only shown to reflect buyer intent)</div>}

          {/* Latest requirement — BuyLead-page fields (order value / type / specs), consistent with the BuyLead view (#4) */}
          {lr && (
            <>
              {/* N1 — a fully-expired buyer must NOT read as having a live lead: reframe the title + show an Expired pill + a browse-only note */}
              <SectionTitle>{lr.isExpired ? 'Last Requirement (expired)' : 'Latest Requirement'}</SectionTitle>
              <div className="rounded-lg border border-gray-100 bg-gray-50/50 p-2 text-[11px] text-gray-700 space-y-0.5">
                <div className="font-semibold text-gray-800 break-words flex items-start gap-1"><ShoppingBag className="w-3.5 h-3.5 shrink-0 text-gray-400 mt-px" /><span className="flex-1">{lr.title || '—'}</span>{lr.isExpired && <span className="shrink-0 rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide bg-red-50 text-red-600 border border-red-100" title={`This BuyLead is expired${lr.expiry ? ` (expiry ${lr.expiry})` : ''} — it is not a live requirement`}>Expired{lr.expiry ? ` · ${lr.expiry}` : ''}</span>}</div>
                {lr.category.present && <div className="text-gray-500 ml-5">Category: {lr.category.value}</div>}
                <div className="flex items-center gap-1"><span className="text-gray-500">Order value:</span> <Val f={lr.orderValue} /></div>
                <div className="flex items-center gap-1"><span className="text-gray-500">Requirement type:</span> <Val f={lr.requirementType} /></div>
                {lr.specs.length > 0 && <div className="text-gray-500">Specs: <span className="text-gray-700">{lr.specs.map((s) => `${s.k}: ${s.v}`).join(' · ')}</span></div>}
                {lr.posted && <div className="text-[9px] text-gray-400">Posted {lr.posted}</div>}
                {lr.isExpired && !m.hasActiveRequirement && <div className="text-[9px] text-amber-600 mt-0.5">No live BuyLead — the buyer is currently browsing, with no open requirement.</div>}
              </div>
            </>
          )}

          {/* TrustSEAL Buyer Plan — dummy placeholder (no plan data in pipeline yet); ellipsis so it never over-elongates (#6) */}
          <SectionTitle>TrustSEAL Buyer Plan</SectionTitle>
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/50 p-2.5">
            <div className="flex items-center justify-between gap-2"><span className="text-[11px] text-gray-500 shrink-0">Plan Type</span><span className="text-[11px] font-semibold text-gray-700 truncate" title="TrustSEAL Verified (sample)">TrustSEAL Verified</span></div>
            <div className="flex items-center justify-between gap-2 mt-1"><span className="text-[11px] text-gray-500 shrink-0">Activated On</span><span className="text-[11px] text-gray-400 truncate">—</span></div>
            <div className="text-[8px] text-gray-400 mt-1 italic">placeholder · no plan data in the pipeline yet</div>
          </div>
        </div>
      </div>

      <ProofsSection proofs={m.proofs} />

      <div className="px-4 pb-2 text-[9px] text-gray-400 border-t border-gray-100 pt-1.5">
        <span className="text-sky-500">inferred</span> = web_osint / LLM synthesis · <span className="text-gray-500">derived</span> = encoded rule · <span className="text-emerald-600">✓✓</span> = agreed by ≥2 sources · <span className="italic">Not available</span> = no source field (never fabricated) · TrustSEAL Plan tile = placeholder (no plan data in pipeline)
      </div>
    </div>
  );
}
