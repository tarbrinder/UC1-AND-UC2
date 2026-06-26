#!/usr/bin/env python3
"""
n8n v11 transform — RFQ Buyer Insights.

Deterministic, targeted patches over the v10x LIVE export. Produces a v11 file.
Run:  python3 n8n_v11_transform.py
Idempotent enough to re-run from the source each time (always reads INP fresh).

CRITICAL INVARIANT: the webhook node PATH stays EXACTLY 'bi-user-insights-v10x'.
Only the workflow display NAME gets 'v11'.

Real node names found in the v10x export (verified by exploration):
  befisc httpRequest      = 'befisc-fetch'   (url https://prod.smartauth.co/C9S1)
  sign3  httpRequest      = 'sign3-fetch'    (url https://you.sign3.in/v1/persona)
  csl->llm Code           = 'csl-to-llm'
  whatsapp Code           = 'whatsapp'
  anchor extract Code     = 'anchor_extract'   (output: json.anchors.mobile, single 10-digit)
  identity Code           = 'identity'         (output: json.summary.mobiles[], last-10)
  external Code           = 'external'         (output: json.summary.mobile, befisc alternate_phone)
  merge node              = 'DUMB-MERGE'       (n8n-nodes-base.merge v3.2, numberInputs=6)
  final assemble Code     = 'final-assemble'   (reads each source by $(name).first().json)
  webhook                 = 'Webhook1'         (path bi-user-insights-v10x)
  first node (glid)       = 't0'               (json.query.glid = buyer's own glid)
"""

import json
import copy
import os
import subprocess
import tempfile

INP = "/Users/tarbrinder/Downloads/RFQ Buyer Insights — v10x LIVE [bi-user-insights-v10x].json"
OUT = "/Users/tarbrinder/Downloads/RFQ Buyer Insights — v11 [bi-user-insights-v10x].json"

# ---- exact node names found by exploration ----
N_BEFISC   = "befisc-fetch"
N_SIGN3    = "sign3-fetch"
N_CSL      = "csl-to-llm"
N_WHATSAPP = "whatsapp"
N_ANCHOR   = "anchor_extract"
N_IDENTITY = "identity"
N_EXTERNAL = "external"
N_MERGE    = "DUMB-MERGE"
N_FINAL    = "final-assemble"
N_WEBHOOK  = "Webhook1"

# ---- new GST sub-flow node names ----
N_GST_COMPILE = "gst-compile-contacts"
N_GST_FETCH   = "gst-fetch"
N_GST_RESOLVE = "gst-resolve"

# v11.1: two endpoints, SAME authkey. Mobile->GST = JKSU, Email->GST = 3WVY.
GST_URL_MOBILE = "https://prod.smartauth.co/JKSU"
GST_URL_EMAIL  = "https://prod.smartauth.co/3WVY"
GST_URL = GST_URL_MOBILE  # default url on the node; per-item url is set by expression
GST_AUTHKEY = "BRLN0P7NRSLVD6J"  # owner-supplied; verified against befisc-fetch at build time


def load():
    with open(INP) as f:
        return json.load(f)


def node_index(wf, name):
    for i, n in enumerate(wf["nodes"]):
        if n["name"] == name:
            return i
    raise KeyError(f"node not found: {name}")


def get_node(wf, name):
    return wf["nodes"][node_index(wf, name)]


def get_befisc_authkey(wf):
    """Copy befisc's authkey header value VERBATIM (so gst uses the same auth)."""
    befisc = get_node(wf, N_BEFISC)
    for p in befisc["parameters"].get("headerParameters", {}).get("parameters", []):
        if str(p.get("name", "")).lower() == "authkey":
            return p["value"]
    raise RuntimeError("befisc authkey header not found")


# ============================================================================
# CHANGE 1 + 2: BEFISC / SIGN3 hardening
# ============================================================================
def harden_befisc(wf):
    n = get_node(wf, N_BEFISC)
    n["parameters"].setdefault("options", {})["timeout"] = 20000  # down from 40000
    n["retryOnFail"] = True
    n["maxTries"] = 3
    n["waitBetweenTries"] = 2000
    return "befisc-fetch: options.timeout 40000->20000, retryOnFail=true, maxTries=3, waitBetweenTries=2000"


