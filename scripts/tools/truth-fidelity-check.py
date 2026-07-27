#!/usr/bin/env python3
"""
Truth Fidelity Check (TFC)
==========================
Answers one question, mechanically, for a sample of real GLIDs: does the truth we captured
(RAW per-source n8n output) actually survive into what the Brain understood, used, and decided?

Run this whenever a NEW n8n workflow is provided/imported — it is exactly how the
csl-merge1 node-rename bug, the missing calls-call wiring, and the contacted_seller
field-mismatch were found. Static code review catches shape bugs; this catches DATA bugs.

For each GLID it fetches, in parallel (throttled), and SAVES:
  - RAW  bi-csl-parser, bi-whatsapp, bi-bpod, bi-rfq-details
  - RAW  bi-transcribe  (BOTH pns=api and pns=full  — the fast vs full PNS pipeline)
  - BRAIN bi-requirement-brain (BOTH pns=api and pns=full)

Then computes, per source, per GLID:
  RAW present? -> RAW richness (non-empty field count) -> node_health in the brain response
  -> does the brain's node_raw / decisions actually CARRY the raw signal (not just "green")

Output: a markdown fidelity table + a JSON summary + the full raw archive (gitignored — the
BPOD payload carries real PII: Aadhaar/PAN/GST/mobile/email; the CSL/WA payloads carry buyer
activity that is also sensitive). NEVER commit the fidelity-runs/ output directory.

Usage:
  python3 truth-fidelity-check.py                      # 10 built-in sample GLIDs
  python3 truth-fidelity-check.py <glid> <glid> ...     # explicit GLIDs
  python3 truth-fidelity-check.py --skip-full           # skip the slow pns=full / brain-full calls
"""
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://imworkflow.intermesh.net/webhook"
GLOBAL_CONCURRENCY = 6          # shared LLM gateway 429s under load (memory: ~3.5s backoff) — stay polite
TIMEOUT_FAST = 90
TIMEOUT_SLOW = 180              # pns=full / brain pns=full run real transcription+LLM calls

DEFAULT_GLIDS = ["106815489", "114522949", "140092812", "14782129", "210304462",
                 "221642727", "236130641", "268590579", "52514720", "90498811"]

_sema = None  # set in main() so --skip-full etc can size the pool

