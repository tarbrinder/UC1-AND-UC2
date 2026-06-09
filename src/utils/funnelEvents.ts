// Funnel events stored locally — no database needed
const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);

export async function logFunnelEvent(
  formVariant: string,
  eventName: string,
  payload?: {
    step?: string;
    product?: string;
    score?: number;
    metadata?: Record<string, unknown>;
  }
) {
  try {
    const key = 'rfq_funnel_events';
    const events = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];
    events.push({
      session_id: sessionId,
      form_variant: formVariant,
      event_name: eventName,
      step: payload?.step ?? null,
      product: payload?.product ?? null,
      score: payload?.score ?? null,
      metadata: payload?.metadata ?? {},
      created_at: new Date().toISOString(),
    });
    // keep last 200 events only
    if (events.length > 200) events.splice(0, events.length - 200);
    localStorage.setItem(key, JSON.stringify(events));
  } catch {
    // non-critical
  }
}
