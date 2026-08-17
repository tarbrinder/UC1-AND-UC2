import { useState, useRef } from 'react';

interface Props {
  options: string[];
  value: string;
  onChange: (val: string) => void;
  className?: string;
  ariaLabel?: string; // accessible name for the group (P2-230/255) — pass the spec/question label
}

const OPT_LIMIT = 8; // beyond this, collapse behind a "+N more" chip so a big option set doesn't wall the page

export default function OptionChips({ options, value, onChange, className = '', ariaLabel = 'Options' }: Props) {
  const [customMode, setCustomMode] = useState(false);
  const [customVal, setCustomVal] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [poppingKey, setPoppingKey] = useState<string | null>(null);
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevValueRef = useRef(''); // the value before "Other…" opened — restored if the buyer abandons it (P2-220)

  const isCustomSelected = value !== '' && !options.includes(value);
  // Collapse a long option set to the first OPT_LIMIT + a "+N more" chip; but always keep a SELECTED chip visible
  // even if it lives in the hidden tail (so the buyer's choice never disappears behind "+N more").
  const collapsed = options.length > OPT_LIMIT && !expanded;
  const head = options.slice(0, OPT_LIMIT);
  const visibleOptions = collapsed
    ? (value && options.includes(value) && !head.includes(value) ? [...head, value] : head)
    : options;
  const hiddenCount = options.length - head.length;

  function triggerPop(key: string) {
    setPoppingKey(key);
    if (popTimerRef.current) clearTimeout(popTimerRef.current);
    popTimerRef.current = setTimeout(() => setPoppingKey(null), 250);
  }

  function selectOption(opt: string) {
    triggerPop(opt);
    setCustomMode(false);
    setCustomVal('');
    onChange(value === opt ? '' : opt); // P2-219: tapping the already-selected chip clears it (toggle-off), matching RadioChip
  }

  function openCustom() {
    prevValueRef.current = value; // remember what was selected so an abandoned custom entry restores it (P2-220)
    setCustomMode(true);
    setCustomVal(isCustomSelected ? value : '');
  }

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`flex flex-wrap gap-2 ${className}`}>
      {visibleOptions.map(opt => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={value === opt && !customMode}
          onClick={() => selectOption(opt)}
          className={[
            'px-3.5 py-2.5 min-h-[40px] rounded-full text-[13px] font-medium border transition-all',
            poppingKey === opt ? 'animate-chip-pop' : '',
            value === opt && !customMode
              ? 'bg-teal-700 text-white border-teal-700 shadow-sm'
              : 'bg-white text-gray-600 border-gray-200 hover:border-teal-300 hover:text-teal-700',
          ].join(' ')}
        >
          {opt}
        </button>
      ))}

      {collapsed && (
        <button type="button" onClick={() => setExpanded(true)} className="px-3.5 py-2.5 min-h-[40px] rounded-full text-[13px] font-medium border border-gray-200 bg-gray-50 text-gray-500 hover:border-teal-300 hover:text-teal-600 transition-all">
          +{hiddenCount} more
        </button>
      )}

      {!customMode && (
        <button
          type="button"
          aria-label="Enter a custom value"
          aria-checked={isCustomSelected}
          role="radio"
          onClick={openCustom}
          className={[
            'px-3.5 py-2.5 min-h-[40px] rounded-full text-[13px] font-medium border transition-all',
            isCustomSelected
              ? 'bg-teal-700 text-white border-teal-700'
              : 'bg-white text-gray-500 border-gray-200 border-dashed hover:border-teal-300 hover:text-teal-600',
          ].join(' ')}
        >
          {isCustomSelected ? value : 'Other...'}
        </button>
      )}

      {customMode && (
        <input
          autoFocus
          type="text"
          aria-label={`${ariaLabel} — custom value`}
          value={customVal}
          onChange={e => {
            setCustomVal(e.target.value);
            onChange(e.target.value);
          }}
          onBlur={() => {
            // Abandoned (typed nothing) → restore the prior selection instead of wiping it (P2-220).
            if (!customVal.trim()) {
              setCustomMode(false);
              onChange(prevValueRef.current);
            }
          }}
          placeholder="Type your answer…"
          // focus ring was teal-100 — a 1.26:1 contrast against white, i.e. an effectively INVISIBLE keyboard focus
          // indicator on the custom-value input (design audit 2026-07-28). teal-500 reads at a glance.
          className="px-3.5 py-2.5 min-h-[40px] rounded-full text-[13px] border border-teal-400 bg-white outline-none focus:ring-2 focus:ring-teal-500 w-44 max-w-full text-gray-700 placeholder:text-gray-400"
        />
      )}
    </div>
  );
}
