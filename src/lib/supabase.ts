// No database needed — submissions are stored in localStorage
// and OTP is verified locally (demo: always "1234")

export const localDB = {
  saveSubmission(data: Record<string, unknown>) {
    const key = 'rfq_submissions';
    const existing = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];
    existing.push({ ...data, id: crypto.randomUUID(), created_at: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(existing));
  },
  getSubmissions(): unknown[] {
    return JSON.parse(localStorage.getItem('rfq_submissions') ?? '[]');
  },
  saveContact(mobile: string, name: string) {
    const contacts = JSON.parse(localStorage.getItem('verified_contacts') ?? '{}') as Record<string, string>;
    contacts[mobile] = name;
    localStorage.setItem('verified_contacts', JSON.stringify(contacts));
  },
  getContact(mobile: string): string | null {
    const contacts = JSON.parse(localStorage.getItem('verified_contacts') ?? '{}') as Record<string, string>;
    return contacts[mobile] ?? null;
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
