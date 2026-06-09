import { useState, useRef } from 'react';

interface Props {
  options: string[];
  value: string;
  onChange: (val: string) => void;
  className?: string;
}

export default function OptionChips({ options, value, onChange, className = '' }: Props) {
  const [customMode, setCustomMode] = useState(false);
  const [customVal, setCustomVal] = useState('');
  const [poppingKey, setPoppingKey] = useState<string | null>(null);
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCustomSelected = value !== '' && !options.includes(value);

  function triggerPop(key: string) {
    setPoppingKey(key);
    if (popTimerRef.current) clearTimeout(popTimerRef.current);
    popTimerRef.current = setTimeout(() => setPoppingKey(null), 250);
  }

  function selectOption(opt: string) {
    triggerPop(opt);
    setCustomMode(false);
    setCustomVal('');
    onChange(opt);
  }

  function openCustom() {
    setCustomMode(true);
    setCustomVal(isCustomSelected ? value : '');
  }

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => selectOption(opt)}
          className={[
            'px-3 py-1.5 rounded-full text-sm font-medium border transition-all',
            poppingKey === opt ? 'animate-chip-pop' : '',
            value === opt && !customMode
              ? 'bg-teal-600 text-white border-teal-600 shadow-sm'
              : 'bg-white text-gray-600 border-gray-200 hover:border-teal-300 hover:text-teal-700',
          ].join(' ')}
        >
          {opt}
        </button>
      ))}

      {!customMode && (
        <button
          type="button"
          onClick={openCustom}
          className={[
            'px-3 py-1.5 rounded-full text-sm font-medium border transition-all',
            isCustomSelected
              ? 'bg-teal-600 text-white border-teal-600'
              : 'bg-white text-gray-400 border-gray-200 border-dashed hover:border-teal-300 hover:text-teal-600',
          ].join(' ')}
        >
          {isCustomSelected ? value : 'Other...'}
        </button>
      )}

      {customMode && (
        <input
          autoFocus
          type="text"
          value={customVal}
          onChange={e => {
            setCustomVal(e.target.value);
            onChange(e.target.value);
          }}
          onBlur={() => {
            if (!customVal.trim()) {
              setCustomMode(false);
              onChange('');
            }
          }}
          placeholder="Type here..."
          className="px-3 py-1.5 rounded-full text-sm border border-teal-400 outline-none focus:ring-2 focus:ring-teal-100 w-36 text-gray-700"
        />
      )}
    </div>
  );
}
