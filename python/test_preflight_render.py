#!/usr/bin/env python3
"""Preflight, render-report and raster-budget regression tests."""
import os
import shutil
import sys
import tempfile

import fitz
import pdf_core as pc
import agent_pipeline as ap

FAIL = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        FAIL.append(name)
        print(f"  ✗ {name}" + (f" — {detail}" if detail else ""))


def scan_png():
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    page.insert_textbox(
        fitz.Rect(30, 40, 370, 260),
        "This text is baked into a page image and cannot be extracted directly.",
        fontsize=18,
    )
    data = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).tobytes("png")
    doc.close()
    return data


def t_preflight_classes():
    print("\n── page classification ──")
    root = tempfile.mkdtemp(prefix="cfa_preflight_")
    try:
        path = os.path.join(root, "mixed.pdf")
        doc = fitz.open()
        native = doc.new_page(width=400, height=300)
        native.insert_textbox(
            fitz.Rect(30, 40, 370, 260),
            "A native PDF paragraph contains extractable characters, words, and layout information. "
            "It should follow the normal translation path without optical character recognition.",
            fontsize=11,
        )
        scanned = doc.new_page(width=400, height=300)
        scanned.insert_image(scanned.rect, stream=scan_png())
        layered = doc.new_page(width=400, height=300)
        layered.insert_image(layered.rect, stream=scan_png())
        layered.insert_textbox(
            fitz.Rect(30, 40, 370, 260),
            "Invisible searchable OCR text layer with enough characters to look native to a text-count heuristic.",
            fontsize=11,
            render_mode=3,
        )
        doc.save(path)
        doc.close()

        doc = fitz.open(path)
        result = pc.preflight_document(doc)
        classes = [p["classification"] for p in result["pages"]]
        check("native page detected", classes[0] == "native_text", str(classes))
        check("image-only scan detected", classes[1] == "scanned", str(classes))
        check("invisible OCR layer detected", classes[2] == "scanned_with_text_layer", str(classes))
        probe = result["pages"][2]["roundtrip_probe"] or {}
        check("OCR-layer probe is high-similarity", probe.get("similarity", 0) > 0.99, str(probe))
        check("document mode is mixed", result["document_mode"] == "mixed")
        doc.close()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def t_native_profile_gate():
    print("\n── safe scan profile gate ──")
    root = tempfile.mkdtemp(prefix="cfa_scan_gate_")
    try:
        source = os.path.join(root, "scan.pdf")
        workdir = os.path.join(root, "work")
        doc = fitz.open()
        page = doc.new_page(width=400, height=300)
        page.insert_image(page.rect, stream=scan_png())
        doc.save(source)
        doc.close()
        failed = False
        try:
            ap.cmd_chunk(source, workdir, profile="native")
        except RuntimeError as exc:
            failed = "scan_detected" in str(exc)
        check("native profile refuses scan instead of pretending translated", failed)
        check("preflight remains available after refusal", os.path.exists(os.path.join(workdir, "preflight.json")))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def t_raster_budget():
    print("\n── adaptive raster budget ──")
    plan = pc.raster_plan(fitz.Rect(0, 0, 100_000, 80_000), 300, 1_000_000)
    check("huge page is limited", plan["limited"])
    check("pixel cap is respected", plan["pixels"] <= 1_000_000, str(plan))
    check("effective DPI is reduced", plan["effective_dpi"] < 300, str(plan))
    normal = pc.raster_plan(fitz.Rect(0, 0, 612, 792), 150, 12_000_000)
    check("normal page keeps requested DPI", not normal["limited"] and abs(normal["effective_dpi"] - 150) < 0.01)


