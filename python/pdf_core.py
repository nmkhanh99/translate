"""
pdf_core.py — Lõi xử lý PDF cho việc dịch GIỮ NGUYÊN layout.

Tách "cơ học PDF" (trích đoạn văn xuôi + ghi đè bản dịch giữ layout) khỏi
"ai dịch". Dùng chung cho MCP server (agent tự dịch) và CLI (engine dịch).

Hai kiểu trang được nhận diện THÍCH NGHI (không hard-code cho riêng PDF nào):
  • Trang VĂN XUÔI (sách volume): gom theo block đoạn văn (như cũ).
  • Trang DANH SÁCH có bullet (vd Topic Outlines, LOS có ô "□"): gom lại theo
    từng mục bullet dựng TỪ DÒNG, GIỮ NGUYÊN ký tự bullet (chỉ redact phần chữ),
    canh lề treo (hanging indent).

Mỗi mục layout dùng schema THỐNG NHẤT để apply:
  { id, page, redact:[[x0,y0,x1,y1],...], box:[l,t,r,b], size, color }
  - redact: các ô chữ cần xóa (KHÔNG gồm glyph bullet -> bullet được giữ lại).
  - box: vùng vẽ bản dịch (đã nới đáy tới phần tử kế dưới).

Heading / công thức / số liệu / bảng / đồ thị / hình -> KHÔNG đụng tới.
"""
import os
import re
import statistics

import fitz  # PyMuPDF

_WORD_RE = re.compile(r"[A-Za-z]{2,}")
_BULLET_CHARS = set("□❑▪■◾◼●◦‣•◻☐∙‚")  # ký tự đánh dấu mục (cả ô đặc/rỗng)
_LABEL_RE = re.compile(r"^[A-Za-z0-9]{1,2}[.)]$")  # nhãn đậm ngắn 'A.'/'B.'/'1.' đầu dòng
_COPYRIGHT_RE = re.compile(
    r"For candidate use only|©\s*CFA|©\s*\d{4}|All rights reserved|\bISBN\b", re.I)
_NUM_CELL = re.compile(r"^[\$\(\)–—\-\d.,%\s]+$")  # ô số trong bảng
_FORMULA_HEAD = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,4}\s*=")  # 'V0=', 'p1u =' ...
_MATH_CH = set("=+−-×÷/^()[]{}0123456789.,%$≤≥≠≈∑∫√·•")
# Ký hiệu HÀM Ý mạnh là toán (tổng, căn, bất đẳng thức, mũi tên, sigma...).
_STRONG_MATH = set("∑∫√≤≥≠≈×÷⁄·∞±→∂∏σµ")


def _is_formula_like(txt):
    """True nếu đoạn là DÒNG/MẢNH công thức (đừng dịch kẻo vỡ phân số/biến).
    High-precision, 3 đường:
      1. Dòng ngắn mở đầu 'biến =' nhiều ký hiệu.
      2. Dòng ngắn gần như toàn số/ký hiệu (<=1 từ).
      3. Dòng (DÀI tuỳ ý) được NEO bởi '=' hoặc ký hiệu toán mạnh, nhiều ký hiệu
         toán và RẤT ÍT từ ngôn ngữ tự nhiên (<=2 từ >=4 chữ cái) — bắt các mảnh
         công thức mà PyMuPDF cắt vụn vì sub/superscript (Σ, phân số, P(...|...),
         Cov(...), σ²(...)). Câu prose thật luôn có >2 từ dài nên không trúng."""
    t = txt.strip()
    if not t:
        return False
    math = sum(c in _MATH_CH for c in t)
    letters = sum(c.isalpha() for c in t)
    words = _WORD_RE.findall(t)
    if len(t) <= 50:
        if _FORMULA_HEAD.match(t) and math >= max(2, letters * 0.4):
            return True
        if len(words) <= 1 and math / max(len(t), 1) > 0.55:
            return True
    longw = sum(1 for w in words if len(w) >= 4)   # từ ngôn ngữ tự nhiên ứng viên
    has_strong = any(c in _STRONG_MATH for c in t)
    if (has_strong or "=" in t) and math >= 3 and longw <= 2:
        return True
    # Mảnh nối của công thức nhiều dòng (sub/superscript bị PyMuPDF cắt rời): KHÔNG
    # có từ ngôn ngữ tự nhiên nào (>=4 chữ) mà vẫn nhiều ký hiệu toán -> giữ nguyên.
    if longw == 0 and math >= 3 and len(words) <= 3:
        return True
    return False


