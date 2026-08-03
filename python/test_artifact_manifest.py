#!/usr/bin/env python3
"""Regression tests for source/context-bound pipeline artifacts."""
import json
import os
import shutil
import sys
import tempfile
import time

import fitz
import agent_pipeline as ap

FAIL = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        FAIL.append(name)
        print(f"  ✗ {name}" + (f" — {detail}" if detail else ""))


def write_pdf(path, text):
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    page.insert_text((40, 80), text, fontsize=11)
    doc.save(path)
    doc.close()


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f)


def t_source_replacement_invalidates():
    print("\n── same path, new PDF bytes ──")
    root = tempfile.mkdtemp(prefix="cfa_manifest_")
    try:
        pdf = os.path.join(root, "source.pdf")
        wd = os.path.join(root, "work")
        write_pdf(pdf, "This is the original source paragraph with enough words.")
        ap.cmd_chunk(pdf, wd, size=10)
        first = json.load(open(os.path.join(wd, "artifact-manifest.json")))
        first_chunks = sorted(os.listdir(os.path.join(wd, "chunks")))
        write_json(os.path.join(wd, "text2vi.json"), {"old": "stale"})
        write_json(os.path.join(wd, "out", "c_000.json"), {"t0": "cũ"})

        # Filesystems with coarse timestamps still differ by content hash.
        time.sleep(0.01)
        os.remove(pdf)
        write_pdf(pdf, "This replacement document has completely different content and words.")
        ap.cmd_chunk(pdf, wd, size=10)
        second = json.load(open(os.path.join(wd, "artifact-manifest.json")))
        layout = json.load(open(os.path.join(wd, "layout.json")))

        check("source hash changed", first["source"]["sha256"] != second["source"]["sha256"])
        check("stale translation cache removed", not os.path.exists(os.path.join(wd, "text2vi.json")))
        check("stale unit output removed", not os.path.exists(os.path.join(wd, "out", "c_000.json")))
        check("chunks regenerated", bool(first_chunks) and os.path.isdir(os.path.join(wd, "chunks")))
        check("layout bound to current absolute source", layout["pdf"] == os.path.abspath(pdf), str(layout["pdf"]))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def t_context_change_keeps_parse_only():
    print("\n── translator context invalidation ──")
    root = tempfile.mkdtemp(prefix="cfa_context_")
    try:
        pdf = os.path.join(root, "source.pdf")
        wd = os.path.join(root, "work")
        write_pdf(pdf, "A sufficiently long paragraph for translation cache testing.")
        ap.cmd_chunk(pdf, wd, size=10)
        ctx_a = {"target_language": "vi", "translator": "claude",
                 "model": "default", "prompt_version": "translate-v1"}
        ap.cmd_prepare(pdf, wd, json.dumps(ctx_a))
        chunk = os.path.join(wd, "chunks", "c_000.json")
        check("parse chunk exists before context switch", os.path.exists(chunk))
        write_json(os.path.join(wd, "text2vi.json"), {"source": "bản dịch"})
        write_json(os.path.join(wd, "out", "c_000.json"), {"t0": "bản dịch"})

        same = ap.cmd_prepare(pdf, wd, json.dumps(ctx_a))
        check("same context is a no-op", same["invalidation"] is None)
        check("same context keeps translation", os.path.exists(os.path.join(wd, "text2vi.json")))

        ctx_b = dict(ctx_a, translator="codex")
        changed = ap.cmd_prepare(pdf, wd, json.dumps(ctx_b))
        check("engine switch invalidates translation", changed["invalidation"] == "translation")
        check("engine switch keeps source chunks", os.path.exists(chunk))
        check("engine switch drops translation cache", not os.path.exists(os.path.join(wd, "text2vi.json")))
        manifest = json.load(open(os.path.join(wd, "artifact-manifest.json")))
        check("manifest records new translator", manifest["translation"]["translator"] == "codex")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main():
    t_source_replacement_invalidates()
    t_context_change_keeps_parse_only()
    if FAIL:
        print(f"\nFAILED {len(FAIL)}: {FAIL}")
        return 1
    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