def harden_sign3(wf):
    n = get_node(wf, N_SIGN3)
    n["parameters"].setdefault("options", {})["timeout"] = 20000  # from 15000
    n["retryOnFail"] = True
    n["maxTries"] = 2
    return "sign3-fetch: options.timeout->20000, retryOnFail=true, maxTries=2"


# ============================================================================
# CHANGE 3: GST sub-flow (mobile-only). 3 new nodes + wiring.
# ============================================================================
GST_COMPILE_CODE = r"""
// NODE: gst-compile-contacts — collect ALL valid buyer CONTACTS (mobiles AND emails) across
// anchor_extract / identity / external, dedupe per type, and emit ONE OUTPUT ITEM PER CONTACT
// tagged with ctype ('mobile'|'email') so the downstream gst-fetch HTTP node runs once per contact
// and routes URL+body by ctype. Reads upstream nodes by name (all already executed).
// Defensive: each $() lookup in its own try/catch.
const last10 = v => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v == null ? '' : v).trim());

const seenMob = new Set();
const seenEm  = new Set();
const contacts = [];  // { contact, ctype }
const addMobile = v => { const m = last10(v); if (m && m.length === 10 && !seenMob.has(m)) { seenMob.add(m); contacts.push({ contact: m, ctype: 'mobile' }); } };
const addEmail  = v => { if (!isEmail(v)) return; const e = String(v).trim().toLowerCase(); if (!seenEm.has(e)) { seenEm.add(e); contacts.push({ contact: e, ctype: 'email' }); } };

// 1) anchor_extract — primary anchor mobile + email (json.anchors.{mobile,email}; tolerate flat json.{mobile,email})
try {
  const a = $('anchor_extract').first().json;
  if (a) {
    add_mobiles: { addMobile(a.mobile); if (a.anchors) addMobile(a.anchors.mobile); }
    add_emails:  { addEmail(a.email);  if (a.anchors) addEmail(a.anchors.email); }
  }
} catch (e) {}

// 2) identity — BL profile multi-mobile + multi-email arrays (json.summary.{mobiles,emails}[]; tolerate flat)
try {
  const id = $('identity').first().json;
  const mArr = (id && id.summary && Array.isArray(id.summary.mobiles)) ? id.summary.mobiles
             : (id && Array.isArray(id.mobiles)) ? id.mobiles : [];
  for (const m of mArr) addMobile(m);
  const eArr = (id && id.summary && Array.isArray(id.summary.emails)) ? id.summary.emails
             : (id && Array.isArray(id.emails)) ? id.emails : [];
  for (const e of eArr) addEmail(e);
} catch (e) {}

// 3) external — befisc alternate phone (json.summary.mobile) + befisc email (json.summary.email); tolerate other shapes
try {
  const ex = $('external').first().json;
  if (ex) {
    if (ex.summary) {
      addMobile(ex.summary.mobile);
      if (Array.isArray(ex.summary.mobiles)) for (const m of ex.summary.mobiles) addMobile(m);
      addEmail(ex.summary.email);
      if (Array.isArray(ex.summary.emails)) for (const e of ex.summary.emails) addEmail(e);
    }
    addMobile(ex.mobile);
    addEmail(ex.email);
    try { const bf = ex.raw && ex.raw.befisc && ex.raw.befisc.result; const ap = bf && bf.alternate_phone; if (Array.isArray(ap)) for (const x of ap) addMobile(x && x.value ? x.value : x); } catch (e2) {}
  }
} catch (e) {}

if (!contacts.length) {
  return [{ json: { contact: '', ctype: 'none', skip: true } }];
}
return contacts.map(c => ({ json: { contact: c.contact, ctype: c.ctype } }));
""".strip()


