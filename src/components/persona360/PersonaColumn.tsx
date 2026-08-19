// Persona360 — column 1 · PERSONA (K-5). Design §5 PersonaColumn.
import type { ColumnState, Persona360Data } from '../../lib/persona360Types';
import { navy } from './tokens';
import { ColumnEmpty, ColumnError, ColumnLoading, FieldRow, SectionTitle } from './ui';

const STAGES = ['startup', 'sme', 'mid', 'enterprise'] as const;
const STAGE_LABELS: Record<(typeof STAGES)[number], string> = {
  startup: 'Startup',
  sme: 'SME',
  mid: 'Mid',
  enterprise: 'Enterprise',
};

function AssignedPersonaCard({ persona, mode = 'fixture' }: { persona: Persona360Data['persona']; mode?: 'fixture' | 'live' }) {
  // In live mode the workflow/audit does not emit a real match % — never fabricate one
  // from the score-less adapter (matchPct is 0 there). Show '—' instead of "0% match".
  const showMatch = mode !== 'live' ? persona.matchPct : (persona.matchPct > 0 ? persona.matchPct : null);
  return (
    <div className="mb-4 rounded-md p-3" style={{ backgroundColor: navy }}>
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-wider text-slate-400">Assigned persona</span>
        <span className="text-[11px] font-bold text-amber-500">
          {showMatch != null ? `${showMatch}% match` : 'match —'}
        </span>
      </div>
      <div className="mt-1 text-[15px] font-extrabold leading-snug text-white">{persona.primary}</div>
      {persona.alternate && <div className="mt-0.5 text-[10px] text-slate-300">Alternate: {persona.alternate}</div>}
    </div>
  );
}

function StageScale({ stage, stageEstimate }: { stage: Persona360Data['persona']['stage']; stageEstimate?: string }) {
  const activeIdx = STAGES.indexOf(stage);
  return (
    <div className="mb-3 mt-1">
      <div className="flex gap-1">
        {STAGES.map((s, i) => (
          <span
            key={s}
            className={`h-1.5 flex-1 rounded-sm ${i <= activeIdx ? '' : 'bg-gray-200'}`}
            style={i <= activeIdx ? { backgroundColor: navy } : undefined}
          />
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        {STAGES.map((s) => (
          <span
            key={s}
            className={`flex-1 text-center text-[9px] ${s === stage ? 'font-bold text-gray-900' : 'text-gray-500'}`}
          >
            {STAGE_LABELS[s]}
          </span>
        ))}
      </div>
      {stageEstimate && <div className="mt-1 text-[10px] text-gray-500">{stageEstimate}</div>}
    </div>
  );
}

export function PersonaColumn({
  persona,
  state = 'ready',
  sourcesAbsent,
  onRetry,
  mode = 'fixture',
}: {
  persona: Persona360Data['persona'];
  state?: ColumnState;
  sourcesAbsent?: string[];
  onRetry?: () => void;
  mode?: 'fixture' | 'live';
}) {
  return (
    <section className="bg-white p-4 dark:bg-slate-800">
      <SectionTitle>1 · PERSONA</SectionTitle>
      {state === 'loading' && <ColumnLoading rows={4} />}
      {state === 'error' && <ColumnError message="Persona sources failed — see source health" onRetry={onRetry} />}
      {state === 'empty' && <ColumnEmpty message="No persona data" sourcesAbsent={sourcesAbsent} />}
      {state === 'ready' && (
        <>
          <AssignedPersonaCard persona={persona} mode={mode} />
          <FieldRow label="Industry" sub={persona.industrySecondary}>
            <div className="text-[13px] font-semibold text-gray-900">{persona.industry}</div>
          </FieldRow>
          <FieldRow label="Stage of business">
            <StageScale stage={persona.stage} stageEstimate={persona.stageEstimate} />
          </FieldRow>
          <FieldRow label="Turnover / Income" sub={persona.turnover.declared ? 'declared p.a.' : undefined}>
            <div className="text-[13px] font-semibold text-gray-900">
              {persona.turnover.display}{' '}
              <span className="text-[10px] font-normal text-gray-500">declared p.a.</span>
            </div>
            {persona.turnover.warning && (
              <div className="mt-0.5 text-[11px] font-semibold text-red-600">{persona.turnover.warning}</div>
            )}
          </FieldRow>
          <FieldRow label="Buying entity" sub={persona.entity.detail}>
            <div className="text-[13px] font-semibold text-gray-900">{persona.entity.type}</div>
          </FieldRow>
        </>
      )}
    </section>
  );
}