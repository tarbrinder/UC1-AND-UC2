// Persona360 — page shell (K-5 tasks 2+3). Owns data acquisition (fixture now,
// Buyer-intelligence webhook later — swap inside this file only, design §0.2).
// Layout: 4 bands on canvas gray per design §1 — TrustStrip → PersonaHeader →
// ColumnsBand (4 equal white columns) → EngagementBand. 1px gutters via gap-px.
import type { Persona360PageProps } from '../../lib/persona360Types';
import { PERSONA360_FIXTURE } from '../../fixtures/persona360Fixture';
import { TrustStrip } from './TrustStrip';
import { PersonaHeader } from './PersonaHeader';
import { PersonaColumn } from './PersonaColumn';
import { SourcingColumn } from './SourcingColumn';
import { RiskColumn } from './RiskColumn';
import { InternetColumn } from './InternetColumn';
import { EngagementBand } from './EngagementBand';

export default function Persona360Page({ data: propData, mode = 'fixture', onRetry }: Persona360PageProps) {
  const data = propData ?? PERSONA360_FIXTURE;
  const glid = data.glid;
  return (
    <div className="min-h-screen bg-[#E9EAEC] dark:bg-[#0F172A]" data-persona360="1">
      <div className="flex flex-col gap-px">
        <TrustStrip score={data.trust.score} max={data.trust.max} mode={mode} />
        <PersonaHeader data={data} />
        <div className="grid grid-cols-1 gap-px md:grid-cols-2 xl:grid-cols-4">
          <PersonaColumn persona={data.persona} onRetry={onRetry} />
          <SourcingColumn sourcing={data.sourcing} onRetry={onRetry} />
          <RiskColumn risk={data.risk} onRetry={onRetry} />
          <InternetColumn internet={data.internet} mode={mode} onRetry={onRetry} />
        </div>
        <EngagementBand engagement={data.engagement} mode={mode} />
      </div>
      {/* glid read for future live fetch: buyer-intelligence webhook targets this glid */}
      <span className="hidden" aria-hidden="true" data-persona360-glid={glid} />
    </div>
  );
}