GST_RESOLVE_CODE = r"""
// NODE: gst-resolve — aggregate ALL gst-fetch output items (one per contact: mobile or email),
// pull EVERY GSTIN each response returned, keep only well-formed GSTINs, DEDUPE (Set, upper-cased),
// and emit the deduped LIST. API success shape: { status, result:[ ...GSTINs... ] } where result may
// hold one OR MANY GSTINs. Defensive about where the body lives (.json, .json.result, .json.body.result, ...).
const items = $input.all();

// Full-string GSTIN format (case-insensitive); we upper-case before dedup.
const GSTIN_FULL = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/i;
const GSTIN_FIND = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/i;

function pickResultArray(body) {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body.result)) return body.result;
  if (Array.isArray(body.results)) return body.results;
  if (body.data && Array.isArray(body.data.result)) return body.data.result;
  if (Array.isArray(body.data)) return body.data;
  if (body.body && Array.isArray(body.body.result)) return body.body.result;
  return null;
}
// Pull EVERY candidate GSTIN string out of one result element (string or object).
function gstinsFrom(el) {
  const out = [];
  const consider = s => {
    if (typeof s !== 'string') return;
    const t = s.trim();
    if (GSTIN_FULL.test(t)) { out.push(t); return; }
    const m = t.match(GSTIN_FIND); if (m) out.push(m[0]);
  };
  if (typeof el === 'string') { consider(el); }
  else if (el && typeof el === 'object') {
    for (const k of ['gstin', 'gst', 'gstNo', 'gst_no', 'GSTIN', 'gstin_no', 'value']) consider(el[k]);
  }
  return out;
}
function statusOf(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.status != null) return body.status;
  if (body.data && body.data.status != null) return body.data.status;
  if (body.body && body.body.status != null) return body.body.status;
  return null;
}

const seen = new Set();
const gsts = [];        // deduped, upper-cased
const per = [];         // { gstin, via_contact, via_type }
let contacts_tried = 0;

for (const it of items) {
  const j = (it && it.json != null) ? it.json : it;
  if (!j) continue;
  // skip the no-contact sentinel from gst-compile-contacts
  if (j.skip === true && (j.contact == null || j.contact === '')) continue;
  if (j.ctype === 'none') continue;
  contacts_tried++;
  // body can be at j (responseFormat json), j.body, j.data, j.json, or nested .body.result
  const body = (j.result != null || j.status != null) ? j
             : (j.body != null) ? j.body
             : (j.data != null && (j.data.result != null || j.data.status != null)) ? j.data
             : (j.json != null) ? j.json
             : j;
  const arr = pickResultArray(body);
  if (!Array.isArray(arr)) continue;
  for (const el of arr) {
    for (const g of gstinsFrom(el)) {
      const up = g.toUpperCase();
      if (!seen.has(up)) {
        seen.add(up);
        gsts.push(up);
        per.push({ gstin: up, via_contact: (j.contact != null ? j.contact : ''), via_type: (j.ctype != null ? j.ctype : '') });
      }
    }
  }
}

return [{ json: {
  gsts: gsts,
  gst: gsts[0] || '',
  gst_count: gsts.length,
  gst_found: gsts.length > 0,
  contacts_tried: contacts_tried,
  per: per
} }];
""".strip()