# ---- Font Unicode hỗ trợ tiếng Việt: tự dò, có thể override ----
_FONT_CANDIDATES = [
    os.environ.get("CFA_TRANSLATE_FONT", ""),
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "/usr/share/fonts/truetype/noto/NotoSerif-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "C:/Windows/Fonts/times.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


def find_font():
    for p in _FONT_CANDIDATES:
        if p and os.path.exists(p):
            return p
    raise RuntimeError(
        "Không tìm thấy font Unicode hỗ trợ tiếng Việt. Đặt CFA_TRANSLATE_FONT "
        "trỏ tới 1 file .ttf (vd Times New Roman / Noto Serif)."
    )


# ====================================================================
#  Tiện ích đọc span / line / block
# ====================================================================
def _span_text(spans):
    return "".join(s["text"] for s in spans)


def _dominant(spans):
    """Span nhiều ký tự nhất (đại diện font/size/color)."""
    best, n = None, -1
    for s in spans:
        if len(s["text"]) > n:
            best, n = s, len(s["text"])
    return best


def _body_size(page_dict):
    """Cỡ chữ thân bài của trang = median theo số ký tự (robust)."""
    sizes = []
    for b in page_dict["blocks"]:
        if b.get("type") != 0:
            continue
        for ln in b.get("lines", []):
            for sp in ln.get("spans", []):
                k = len(sp["text"].strip())
                if k:
                    sizes.extend([round(sp["size"], 1)] * k)
    return statistics.median(sizes) if sizes else 10.0


def _is_copyright(txt):
    return bool(_COPYRIGHT_RE.search(txt))


def _heading_font(font):
    f = font.lower()
    return any(k in f for k in ("bold", "semibold", "black", "cond", "italic"))


def _is_code_font(font):
    """Font monospace (vd CourierStd) dùng cho code Excel/R/Python -> KHÔNG dịch,
    dịch sẽ phá cú pháp lệnh (vd 'CHISQ.INV(0.95,4)', 'from scipy.stats import ...')."""
    f = font.lower()
    return "courier" in f or "mono" in f or "consol" in f


# ====================================================================
#  Phân loại / nhận diện
# ====================================================================
def _num_cell(t):
    return bool(_NUM_CELL.match(t)) and any(c.isdigit() for c in t)


_TOC_NUM = re.compile(r"^[ivxlcdm\d]{1,4}$", re.I)  # số trang đứng riêng (la mã/ả rập)


def _is_toc_block(block):
    """Block MỤC LỤC: >=3 dòng số-trang đứng riêng, CĂN PHẢI ở block rộng (cột số
    trang bên phải). Dịch gộp sẽ phá cấu trúc 'tên mục … số trang'. Ràng buộc hình
    học (cột số căn phải) nên prose/công thức không khớp -> an toàn."""
    lines = block.get("lines", [])
    if len(lines) < 6:
        return False
    left = min(ln["bbox"][0] for ln in lines)
    right = max(ln["bbox"][2] for ln in lines)
    if right - left < 200:                      # phải là block rộng (toàn cột)
        return False
    thr = left + 0.72 * (right - left)
    hits = sum(1 for ln in lines
               if _TOC_NUM.match(_span_text(ln["spans"]).strip())
               and ln["bbox"][0] > thr)
    return hits >= 3




def _is_table_row(block):
    """True nếu block là 1 DÒNG BẢNG. Bắt cả 2 dạng PyMuPDF hay tách:
    (a) ô số nằm cùng dòng với nhãn nhưng cách 1 khoảng lớn (cột);
    (b) các con số mỗi cột là 1 'line' riêng nằm lệch phải (label + số rời dòng).
    Tránh dịch nhãn rồi kéo các con số ra khỏi cột."""
    lines = block["lines"]
    left = min((l["bbox"][0] for l in lines), default=0)
    num_lines = 0
    for ln in lines:
        full = _span_text(ln["spans"]).strip()
        if full and _num_cell(full):
            num_lines += 1
            if ln["bbox"][0] > left + 60:     # ô số lệch phải -> cột bảng
                return True
        prev_x1 = None
        for sp in ln["spans"]:
            t = sp["text"].strip()
            if not t:
                continue
            x0, x1 = sp["bbox"][0], sp["bbox"][2]
            if prev_x1 is not None and x0 - prev_x1 > 24 and _num_cell(t):
                return True
            prev_x1 = x1
    return num_lines >= 2


def _is_prose_block(block, body_size):
    """Block văn xuôi nên dịch (đường đi cho trang sách volume)."""
    txt = _block_text(block).strip()
    if len(txt) < 25 or _is_copyright(txt):
        return False
    if _is_formula_like(txt):                 # dòng công thức ngắn -> giữ nguyên
        return False
    if _is_toc_block(block):                  # mục lục (cột số căn phải) -> giữ nguyên
        return False
    sp = _dominant([s for ln in block["lines"] for s in ln["spans"]])
    if sp is None:
        return False
    if _heading_font(sp["font"]) or _is_code_font(sp["font"]) or sp["size"] > body_size * 1.12:
        return False
    if sp["size"] < 8.5:                  # chữ rất nhỏ -> nhãn đồ thị/trục/chú thích
        return False                       # (dịch dễ làm hỏng chart) -> giữ nguyên
    letters = sum(c.isalpha() for c in txt)
    if letters / max(len(txt), 1) < 0.55:
        return False
    if len(_WORD_RE.findall(txt)) < 5:
        return False
    if _is_table_row(block):                  # dòng bảng -> giữ nguyên, đừng phá cột
        return False
    return True


def _block_text(block):
    return "\n".join(_span_text(ln["spans"]) for ln in block.get("lines", []))


def _is_short_bold(spans, txt):
    sp = _dominant(spans)
    if sp is None or not _heading_font(sp["font"]):
        return False
    return 2 <= len(txt) <= 20 and len(_WORD_RE.findall(txt)) <= 3


def _row_columns(label, rest):
    """Từ 1 dòng NHÃN + các dòng còn lại của HÀNG đó -> list CỘT [[line,...],...]
    trái->phải (cột 0 = nhãn). None nếu dòng nào trong rest không lệch phải đủ xa
    nhãn (không phải cột khác, có thể là dòng-xuống-hàng thật của đoạn văn xuôi)."""
    label_x1 = label["bbox"][2]
    if any(ln["bbox"][0] < label_x1 + 15 for ln in rest):
        return None
    rest = sorted(rest, key=lambda ln: (ln["bbox"][0], ln["bbox"][1]))
    cols, cur_x = [], None
    for ln in rest:
        if cols and abs(ln["bbox"][0] - cur_x) < 10:
            cols[-1].append(ln)
        else:
            cols.append([ln])
            cur_x = ln["bbox"][0]
    for c in cols:
        c.sort(key=lambda ln: ln["bbox"][1])
    return [[label]] + cols


def _label_rows(block):
    """Nếu block là 1 HAY NHIỀU hàng dạng 'nhãn đậm ngắn (Step N/Bước N, tiêu đề
    cột...) | nội dung | [dữ liệu]' mà PyMuPDF gom vào 1 block (mỗi 'line' là 1 RUN
    lệch cột, không phải dòng-xuống-hàng thật của 1 đoạn văn) -> trả về LIST các
    HÀNG, mỗi hàng là list CỘT [[line,...],...] trái->phải (cột 0 = nhãn, GIỮ
    NGUYÊN không dịch). None nếu không khớp mẫu (chặn bởi: nhãn phải đậm+ngắn VÀ
    nằm SÁT MÉP TRÁI của block, mọi dòng còn lại trong hàng phải lệch phải xa nhãn
    -> đoạn văn xuôi bình thường xuống dòng ngay dưới nhãn sẽ không khớp; TỐI ĐA 20
    dòng/block -> mục lục CONTENTS không trúng; loại rõ bằng _is_toc_block).
    Đôi khi PyMuPDF gộp NHIỀU hàng thủ tục (Step 1 và Step 2...) vào 1 block ->
    tách theo từng dòng-nhãn-mép-trái thành nhiều hàng riêng.
    Sửa lỗi bảng thủ tục (Step 1..6 / Exhibit) bị dịch gộp thành 1 đoạn phẳng, mất
    cột và mất định dạng đậm của nhãn."""
    lines = block["lines"]
    if len(lines) < 2 or len(lines) > 20 or _is_toc_block(block):
        return None
    left_margin = min(ln["bbox"][0] for ln in lines)
    labels = [ln for ln in lines
              if ln["bbox"][0] <= left_margin + 3
              and _is_short_bold(ln["spans"], _span_text(ln["spans"]).strip())]
    if not labels:
        return None
    labels.sort(key=lambda ln: ln["bbox"][1])
    label_ids = {id(ln) for ln in labels}
    TOL = 10  # công thức cao (phân số/sub-superscript) có thể bắt đầu CAO HƠN nhãn
              # cùng hàng do canh giữa theo chiều dọc -> vẫn gán đúng hàng, không
              # rơi nhầm sang hàng TRƯỚC (fix cho block gộp nhiều hàng, vd Step 1+2)
    groups = [[] for _ in labels]
    for ln in lines:
        if id(ln) in label_ids:
            continue
        best = 0
        for k, lb in enumerate(labels):
            if lb["bbox"][1] <= ln["bbox"][1] + TOL:
                best = k
            else:
                break
        groups[best].append(ln)
    rows = []
    for lb, rest in zip(labels, groups):
        row = _row_columns(lb, rest)
        if row is not None:
            rows.append(row)
    return rows or None


def _col_text(lines):
    return "\n".join(_span_text(ln["spans"]) for ln in lines)


def _extract_label_row(cols, all_boxes, page_bottom, pno, segments, layout, ctr,
                        next_top=None):
    """Dịch riêng từng CỘT nội dung của 1 hàng nhãn+cột (mục 6, fix #9) — GIỮ NGUYÊN
    cột nhãn đậm (đúng quy ước 'heading/nhãn in đậm giữ nguyên tiếng Anh'), mỗi cột nội
    dung có khung riêng nên không đè lên cột kế / hàng kế. `next_top`: mép trên hàng
    KẾ TIẾP nếu nhiều hàng bị PyMuPDF gộp chung 1 block (vd Step 1 và Step 2 cùng
    block) -> all_boxes không thấy ranh giới này nên phải kẹp thủ công."""
    label_lines, content_cols = cols[0], cols[1:]
    if not content_cols:
        return
    row_rect = fitz.Rect(label_lines[0]["bbox"])
    for c in cols:
        for ln in c:
            row_rect |= fitz.Rect(ln["bbox"])
    for i, col in enumerate(content_cols):
        rect = fitz.Rect(col[0]["bbox"])
        for ln in col[1:]:
            rect |= fitz.Rect(ln["bbox"])
        txt = _col_text(col).strip()
        if len(txt) < 3 or _is_copyright(txt) or _is_formula_like(txt):
            continue
        sp = _dominant([s for ln in col for s in ln["spans"]])
        if sp is None or _heading_font(sp["font"]) or _is_code_font(sp["font"]):
            continue
        letters = sum(c2.isalpha() for c2 in txt)
        if letters / max(len(txt), 1) < 0.4:      # cột số/công thức thuần -> giữ nguyên
            continue
        bottom = _bottom_limit(rect, all_boxes, page_bottom)
        if next_top is not None:
            bottom = min(bottom, next_top - 2)
        for ob in all_boxes:
            if ob.y0 <= rect.y0 + 2 or ob.y0 >= bottom:
                continue
            if ob.x1 <= rect.x0 + 2 or ob.x0 >= rect.x1 - 2:
                continue
            bottom = min(bottom, ob.y0 - 2)
        right = rect.x1                            # không tràn sang cột kế bên phải
        if i + 1 < len(content_cols):
            right = max(right, min(ln["bbox"][0] for ln in content_cols[i + 1]) - 4)
        else:
            right = max(right, row_rect.x1)
        _emit(segments, layout, ctr, pno, _col_text(col),
              redact=[list(fitz.Rect(ln["bbox"])) for ln in col],
              box=[rect.x0, rect.y0, right, max(bottom, rect.y1)],
              size=sp["size"], color=sp["color"])


def _collect_lines(page_dict):
    """Phẳng hóa mọi dòng văn bản, sắp theo (y, x). Giữ `blk` = chỉ số BLOCK gốc để
    nhận continuation đúng dòng-xuống-hàng CỦA CÙNG 1 đoạn, không lẫn 2 mục/hàng
    khác nhau (vd 2 LOS liền kề trong bảng LEARNING OUTCOMES, mỗi mục 1 block
    riêng) chỉ vì chúng đứng gần nhau theo chiều dọc và không có bullet glyph."""
    out = []
    for bi, b in enumerate(page_dict["blocks"]):
        if b.get("type") != 0:
            continue
        for ln in b["lines"]:
            spans = ln["spans"]
            if not _span_text(spans).strip():
                continue
            out.append({"bbox": list(ln["bbox"]), "spans": spans, "blk": bi})
    out.sort(key=lambda L: (round(L["bbox"][1]), round(L["bbox"][0])))
    return out


def _bullet_idx(spans):
    """Chỉ số span là glyph bullet (ngắn, bắt đầu bằng ký tự bullet)."""
    for i, s in enumerate(spans):
        t = s["text"].strip()
        if t and t[0] in _BULLET_CHARS and len(t) <= 2:
            return i
    return -1


def _has_bullets(lines):
    return any(_bullet_idx(L["spans"]) >= 0 for L in lines)


def _label_span_idx(spans):
    """Chỉ số span là NHÃN đậm ngắn ('A.'/'B.'/'1.'...) đứng đầu dòng, đi liền
    (cùng 1 "line" PyMuPDF) với nội dung KHÔNG đậm (đáp án câu hỏi trắc nghiệm).
    Xử lý như glyph bullet (mục 6, fix #14): giữ nguyên đậm, không gộp phẳng
    khiến nhãn 'A./B./C.' mất định dạng in đậm khi redraw 1 cỡ/màu cho cả dòng."""
    if len(spans) < 2:
        return -1
    t0 = spans[0]["text"].strip()
    if not (_LABEL_RE.match(t0) and _heading_font(spans[0]["font"])):
        return -1
    rest = spans[1:]
    dom = _dominant(rest)
    if dom is None or _heading_font(dom["font"]):
        return -1          # cả dòng đều đậm -> heading thật, không phải nhãn+nội dung
    if len(_span_text(rest).strip()) < 3:
        return -1
    return 0


def _line_is_heading(line, body_size):
    sp = _dominant(line["spans"])
    return sp is None or _heading_font(sp["font"]) or sp["size"] > body_size * 1.12


# ====================================================================
#  Đáy khả dụng & màu
# ====================================================================
def _bottom_limit(rect, all_boxes, page_bottom):
    """Đáy khả dụng = mép trên của phần tử gần nhất nằm DƯỚI & giao ngang."""
    limit = page_bottom
    for b in all_boxes:
        if b.y0 <= rect.y1 + 1:
            continue
        if b.x1 <= rect.x0 or b.x0 >= rect.x1:
            continue
        limit = min(limit, b.y0 - 2)
    return max(limit, rect.y1)


def _int_color_to_rgb(c):
    return ((c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255)


def parse_pages(spec, total):
    if not spec or spec == "all":
        return list(range(total))
    out = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return [p for p in out if 0 <= p < total]


# ====================================================================
#  TRÍCH ĐOẠN
# ====================================================================
def extract_segments(doc, pages_spec):
    """Trả về (segments, layout). segment = {id, text}; layout = schema thống nhất."""
    pages = parse_pages(pages_spec, doc.page_count)
    segments, layout, ctr = [], [], [0]
    for pno in pages:
        page = doc[pno]
        pd = page.get_text("dict")
        body = _body_size(pd)
        all_boxes = [fitz.Rect(b["bbox"]) for b in pd["blocks"]]
        page_bottom = page.rect.height - 50
        lines = _collect_lines(pd)
        if _has_bullets(lines):
            _extract_bulleted(lines, body, all_boxes, page_bottom, pno,
                              segments, layout, ctr)
        else:
            _extract_blocky(pd, body, all_boxes, page_bottom, pno,
                            segments, layout, ctr)
    return segments, layout


def _emit(segments, layout, ctr, pno, text, redact, box, size, color):
    text = " ".join(text.split()).strip()
    if len(text) < 3:
        return
    sid = f"s{ctr[0]}"
    ctr[0] += 1
    segments.append({"id": sid, "text": text})
    layout.append({"id": sid, "page": pno, "redact": redact,
                   "box": box, "size": size, "color": color})


def _heading_split_runs(lines, body):
    """Tách dòng heading-like (đậm/lớn hơn thân bài, vd nhãn 'Solution:'/'Excel'/
    'Python' đứng riêng 1 dòng) ra khỏi phần văn xuôi/đáp án bao quanh khi chúng bị
    PyMuPDF gộp CHUNG 1 block (vd đáp án 'C. ...' rồi ngay dòng dưới là 'Solution:'
    trong cùng ô Question/Solution). Trả về list `(run, next_heading_line|None)`:
    run = list dòng văn xuôi liên tục cần dịch; next_heading_line = dòng heading
    NGAY SAU run đó (nếu có) để kẹp đáy khung, tránh bản dịch (dài hơn) đè lên nhãn.
    Dòng heading bản thân KHÔNG nằm trong run nào -> giữ nguyên (đúng quy ước nhãn
    in đậm giữ nguyên tiếng Anh), fix cho lỗi 'Solution:' bị dịch dính vào đáp án
    trước đó vì _is_prose_block chỉ xét span CHIẾM ĐA SỐ ký tự của cả block."""
    runs, cur = [], []
    for ln in lines:
        if _line_is_heading(ln, body):
            if cur:
                runs.append((cur, ln))
                cur = []
        else:
            cur.append(ln)
    if cur:
        runs.append((cur, None))
    return runs


def _extract_labeled_lines(lines, body, all_boxes, page_bottom, pno,
                            segments, layout, ctr):
    """Dịch riêng các dòng NHÃN ĐẬM+NỘI DUNG ('A. text'/'B. text'...) trong 1 block
    của đường đi blocky, giữ NGUYÊN glyph nhãn (không redact/dịch) — fix #15, tương
    đương _label_span_idx trong _extract_bulleted nhưng cho block không-bullet.
    Dòng KHÔNG-nhãn ngay sau 1 nhãn (đáp án dài xuống dòng) được gộp làm phần nội
    dung tiếp theo của nhãn đó; dòng heading (vd 'Solution:') đóng mục và được GIỮ
    NGUYÊN (không nằm trong item nào, đúng quy ước heading giữ nguyên tiếng Anh).
    Dòng văn xuôi KHÔNG-nhãn đứng riêng NGAY SAU 1 heading (vd đoạn giải thích ngay
    dưới 'Solution:') mở 1 item MỚI thay vì bị bỏ rơi (không có `cur` để nối vào)."""
    items, cur = [], None
    for ln in lines:
        bidx = _label_span_idx(ln["spans"])
        if bidx >= 0:
            if cur:
                items.append(cur)
            text_spans = [s for k, s in enumerate(ln["spans"]) if k != bidx]
            tx0 = min((s["bbox"][0] for s in text_spans), default=ln["bbox"][0])
            cur = {"lines": [ln], "spans": list(text_spans), "left": tx0}
        elif _line_is_heading(ln, body):
            if cur:
                items.append(cur)
            cur = None
        elif cur is not None:
            cur["lines"].append(ln)
            cur["spans"].extend(ln["spans"])
        else:
            cur = {"lines": [ln], "spans": list(ln["spans"]), "left": ln["bbox"][0]}
    if cur:
        items.append(cur)

    for it in items:
        txt = _span_text(it["spans"]).strip()
        if len(txt) < 3:
            continue
        tsp = _dominant(it["spans"])
        rect = fitz.Rect(it["lines"][0]["bbox"])
        for ln in it["lines"][1:]:
            rect |= fitz.Rect(ln["bbox"])
        last = it["lines"][-1]
        pos = lines.index(last)
        next_line = lines[pos + 1] if pos + 1 < len(lines) else None
        next_top = next_line["bbox"][1] if next_line is not None else page_bottom
        bottom = min(_bottom_limit(rect, all_boxes, page_bottom), next_top - 2)
        for ob in all_boxes:
            if ob.y0 <= rect.y0 + 2 or ob.y0 >= bottom:
                continue
            if ob.x1 <= rect.x0 + 2 or ob.x0 >= rect.x1 - 2:
                continue
            bottom = min(bottom, ob.y0 - 2)
        redact = [list(s["bbox"]) for s in it["spans"]]
        if next_line is not None and _line_is_heading(next_line, body):
            # trần redact = mép trên nhãn heading kế (bbox 2 dòng liền kề trong PDF
            # nguồn thường chồng lấn nhẹ theo chiều dọc) -> không ăn lẹm glyph (fix #13)
            ceiling = next_line["bbox"][1] - 1
            for r in redact:
                if r[3] > ceiling:
                    r[3] = ceiling
        _emit(segments, layout, ctr, pno, _span_text(it["spans"]),
              redact=redact,
              box=[it["left"], rect.y0, rect.x1, max(bottom, rect.y1)],
              size=tsp["size"], color=tsp["color"])


def _extract_blocky(pd, body, all_boxes, page_bottom, pno, segments, layout, ctr):
    """Đường đi trang VĂN XUÔI (sách volume)."""
    cands = []
    for b in pd["blocks"]:
        if b.get("type") != 0:
            continue
        rows = _label_rows(b)                       # hàng 'Step N | nội dung | dữ liệu'
        if rows is not None:
            for ri, cols in enumerate(rows):
                nt = rows[ri + 1][0][0]["bbox"][1] if ri + 1 < len(rows) else None
                _extract_label_row(cols, all_boxes, page_bottom, pno, segments, layout, ctr,
                                    next_top=nt)
            continue
        blines = b["lines"]
        if any(_label_span_idx(ln["spans"]) >= 0 for ln in blines):
            # Dòng NHÃN ĐẬM+NỘI DUNG cùng dòng (đáp án trắc nghiệm 'A. ...'/'B. ...') mà
            # PyMuPDF gom thành 1 block RIÊNG (trang không có bullet glyph nào khác nên
            # không đi qua _extract_bulleted) hoặc gộp chung block với dòng heading kế
            # ('Solution:') -> fix #15. Không có cơ chế này thì: (a) _is_prose_block xét
            # NGUYÊN CẢ BLOCK (word-count/length) làm rớt hẳn các đáp án ngắn, một mình
            # 1 dòng -> KHÔNG dịch (vẫn tiếng Anh); (b) nếu block đủ dài để qua được (vì
            # gộp chung dòng khác) thì dịch PHẲNG cả dòng, mất đậm nhãn 'A./B./C.' (đúng
            # lý do fix #14 xử lý ở _extract_bulleted, nhưng đường blocky chưa có).
            _extract_labeled_lines(blines, body, all_boxes, page_bottom, pno,
                                    segments, layout, ctr)
            continue
        if not _is_prose_block(b, body):
            continue
        for run, next_heading in _heading_split_runs(b["lines"], body):
            if not run:
                continue
            sp = _dominant([s for ln in run for s in ln["spans"]])
            if sp is None:
                continue
            rect = fitz.Rect(run[0]["bbox"])
            for ln in run[1:]:
                rect |= fitz.Rect(ln["bbox"])
            cands.append((run, sp, rect, next_heading))
    for run, sp, rect, next_heading in cands:
        bottom = _bottom_limit(rect, all_boxes, page_bottom)
        if next_heading is not None:      # nhãn heading NGAY SAU (cùng block gốc)
            bottom = min(bottom, next_heading["bbox"][1] - 2)
        # Kẹp đáy theo MÉP TRÊN của BẤT KỲ phần tử nào bắt đầu dưới mép-trên
        # block này và giao ngang: prose-block chồng nhau (bảng Learning
        # Outcomes) HOẶC công thức/ảnh mà nguồn đặt sát ngay dưới. _bottom_limit
        # bỏ sót phần tử bắt đầu ngay tại/trên đáy block nên bản dịch (dài hơn)
        # bị nới đè lên chúng.
        for ob in all_boxes:
            if ob.y0 <= rect.y0 + 2 or ob.y0 >= bottom:
                continue
            if ob.x1 <= rect.x0 + 2 or ob.x0 >= rect.x1 - 2:
                continue
            bottom = min(bottom, ob.y0 - 2)
        # Trần redact = mép trên nhãn heading kế tiếp (nếu có): bbox của các "line"
        # liền kề trong CÙNG 1 block PyMuPDF thường chồng lấn nhẹ theo chiều dọc
        # (ascender/descender) -> nếu redact đúng bbox thô của dòng cuối cùng có
        # thể ăn lẹm vào phần TRÊN của nhãn heading kế (cắt cụt "Solution:" ->
        # "Sol"). Kẹp cứng NGOÀI `bottom` (vốn có thể bị `max(bottom, rect.y1)`
        # nới ra ở box) để tuyệt đối không đụng nhãn.
        redact_ceiling = next_heading["bbox"][1] - 1 if next_heading is not None else None
        redact = []
        for ln in run:
            r = fitz.Rect(ln["bbox"])
            if redact_ceiling is not None and r.y1 > redact_ceiling:
                r.y1 = redact_ceiling
            redact.append(list(r))
        _emit(segments, layout, ctr, pno, "\n".join(_span_text(ln["spans"]) for ln in run),
              redact=redact,
              box=[rect.x0, rect.y0, rect.x1, max(bottom, rect.y1)],
              size=sp["size"], color=sp["color"])


def _merge_orphan_bullets(lines):
    """Một số PDF tách glyph bullet (vd ■) thành 1 'line' riêng, hơi lệch y so
    với dòng chữ đầu mục. Gộp glyph mồ côi đó vào dòng chữ cùng hàng (bên phải)
    để nó trở thành dòng-bullet bình thường."""
    body_lines, orphans = [], []
    for L in lines:
        spans = [s for s in L["spans"] if s["text"].strip()]
        t = spans[0]["text"].strip() if len(spans) == 1 else ""
        if t and t[0] in _BULLET_CHARS and len(t) <= 2:
            orphans.append(L)
        else:
            body_lines.append(L)
    for orb in orphans:
        oy = (orb["bbox"][1] + orb["bbox"][3]) / 2
        best, bestdy = None, 8
        for L in body_lines:
            ly = (L["bbox"][1] + L["bbox"][3]) / 2
            if abs(ly - oy) < bestdy and L["bbox"][0] >= orb["bbox"][0] - 2:
                best, bestdy = L, abs(ly - oy)
        if best is not None:
            best["spans"] = orb["spans"] + best["spans"]
            best["bbox"] = [min(best["bbox"][0], orb["bbox"][0]),
                            min(best["bbox"][1], orb["bbox"][1]),
                            best["bbox"][2], max(best["bbox"][3], orb["bbox"][3])]
        else:
            body_lines.append(orb)
    body_lines.sort(key=lambda L: (round(L["bbox"][1]), round(L["bbox"][0])))
    return body_lines


def _extract_bulleted(lines, body, all_boxes, page_bottom, pno,
                      segments, layout, ctr):
    """Đường đi trang DANH SÁCH bullet — dựng lại từng mục từ DÒNG.
    Giữ glyph bullet (không redact), canh lề treo."""
    lines = _merge_orphan_bullets(lines)
    body_lines = [L for L in lines
                  if not _line_is_heading(L, body) and not _is_copyright(_span_text(L["spans"]))]
    col_right = max((L["bbox"][2] for L in body_lines), default=500)

    items, cur = [], None

    def close(next_heading=None):
        nonlocal cur
        if cur:
            cur["next_heading"] = next_heading    # xem chú thích ở vòng emit dưới
            items.append(cur)
            cur = None

    for L in lines:
        txt = _span_text(L["spans"])
        if _is_copyright(txt) or _line_is_heading(L, body):
            close(L)
            continue
        bidx = _bullet_idx(L["spans"])
        if bidx < 0:
            bidx = _label_span_idx(L["spans"])
        sp = _dominant(L["spans"])
        lh = sp["size"] if sp else 10
        if bidx >= 0:
            close()
            text_spans = [s for k, s in enumerate(L["spans"]) if k != bidx]
            tx0 = min((s["bbox"][0] for s in text_spans), default=L["bbox"][0])
            tsp = _dominant(text_spans) or sp
            cur = {"lines": [L], "redact": [s["bbox"] for s in text_spans],
                   "text": [_span_text(text_spans)], "top": L["bbox"][1],
                   "last_y1": L["bbox"][3], "left": tx0,
                   "bullet_x": L["bbox"][0],
                   "size": tsp["size"], "color": tsp["color"]}
        elif (cur and L["bbox"][0] > cur["bullet_x"] - 6
              and L["bbox"][1] - cur["last_y1"] < lh * 1.8
              # dòng KHÔNG-bullet chỉ nối được vào 1 mục KHÔNG-bullet nếu CÙNG block
              # gốc (khác block = mục/hàng KHÁC đứng gần nhau, vd 2 LOS liền kề
              # trong bảng LEARNING OUTCOMES không có glyph bullet -> không được
              # gộp dù đứng gần theo chiều dọc). Mục có bullet giữ nguyên hành vi cũ.
              and (cur.get("blk") is None or L["blk"] == cur["blk"])):
            # dòng tiếp nối của mục hiện tại
            cur["lines"].append(L)
            cur["redact"].extend(s["bbox"] for s in L["spans"])
            cur["text"].append(txt)
            cur["last_y1"] = L["bbox"][3]
            cur["left"] = min(cur["left"], L["bbox"][0])
        else:
            # dòng body đứng một mình (đoạn văn không bullet chen giữa các mục, vd
            # đoạn INTRODUCTION ngay sau khối LEARNING OUTCOMES) -> mở mục MỚI làm
            # `cur` (KHÔNG chỉ append rời rạc) để các dòng SAU nối tiếp vào đúng
            # mục này qua nhánh continuation ở trên. Fix #10: trước đây nhánh này
            # không set `cur` nên MỌI dòng tiếp theo của đoạn cũng rơi vào đây ->
            # cả đoạn bị xé thành 1 segment/dòng, mỗi dòng tự co cỡ chữ riêng theo
            # khung 1-dòng chật của nó -> cỡ chữ nhảy lung tung + đè dòng kế trong
            # CÙNG một đoạn (nhóm lỗi phổ biến nhất khi review layout). Fix #11:
            # ràng buộc CÙNG block (ở nhánh continuation trên) để không gộp nhầm 2
            # mục/hàng riêng biệt (khác block) chỉ vì đứng gần nhau.
            close()
            cur = {"lines": [L], "redact": [s["bbox"] for s in L["spans"]],
                   "text": [txt], "top": L["bbox"][1],
                   "last_y1": L["bbox"][3], "left": L["bbox"][0],
                   "bullet_x": L["bbox"][0], "blk": L["blk"],
                   "size": sp["size"], "color": sp["color"]}
    close()

    items.sort(key=lambda it: it["top"])
    for i, it in enumerate(items):
        rect = fitz.Rect(it["lines"][0]["bbox"])
        for L in it["lines"]:
            rect |= fitz.Rect(L["bbox"])
        # đáy bị chặn bởi MỤC KẾ TIẾP (các bullet thường nằm trong cùng 1 block
        # PyMuPDF nên _bottom_limit theo block không thấy ranh giới giữa chúng)
        next_top = items[i + 1]["top"] if i + 1 < len(items) else page_bottom
        heading = it.get("next_heading")   # dòng heading (vd 'Solution:') bị close()
                                            # ngay sau mục này -> KHÔNG có trong `items`
                                            # (bị loại hẳn) nên next_top ở trên "nhảy
                                            # cóc" qua nó, không thấy ranh giới thật
        if heading is not None:
            next_top = min(next_top, heading["bbox"][1])
        bottom = min(_bottom_limit(rect, all_boxes, page_bottom), next_top - 2)
        # kẹp đáy theo mọi phần tử (công thức/ảnh/block kế) bắt đầu dưới mép-trên item
        # và giao ngang -> bản dịch (dài hơn) không đè lên công thức ngay dưới mục.
        for ob in all_boxes:
            if ob.y0 <= rect.y0 + 2 or ob.y0 >= bottom:
                continue
            if ob.x1 <= rect.x0 + 2 or ob.x0 >= rect.x1 - 2:
                continue
            bottom = min(bottom, ob.y0 - 2)
        if _is_formula_like(" ".join(it["text"])):   # dòng công thức (kể cả có ■) -> giữ
            continue
        # Trần REDACT = mép trên nhãn heading kế (nếu có): bbox các SPAN/dòng liền kề
        # trong cùng block thường chồng lấn nhẹ theo chiều dọc (ascender/descender)
        # -> redact đúng bbox thô của span cuối có thể ăn lẹm vào phần TRÊN của nhãn
        # heading kế (cắt cụt 'Solution:' -> 'So'). Kẹp cứng để không đụng nhãn.
        redact = it["redact"]
        if heading is not None:
            ceiling = heading["bbox"][1] - 1
            redact = []
            for r in it["redact"]:
                rr = fitz.Rect(r)
                if rr.y1 > ceiling:
                    rr.y1 = ceiling
                redact.append(list(rr))
        _emit(segments, layout, ctr, pno, " ".join(it["text"]),
              redact=redact,
              box=[it["left"], it["top"], max(col_right, rect.x1),
                   max(bottom, rect.y1)],
              size=it["size"], color=it["color"])


# ====================================================================
#  ÁP DỤNG BẢN DỊCH
# ====================================================================
def _header_dups(page):
    """Header bản quyền được nguồn in 2 lần chồng khít (faux-bold). Khi
    apply_redactions re-encode trang, bản sao thứ 2 bị lệch -> chữ garbled.
    Trả [(rect, clean_text, size, color_int)] cho dòng header bị lặp để
    redact rồi vẽ lại MỘT bản sạch. Bỏ qua header không lặp (không đụng)."""
    words = [w for w in page.get_text("words") if w[3] <= 72]  # băng header trên
    if not words:
        return []
    words.sort(key=lambda w: w[1])
    clusters = []                                  # gom theo dòng (gap y > 6pt)
    for w in words:
        if clusters and w[1] - clusters[-1][-1][1] < 6:
            clusters[-1].append(w)
        else:
            clusters.append([w])
    out = []
    for cl in clusters:
        cl.sort(key=lambda w: w[0])
        toks = [w[4] for w in cl]
        if not _is_copyright(" ".join(toks)):
            continue
        dup = sum(1 for i in range(1, len(toks)) if toks[i] == toks[i - 1])
        if dup < 3:                                # không lặp -> để nguyên
            continue
        clean = []
        for t in toks:
            if not clean or clean[-1] != t:
                clean.append(t)
        rect = fitz.Rect(min(w[0] for w in cl), min(w[1] for w in cl),
                         max(w[2] for w in cl), max(w[3] for w in cl))
        sz = max((w[3] - w[1]) for w in cl) * 0.82  # cao dòng -> cỡ chữ xấp xỉ
        out.append((rect, " ".join(clean), sz, 0))
    return out


def apply_translations(doc, layout, translations, fontfile=None):
    """Ghi đè bản dịch giữ layout. translations: {id: vi_text}.
    Trả về (applied, missing_ids)."""
    fontfile = fontfile or find_font()
    by_page = {}
    for item in layout:
        vi = translations.get(item["id"])
        if vi:
            by_page.setdefault(item["page"], []).append((item, vi))

    applied = 0
    missing = [it["id"] for it in layout if not translations.get(it["id"])]
    for pno, items in by_page.items():
        page = doc[pno]
        # Xoá markup annotation (Highlight/Underline/StrikeOut/Squiggly): rect cố
        # định theo chữ Anh, khi chữ Việt reflow sẽ lệch -> đè đoạn khác (artifact).
        for an in list(page.annots() or []):
            if an.type[1] in ("Highlight", "Underline", "StrikeOut", "Squiggly"):
                page.delete_annot(an)
        hdrs = _header_dups(page)              # dọn header lặp trên trang bị redact
        for item, _vi in items:
            for r in item["redact"]:
                page.add_redact_annot(fitz.Rect(r))
        for rect, _txt, _sz, _col in hdrs:
            page.add_redact_annot(rect)
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                              graphics=fitz.PDF_REDACT_LINE_ART_NONE)
        for item, vi in items:
            l, t, r, b = item["box"]
            box = fitz.Rect(l, t, r, max(b, t + item["size"]))
            _fit(page, box, vi, item["size"], _int_color_to_rgb(item["color"]),
                 fontfile)
            applied += 1
        for rect, txt, sz, col in hdrs:        # vẽ lại 1 bản header sạch
            _fit(page, rect, txt, sz, _int_color_to_rgb(col), fontfile)
    return applied, missing


def _fit(page, box, text, size, color, fontfile):
    """Vẽ text, ưu tiên giữ cỡ gốc, chỉ co khi không vừa. Ô quá chật (vd câu hỏi 1
    dòng tiếng Anh mà bản Việt tràn 2 dòng, sát ngay nhãn 'Solution:' bên dưới) co
    xuống tới 5.5pt (bước nhỏ hơn khi gần sàn) trước khi buộc vẽ tràn — giảm hẳn số
    ca đè chữ lên phần tử kế mà vẫn đọc được, so với sàn 6.5pt cố định trước đây."""
    s = size
    while s >= 5.5:
        rc = page.insert_textbox(box, text, fontname="vi", fontfile=fontfile,
                                 fontsize=s, color=color, align=0, lineheight=1.08)
        if rc >= 0:
            return
        s -= 0.25 if s <= 7 else 0.5
    page.insert_textbox(box, text, fontname="vi", fontfile=fontfile,
                        fontsize=5.5, color=color, align=0, lineheight=1.0)
