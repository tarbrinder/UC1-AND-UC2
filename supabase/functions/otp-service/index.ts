import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { action, mobile, otp, name } = await req.json();

    if (action === 'send') {
      // In production: integrate real SMS provider. For demo, use hardcoded "1234"
      const otpCode = '1234';
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await supabase.from('otp_verifications').upsert({
        mobile, otp_code: otpCode, expires_at: expiresAt, verified: false,
      }, { onConflict: 'mobile' });
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'verify') {
      const { data: record } = await supabase
        .from('otp_verifications')
        .select('*')
        .eq('mobile', mobile)
        .eq('otp_code', otp)
        .gt('expires_at', new Date().toISOString())
        .eq('verified', false)
        .single();

      if (!record) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid or expired OTP' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      await supabase.from('otp_verifications').update({ verified: true }).eq('id', record.id);

      // Upsert verified contact
      const { data: existing } = await supabase
        .from('verified_contacts')
        .select('name')
        .eq('mobile', mobile)
        .single();

      if (!existing) {
        await supabase.from('verified_contacts').insert({ mobile, name: name ?? null });
      }

      return new Response(JSON.stringify({
        success: true,
        returningName: existing?.name ?? null,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: false, error: 'Unknown action' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    });
  }
});