def add_gst_subflow(wf):
    notes = []
    authkey = GST_AUTHKEY  # owner-supplied authkey, SAME for both endpoints
    try:
        befisc_key = get_befisc_authkey(wf)
        if befisc_key == authkey:
            notes.append(f"gst-fetch authkey={authkey!r} (matches befisc-fetch)")
        else:
            notes.append(f"gst-fetch authkey={authkey!r} (owner-supplied; befisc uses {befisc_key!r})")
    except Exception as e:
        notes.append(f"gst-fetch authkey={authkey!r} (befisc authkey lookup skipped: {e})")

    ext = get_node(wf, N_EXTERNAL)
    bx, by = ext["position"][0], ext["position"][1]

    # node ids: stable, descriptive (n8n allows any unique string id)
    compile_node = {
        "parameters": {"jsCode": GST_COMPILE_CODE},
        "id": "v11-gst-compile-0001",
        "name": N_GST_COMPILE,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [bx + 260, by + 220],
    }
    # URL + body switch by ctype. Email->3WVY, anything else (mobile)->JKSU. Same authkey.
    url_expr = (
        "={{ $json.ctype === 'email' ? "
        f"'{GST_URL_EMAIL}' : '{GST_URL_MOBILE}' }}}}"
    )
    body_expr = (
        "={{ $json.ctype === 'email' ? "
        "{ email: $json.contact, consent: 'Y', "
        "consent_text: 'We confirm obtaining valid customer consent to access/process their email data. "
        "Consent remains valid, informed, and unwithdrawn.' } : "
        "{ mobile: $json.contact, consent: 'Y', "
        "consent_text: 'I give my consent to mobile to gst api to get my gst number info' } }}"
    )
    fetch_node = {
        "parameters": {
            "method": "POST",
            "url": url_expr,
            "sendHeaders": True,
            "headerParameters": {
                "parameters": [
                    {"name": "Content-Type", "value": "application/json"},
                    {"name": "authkey", "value": authkey},
                ]
            },
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": body_expr,
            "options": {
                "response": {"response": {"responseFormat": "json"}},
                "timeout": 20000,
            },
        },
        "id": "v11-gst-fetch-0002",
        "name": N_GST_FETCH,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": [bx + 520, by + 220],
        "onError": "continueRegularOutput",
        "retryOnFail": True,
        "maxTries": 2,
    }
    resolve_node = {
        "parameters": {"jsCode": GST_RESOLVE_CODE},
        "id": "v11-gst-resolve-0003",
        "name": N_GST_RESOLVE,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [bx + 780, by + 220],
    }

    wf["nodes"].extend([compile_node, fetch_node, resolve_node])
    notes.append("added 3 nodes: gst-compile-contacts (Code, one item per mobile+email by ctype), gst-fetch (httpRequest POST, url+body by ctype expr: email->3WVY / mobile->JKSU, onError=continueRegularOutput, timeout=20000, retry x2), gst-resolve (Code, collects+dedupes all valid GSTINs)")

    # ---- WIRING ----
    conns = wf["connections"]

    # external already -> DUMB-MERGE(#5). ADD external -> gst-compile (branch off external, parallel).
    ext_out = conns.setdefault(N_EXTERNAL, {}).setdefault("main", [])
    if not ext_out:
        ext_out.append([])
    ext_out[0].append({"node": N_GST_COMPILE, "type": "main", "index": 0})

    # gst-compile -> gst-fetch
    conns[N_GST_COMPILE] = {"main": [[{"node": N_GST_FETCH, "type": "main", "index": 0}]]}
    # gst-fetch -> gst-resolve
    conns[N_GST_FETCH] = {"main": [[{"node": N_GST_RESOLVE, "type": "main", "index": 0}]]}

    # gst-resolve -> DUMB-MERGE as a NEW input #6 (sync barrier so final-assemble, which reads
    # gst-resolve by name, is guaranteed it has run). Bump merge numberInputs 6 -> 7.
    merge = get_node(wf, N_MERGE)
    cur_inputs = int(merge["parameters"].get("numberInputs", 6))
    new_idx = cur_inputs
    merge["parameters"]["numberInputs"] = cur_inputs + 1
    conns[N_GST_RESOLVE] = {"main": [[{"node": N_MERGE, "type": "main", "index": new_idx}]]}
    notes.append(f"wired external->gst-compile->gst-fetch->gst-resolve->DUMB-MERGE(input#{new_idx}); DUMB-MERGE numberInputs {cur_inputs}->{cur_inputs+1}")

    return notes


