import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { audioBase64, mimeType = 'audio/webm', productName = '', isqSpecs = [] } = body;

    if (!audioBase64) {
      return new Response(JSON.stringify({ success: false, error: 'No audio provided' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
      });
    }

    const llmKey = Deno.env.get('LLM_key_indiamart') ?? '';

    const specNames = Array.isArray(isqSpecs)
      ? isqSpecs.map((s: { IM_SPEC_MASTER_DESC: string }) => s.IM_SPEC_MASTER_DESC).join(', ')
      : '';

    const systemPrompt = `You are a B2B procurement assistant. Extract structured procurement information from the audio.
${specNames ? `Known spec fields for ${productName || 'this product'}: ${specNames}` : ''}

Return ONLY valid JSON with these fields:
{
  "rawTranscript": "exact transcription",
  "productName": "product name or null",
  "quantity": "number as string or null",
  "quantityUnit": "unit (Pieces/KG/MT/etc) or null",
  "deliveryLocation": "city name or null",
  "deliveryTimeline": "one of: Immediate, Within 1 Week, Within 2 Weeks, Within 1 Month, Within 3 Months, Flexible — or null",
  "mappedSpecs": { "SpecFieldName": "value" },
  "customSpecs": [{ "fieldName": "name", "value": "value" }]
}
mappedSpecs keys must exactly match known spec fields. customSpecs is for specs not in the known fields list.`;

    const llmRes = await fetch('https://imllm.intermesh.net/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${llmKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: audioBase64, format: mimeType.includes('mp4') ? 'mp4' : 'wav' },
              },
              { type: 'text', text: 'Extract procurement details from this audio.' },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1024,
      }),
    });

    const llmData = await llmRes.json();
    const content = llmData?.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content);

    return new Response(JSON.stringify({ ...parsed, success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    });
  }
});
