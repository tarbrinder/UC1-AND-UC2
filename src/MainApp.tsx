import { useState, useMemo } from 'react';
import { Zap, Layers, Mic, FileText, Sparkles, Search, FolderTree, ExternalLink, BarChart3, Package } from 'lucide-react';
import RFQModalV3 from './components/RFQModalV3';
import RFQModalV4 from './components/RFQModalV4';
import SimpleRFQForm from './components/SimpleRFQForm';
import BuyerLedgerView from './components/BuyerLedgerView';
import { buildRfqLedger, rfqStateFromInspector } from './lib/rfqLedger';
import { isDebug } from './lib/debugFlag';
import type { InspectorState } from './lib/inspectorData';

type ModalVariant = 'v1' | 'v2' | 'v3' | 'smart' | 'v4' | null;

// ── UI declutter (owner) — hide the public quote CTAs + the extra debug pulls/ledgers FOR NOW. Everything is kept
//    in source (just gated) so we can re-enable in future by flipping a single flag. Debug landing keeps ONLY the
//    Buyer-GLID input + the 🔬 Buyer Ledger entry. ─────────────────────────────────────────────────────────────
const SHOW_QUOTE_CTAS: boolean = true;    // the "All RFQ form variants" hub (Simple/Category · popup/standalone · V1–V4 · debug)
const SHOW_EXTRA_DEBUG: boolean = false;  // Pull → V3 · Pull → V4 · 🔬 RFQ Ledger · Ignore-Twin toggle · explainer line

const VARIANT_LABELS: Record<NonNullable<ModalVariant>, string> = {
  v1: 'V1',
  v2: 'V2',
  v3: 'V3',
  smart: 'Smart',
  v4: 'V4',
};

// Module 2 demo — a representative RFQ state (the live RFQ passes its real inspectorState the same way).
// Module-level constant so its identity is stable across renders (no effect churn).
const RFQ_DEMO_STATE = {
  intent: { value: 'Construction site power', confidence: 100, journey: 'industrial', candidates: [{ label: 'Construction site power', score: 70, reason: 'buyer picked' }, { label: 'Manufacturing unit operations', score: 60, reason: 'manufacturer profile' }, { label: 'Backup for premises', score: 40, reason: 'common but not stated' }] },
  planner: { budgetMax: 3, questions: [{ id: 'q1', label: 'What is your budget for this generator?', priority: 90, reason: 'this category negotiates hard', groundedIn: 'category:price-blocker' }, { id: 'q2', label: 'What installation service do you need?', priority: 85, reason: 'capital equipment', groundedIn: 'product:capital' }], considered: [{ label: 'What phase is required?', score: 75, reason: "covered by 'Phase' spec" }, { label: 'Preferred engine brand?', score: 65, reason: "covered by 'Engine Brand' spec" }, { label: 'Silent or open type?', score: 70, reason: "covered by 'Genset Type' spec" }] },
  specs: [{ name: 'Rated Power', value: '5 kVA', source: 'user', priority: 100 }, { name: 'Genset Type', value: 'Open', source: 'user', priority: 94 }, { name: 'Phase', value: 'Single Phase', source: 'cascade-inferred', priority: 85, reason: 'inferred from 5 kVA + open' }, { name: 'Cooling System', value: 'Air Cooled', source: 'cascade-inferred', priority: 95 }, { name: 'Warranty', value: '', source: 'isq', priority: 40 }],
  logistics: { paymentTerms: { value: 'Credit (Post-Delivery)', confidence: 85, reason: 'capital equipment, manufacturer buyer leans credit' } },
};