def patch_final_assemble_for_gst(wf):
    """Option B: final-assemble reads $('gst-resolve').first().json by name and attaches it.
    Adds sources.gst, derived_anchors.gst, source_registry.gst."""
    n = get_node(wf, N_FINAL)
    code = n["parameters"]["jsCode"]

    # 1) add gst to the `sources` object (insert a line inside the object literal)
    anchor = "  external: ref('external'),"
    assert anchor in code, "final-assemble: external source line not found"
    gst_source_line = (
        anchor
        + "\n"
        + "  gst: ref('gst-resolve'),         // v11: Mobile/Email->GST (KYB) registered-business signal"
    )
    code = code.replace(anchor, gst_source_line, 1)

    # 2) inject a block, just before the final `return`, that resolves gst + patches
    #    derived_anchors, source_registry, and sources.gst into a {summary} shape.
    return_anchor = "return [{ json: { glid, fetched_at:"
    assert return_anchor in code, "final-assemble: return statement not found"
    gst_block = r"""
// ── v11: Mobile/Email→GST (KYB) attach — deduped GSTIN LIST ────────────────────
try {
  const gstJson = (typeof sources.gst === 'object' && sources.gst) ? sources.gst : {};
  const gsts = Array.isArray(gstJson.gsts) ? gstJson.gsts : [];
  const gst = gstJson.gst || gsts[0] || '';
  const gst_count = (gstJson.gst_count != null) ? gstJson.gst_count : gsts.length;
  const gst_found = (gstJson.gst_found != null) ? !!gstJson.gst_found : (gsts.length > 0);
  const contacts_tried = (gstJson.contacts_tried != null) ? gstJson.contacts_tried : 0;
  // reshape sources.gst into the flow's {summary} contract — primary + deduped list
  sources.gst = { summary: { gst, gsts, gst_count, gst_found, contacts_tried }, raw: gstJson };
  if (anchors && typeof anchors === 'object') { anchors.gst = gst || anchors.gst; }
  source_registry.gst = { source_name: 'gst', trust_level: 'high', observed_only: true, purpose: 'Mobile/Email→GST (KYB) registered-business signal' };
} catch (e) {}

"""
    code = code.replace(return_anchor, gst_block + return_anchor, 1)
    n["parameters"]["jsCode"] = code
    return "final-assemble: sources.gst=ref('gst-resolve'); attach block sets sources.gst.summary{gst,gsts,gst_count,gst_found,contacts_tried}, derived_anchors.gst=primary||existing, source_registry.gst"


# ============================================================================
# CHANGE 4: CSL self-supplier filter — drop the buyer's own glid from supplierIdSet.
# ============================================================================
def patch_csl_self_filter(wf):
    n = get_node(wf, N_CSL)
    code = n["parameters"]["jsCode"]

    # The supplier set is built per-record; the buyer's own glid for this item is the local
    # var `glid` (from r.glusr_id). The incoming response is `it.json`; the buyer glid is also
    # reachable as it.json.glid / it.json.glusr_id. Inside toLLM(input), `glid` is the parsed
    # buyer glid. We insert deletes right where suppliers{} is derived from supplierIdSet.
    anchor = "  const uniqueSuppliers=supplierIdSet.size;"
    assert anchor in code, "csl-to-llm: supplier-derivation anchor not found"
    inject = (
        "  // v11: exclude the BUYER'S OWN glid from supplier touchpoints (self-views are not supplier comparisons)\n"
        "  try {\n"
        "    const __selfGlids = [glid, (input && input.glid), (input && input.glusr_id)];\n"
        "    for (const __g of __selfGlids) { if (__g != null && __g !== '') { supplierIdSet.delete(String(__g)); supplierIdSet.delete(String(__g).replace(/\\D/g,'')); } }\n"
        "  } catch(e) {}\n"
    )
    code = code.replace(anchor, inject + anchor, 1)

    # also filter the final ids_viewed array defensively (in case set ops missed a formatting variant)
    arr_anchor = "    ids_viewed:[...supplierIdSet],"
    assert arr_anchor in code, "csl-to-llm: ids_viewed line not found"
    arr_repl = (
        "    ids_viewed:[...supplierIdSet].filter(__id => {"  # v11 self-filter
        " const __s=String(__id).replace(/\\D/g,'');"
        " const __b=String((glid!=null?glid:((input&&(input.glid||input.glusr_id))||''))).replace(/\\D/g,'');"
        " return !__b || __s !== __b; }),"
    )
    code = code.replace(arr_anchor, arr_repl, 1)

    n["parameters"]["jsCode"] = code
    return "csl-to-llm: delete buyer glid from supplierIdSet (glid / input.glid / input.glusr_id) + filter final ids_viewed"


