declare global {
  interface Window { gtag?: (...args: unknown[]) => void; }
}

export function trackEvent(eventName: string, params?: Record<string, unknown>) {
  window.gtag?.('event', eventName, params);
}

export const EVENTS = {
  RFQ_STARTED: 'rfq_started',
  MCAT_RESOLVED: 'mcat_resolved',
  STEP_ADVANCED: 'rfq_step_advanced',
  VOICE_STARTED: 'voice_recording_started',
  VOICE_APPLIED: 'voice_fields_applied',
  IMAGE_ANALYZED: 'image_analyzed',
  RFQ_SUBMITTED: 'rfq_submitted',
  OTP_SENT: 'otp_sent',
  OTP_VERIFIED: 'otp_verified',
};
