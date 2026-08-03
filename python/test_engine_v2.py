#!/usr/bin/env python3
"""test_engine_v2.py — unit test cho engine render v2 (marker/{vN}/grid/html).
Chạy: python3 test_engine_v2.py  (exit 0 = pass hết; in từng case fail)."""
import sys

import pdf_core as pc

FAIL = []


def check(name, cond):
    if not cond:
        FAIL.append(name)
        print(f"  ✗ {name}")
    else:
        print(f"  ✓ {name}")


# ── check_markers ───────────────────────────────────────────────────────────
def t_check_markers():
    en = "Value {v1} rises with <i>g</i> and <b>rate</b> {v2}."
    check("giữ nguyên marker đúng",
          pc.check_markers(en, "Giá trị {v1} tăng theo <i>g</i> và <b>tỷ lệ</b> {v2}.")
          == "Giá trị {v1} tăng theo <i>g</i> và <b>tỷ lệ</b> {v2}.")
    check("sửa placeholder viết lệch ( v1 )/（v2）",
          pc.check_markers(en, "Giá trị { v1 } tăng <i>g</i> <b>x</b>（v2）.")
          == "Giá trị {v1} tăng <i>g</i> <b>x</b>{v2}.")
    check("mất placeholder -> None",
          pc.check_markers(en, "Giá trị {v1} tăng theo g.") is None)
    check("placeholder trùng -> None",
          pc.check_markers(en, "{v1} và {v1} với {v2}") is None)
    check("placeholder bịa (en không có) -> bị bỏ",
          pc.check_markers("Plain text.", "Chữ {v1} thường.") == "Chữ thường.")
    check("thẻ hỏng cặp -> strip thẻ đó",
          pc.check_markers("A <b>b</b> c.", "A <b>b c.") == "A b c.")
    check("thẻ bịa (en không có) -> strip",
          pc.check_markers("A b c.", "A <i>b</i> c.") == "A b c.")
    check("vi rỗng -> None", pc.check_markers("x", "") is None)


# ── strip_markers ───────────────────────────────────────────────────────────
def t_strip():
    check("strip đủ loại marker",
          pc.strip_markers("a <b>x</b> {v1} <sup>2</sup> b") == "a x 2 b")


# ── _line_markup: span tổng hợp ─────────────────────────────────────────────
def _sp(text, x0, x1, size=10.0, font="KeplerStd", flags=0, y0=100.0, y1=110.0):
    return {"text": text, "bbox": [x0, y0, x1, y1], "size": size,
            "font": font, "flags": flags, "color": 0}


def t_markup():
    fx = []
    spans = [_sp("rate of ", 10, 50), _sp("g", 50, 55, font="Kepler-Italic"),
             _sp(" per period", 55, 110)]
    out = pc._line_markup(spans, 10.0, fx)
    check("italic giữa câu -> <i> + space từ text gốc",
          out == "rate of <i>g</i> per period")
    check("không sinh fx cho italic thường", fx == [])

    fx = []
    spans = [_sp("value ", 10, 40), _sp("σ", 40, 46, size=6.5),
             _sp("2", 46, 50, size=6.5), _sp(" is large enough here", 50, 140)]
    out = pc._line_markup(spans, 10.0, fx)
    check("run toán lệch cỡ -> {v1}", out == "value {v1} is large enough here")
    check("fx có 1 rect", len(fx) == 1)

    fx = []
    spans = [_sp("in the market", 10, 80), _sp("3", 80, 84, flags=1),
             _sp(" and more text follows here", 84, 200)]
    out = pc._line_markup(spans, 10.0, fx)
    check("footnote superscript -> <sup>",
          out == "in the market<sup>3</sup> and more text follows here")

    # coverage guard: run >=60% ký tự dòng -> giữ dạng chữ, không {vN}
    fx = []
    spans = [_sp("x", 10, 12), _sp("Σ(1+r)·β≥σ", 12, 80, size=6.0)]
    out = pc._line_markup(spans, 10.0, fx)
    check("run quá lớn -> không đổi thành {vN}", "{v" not in out and fx == [])


# ── grid table detector ─────────────────────────────────────────────────────
def _cell_line(y, x0, x1, text):
    # 1 Ô bảng = 1 LINE riêng (đúng cấu trúc sách: mỗi ô một line cùng hàng y)
    return {"spans": [_sp(text, x0, x1, y0=y, y1=y + 10)],
            "bbox": [x0, y, x1, y + 10]}


