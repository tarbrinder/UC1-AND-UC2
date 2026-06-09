import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { imageBase64, mimeType = 'image/jpeg', currentProduct = '', isqFieldNames = [], isqFieldOptions = {} } = await req.json();
    const llmKey = Deno.env.get('LLM_key_indiamart') ?? '';

    const hasFields = isqFieldNames.length > 0;
    const prompt = hasFields
      ? `Analyze this product image for a B2B procurement form.
Product context: ${currentProduct || 'unknown'}
Specification fields to fill: ${JSON.stringify(isqFieldNames)}
Field options: ${JSON.stringify(isqFieldOptions)}

Return JSON:
{
  "productName": "identified product name",
  "specifications": { "FieldName": "value matching available options" },
  "additionalSpecifications": { "other visible spec": "value" },
  "quantity": "if visible",
  "additionalDetails": "other relevant details",
  "success": true
}`
      : `Analyze this product image for B2B procurement.
Return JSON:
{
  "productName": "product name",
  "specifications": { "spec": "value" },
  "additionalSpecifications": {},
  "quantity": null,
  "additionalDetails": "visible details",
  "success": true
}`;

    const llmRes = await fetch('https://imllm.intermesh.net/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${llmKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: 'text', text: prompt },
          ],
        }],
        response_format: { type: 'json_object' },
        max_tokens: 512,
      }),
    });

    const data = await llmRes.json();
    const content = data?.choices?.[0]?.message?.content ?? '{}';
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
