// Deterministic test for the LLM-native Buyer-Profile extractor (mirrors src/lib/buyerProfileExtract.ts +
// enrichment.normalizeNewUserInsights). Proves: bundleFromResponse flattens the REAL bi-user-insights response into
// citable fN evidence with per-source coverage (silent-fact-loss guard); extractedToFinals maps an LLM output →
// FinalAttr with correct grounded flags + derived state; ungrounded citations are caught; the new→legacy adapter
// reshapes (and old-shape passthrough is identity). NO LLM, NO fetch. Runs against /tmp/biui_v4_resp.json if present,
// else a synthetic new-shape fixture. `node scripts/extracttest.mjs`.
import fs from 'fs';

// ── mirror: bundleFromResponse ──
const SRC_LABEL = { csl:'CSL · on-site behaviour', pns:'PNS · sales calls (spoken)', rfq:'Previous BuyLeads', isq:'Previous ISQ specs', whatsapp_conversations:'WhatsApp (buyer messages = signal · ours = context)', whatsapp_inbound:'WhatsApp inbound', profile:'Profile (identity)', usersince:'GLUSR (tenure)', befisc:'Befisc (observed external)', sign3:'Sign3 (observed external)', requirement:'Requirement · BuyLeads ⨝ ISQ specs (one per offer, category-named)', whatsapp:'WhatsApp · one timeline (buyer = signal · ours = context)' };
const SKIP_KEY = /^(observed_only|txn_id|api_category|api_name|billable|datetime|message|parse_ok|parse_error|status|fetched_at|glid|csl_activity)$/i;
function flattenInto(node, src, path, push){
  if(node==null||node===''||node===false) return;
  if(Array.isArray(node)){ node.forEach((el,i)=>{ if(el&&typeof el==='object') flattenInto(el,src,path?`${path}[${i}]`:`[${i}]`,push); else if(el!=null&&el!=='') push(src,path||'item',el); }); return; }
  if(typeof node==='object'){ for(const [k,v] of Object.entries(node)){ if(SKIP_KEY.test(k)) continue; flattenInto(v,src,path?`${path}.${k}`:k,push); } return; }
  push(src,path||'value',node);
}
function bundleFromResponse(resp){
  const sources=(resp&&typeof resp==='object'&&resp.sources&&typeof resp.sources==='object')?resp.sources:{};
  const evidence=[]; const perSource={}; let n=0;
  const push=(src,tag,raw)=>{ const v=typeof raw==='object'?JSON.stringify(raw):String(raw); if(!v||v==='-'||v==='null'||v==='undefined') return; evidence.push({evidence_id:`f${++n}`,node:SRC_LABEL[src]||src,tag,raw:v.length>220?v.slice(0,220)+'…':v,role:'available'}); perSource[src]=(perSource[src]||0)+1; };
  if(resp.derived_anchors&&typeof resp.derived_anchors==='object') flattenInto(resp.derived_anchors,'profile','anchor',push);
  const superseded=new Set(); if(sources.requirement){superseded.add('rfq');superseded.add('isq');} if(sources.whatsapp){superseded.add('whatsapp_conversations');superseded.add('whatsapp_inbound');}
  for(const [src,val] of Object.entries(sources)){ if(superseded.has(src)) continue; const summary=(val&&typeof val==='object'&&'summary' in val)?val.summary:val; flattenInto(summary,src,'',push); }
  return { evidence, perSource };
}
// ── mirror: extractedToFinals + deriveState ──
function deriveState(value,confidence,grounded,hasRejected){ const v=String(value||'').trim(); if(!v||/^(unknown|—|-|n\/?a|none)$/i.test(v)) return 'Unknown'; if(hasRejected) return 'Conflicted'; if(grounded&&confidence>=70) return 'Confirmed'; if(grounded&&confidence>=50) return 'Likely'; return grounded?'Likely':'Unknown'; }
function extractedToFinals(out, evidenceIds){
  const attrs=(out&&Array.isArray(out.attributes))?out.attributes:[]; const finals=[];
  for(const la of attrs){ if(!la||!la.key) continue; const steps=la.reasoning_steps||[]; const cites=steps.flatMap(s=>s.from_evidence||[]); const grounded=cites.length>0&&cites.every(id=>evidenceIds.has(id)); const hasRejected=steps.some(s=>!!s.rejected); const confidence=grounded?la.confidence:Math.min(la.confidence??0,30); const state=(la.state&&['Confirmed','Likely','Conflicted','Unknown'].includes(la.state))?la.state:deriveState(la.value,confidence,grounded,hasRejected); finals.push({ key:la.key, value:la.value, confidence, provenance:'llm-confirmed', state, llm:{ value:la.value, confidence, reasoning:steps.map(s=>({claim:s.claim,evidence:s.from_evidence||[],rejected:s.rejected})), grounded } }); }
  return finals;
}
// ── mirror: normalizeNewUserInsights (v7 — UNWRAPS pns/bl/wa inner arrays + reshapes isq, else deriveEnrichment throws) ──
function isNew(raw){ return !!raw&&typeof raw==='object'&&!Array.isArray(raw)&&'sources' in raw&&typeof raw.sources==='object'; }
const _o=v=>(v&&typeof v==='object'&&!Array.isArray(v))?v:{};
const _a=v=>Array.isArray(v)?v:[];
function normalize(raw){ if(!isNew(raw)) return { legacy:raw, anchors:null }; const s=raw.sources;
  const rawOf=k=>{ const v=s[k]; return v&&typeof v==='object'&&'raw' in v?v.raw:v; };
  const sumOf=k=>{ const v=s[k]; return v&&typeof v==='object'&&'summary' in v?v.summary:undefined; };
  const isqLegacy=_a(_o(sumOf('isq')).isq_offers).map(o=>{ const oo=_o(o); return { title:oo.category||oo.mcat_id, post_date:'', isq:_a(oo.specs).map(sp=>{ const t=String(sp); const i=t.indexOf(': '); return i>0?{IM_SPEC_MASTER_DESC:t.slice(0,i),ISQ_RESPONSE:t.slice(i+2)}:{IM_SPEC_MASTER_DESC:t,ISQ_RESPONSE:''}; }) }; });
  const usRaw=_o(rawOf('usersince'));
  const legacy=[{csl_data:rawOf('csl')},{pns_data:_a(_o(rawOf('pns')).data)},{buyer_profile:rawOf('profile')},{prev_bl_data:_a(_o(_o(_o(rawOf('rfq')).RESPONSE).DATA).Listing)},{prev_isq_data:isqLegacy},{whatsapp_data:_a(_o(_o(rawOf('whatsapp_conversations')).data).records)},{whatsapp_inbound:rawOf('whatsapp_inbound')},{befisc:rawOf('befisc')},{sign3:rawOf('sign3')},{glusr_extra:_o(usRaw.glusr_extra).glusr_usr_id?usRaw.glusr_extra:rawOf('usersince')}].filter(o=>{ const v=Object.values(o)[0]; return v!=null&&!(Array.isArray(v)&&v.length===0); }); return { legacy, anchors:(raw.derived_anchors&&typeof raw.derived_anchors==='object')?raw.derived_anchors:null }; }

