#!/usr/bin/env python3
"""test_defects_perf.py — defect-report/classify must be light (no full-PDF).

Drives real agent_pipeline helpers with synthetic workdirs.
"""
import json
import os
import shutil
import sys
import tempfile
import time

import agent_pipeline as ap

FAIL = []


def check(name, cond, detail=""):
    if not cond:
        FAIL.append(name)
        print(f"  ✗ {name}" + (f" — {detail}" if detail else ""))
    else:
        print(f"  ✓ {name}")


def _write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(obj, open(path, "w", encoding="utf-8"), ensure_ascii=False)


def t_light_enrich_no_pdf():
    print("\n── light enrich + classify without PDF ──")
    wd = tempfile.mkdtemp(prefix="cfa_def_")
    try:
        issues = []
        for i in range(200):
            issues.append({
                "page": i % 50,
                "kind": "defect",
                "severity": "medium",
                "detail": "Bảng exhibit cột dồn giá trị" if i % 2 == 0
                else "chữ tràn khung sát viền phải",
            })
        _write(os.path.join(wd, "review_issues.json"), issues)
        # layout points at missing pdf — heavy path would fail/slow
        _write(os.path.join(wd, "layout.json"), {"pdf": "/no/such/file.pdf"})

        t0 = time.perf_counter()
        clusters = ap.cmd_defect_report(wd)
        dt = time.perf_counter() - t0
        check("defect-report under 2s for 200 issues no pdf", dt < 2.0, f"{dt:.3f}s")
        check("has bang_vo and tran_khung clusters",
              any(c["name"] == "bang_vo" for c in clusters)
              and any(c["name"] == "tran_khung" for c in clusters),
              str([c["name"] for c in clusters]))
        # second call hits cache
        t0 = time.perf_counter()
        ap.cmd_defect_report(wd)
        dt2 = time.perf_counter() - t0
        check("cached defect-report under 0.5s", dt2 < 0.5, f"{dt2:.3f}s")
        check("cache file written",
              os.path.exists(os.path.join(wd, "defect_clusters.json")))
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def t_problems_text_light():
    print("\n── problems text channel light ──")
    wd = tempfile.mkdtemp(prefix="cfa_prob_")
    try:
        issues = [
            {"page": 1, "kind": "defect", "severity": "high",
             "detail": "chữ tràn khung vượt viền"},
            {"page": 2, "kind": "defect", "severity": "medium",
             "detail": "bảng exhibit cột dồn"},
            {"page": 3, "kind": "fit", "severity": "low", "detail": "co chữ"},
        ]
        _write(os.path.join(wd, "review_issues.json"), issues)
        pages = ap.cmd_problems(wd, "medium", "text")
        check("text channel includes page 1", 1 in pages, str(pages))
        check("code bang not in text channel", 2 not in pages, str(pages))
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def t_review_resume_branch_in_runner():
    print("\n── pipeline-runner review-resume structure ──")
    path = os.path.join(os.path.dirname(__file__),
                        "../apps/daemon/src/pipeline-runner.mjs")
    path = os.path.normpath(path)
    src = open(path, encoding="utf-8").read()
    check("autoFixText function exists", "async function autoFixText" in src)
    check("reviewResume defined", "reviewResume" in src)
    check("auto-fix outside only-vision-only skip",
          "reviewResume || openDefects" in src or "reviewResume || openDefects > 0" in src
          or "review-resume: auto-fix" in src)
    check("auto-fix not nested only under vision block only",
          "if (!onlyVision && (didVision || reviewResume" in src
          or "review-resume: auto-fix" in src)


def t_live_v3_fast_if_present():
    print("\n── live v3 defect-report timing (if workdir exists) ──")
    wd = os.path.join(os.path.dirname(__file__), "../tool/work/v3")
    wd = os.path.normpath(wd)
    if not os.path.exists(os.path.join(wd, "review_issues.json")):
        print("  (skip — no tool/work/v3)")
        return
    # invalidate nothing — measure warm/light path
    cache = os.path.join(wd, "defect_clusters.json")
    if os.path.exists(cache):
        os.remove(cache)
    t0 = time.perf_counter()
    clusters = ap.cmd_defect_report(wd)
    dt = time.perf_counter() - t0
    check("v3 cold light report under 5s", dt < 5.0, f"{dt:.3f}s")
    check("v3 has defect clusters", len(clusters) >= 1)
    t0 = time.perf_counter()
    ap.cmd_defect_report(wd)
    dt2 = time.perf_counter() - t0
    check("v3 cached under 1s", dt2 < 1.0, f"{dt2:.3f}s")
    print(f"  (v3 cold={dt:.3f}s cached={dt2:.3f}s clusters={len(clusters)})")


def main():
    t_light_enrich_no_pdf()
    t_problems_text_light()
    t_review_resume_branch_in_runner()
    t_live_v3_fast_if_present()
    print()
    if FAIL:
        print(f"FAILED {len(FAIL)}: {FAIL}")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