def t_grid():
    def table_rows(jitter=0):
        out = []
        for i in range(4):
            y = 100 + i * 15
            out += [_cell_line(y, 20, 60, "Item"),
                    _cell_line(y, 200 + (i % 2) * jitter, 240 + (i % 2) * jitter, "Alpha"),
                    _cell_line(y, 350, 380, "Beta")]
        return out

    pd = {"blocks": [{"type": 0, "lines": table_rows()}]}
    keys = pc._page_grid_keys(pd)
    check("bảng 3 cột x 4 hàng (ô = line riêng, tâm thẳng) -> bắt đủ 12 line",
          len(keys) == 12)

    prose = [_cell_line(100 + i * 14, 20, 300, "one long prose line of text")
             for i in range(6)]
    pd = {"blocks": [{"type": 0, "lines": prose}]}
    check("prose không trúng grid", pc._page_grid_keys(pd) == set())

    two = []
    for i in range(4):
        y = 100 + i * 14
        two += [_cell_line(y, 20, 60, "a"), _cell_line(y, 200, 240, "b")]
    pd = {"blocks": [{"type": 0, "lines": two + prose[:2]}]}
    check("2 cột không trúng (cần >=3 ô/hàng)", pc._page_grid_keys(pd) == set())

    pd = {"blocks": [{"type": 0, "lines": table_rows(jitter=60)}]}
    check("cột nhảy vị trí (không thẳng hàng) -> không trúng",
          pc._page_grid_keys(pd) == set())


# ── _seg_html ───────────────────────────────────────────────────────────────
def t_html():
    h = pc._seg_html("a < b & c > d", 10, 0, 1.2, None, None, 1.0, "x")
    check("escape <>&", "&lt;" in h and "&amp;" in h and "&gt;" in h)
    h = pc._seg_html("x {v1} y", 10, 0, 1.2, None, [[0, 0, 20, 10]], 0.8, "p_")
    check("{v1} -> img đúng prefix + scale",
          '<img src="p_1.png" style="width:16.00pt;height:8.00pt"/>' in h)
    h = pc._seg_html("mồ côi {v3} đây", 10, 0, 1.2, None, None, 1.0, "x")
    check("placeholder mồ côi bị bỏ", "{v3}" not in h and "img" not in h)
    h = pc._seg_html("<b>hỏng cặp", 10, 0, 1.2, None, None, 1.0, "x")
    check("thẻ hỏng cặp bị strip khi render", "<b>" not in h)
    h = pc._seg_html("t", 10, 255, 1.2, "j", None, 1.0, "x")
    check("màu + justify", "color:#0000ff" in h and "text-align:justify" in h)


# ── _mode_scale ─────────────────────────────────────────────────────────────
def t_mode():
    check("mode theo trọng số",
          abs(pc._mode_scale([(1.0, 10), (0.85, 500), (0.85, 400), (0.7, 50)]) - 0.84) < 0.03)
    check("rỗng -> 1.0", pc._mode_scale([]) == 1.0)


# ── highlight tier-2: re-draw highlight on translated box when ≥60% overlap ──
def t_highlight_tier2():
    import fitz
    doc = fitz.open()
    page = doc.new_page(width=400, height=200)
    # English-like text in a known rect
    box = fitz.Rect(50, 50, 300, 80)
    page.insert_textbox(box, "Sample English sentence for highlight test.",
                        fontsize=11, fontname="helv")
    # Highlight covering most of that rect
    hl = page.add_highlight_annot(fitz.Rect(50, 50, 290, 78))
    hl.set_colors(stroke=[1, 1, 0])
    hl.update()
    # Fake layout item covering same region (as extract would)
    layout = [{
        "id": "s0", "page": 0,
        "redact": [[50, 50, 300, 80]],
        "box": [50, 50, 300, 95],
        "size": 11, "color": 0, "lh": 1.12, "align": None, "fx": None,
    }]
    before = sum(1 for a in (page.annots() or []) if a.type[1] == "Highlight")
    check("before apply: 1 highlight", before == 1)
    applied, _miss = pc.apply_translations(
        doc, layout, {"s0": "Câu tiếng Việt để kiểm tra highlight tier-2."})
    check("applied segment", applied == 1)
    after = [a for a in (page.annots() or []) if a.type[1] == "Highlight"]
    check("tier-2 redraw: still has ≥1 highlight", len(after) >= 1)
    if after:
        inter = after[0].rect & fitz.Rect(layout[0]["box"])
        check("new highlight overlaps translated box", inter.get_area() > 0)