# ============================================================================
# CHANGE 5: WhatsApp response_rate cap at 100.
# ============================================================================
def patch_whatsapp_cap(wf):
    n = get_node(wf, N_WHATSAPP)
    code = n["parameters"]["jsCode"]
    old = "    response_rate = Number(((campaigns_responded / campaigns_received) * 100).toFixed(2));"
    assert old in code, "whatsapp: response_rate computation not found"
    new = "    response_rate = Math.min(100, Math.round((campaigns_responded / Math.max(1, campaigns_received)) * 100)); // v11: cap at 100"
    code = code.replace(old, new, 1)
    n["parameters"]["jsCode"] = code
    return "whatsapp: response_rate = Math.min(100, Math.round((responded/Math.max(1,received))*100))"


# ============================================================================
# CHANGE 6: workflow name -> v11 (path UNCHANGED)
# ============================================================================
def patch_name(wf):
    wf["name"] = "RFQ Buyer Insights — v11 [bi-user-insights-v10x]"
    return f'workflow name -> {wf["name"]!r}'


# ============================================================================
# VALIDATION
# ============================================================================
def validate(wf, before_count):
    errs = []
    names = {n["name"] for n in wf["nodes"]}
    after_count = len(wf["nodes"])

    # webhook path unchanged
    wh = get_node(wf, N_WEBHOOK)
    assert wh["parameters"].get("path") == "bi-user-insights-v10x", "WEBHOOK PATH CHANGED!"

    # every connection refers to existing nodes (source + target)
    for src, out in wf["connections"].items():
        if src not in names:
            errs.append(f"connection source '{src}' is not an existing node")
        for typ, branches in out.items():
            for branch in branches:
                for c in branch:
                    if c["node"] not in names:
                        errs.append(f"connection target '{c['node']}' (from '{src}') is not an existing node")

    # 3 new nodes exist
    for nm in (N_GST_COMPILE, N_GST_FETCH, N_GST_RESOLVE):
        if nm not in names:
            errs.append(f"missing new node: {nm}")

    # chain external -> compile -> fetch -> resolve -> (merge)
    def targets(src):
        out = wf["connections"].get(src, {})
        return [c["node"] for branches in out.get("main", []) for c in branches]

    if N_GST_COMPILE not in targets(N_EXTERNAL):
        errs.append("external -> gst-compile-contacts NOT wired")
    if N_GST_FETCH not in targets(N_GST_COMPILE):
        errs.append("gst-compile-contacts -> gst-fetch NOT wired")
    if N_GST_RESOLVE not in targets(N_GST_FETCH):
        errs.append("gst-fetch -> gst-resolve NOT wired")
    if N_MERGE not in targets(N_GST_RESOLVE):
        errs.append("gst-resolve -> DUMB-MERGE NOT wired")

    # gst-fetch onError graceful + URL/body switch by ctype expression
    gf = get_node(wf, N_GST_FETCH)
    if gf.get("onError") != "continueRegularOutput":
        errs.append("gst-fetch onError != continueRegularOutput")
    gf_url = gf["parameters"].get("url", "")
    if not (gf_url.startswith("={{") and "ctype === 'email'" in gf_url and GST_URL_EMAIL in gf_url and GST_URL_MOBILE in gf_url):
        errs.append("gst-fetch url is not a ctype expression over 3WVY/JKSU")
    gf_body = gf["parameters"].get("jsonBody", "")
    if not (gf_body.startswith("={{") and "ctype === 'email'" in gf_body and "email: $json.contact" in gf_body and "mobile: $json.contact" in gf_body):
        errs.append("gst-fetch jsonBody is not a ctype expression over email/mobile")
    # gst-fetch authkey header present and SAME owner key
    hp = gf["parameters"].get("headerParameters", {}).get("parameters", [])
    if not any(str(p.get("name", "")).lower() == "authkey" and p.get("value") == GST_AUTHKEY for p in hp):
        errs.append(f"gst-fetch authkey header != {GST_AUTHKEY}")

    # befisc / sign3 hardening present
    bf = get_node(wf, N_BEFISC)
    if not (bf.get("retryOnFail") and bf.get("maxTries") == 3 and bf["parameters"]["options"]["timeout"] == 20000):
        errs.append("befisc hardening incomplete")
    s3 = get_node(wf, N_SIGN3)
    if not (s3.get("retryOnFail") and s3.get("maxTries") == 2 and s3["parameters"]["options"]["timeout"] == 20000):
        errs.append("sign3 hardening incomplete")

    # name includes v11
    if "v11" not in wf.get("name", ""):
        errs.append("workflow name missing v11")

    return errs, before_count, after_count


