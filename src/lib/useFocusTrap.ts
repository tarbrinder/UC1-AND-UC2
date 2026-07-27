import { useEffect, type RefObject } from 'react';

// Minimal, defensive focus-trap for modal overlays (P2-213/228/254). While `active`, it:
//   • moves focus into the container (first focusable) on open,
//   • cycles Tab / Shift+Tab within the container (so keyboard/AT users can't tab out to the page behind),
//   • restores focus to the previously-focused element on close.
// It is intentionally forgiving — every step guards for missing nodes so it can never throw and trap the UI.
export function useFocusTrap(active: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const prevFocus = document.activeElement as HTMLElement | null;

    const SEL =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const focusables = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(SEL)).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Initial focus — only steal focus if it isn't already inside the modal.
    if (!node.contains(document.activeElement)) {
      const first = focusables()[0];
      if (first) setTimeout(() => first.focus(), 0);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const firstEl = f[0];
      const lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    };
  }, [active, ref]);
}
