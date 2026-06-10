// Debug flag — STICKY within the tab. `?debug` / `?debug=1` turns it on and REMEMBERS it across
// reloads (the Vite dep-reopt reload kept stripping the query string, which hid the debug GLID CTA
// + the debug panels). `?debug=0` turns it off. A fresh tab/window starts clean — good for demos.
export function isDebug(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.has('debug')) {
      const on = p.get('debug') !== '0' && p.get('debug') !== 'false';
      sessionStorage.setItem('rfq_debug', on ? '1' : '0');
      return on;
    }
    return sessionStorage.getItem('rfq_debug') === '1';
  } catch {
    return new URLSearchParams(window.location.search).has('debug');
  }
}
