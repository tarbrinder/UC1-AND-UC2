// Debug flag — STICKY within the tab. `?debug` / `?debug=1` turns it on and REMEMBERS it across
// reloads (the Vite dep-reopt reload kept stripping the query string, which hid the debug GLID CTA
// + the debug panels). `?debug=0` turns it off (anywhere, and is remembered).
//
// DEFAULT (owner 2026-07-13): ON in LOCAL DEV (`npm run dev`, import.meta.env.DEV) so a fresh repo pull just works —
// you never have to type ?debug=1 in the URL. OFF in a PRODUCTION build (webERP deploy + the offline download shell)
// so end-users always get the clean buyer-facing card. `?debug=0` still forces it off in dev when you want the clean view.
export function isDebug(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.has('debug')) {
      const on = p.get('debug') !== '0' && p.get('debug') !== 'false';
      sessionStorage.setItem('rfq_debug', on ? '1' : '0');
      return on;
    }
    const stored = sessionStorage.getItem('rfq_debug');
    if (stored != null) return stored === '1';                 // an explicit prior ?debug=0/1 wins
    return !!(import.meta.env && import.meta.env.DEV);          // fresh tab: dev = on, prod build = off
  } catch {
    return new URLSearchParams(window.location.search).has('debug');
  }
}