def node_check_code_nodes(wf):
    """Run `node --check` on every Code node's jsCode. Returns (errs, checked_count).
    n8n Code nodes run the body inside a function, so we wrap before checking syntax."""
    errs = []
    checked = 0
    have_node = subprocess.run(["which", "node"], capture_output=True, text=True).returncode == 0
    if not have_node:
        return ["node binary not found — skipped --check (install node to enable)"], 0
    for n in wf["nodes"]:
        if n.get("type") != "n8n-nodes-base.code":
            continue
        js = n.get("parameters", {}).get("jsCode")
        if not js:
            continue
        checked += 1
        wrapped = "(async function(){\n" + js + "\n})();\n"
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as tf:
            tf.write(wrapped)
            path = tf.name
        try:
            r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
            if r.returncode != 0:
                errs.append(f"node --check FAILED for '{n['name']}': {r.stderr.strip().splitlines()[-1] if r.stderr.strip() else r.stderr}")
        finally:
            os.unlink(path)
    return errs, checked


def main():
    wf = load()
    before_count = len(wf["nodes"])
    log = []

    log.append(harden_befisc(wf))
    log.append(harden_sign3(wf))
    log += add_gst_subflow(wf)
    log.append(patch_final_assemble_for_gst(wf))
    log.append(patch_csl_self_filter(wf))
    log.append(patch_whatsapp_cap(wf))
    log.append(patch_name(wf))

    errs, bc, ac = validate(wf, before_count)

    # syntax-check every Code node with `node --check`
    nc_errs, nc_count = node_check_code_nodes(wf)
    hard_nc = [e for e in nc_errs if "skipped" not in e]
    errs += hard_nc

    if errs:
        print("VALIDATION FAILED:")
        for e in errs:
            print("  -", e)
        raise SystemExit(1)

    with open(OUT, "w") as f:
        json.dump(wf, f, ensure_ascii=False, indent=2)

    # re-load the WRITTEN file to be sure it parses from disk
    with open(OUT) as f:
        json.load(f)

    print("=== v11 transform complete ===")
    for line in log:
        print("  *", line)
    print(f"\nnode count: {bc} -> {ac}")
    print("webhook path:", get_node(wf, N_WEBHOOK)["parameters"]["path"])
    if any("skipped" in e for e in nc_errs):
        print(f"node --check: SKIPPED ({nc_count} Code nodes; node binary unavailable)")
    else:
        print(f"node --check: PASSED for all {nc_count} Code nodes")
    print("ALL VALIDATIONS PASSED")
    print(
        "\nGST sub-flow change (v11.1): gst-compile-contacts now emits ONE item per CONTACT across "
        "BOTH mobiles AND emails (anchor_extract/identity/external), each tagged ctype='mobile'|'email' "
        "(mobiles deduped to last-10, emails lowercased-deduped); gst-fetch switches URL and JSON body by a "
        "ctype expression (email -> 3WVY with the email consent_text, otherwise mobile -> JKSU with the mobile "
        "consent_text) using the same authkey for both; gst-resolve aggregates every gst-fetch response, pulls "
        "EVERY well-formed GSTIN, dedupes (upper-cased Set), and emits the deduped LIST as "
        "{gsts, gst=gsts[0], gst_count, gst_found, contacts_tried, per[]}; final-assemble attaches the list under "
        "sources.gst.summary and sets derived_anchors.gst to the primary."
    )


if __name__ == "__main__":
    main()
