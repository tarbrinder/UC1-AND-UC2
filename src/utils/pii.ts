// Strip personally-identifiable contact info from buyer free-text before it is
// shown to / sent to suppliers. IndiaMART sells the verified buyer contact as a
// lead, so the enquiry body must NOT leak phone/email/links — otherwise a seller
// gets the contact for free without purchasing the requirement.
export function stripPII(text: string): string {
  if (!text) return text;
  let t = text;

  // Emails
  t = t.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[contact hidden]');

  // URLs / social handles
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link hidden]');

  // Phone-like sequences: any run that resolves to 10+ digits (handles
  // "+91 98765 43210", "9876543210", "98765-43210"). Short numbers like
  // "20 kVA", "415 V", "12 mm", "500 pieces" are untouched.
  t = t.replace(/\+?\d[\d\s().-]{8,}\d/g, (m) =>
    m.replace(/\D/g, '').length >= 10 ? '[contact hidden]' : m
  );

  // Common "call/whatsapp me" lead-ins left dangling after number removal
  t = t.replace(/\b(call|whatsapp|contact|ping|reach)\s+me\s*(at|on)?\s*/gi, '');

  return t.replace(/\s{2,}/g, ' ').trim();
}
