// Deterministic test for the CANDIDATE LEADERBOARD / DISPOSITION — mirrors src/lib/categoryDisposition.ts.
// Answers "why wasn't Site-Ready asked?" without guessing — models the real Diesel Generator case. NO LLM.

const STOP = new Set(['the','a','for','of','with','and','to','in','your','this','required','requirement','need','needed','type','do','you','how','what','is','are','will']);
const toks = (s) => new Set(String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter((t)=>t.length>=3&&!STOP.has(t)));
const norm = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
function related(a,b){ const na=norm(a),nb=norm(b); if(na.length>=4&&nb.length>=4&&(na.includes(nb)||nb.includes(na)))return true; const ta=toks(a),tb=toks(b); for(const t of ta) if(tb.has(t))return true; return false; }
const matchIn=(name,list)=>list.find((x)=>related(name,x));
const DEFAULT_LASTPAGE=['budget','gst','delivery','payment','credit','location','firm','company','price'];
function categoryLeaderboard(input){
  const lastPage=input.lastPageConcepts?.length?input.lastPageConcepts:DEFAULT_LASTPAGE;
  const rows=[]; const seen=new Set();
  const classify=(name,priority,kind,maps)=>{
    if(kind==='application')return{name,priority,kind,disposition:'INTENT',reason:'intent',coveredBy:input.intentValue||'intent'};
    const knownHit=input.knownConcepts.find((c)=>related(name,c)); if(knownHit)return{name,priority,kind,disposition:'KNOWN',reason:'known',coveredBy:knownHit};
    if(maps&&maps.trim())return{name,priority,kind,disposition:'SPEC',reason:'spec',coveredBy:maps};
    const specHit=matchIn(name,input.specNames); if(specHit)return{name,priority,kind,disposition:'SPEC',reason:'spec',coveredBy:specHit};
    const askedHit=matchIn(name,input.askedLabels); if(askedHit)return{name,priority,kind,disposition:'ASKED',reason:'asked',coveredBy:askedHit};
    if(kind==='application'||(input.intentValue&&related(name,input.intentValue)))return{name,priority,kind,disposition:'INTENT',reason:'intent',coveredBy:input.intentValue||'intent'};
    const lpHit=matchIn(name,lastPage); if(lpHit)return{name,priority,kind,disposition:'LAST_PAGE',reason:'lastpage',coveredBy:lpHit};
    const sibling=input.askedLabels.find((q)=>related(name,q)); if(sibling)return{name,priority,kind,disposition:'DEPRIORITIZED',reason:'partially covered',coveredBy:sibling};
    return{name,priority,kind,disposition:'DEPRIORITIZED',reason:'below cap'};
  };
  const add=(r)=>{const k=norm(r.name); if(k&&!seen.has(k)){seen.add(k);rows.push(r);}};
  for(const c of input.criticals||[]) if(c&&c.name) add(classify(c.name,typeof c.seller_frequency==='number'?c.seller_frequency:50,'critical',c.maps_to_isq));
  for(const b of input.blockers||[]) if(b&&b.label) add(classify(b.label,typeof b.frequency==='number'?b.frequency:30,'blocker'));
  for(const a of input.applications||[]) if(a) add(classify(a,40,'application'));
  return rows.sort((x,y)=>y.priority-x.priority);
}

let pass=0,fail=0; const ok=(n,c)=>{if(c)pass++;else{fail++;console.log('  ✗ FAIL:',n);}};

// ── the real Diesel Generator case ──
const board = categoryLeaderboard({
  criticals: [{ name: 'Rated Power (kVA)', seller_frequency: 96, maps_to_isq: 'Rated Power' }, { name: 'Phase', seller_frequency: 88, maps_to_isq: 'Phase' }, { name: 'Fuel Type', seller_frequency: 80, maps_to_isq: 'Fuel Type' }],
  blockers: [{ label: 'Installation and commissioning', kind: 'logistics', frequency: 41 }, { label: 'Site readiness / space', kind: 'logistics', frequency: 32 }, { label: 'Price too high / budget', kind: 'price', frequency: 35 }],
  applications: ['Manufacturing backup power', 'Primary power source'],
  askedLabels: ['What is your budget for this generator?', 'Will you need more generators in the future?', 'Do you need installation and commissioning?'],
  specNames: ['Rated Power', 'Phase', 'Fuel Type', 'Genset Type', 'Cooling System'],
  intentValue: 'Primary power source',
  knownConcepts: ['fuel type'],
});
const power = board.find((r) => /power/i.test(r.name));
const install = board.find((r) => /install/i.test(r.name));
const site = board.find((r) => /site/i.test(r.name));
const price = board.find((r) => /price|budget/i.test(r.name));
const fuel = board.find((r) => /fuel/i.test(r.name));
const app = board.find((r) => r.kind === 'application');

ok('Rated Power (freq 96, maps to ISQ) → SPEC (spec page, not a card)', power && power.disposition === 'SPEC');
ok('Installation (blocker 41) → ASKED (became a panel question)', install && install.disposition === 'ASKED');
ok('Site Ready (blocker 32) → DEPRIORITIZED — THE answer to "why wasn\'t it asked"', site && site.disposition === 'DEPRIORITIZED');
ok('Site Ready reason cites coverage or the cap', site && /covered|cap|frequency/i.test(site.reason));
ok('Price/budget blocker → LAST_PAGE or ASKED (budget question)', price && (price.disposition === 'ASKED' || price.disposition === 'LAST_PAGE'));
ok('Fuel Type (known) → KNOWN, never re-asked', fuel && fuel.disposition === 'KNOWN');
ok('applications → INTENT (framed the intent question)', app && app.disposition === 'INTENT');
ok('board is ranked by priority desc (Power 96 first)', board[0].priority === 96);
ok('every candidate has a disposition + reason', board.every((r) => r.disposition && r.reason));

// ── coverage: nothing silently lost ──
ok('all candidates present (3 criticals + 3 blockers + 2 apps, deduped)', board.length >= 7);
ok('dispositions span the real spread', new Set(board.map((r) => r.disposition)).size >= 4);

// ── graceful ──
ok('empty input → empty board, no throw', categoryLeaderboard({ criticals: [], blockers: [], applications: [], askedLabels: [], specNames: [], intentValue: '', knownConcepts: [] }).length === 0);

console.log(`\ncategorydispositiontest (candidate leaderboard · ASKED/SPEC/INTENT/LAST_PAGE/KNOWN/DEPRIORITIZED · "why wasn't Site-Ready asked" · freq-ranked · graceful): ${pass}/${pass+fail} passed${fail?` — ${fail} FAILED`:' ✓'}`);
process.exit(fail?1:0);