# ── highlight tier-1: annot on non-redacted region is kept ──
def t_highlight_tier1_keep():
    import fitz
    doc = fitz.open()
    page = doc.new_page(width=400, height=200)
    page.insert_textbox(fitz.Rect(50, 50, 200, 80), "Translated area",
                        fontsize=11, fontname="helv")
    page.insert_textbox(fitz.Rect(220, 50, 380, 80), "Formula kept",
                        fontsize=11, fontname="helv")
    # Highlight only on formula region (no overlap with redact)
    hl = page.add_highlight_annot(fitz.Rect(220, 50, 370, 75))
    hl.update()
    layout = [{
        "id": "s0", "page": 0,
        "redact": [[50, 50, 200, 80]],
        "box": [50, 50, 200, 95],
        "size": 11, "color": 0, "lh": 1.12, "align": None, "fx": None,
    }]
    pc.apply_translations(doc, layout, {"s0": "Vùng đã dịch"})
    after = [a for a in (page.annots() or []) if a.type[1] == "Highlight"]
    check("tier-1: highlight trên vùng giữ nguyên còn lại", len(after) >= 1)


# ── same-y prefix stitch (chu_de_chong p25/p101: bold term + X̄ split) ─────
def _blk(lines, bbox, typ=0):
    """Synthetic PyMuPDF-like block for stitch unit tests."""
    return {"type": typ, "bbox": bbox, "lines": lines}


def _ln(spans, bbox):
    return {"spans": spans, "bbox": bbox, "wmode": 0, "dir": (1, 0)}


def t_same_y_stitch():
    """Pure logic: prefix non-prose on same y as prose next → merged once."""
    body = 10.0
    # prefix: "The harmonic mean, _" (bold dominant → not prose)
    pref_spans = [
        _sp("The ", 174, 192, size=10, font="WarnockPro-Regular", flags=4,
            y0=697, y1=712),
        _sp("harmonic mean", 193, 265, size=10, font="MyriadPro-Bold", flags=20,
            y0=697, y1=709),
        _sp(", ", 265, 273, size=10, font="WarnockPro-Regular", flags=4,
            y0=697, y1=712),
        _sp("_", 272, 279, size=11.7, font="WarnockPro-Regular", flags=5,
            y0=689, y1=703),
    ]
    # next: "X_H, is another measure of central tendency here enough words."
    nxt_spans = [
        _sp("X", 271, 280, size=10, font="WarnockPro-It", flags=6, y0=697, y1=712),
        _sp("H", 279, 285, size=8, font="WarnockPro-It", flags=6, y0=702, y1=714),
        _sp(", is another measure of central tendency here enough words ok.",
            285, 530, size=10, font="WarnockPro-Regular", flags=4, y0=697, y1=712),
    ]
    pref = _blk([_ln(pref_spans, [174, 689, 279, 712])], [174, 689, 279, 712])
    nxt = _blk([_ln(nxt_spans, [271, 697, 530, 712])], [271, 697, 530, 712])
    # sanity: prefix not prose, next is prose
    check("prefix synthetic không prose", not pc._is_prose_block(pref, body))
    check("next synthetic là prose", pc._is_prose_block(nxt, body))
    check("same-y prefix nhận diện", pc._is_same_y_prefix(pref, nxt, body))

    stitched = pc._stitch_same_y_blocks([pref, nxt], body)
    check("stitch gộp còn 1 block", len(stitched) == 1)
    merged_txt = pc._block_text(stitched[0])
    check("merged chứa prefix 'harmonic mean'", "harmonic mean" in merged_txt)
    check("merged có continuation 'another measure'", "another measure" in merged_txt)
    check("merged vẫn prose sau gộp", pc._is_prose_block(stitched[0], body))

    # negative: pure large heading must NOT stitch into next
    head_spans = [
        _sp("The Harmonic Mean", 174, 287, size=13, font="MyriadPro-Semibold",
            flags=20, y0=675, y1=691),
    ]
    head = _blk([_ln(head_spans, [174, 675, 287, 691])], [174, 675, 287, 691])
    check("heading lớn không same-y-prefix",
          not pc._is_same_y_prefix(head, nxt, body))

    # merge same-y lines: overline + X → 1 line
    lines = [
        _ln(pref_spans, [174, 689, 279, 712]),
        _ln(nxt_spans, [271, 697, 530, 712]),
    ]
    merged_lines = pc._merge_same_y_lines(lines)
    check("merge_same_y_lines gộp 2→1", len(merged_lines) == 1)
    check("span đã sort theo x",
          merged_lines[0]["spans"][0]["bbox"][0]
          <= merged_lines[0]["spans"][-1]["bbox"][0])


