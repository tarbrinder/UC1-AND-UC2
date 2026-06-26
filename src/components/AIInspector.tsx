// ─── AI INSPECTOR (V4) ─────────────────────────────────────────────────────────────────────────
// Right half of the V4 "AI Studio" split. PURE renderer of an InspectorPayload (built by
// src/lib/inspectorData.ts from the form's live state) + trace SEARCH + COMPARE. Shows decision
// provenance for the hovered/pinned element: decision · alternatives · suppressed · evidence · source ·
// confidence · prompt/version · tokens · cost · latency · failure-mode. Hover=preview · click=pin ·
// click a 2nd element=compare (A vs B). Search "site ready" → where it was generated/asked/suppressed.

import { useState } from 'react';
import { searchInspector, type InspectorPayload, type InspectorState, type Tone } from '../lib/inspectorData';

interface Props {
  payload: InspectorPayload | null;       // hovered/pinned element (slot A)
  payloadB?: InspectorPayload | null;      // compare slot (B)
  summary: InspectorPayload;               // default view when nothing hovered
  observatory?: InspectorPayload | null;   // L11-L20 + quality-gate report (the Observatory lens)
  state: InspectorState;                   // full decision state — for trace search
  pinned: boolean;
  onUnpin: () => void;
  onUnpinB?: () => void;
}

const TONE: Record<Tone, string> = { good: 'text-emerald-700', warn: 'text-amber-600', bad: 'text-rose-600', info: 'text-teal-700', muted: 'text-gray-400' };
const BAR: Record<Tone, string> = { good: 'bg-emerald-400', warn: 'bg-amber-400', bad: 'bg-rose-400', info: 'bg-teal-400', muted: 'bg-gray-300' };