def t_render_report():
    print("\n── segment fit telemetry ──")
    doc = fitz.open()
    page = doc.new_page(width=400, height=220)
    box = fitz.Rect(40, 40, 180, 62)
    page.insert_textbox(box, "Original English paragraph for replacement.", fontsize=11)
    layout = [{
        "id": "s0", "page": 0,
        "redact": [list(box)], "box": list(box),
        "size": 11, "color": 0, "lh": 1.1, "align": None, "fx": None,
    }]
    report = {}
    pc.apply_translations(
        doc,
        layout,
        {"s0": "Bản dịch tiếng Việt rất dài, cố ý vượt xa sức chứa của khung nhỏ này để kiểm tra."},
        report=report,
    )
    seg = report["segments"][0]
    check("report records applied segment", report["applied"] == 1 and seg["id"] == "s0")
    check("report records actual scale", 0 < seg["actual_scale"] <= 1, str(seg))
    check("small text is flagged for review", seg["review_required"] and report["review_count"] == 1, str(seg))
    check("report carries fit status", seg["status"] == "review")
    doc.close()


def t_apply_persists_report():
    print("\n── apply persists editor/report data ──")
    root = tempfile.mkdtemp(prefix="cfa_render_report_")
    try:
        source = os.path.join(root, "source.pdf")
        output = os.path.join(root, "output.pdf")
        workdir = os.path.join(root, "work")
        doc = fitz.open()
        page = doc.new_page(width=400, height=300)
        page.insert_textbox(
            fitz.Rect(40, 50, 360, 180),
            "This paragraph has enough English words to enter the normal translation pipeline.",
            fontsize=11,
        )
        doc.save(source)
        doc.close()
        ap.cmd_chunk(source, workdir, size=10)
        chunks = []
        for name in sorted(os.listdir(os.path.join(workdir, "chunks"))):
            chunks.extend(__import__("json").load(open(os.path.join(workdir, "chunks", name))))
        translations = {item["text"]: "Đây là đoạn dịch tiếng Việt để kiểm tra dữ liệu báo cáo kết xuất." for item in chunks}
        with open(os.path.join(workdir, "text2vi.json"), "w", encoding="utf-8") as f:
            __import__("json").dump(translations, f, ensure_ascii=False)
        ap.cmd_apply(source, workdir, output)
        report = __import__("json").load(open(os.path.join(workdir, "render_report.json")))
        seg = report["segments"][0]
        check("render_report.json exists", os.path.exists(os.path.join(workdir, "render_report.json")))
        check("report stores source for editor", bool(seg.get("source")))
        check("report stores translation for editor", bool(seg.get("translation")))
        check("translated PDF written", os.path.exists(output))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def t_block_update_roundtrip():
    print("\n── editable block update ──")
    root = tempfile.mkdtemp(prefix="cfa_block_update_")
    try:
        source = os.path.join(root, "source.pdf")
        output = os.path.join(root, "output.pdf")
        workdir = os.path.join(root, "work")
        doc = fitz.open()
        p = doc.new_page(width=400, height=250)
        p.insert_textbox(
            fitz.Rect(30, 40, 370, 140),
            "A paragraph with a formula marker-like source is translated here.",
            fontsize=11,
        )
        doc.save(source)
        doc.close()
        ap.cmd_chunk(source, workdir, size=10)
        chunks = []
        for name in sorted(os.listdir(os.path.join(workdir, "chunks"))):
            chunks.extend(__import__("json").load(open(os.path.join(workdir, "chunks", name))))
        with open(os.path.join(workdir, "text2vi.json"), "w", encoding="utf-8") as f:
            __import__("json").dump({x["text"]: "Bản dịch ban đầu." for x in chunks}, f, ensure_ascii=False)
        ap.cmd_apply(source, workdir, output)
        sid = __import__("json").load(open(os.path.join(workdir, "render_report.json")))["segments"][0]["id"]
        result = ap.cmd_block_update(source, workdir, output, sid, "Bản dịch chỉnh tay.")
        check("block update returns selected id", result["id"] == sid)
        check("override is persisted", __import__("json").load(open(os.path.join(workdir, "fixes.json")))[sid]["vi"] == "Bản dịch chỉnh tay.")
        check("manual render keeps output", os.path.exists(output))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main():
    t_preflight_classes()
    t_native_profile_gate()
    t_raster_budget()
    t_render_report()
    t_apply_persists_report()
    t_block_update_roundtrip()
    if FAIL:
        print(f"\nFAILED {len(FAIL)}: {FAIL}")
        return 1
    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
