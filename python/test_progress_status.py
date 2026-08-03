#!/usr/bin/env python3
"""test_progress_status.py — unit tests for honest progress accounting.

Drives the real helpers in agent_pipeline (_status, pending, overall_pct,
enrich issues) with synthetic workdirs. No PDF/agent required.

Chạy: python3 test_progress_status.py
"""
import json
import os
import shutil
import sys
import tempfile

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


def _wd():
    d = tempfile.mkdtemp(prefix="cfa_prog_")
    return d


def t_overall_pct():
    print("\n── overall_pct sequential ──")
    check("done=100", ap._overall_pct("done", [0, 7], [0, 0], [0, 0]) == 100)
    check("translate 0/7 = 0", ap._overall_pct("translate", [0, 7], [242, 243], [624, 624]) == 0)
    check("translate half ~20",
          ap._overall_pct("translate", [1, 2], [0, 0], [0, 0]) == 20)
    check("verify mid in 40-70",
          40 <= ap._overall_pct("verify", [10, 10], [5, 10], [0, 100]) <= 70)
    check("vision mid in 70-95",
          70 <= ap._overall_pct("vision", [10, 10], [10, 10], [50, 100]) <= 95)
    check("review=95 never 100", ap._overall_pct("review", [1, 1], [1, 1], [1, 1]) == 95)
    # Near-complete vision artifacts must NOT yield ~100 while still translating
    pct = ap._overall_pct("translate", [0, 7], [242, 243], [624, 624])
    check("stale vision not near-100 while translate", pct < 10, f"got {pct}")


