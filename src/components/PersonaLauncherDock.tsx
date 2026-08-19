// Persona360 — main-screen launcher dock (K-5 task 9 deliverable A).
// A self-contained fixed-position widget ('Buyer Persona 360' label + numeric-GLID input +
// open button) that navigates to ?persona360=1&glid=<value>. Rendered alongside the main
// dashboard by App.tsx (the ONLY existing-file mount point; this file is new and standalone).
// It never intercepts globals, routes, or other UI — just an input + a link.
import { useState } from 'react';
import { Radar } from 'lucide-react';

const OPEN_PARAM = 'persona360';

export default function PersonaLauncherDock() {
  const [glid, setGlid] = useState('');

  const open = () => {
    const q = glid.trim();
    const params = new URLSearchParams(window.location.search);
    params.set(OPEN_PARAM, '1');
    if (q) params.set('glid', q);
    else params.delete('glid');
    // Preserve any other live params, then navigate to the persona360 route.
    window.location.href = `${window.location.pathname}?${params.toString()}`;
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') open();
  };

  return (
    <div
      className="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-xl border border-gray-200 bg-white/95 p-3 shadow-lg backdrop-blur-sm"
      data-persona360-dock="1"
    >
      <div className="flex flex-col">
        <span className="flex items-center gap-1 text-[11px] font-bold text-gray-800">
          <Radar className="h-3.5 w-3.5 text-teal-600" />
          Buyer Persona 360
        </span>
        <input
          value={glid}
          onChange={(e) => setGlid(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={onKey}
          inputMode="numeric"
          placeholder="GLID"
          className="mt-1 w-40 rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm outline-none focus:border-teal-400"
          aria-label="Buyer Persona GLID"
        />
      </div>
      <button
        type="button"
        onClick={open}
        className="inline-flex items-center rounded-lg bg-teal-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700"
      >
        Open
      </button>
    </div>
  );
}

// re-exported so App.tsx can mount it and the gate story stays colocated
export { OPEN_PARAM };
