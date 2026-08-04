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
  { id, page, redact:[[x0,y0,x1,y1],...], box:[l,t,r,b], size, color,
    fx?:[[x0,y0,x1,y1],...], lh?, align? }
  - redact: các ô chữ cần xóa (KHÔNG gồm glyph bullet -> bullet được giữ lại).
  - box: vùng vẽ bản dịch (đã nới đáy tới phần tử kế dưới).
  - fx: rect nguồn của công thức inline thứ N — text segment chứa marker {vN},
    khi render được thay bằng ẢNH vùng gốc (sub/superscript/ký hiệu giữ nguyên).
  - lh/align: giãn dòng + canh đều đo từ đoạn nguồn (mặc định 1.12 / trái).
Text segment có thể chứa marker <b>/<i>/<sup> (đậm/nghiêng/chỉ số) và {vN};
bản dịch phải GIỮ NGUYÊN marker (check_markers kiểm + tự sửa dạng lệch).

Heading / công thức / số liệu / bảng / đồ thị / hình -> KHÔNG đụng tới.
"""
import os
import math
import re
import statistics

import fitz  # PyMuPDF

_WORD_RE = re.compile(r"[A-Za-z]{2,}")
_BULLET_CHARS = set("□❑▪■◾◼●◦‣•◻☐∙‚")  # ký tự đánh dấu mục (cả ô đặc/rỗng)
_LABEL_RE = re.compile(r"^[A-Za-z0-9]{1,2}[.)]$")  # nhãn đậm ngắn 'A.'/'B.'/'1.' đầu dòng
_COPYRIGHT_RE = re.compile(
    r"For candidate use only|©\s*CFA|©\s*\d{4}|All rights reserved|\bISBN\b", re.I)
_NUM_CELL = re.compile(r"^[\$\(\)–—−\-\d.,%\s]+$")  # ô số trong bảng (gồm − U+2212)
# Mã tiền tệ dán liền số: 'EUR0', 'USD1,000', '−USD1,800' -> strip để _num_cell
# nhận ra ô số (bảng có tiền tố tiền tệ trước đây bị coi là prose -> vỡ cột).
_CCY_PREFIX = re.compile(r"(?<![A-Za-z])[A-Z]{2,4}(?=[\d(.])")
_FORMULA_HEAD = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,4}\s*=")  # 'V0=', 'p1u =' ...
_MATH_CH = set("=+−-×÷/^()[]{}0123456789.,%$≤≥≠≈∑∫√·•")
# Ký hiệu HÀM Ý mạnh là toán (tổng, căn, bất đẳng thức, mũi tên, sigma...).
_STRONG_MATH = set("∑∫√≤≥≠≈×÷⁄·∞±→∂∏σµ")

DEFAULT_RASTER_MAX_PIXELS = 12_000_000
PREFLIGHT_RASTER_MAX_PIXELS = 400_000


def raster_plan(rect, dpi, max_pixels=DEFAULT_RASTER_MAX_PIXELS):
    """Return a deterministic scale capped by total raster pixels.

    PDF page boxes can declare enormous physical sizes. Rendering them at a
    fixed DPI can exhaust desktop memory, so all raster consumers share this
    coordinate-preserving budget.
    """
    rect = fitz.Rect(rect)
    requested_dpi = max(float(dpi), 1.0)
    scale = requested_dpi / 72.0
    width = max(rect.width, 1.0)
    height = max(rect.height, 1.0)
    requested_pixels = max(1, math.ceil(width * scale) * math.ceil(height * scale))
    limited = requested_pixels > max_pixels > 0
    if limited:
        scale *= math.sqrt(max_pixels / requested_pixels)
    pixel_width = max(1, math.ceil(width * scale))
    pixel_height = max(1, math.ceil(height * scale))
    if max_pixels > 0 and pixel_width * pixel_height > max_pixels:
        scale *= math.sqrt(max_pixels / (pixel_width * pixel_height)) * 0.999999
        pixel_width = max(1, math.ceil(width * scale))
        pixel_height = max(1, math.ceil(height * scale))
    return {
        "requested_dpi": requested_dpi,
        "effective_dpi": scale * 72.0,
        "scale": scale,
        "pixel_width": pixel_width,
        "pixel_height": pixel_height,
        "pixels": pixel_width * pixel_height,
        "max_pixels": int(max_pixels),
        "limited": limited,
    }


def raster_pixmap(page, dpi, max_pixels=DEFAULT_RASTER_MAX_PIXELS, clip=None,
                  colorspace=None, alpha=False):
    """Render one page/clip using :func:`raster_plan`; return (pixmap, plan)."""
    rect = fitz.Rect(clip) if clip is not None else page.rect
    plan = raster_plan(rect, dpi, max_pixels)
    kwargs = {
        "matrix": fitz.Matrix(plan["scale"], plan["scale"]),
        "alpha": alpha,
    }
    if clip is not None:
        kwargs["clip"] = rect
    if colorspace is not None:
        kwargs["colorspace"] = colorspace
    return page.get_pixmap(**kwargs), plan


def _area_ratio(rects, page_rect):
    area = max(page_rect.get_area(), 1.0)
    total = 0.0
    for value in rects:
        rect = fitz.Rect(value) & page_rect
        if not rect.is_empty:
            total += rect.get_area()
    return min(1.0, total / area)


def _text_removal_probe(doc, pno, span_rects):
    """Raster comparison after removing PDF text only (images/graphics stay).

    High similarity means the extracted text contributes almost nothing to the
    visible page, which is a strong signal for an invisible OCR layer over a
    scan. This is a preflight probe, not a claim of semantic OCR accuracy.
    """
    if not span_rects:
        return None
    copy = fitz.open()
    try:
        copy.insert_pdf(doc, from_page=pno, to_page=pno)
        page = copy[0]
        original, plan = raster_pixmap(
            doc[pno], 54, PREFLIGHT_RASTER_MAX_PIXELS,
            colorspace=fitz.csGRAY, alpha=False,
        )
        for rect in span_rects:
            clipped = fitz.Rect(rect) & page.rect
            if not clipped.is_empty:
                page.add_redact_annot(clipped, fill=False, cross_out=False)
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
        )
        removed, _ = raster_pixmap(
            page, plan["effective_dpi"], PREFLIGHT_RASTER_MAX_PIXELS,
            colorspace=fitz.csGRAY, alpha=False,
        )
        if original.width != removed.width or original.height != removed.height:
            return None
        a, b = original.samples, removed.samples
        # Bound CPU independently of page dimensions while sampling uniformly.
        step = max(1, len(a) // 200_000)
        count = 0
        diff_sum = 0
        changed = 0
        for av, bv in zip(a[::step], b[::step]):
            delta = abs(av - bv)
            diff_sum += delta
            changed += delta > 8
            count += 1
        if not count:
            return None
        mean_delta = diff_sum / (255.0 * count)
        return {
            "method": "text-removal-raster",
            "similarity": round(1.0 - mean_delta, 6),
            "mean_delta": round(mean_delta, 6),
            "changed_pixel_ratio": round(changed / count, 6),
            "effective_dpi": round(plan["effective_dpi"], 2),
            "pixel_limited": bool(plan["limited"]),
        }
    except Exception as exc:
        return {"method": "text-removal-raster", "error": str(exc)[:200]}
    finally:
        copy.close()


def preflight_document(doc):
    """Classify every page before translation using text, image and raster evidence."""
    pages = []
    for pno, page in enumerate(doc):
        data = page.get_text("dict")
        spans = [
            span
            for block in data.get("blocks", []) if block.get("type") == 0
            for line in block.get("lines", [])
            for span in line.get("spans", [])
            if span.get("text", "").strip()
        ]
        text = "".join(span.get("text", "") for span in spans)
        visible_chars = sum(not c.isspace() for c in text)
        replacement_chars = text.count("�")
        span_rects = [span["bbox"] for span in spans if span.get("bbox")]
        image_rects = [
            block["bbox"] for block in data.get("blocks", [])
            if block.get("type") == 1 and block.get("bbox")
        ]
        text_coverage = _area_ratio(span_rects, page.rect)
        image_coverage = _area_ratio(image_rects, page.rect)
        replacement_ratio = replacement_chars / max(visible_chars, 1)
        suspicious = (
            visible_chars < 80 or image_coverage >= 0.55 or replacement_ratio >= 0.05
        )
        probe = _text_removal_probe(doc, pno, span_rects) if suspicious else None
        mean_delta = probe.get("mean_delta") if isinstance(probe, dict) else None

        if replacement_ratio >= 0.15 and visible_chars >= 20:
            classification = "unsupported_text_encoding"
            confidence = 0.9
        elif visible_chars < 20 and image_coverage >= 0.50:
            classification = "scanned"
            confidence = min(0.99, 0.70 + image_coverage * 0.25)
        elif (
            visible_chars >= 20 and image_coverage >= 0.55
            and mean_delta is not None and mean_delta < 0.002
        ):
            classification = "scanned_with_text_layer"
            confidence = 0.9
        elif visible_chars >= 20 and image_coverage >= 0.55 and text_coverage < 0.08:
            classification = "mixed"
            confidence = 0.75
        elif visible_chars >= 20:
            classification = "native_text"
            confidence = 0.95 if visible_chars >= 80 else 0.8
        elif image_coverage > 0.05:
            classification = "image_or_figure"
            confidence = 0.65
        else:
            classification = "empty_or_vector"
            confidence = 0.6

        pages.append({
            "page": pno,
            "classification": classification,
            "confidence": round(confidence, 3),
            "text_chars": visible_chars,
            "text_coverage": round(text_coverage, 6),
            "image_coverage": round(image_coverage, 6),
            "replacement_char_ratio": round(replacement_ratio, 6),
            "roundtrip_probe": probe,
            "requires_ocr": classification in ("scanned", "scanned_with_text_layer"),
            "manual_review": classification in (
                "unsupported_text_encoding", "mixed", "image_or_figure", "empty_or_vector"
            ),
        })

    counts = {}
    for item in pages:
        key = item["classification"]
        counts[key] = counts.get(key, 0) + 1
    ocr_pages = sum(1 for item in pages if item["requires_ocr"])
    if pages and ocr_pages / len(pages) >= 0.8:
        mode = "scanned"
    elif ocr_pages:
        mode = "mixed"
    else:
        mode = "native"
    return {
        "version": 1,
        "document_mode": mode,
        "page_count": len(pages),
        "counts": counts,
        "pages": pages,
    }


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


# HỌ font 4 mặt (regular/bold/italic/bold-italic) cho render rich-text: giữ được
# đậm/nghiêng inline khi redraw (kỹ thuật học từ BabelDOC FontMapper). Thiếu mặt
# nào thì rơi về regular (chấp nhận mất mặt đó, không sập).
_FAMILY_CANDIDATES = [
    {   # macOS
        "regular": "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
        "bold": "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
        "italic": "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf",
        "bolditalic": "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf",
    },
    {   # Linux (Liberation = metric-compatible Times)
        "regular": "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
        "bold": "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "italic": "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf",
        "bolditalic": "/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf",
    },
    {   # Windows
        "regular": "C:/Windows/Fonts/times.ttf",
        "bold": "C:/Windows/Fonts/timesbd.ttf",
        "italic": "C:/Windows/Fonts/timesi.ttf",
        "bolditalic": "C:/Windows/Fonts/timesbi.ttf",
    },
]


def find_font_family(fontfile=None):
    """{regular, bold, italic, bolditalic} -> đường dẫn ttf. Ưu tiên env
    CFA_TRANSLATE_FONT_(BOLD|ITALIC|BOLDITALIC); mặt thiếu rơi về regular."""
    reg = fontfile or find_font()
    fam = {"regular": reg, "bold": reg, "italic": reg, "bolditalic": reg}
    for cand in _FAMILY_CANDIDATES:
        if cand["regular"] == reg and all(os.path.exists(p) for p in cand.values()):
            fam.update(cand)
            break
    for face in ("bold", "italic", "bolditalic"):
        env = os.environ.get(f"CFA_TRANSLATE_FONT_{face.upper()}", "")
        if env and os.path.exists(env):
            fam[face] = env
    return fam


# ====================================================================
#  Marker inline: {vN} = công thức giữ chỗ; <b>/<i>/<sup> = đậm/nghiêng/chỉ số
#  (round-trip qua LLM — kỹ thuật placeholder của BabelDOC ILTranslator)
# ====================================================================
_PH_RE = re.compile(r"\{v(\d+)\}")
# biến thể LLM hay viết lệch: { v1 }, (v1), [v1], （v1）, {V1}
_PH_FUZZ = re.compile(r"[{(\[（【]\s*[vV]\s*(\d+)\s*[})\]）】]")
_TAG_RE = re.compile(r"</?(?:b|i|sup)>")
_TAG_TOKEN = re.compile(r"</?(?:b|i|sup)>|\{v\d+\}")


def strip_markers(text):
    """Bỏ mọi marker -> text trần (đo độ dài / render fallback / phân loại)."""
    return " ".join(_PH_RE.sub(" ", _TAG_RE.sub("", text)).split())


_ESCAPED_TAG = re.compile(r"&lt;(/?)(b|i|sup)&gt;")


def check_markers(en, vi):
    """Kiểm + tự sửa marker trong bản dịch. Trả vi đã chuẩn hoá, hoặc None nếu
    KHÔNG cứu được (mất/lệch placeholder {vN} -> áp bản này sẽ mất công thức):
      - thẻ bị LLM escape HTML (&lt;i&gt;) -> unescape về <i> (thấy thật khi
        agent ghi JSON);
      - {vN} viết lệch dạng ((v1)/{ v1 }/（v1）) -> chuẩn về {vN};
      - {vN} phải khớp ĐÚNG tập trong en (thiếu/thừa/trùng -> None);
      - thẻ <b>/<i>/<sup> hỏng cặp hoặc bịa thêm -> strip thẻ đó (mất định dạng
        nhưng nội dung vẫn đúng — không chặn bản dịch)."""
    if not vi:
        return None
    vi = _ESCAPED_TAG.sub(r"<\1\2>", vi)
    need = sorted(_PH_RE.findall(en))
    if need:
        fixed = _PH_FUZZ.sub(lambda m: "{v%s}" % m.group(1), vi)
        if sorted(_PH_RE.findall(fixed)) != need:
            return None
        vi = fixed
    elif _PH_RE.search(vi):
        vi = _PH_RE.sub("", vi)            # placeholder bịa -> bỏ
    for tag in ("b", "i", "sup"):
        o, c = vi.count(f"<{tag}>"), vi.count(f"</{tag}>")
        if o != c or (o and f"<{tag}>" not in en):
            vi = vi.replace(f"<{tag}>", "").replace(f"</{tag}>", "")
    return " ".join(vi.split())


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
#  Run công thức/inline-style ở mức SPAN (trong 1 dòng prose)
# ====================================================================
def _span_bold(s):
    f = s["font"].lower()
    return ("bold" in f or "semibold" in f or "black" in f) or bool(s.get("flags", 0) & 16)


def _span_italic(s):
    f = s["font"].lower()
    return "italic" in f or "oblique" in f or bool(s.get("flags", 0) & 2)


def _span_is_mathish(s, seg_size):
    """Span 'chắc chắn toán' làm HẠT NHÂN của run công thức inline:
    superscript-flag, lệch cỡ >25% (sub/superscript thật), hoặc token ngắn
    nhiều ký hiệu toán mạnh/Hy Lạp/dấu kết hợp (σ², X̄, ≥)."""
    t = s["text"].strip()
    if not t:
        return False
    if s.get("flags", 0) & 1:                      # superscripted (PyMuPDF)
        return True
    if seg_size and abs(s["size"] - seg_size) > seg_size * 0.25:
        return True
    strong = sum((c in _STRONG_MATH) or (0x370 <= ord(c) < 0x400)
                 or (0x300 <= ord(c) <= 0x36F) for c in t)
    letters = sum(c.isascii() and c.isalpha() for c in t)
    return strong > 0 and letters <= 2 and len(t) <= 12


def _span_attachable(s):
    """Span 'dính' được vào run công thức kề bên: RẤT ngắn, không chứa từ tự
    nhiên (>=2 chữ cái liên tiếp) — biến 'P', '(1 +', '= 0.6' dính vào run để
    ảnh công thức trọn vẹn; 'so.', 'of' là từ -> không dính."""
    t = s["text"].strip()
    return bool(t) and len(t) <= 4 and not _WORD_RE.search(t)


def _gap(a, b):
    return b["bbox"][0] - a["bbox"][2]


def _line_markup(spans, seg_size, fx):
    """Dựng text 1 dòng CÓ marker từ spans:
      - run công thức inline -> '{vN}' + append rect nguồn vào fx (redraw sẽ
        stamp lại ảnh vùng gốc, hết cảnh sub/superscript/phân số vỡ chữ);
      - chỉ số trên thuần số (footnote ¹²³) -> <sup>N</sup>;
      - span đậm/nghiêng -> <b>/<i> (giữ định dạng inline qua bản dịch).
    Guard: tổng run <60% ký tự dòng (dòng đặc toán hơn đã là boundary ở
    _line_is_formula_fragment); tối đa 8 run/segment."""
    vis = [s for s in spans if s["text"].strip()]
    if not vis:
        return _span_text(spans)
    math = [_span_is_mathish(s, seg_size) for s in vis]
    # nới run: dính span kề RẤT ngắn không-từ khi sát nhau (subscript tách span)
    changed = True
    while changed:
        changed = False
        for i, s in enumerate(vis):
            if math[i] or not _span_attachable(s):
                continue
            near_prev = i > 0 and math[i - 1] and _gap(vis[i - 1], s) < 1.5
            near_next = i + 1 < len(vis) and math[i + 1] and _gap(s, vis[i + 1]) < 1.5
            if near_prev or near_next:
                math[i] = True
                changed = True
    total = sum(len(s["text"].strip()) for s in vis)
    run_chars = sum(len(s["text"].strip()) for s, m in zip(vis, math) if m)
    parts = []          # (text, first_span_idx, last_span_idx)
    i = 0
    while i < len(vis):
        s = vis[i]
        if math[i]:
            j = i
            while j + 1 < len(vis) and math[j + 1]:
                j += 1
            group = vis[i:j + 1]
            gtxt = " ".join(_span_text(group).split())
            # footnote/chỉ số trên thuần số đứng lẻ -> <sup>, không cần ảnh
            if (len(group) == 1 and (s.get("flags", 0) & 1)
                    and gtxt.isdigit() and len(gtxt) <= 3):
                parts.append((f"<sup>{gtxt}</sup>", i, j))
            elif (run_chars < 0.6 * max(total, 1) and len(fx) < 8
                    and any(_span_is_mathish(g, seg_size) for g in group)):
                r = fitz.Rect(group[0]["bbox"])
                for g in group[1:]:
                    r |= fitz.Rect(g["bbox"])
                if r.width > 0.5 and r.height > 0.5:
                    fx.append([r.x0 - 0.5, r.y0 - 0.5, r.x1 + 0.5, r.y1 + 0.5])
                    parts.append(("{v%d}" % len(fx), i, j))
                else:
                    parts.append((gtxt, i, j))
            else:
                parts.append((gtxt, i, j))  # run quá lớn/quá nhiều -> giữ dạng chữ
            i = j + 1
            continue
        # nhóm span thường theo style đậm/nghiêng liên tục
        j = i
        b0, i0 = _span_bold(s), _span_italic(s)
        while (j + 1 < len(vis) and not math[j + 1]
               and _span_bold(vis[j + 1]) == b0 and _span_italic(vis[j + 1]) == i0):
            j += 1
        seg = " ".join(_span_text(vis[i:j + 1]).split())
        if seg:
            if b0 and i0:
                seg = f"<b><i>{seg}</i></b>"
            elif b0:
                seg = f"<b>{seg}</b>"
            elif i0:
                seg = f"<i>{seg}</i>"
            parts.append((seg, i, j))
        i = j + 1
    # Nối các part: có dấu cách nếu (a) text gốc của span biên CÓ whitespace ở
    # mép ('rate of ' + italic 'g'), hoặc (b) khoảng cách hình học >= 0.5pt.
    # Sát nhau và không có whitespace gốc (subscript, punctuation dính) -> dán
    # liền, tránh '<b>term</b> .' hay 'P {v1}' sai chính tả.
    out = []
    for k, (txt, a, b) in enumerate(parts):
        if k:
            pa, pb = parts[k - 1][1], parts[k - 1][2]
            prev_raw = _span_text(vis[pa:pb + 1])
            cur_raw = _span_text(vis[a:b + 1])
            if (prev_raw != prev_raw.rstrip() or cur_raw != cur_raw.lstrip()
                    or _gap(vis[pb], vis[a]) >= 0.5):
                out.append(" ")
        out.append(txt)
    return "".join(out)


def _seg_lh(lines, size):
    """Giãn dòng của đoạn nguồn (median delta-y giữa các dòng / cỡ chữ)."""
    tops = sorted(ln["bbox"][1] for ln in lines)
    ds = [b - a for a, b in zip(tops, tops[1:]) if 2 < b - a < size * 3]
    if not ds or not size:
        return None
    return max(1.02, min(1.6, statistics.median(ds) / size))


def _seg_align(lines, rect):
    """'j' nếu đoạn nguồn CANH ĐỀU (justify): >=70% các dòng (trừ dòng cuối)
    chạm mép phải khung. Đoạn <3 dòng không đủ bằng chứng -> None (canh trái)."""
    if len(lines) < 3:
        return None
    body = lines[:-1]
    just = sum(1 for ln in body if rect.x1 - ln["bbox"][2] <= 2.5)
    return "j" if just >= max(2, int(0.7 * len(body))) else None


# ====================================================================
#  Phân loại / nhận diện
# ====================================================================
def _num_cell(t):
    if bool(_NUM_CELL.match(t)) and any(c.isdigit() for c in t):
        return True
    # Ô số mang mã tiền tệ (EUR0 / USD1,000 / −USD1,800): strip cục bộ tiền tố
    # rồi thử lại — KHÔNG đổi ngữ nghĩa _NUM_CELL toàn cục.
    t2 = _CCY_PREFIX.sub("", t)
    return t2 != t and bool(_NUM_CELL.match(t2)) and any(c.isdigit() for c in t2)


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


def _gkey(ln):
    return (round(ln["bbox"][0]), round(ln["bbox"][1]))


def _aligned_clusters(vals, tol=5.0, need=3):
    """Số CỤM giá trị thẳng hàng: sort rồi gom nhóm cách nhau <= tol, đếm nhóm
    có >= need phần tử."""
    vals = sorted(vals)
    groups, i = 0, 0
    while i < len(vals):
        j = i
        while j + 1 < len(vals) and vals[j + 1] - vals[j] <= tol:
            j += 1
        if j - i + 1 >= need:
            groups += 1
        i = j + 1
    return groups


def _page_grid_keys(pd):
    """Nhận diện BẢNG >=3 cột ở mức TRANG (bù cho _is_table_row/_label_rows,
    không cần nhãn đậm/ô số). Cấu trúc thật trong sách: MỖI Ô là một LINE riêng
    nằm cùng hàng y (vd Exhibit 'ETF | Time Since Inception | Return...').
    Thuật toán: gom line theo hàng (y-center +-3pt) -> hàng có >=3 ô (khoảng
    ngang >=10pt) là ứng viên; vùng >=3 hàng ứng viên liên tiếp (cách <28pt)
    có >=2 cột THẲNG HÀNG THEO TÂM Ô (cột canh giữa/phải nên x0 không thẳng)
    -> mọi line trong vùng được giữ nguyên tiếng Anh (dịch phẳng sẽ dồn cột —
    cụm bang_vo). Prose không trúng: 1 ô/hàng; bullet '■ text': 2 ô."""
    lines = []
    for b in pd["blocks"]:
        if b.get("type") != 0:
            continue
        for ln in b.get("lines", []):
            if _span_text(ln["spans"]).strip():
                lines.append(ln)
    if len(lines) < 6:
        return set()
    lines.sort(key=lambda ln: ((ln["bbox"][1] + ln["bbox"][3]) / 2, ln["bbox"][0]))
    rows, cur, cy = [], [], None
    for ln in lines:
        c = (ln["bbox"][1] + ln["bbox"][3]) / 2
        if cy is not None and abs(c - cy) <= 3:
            cur.append(ln)
        else:
            if cur:
                rows.append(cur)
            cur, cy = [ln], c
    if cur:
        rows.append(cur)
    cand = []                                    # (y_top, [tâm ô 2..n], lines)
    for row in rows:
        row.sort(key=lambda ln: ln["bbox"][0])
        cells = []
        for ln in row:
            if cells and ln["bbox"][0] - cells[-1][1] < 10:
                cells[-1][1] = max(cells[-1][1], ln["bbox"][2])
                cells[-1][2].append(ln)
            else:
                cells.append([ln["bbox"][0], ln["bbox"][2], [ln]])
        if len(cells) >= 3:
            centers = [(c[0] + c[1]) / 2 for c in cells[1:]]
            cand.append((min(ln["bbox"][1] for ln in row), centers, row))
    if len(cand) < 3:
        return set()
    keys = set()
    region = [cand[0]]
    for r in cand[1:] + [(1e9, [], [])]:         # sentinel đóng vùng cuối
        if r[0] - region[-1][0] < 28:
            region.append(r)
            continue
        if len(region) >= 3:
            centers = [c for _y, cs, _r in region for c in cs]
            if _aligned_clusters(centers) >= 2:
                for _y, _cs, row in region:
                    keys.update(_gkey(ln) for ln in row)
        region = [r]
    return keys


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


def _is_same_y_prefix(prefix, nxt, body_size):
    """True nếu `prefix` là mảnh non-prose nằm CÙNG HÀNG thị giác với block
    prose `nxt` kế tiếp. PyMuPDF hay tách 'The bold term, X̄_H, is...' thành
    prefix='The bold term, ¯' (thất bại _is_prose_block vì dominant bold /
    <5 từ) + next='X_H, is...' — prefix giữ nguyên EN, next dịch VI → chữ đè
    (cụm chu_de_chong p25/p101).

    Chỉ gộp khi DÒNG ĐẦU của 2 block giao y thật (không dùng bbox cả block —
    tránh gộp 2 bullet/Step liền kề chỉ vì block cao chồng nhẹ)."""
    if not prefix.get("lines") or not nxt.get("lines"):
        return False
    pt = _block_text(prefix).strip()
    nt = _block_text(nxt).strip()
    if not pt or not nt:
        return False
    # không gộp bullet / Step row (2 mục danh sách đứng gần nhau)
    if any(pt.lstrip().startswith(c) for c in _BULLET_CHARS) or "■" in pt[:4]:
        return False
    if any(nt.lstrip().startswith(c) for c in _BULLET_CHARS) or "■" in nt[:4]:
        return False
    if _WORD_RE.match(pt) and pt.lower().startswith("step "):
        return False
    if _WORD_RE.match(nt) and nt.lower().startswith("step "):
        return False
    # dòng đầu có chữ của prefix vs dòng đầu có chữ của next
    def _first_line_bbox(block):
        for ln in block["lines"]:
            if _span_text(ln["spans"]).strip():
                return ln["bbox"]
        return None
    pl, nl = _first_line_bbox(prefix), _first_line_bbox(nxt)
    if pl is None or nl is None:
        return False
    oy = min(pl[3], nl[3]) - max(pl[1], nl[1])
    if oy < 3:
        return False
    # cùng cột (không gộp sidebar/cột trái rời)
    if pl[2] < nl[0] - 20 or nl[2] < pl[0] - 20:
        return False
    spans = [s for ln in prefix["lines"] for s in ln["spans"] if s["text"].strip()]
    if not spans:
        return False
    # từ chối heading section lớn (vd 'The Harmonic Mean' 13pt đứng riêng)
    if (min(s["size"] for s in spans) > body_size * 1.15
            and all(_heading_font(s["font"]) for s in spans)):
        return False
    # prefix ngắn + có cỡ chữ thân bài (run-in / overline fragment)
    if len(pt) > 140:
        return False
    return any(abs(s["size"] - body_size) < body_size * 0.25
               or s["size"] < 8.5  # subscript/overline glyph
               for s in spans)


def _merge_same_y_lines(lines):
    """Gộp các 'line' PyMuPDF cùng hàng thị giác (y-center rơi vào band dòng
    trước) thành 1 line — nối span theo x. Cần sau khi stitch block prefix+X̄
    để overline '_' và 'X' thành 1 dòng cho _line_markup gom {vN}."""
    if not lines:
        return lines
    ordered = sorted(lines, key=lambda L: (L["bbox"][1], L["bbox"][0]))
    out = []
    for L in ordered:
        if not out:
            out.append({"spans": list(L["spans"]), "bbox": list(L["bbox"]),
                        "wmode": L.get("wmode", 0), "dir": L.get("dir")})
            continue
        prev = out[-1]
        cy = (L["bbox"][1] + L["bbox"][3]) / 2
        if prev["bbox"][1] - 2 <= cy <= prev["bbox"][3] + 2:
            spans = sorted(prev["spans"] + list(L["spans"]),
                           key=lambda s: s["bbox"][0])
            prev["spans"] = spans
            prev["bbox"] = [min(prev["bbox"][0], L["bbox"][0]),
                            min(prev["bbox"][1], L["bbox"][1]),
                            max(prev["bbox"][2], L["bbox"][2]),
                            max(prev["bbox"][3], L["bbox"][3])]
        else:
            out.append({"spans": list(L["spans"]), "bbox": list(L["bbox"]),
                        "wmode": L.get("wmode", 0), "dir": L.get("dir")})
    return out


def _stitch_same_y_blocks(blocks, body_size):
    """Gộp block non-prose prefix vào block prose kế khi chúng cùng hàng
    (xem _is_same_y_prefix). Trả list block mới (shallow copy khi merge)."""
    out, i, n = [], 0, len(blocks)
    while i < n:
        b = blocks[i]
        if (b.get("type") == 0 and i + 1 < n and blocks[i + 1].get("type") == 0
                and not _is_prose_block(b, body_size)
                and _is_prose_block(blocks[i + 1], body_size)
                and _is_same_y_prefix(b, blocks[i + 1], body_size)):
            nxt = blocks[i + 1]
            merged = dict(nxt)
            raw_lines = list(b.get("lines", [])) + list(nxt.get("lines", []))
            merged["lines"] = _merge_same_y_lines(raw_lines)
            pb, nb = b["bbox"], nxt["bbox"]
            merged["bbox"] = (min(pb[0], nb[0]), min(pb[1], nb[1]),
                              max(pb[2], nb[2]), max(pb[3], nb[3]))
            out.append(merged)
            i += 2
            continue
        out.append(b)
        i += 1
    return out


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
                        next_top=None, hlines=None):
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
        bottom = _clamp_bottom_hlines(rect, bottom, hlines)
        right = rect.x1                            # không tràn sang cột kế bên phải
        if i + 1 < len(content_cols):
            right = max(right, min(ln["bbox"][0] for ln in content_cols[i + 1]) - 4)
        else:
            right = max(right, row_rect.x1)
        fx = []
        marked = "\n".join(_line_markup(ln["spans"], sp["size"], fx) for ln in col)
        _emit(segments, layout, ctr, pno, marked,
              redact=[list(fitz.Rect(ln["bbox"])) for ln in col],
              box=[rect.x0, rect.y0, right, max(bottom, rect.y1)],
              size=sp["size"], color=sp["color"],
              fx=fx, lh=_seg_lh(col, sp["size"]))


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


def _line_is_formula_fragment(line, body_size):
    """MẢNH công thức ở mức DÒNG (overline, sub/superscript, tử/mẫu phân số bị
    PyMuPDF tách rời) -> giữ nguyên, không gom vào run prose để redact/flatten
    (cụm congthuc_vo). CỐ Ý hẹp hơn _is_formula_like (không dùng rule '<=1 từ,
    math-ratio' — dòng kết đoạn kiểu 'of 0.05.' sẽ dính oan):
      - mở đầu 'biến =' (FORMULA_HEAD), hoặc
      - chứa ký hiệu toán MẠNH (Σ √ ≤ ...), hoặc
      - dòng CHỈ là glyph overline/macron đứng lẻ (<=2 ký tự; '______' điền-vào-
        chỗ-trống dài hơn nên không trúng), hoặc
      - span lệch cỡ >25% thân bài (sub/superscript) chiếm >=60% ký tự dòng,
        hoặc dòng không có từ tự nhiên nào mà vẫn có span lệch cỡ
        (footnote ¹ ² giữa câu prose: share nhỏ -> không trúng)."""
    txt = _span_text(line["spans"]).strip()
    if not txt:
        return False
    # dòng toàn glyph gạch/overline (thanh phân số, overline, fill-in-blank):
    # không có gì để dịch, redact sẽ phá cấu trúc -> giữ nguyên (mọi độ dài)
    if all(c in "_‾¯̅" for c in txt):
        return True
    letters = sum(c.isalpha() for c in txt)
    math = sum(c in _MATH_CH for c in txt)
    longw = sum(1 for w in _WORD_RE.findall(txt) if len(w) >= 4)
    # 'biến =' phải kèm MẬT ĐỘ toán (như rule 1 _is_formula_like) — dòng chú
    # giải 'PV = present value of...' là prose định nghĩa, phải được dịch
    if _FORMULA_HEAD.match(txt) and len(txt) <= 60 and math >= max(2, letters * 0.4):
        return True
    # 'biến =' RẤT NGẮN, gần như không có từ tự nhiên ('FVt = PVe^rt' với mũ bị
    # tách span): mật độ toán thấp vì toàn chữ-biến, nhưng vẫn là công thức —
    # dịch sẽ vẽ đè 2 lớp lên công thức được giữ. 'A = periodic cash flow' có
    # >=2 từ tự nhiên nên không trúng.
    if _FORMULA_HEAD.match(txt) and len(txt) <= 20 and longw <= 1:
        return True
    # ký hiệu toán mạnh + RẤT ÍT từ tự nhiên + đủ MẬT ĐỘ toán (math>=3 như rule 3
    # _is_formula_like) — 'the standard deviation σ is' hay 't → ∞' lẻ trong câu
    # prose không có ký tự toán nào khác thì vẫn là prose, phải được dịch
    words_n = len(_WORD_RE.findall(txt))
    if any(c in _STRONG_MATH for c in txt) and longw <= 2 and math >= 3 and words_n <= 2:
        return True
    total = dev = 0
    for s in line["spans"]:
        n = len(s["text"].strip().replace(" ", ""))
        if not n:
            continue
        total += n
        if abs(s["size"] - body_size) > body_size * 0.25:
            dev += n
    if total and dev / total >= 0.6:
        return True
    if dev > 0 and longw == 0:
        return True
    # Bộ typeset công thức của sách nhét ZERO-WIDTH SPACE (U+200B) dày đặc giữa
    # các token toán ('X ​ H​ = ​', 'Y ​)​ 2​'). >=2 ZWSP mà gần như không có từ
    # tự nhiên -> mảnh công thức. Prose chỉ có lác đác 1 ZWSP đầu dòng.
    if txt.count("​") >= 2 and longw <= 1:
        return True
    # Phương trình mà TỪ DÀI duy nhất là NHÃN SUB/SUPERSCRIPT: 'R_weekly =
    # (1 + R_daily)^5 − 1' — longw đếm cả 'weekly/daily' nên các rule trên
    # trượt. Sub/superscript của sách chỉ nhỏ hơn ~20% (8pt vs 10pt, DƯỚI
    # ngưỡng 25% của dev-share) hoặc mang flags superscript. Đếm lại từ dài
    # CHỈ trong span cỡ thường: bằng 0 + có neo '='/ký hiệu mạnh + đủ mật độ
    # toán + CÓ span lệch (>15% hay flags&1) -> công thức, giữ nguyên. Prose
    # thật luôn có từ dài cỡ thường nên không trúng.
    if ("=" in txt or any(c in _STRONG_MATH for c in txt)) and math >= 3:
        longw_normal = dev_any = 0
        for s in line["spans"]:
            if (abs(s["size"] - body_size) > body_size * 0.15
                    or s.get("flags", 0) & 1):
                dev_any += 1
                continue
            longw_normal += sum(1 for w in _WORD_RE.findall(s["text"])
                                if len(w) >= 4)
        if dev_any and longw_normal == 0:
            return True
    # Token mồ côi cực ngắn ('P' tử phân số, '10') / cụm KHÔNG CÓ từ tự nhiên nào
    # chỉ vài chữ cái + chữ số ('n − 1' mẫu phân số). PHẢI không chứa từ thật —
    # 'so', 'Yes.', 'of 0.05.', 'is 5%.' đều có từ (_WORD_RE >=2 chữ cái) nên là
    # đuôi đoạn văn, phải được dịch (đúng docstring, review finding #4/#7/#8).
    # '3.' / '10.' / '5%.' — số + dấu câu kết dòng (PyMuPDF tách đuôi câu
    # "…distribution is\n3.") KHÔNG phải mảnh công thức: nếu coi fragment sẽ
    # cắt bullet/prose, để rơi orphan '3.' trên trang (p100 kurtosis). Tử/mẫu
    # phân số thật thường là '10'/'n−1' không có '.'/'%' kết thúc câu.
    clean = txt.replace("​", "").strip()
    words_all = _WORD_RE.findall(clean)
    if len(clean) <= 2 and not words_all:
        # '3.' vẫn 2 ký tự — chấm câu → đuôi prose, không fragment
        if clean.endswith((".", ",", ";", "%", "!", "?")):
            return False
        return True
    if (not words_all and letters <= 3 and any(c.isdigit() for c in clean)
            and not clean.endswith((".", ",", ";", "%", "!", "?"))
            and len(clean) <= 8):
        return True
    return False


def _line_is_heading(line, body_size):
    """Heading = TỶ LỆ ký tự heading-style (đậm/italic/lớn hơn thân bài) chiếm
    >= 0.8 số ký tự non-whitespace của dòng. Trước đây xét theo span TRỘI
    (_dominant) — câu chứa thuật ngữ bold run-in mà phần chữ thường bị PyMuPDF
    cắt vụn thành nhiều span nhỏ sẽ bị coi nhầm là heading (share thực ~0.5) ->
    giữ nguyên tiếng Anh + tách rời khỏi câu (cụm lỗi label_tach_dong).
    Heading thật ('Solution:'/'Excel') ~100% ký tự đậm -> vẫn đúng."""
    if not line["spans"]:
        return True                    # không có span nào (như _dominant None cũ)
    total = heads = 0
    for s in line["spans"]:
        n = len(s["text"].strip().replace(" ", ""))
        if not n:
            continue
        total += n
        if _heading_font(s["font"]) or s["size"] > body_size * 1.12:
            heads += n
    if total == 0:
        # CÓ span nhưng toàn whitespace: là dòng đệm trong đoạn — coi như
        # continuation (False), không phải boundary heading (kẻo xé đoạn làm 2
        # segment + kẹp đáy giữa đoạn — review finding #3).
        return False
    return heads / total >= 0.8


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


def _collect_drawing_lines(page):
    """Đường KẺ vector của trang -> (hlines, vlines) dạng fitz.Rect. all_boxes chỉ
    lấy từ get_text('dict') nên viền khung (LEARNING MODULE OVERVIEW, box Example),
    ngoặc nhọn, cột chart... VÔ HÌNH với extractor -> box dịch nới xuyên viền
    (cụm tràn_khung/chu_de_chong). Quy tắc (theo phản biện):
    - primitive MỎNG ('l'/'re' có bbox h<=2.5 & w>=30, hoặc w<=2.5 & h>=30) là
      đường kẻ bất kể fill/stroke (thanh fill 1pt vẫn là rule line);
    - 're' DÀY chỉ tách 4 cạnh khi path CÓ STROKE (khung viền); fill-only dày là
      nền shading -> BỎ (kẻo kẹp đáy giữa đoạn văn có nền);
    - path stroke tổng thể HẸP-CAO (w<=12, h>=30, vd ngoặc nhọn vẽ bằng curve)
      -> 1 vline tại bbox."""
    hl, vl = [], []

    def _classify(x0, y0, x1, y1):
        w, h = x1 - x0, y1 - y0
        if h <= 2.5 and w >= 30:
            hl.append(fitz.Rect(x0, y0, x1, y1))
        elif w <= 2.5 and h >= 30:
            vl.append(fitz.Rect(x0, y0, x1, y1))

    try:
        drawings = page.get_drawings()
    except Exception:
        return hl, vl
    for d in drawings:
        stroked = "s" in (d.get("type") or "")
        for it in d.get("items", []):
            kind = it[0]
            if kind == "l":
                p1, p2 = it[1], it[2]
                _classify(min(p1.x, p2.x), min(p1.y, p2.y),
                          max(p1.x, p2.x), max(p1.y, p2.y))
            elif kind == "re":
                r = it[1]
                w, h = r.width, r.height
                if h <= 2.5 or w <= 2.5:
                    _classify(r.x0, r.y0, r.x1, r.y1)   # rect mỏng = đường kẻ
                elif stroked:                             # khung viền -> 4 cạnh
                    _classify(r.x0, r.y0, r.x1, r.y0)
                    _classify(r.x0, r.y1, r.x1, r.y1)
                    _classify(r.x0, r.y0, r.x0, r.y1)
                    _classify(r.x1, r.y0, r.x1, r.y1)
        r = d.get("rect")
        if stroked and r is not None and r.width <= 12 and r.height >= 30:
            vl.append(fitz.Rect(r.x0, r.y0, r.x0 + 1, r.y1))  # ngoặc nhọn/cột hẹp
    return hl, vl


def _clamp_bottom_hlines(rect, bottom, hlines):
    """Kẹp đáy theo đường kẻ ngang NẰM DƯỚI text gốc (y0 >= rect.y1 - 2 — chỉ chặn
    phần NỚI THÊM, không bao giờ kẹp vào trong text: gạch chân/kẻ hàng GIỮA đoạn
    không được co chữ oan) và PHỦ GẦN HẾT bề ngang item (>= 60% — viền khung luôn
    rộng hơn text bên trong; underline một cụm từ thì hẹp -> bỏ qua)."""
    if not hlines:
        return bottom
    for ln in hlines:
        if ln.y0 < rect.y1 - 2 or ln.y0 >= bottom:
            continue
        ov = min(ln.x1, rect.x1) - max(ln.x0, rect.x0)
        if ov >= 0.6 * max(rect.width, 1):
            bottom = min(bottom, ln.y0 - 2)
    return max(bottom, rect.y1)


def _clamp_right_vlines(rect, right, bottom, vlines):
    """Kẹp mép PHẢI theo đường kẻ dọc/ngoặc nhọn nằm BÊN PHẢI text gốc
    (x0 >= rect.x1 - 2) và giao dọc với [rect.y0, bottom]. Sàn: không bao giờ
    hẹp hơn rect.x1 (viền sát chữ không được làm box hẹp hơn text gốc)."""
    if not vlines:
        return right
    for v in vlines:
        if v.x0 < rect.x1 - 2 or v.x0 >= right:
            continue
        if v.y1 <= rect.y0 or v.y0 >= bottom:
            continue
        right = min(right, v.x0 - 3)
    return max(right, rect.x1)


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
        hlines, vlines = _collect_drawing_lines(page)
        gkeys = _page_grid_keys(pd)
        lines = _collect_lines(pd)
        start = len(layout)
        if _has_bullets(lines):
            _extract_bulleted(lines, body, all_boxes, page_bottom, pno,
                              segments, layout, ctr, hlines=hlines, vlines=vlines,
                              gkeys=gkeys)
        else:
            _extract_blocky(pd, body, all_boxes, page_bottom, pno,
                            segments, layout, ctr, hlines=hlines, vlines=vlines,
                            gkeys=gkeys)
        # Kẹp redact xuyên block theo MỌI dòng giữ-nguyên của trang (heading,
        # nhãn, mảnh công thức, dòng bảng lưới) — xem _shave_redacts.
        kept = [fitz.Rect(L["bbox"]) for L in lines
                if _line_is_heading(L, body) or _line_is_formula_fragment(L, body)
                or _gkey(L) in gkeys]
        if kept:
            _shave_redacts(layout[start:], kept)
    return segments, layout


def _shave_redacts(layout_items, kept_boxes):
    """Kẹp redact XUYÊN BLOCK: bbox dòng PDF luôn chồm nhẹ ascender/descender
    sang dòng kề — nếu dòng kề là dòng GIỮ NGUYÊN (heading/nhãn/mảnh công thức ở
    block khác), redact chờm ~1-2pt sẽ ăn lẹm glyph của nó ('Solution:' mất chữ,
    cụm khac p84). Chỉ shave khi giao 2D THẬT và phần chờm NHỎ (<=3pt hoặc <=30%
    chiều cao redact) — kept-line cao (công thức phân số) chờm sâu thì KHÔNG
    shave kẻo sót chữ Anh của chính đoạn bị redact. Bỏ qua nếu shave làm rect
    lộn ngược. Idempotent với ceiling-clamp #13/#15 sẵn có (min/max hai lần)."""
    for it in layout_items:
        # span bbox có thể là tuple -> chuẩn hoá list để gán được
        it["redact"] = [list(r) for r in it["redact"]]
        for r in it["redact"]:
            rr = fitz.Rect(r)
            for k in kept_boxes:
                ox = min(rr.x1, k.x1) - max(rr.x0, k.x0)
                oy = min(rr.y1, k.y1) - max(rr.y0, k.y0)
                if ox <= 0 or oy <= 0:
                    continue
                if oy > min(3.0, 0.3 * max(rr.height, 1)):
                    continue
                # kept box phải VƯỢT RA NGOÀI mép redact (straddle) — kept mỏng
                # nằm TRỌN TRONG redact (glyph overline ~2pt giữa dòng chữ) mà
                # shave thì cắt cụt redact tới sát đỉnh, chữ Anh bên dưới sống
                # sót -> song ngữ đè nhau (review finding #6).
                if rr.y0 < k.y0 < rr.y1 and k.y1 >= rr.y1:   # chờm TRÊN xuống kept
                    ny1 = k.y0 - 1
                    if ny1 > r[1]:
                        r[3] = min(r[3], ny1)
                elif rr.y0 < k.y1 < rr.y1 and k.y0 <= rr.y0:  # chờm DƯỚI lên kept
                    ny0 = k.y1 + 1
                    if ny0 < r[3]:
                        r[1] = max(r[1], ny0)


def _emit(segments, layout, ctr, pno, text, redact, box, size, color,
          fx=None, lh=None, align=None):
    text = " ".join(text.split()).strip()
    if len(strip_markers(text)) < 3:
        return                    # không có prose thật (toàn marker) -> giữ nguyên
    sid = f"s{ctr[0]}"
    ctr[0] += 1
    segments.append({"id": sid, "text": text})
    item = {"id": sid, "page": pno, "redact": redact,
            "box": box, "size": size, "color": color}
    if fx:                                   # rect nguồn của từng {vN} (theo thứ tự)
        item["fx"] = [list(r) for r in fx]
    if lh:
        item["lh"] = round(lh, 2)
    if align:
        item["align"] = align
    layout.append(item)


def _heading_split_runs(lines, body, gkeys=None):
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
    n = len(lines)
    for i, ln in enumerate(lines):
        # Mảnh công thức CHECK TRƯỚC heading (thứ tự quan trọng — phản biện (5)):
        # cắt run tại đó, giữ nguyên, dòng này thành boundary kẹp đáy run trước
        # (tái dùng cơ chế next_heading) -> không redact nửa công thức nữa.
        # Dòng BẢNG LƯỚI (>=3 cột thẳng hàng, _page_grid_keys) xử lý y hệt:
        # giữ nguyên tiếng Anh, làm boundary — dịch phẳng sẽ dồn cột (bang_vo).
        if _line_is_formula_fragment(ln, body) or (gkeys and _gkey(ln) in gkeys):
            if cur:
                runs.append((cur, ln))
                cur = []
            continue
        if _line_is_heading(ln, body):
            # Heading phải ĐỨNG RIÊNG một hàng thị giác. Mảnh bold/italic nằm
            # CÙNG HÀNG (y-center rơi vào band dòng prose kề) là run-in fragment
            # -> nhập vào run (dịch inline), không phải boundary — hết cảnh chữ
            # Việt vẽ chồng lên glyph tiếng Anh được "giữ nguyên" (p25).
            cy = (ln["bbox"][1] + ln["bbox"][3]) / 2
            inline = False
            for j in (i - 1, i + 1):
                if 0 <= j < n and not _line_is_heading(lines[j], body):
                    nb = lines[j]["bbox"]
                    # cùng hàng thị giác VÀ giao ngang thật — nhãn side-by-side
                    # ('Step 1' bên trái cột nội dung) x-disjoint nên vẫn là
                    # boundary, không bị nhập vào run (review finding #9)
                    if (nb[1] <= cy <= nb[3]
                            and min(ln["bbox"][2], nb[2]) > max(ln["bbox"][0], nb[0])):
                        inline = True
                        break
            if inline:
                cur.append(ln)
                continue
            if cur:
                runs.append((cur, ln))
                cur = []
        else:
            cur.append(ln)
    if cur:
        runs.append((cur, None))
    return runs


def _extract_labeled_lines(lines, body, all_boxes, page_bottom, pno,
                            segments, layout, ctr, hlines=None):
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
            # bỏ span TOÀN whitespace (dấu cách đệm sau nhãn '1.\t') khỏi tx0 —
            # kẻo box dán sát nhãn + cả khối lệch trái (fix cụm bullet_indent p130)
            tx0 = min((s["bbox"][0] for s in text_spans if s["text"].strip()),
                      default=ln["bbox"][0])
            cur = {"lines": [ln], "spans": list(text_spans),
                   "span_lines": [list(text_spans)], "left": tx0}
        elif _line_is_heading(ln, body):
            if cur:
                items.append(cur)
            cur = None
        elif cur is not None:
            cur["lines"].append(ln)
            cur["spans"].extend(ln["spans"])
            cur["span_lines"].append(list(ln["spans"]))
        else:
            cur = {"lines": [ln], "spans": list(ln["spans"]),
                   "span_lines": [list(ln["spans"])], "left": ln["bbox"][0]}
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
        bottom = _clamp_bottom_hlines(rect, bottom, hlines)
        redact = [list(s["bbox"]) for s in it["spans"]]
        if next_line is not None and _line_is_heading(next_line, body):
            # trần redact = mép trên nhãn heading kế (bbox 2 dòng liền kề trong PDF
            # nguồn thường chồng lấn nhẹ theo chiều dọc) -> không ăn lẹm glyph (fix #13)
            ceiling = next_line["bbox"][1] - 1
            for r in redact:
                # chỉ kẹp khi không làm rect LỘN NGƯỢC — boundary cùng hàng
                # (mảnh công thức tách span ở cùng y) cho ceiling < y0, kẹp sẽ
                # tạo rect rỗng -> chữ Anh không bị xoá, vẽ đè 2 lớp (finding #2)
                if r[3] > ceiling > r[1]:
                    r[3] = ceiling
        fx = []
        marked = "\n".join(_line_markup(sl, tsp["size"], fx)
                           for sl in it["span_lines"])
        _emit(segments, layout, ctr, pno, marked,
              redact=redact,
              box=[it["left"], rect.y0, rect.x1, max(bottom, rect.y1)],
              size=tsp["size"], color=tsp["color"],
              fx=fx, lh=_seg_lh(it["lines"], tsp["size"]))


def _extract_blocky(pd, body, all_boxes, page_bottom, pno, segments, layout, ctr,
                    hlines=None, vlines=None, gkeys=None):
    """Đường đi trang VĂN XUÔI (sách volume)."""
    cands = []
    # Gộp prefix non-prose cùng hàng với prose kế (X̄ split — chu_de_chong p25/p101)
    # TRƯỚC khi lọc _is_prose_block, nếu không prefix bị bỏ + next dịch đè EN.
    blocks = _stitch_same_y_blocks(pd["blocks"], body)
    for b in blocks:
        if b.get("type") != 0:
            continue
        rows = _label_rows(b)                       # hàng 'Step N | nội dung | dữ liệu'
        if rows is not None:
            for ri, cols in enumerate(rows):
                nt = rows[ri + 1][0][0]["bbox"][1] if ri + 1 < len(rows) else None
                _extract_label_row(cols, all_boxes, page_bottom, pno, segments, layout, ctr,
                                    next_top=nt, hlines=hlines)
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
                                    segments, layout, ctr, hlines=hlines)
            continue
        if not _is_prose_block(b, body):
            continue
        for run, next_heading in _heading_split_runs(b["lines"], body, gkeys):
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
        bottom = _clamp_bottom_hlines(rect, bottom, hlines)
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
            # guard chống rect lộn ngược khi boundary (heading/mảnh công thức)
            # nằm cùng hàng với dòng redact (finding #2)
            if redact_ceiling is not None and r.y1 > redact_ceiling > r.y0:
                r.y1 = redact_ceiling
            redact.append(list(r))
        fx = []
        marked = "\n".join(_line_markup(ln["spans"], sp["size"], fx) for ln in run)
        _emit(segments, layout, ctr, pno, marked,
              redact=redact,
              box=[rect.x0, rect.y0, rect.x1, max(bottom, rect.y1)],
              size=sp["size"], color=sp["color"],
              fx=fx, lh=_seg_lh(run, sp["size"]), align=_seg_align(run, rect))


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
                      segments, layout, ctr, hlines=None, vlines=None, gkeys=None):
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
        # Mảnh công thức (overline/sub-superscript bị tách dòng): KHÔNG nối vào
        # mục, KHÔNG mở mục mới (sẽ bị redact) — đóng mục hiện tại và truyền L
        # làm boundary để kẹp đáy box (mảnh cùng block nên vòng kẹp all_boxes
        # mức block không thấy nó — phản biện điều kiện (6)).
        if _line_is_formula_fragment(L, body) or (gkeys and _gkey(L) in gkeys):
            close(L)          # dòng bảng lưới cũng giữ nguyên + làm boundary
            continue
        bidx = _bullet_idx(L["spans"])
        if bidx < 0:
            bidx = _label_span_idx(L["spans"])
        sp = _dominant(L["spans"])
        lh = sp["size"] if sp else 10
        if bidx >= 0:
            close()
            text_spans = [s for k, s in enumerate(L["spans"]) if k != bidx]
            # bỏ span toàn whitespace khỏi tx0 (như _extract_labeled_lines)
            tx0 = min((s["bbox"][0] for s in text_spans if s["text"].strip()),
                      default=L["bbox"][0])
            tsp = _dominant(text_spans) or sp
            fx = []
            cur = {"lines": [L], "redact": [s["bbox"] for s in text_spans],
                   "text": [_line_markup(text_spans, tsp["size"], fx)],
                   "fx": fx, "top": L["bbox"][1],
                   "last_y1": L["bbox"][3], "left": tx0,
                   "bullet_x": L["bbox"][0], "tx0": tx0, "src_blk": L["blk"],
                   "size": tsp["size"], "color": tsp["color"]}
        elif (cur and L["bbox"][1] - cur["last_y1"] < lh * 1.8
              and (
                  # Mục CÓ bullet/nhãn: nhận dòng CÙNG block gốc HOẶC thẳng lề
                  # text (>= tx0-6). Trước đây so với bullet_x (cột glyph) nên
                  # dòng đầu ĐOẠN VĂN KHÁC (block khác, thụt ngang glyph) bị nuốt
                  # vào mục + min() kéo mép trái box về cột glyph -> chữ Việt đè
                  # lên glyph ■ và mất hanging indent (cụm bullet_indent p17).
                  (cur.get("blk") is None
                   and (L["blk"] == cur.get("src_blk")
                        or L["bbox"][0] > cur.get("tx0", cur["bullet_x"]) - 6))
                  # Đoạn văn thường: CÙNG block (fix #11) + nới lề trái -6 -> -20
                  # để đón cả câu bị tách sau nhãn bold run-in đứng lệch phải
                  # (cụm label_tach_dong p195) — khác block vẫn bị chặn.
                  or (cur.get("blk") is not None and L["blk"] == cur["blk"]
                      and L["bbox"][0] > cur["bullet_x"] - 20)
              )):
            # dòng tiếp nối của mục hiện tại
            cur["lines"].append(L)
            cur["redact"].extend(s["bbox"] for s in L["spans"])
            cur["text"].append(_line_markup(L["spans"], cur["size"], cur["fx"]))
            cur["last_y1"] = L["bbox"][3]
            cur["left"] = min(cur["left"], L["bbox"][0])
            if cur.get("blk") is None:
                # box của mục có glyph/nhãn không bao giờ trùm lên glyph
                cur["left"] = max(cur["left"], cur.get("tx0", cur["left"]))
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
            fx = []
            cur = {"lines": [L], "redact": [s["bbox"] for s in L["spans"]],
                   "text": [_line_markup(L["spans"], sp["size"], fx)],
                   "fx": fx, "top": L["bbox"][1],
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
        bottom = _clamp_bottom_hlines(rect, bottom, hlines)
        # phân loại trên text TRẦN (marker {vN} chứa {}/digit làm lệch mật độ toán)
        if _is_formula_like(strip_markers(" ".join(it["text"]))):
            continue                                 # dòng công thức (kể cả có ■) -> giữ
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
                # guard chống rect lộn ngược khi boundary cùng hàng (finding #2)
                if rr.y1 > ceiling > rr.y0:
                    rr.y1 = ceiling
                redact.append(list(rr))
        right = _clamp_right_vlines(rect, max(col_right, rect.x1), bottom, vlines)
        _emit(segments, layout, ctr, pno, " ".join(it["text"]),
              redact=redact,
              box=[it["left"], it["top"], right, max(bottom, rect.y1)],
              size=it["size"], color=it["color"],
              fx=it.get("fx"), lh=_seg_lh(it["lines"], it["size"]),
              align=_seg_align(it["lines"], rect))


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


# ---- Render v2: rich-text (đậm/nghiêng/sup), đo trước bằng Story, chuẩn hoá
# scale toàn tài liệu, công thức inline {vN} stamp lại bằng ảnh vùng gốc.
# (Các kỹ thuật học từ BabelDOC: typesetting scale-loop + mode-normalization,
#  formula placeholder round-trip, font family mapping.)

_SCALE_LADDER = [1.0, 0.97, 0.94, 0.91, 0.88, 0.85, 0.82, 0.79,
                 0.76, 0.73, 0.70, 0.66, 0.62, 0.58, 0.55]
_FX_DPI = 288          # raster công thức inline (4x) — nét ở cỡ chữ sách


def _font_css_archive(fam):
    """CSS @font-face 4 mặt + Archive chứa font (dùng chung cho Story/htmlbox)."""
    ar = fitz.Archive()
    seen, css = {}, []
    for i, face in enumerate(("regular", "bold", "italic", "bolditalic")):
        path = fam[face]
        name = seen.get(path)
        if name is None:
            name = f"f{i}.ttf"
            with open(path, "rb") as fh:
                ar.add(fh.read(), name)
            seen[path] = name
        w = " font-weight: bold;" if "bold" in face else ""
        s = " font-style: italic;" if "italic" in face else ""
        css.append(f"@font-face {{font-family: vn; src: url({name});{w}{s}}}")
    # LƯU Ý: engine CSS của Story KHÔNG hỗ trợ selector '*' — phải liệt kê
    # tường minh, nếu không margin mặc định của body/p (~24pt) phồng mọi phép
    # đo -> scale tụt đáy oan (bug 'bullet tí hon' đã gặp thật).
    css.append("body {font-family: vn; margin: 0; padding: 0;}")
    css.append("p {font-family: vn; margin: 0; padding: 0;}")
    css.append("sup {font-size: 0.65em; vertical-align: super;}")
    return "\n".join(css), ar


def _esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _html_body(text):
    """Escape toàn bộ text TRỪ các marker hợp lệ (<b>/<i>/<sup>/{vN})."""
    out, pos = [], 0
    for m in _TAG_TOKEN.finditer(text):
        out.append(_esc(text[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(_esc(text[pos:]))
    return "".join(out)


def _seg_html(vi, size, color, lh, align, fx, scale, img_prefix):
    """HTML 1 segment ở hệ số scale cho trước. {vN} -> <img> (kích thước gốc
    nhân scale); thẻ hỏng cặp bị strip để không tràn style sang cả đoạn."""
    for tag in ("b", "i", "sup"):
        if vi.count(f"<{tag}>") != vi.count(f"</{tag}>"):
            vi = vi.replace(f"<{tag}>", "").replace(f"</{tag}>", "")
    body = _html_body(vi)
    for n, r in enumerate(fx or [], 1):
        w = max(r[2] - r[0], 1.0) * scale
        h = max(r[3] - r[1], 1.0) * scale
        body = body.replace(
            "{v%d}" % n,
            f'<img src="{img_prefix}{n}.png" style="width:{w:.2f}pt;height:{h:.2f}pt"/>')
    body = _PH_RE.sub("", body)                    # placeholder mồ côi -> bỏ
    col = "#%06x" % (int(color) & 0xFFFFFF)
    return (f'<p style="font-size:{size * scale:.2f}pt; line-height:{lh:.2f}; '
            f'color:{col}; text-align:{"justify" if align == "j" else "left"};">'
            f"{body}</p>")


def _fit_scale(item, vi, css, ar, img_prefix):
    """Hệ số scale LỚN NHẤT trong thang mà segment vừa khung (đo bằng Story,
    không vẽ). Không vừa cả ở sàn -> trả sàn (htmlbox scale_low sẽ ép vừa)."""
    l, t, r, b = item["box"]
    w = max(r - l, 10.0)
    h = max(b - t, item["size"])
    lh = item.get("lh") or 1.12
    for s in _SCALE_LADDER:
        html = _seg_html(vi, item["size"], item["color"], lh,
                         item.get("align"), item.get("fx"), s, img_prefix)
        try:
            story = fitz.Story(html, user_css=css, archive=ar)
            more, filled = story.place((0, 0, w, h))
        except Exception:
            return s
        if not more and filled[3] <= h + 0.5:
            return s
    return _SCALE_LADDER[-1]


def _mode_scale(pairs):
    """Scale PHỔ BIẾN nhất (mode, trọng số theo độ dài text, bucket 0.03) của
    các đoạn thân bài -> chuẩn hoá cỡ chữ toàn tài liệu cho đều mắt."""
    acc = {}
    for s, weight in pairs:
        k = round(s / 0.03)
        acc[k] = acc.get(k, 0) + weight
    if not acc:
        return 1.0
    best = max(acc.items(), key=lambda kv: (kv[1], kv[0]))[0]
    return min(1.0, best * 0.03)


def _fx_prefix(item):
    return f"x{item['id']}_"


def _review_scale_floor(item):
    """Human-review floor by block role; rendering still preserves content."""
    kind = item.get("type", "paragraph")
    if kind in ("heading", "title"):
        return 0.85
    if kind in ("caption", "figure_caption", "table_caption"):
        return 0.72
    if kind in ("footnote", "reference"):
        return 0.80
    return 0.78


def apply_translations(doc, layout, translations, fontfile=None, report=None,
                       document_scale_cap=None):
    """Ghi đè bản dịch giữ layout. translations: {id: vi_text}.
    Trả về (applied, missing_ids).
    LƯU Ý: `doc` phải còn NGUYÊN BẢN khi gọi (ảnh công thức inline được raster
    từ chính các trang này TRƯỚC khi redact).

    `document_scale_cap` chỉ dùng khi render lại một trang: tái sử dụng cap
    của lần apply toàn tài liệu, thay vì tính mode sai từ một subset."""
    fam = find_font_family(fontfile)
    css, ar = _font_css_archive(fam)
    fallback_font = fam["regular"]
    by_page = {}
    for item in layout:
        vi = translations.get(item["id"])
        if vi:
            by_page.setdefault(item["page"], []).append((item, vi))

    applied = 0
    missing = [it["id"] for it in layout if not translations.get(it["id"])]
    if report is not None:
        report.clear()
        report.update({
            "version": 1,
            "page_count": doc.page_count,
            "page_sizes": [[round(p.rect.width, 3), round(p.rect.height, 3)] for p in doc],
            "applied": 0,
            "missing_ids": missing,
            "document_scale_cap": None,
            "review_count": 0,
            "segments": [],
        })

    # B1: raster ảnh công thức inline từ trang CÒN NGUYÊN (trước mọi redact).
    for pno, items in by_page.items():
        page = doc[pno]
        for item, vi in items:
            if not item.get("fx") or not _PH_RE.search(vi):
                continue
            for n, r in enumerate(item["fx"], 1):
                try:
                    pm, _plan = raster_pixmap(
                        page, _FX_DPI, max_pixels=2_000_000, clip=fitz.Rect(r)
                    )
                    ar.add(pm.tobytes("png"), f"{_fx_prefix(item)}{n}.png")
                except Exception:
                    pass                     # thiếu ảnh -> {vN} bị bỏ khi render

    # B2: đo scale vừa khung cho từng segment -> chuẩn hoá theo mode tài liệu.
    fits = {}
    weights = []
    for pno, items in by_page.items():
        for item, vi in items:
            s = _fit_scale(item, vi, css, ar, _fx_prefix(item))
            fits[item["id"]] = s
            weights.append((s, len(vi)))
    if document_scale_cap is None:
        mode = _mode_scale(weights)
        # mode >= 0.94: tài liệu về cơ bản vừa -> không ép nhỏ cả cuốn vì chênh nhẹ.
        # Sàn chuẩn hoá 0.85: không bao giờ ÉP đoạn đã-vừa co quá 15% chỉ để đều.
        cap = 1.0 if mode >= 0.94 else max(mode, 0.85)
    else:
        cap = max(0.3, min(1.0, float(document_scale_cap)))
    if report is not None:
        report["document_scale_cap"] = round(cap, 4)

    for pno, items in by_page.items():
        page = doc[pno]
        # Xoá markup annotation (Highlight/Underline/StrikeOut/Squiggly) NHƯNG chỉ
        # khi rect của nó GIAO vùng bị redact: chữ Việt reflow làm annot neo theo
        # chữ Anh lệch chỗ. Annot phủ vùng GIỮ NGUYÊN (công thức, dòng bị filter
        # bỏ qua) vẫn đúng vị trí -> GIỮ LẠI (tier-1: cụm 'mất highlight').
        # Tier-2: nếu highlight GẦN HẾT nằm trên 1 segment bị dịch (≥60% diện
        # tích annot giao union redact của segment) -> sau khi vẽ VI, vẽ lại
        # highlight trên box segment mới (chữ đã reflow). Ngưỡng cao để tránh
        # over-highlight khi annot gốc chỉ phủ vài câu trong segment lớn.
        hdrs = _header_dups(page)              # dọn header lặp trên trang bị redact
        red_rects = [fitz.Rect(r) for it, _vi in items for r in it["redact"]]
        red_rects += [rect for rect, _t, _s, _c in hdrs]  # header cũng bị redact+vẽ lại
        # Map segment id -> union of its redact rects (for tier-2 matching)
        seg_redact_union = {}
        for it, _vi in items:
            u = fitz.Rect()
            for r in it["redact"]:
                u |= fitz.Rect(r)
            if not u.is_empty:
                seg_redact_union[it["id"]] = u
        re_hl = []  # [(box_rect, stroke_rgb_or_None)]
        for an in list(page.annots() or []):
            if an.type[1] not in ("Highlight", "Underline", "StrikeOut", "Squiggly"):
                continue
            if not any(an.rect.intersects(rr) for rr in red_rects):
                continue  # không giao redact -> giữ nguyên (tier-1)
            # Tier-2: tìm segment mà annot phủ ≥60%
            ar = an.rect
            ar_area = max(ar.get_area(), 1e-6)
            best_id, best_ratio = None, 0.0
            for sid, u in seg_redact_union.items():
                inter = ar & u
                if inter.is_empty:
                    continue
                ratio = inter.get_area() / ar_area
                if ratio > best_ratio:
                    best_ratio, best_id = ratio, sid
            if best_id is not None and best_ratio >= 0.60:
                # Lấy box đích (chỗ chữ Việt sẽ nằm)
                for it, _vi in items:
                    if it["id"] == best_id:
                        l, t, r, b = it["box"]
                        re_hl.append((
                            fitz.Rect(l, t, r, max(b, t + it["size"] + 2)),
                            an.type[1],
                            (an.colors or {}).get("stroke"),
                        ))
                        break
            page.delete_annot(an)
        for item, _vi in items:
            for r in item["redact"]:
                page.add_redact_annot(fitz.Rect(r))
        for rect, _txt, _sz, _col in hdrs:
            page.add_redact_annot(rect)
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                              graphics=fitz.PDF_REDACT_LINE_ART_NONE)
        for item, vi in items:
            l, t, r, b = item["box"]
            box = fitz.Rect(l, t, r, max(b, t + item["size"] + 2))
            s = min(fits.get(item["id"], 1.0), cap)
            html = _seg_html(vi, item["size"], item["color"],
                             item.get("lh") or 1.12, item.get("align"),
                             item.get("fx"), s, _fx_prefix(item))
            fallback = None
            spare_height = None
            renderer_scale = 1.0
            overflow = False
            try:
                # scale_low=0.3: lưới an toàn — nếu đo trước vẫn lệch thì co
                # thêm cho VỪA, tuyệt đối không tràn đè phần tử giữ nguyên.
                spare_height, renderer_scale = page.insert_htmlbox(
                    box, html, css=css, archive=ar, scale_low=0.3
                )
                overflow = spare_height < 0
                if overflow:
                    fallback = "plain_text"
                    fallback_size = _fit(
                        page, box, strip_markers(vi), item["size"],
                        _int_color_to_rgb(item["color"]), fallback_font,
                    )
                    renderer_scale = fallback_size / max(item["size"], 0.1)
            except Exception:
                fallback = "plain_text"
                fallback_size = _fit(
                    page, box, strip_markers(vi), item["size"],
                    _int_color_to_rgb(item["color"]), fallback_font,
                )
                renderer_scale = fallback_size / max(item["size"], 0.1)
            applied += 1
            if report is not None:
                actual_scale = max(0.0, min(
                    1.0,
                    float(renderer_scale) if fallback else s * float(renderer_scale),
                ))
                review_floor = _review_scale_floor(item)
                review_required = bool(
                    actual_scale < review_floor or fallback is not None or overflow
                )
                if review_required:
                    report["review_count"] += 1
                report["segments"].append({
                    "id": item["id"],
                    "page": pno,
                    "type": item.get("type", "paragraph"),
                    "box": list(item["box"]),
                    "optimal_scale": round(fits.get(item["id"], 1.0), 4),
                    "requested_scale": round(s, 4),
                    "renderer_scale": round(float(renderer_scale), 4),
                    "actual_scale": round(actual_scale, 4),
                    "review_scale_floor": review_floor,
                    "spare_height": (round(float(spare_height), 3)
                                     if spare_height is not None else None),
                    "formula_count": len(item.get("fx") or []),
                    "fallback": fallback,
                    "overflow": overflow,
                    "review_required": review_required,
                    "status": "review" if review_required else "ok",
                })
        for rect, txt, sz, col in hdrs:        # vẽ lại 1 bản header sạch
            _fit(page, rect, txt, sz, _int_color_to_rgb(col), fallback_font)
        # Tier-2: vẽ lại highlight/underline trên box segment đã dịch
        for box, kind, stroke in re_hl:
            try:
                if kind == "Highlight":
                    ann = page.add_highlight_annot(box)
                elif kind == "Underline":
                    ann = page.add_underline_annot(box)
                elif kind == "StrikeOut":
                    ann = page.add_strikeout_annot(box)
                else:
                    ann = page.add_squiggly_annot(box)
                if stroke:
                    ann.set_colors(stroke=stroke)
                ann.update()
            except Exception:
                pass  # annot API khác phiên bản PyMuPDF — bỏ qua, không phá apply
    if report is not None:
        report["applied"] = applied
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
            return s
        s -= 0.25 if s <= 7 else 0.5
    page.insert_textbox(box, text, fontname="vi", fontfile=fontfile,
                        fontsize=5.5, color=color, align=0, lineheight=1.0)
    return 5.5
