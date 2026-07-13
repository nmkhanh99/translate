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
