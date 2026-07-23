type ErrorType = 'API_ERROR' | 'FALLBACK_USED' | 'VALIDATION_ERROR' | 'NETWORK_ERROR';

interface ErrorEntry {
  type: ErrorType;
  message: string;
  context?: string;
  ts: number;
}

const log: ErrorEntry[] = [];

export function captureError(type: ErrorType, message: string, context?: string) {
  if (log.length >= 100) log.shift();
  log.push({ type, message, context, ts: Date.now() });
  // DEV-only console — the in-memory ring above is what the debug panel/getErrorLog consume; don't leak
  // component stacks / filenames to every production buyer's console (audit).
  if (import.meta.env.DEV) console.warn(`[${type}]`, message, context ?? '');
}

export function getErrorLog(): ErrorEntry[] {
  return [...log];
}
