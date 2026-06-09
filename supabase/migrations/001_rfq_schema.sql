-- RFQ Submissions
CREATE TABLE IF NOT EXISTS rfq_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL,
  contact_name text NOT NULL,
  contact_email text,
  contact_mobile text,
  buyer_type text,
  company_name text,
  company_size text,
  gst_registered boolean,
  gst_number text,
  industry text,
  quantity text,
  unit text,
  delivery_location text,
  delivery_timeline text,
  payment_terms text,
  payment_mode text,
  requirement_frequency text,
  buyer_location text,
  mcat_id text,
  product_specifications text,
  additional_details text,
  rfq_score integer DEFAULT 0,
  voice_transcript text,
  voice_duration_seconds numeric,
  funnel_variant text DEFAULT 'quick-v3',
  created_at timestamptz DEFAULT now()
);

-- OTP Verifications
CREATE TABLE IF NOT EXISTS otp_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile text NOT NULL,
  otp_code text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  verified boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(mobile)
);

-- Verified Contacts
CREATE TABLE IF NOT EXISTS verified_contacts (
  mobile text PRIMARY KEY,
  name text,
  email text,
  last_location text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- RFQ Funnel Events
CREATE TABLE IF NOT EXISTS rfq_funnel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  form_variant text NOT NULL,
  event_name text NOT NULL,
  step text,
  product text,
  score integer,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Product Variant Cache
CREATE TABLE IF NOT EXISTS product_variant_cache (
  mcat_id text PRIMARY KEY,
  product_name text,
  variants_json jsonb,
  created_at timestamptz DEFAULT now()
);

-- RLS: allow anonymous inserts to rfq_submissions and rfq_funnel_events
ALTER TABLE rfq_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_funnel_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon insert rfq" ON rfq_submissions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon insert events" ON rfq_funnel_events FOR INSERT TO anon WITH CHECK (true);
