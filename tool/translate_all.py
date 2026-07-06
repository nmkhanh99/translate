#!/usr/bin/env python3
"""
translate_all.py — Dịch HÀNG LOẠT mọi PDF trong 1 thư mục sang tiếng Việt,
giữ nguyên layout. Dùng chung lõi `pdf_core`.

Đặc điểm cho job lớn (hàng nghìn trang):
  - Dịch SONG SONG (ThreadPoolExecutor) cho nhanh.
  - Cache JSON / mỗi PDF -> resume được, và FIX TOOL rồi chạy lại chỉ tốn bước
    apply (dịch đã cache nên không gọi lại mạng).
  - Ghi progress ra file để theo dõi bất cứ lúc nào.
  - Lỗi 1 đoạn -> giữ nguyên tiếng Anh, không làm hỏng cả job.

  python3 translate_all.py --src "<thư mục PDF>" --out "<thư mục VI>" \
      --workers 10 [--only L1V1,L1V2] [--pages all]
"""
import argparse
import glob
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import fitz
import pdf_core
from deep_translator import GoogleTranslator

_tl = threading.local()


def _translator():
    if not hasattr(_tl, "t"):
        _tl.t = GoogleTranslator(source="en", target="vi")
    return _tl.t


def log(logpath, msg):
    line = time.strftime("%H:%M:%S ") + msg
    print(line, flush=True)
    with open(logpath, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def translate_unique(texts, workers, cache, cache_path, logpath, name):
    todo = [t for t in texts if t not in cache]
    total = len(todo)
    if not total:
        return
    done = [0]
    fail = [0]
    lock = threading.Lock()

    def work(t):
        res = None
        for _ in range(4):
            try:
                res = _translator().translate(t)
                if res:
                    break
            except Exception:
                time.sleep(1.5)
        with lock:
            if res:
                cache[t] = res          # CHỈ cache khi thành công
            else:
                fail[0] += 1            # thất bại -> KHÔNG cache để resume thử lại
            done[0] += 1
            if done[0] % 100 == 0 or done[0] == total:
                json.dump(cache, open(cache_path, "w", encoding="utf-8"),
                          ensure_ascii=False)
                log(logpath, f"  {name}: dịch {done[0]}/{total} (lỗi {fail[0]})")

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(work, todo))
    json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)


def process_pdf(path, outdir, workers, pages, logpath):
    name = os.path.basename(path)
    out = os.path.join(outdir, name)
    cache_path = os.path.join(outdir, name + ".cache.json")
    cache = {}
    if os.path.exists(cache_path):
        cache = json.load(open(cache_path, encoding="utf-8"))

    doc = fitz.open(path)
    segs, layout = pdf_core.extract_segments(doc, pages)
    todo = sum(1 for s in segs if s["text"] not in cache)
    log(logpath, f"▶ {name}: {doc.page_count} trang, {len(segs)} đoạn, "
                 f"cần dịch {todo} (cache {len(segs) - todo})")

    texts = list({s["text"] for s in segs})
    translate_unique(texts, workers, cache, cache_path, logpath, name)

    trans = {s["id"]: cache.get(s["text"], s["text"]) for s in segs}
    applied, missing = pdf_core.apply_translations(doc, layout, trans)
    doc.save(out, garbage=4, deflate=True)
    log(logpath, f"✓ {name}: lưu {out} (áp dụng {applied}, thiếu {len(missing)})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--pages", default="all")
    ap.add_argument("--only", default=None,
                    help="lọc theo chuỗi con tên file, cách nhau bởi dấu phẩy")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.src, "*.pdf")),
                   key=lambda p: fitz.open(p).page_count)  # nhỏ -> lớn
    if args.only:
        keys = [k.strip() for k in args.only.split(",")]
        files = [f for f in files if any(k in os.path.basename(f) for k in keys)]

    os.makedirs(args.out, exist_ok=True)
    logpath = os.path.join(args.out, "_progress.log")
    log(logpath, f"=== BẮT ĐẦU: {len(files)} file, workers={args.workers} ===")
    for f in files:
        try:
            process_pdf(f, args.out, args.workers, args.pages, logpath)
        except Exception as e:
            log(logpath, f"✗ LỖI {os.path.basename(f)}: {e!r}")
    log(logpath, "=== XONG ===")


if __name__ == "__main__":
    main()