// ── fixture: the REAL response if saved, else a synthetic one ──
let resp;
try { resp = JSON.parse(fs.readFileSync('/tmp/biui_v4_resp.json','utf8')); resp = Array.isArray(resp)?resp[0]:resp; } catch { resp = null; }
const SYNTH = { glid:1, derived_anchors:{ name:'Amit', city:'Noida', state:'UP' }, sources:{
  csl:{ summary:{ searched:['tafe tractor ×9'], viewed_products:['eicher tafe tractor ×13'], location:{city:'Noida',state:'UP'}, requirement:{raised_buylead:true} } },
  pns:{ summary:{ persona:null } },
  rfq:{ summary:{ buyleads:[{title:'Antique Teak Wood Doors',status:'Expired'}] } },
  profile:{ summary:{ name:'Amit Agarwal', company:'Personal', city:'Noida' } },
  usersince:{ summary:{ tenure_years:7.9, listing_status:'NFL' } },
  sign3:{ summary:{ observed_only:true, phone_operator:'Jio', phone_accounts:['LINKEDIN','FACEBOOK'] } },
} };
if(!resp || !resp.sources){ resp = SYNTH; }

let pass=0, fail=0; const ok=(n,c)=>{ if(c) pass++; else { fail++; console.log('  ✗ '+n); } };

