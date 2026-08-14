// ─── Dynamic RFQ — the dumb renderer ──────────────────────────────────────────
// Renders a PlannerEnvelope's questions. Switches ONLY on `ui`. No logic, no fetches.
import type { Question } from '../../lib/rfq/contracts';

export default function QuestionRenderer({ questions, values, onChange }: {
  questions: Question[];
  values: Record<string, string>;
  onChange: (field: string, value: string) => void;
}) {
  const sorted = [...questions].sort((a, b) => a.order - b.order);
  return (
    <div className="space-y-5">
      {sorted.map((q) => {
        const current = values[q.field] ?? q.value ?? '';
        return (
          <div key={q.field}>
            <div className="mb-1.5 flex items-center gap-1.5">
              <p className="text-[14px] font-medium text-gray-900">{q.label}</p>
              {q.ui === 'prefill' && <span className="rounded bg-teal-50 px-1.5 text-[10px] font-semibold text-teal-700">prefilled</span>}
              {q.ui === 'confirm' && <span className="rounded bg-amber-50 px-1.5 text-[10px] font-semibold text-amber-700">confirm</span>}
            </div>
            {q.options?.length ? (
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt) => {
                  const on = current === opt;
                  return (
                    <button key={opt} type="button" onClick={() => onChange(q.field, on ? '' : opt)}
                      className={`rounded-full border px-3 py-1.5 text-[13px] transition-colors ${on ? 'border-teal-600 bg-teal-600 text-white' : 'border-gray-300 text-gray-700 hover:border-teal-400'}`}>
                      {opt}
                    </button>
                  );
                })}
              </div>
            ) : (
              <input value={current} onChange={(e) => onChange(q.field, e.target.value)}
                placeholder="Type your answer"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[14px] focus:border-teal-500 focus:outline-none" />
            )}
            {q.ui === 'suggest' && q.suggestion && q.suggestion !== current && (
              <button type="button" onClick={() => onChange(q.field, q.suggestion!)}
                className="mt-1.5 text-[12px] text-teal-700 hover:underline">✦ Suggestion: {q.suggestion} — use it</button>
            )}
          </div>
        );
      })}
      {!sorted.length && <p className="text-[13px] text-gray-400">No questions for this step.</p>}
    </div>
  );
}