def t_valid_out_partial_and_empty():
    print("\n── valid out / partial / empty ──")
    wd = _wd()
    try:
        items = [{"id": "t0", "text": "Hello"}, {"id": "t1", "text": "World"}]
        _write(os.path.join(wd, "chunks", "c_000.json"), items)
        # missing out
        check("no out -> not valid", not ap._is_valid_out(wd, "000"))
        # empty dict
        _write(os.path.join(wd, "out", "c_000.json"), {})
        check("empty out -> not valid", not ap._is_valid_out(wd, "000"))
        # partial (missing id)
        _write(os.path.join(wd, "out", "c_000.json"), {"t0": "Xin chào"})
        check("partial out -> not valid", not ap._is_valid_out(wd, "000"))
        # empty string vi
        _write(os.path.join(wd, "out", "c_000.json"), {"t0": "Xin chào", "t1": "  "})
        check("blank vi -> not valid", not ap._is_valid_out(wd, "000"))
        # full
        _write(os.path.join(wd, "out", "c_000.json"),
               {"t0": "Xin chào", "t1": "Thế giới"})
        check("full out -> valid", ap._is_valid_out(wd, "000"))
        # corrupt
        open(os.path.join(wd, "out", "c_000.json"), "w").write("{not json")
        check("corrupt out -> not valid", not ap._is_valid_out(wd, "000"))
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def t_valid_vout_and_vis():
    print("\n── valid vout / vis ──")
    wd = _wd()
    try:
        _write(os.path.join(wd, "vchunks", "v_000.json"),
               [{"id": "v0", "en": "a", "vi": "b"}])
        _write(os.path.join(wd, "vout", "v_000.json"), {})  # empty = no corrections OK
        check("empty vout dict valid", ap._is_valid_vout(wd, "000"))
        _write(os.path.join(wd, "vout", "v_000.json"), {"v0": "bb"})
        check("nonempty vout valid", ap._is_valid_vout(wd, "000"))
        open(os.path.join(wd, "vout", "v_000.json"), "w").write("[1,2]")
        check("list vout invalid", not ap._is_valid_vout(wd, "000"))

        _write(os.path.join(wd, "vis", "page_000.json"), [])
        check("empty list vis valid", ap._is_valid_vis(wd, 0))
        _write(os.path.join(wd, "vis", "page_001.json"),
               [{"page": 1, "kind": "defect", "severity": "high", "detail": "x"}])
        check("list-with-issues vis valid", ap._is_valid_vis(wd, 1))
        _write(os.path.join(wd, "vis", "page_002.json"), {"not": "list"})
        check("dict vis invalid", not ap._is_valid_vis(wd, 2))
        check("missing vis invalid", not ap._is_valid_vis(wd, 9))
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def t_status_rechunk_stale_vision():
    """Simulate force-rechunk: out empty, chunks reduced, vis full from old run."""
    print("\n── status after force-rechunk (stale vision) ──")
    wd = _wd()
    try:
        # 2 new chunks, 0 out — stamp new chunk_gen, later stages NOT matching
        for i in range(2):
            _write(os.path.join(wd, "chunks", f"c_{i:03d}.json"),
                   [{"id": f"t{i}", "text": f"Text {i}"}])
        cg = ap._chunk_gen(wd)
        _write(os.path.join(wd, "workset.json"),
               {"chunk_gen": cg, "vchunk_gen": "", "vision_gen": ""})
        # old verify almost complete (stale gen)
        for i in range(3):
            _write(os.path.join(wd, "vchunks", f"v_{i:03d}.json"),
                   [{"id": f"v{i}", "en": "e", "vi": "v"}])
            _write(os.path.join(wd, "vout", f"v_{i:03d}.json"), {})
        # old vision "complete"
        os.makedirs(os.path.join(wd, "vis"), exist_ok=True)
        for i in range(5):
            _write(os.path.join(wd, "vis", f"page_{i:03d}.json"), [])
        # page count via state.json cache (no real PDF)
        _write(os.path.join(wd, "state.json"),
               {"stage": "x", "vision": [5, 5], "translate": [0, 2], "verify": [0, 0]})
        _write(os.path.join(wd, "layout.json"), {"pdf": "/no/such.pdf", "layout": []})
        # review_issues present so old code could jump to review/done
        _write(os.path.join(wd, "review_issues.json"), [])

        st = ap._status(wd)
        check("stage=translate", st["stage"] == "translate", f"got {st['stage']}")
        check("tr=0/2", st["translate"] == [0, 2], f"got {st['translate']}")
        # later stages must NOT show as complete
        check("verify done gated to 0", st["verify"][0] == 0, f"got {st['verify']}")
        check("vision done gated to 0", st["vision"][0] == 0, f"got {st['vision']}")
        check("vision denom keeps pages", st["vision"][1] == 5, f"got {st['vision']}")
        check("overall not near 100", st["overall_pct"] < 10, f"got {st['overall_pct']}")
        check("not done", st["stage"] != "done")
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def t_status_rechunk_refill_outs_stale_later():
    """Skeptic case: after force-rechunk, outs are refilled but old vout/vis remain
    → must NOT report done / 100% (generation gate)."""
    print("\n── rechunk then refill outs; stale vout/vis must not complete ──")
    wd = _wd()
    try:
        # --- generation A: fully "done" looking files ---
        _write(os.path.join(wd, "chunks", "c_000.json"),
               [{"id": "t0", "text": "Old A"}])
        _write(os.path.join(wd, "out", "c_000.json"), {"t0": "Cũ A"})
        for i in range(2):
            _write(os.path.join(wd, "vchunks", f"v_{i:03d}.json"),
                   [{"id": f"v{i}", "en": "e", "vi": "v"}])
            _write(os.path.join(wd, "vout", f"v_{i:03d}.json"), {})
        for i in range(3):
            _write(os.path.join(wd, "vis", f"page_{i:03d}.json"), [])
        _write(os.path.join(wd, "review_issues.json"), [])
        _write(os.path.join(wd, "state.json"), {"vision": [3, 3]})
        _write(os.path.join(wd, "layout.json"), {"pdf": "/no/such.pdf"})
        gen_a = ap._chunk_gen(wd)
        _write(os.path.join(wd, "workset.json"),
               {"chunk_gen": gen_a, "vchunk_gen": gen_a, "vision_gen": gen_a})
        st_a = ap._status(wd)
        check("gen A can be done", st_a["stage"] == "done", f"got {st_a}")

        # --- force-rechunk simulation: NEW chunks, outs refilled, later stages LEFT ---
        # (even if invalidate failed / partial — status must still gate)
        _write(os.path.join(wd, "chunks", "c_000.json"),
               [{"id": "t0", "text": "New text after rechunk"}])
        _write(os.path.join(wd, "chunks", "c_001.json"),
               [{"id": "t1", "text": "Second new chunk"}])
        # refill outs completely (translate "finished")
        _write(os.path.join(wd, "out", "c_000.json"),
               {"t0": "Văn bản mới sau rechunk"})
        _write(os.path.join(wd, "out", "c_001.json"),
               {"t1": "Chunk hai mới"})
        gen_b = ap._chunk_gen(wd)
        check("gen changed after rechunk", gen_b != gen_a, f"{gen_a[:8]} vs {gen_b[:8]}")
        # workset after chunk --force: new chunk_gen, later gens cleared
        # but STALE vout/vis/review_issues still on disk (skeptic residual)
        _write(os.path.join(wd, "workset.json"),
               {"chunk_gen": gen_b, "vchunk_gen": "", "vision_gen": ""})
        # leave old vchunks/vout/vis/review_issues untouched

        st = ap._status(wd)
        check("stage != done after refill", st["stage"] != "done", f"got {st}")
        check("overall != 100", st["overall_pct"] != 100, f"got {st['overall_pct']}")
        check("translate complete", st["translate"] == [2, 2], f"got {st['translate']}")
        check("verify not credited", st["verify"][0] == 0, f"got {st['verify']}")
        check("vision not credited", st["vision"][0] == 0, f"got {st['vision']}")
        check("stage is verify (need re-vchunk)", st["stage"] == "verify", f"got {st['stage']}")
        check("overall in translate/verify band", st["overall_pct"] <= 70,
              f"got {st['overall_pct']}")

        # Even if someone stamps old vchunk_gen wrongly equal to gen_a (not B):
        _write(os.path.join(wd, "workset.json"),
               {"chunk_gen": gen_b, "vchunk_gen": gen_a, "vision_gen": gen_a})
        st2 = ap._status(wd)
        check("wrong later gen still not done", st2["stage"] != "done", f"got {st2}")
        check("wrong later gen verify blocked", st2["verify"][0] == 0, f"got {st2['verify']}")

        # Same-second leftover files + empty stamp must NOT mtime-fallthrough to done
        for i in range(2):
            _write(os.path.join(wd, "vchunks", f"v_{i:03d}.json"),
                   [{"id": f"v{i}", "en": "e", "vi": "v"}])
            _write(os.path.join(wd, "vout", f"v_{i:03d}.json"), {})
        for i in range(3):
            _write(os.path.join(wd, "vis", f"page_{i:03d}.json"), [])
        _write(os.path.join(wd, "review_issues.json"), [])
        _write(os.path.join(wd, "workset.json"),
               {"chunk_gen": gen_b, "vchunk_gen": "", "vision_gen": ""})
        st3 = ap._status(wd)
        check("empty stamp no mtime false-done", st3["stage"] != "done", f"got {st3}")
        check("empty stamp overall!=100", st3["overall_pct"] != 100, f"got {st3}")
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def t_invalidate_later_stages():
    print("\n── invalidate later stages helper ──")
    wd = _wd()
    try:
        for sub, name in (("vchunks", "v_000.json"), ("vout", "v_000.json"),
                          ("vis", "page_000.json")):
            _write(os.path.join(wd, sub, name), [] if sub == "vis" else {})
        _write(os.path.join(wd, "review_issues.json"), [])
        _write(os.path.join(wd, "vid2en.json"), {})
        _write(os.path.join(wd, "workset.json"),
               {"chunk_gen": "x", "vchunk_gen": "x", "vision_gen": "x"})
        ap._invalidate_later_stages(wd, reason="test")
        check("vchunks gone", not os.path.isdir(os.path.join(wd, "vchunks"))
              or not os.listdir(os.path.join(wd, "vchunks")))
        check("vout gone", not os.path.isdir(os.path.join(wd, "vout"))
              or not os.listdir(os.path.join(wd, "vout")))
        check("vis page gone", not os.path.exists(os.path.join(wd, "vis", "page_000.json")))
        check("review_issues gone", not os.path.exists(os.path.join(wd, "review_issues.json")))
        ws = json.load(open(os.path.join(wd, "workset.json")))
        check("later gens cleared", not ws.get("vchunk_gen") and not ws.get("vision_gen"),
              f"got {ws}")
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def t_status_done_only_when_clean():
    print("\n── done only when complete + no open defects ──")
    wd = _wd()
    try:
        _write(os.path.join(wd, "chunks", "c_000.json"),
               [{"id": "t0", "text": "Hello"}])
        _write(os.path.join(wd, "out", "c_000.json"), {"t0": "Xin chào"})
        _write(os.path.join(wd, "vchunks", "v_000.json"),
               [{"id": "v0", "en": "Hello", "vi": "Xin chào"}])
        _write(os.path.join(wd, "vout", "v_000.json"), {})
        _write(os.path.join(wd, "vis", "page_000.json"), [])
        _write(os.path.join(wd, "state.json"), {"vision": [0, 1]})
        _write(os.path.join(wd, "layout.json"), {"pdf": "/no/such.pdf"})
        _write(os.path.join(wd, "review_issues.json"), [])
        cg = ap._chunk_gen(wd)
        _write(os.path.join(wd, "workset.json"),
               {"chunk_gen": cg, "vchunk_gen": cg, "vision_gen": cg})
        st = ap._status(wd)
        check("clean -> done", st["stage"] == "done", f"got {st}")
        check("overall 100", st["overall_pct"] == 100)

        # open medium defect -> review, not done
        _write(os.path.join(wd, "review_issues.json"), [{
            "page": 0, "kind": "defect", "severity": "medium",
            "detail": "chữ tràn khung bên phải",
        }])
        st = ap._status(wd)
        check("open defect -> review", st["stage"] == "review", f"got {st['stage']}")
        check("review overall 95", st["overall_pct"] == 95)
        check("defects count >=1", st["defects"] >= 1)

        # accept page -> done
        _write(os.path.join(wd, "accepted.json"), {"pages": [0], "notes": {}})
        st = ap._status(wd)
        check("accepted -> done", st["stage"] == "done", f"got {st['stage']}")
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def t_pending_matches_status():
    print("\n── pending aligns with valid-out rules ──")
    wd = _wd()
    try:
        items = [{"id": "t0", "text": "A"}, {"id": "t1", "text": "B"}]
        _write(os.path.join(wd, "chunks", "c_000.json"), items)
        _write(os.path.join(wd, "chunks", "c_001.json"),
               [{"id": "t2", "text": "C"}])
        # c_000 partial, c_001 complete
        _write(os.path.join(wd, "out", "c_000.json"), {"t0": "aa"})  # missing t1
        _write(os.path.join(wd, "out", "c_001.json"), {"t2": "cc"})
        # Capture pending without printing pollution: call internals
        pending = []
        for idx in ap._chunk_indices(wd, "chunks", "c_"):
            if not ap._is_valid_out(wd, idx):
                pending.append(idx)
        check("partial in pending", "000" in pending, f"got {pending}")
        check("complete not pending", "001" not in pending, f"got {pending}")
        co, c = ap._count_valid_out(wd)
        check("count valid out 1/2", (co, c) == (1, 2), f"got {(co, c)}")
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def t_enrich_issues():
    print("\n── needs-fix enrich cluster/channel ──")
    wd = _wd()
    try:
        issues = [
            {"page": 1, "kind": "defect", "severity": "high",
             "detail": "Mục bullet thứ 4 bị mất indent thụt lề"},
            {"page": 2, "kind": "defect", "severity": "medium",
             "detail": "chữ tràn khung sát viền phải"},
            {"page": 3, "kind": "fit", "severity": "low",
             "detail": "co chữ nhẹ"},
        ]
        enriched = ap._enrich_issues(wd, issues, pdf=None)
        by_page = {x["page"]: x for x in enriched}
        check("bullet -> bullet_indent/code",
              by_page[1].get("cluster") == "bullet_indent"
              and by_page[1].get("channel") == "code",
              f"got {by_page[1]}")
        check("tran -> tran_khung/text",
              by_page[2].get("cluster") == "tran_khung"
              and by_page[2].get("channel") == "text",
              f"got {by_page[2]}")
        check("fit still fit", by_page[3].get("kind") == "fit")
        # rule_for_detail pure
        n, ch = ap._rule_for_detail("bảng exhibit cột dồn")
        check("bang_vo rule", n == "bang_vo" and ch == "code")
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def t_merge_vis_skips_bad():
    print("\n── merge-vis skips corrupt vis ──")
    wd = _wd()
    try:
        _write(os.path.join(wd, "vis", "page_000.json"),
               [{"page": 0, "kind": "defect", "severity": "high",
                 "detail": "bullet indent mất"}])
        open(os.path.join(wd, "vis", "page_001.json"), "w").write("{bad")
        _write(os.path.join(wd, "vis", "page_002.json"), {"not": "list"})
        issues = ap.cmd_merge_vis(wd)
        check("merged 1 good issue", len(issues) == 1, f"got {len(issues)}")
        check("enriched cluster", issues[0].get("cluster") == "bullet_indent")
        on_disk = json.load(open(os.path.join(wd, "review_issues.json")))
        check("persisted enriched", on_disk[0].get("channel") == "code")
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def main():
    t_overall_pct()
    t_valid_out_partial_and_empty()
    t_valid_vout_and_vis()
    t_status_rechunk_stale_vision()
    t_status_rechunk_refill_outs_stale_later()
    t_invalidate_later_stages()
    t_status_done_only_when_clean()
    t_pending_matches_status()
    t_enrich_issues()
    t_merge_vis_skips_bad()
    print()
    if FAIL:
        print(f"FAILED {len(FAIL)}: {FAIL}")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
