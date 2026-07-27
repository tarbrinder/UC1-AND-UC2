// No database needed — submissions are stored in localStorage
// and OTP is verified locally (demo: always "1234")

// Every method is try/guarded so a blocked/quota-exceeded/private-mode localStorage or a corrupt JSON value can
// NEVER throw into a caller (fixes P1-117: an unguarded throw here dead-locked OTP verification forever). Reads
// return safe defaults; writes are best-effort no-ops on failure.
export const localDB = {
  saveSubmission(data: Record<string, unknown>) {
    try {
      const key = 'rfq_submissions';
      const existing = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];
      existing.push({ ...data, id: crypto.randomUUID(), created_at: new Date().toISOString() });
      localStorage.setItem(key, JSON.stringify(existing));
    } catch { /* storage blocked/full — non-critical */ }
  },
  getSubmissions(): unknown[] {
    try { return JSON.parse(localStorage.getItem('rfq_submissions') ?? '[]'); } catch { return []; }
  },
  saveContact(mobile: string, name: string) {
    try {
      const contacts = JSON.parse(localStorage.getItem('verified_contacts') ?? '{}') as Record<string, string>;
      contacts[mobile] = name;
      localStorage.setItem('verified_contacts', JSON.stringify(contacts));
    } catch { /* storage blocked/full — non-critical */ }
  },
  getContact(mobile: string): string | null {
    try {
      const contacts = JSON.parse(localStorage.getItem('verified_contacts') ?? '{}') as Record<string, string>;
      return contacts[mobile] ?? null;
    } catch { return null; }
  },
};

// Stub for code that still references supabase.functions.invoke — returns empty success
export const supabase = {
  functions: {
    invoke: async (_name: string, _opts?: unknown) => ({ data: null, error: null }),
  },
  from: (_table: string) => ({
    insert: async (_row: unknown) => ({ error: null }),
  }),
};