// 1 · bundle from the real/synthetic response
const { evidence, perSource } = bundleFromResponse(resp);
const ids = new Set(evidence.map(e=>e.evidence_id));
ok('bundle produced evidence lines (fN)', evidence.length > 0 && /^f\d+$/.test(evidence[0].evidence_id));
ok('per-source coverage — ≥3 distinct sources contributed evidence (silent-fact-loss guard)', Object.keys(perSource).length >= 3);
ok('csl evidence carries the ×N frequency signal', evidence.some(e=>/×\d+/.test(e.raw)) || resp===SYNTH);
ok('no plumbing keys leaked as evidence (observed_only/txn_id/status)', !evidence.some(e=>/^(observed_only|txn_id|status|api_name)$/i.test(e.tag)));
ok('every evidence id is unique', ids.size === evidence.length);

// 1b · V10 supersede — when the n8n emits the MERGED sources, the LLM bundle uses them and SKIPS the legacy split feeds (no double-count)
{
  const v10 = { sources: {
    requirement: { summary: { titles:['Hero Bike Body Parts'], items:[{title:'Hero Bike Body Parts', category:'Two Wheeler Spare Parts', specs:{Color:'Blue'}}] } },
    rfq: { summary: { buyleads:[{title:'SHOULD-BE-SKIPPED-rfq'}] } },
    isq: { summary: { isq_offers:[{mcat_id:'99', specs:['SHOULD-BE-SKIPPED-isq: x']}] } },
    whatsapp: { summary: { timeline:[{side:'buyer', text:'merged WA turn'}] } },
    whatsapp_conversations: { summary: { buyer_messages:[{text:'SHOULD-BE-SKIPPED-waconv'}] } },
    whatsapp_inbound: { summary: { enquiries:[{product:'SHOULD-BE-SKIPPED-wainbound'}] } },
  } };
  const b = bundleFromResponse(v10);
  const raws = b.evidence.map(e => e.raw).join(' | ');
  ok('V10 supersede — merged requirement+whatsapp ARE in the bundle', /Hero Bike Body Parts/.test(raws) && /merged WA turn/.test(raws));
  ok('V10 supersede — legacy rfq/isq/wa_conv/wa_inbound are SKIPPED (no double-count)', !/SHOULD-BE-SKIPPED/.test(raws));
  ok('V10 supersede — fallback intact: legacy keys still feed when merged absent', (() => { const f = bundleFromResponse({ sources:{ rfq:{summary:{buyleads:[{title:'legacy-only'}]}} } }); return f.evidence.some(e=>/legacy-only/.test(e.raw)); })());
}

// 2 · extractedToFinals — grounded vs ungrounded + state derivation
const f1 = evidence[0].evidence_id, f2 = evidence[1] ? evidence[1].evidence_id : f1;
const mockOut = { attributes: [
  { key:'business_type', value:'Manufacturer', confidence:78, reasoning_steps:[{claim:'machine views', from_evidence:[f1,f2]}] },          // grounded → Confirmed
  { key:'price_vs_quality', value:'Price-oriented', confidence:55, reasoning_steps:[{claim:'weak', from_evidence:[f1]}] },                    // grounded mid → Likely
  { key:'urgency', value:'High', confidence:90, reasoning_steps:[{claim:'invented', from_evidence:['f9999']}] },                              // BAD id → ungrounded
  { key:'supplier_preference', value:'Manufacturer', confidence:72, reasoning_steps:[{claim:'a', from_evidence:[f1], rejected:'trader'}] },   // has rejected → Conflicted
] };
const finals = extractedToFinals(mockOut, ids);
const byKey = Object.fromEntries(finals.map(f=>[f.key,f]));
ok('4 finals mapped, each FinalAttr shape (key/value/confidence/provenance/llm)', finals.length===4 && finals.every(f=>f.key&&f.value&&f.provenance==='llm-confirmed'&&f.llm));
ok('grounded when all cited ids resolve', byKey.business_type.llm.grounded === true);
ok('UNGROUNDED when a cited id is invented (f9999)', byKey.urgency.llm.grounded === false);
ok('state: grounded ≥70 → Confirmed', byKey.business_type.state === 'Confirmed');
ok('state: grounded 50-69 → Likely', byKey.price_vs_quality.state === 'Likely');
ok('state: a rejected alternative → Conflicted', byKey.supplier_preference.state === 'Conflicted');
ok('state: ungrounded → not Confirmed', byKey.urgency.state !== 'Confirmed');
ok('HONESTY: ungrounded confidence floored ≤30 (90→30) so the pill is never misleadingly strong', byKey.urgency.confidence <= 30 && byKey.business_type.confidence === 78);
ok('reasoning carried for the per-attribute drill', byKey.business_type.llm.reasoning.length === 1 && byKey.business_type.llm.reasoning[0].evidence.length === 2);

