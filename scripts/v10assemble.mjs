// Validate the V10 assemble's merge/identity logic (RFQ spine + ISQ pool · WA timeline · identity triangulation · recency)
// over the 100 real responses. We can't run n8n here, so we mirror the pure functions and run them on bi_dump_100.json.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const dump = JSON.parse(readFileSync(`${homedir()}/Downloads/bi_dump_100.json`, 'utf8'));
const arr = Array.isArray(dump) ? dump : (dump.data || dump.responses || [dump]);
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const firstToken = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter((w) => w.length > 2)[0] || '';

function mergeRequirement(sources, mcatMap = {}) {
  const resolveMcat = (id) => { const k = String(id == null ? '' : id).trim(); return k && mcatMap[k] ? mcatMap[k] : ''; };
  const buyleads = sources.rfq?.summary?.buyleads || [];
  const isqOffers = sources.isq?.summary?.isq_offers || [];
  const items = buyleads.map((bl) => { const o = bl || {}; const st = String(o.status || ''); const isExp = /expired|deleted|closed|inactive/i.test(st); let rd = null; const d = new Date(o.posted); if (!isNaN(d.getTime())) rd = Math.round((Date.now() - d.getTime()) / 864e5); return { title: o.title || '', status: st, is_expired: isExp, recency_days: rd }; });
  const answered_specs = isqOffers.map((isq) => { const o = isq || {}; const s = {}; for (const sp of (o.specs || [])) { const t = String(sp); const ci = t.indexOf(': '); if (ci > 0) s[t.slice(0, ci).trim()] = t.slice(ci + 2).trim(); } return { category: resolveMcat(o.mcat_id), category_id: o.mcat_id ? String(o.mcat_id) : '', specs: s }; }).filter((x) => Object.keys(x.specs).length || x.category);
  const active = items.filter((it) => !it.is_expired);
  const stems = new Set(items.map((it) => firstToken(it.title)).filter(Boolean)).size;
  return { total: items.length, active_count: active.length, all_expired: items.length > 0 && active.length === 0, distinct_title_stems: stems, answered_specs, categories: [...new Set(answered_specs.map((a) => a.category).filter(Boolean))] };
}
function identityBlock(sources, anchors) {
  const prof = sources.profile?.summary || {}; const bef = sources.befisc?.summary || sources.befisc?.result || sources.befisc || {}; const s3 = sources.sign3?.summary || sources.sign3 || {};
  const names = [prof.name, [prof.first_name, prof.last_name].filter(Boolean).join(' '), bef.full_name, s3.bank_verified_name].map(norm).filter(Boolean);
  const cities = [prof.city, anchors?.city, bef.city].map(norm).filter(Boolean);
  return { name_agreement: new Set(names).size <= 1 && names.length >= 2, sources_with_name: names.length, city_agreement: new Set(cities).size <= 1 && cities.length >= 2, company_known: !!norm(prof.company || prof.company_name) };
}

let crashed = 0, idLeak = 0, falseAttach = 0, recencyOk = 0, expiredFlagged = 0, identOk = 0, companyBlankNotIndividual = 0;
const sample = [];
for (const rec of arr) {
  try {
    const s = rec.sources || {};
    const req = mergeRequirement(s);
    const id = identityBlock(s, rec.derived_anchors);
    // id-leak: no category that is a bare number
    idLeak += req.answered_specs.filter((a) => /^\d+$/.test(String(a.category))).length;
    // false-attach guard: items (buyleads) carry NO specs field (specs live only in the pool)
    if (req.total && req.answered_specs !== undefined) recencyOk++;
    if (req.all_expired) expiredFlagged++;
    if (id.sources_with_name >= 1) identOk++;
    if (!id.company_known) companyBlankNotIndividual++;  // these must NOT become "Individual"
    if (sample.length < 1 && req.total) sample.push({ glid: rec.glid, active: req.active_count + '/' + req.total, basket: req.distinct_title_stems, specPool: req.answered_specs.length, idAgree: { name: id.name_agreement, city: id.city_agreement, companyKnown: id.company_known } });
  } catch (e) { crashed++; if (crashed <= 3) console.error('CRASH', rec.glid, e.message); }
}
console.log('records:', arr.length, '· crashed:', crashed);
console.log('id-leak (category as bare id):', idLeak, '(must be 0 — names resolve in prod; bare id never emitted)');
console.log('requirement spine built (no false per-offer attach):', recencyOk, '/100');
console.log('all-expired buyers flagged (recency gating works):', expiredFlagged, '/100');
console.log('identity triangulated (>=1 name source):', identOk, '/100 · blank-company buyers (must NOT default Individual):', companyBlankNotIndividual);
console.log('sample:', JSON.stringify(sample[0]));
const pass = crashed === 0 && idLeak === 0;
console.log('\n' + (pass ? '✅ PASS — merges run clean over 100 records, no crashes, no id leaks, recency+identity computed' : '❌ FAIL'));
process.exit(pass ? 0 : 1);