def t_formula_fragment_prose_tail():
    """'3.' đuôi câu không phải mảnh công thức; '10' tử phân số vẫn là fragment."""
    body = 10.0
    # sentence-ending number on its own line (p100 kurtosis)
    line_3 = _ln([_sp("3.", 126, 140, size=10, font="WarnockPro-Regular", flags=4,
                      y0=221, y1=236)], [126, 221, 140, 236])
    check("'3.' không phải formula fragment",
          not pc._line_is_formula_fragment(line_3, body))
    # bare numerator-like token without sentence punctuation
    line_10 = _ln([_sp("10", 200, 215, size=10, font="WarnockPro-Regular", flags=4,
                       y0=100, y1=112)], [200, 100, 215, 112])
    check("'10' vẫn là formula fragment (tử phân số)",
          pc._line_is_formula_fragment(line_10, body))
    # overline bar still fragment
    line_bar = _ln([_sp("_", 272, 279, size=11.7, font="WarnockPro-Regular", flags=5,
                        y0=689, y1=703)], [272, 689, 279, 703])
    check("overline '_' vẫn fragment",
          pc._line_is_formula_fragment(line_bar, body))


def t_kurtosis_tail_real_pdf():
    """p100: kurtosis bullet includes trailing '3.'; no orphan formula cut."""
    import os
    src = "/Users/khanhnm/Desktop/translate/2024 CFA L1 Curriculum/2024 L1V1.pdf"
    if not os.path.exists(src):
        print("  (bỏ qua kurtosis real-pdf — thiếu PDF nguồn)")
        return
    import fitz
    doc = fitz.open(src)
    segs, layout = pc.extract_segments(doc, "100")
    s1 = next((s for s in segs if "Kurtosis measures" in s["text"]), None)
    check("p100 có segment Kurtosis", s1 is not None)
    if s1:
        check("p100 kurtosis kết thúc bằng 'is 3.'",
              s1["text"].rstrip().endswith("is 3."))
        lay = next(L for L in layout if L["id"] == s1["id"])
        # box must cover the '3.' line (~y221-236)
        check("p100 box.y1 phủ dòng '3.' (~236)", lay["box"][3] >= 230)
        # no separate short segment that is just '3.'
        orphans = [s for s in segs if s["text"].strip() in ("3.", "3")]
        check("p100 không còn segment orphan '3.'", orphans == [])


def t_same_y_stitch_real_pdf():
    """Shipped extract_segments on v1 p25/p101: prefix+X̄ gộp, redact phủ prefix."""
    import os
    src = "/Users/khanhnm/Desktop/translate/2024 CFA L1 Curriculum/2024 L1V1.pdf"
    if not os.path.exists(src):
        print("  (bỏ qua real-pdf stitch — thiếu PDF nguồn)")
        return
    import fitz
    doc = fitz.open(src)
    segs, layout = pc.extract_segments(doc, "25")
    s1 = next((s for s in segs if "harmonic mean" in s["text"].lower()
               and "another measure" in s["text"].lower()), None)
    check("p25: segment gộp 'The harmonic mean' + continuation", s1 is not None)
    if s1:
        check("p25: có {vN} cho X̄ inline", "{v" in s1["text"])
        lay = next(L for L in layout if L["id"] == s1["id"])
        # prefix overline/bold starts ~y688 — box must cover it
        check("p25: box.y0 phủ vùng prefix (~688)", lay["box"][1] < 692)
        check("p25: ≥1 redact rect", len(lay["redact"]) >= 1)

    segs, layout = pc.extract_segments(doc, "101")
    s3 = next((s for s in segs if "Sample Mean Formula" in s["text"]
               and "X-bar" in s["text"]), None)
    check("p101: segment gộp Sample Mean Formula + X-bar", s3 is not None)
    if s3:
        check("p101: có {vN}", "{v" in s3["text"])
        lay = next(L for L in layout if L["id"] == s3["id"])
        check("p101: box.y0 phủ prefix (~483)", lay["box"][1] < 490)


# ── determinism end-to-end (2 trang thật) ──────────────────────────────────
def t_determinism():
    import hashlib
    import fitz
    src = "/Users/khanhnm/Desktop/translate/2024 CFA L1 Curriculum/2024 L1V1.pdf"
    import os
    if not os.path.exists(src):
        print("  (bỏ qua determinism — thiếu PDF nguồn)")
        return
    sigs = []
    for _ in range(2):
        doc = fitz.open(src)
        segs, layout = pc.extract_segments(doc, "68,90")
        trans = {l["id"]: "‹VI› " + s["text"] for s, l in zip(segs, layout)}
        pc.apply_translations(doc, layout, trans)
        h = hashlib.md5()
        for p in (68, 90):
            h.update(doc[p].get_pixmap(dpi=96).tobytes("png"))
        sigs.append(h.hexdigest())
    check("apply deterministic (golden vẫn dùng được)", sigs[0] == sigs[1])


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("t_"):
            print(f"[{name}]")
            fn()
    print(f"\n{'PASS hết' if not FAIL else f'FAIL {len(FAIL)}: {FAIL}'}")
    sys.exit(1 if FAIL else 0)
