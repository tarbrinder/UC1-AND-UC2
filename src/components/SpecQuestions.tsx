import { Sparkles } from 'lucide-react';
import type { ISQSpec, AIMissingSpec } from '../types';
import type { SpecSource } from '../types';
import OptionChips from './OptionChips';

interface Props {
  isqSpecs: ISQSpec[];
  aiMissingSpecs: AIMissingSpec[];
  redundantISQSpecs: string[];
  isqHints: Record<string, string>;
  knownFromProductName: Record<string, string>;
  values: Record<string, string>;
  onChange: (key: string, val: string) => void;
  specSourceMap: Record<string, SpecSource>;
  pageIndex: number;
  loading: boolean;
  productName: string;
}

function SourceBadge({ source }: { source: SpecSource }) {
  if (source === 'user') return null;
  const cfg: Record<Exclude<SpecSource, 'user'>, { cls: string; label: string }> = {
    photo:          { cls: 'bg-teal-50 text-teal-700 border border-teal-200',   label: '📷 From photo' },
    'product-name': { cls: 'bg-indigo-50 text-indigo-700 border border-indigo-200', label: '✦ Detected' },
    voice:          { cls: 'bg-purple-50 text-purple-700 border border-purple-200', label: '🎙 From voice' },
    variant:        { cls: 'bg-orange-50 text-orange-700 border border-orange-200', label: '⬡ From variant' },
  };
  const c = cfg[source as Exclude<SpecSource, 'user'>];
  if (!c) return null;
  return (
    <span className={`ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${c.cls}`}>
      {c.label}
    </span>
  );
}

function Shimmer() {
  return (
    <div className="space-y-5">
      {[0, 1, 2, 3].map(i => (
        <div key={i} className="space-y-2 animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/3" />
          <div className="h-10 bg-gray-100 rounded-xl w-full" />
        </div>
      ))}
    </div>
  );
}

export default function SpecQuestions({
  isqSpecs,
  aiMissingSpecs,
  redundantISQSpecs,
  isqHints,
  knownFromProductName,
  values,
  onChange,
  specSourceMap,
  pageIndex,
  loading,
}: Props) {
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-teal-600 text-sm font-medium">
          <Sparkles className="w-4 h-4 animate-pulse" />
          <span>AI filling specs...</span>
        </div>
        <Shimmer />
      </div>
    );
  }

  const redundantLower = redundantISQSpecs.map(s => s.toLowerCase());
  const visibleISQ = isqSpecs.filter(
    s => !redundantLower.includes(s.IM_SPEC_MASTER_DESC.toLowerCase()),
  );

  const displayedISQ =
    pageIndex === 0 ? visibleISQ.slice(0, 3) : visibleISQ.slice(3);

  // showWhen / hideWhen visibility for aiMissingSpecs
  function isAIVisible(spec: AIMissingSpec): boolean {
    if (spec.showWhen) {
      const cur = values[spec.showWhen.spec] ?? '';
      if (!spec.showWhen.values.includes(cur)) return false;
    }
    if (spec.hideWhen) {
      const cur = values[spec.hideWhen.spec] ?? '';
      if (spec.hideWhen.values.includes(cur)) return false;
    }
    return true;
  }

  const visibleAI = aiMissingSpecs.filter(isAIVisible);

  return (
    <div className="space-y-5">
      {displayedISQ.map(spec => {
        const name = spec.IM_SPEC_MASTER_DESC;
        const key = name;
        const val = values[key] ?? '';
        const hint = isqHints[name] ?? '';
        const detected = knownFromProductName[name];
        const source = specSourceMap[key];
        const isSelect =
          spec.IM_SPEC_MASTER_TYPE === '3' && spec.IM_SPEC_OPTIONS_DESC;
        const options = isSelect
          ? spec.IM_SPEC_OPTIONS_DESC.split('##').map(o => o.trim()).filter(Boolean)
          : [];

        return (
          <div key={key} className="space-y-1.5">
            <label className="flex items-center text-sm font-medium text-gray-700">
              {name}
              {detected && !val && (
                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-teal-50 text-teal-700 border border-teal-200">
                  Detected
                </span>
              )}
              {source && source !== 'user' && <SourceBadge source={source} />}
            </label>

            {isSelect && options.length > 0 ? (
              <OptionChips options={options} value={val} onChange={v => onChange(key, v)} />
            ) : (
              <input
                type="text"
                value={val}
                onChange={e => onChange(key, e.target.value)}
                placeholder={hint || `Enter ${name.toLowerCase()}`}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 transition"
              />
            )}

            {hint && !val && (
              <p className="text-[11px] text-gray-400 ml-1">{hint}</p>
            )}
          </div>
        );
      })}

      {pageIndex === 1 && visibleAI.length > 0 && (
        <>
          <div className="flex items-center gap-2 pt-2">
            <div className="flex-1 h-px bg-gray-100" />
            <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> AI Suggested
            </span>
            <div className="flex-1 h-px bg-gray-100" />
          </div>

          {visibleAI.map(spec => {
            const key = spec.fieldName;
            const val = values[key] ?? '';
            const source = specSourceMap[key];

            return (
              <div key={key} className="space-y-1.5">
                <label className="flex items-center text-sm font-medium text-gray-700">
                  {spec.fieldName}
                  {source && source !== 'user' && <SourceBadge source={source} />}
                </label>

                {(spec.inputType === 'radio' || spec.inputType === 'chips' || spec.inputType === 'chips-with-text') &&
                  spec.options && spec.options.length > 0 ? (
                  <OptionChips
                    options={spec.options}
                    value={val}
                    onChange={v => onChange(key, v)}
                  />
                ) : spec.inputType === 'dropdown' && spec.options && spec.options.length > 0 ? (
                  <select
                    value={val}
                    onChange={e => onChange(key, e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 transition"
                  >
                    <option value="">Select…</option>
                    {spec.options.map(o => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={val}
                    onChange={e => onChange(key, e.target.value)}
                    placeholder={spec.helperText || `Enter ${spec.fieldName.toLowerCase()}`}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 transition"
                  />
                )}

                {spec.helperText && !val && (
                  <p className="text-[11px] text-gray-400 ml-1">{spec.helperText}</p>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