// 3 · normalize adapter — new→legacy + anchors; old-shape identity
const norm = normalize(resp);
if(resp.sources){ ok('new shape → legacy array of singly-keyed objects', Array.isArray(norm.legacy) && norm.legacy.every(o=>Object.keys(o).length===1)); ok('derived_anchors captured', norm.anchors===null || typeof norm.anchors==='object'); }
const legacyIn = [{csl_data:'[{}]'},{pns_data:'[]'}];
const norm2 = normalize(legacyIn);
ok('OLD-shape (array) passes through unchanged (identity)', norm2.legacy === legacyIn && norm2.anchors === null);

// 3b · v7 UNWRAP — pns/bl/wa wrapper objects → inner arrays (the crash-fix); isq raw → {title, isq[]} reshape
const V7 = { derived_anchors:{ name:'Jaiveer', city:'Auraiya' }, sources:{
  pns:{ summary:{}, raw:{ Code:200, data:[ { file_id:1, extracted_data:{ metadata:{ call_type:{ evidence:{ buyer_persona:'Manufacturer' } } } } } ] } },
  rfq:{ summary:{}, raw:{ RESPONSE:{ DATA:{ Listing:[ { ETO_OFR_TITLE:'Notebook Making Machine', ETO_OFR_POSTDATE_ORIG:'25-MAY-26' } ] } } } },
  isq:{ summary:{ isq_offers:[ { mcat_id:'122454', specs:['Automation Grade: Semi-Automatic','Cutting Machine Size: 32 inch'] } ] } },
  whatsapp_conversations:{ summary:{}, raw:{ data:{ records:[ {eto_lead_attribute:'USER',eto_lead_attribute_detail:'{}'} ] } } },
  profile:{ summary:{}, raw:{ first_name:'Jaiveer', city:'Auraiya' } },
} };
const nv7 = normalize(V7);
const pick7 = k => { const e = nv7.legacy.find(o => k in o); return e ? e[k] : undefined; };
ok('v7 pns_data UNWRAPPED to the calls array (not the {Code,data} wrapper) — deriveEnrichment-iterable', Array.isArray(pick7('pns_data')) && pick7('pns_data')[0]?.extracted_data);
ok('v7 prev_bl_data UNWRAPPED to RESPONSE.DATA.Listing array', Array.isArray(pick7('prev_bl_data')) && pick7('prev_bl_data')[0]?.ETO_OFR_TITLE === 'Notebook Making Machine');
ok('v7 whatsapp_data UNWRAPPED to data.records array', Array.isArray(pick7('whatsapp_data')) && pick7('whatsapp_data').length === 1);
ok('v7 prev_isq_data RESHAPED to {title, isq:[{IM_SPEC_MASTER_DESC,ISQ_RESPONSE}]}', (()=>{ const i=pick7('prev_isq_data'); return Array.isArray(i) && i[0]?.title==='122454' && i[0].isq[0]?.IM_SPEC_MASTER_DESC==='Automation Grade' && i[0].isq[0]?.ISQ_RESPONSE==='Semi-Automatic'; })());
ok('v7 buyer_profile passes through as object (correct shape — no unwrap needed)', !Array.isArray(pick7('buyer_profile')) && pick7('buyer_profile')?.first_name==='Jaiveer');
// v9: when isq-enrich resolved a category, the legacy requirement title uses the NAME (not the mcat id)
const nvCat = normalize({ sources:{ isq:{ summary:{ isq_offers:[ {mcat_id:'122454', category:'Notebook Making Machines', specs:[]} ] } } } });
const isqCat = (nvCat.legacy.find(o=>'prev_isq_data' in o)||{}).prev_isq_data;
ok('v9 ISQ category → legacy requirement title = the NAME (not mcat id)', Array.isArray(isqCat) && isqCat[0]?.title==='Notebook Making Machines');

console.log(`\nextracttest (LLM-native buyer-profile · bundle-from-summaries · grounding · state · new→legacy adapter): ${pass}/${pass+fail} passed${fail?` — ${fail} FAILED`:' ✓'}`);
process.exit(fail?1:0);
