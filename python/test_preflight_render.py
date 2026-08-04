#!/usr/bin/env python3
"""Preflight, render-report and raster-budget regression tests."""
import hashlib
import json
import os
import re
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
    print("\n── partial-page editable block update ──")
    root = tempfile.mkdtemp(prefix="cfa_block_update_")
    try:
        source = os.path.join(root, "source.pdf")
        output = os.path.join(root, "output.pdf")
        workdir = os.path.join(root, "work")
        doc = fitz.open()
        p = doc.new_page(width=440, height=320)
        p.insert_textbox(
            fitz.Rect(35, 35, 405, 115),
            "Page zero contains a unique English paragraph that must remain byte-for-byte untouched.",
            fontsize=11,
        )
        p = doc.new_page(width=440, height=320)
        p.insert_text((35, 70), "The target formula value ", fontsize=11)
        p.insert_text((160, 70), "x", fontsize=6)
        p.insert_text((168, 70), " changes under a distinct middle-page scenario.", fontsize=11)
        p.insert_textbox(
            fitz.Rect(35, 150, 405, 215),
            "A second independent paragraph on the target page must retain its existing translation.",
            fontsize=11,
        )
        p = doc.new_page(width=440, height=320)
        p.insert_textbox(
            fitz.Rect(35, 35, 405, 115),
            "Page two contains another unique English paragraph that must remain byte-for-byte untouched.",
            fontsize=11,
        )
        doc.set_metadata({"title": "Partial render fixture", "author": "CFA Translate Studio"})
        doc.set_toc([[1, "First", 1], [1, "Editable", 2], [1, "Last", 3]])
        doc.set_page_labels([{"startpage": 0, "prefix": "T-", "style": "D", "firstpagenum": 1}])
        doc[0].insert_link({
            "kind": fitz.LINK_GOTO,
            "from": fitz.Rect(35, 250, 140, 270),
            "page": 1,
            "to": fitz.Point(0, 0),
        })
        doc[1].insert_link({
            "kind": fitz.LINK_URI,
            "from": fitz.Rect(35, 250, 140, 270),
            "uri": "https://example.com/partial-render",
        })
        doc.save(source)
        doc.close()
        ap.cmd_chunk(source, workdir, size=10)
        chunks = []
        for name in sorted(os.listdir(os.path.join(workdir, "chunks"))):
            chunks.extend(json.load(open(os.path.join(workdir, "chunks", name))))
        with open(os.path.join(workdir, "text2vi.json"), "w", encoding="utf-8") as f:
            json.dump(
                {
                    x["text"]: (
                        f"Bản dịch ban đầu cho đoạn {idx}. "
                        + " ".join(re.findall(r"\{v\d+\}", x["text"]))
                    ).strip()
                    for idx, x in enumerate(chunks)
                },
                f,
                ensure_ascii=False,
            )
        ap.cmd_apply(source, workdir, output)
        report_path = os.path.join(workdir, "render_report.json")
        baseline_report = json.load(open(report_path))
        target_page = 1
        target_segments = [x for x in baseline_report["segments"] if x["page"] == target_page]
        other_segments = [x for x in baseline_report["segments"] if x["page"] != target_page]
        sid = target_segments[0]["id"]
        neighbor_id = target_segments[1]["id"]
        check("fixture contains a real formula marker",
              "{v1}" in target_segments[0]["source"]
              and target_segments[0]["formula_count"] == 1,
              str(target_segments[0]))

        # Ground-truth sentinels exist only in the current translated output.
        # A legacy full-document apply recreates pages 0/2 from `source` and
        # necessarily loses them; a true partial update cannot touch them.
        rendered = fitz.open(output)
        rendered[0].insert_text((360, 300), "KEEP-P0", fontsize=7)
        rendered[2].insert_text((360, 300), "KEEP-P2", fontsize=7)
        target_note = rendered[1].add_text_annot((390, 285), "KEEP-TARGET-ANNOT")
        target_note.update()
        rendered.saveIncr()
        rendered.close()
        # The sentinels deliberately define the current translated baseline for
        # this regression fixture, so refresh its cheap report/PDF identity.
        baseline_report["output_identity"] = ap._pdf_identity(output)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(baseline_report, f, ensure_ascii=False, indent=1)

        os.makedirs(os.path.join(workdir, "review"), exist_ok=True)
        os.makedirs(os.path.join(workdir, "vis"), exist_ok=True)
        for pno in range(3):
            with open(os.path.join(workdir, "review", f"pair_{pno:03d}.png"), "wb") as f:
                f.write(f"PAIR-{pno}".encode("ascii"))
            with open(os.path.join(workdir, "vis", f"page_{pno:03d}.json"), "w") as f:
                json.dump([], f)
        with open(os.path.join(workdir, "review_issues.json"), "w") as f:
            json.dump([
                {"page": 0, "severity": "low", "detail": "keep"},
                {"page": 1, "severity": "high", "detail": "invalidate"},
            ], f)
        with open(os.path.join(workdir, "accepted.json"), "w") as f:
            json.dump({"pages": [1, 2], "notes": {"1": "stale", "2": "keep"}}, f)
        with open(os.path.join(workdir, "state.json"), "w") as f:
            json.dump({"stage": "done", "vision": [3, 3]}, f)
        with open(os.path.join(workdir, "vis_todo.json"), "w") as f:
            json.dump([], f)

        def page_snapshot(path, pno):
            current = fitz.open(path)
            page = current[pno]
            contents = tuple(page.get_contents())
            result = {
                "xref": page.xref,
                "text": page.get_text(),
                "pix": hashlib.sha256(page.get_pixmap(alpha=False).samples).hexdigest(),
                "streams": tuple(
                    hashlib.sha256(current.xref_stream(xref)).hexdigest()
                    for xref in contents
                ),
            }
            current.close()
            return result

        untouched_before = {pno: page_snapshot(output, pno) for pno in (0, 2)}
        target_before = page_snapshot(output, target_page)
        structural_before = fitz.open(output)
        metadata_before = structural_before.metadata
        toc_before = structural_before.get_toc(simple=False)
        labels_before = structural_before.get_page_labels()
        page_xrefs_before = [page.xref for page in structural_before]
        links_before = [page.get_links() for page in structural_before]
        target_annots_before = structural_before[1].annot_xrefs()
        structural_before.close()
        previous_report = open(report_path, "rb").read()
        previous_output = open(output, "rb").read()
        original_apply = pc.apply_translations
        invalid_marker_rejected = False
        try:
            ap.cmd_block_update(source, workdir, output, sid, "Bản dịch làm mất công thức.")
        except ValueError as exc:
            invalid_marker_rejected = "marker" in str(exc)
        check("missing formula marker is rejected", invalid_marker_rejected)
        check("marker rejection keeps report/PDF exact",
              open(report_path, "rb").read() == previous_report
              and open(output, "rb").read() == previous_output)
        check("marker rejection releases persistent lock",
              not os.path.exists(os.path.join(workdir, ap.BLOCK_UPDATE_LOCK_FILE)))

        timed_out = False
        def fail_apply(*_args, **_kwargs):
            raise TimeoutError("render timeout")
        try:
            pc.apply_translations = fail_apply
            ap.cmd_block_update(source, workdir, output, sid, "Bản dịch chưa hoàn tất với {v1}.")
        except TimeoutError:
            timed_out = True
        finally:
            pc.apply_translations = original_apply
        check("failed render propagates its error", timed_out)
        check("failed render does not persist override", not os.path.exists(os.path.join(workdir, "fixes.json")))
        check("failed render keeps previous report", open(report_path, "rb").read() == previous_report)
        check("failed render keeps previous PDF", open(output, "rb").read() == previous_output)

        original_replace = ap.os.replace
        commit_interrupted = False
        signal_sent = False
        def interrupt_after_output_commit(src, dst):
            nonlocal signal_sent
            result = original_replace(src, dst)
            if dst == output and ".block-" in src and not signal_sent:
                signal_sent = True
                os.kill(os.getpid(), ap.signal.SIGTERM)
            return result
        try:
            ap.os.replace = interrupt_after_output_commit
            ap.cmd_block_update(source, workdir, output, sid, "Bản dịch chưa commit với {v1}.")
        except RuntimeError as exc:
            commit_interrupted = "block update interrupted" in str(exc)
        finally:
            ap.os.replace = original_replace
        check("SIGTERM during final commit propagates", commit_interrupted)
        check("SIGTERM during final commit rolls back override", not os.path.exists(os.path.join(workdir, "fixes.json")))
        check("SIGTERM during final commit rolls back report", open(report_path, "rb").read() == previous_report)
        check("SIGTERM during final commit rolls back PDF", open(output, "rb").read() == previous_output)

        # A SIGTERM delivered from inside a directory fsync used to become the
        # built-in InterruptedError (an OSError) and get swallowed by
        # _fsync_parent. The dedicated signal exception must escape and roll the
        # whole journaled commit back.
        original_fsync = ap.os.fsync
        output_replaced = False
        fsync_signal_sent = False
        fsync_interrupted = False
        def mark_output_replaced(src, dst):
            nonlocal output_replaced
            result = original_replace(src, dst)
            if dst == output and ".block-" in src:
                output_replaced = True
            return result
        def interrupt_inside_parent_fsync(fd):
            nonlocal fsync_signal_sent
            if output_replaced and not fsync_signal_sent:
                fsync_signal_sent = True
                os.kill(os.getpid(), ap.signal.SIGTERM)
            return original_fsync(fd)
        try:
            ap.os.replace = mark_output_replaced
            ap.os.fsync = interrupt_inside_parent_fsync
            ap.cmd_block_update(source, workdir, output, sid, "Bản dịch dừng trong fsync với {v1}.")
        except RuntimeError as exc:
            fsync_interrupted = "block update interrupted" in str(exc)
        finally:
            ap.os.fsync = original_fsync
            ap.os.replace = original_replace
        check("SIGTERM inside parent fsync propagates", fsync_interrupted and fsync_signal_sent)
        check("SIGTERM inside parent fsync rolls all artifacts back",
              not os.path.exists(os.path.join(workdir, "fixes.json"))
              and open(report_path, "rb").read() == previous_report
              and open(output, "rb").read() == previous_output)

        render_calls = []
        extract_calls = []
        durability_events = []
        staged_pdf_path = None
        original_extract = pc.extract_segments
        original_splice = ap._splice_page_contents_incrementally
        original_fsync = ap.os.fsync
        original_replace = ap.os.replace
        def observe_extract(doc, pages_spec):
            extract_calls.append((doc.page_count, str(pages_spec)))
            return original_extract(doc, pages_spec)
        def observe_apply(doc, layout, translations, *args, **kwargs):
            render_calls.append({
                "page_count": doc.page_count,
                "layout_ids": tuple(item["id"] for item in layout),
                "translated_ids": tuple(
                    item["id"] for item in layout if translations.get(item["id"])
                ),
            })
            return original_apply(doc, layout, translations, *args, **kwargs)
        def observe_splice(current_pdf, staged_pdf, rendered_page, pno):
            nonlocal staged_pdf_path
            staged_pdf_path = staged_pdf
            return original_splice(current_pdf, staged_pdf, rendered_page, pno)
        def observe_fsync(fd):
            if staged_pdf_path and os.path.exists(staged_pdf_path):
                try:
                    opened = os.fstat(fd)
                    staged = os.stat(staged_pdf_path)
                    if (opened.st_dev, opened.st_ino) == (staged.st_dev, staged.st_ino):
                        durability_events.append("staged-pdf-fsync")
                except OSError:
                    pass
            return original_fsync(fd)
        def observe_replace(src, dst):
            if staged_pdf_path and src == staged_pdf_path and dst == output:
                durability_events.append("live-output-replace")
            return original_replace(src, dst)
        try:
            pc.extract_segments = observe_extract
            pc.apply_translations = observe_apply
            ap._splice_page_contents_incrementally = observe_splice
            ap.os.fsync = observe_fsync
            ap.os.replace = observe_replace
            result = ap.cmd_block_update(source, workdir, output, sid, "Bản dịch chỉnh tay với {v1}.")
        finally:
            ap.os.replace = original_replace
            ap.os.fsync = original_fsync
            ap._splice_page_contents_incrementally = original_splice
            pc.extract_segments = original_extract
            pc.apply_translations = original_apply
        check("block update returns selected id", result["id"] == sid)
        check("override is persisted", json.load(open(os.path.join(workdir, "fixes.json")))[sid]["vi"] == "Bản dịch chỉnh tay với {v1}.")
        check("manual render keeps output", os.path.exists(output))
        check("block update releases persistent lock", not os.path.exists(os.path.join(workdir, ap.BLOCK_UPDATE_LOCK_FILE)))
        check("staged PDF data is durable before live rename",
              "staged-pdf-fsync" in durability_events
              and durability_events.index("staged-pdf-fsync")
              < durability_events.index("live-output-replace"),
              str(durability_events))

        target_ids = {x["id"] for x in target_segments}
        check("renderer is invoked once for a one-page document",
              len(render_calls) == 1 and render_calls[0]["page_count"] == 1,
              str(render_calls))
        check("renderer receives only target-page segments",
              len(render_calls) == 1
              and set(render_calls[0]["layout_ids"]) == target_ids,
              str(render_calls))
        check("validation extracts only the target source page",
              extract_calls == [(3, str(target_page))], str(extract_calls))
        check("unrelated page 0 is byte/visual identical",
              page_snapshot(output, 0) == untouched_before[0])
        check("unrelated page 2 is byte/visual identical",
              page_snapshot(output, 2) == untouched_before[2])
        check("target page visibly changes",
              page_snapshot(output, target_page)["pix"] != target_before["pix"])

        final_doc = fitz.open(output)
        check("page count and page objects stay stable",
              final_doc.page_count == 3
              and [page.xref for page in final_doc] == page_xrefs_before)
        check("document metadata stays stable", final_doc.metadata == metadata_before)
        check("document outline stays stable", final_doc.get_toc(simple=False) == toc_before)
        check("page labels stay stable", final_doc.get_page_labels() == labels_before)
        check("incoming/outgoing links stay stable",
              [page.get_links() for page in final_doc] == links_before)
        check("target annotations stay stable",
              final_doc[1].annot_xrefs() == target_annots_before)
        final_doc.close()
        check("incremental splice preserves old PDF as byte prefix",
              open(output, "rb").read().startswith(previous_output))

        final_report = json.load(open(report_path))
        final_by_id = {x["id"]: x for x in final_report["segments"]}
        check("report segment order/count stay stable",
              [x["id"] for x in final_report["segments"]]
              == [x["id"] for x in baseline_report["segments"]])
        check("report entries outside target page stay exact",
              [x for x in final_report["segments"] if x["page"] != target_page]
              == other_segments)
        check("edited report entry contains new translation",
              final_by_id[sid]["translation"] == "Bản dịch chỉnh tay với {v1}.")
        check("edited formula telemetry stays attached to global id",
              final_by_id[sid]["formula_count"] == 1
              and final_by_id[sid]["page"] == target_page)
        check("neighbor translation on same page is preserved",
              final_by_id[neighbor_id]["translation"]
              == next(x["translation"] for x in target_segments if x["id"] == neighbor_id))
        check("document-level report fields stay stable",
              all(final_report[key] == baseline_report[key]
                  for key in ("page_count", "page_sizes", "missing_ids", "document_scale_cap")))
        check("report totals are internally consistent",
              final_report["applied"] == len(final_report["segments"])
              and final_report["review_count"]
              == sum(bool(x["review_required"]) for x in final_report["segments"]))

        check("only target review pair/verdict are invalidated",
              not os.path.exists(os.path.join(workdir, "review", "pair_001.png"))
              and not os.path.exists(os.path.join(workdir, "vis", "page_001.json"))
              and all(os.path.exists(os.path.join(workdir, sub, f"{prefix}_{pno:03d}.{ext}"))
                      for pno in (0, 2)
                      for sub, prefix, ext in (("review", "pair", "png"),
                                               ("vis", "page", "json"))))
        check("review state keeps true page denominator",
              json.load(open(os.path.join(workdir, "state.json")))["vision"][1] == 3)
        accepted = json.load(open(os.path.join(workdir, "accepted.json")))
        check("manual edit reopens only the target page",
              accepted["pages"] == [2] and accepted["notes"] == {"2": "keep"})
        check("target review issue is removed while other issue stays",
              json.load(open(os.path.join(workdir, "review_issues.json")))
              == [{"page": 0, "severity": "low", "detail": "keep"}])

        # Force the bounded-maintenance branch. It may rewrite the PDF container
        # but must not re-render other pages or renumber any page object.
        before_maintenance_report = json.load(open(report_path))
        old_edit_threshold = ap.PARTIAL_COMPACT_EDIT_THRESHOLD
        old_growth_threshold = ap.PARTIAL_COMPACT_GROWTH_THRESHOLD
        try:
            ap.PARTIAL_COMPACT_EDIT_THRESHOLD = 1
            ap.PARTIAL_COMPACT_GROWTH_THRESHOLD = 1 << 60
            ap.cmd_block_update(
                source, workdir, output, sid,
                "Bản dịch sau bảo trì cấu trúc với {v1}.",
            )
        finally:
            ap.PARTIAL_COMPACT_EDIT_THRESHOLD = old_edit_threshold
            ap.PARTIAL_COMPACT_GROWTH_THRESHOLD = old_growth_threshold
        maintained_report = json.load(open(report_path))
        maintenance_state = maintained_report.get("partial_render_state", {})
        check("thresholded maintenance resets incremental growth counter",
              maintenance_state.get("edits_since_compaction") == 0
              and maintenance_state.get("base_size") == os.path.getsize(output),
              str(maintenance_state))
        check("maintenance preserves every unrelated report entry",
              [x for x in maintained_report["segments"] if x["page"] != target_page]
              == [x for x in before_maintenance_report["segments"]
                  if x["page"] != target_page])
        maintained_doc = fitz.open(output)
        check("maintenance preserves page xrefs and document structure",
              [page.xref for page in maintained_doc] == page_xrefs_before
              and maintained_doc.metadata == metadata_before
              and maintained_doc.get_toc(simple=False) == toc_before
              and maintained_doc.get_page_labels() == labels_before
              and [page.get_links() for page in maintained_doc] == links_before
              and maintained_doc[1].annot_xrefs() == target_annots_before)
        maintained_doc.close()
        check("maintenance preserves unrelated page bytes and pixels",
              page_snapshot(output, 0) == untouched_before[0]
              and page_snapshot(output, 2) == untouched_before[2])

        # Corrupting any render-critical baseline field must fail closed before
        # a page is touched. This catches stale layout after engine upgrades.
        layout_path = os.path.join(workdir, "layout.json")
        saved_layout_bytes = open(layout_path, "rb").read()
        stable_report_bytes = open(report_path, "rb").read()
        stable_output_bytes = open(output, "rb").read()
        stable_fixes_bytes = open(os.path.join(workdir, "fixes.json"), "rb").read()

        # Legacy/incomplete baselines are not safe splice targets: without all
        # three identities the engine cannot prove source/layout/output belong
        # to the same full Apply generation.
        report_without_identity = json.loads(stable_report_bytes)
        report_without_identity.pop("output_identity", None)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report_without_identity, f, ensure_ascii=False)
        missing_identity_rejected = False
        try:
            ap.cmd_block_update(source, workdir, output, sid, "Không áp baseline cũ với {v1}.")
        except RuntimeError as exc:
            missing_identity_rejected = "partial_render_unavailable" in str(exc)
        check("baseline without output SHA-256 fails closed", missing_identity_rejected)
        with open(report_path, "wb") as f:
            f.write(stable_report_bytes)

        layout_without_generation = json.loads(saved_layout_bytes)
        report_without_generation = json.loads(stable_report_bytes)
        layout_without_generation.pop("layout_generation", None)
        report_without_generation.pop("layout_generation", None)
        with open(layout_path, "w", encoding="utf-8") as f:
            json.dump(layout_without_generation, f, ensure_ascii=False)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report_without_generation, f, ensure_ascii=False)
        missing_generation_rejected = False
        try:
            ap.cmd_block_update(source, workdir, output, sid, "Không áp generation cũ với {v1}.")
        except RuntimeError as exc:
            missing_generation_rejected = "partial_render_unavailable" in str(exc)
        check("baseline without layout generation fails closed", missing_generation_rejected)
        with open(layout_path, "wb") as f:
            f.write(saved_layout_bytes)
        with open(report_path, "wb") as f:
            f.write(stable_report_bytes)

        manifest_path = os.path.join(workdir, "artifact-manifest.json")
        stable_manifest_bytes = open(manifest_path, "rb").read()
        manifest_without_hash = json.loads(stable_manifest_bytes)
        manifest_without_hash.get("source", {}).pop("sha256", None)
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest_without_hash, f, ensure_ascii=False)
        missing_source_hash_rejected = False
        try:
            ap.cmd_block_update(source, workdir, output, sid, "Không áp nguồn chưa hash với {v1}.")
        except RuntimeError as exc:
            missing_source_hash_rejected = "partial_render_unavailable" in str(exc)
        check("baseline without source SHA-256 fails closed", missing_source_hash_rejected)
        with open(manifest_path, "wb") as f:
            f.write(stable_manifest_bytes)
        check("identity rejections never touch live PDF or override",
              open(output, "rb").read() == stable_output_bytes
              and open(os.path.join(workdir, "fixes.json"), "rb").read() == stable_fixes_bytes)

        damaged_layout = json.loads(saved_layout_bytes)
        damaged_item = next(item for item in damaged_layout["layout"] if item["id"] == sid)
        damaged_item["fx"] = []
        with open(layout_path, "w", encoding="utf-8") as f:
            json.dump(damaged_layout, f, ensure_ascii=False)
        stale_rejected = False
        try:
            ap.cmd_block_update(source, workdir, output, sid, "Không được áp với {v1}.")
        except RuntimeError as exc:
            stale_rejected = "partial_render_unavailable" in str(exc)
        check("stale render geometry fails closed", stale_rejected)
        check("stale-baseline rejection keeps all live artifacts exact",
              open(report_path, "rb").read() == stable_report_bytes
              and open(output, "rb").read() == stable_output_bytes
              and open(os.path.join(workdir, "fixes.json"), "rb").read() == stable_fixes_bytes)
        with open(layout_path, "wb") as f:
            f.write(saved_layout_bytes)

        # Provenance validation for an edit is read-only: a changed source must
        # reject the edit without deleting the last usable baseline artifacts.
        original_source_bytes = open(source, "rb").read()
        changed_source = fitz.open(source)
        changed_source.set_metadata({**changed_source.metadata, "subject": "changed"})
        changed_source.saveIncr()
        changed_source.close()
        source_change_rejected = False
        try:
            ap.cmd_block_update(source, workdir, output, sid, "Không được áp với {v1}.")
        except RuntimeError as exc:
            source_change_rejected = "PDF nguồn đã thay đổi" in str(exc)
        finally:
            with open(source, "wb") as f:
                f.write(original_source_bytes)
        check("source mismatch fails closed", source_change_rejected)
        check("source mismatch does not invalidate the usable baseline",
              open(layout_path, "rb").read() == saved_layout_bytes
              and open(report_path, "rb").read() == stable_report_bytes
              and open(output, "rb").read() == stable_output_bytes
              and open(os.path.join(workdir, "fixes.json"), "rb").read() == stable_fixes_bytes)

        # Recreate the exact on-disk state left by SIGKILL after committing only
        # fixes.json. Journal recovery must remove the aborted override.
        crash_token = f".block-999-{__import__('time').time_ns()}"
        crash_paths = ap._block_transaction_paths(workdir, output, crash_token)
        shutil.copy2(output, crash_paths["backup_out"])
        shutil.copy2(report_path, crash_paths["backup_report"])
        shutil.copy2(os.path.join(workdir, "fixes.json"), crash_paths["backup_fixes"])
        crash_journal = {
            "version": 1,
            "token": crash_token,
            "out": os.path.abspath(output),
            "had": {"out": True, "report": True, "fixes": True},
            "old_output_identity": ap._pdf_identity(output),
            "old_report_sha256": hashlib.sha256(stable_report_bytes).hexdigest(),
            "old_fixes_sha256": hashlib.sha256(stable_fixes_bytes).hexdigest(),
        }
        ap._write_json_atomic(os.path.join(workdir, ap.BLOCK_UPDATE_TXN_FILE), crash_journal)
        with open(os.path.join(workdir, "fixes.json"), "w", encoding="utf-8") as f:
            json.dump({sid: {"en": "aborted", "vi": "aborted"}}, f)
        recovery_events = []
        original_fsync_parent = ap._fsync_parent
        original_remove_quietly = ap._remove_quietly
        def observe_recovery_fsync(path):
            recovery_events.append(("fsync", path))
            return original_fsync_parent(path)
        def observe_recovery_remove(path):
            if path == os.path.join(workdir, ap.BLOCK_UPDATE_TXN_FILE):
                recovery_events.append(("remove-journal", path))
            return original_remove_quietly(path)
        try:
            ap._fsync_parent = observe_recovery_fsync
            ap._remove_quietly = observe_recovery_remove
            recovered = ap._recover_block_update_transaction(workdir, output)
        finally:
            ap._remove_quietly = original_remove_quietly
            ap._fsync_parent = original_fsync_parent
        check("write-ahead journal recovers a killed partial commit", recovered)
        journal_path = os.path.join(workdir, ap.BLOCK_UPDATE_TXN_FILE)
        remove_index = recovery_events.index(("remove-journal", journal_path))
        check("recovery makes all restored artifacts durable before journal removal",
              recovery_events.index(("fsync", output)) < remove_index
              and recovery_events.index(("fsync", crash_paths["report"])) < remove_index
              and recovery_events.index(("fsync", journal_path)) > remove_index,
              str(recovery_events))
        check("recovery removes aborted override and journal",
              open(os.path.join(workdir, "fixes.json"), "rb").read() == stable_fixes_bytes
              and open(report_path, "rb").read() == stable_report_bytes
              and open(output, "rb").read() == stable_output_bytes
              and not os.path.exists(os.path.join(workdir, ap.BLOCK_UPDATE_TXN_FILE)))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def t_block_update_preserves_missing_neighbor():
    print("\n── partial page with untranslated neighbor ──")
    root = tempfile.mkdtemp(prefix="cfa_block_missing_")
    try:
        source = os.path.join(root, "source.pdf")
        output = os.path.join(root, "output.pdf")
        workdir = os.path.join(root, "work")
        missing_text = "This untranslated neighbor must remain in English after the nearby block changes."
        doc = fitz.open()
        p = doc.new_page(width=420, height=280)
        p.insert_textbox(fitz.Rect(30, 35, 390, 110),
                         "A translated paragraph on the first page establishes global IDs.", fontsize=11)
        p = doc.new_page(width=420, height=280)
        p.insert_textbox(fitz.Rect(30, 35, 390, 110),
                         "The editable translated paragraph is on the second page.", fontsize=11)
        p.insert_textbox(fitz.Rect(30, 145, 390, 220), missing_text, fontsize=11)
        doc.save(source)
        doc.close()

        ap.cmd_chunk(source, workdir, size=10)
        layout = json.load(open(os.path.join(workdir, "layout.json")))["layout"]
        page_ids = [item["id"] for item in layout if item["page"] == 1]
        chunks = []
        for name in sorted(os.listdir(os.path.join(workdir, "chunks"))):
            chunks.extend(json.load(open(os.path.join(workdir, "chunks", name))))
        translations = {
            item["text"]: f"Bản dịch cho {item['id']}."
            for item in chunks if item["text"] != missing_text
        }
        with open(os.path.join(workdir, "text2vi.json"), "w", encoding="utf-8") as f:
            json.dump(translations, f, ensure_ascii=False)
        ap.cmd_apply(source, workdir, output)
        report_path = os.path.join(workdir, "render_report.json")
        before = json.load(open(report_path))
        target_id, missing_id = page_ids
        check("fixture report records global missing id", missing_id in before["missing_ids"])

        ap.cmd_block_update(source, workdir, output, target_id, "Bản dịch chỉnh tay trên trang hai.")
        after = json.load(open(report_path))
        rendered = fitz.open(output)
        page_text = rendered[1].get_text()
        rendered.close()
        check("missing neighbor remains English",
              " ".join(missing_text.split()) in " ".join(page_text.split()), page_text)
        check("global missing ids remain exact", after["missing_ids"] == before["missing_ids"])
        check("missing neighbor is not invented in report",
              missing_id not in {entry["id"] for entry in after["segments"]})
        check("edited global id remains on target page",
              next(entry for entry in after["segments"] if entry["id"] == target_id)["page"] == 1)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main():
    t_preflight_classes()
    t_native_profile_gate()
    t_raster_budget()
    t_render_report()
    t_apply_persists_report()
    t_block_update_roundtrip()
    t_block_update_preserves_missing_neighbor()
    if FAIL:
        print(f"\nFAILED {len(FAIL)}: {FAIL}")
        return 1
    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