def fetch(url, timeout):
    # Shelling out to curl, NOT urllib: this network's TLS chain includes a self-signed cert
    # that curl (via the macOS system trust store) accepts but Python's ssl module rejects
    # (CERTIFICATE_VERIFY_FAILED) — verified empirically: with urllib every single one of 80
    # fetches failed silently and the analyzer mis-read "raw absent" as "OK". curl is the
    # network layer PROVEN to work on this machine against this exact host.
    t0 = time.time()
    try:
        p = subprocess.run(["curl", "-s", "-w", "\n%{http_code}", "--max-time", str(timeout), url],
                            capture_output=True, text=True, timeout=timeout + 10)
        ms = int((time.time() - t0) * 1000)
        if p.returncode != 0:
            return {"ok": False, "status": None, "ms": ms, "error": f"curl exit {p.returncode}: {p.stderr.strip()[:200]}"}
        *body_lines, code = p.stdout.rsplit("\n", 1)
        body = "\n".join(body_lines) if body_lines else ""
        status = int(code) if code.strip().isdigit() else None
        if status != 200:
            return {"ok": False, "status": status, "ms": ms, "error": f"HTTP {status}: {body[:200]}"}
        try:
            return {"ok": True, "status": status, "ms": ms, "json": json.loads(body)}
        except Exception as e:
            return {"ok": False, "status": status, "ms": ms, "error": f"non-json response: {e}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "status": None, "ms": int((time.time() - t0) * 1000), "error": "timeout"}
    except Exception as e:
        return {"ok": False, "status": None, "ms": int((time.time() - t0) * 1000), "error": str(e)}

def throttled_fetch(url, timeout):
    with _sema:
        return fetch(url, timeout)

def u(path, glid, extra=""):
    return f"{BASE}/{path}?glid={glid}{extra}"

def run_glid(glid, outdir, skip_full):
    gdir = os.path.join(outdir, glid)
    os.makedirs(gdir, exist_ok=True)
    jobs = {
        "raw_csl": (u("bi-csl-parser", glid), TIMEOUT_FAST),
        "raw_wa": (u("bi-whatsapp", glid), TIMEOUT_FAST),
        "raw_bpod": (u("bi-bpod", glid), TIMEOUT_FAST),
        "raw_rfq": (u("bi-rfq-details", glid), TIMEOUT_FAST),
        "raw_pns_api": (u("bi-transcribe", glid, "&pns=api"), TIMEOUT_SLOW),
        "brain_api": (u("bi-requirement-brain", glid, "&pns=api"), TIMEOUT_SLOW),
    }
    if not skip_full:
        jobs["raw_pns_full"] = (u("bi-transcribe", glid, "&pns=full"), TIMEOUT_SLOW)
        jobs["brain_full"] = (u("bi-requirement-brain", glid, "&pns=full"), TIMEOUT_SLOW)

    out = {"glid": glid}
    with ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        futs = {ex.submit(throttled_fetch, url, to): name for name, (url, to) in jobs.items()}
        for fut in as_completed(futs):
            name = futs[fut]
            res = fut.result()
            meta = {k: v for k, v in res.items() if k != "json"}
            if res.get("ok"):
                with open(os.path.join(gdir, f"{name}.json"), "w") as f:
                    json.dump(res["json"], f, ensure_ascii=False, indent=1)
                meta["saved"] = f"{glid}/{name}.json"
            out[name] = meta
    with open(os.path.join(gdir, "_meta.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    return out

# ---- fidelity analysis: RAW vs BRAIN, per source, per GLID ----
def _get(d, *path, default=None):
    for k in path:
        if not isinstance(d, dict):
            return default
        d = d.get(k)
    return d if d is not None else default

def load(gdir, name):
    p = os.path.join(gdir, f"{name}.json")
    if not os.path.exists(p):
        return None
    try:
        return json.load(open(p))
    except Exception:
        return None

def analyze_glid(glid, outdir):
    gdir = os.path.join(outdir, glid)
    row = {"glid": glid}

    # FETCH-STATUS GATE — a failed fetch must NEVER read as "OK: no data present." Load the
    # per-job ok/error meta and use it as a hard precondition for every verdict below.
    meta = {}
    mp = os.path.join(gdir, "_meta.json")
    if os.path.exists(mp):
        try:
            meta = json.load(open(mp))
        except Exception:
            meta = {}
    def fetch_ok(*names):
        return all(meta.get(n, {}).get("ok") for n in names)
    def fetch_errs(*names):
        return {n: meta.get(n, {}).get("error") for n in names if not meta.get(n, {}).get("ok")}

    csl = load(gdir, "raw_csl"); csl_s = _get(csl, "summary", default=csl) or {}
    wa = load(gdir, "raw_wa"); wa_s = _get(wa, "summary", default=wa) or {}
    wa_raw = _get(wa, "raw", default={}) or {}
    bpod = load(gdir, "raw_bpod") or {}
    rfq = load(gdir, "raw_rfq"); rfq_s = _get(rfq, "summary", default=rfq) or {}
    pns_api = load(gdir, "raw_pns_api"); pns_api_s = _get(pns_api, "summary", default=pns_api) or {}
    pns_full = load(gdir, "raw_pns_full"); pns_full_s = _get(pns_full, "summary", default=pns_full) or {}
    brain = load(gdir, "brain_api") or {}
    brain_full = load(gdir, "brain_full") or {}

    m = _get(brain, "metadata", default=brain) or {}
    o = _get(brain, "observability", default={}) or {}
    nh = _get(o, "node_health", default={}) or {}
    nr = _get(o, "node_raw", default={}) or {}
    decisions = _get(brain, "decisions", default=[]) or []
    brain_str = json.dumps(brain)

    def health(src):
        h = nh.get(src, {})
        return h.get("status"), h.get("count")

    # CSL
    if not fetch_ok("raw_csl", "brain_api"):
        row["CSL"] = {"verdict": f"FETCH-FAILED: {fetch_errs('raw_csl', 'brain_api')}"}
    else:
        csl_present = bool(csl_s.get("viewed_products") or csl_s.get("categories") or csl_s.get("requirement"))
        csl_h_status, csl_h_count = health("csl")
        delivery_dec = next((d for d in decisions if d.get("field") == "delivery_city"), None)
        row["CSL"] = {
            "raw_present": csl_present,
            "raw_viewed_products": len(csl_s.get("viewed_products") or []),
            "raw_categories": len(csl_s.get("categories") or []),
            "raw_browse_city": _get(csl_s, "browse_location", "city"),
            "node_health": f"{csl_h_status}({csl_h_count})",
            "delivery_decision": bool(delivery_dec),
            "delivery_is_ab": bool(delivery_dec and delivery_dec.get("options")),
            "verdict": "OK" if (not csl_present or delivery_dec or csl_h_status == "green") else ("GAP" if csl_present else "no-data"),
        }

    # WhatsApp
    if not fetch_ok("raw_wa", "brain_api"):
        row["WhatsApp"] = {"verdict": f"FETCH-FAILED: {fetch_errs('raw_wa', 'brain_api')}"}
    else:
        wa_products = wa_s.get("products_enquired") or []
        wa_typed = wa_s.get("buyer_typed_enquiries") or _get(wa_raw, "inbound", "buyer_typed_enquiries", default=[])
        wa_h_status, wa_h_count = health("whatsapp")
        row["WhatsApp"] = {
            "raw_present": bool(wa_products or wa_typed),
            "raw_products_enquired": len(wa_products),
            "raw_typed_enquiries": len(wa_typed),
            "node_health": f"{wa_h_status}({wa_h_count})",
            "discussed_wa_reaches_output": "discussed_wa" in brain_str,
            "verdict": "OK" if not (wa_products or wa_typed) else ("OK" if "discussed_wa" in brain_str else "GAP: products_enquired present but discussed_wa never tagged"),
        }

    # BPOD / profile
    if not fetch_ok("raw_bpod", "brain_api"):
        row["Profile(BPOD)"] = {"verdict": f"FETCH-FAILED: {fetch_errs('raw_bpod', 'brain_api')}"}
    else:
        bp = bpod.get("bp") or {}
        bf = _get(m, "buyer_facts", default={}) or {}
        row["Profile(BPOD)"] = {
            "raw_present": bool(bp),
            "raw_field_count": len(bp),
            "node_health": f"{health('profile')[0]}({health('profile')[1]})",
            "buyer_facts_populated": bool(bf.get("city") or bf.get("member_since") or bf.get("business_type")),
            "verdict": "OK" if not bp else ("OK" if bf else "GAP: bp present but buyer_facts empty"),
        }

    # RFQ / prev requirements
    if not fetch_ok("raw_rfq", "brain_api"):
        row["Prev-RFQ"] = {"verdict": f"FETCH-FAILED: {fetch_errs('raw_rfq', 'brain_api')}"}
    else:
        reqs = rfq_s.get("requirements") or (rfq.get("requirements") if isinstance(rfq, dict) else []) or []
        rfq_h_status, rfq_h_count = health("rfq")
        recs = _get(m, "recommendations", default=[]) or []
        primary = _get(m, "primary")
        row["Prev-RFQ"] = {
            "raw_present": bool(reqs),
            "raw_requirement_count": len(reqs),
            "node_health": f"{rfq_h_status}({rfq_h_count})",
            "primary_or_recs_populated": bool(primary or recs),
            "verdict": "OK" if not reqs else ("OK" if (primary or recs) else "GAP: requirements present but no primary/recommendations"),
        }

    # PNS Calls — fast vs full
    pns_full_ok = meta.get("raw_pns_full", {}).get("ok")  # optional (--skip-full may omit it)
    if not fetch_ok("raw_pns_api", "brain_api"):
        row["PNS-Calls"] = {"verdict": f"FETCH-FAILED: {fetch_errs('raw_pns_api', 'brain_api')}"}
    else:
        api_cov = pns_api_s.get("coverage") or {}
        full_cov = pns_full_s.get("coverage") or {}
        api_app = _get(pns_api_s, "requirement", "intended_application")
        calls_h_status, calls_h_count = health("calls")
        app_decision = next((d for d in decisions if d.get("field") in ("buyer_context", "application")), None)
        row["PNS-Calls"] = {
            "raw_pns_api_present": bool(pns_api_s.get("requirement")),
            "raw_pns_full_present": (bool(pns_full_s.get("requirement")) if pns_full_ok else ("FETCH-FAILED" if "raw_pns_full" in meta else "skipped")),
            "api_coverage": api_cov, "full_coverage": (full_cov if pns_full_ok else None),
            "full_adds_over_api": ((full_cov.get("pns_llm_extracted", 0) > api_cov.get("pns_llm_extracted", 0)) if pns_full_ok and full_cov else "n/a"),
            "node_health_(brain,pns=api)": f"{calls_h_status}({calls_h_count})",
            "application_reaches_decision": bool(app_decision),
            "verdict": ("no-data" if not pns_api_s.get("requirement")
                        else ("OK" if calls_h_status == "green" and app_decision else
                              f"GAP: raw present (app={bool(api_app)}) but brain calls={calls_h_status}({calls_h_count}), application_decision={bool(app_decision)}")),
        }

    return row

def main():
    argv = sys.argv[1:]
    skip_full = "--skip-full" in argv
    argv = [a for a in argv if not a.startswith("--")]
    glids = argv if argv else DEFAULT_GLIDS

    global _sema
    _sema = __import__("threading").Semaphore(GLOBAL_CONCURRENCY)

    ts = os.environ.get("TFC_RUN_ID") or str(int(time.time()))
    outdir = os.path.join(os.path.dirname(__file__), "fidelity-runs", ts)
    os.makedirs(outdir, exist_ok=True)
    print(f"Truth Fidelity Check — run {ts} — {len(glids)} GLIDs — output: {outdir}", file=sys.stderr)

    fetch_results = []
    with ThreadPoolExecutor(max_workers=min(len(glids), 5)) as ex:
        futs = {ex.submit(run_glid, g, outdir, skip_full): g for g in glids}
        for fut in as_completed(futs):
            g = futs[fut]
            try:
                r = fut.result()
                fetch_results.append(r)
                print(f"  done: {g}", file=sys.stderr)
            except Exception as e:
                print(f"  ERROR {g}: {e}", file=sys.stderr)
                fetch_results.append({"glid": g, "error": str(e)})

    json.dump(fetch_results, open(os.path.join(outdir, "_fetch_log.json"), "w"), indent=1)

    rows = [analyze_glid(g, outdir) for g in glids]
    json.dump(rows, open(os.path.join(outdir, "_fidelity_report.json"), "w"), indent=1)
    print(json.dumps({"run_id": ts, "outdir": outdir, "rows": rows}, indent=1))

if __name__ == "__main__":
    main()