export default function MainApp() {
  const [activeModal, setActiveModal] = useState<ModalVariant>(null);
  // Step-0 debug staging: the GLID/Pull CTA now lives HERE (on the landing). It stages a GLID and
  // opens Smart with autoPull → the modal runs its existing pull on mount, so the product screen
  // stays clean. ?debug-gated (demo prefill). Opening any card directly = a clean cold run.
  const debug = isDebug(); // sticky within the tab — survives the dep-reopt reload that drops ?debug
  // Simple RFQ — the plain, no-AI/no-n8n flow (mcat-resolve → GetIsq/getISQs → qty+specs only).
  // Always visible on the landing (not ?debug-gated) since it needs no enrichment pull to run.
  const [simpleFormOpen, setSimpleFormOpen] = useState(false);
  const [simpleFormMode, setSimpleFormMode] = useState<'simple' | 'category'>('simple'); // Simple (no corpus) vs Category (corpus-driven) popup
  const openSimple = (mode: 'simple' | 'category') => { setSimpleFormMode(mode); setSimpleFormOpen(true); };
  const [stagedGlid, setStagedGlid] = useState('');
  const [stagedIgnoreTwin, setStagedIgnoreTwin] = useState(false);
  const [autoPull, setAutoPull] = useState(false);
  const [stagingOnly, setStagingOnly] = useState(false); // B-step-2: open Smart in staging mode (debug panels first)
  const [ledgerOpen, setLedgerOpen] = useState(false); // Module 1: standalone Buyer Ledger Observatory (GLID pull → clickable provenance)
  const [rfqLedgerOpen, setRfqLedgerOpen] = useState(false); // Module 2: SAME ledger over Intent/Planner/Spec/Logistics
  // P6 · the live RFQ ledger — set from a real V4 run (on form close). Until a run exists, fall back to the demo.
  const [liveRfqState, setLiveRfqState] = useState<InspectorState | null>(null);
  const rfqDemoLedger = useMemo(() => buildRfqLedger(RFQ_DEMO_STATE), []); // stable identity → no effect churn
  const rfqLiveLedger = useMemo(() => (liveRfqState ? buildRfqLedger(rfqStateFromInspector(liveRfqState)) : null), [liveRfqState]);
  const rfqLedger = rfqLiveLedger ?? rfqDemoLedger;
  // "Pull" → open Smart in STAGING mode (pulls + shows the pulled-data debug panels at step 0).
  // "Start RFQ →" inside the staging view flips stagingOnly off (same instance, data persists).
  const openStaged = (target: 'smart' | 'v4' = 'smart') => { if (!stagedGlid.trim()) return; setAutoPull(true); setStagingOnly(true); setActiveModal(target); };
  // Hub → open a quote-engine variant cold (no pull/staging). Same as the old pill onClick.
  const openVariant = (id: NonNullable<ModalVariant>) => { setAutoPull(false); setStagingOnly(false); setActiveModal(id); };
  // Hub → the debug Profile & Enrichment observatory. Seeds the recurring demo GLID if none is staged.
  const openLedger = () => { setStagedGlid((g) => g.trim() || '268590579'); setLedgerOpen(true); };
  // The full menu of RFQ surfaces (owner: "surface ALL"), each with a one-line "what it does differently".
  const HUB_GROUPS: { group: string; items: { title: string; tag: string; desc: string; Icon: typeof Zap; onClick: () => void }[] }[] = [
    {
      group: 'Post a Requirement — the redesigned form',
      items: [
        { title: 'Simple', tag: 'Popup', desc: 'No category corpus — buyer + seller specs + your input → top-5 smart questions. Today’s live flow.', Icon: Search, onClick: () => openSimple('simple') },
        { title: 'Category', tag: 'Popup', desc: 'Corpus-driven: the whole category-intelligence corpus feeds one LLM call for the questions (needs v51 n8n).', Icon: FolderTree, onClick: () => openSimple('category') },
        { title: 'Simple · standalone', tag: 'Full page', desc: 'The Simple form on its own full page, no dashboard chrome. Opens ?rfq=simple.', Icon: ExternalLink, onClick: () => { window.location.href = '?rfq=simple'; } },
        { title: 'Category · standalone', tag: 'Full page', desc: 'The Category form on its own full page. Opens ?rfq=category.', Icon: ExternalLink, onClick: () => { window.location.href = '?rfq=category'; } },
        { title: 'Standard Product', tag: 'Brand', desc: 'Exact catalog product from a brand page ("Get Best Price") — 6 pre-set specs + describe, no search, no LLM. Opens ?rfq=standard.', Icon: Package, onClick: () => { window.location.href = '?rfq=standard&sid=456523'; } },
      ],
    },
    {
      group: 'Quote engines — earlier versions',
      items: [
        { title: 'Quick Quote', tag: 'V1', desc: 'Fastest path — 2-min, no signup. Minimal fields.', Icon: Zap, onClick: () => openVariant('v1') },
        { title: 'Quick Quote V2', tag: 'V2', desc: 'Richer specs via dual ISQ APIs (GetIsq + getISQs).', Icon: Layers, onClick: () => openVariant('v2') },
        { title: 'Voice Quote', tag: 'V3', desc: 'Voice-first — speak the requirement, zero typing.', Icon: Mic, onClick: () => openVariant('v3') },
        { title: 'Smart RFQ', tag: 'Smart', desc: 'AI-matched — best supplier fit from the enriched requirement.', Icon: FileText, onClick: () => openVariant('smart') },
        { title: 'AI Studio', tag: 'V4', desc: 'AI Inspector — hover any AI decision to see its provenance.', Icon: Sparkles, onClick: () => openVariant('v4') },
      ],
    },
    {
      group: 'Debug',
      items: [
        { title: 'Profile & Enrichment', tag: 'Debug', desc: 'GLID → an AI-built buyer twin + enriched requirement, every claim traced back to its raw source.', Icon: BarChart3, onClick: openLedger },
      ],
    },
  ];
  // UC3 · launch the live RFQ form for the buyer in the Ledger (mobile=V3/voice, desktop=V4/inspector), debug staging.
  const openFormForBuyer = (variant: 'v3' | 'v4', g: string) => { if (!g.trim()) return; setLedgerOpen(false); setRfqLedgerOpen(false); setStagedGlid(g); setAutoPull(true); setStagingOnly(true); setActiveModal(variant === 'v4' ? 'v4' : 'smart'); };


  return (
    <div className="min-h-screen bg-gradient-to-b from-[#f0f4f8] to-[#e8edf2] flex flex-col items-center justify-center px-4 py-16">

      <div className="flex flex-col items-center text-center max-w-xl w-full space-y-6">

        {/* Lightning bolt icon */}
        <div className="w-16 h-16 rounded-2xl bg-teal-500 shadow-lg flex items-center justify-center animate-float-gentle">
          <Zap className="w-8 h-8 text-white" />
        </div>

        {/* Headline — this is the internal Buyer-Intelligence console, NOT a buyer-facing quote marketplace (owner) */}
        <div className="space-y-2">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-gray-900">
            Buyer Intelligence
          </h1>
          <div className="inline-flex items-center justify-center">
            <span className="inline-block bg-gray-100 text-gray-600 font-semibold text-sm sm:text-base px-4 py-1 rounded-full">
              RFQ · Profile &amp; Requirement Enrichment
            </span>
          </div>
        </div>

        {/* Subtitle — what the tool actually does */}
        <p className="text-gray-500 text-base sm:text-lg leading-relaxed max-w-md">
          Drop a buyer&apos;s GLID → an AI-built profile + enriched requirement,
          <br />
          every deduction traced back to its raw source.
        </p>

        {/* What this is — replaces the old marketplace trust badges */}
        <div className="flex items-center justify-center gap-6 flex-wrap">
          <div className="flex items-center gap-1.5 text-sm text-gray-600">
            <Sparkles className="w-4 h-4 text-teal-600" />
            <span>One LLM · no black box</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-gray-600">
            <Layers className="w-4 h-4 text-teal-600" />
            <span>Every claim → raw source</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-gray-600">
            <FileText className="w-4 h-4 text-teal-600" />
            <span>Profile + Requirement enrichment</span>
          </div>
        </div>

        {/* Simple RFQ — always visible, no ?debug needed, no GLID required. Plain category/spec
            APIs only: no Gemini, no buyer enrichment, no n8n. */}
        <button
          type="button"
          onClick={() => openSimple('simple')}
          className="px-8 py-3.5 rounded-2xl bg-teal-600 text-white text-base font-semibold hover:bg-teal-700 transition-colors shadow-sm"
        >
          Post a Requirement →
        </button>

        {/* Step-0 debug staging — the Buyer GLID / Pull CTA lives HERE (above the cards so it's the
            first thing in ?debug). "Pull" → staging view (pulled-data debug) → "Start RFQ →" → clean form. */}
        {debug && (
          <div className="w-full max-w-sm rounded-2xl border border-purple-200 bg-purple-50/70 p-3 text-left">
            <p className="text-[11px] font-semibold text-purple-700 uppercase tracking-wide mb-2">🐞 Debug · Buyer GLID (demo prefill)</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={stagedGlid}
                onChange={(e) => setStagedGlid(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter' && stagedGlid.trim()) setLedgerOpen(true); }}
                placeholder="e.g., 268590579"
                className="flex-1 min-w-0 border border-purple-200 rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-400"
              />
              {SHOW_EXTRA_DEBUG && (
                <button
                  type="button"
                  disabled={!stagedGlid.trim()}
                  onClick={() => openStaged('smart')}
                  className="px-3 rounded-xl bg-gray-800 text-white text-sm font-semibold hover:bg-gray-900 disabled:opacity-50"
                >
                  Pull → V3
                </button>
              )}
              {SHOW_EXTRA_DEBUG && (
                <button
                  type="button"
                  disabled={!stagedGlid.trim()}
                  onClick={() => openStaged('v4')}
                  title="Pull buyer history, then Start RFQ into the V4 AI Inspector"
                  className="px-3 rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  Pull → V4
                </button>
              )}
              <button
                type="button"
                disabled={!stagedGlid.trim()}
                onClick={() => setLedgerOpen(true)}
                title="Standalone Buyer Ledger — click any attribute to see its full Fact→Belief→Decision→Consumption→Outcome chain"
                className="px-4 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
              >
                📊 Profile & Enrichment
              </button>
              {SHOW_EXTRA_DEBUG && (
                <button
                  type="button"
                  onClick={() => setRfqLedgerOpen(true)}
                  title="Module 2 — the SAME Decision Ledger over the RFQ surfaces (intent, planner questions, specs, logistics)"
                  className="px-3 rounded-xl bg-teal-600 text-white text-sm font-semibold hover:bg-teal-700"
                >
                  🔬 RFQ Ledger
                </button>
              )}
            </div>
            {SHOW_EXTRA_DEBUG && (
              <>
                <label className="flex items-center gap-1.5 mt-2 text-[11px] text-purple-700 cursor-pointer select-none">
                  <input type="checkbox" checked={stagedIgnoreTwin} onChange={(e) => setStagedIgnoreTwin(e.target.checked)} className="accent-purple-600" />
                  🧪 Ignore Twin (cold run — skip persona/concierge)
                </label>
                <p className="text-[10px] text-purple-400 mt-1.5">Pull → inspect the pulled buyer data (Twin · Dossier · Pipeline · External · raw) → Start the clean RFQ.</p>
              </>
            )}
          </div>
        )}

        {/* audit MAIN-164: without ?debug the landing has no interactive CTA (GLID input is debug-gated, quote CTAs off) —
            so show a one-line hint instead of a dead-end page. */}
        {!debug && !SHOW_QUOTE_CTAS && (
          <p className="text-[12px] text-gray-400 max-w-sm text-center">Append <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-600">?debug=1</code> to the URL to open the Buyer Profile &amp; Enrichment console.</p>
        )}

      </div>

      {/* ── All RFQ form variants hub (owner: "surface ALL") — every RFQ surface in one place, each with a
             one-line "what it does differently". Wider than the intro column. ── */}
      {SHOW_QUOTE_CTAS && (
        <div className="w-full max-w-5xl mt-14 space-y-8">
          <div className="text-center">
            <h2 className="text-lg font-bold text-gray-800">All RFQ form variants</h2>
            <p className="text-[13px] text-gray-400 mt-1">Every version in one place — pick one to open it.</p>
          </div>
          {HUB_GROUPS.map((grp) => (
            <div key={grp.group} className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 px-1">{grp.group}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {grp.items.map((item) => {
                  const { Icon } = item;
                  return (
                    <button
                      key={item.title}
                      type="button"
                      onClick={item.onClick}
                      className="group text-left p-4 rounded-2xl border border-gray-200 bg-white hover:border-teal-300 hover:shadow-md hover:-translate-y-0.5 transition-all flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="w-9 h-9 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center group-hover:bg-teal-100 transition-colors"><Icon size={18} /></span>
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{item.tag}</span>
                      </div>
                      <p className="font-bold text-gray-800 text-sm">{item.title}</p>
                      <p className="text-[12px] text-gray-500 leading-snug">{item.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {activeModal && activeModal !== 'v4' && (
        <RFQModalV3
          onClose={() => { setActiveModal(null); setAutoPull(false); setStagingOnly(false); }}
          variantLabel={VARIANT_LABELS[activeModal]}
          initialGlid={stagedGlid}
          autoPull={autoPull && activeModal === 'smart'}
          initialIgnoreTwin={stagedIgnoreTwin}
          stagingOnly={stagingOnly && activeModal === 'smart'}
          onStart={() => setStagingOnly(false)}
        />
      )}
      {/* V4 — AI Inspector (experimental, replica of V3 + 50/50 split inspector). V3 untouched. */}
      {activeModal === 'v4' && (
        <RFQModalV4
          onClose={() => { setActiveModal(null); setAutoPull(false); setStagingOnly(false); }}
          variantLabel="V4"
          initialGlid={stagedGlid}
          autoPull={autoPull && activeModal === 'v4'}
          initialIgnoreTwin={stagedIgnoreTwin}
          stagingOnly={stagingOnly && activeModal === 'v4'}
          onStart={() => setStagingOnly(false)}
          onInspectorState={setLiveRfqState}
        />
      )}
      {/* Simple RFQ — the plain, no-AI/no-n8n flow. Landing CTA above opens SIMPLE; the hub can also open
          CATEGORY (corpus-driven). ?login=1 demos the logged-in scenario. */}
      {simpleFormOpen && (
        <SimpleRFQForm onClose={() => setSimpleFormOpen(false)} categoryMode={simpleFormMode} loggedIn={(() => { try { return new URLSearchParams(window.location.search).get('login') === '1'; } catch { return false; } })()} />
      )}
      {/* Module 1 — standalone Buyer Ledger Observatory (GLID pull → clickable provenance). Reads the same ledger. */}
      {ledgerOpen && (
        <BuyerLedgerView glid={stagedGlid} onClose={() => setLedgerOpen(false)} onOpenForm={openFormForBuyer} />
      )}
      {/* Module 2 — the SAME ledger view over the RFQ state (intent/planner/spec/logistics). P6: now the LIVE
          run when a V4 session has completed (rfqLiveLedger), else the representative demo. */}
      {rfqLedgerOpen && (
        <BuyerLedgerView glid={stagedGlid} title={`🔬 RFQ Ledger · Intent · Planner · Spec · Logistics${rfqLiveLedger ? ' · LIVE run' : ' · demo'}`} onClose={() => setRfqLedgerOpen(false)} presetLedger={rfqLedger} onOpenForm={openFormForBuyer} />
      )}
    </div>
  );
}
