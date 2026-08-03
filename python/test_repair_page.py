#!/usr/bin/env python3
"""Focused invariants for page-scoped repair helpers."""
import json
import os
import shutil
import sys
import tempfile

import fitz
import agent_pipeline as ap
import pdf_core


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)


def main():
    root = tempfile.mkdtemp(prefix="cfa_repair_page_")
    try:
        accepted = os.path.join(root, "accepted.json")
        cache = os.path.join(root, "defect_clusters.json")
        write_json(accepted, {
            "pages": [1, 3, 8],
            "notes": {"1": "keep", "3": "reopen", "8": "keep too"},
        })
        write_json(cache, {"stale": True})

        result = ap.cmd_reopen(root, "3")
        saved = json.load(open(accepted, encoding="utf-8"))
        assert result == {"pages": [3], "reopened": [3]}
        assert saved["pages"] == [1, 8]
        assert saved["notes"] == {"1": "keep", "8": "keep too"}
        assert not os.path.exists(cache)

        # Repeating is idempotent and must not disturb unrelated decisions.
        ap.cmd_reopen(root, "3")
        assert json.load(open(accepted, encoding="utf-8")) == saved

        # Ground truth: page 2 must retain its full-document segment IDs. A
        # page-only extraction restarts at s0, which must never leak into fixes.
        pdf = os.path.join(root, "source.pdf")
        doc = fitz.open()
        for text in (
            "The first page contains a sufficiently long paragraph for translation.",
            "The second page contains a different sufficiently long paragraph.",
        ):
            page = doc.new_page(width=400, height=300)
            page.insert_textbox(fitz.Rect(40, 50, 360, 200), text, fontsize=11)
        doc.save(pdf)
        doc.close()
        full = fitz.open(pdf)
        segments, layout = pdf_core.extract_segments(full, "all")
        full.close()
        assert len(segments) >= 2
        write_json(os.path.join(root, "layout.json"), {"pdf": pdf, "layout": layout})
        translations = {segment["text"]: f"VI::{segment['text']}" for segment in segments}
        write_json(os.path.join(root, "text2vi.json"), translations)

        expected = [item["id"] for item in layout if item["page"] == 1]
        mapped = ap._page_segments_map(pdf, root, {1})[1]
        assert [item["id"] for item in mapped] == expected
        assert set(expected).isdisjoint(
            item["id"] for item in layout if item["page"] == 0
        )

        # The latest apply report wins when its source/geometry match: apply
        # consumes these current IDs even if layout.json still has old IDs.
        page_one_local = [item for item in layout if item["page"] == 1]
        report = {
            "segments": [
                {
                    "id": f"current-{item['id']}",
                    "page": 1,
                    "box": item["box"],
                    "source": mapped_item["en"],
                    "translation": f"REPORT::{mapped_item['en']}",
                }
                for item, mapped_item in zip(page_one_local, mapped)
            ]
        }
        write_json(os.path.join(root, "render_report.json"), report)
        current = ap._page_segments_map(pdf, root, {1})[1]
        assert [item["id"] for item in current] == [f"current-{x}" for x in expected]
        os.remove(os.path.join(root, "render_report.json"))

        # A materially shifted block is ambiguous and must fail closed rather
        # than guess a neighbouring segment ID.
        altered = json.loads(json.dumps(layout))
        for item in altered:
            if item.get("page") == 1:
                item["box"][0] += 100
                item["box"][2] += 100
                break
        write_json(os.path.join(root, "layout.json"), {"pdf": pdf, "layout": altered})
        assert not ap._page_segments_map(pdf, root, {1}).get(1)
        write_json(os.path.join(root, "layout.json"), {"pdf": pdf + ".other", "layout": layout})
        assert not ap._page_segments_map(pdf, root, {1}).get(1)
        write_json(os.path.join(root, "layout.json"), {"pdf": pdf, "layout": layout})

        # Merge one repaired page and prove an unrelated existing override is
        # byte-for-byte preserved.
        target = mapped[0]
        write_json(os.path.join(root, "fixes.json"), {
            "s0": {"en": "unrelated", "vi": "không đổi"},
        })
        write_json(os.path.join(root, "fixout", "page_001.json"), {
            target["id"]: "OUTPUT CŨ KHÔNG ĐƯỢC TÁI DÙNG",
        })
        assert 1 in ap.cmd_page_segments(pdf, root, "1")
        assert not os.path.exists(os.path.join(root, "fixout", "page_001.json"))
        mapped = json.load(open(os.path.join(root, "fix", "page_001.json"), encoding="utf-8"))
        write_json(os.path.join(root, "fixout", "page_001.json"), {
            target["id"]: "Bản dịch mới của riêng trang hai",
        })
        # A stale checkpoint for page 0 must not be merged by a page-1 repair.
        write_json(os.path.join(root, "fix", "page_000.json"), [
            {"id": "s0", "en": "unrelated", "vi": "không đổi"},
        ])
        write_json(os.path.join(root, "fixout", "page_000.json"), {
            "s0": "DỊCH SAI TỪ CHECKPOINT CŨ",
        })
        ap.cmd_merge_fix(root, "1")
        fixes = json.load(open(os.path.join(root, "fixes.json"), encoding="utf-8"))
        assert fixes["s0"] == {"en": "unrelated", "vi": "không đổi"}
        assert fixes[target["id"]]["vi"] == "Bản dịch mới của riêng trang hai"
        print("ALL PASS: repair stays page-scoped and preserves unrelated overrides")
        return 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
