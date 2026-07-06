#!/usr/bin/env python3
"""
translate_pdf.py — CLI dịch PDF tự động, GIỮ NGUYÊN layout (Design B).

Dùng chung lõi `pdf_core` với MCP server, nhưng tự dịch bằng engine (Google
Translate free) thay vì nhờ agent. Phù hợp chạy hàng loạt / không tương tác.

  python3 translate_pdf.py INPUT.pdf --out OUT.pdf --pages 40-46

- Engine pluggable (get_engine). Có cache JSON -> chạy lại miễn phí, resume được.
- Để dịch chất lượng cao hơn (giữ thuật ngữ, "VN (English term)"), dùng MCP
  server (server.py) để chính agent dịch.
"""
import argparse
import json
import os
import sys
import time

import fitz

import pdf_core


# ---------------- Engine dịch (pluggable) ----------------
class GoogleEngine:
    name = "google"

    def __init__(self, target="vi"):
        from deep_translator import GoogleTranslator
        self.t = GoogleTranslator(source="en", target=target)

    def translate_batch(self, texts):
        out = []
        for i in range(0, len(texts), 20):
            chunk = texts[i:i + 20]
            for _ in range(3):
                try:
                    out.extend(self.t.translate_batch(chunk))
                    break
                except Exception as e:
                    print(f"    [retry] {e}", file=sys.stderr)
                    time.sleep(2)
            else:
                out.extend(chunk)
        return out


def get_engine(name, target):
    if name == "google":
        return GoogleEngine(target)
    raise SystemExit(f"Engine chưa hỗ trợ: {name}")


def main():
    ap = argparse.ArgumentParser(description="Dịch PDF tự động, giữ layout")
    ap.add_argument("input")
    ap.add_argument("--out", required=True)
    ap.add_argument("--pages", default="all", help="vd 40-46 / 40,42 / all (0-based)")
    ap.add_argument("--engine", default="google")
    ap.add_argument("--target", default="vi")
    ap.add_argument("--cache", default=None)
    args = ap.parse_args()
    cache_path = args.cache or os.path.splitext(args.out)[0] + ".cache.json"

    doc = fitz.open(args.input)
    segments, layout = pdf_core.extract_segments(doc, args.pages)
    print(f"PDF: {args.input} ({doc.page_count} trang) -> {len(segments)} đoạn văn xuôi")

    cache = {}
    if os.path.exists(cache_path):
        cache = json.load(open(cache_path, encoding="utf-8"))

    todo = list(dict.fromkeys(s["text"] for s in segments if s["text"] not in cache))
    if todo:
        print(f"Dịch {len(todo)} đoạn mới (cache có {len(segments) - len(todo)})...")
        eng = get_engine(args.engine, args.target)
        for s, t in zip(todo, eng.translate_batch(todo)):
            cache[s] = t or s
        json.dump(cache, open(cache_path, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=0)
    else:
        print("Tất cả đoạn đã có trong cache.")

    translations = {s["id"]: cache.get(s["text"], s["text"]) for s in segments}
    applied, missing = pdf_core.apply_translations(doc, layout, translations)
    doc.save(args.out, garbage=4, deflate=True)
    print(f"\n✓ Đã lưu: {args.out}  (áp dụng {applied} đoạn, thiếu {len(missing)})")


if __name__ == "__main__":
    main()