function Body({ p }: { p: InspectorPayload }) {
  return (
    <>
      <div className="px-4 pt-3 pb-2 border-b border-gray-100">
        <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">{p.title}</p>
        <p className={`text-[15px] font-bold mt-0.5 ${p.decisionTone ? TONE[p.decisionTone] : 'text-gray-900'}`}>{p.decision}</p>
      </div>
      <div className="px-4 py-3 space-y-3">
        {p.sections.map((s, si) => (
          <div key={si}>
            <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1">{s.title}</p>
            <div className="space-y-1">
              {s.rows.map((r, ri) => (
                <div key={ri} className="flex items-start gap-2">
                  <span className="text-gray-500 shrink-0 min-w-[92px]">{r.label}</span>
                  <span className="flex-1 min-w-0">
                    {typeof r.score === 'number' && (
                      <span className="inline-flex items-center gap-1 mr-1.5 align-middle">
                        <span className="inline-block w-10 h-1.5 rounded-full bg-gray-100 overflow-hidden align-middle">
                          <span className={`block h-full rounded-full ${BAR[r.tone ?? 'muted']}`} style={{ width: `${Math.max(0, Math.min(100, r.score))}%` }} />
                        </span>
                        <b className={TONE[r.tone ?? 'muted']}>{r.score}</b>
                      </span>
                    )}
                    {r.value != null && <span className={`font-medium ${r.tone ? TONE[r.tone] : 'text-gray-800'}`}>{r.value}</span>}
                    {r.sub && <span className="block text-[11px] text-gray-400 leading-tight">{r.sub}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export default function AIInspector({ payload, payloadB, summary, observatory, state, pinned, onUnpin, onUnpinB }: Props) {
  const [q, setQ] = useState('');
  const [view, setView] = useState<'summary' | 'observatory'>('summary');
  const query = q.trim();
  const hits = query.length >= 2 ? searchInspector(state, query) : null;
  // when nothing is hovered/pinned, the default pane is either the exec summary or the Observatory lens
  const defaultPayload = view === 'observatory' && observatory ? observatory : summary;
  const p = payload ?? defaultPayload;
  const live = !!payload;
  const comparing = !!payloadB;

  return (
    <div className="h-full overflow-y-auto bg-white text-[12.5px] text-gray-700">
      <div className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 backdrop-blur px-4 py-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-gray-900 flex items-center gap-1.5">🔬 AI Inspector{comparing && <span className="text-[10px] font-medium text-fuchsia-600">⇆ comparing</span>}</h2>
          {pinned ? (
            <button onClick={onUnpin} className="text-[11px] rounded-full bg-teal-50 border border-teal-300 text-teal-700 px-2.5 py-1 hover:bg-teal-100">📌 pinned · unpin</button>
          ) : (
            <span className="text-[10px] text-gray-400">{live ? 'hover · click to pin · click 2nd to compare' : 'hover an element →'}</span>
          )}
        </div>
        <div className="relative">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder='Trace search — "site ready", "power", "credit"' className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[12px] outline-none focus:ring-2 focus:ring-teal-200 focus:border-teal-300" />
          {query.length >= 2 && <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">✕ clear</button>}
        </div>
        {observatory && !live && hits === null && !comparing && (
          <div className="flex items-center gap-1 rounded-lg bg-gray-100 p-0.5 text-[11px] font-semibold">
            <button onClick={() => setView('summary')} className={`flex-1 rounded-md px-2 py-1 transition ${view === 'summary' ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>📋 Summary</button>
            <button onClick={() => setView('observatory')} className={`flex-1 rounded-md px-2 py-1 transition ${view === 'observatory' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>🛰 Observatory</button>
          </div>
        )}
      </div>

      {hits !== null ? (
        <div className="px-4 py-3">
          <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1.5">{hits.length} hit{hits.length === 1 ? '' : 's'} for "{query}" — generated · asked · suppressed across the RFQ</p>
          {hits.length === 0 ? (
            <p className="text-gray-400">No surface mentions "{query}". It was never generated, asked, or suppressed.</p>
          ) : (
            <div className="space-y-1.5">
              {hits.map((h, i) => (
                <div key={i} className="flex items-start gap-2 border-b border-gray-50 pb-1.5">
                  <span className="text-[10px] uppercase font-semibold text-gray-400 min-w-[64px] shrink-0">{h.surface}</span>
                  <span className="flex-1 min-w-0"><b className="text-gray-800">{h.label}</b> → <span className={TONE[h.tone]}>{h.disposition}</span>{h.detail && <span className="block text-[11px] text-gray-400 leading-tight">{h.detail}</span>}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : comparing && payloadB ? (
        <div>
          <div className="bg-teal-50/60"><div className="px-4 pt-1.5 text-[10px] uppercase tracking-wide text-teal-600 font-semibold flex items-center justify-between"><span>A</span>{pinned && <button onClick={onUnpin} className="text-teal-600 hover:text-teal-800 normal-case">unpin A</button>}</div><Body p={p} /></div>
          <div className="px-4 py-1 text-center text-[11px] font-bold text-fuchsia-500 bg-gradient-to-r from-transparent via-fuchsia-50 to-transparent">⇆ VS</div>
          <div className="bg-fuchsia-50/40"><div className="px-4 pt-1.5 text-[10px] uppercase tracking-wide text-fuchsia-600 font-semibold flex items-center justify-between"><span>B</span><button onClick={onUnpinB} className="text-fuchsia-600 hover:text-fuchsia-800 normal-case">unpin B</button></div><Body p={payloadB} /></div>
        </div>
      ) : (
        <>
          <Body p={p} />
          {!live && view === 'summary' && (
            <p className="px-4 pb-4 text-[11px] text-gray-400 leading-relaxed">
              This is the executive summary. <b>Hover</b> any AI-driven element on the left to see <b>why</b> it was decided, what alternatives lost, and what was suppressed. <b>Click</b> to pin, click a 2nd element to <b>compare</b>. Or flip to <b>🛰 Observatory</b> for the trust/value/governance lens, or <b>search</b> above.
            </p>
          )}
          {!live && view === 'observatory' && (
            <p className="px-4 pb-4 text-[11px] text-gray-400 leading-relaxed">
              The <b>Observatory</b> answers the trust/value/governance questions for the live RFQ: quality gates, who's allowed to decide, what was produced but not consumed, evidence sufficiency &amp; robustness, what survives without the LLM, source ROI, and blast-radius if a decision is wrong. STRUCTURAL rows are flagged where measured outcomes aren't wired yet.
            </p>
          )}
        </>
      )}
    </div>
  );
}
