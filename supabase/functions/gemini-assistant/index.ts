import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { product, isqSpecNames = [], isqSpecsWithOptions = {}, noOptionSpecs = [], additionalDetails = '', mode = 'quick' } = await req.json();
    const llmKey = Deno.env.get('LLM_key_indiamart') ?? '';

    const prompt = `You are a B2B product specification expert for IndiaMART.

Product: "${product}"
${additionalDetails ? `Additional context: ${additionalDetails}` : ''}

ISQ specification fields: ${JSON.stringify(isqSpecNames)}
Specs with options: ${JSON.stringify(isqSpecsWithOptions)}
Free-text specs: ${JSON.stringify(noOptionSpecs)}

Respond ONLY with valid JSON:
{
  "knownFromProductName": { "SpecName": "value inferred from product name" },
  "redundantISQSpecs": ["spec names that are redundant or not applicable for this product"],
  "isqHints": { "SpecName": "helpful hint for buyer, e.g. 'Common: 10 kVA, 15 kVA, 25 kVA'" },
  "success": true
}

Rules:
- knownFromProductName: only when product name clearly implies a spec value (e.g. "Diesel Generator" → Fuel Type: Diesel)
- redundantISQSpecs: specs that don't apply or are already captured by product name
- isqHints: short helpful suggestions for remaining specs, max 8 words each
- mode "${mode}": ${mode === 'quick' ? 'return top 5 hints only' : 'return comprehensive analysis'}`;

    const llmRes = await fetch('https://imllm.intermesh.net/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${llmKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash',
        messages: [{ role: 'user', content: prompt }],
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
