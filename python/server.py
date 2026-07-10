#!/usr/bin/env python3
"""
MCP server: cfa-pdf-translator
==============================
Dịch PDF sang BẤT KỲ ngôn ngữ nào, GIỮ NGUYÊN layout (hình ảnh, đồ thị, công
thức, bảng số đều không bị đụng tới). Theo Model Context Protocol (stdio) nên
dùng được với mọi MCP client: Claude Code, Claude Desktop, Codex, Cursor...

Kiến trúc "agent tự dịch" (Design A):
  1) extract_segments(pdf, pages)  -> trả về các đoạn văn xuôi [{id, text}]
                                      và tạo 1 session (lưu metadata layout).
  2) AGENT (chính bạn) tự dịch các đoạn đó sang ngôn ngữ đích.
  3) apply_translations(session_id, {id: bản_dịch}, out_pdf)
                                   -> ghi đè giữ layout, xuất PDF.

Tool phụ:
  - list_pdf_info(pdf): số trang, kích thước.
  - render_page(pdf, page): xuất 1 trang ra PNG để xem/đối chiếu.

LƯU Ý cho agent khi dịch:
  - Chỉ dịch phần văn xuôi được trả về. KHÔNG tự bịa thêm.
  - Giữ nguyên thuật ngữ chuyên ngành / mã (vd ETF, CAPM) nếu phù hợp.
  - Giữ nguyên con số, ký hiệu, công thức xuất hiện trong đoạn.
"""
import json
import os
import uuid

import fitz
from mcp.server.fastmcp import FastMCP

import pdf_core

mcp = FastMCP("cfa-pdf-translator")

# Nơi lưu session (metadata layout giữa 2 bước extract -> apply)
SESS_DIR = os.environ.get(
    "CFA_TRANSLATE_SESSIONS",
    os.path.join(os.path.expanduser("~"), ".cfa_pdf_translator", "sessions"),
)
os.makedirs(SESS_DIR, exist_ok=True)


def _sess_path(sid):
    return os.path.join(SESS_DIR, f"{sid}.json")


@mcp.tool()
def list_pdf_info(pdf_path: str) -> dict:
    """Xem thông tin PDF: số trang, kích thước trang đầu. Dùng để biết phạm vi
    trang trước khi trích/dịch. `pdf_path` là đường dẫn tuyệt đối tới file PDF."""
    doc = fitz.open(pdf_path)
    p0 = doc[0].rect
    return {
        "pdf_path": pdf_path,
        "page_count": doc.page_count,
        "page_size": [round(p0.width), round(p0.height)],
        "note": "pages dùng chỉ số 0-based; trang in trong sách thường lệch do "
                "phần đầu (bìa, mục lục).",
    }


@mcp.tool()
def extract_segments(pdf_path: str, pages: str = "all", max_segments: int = 400) -> dict:
    """BƯỚC 1. Trích các đoạn VĂN XUÔI cần dịch từ PDF (bỏ qua heading, công
    thức, số liệu, bảng, đồ thị — những thứ phải giữ nguyên).

    Tham số:
      - pdf_path: đường dẫn tuyệt đối tới PDF nguồn.
      - pages: "all" hoặc phạm vi 0-based, vd "40-46" hoặc "40,42,50-52".
      - max_segments: chặn an toàn; nếu vượt sẽ báo để bạn chia nhỏ pages.

    Trả về: { session_id, total, segments:[{id,text}], truncated }.
    Sau đó AGENT tự dịch `text` của từng segment rồi gọi apply_translations
    với { id: bản_dịch } và cùng session_id."""
    doc = fitz.open(pdf_path)
    segments, layout = pdf_core.extract_segments(doc, pages)
    truncated = False
    if len(segments) > max_segments:
        truncated = True
        keep_ids = {s["id"] for s in segments[:max_segments]}
        segments = segments[:max_segments]
        layout = [l for l in layout if l["id"] in keep_ids]

    sid = uuid.uuid4().hex[:12]
    json.dump(
        {"pdf_path": pdf_path, "pages": pages, "layout": layout},
        open(_sess_path(sid), "w", encoding="utf-8"),
        ensure_ascii=False,
    )
    return {
        "session_id": sid,
        "total": len(segments),
        "segments": segments,
        "truncated": truncated,
        "hint": "Dịch từng segment, giữ số/ký hiệu, rồi gọi apply_translations("
                f"session_id='{sid}', translations={{id: ban_dich}}, out_pdf=...).",
    }


@mcp.tool()
def apply_translations(session_id: str, translations: dict, out_pdf: str) -> dict:
    """BƯỚC 2. Ghi đè bản dịch vào PDF, GIỮ NGUYÊN layout, xuất ra `out_pdf`.

    Tham số:
      - session_id: lấy từ extract_segments.
      - translations: dict { segment_id: "bản dịch" }. Thiếu id nào thì đoạn đó
        giữ nguyên gốc.
      - out_pdf: đường dẫn tuyệt đối file PDF kết quả.

    Trả về: { out_pdf, applied, missing_ids, total }."""
    sp = _sess_path(session_id)
    if not os.path.exists(sp):
        return {"error": f"session_id không tồn tại: {session_id}"}
    sess = json.load(open(sp, encoding="utf-8"))
    doc = fitz.open(sess["pdf_path"])
    applied, missing = pdf_core.apply_translations(doc, sess["layout"], translations)
    doc.save(out_pdf, garbage=4, deflate=True)
    return {
        "out_pdf": out_pdf,
        "applied": applied,
        "missing_ids": missing,
        "total": len(sess["layout"]),
    }


@mcp.tool()
def render_page(pdf_path: str, page: int, out_png: str, dpi: int = 140) -> dict:
    """Xuất 1 trang PDF ra ảnh PNG để xem/đối chiếu layout. `page` là 0-based."""
    doc = fitz.open(pdf_path)
    if not (0 <= page < doc.page_count):
        return {"error": f"page ngoài phạm vi 0..{doc.page_count - 1}"}
    doc[page].get_pixmap(dpi=dpi).save(out_png)
    return {"out_png": out_png, "page": page}


if __name__ == "__main__":
    mcp.run()
