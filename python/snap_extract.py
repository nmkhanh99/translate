#!/usr/bin/env python3
"""Chụp/so snapshot extraction trên bộ trang sentinel — lưới regression rẻ khi
sửa pdf_core. Dùng: snap_extract.py snap <pdf> <out.json> | diff <pdf> <base.json>"""
import json
import sys

import fitz
import pdf_core

# Trang lỗi (mọi cụm) + trang ĐANG ĐÚNG (fix #9-#15 cũ: Solution/A.B.C./Step/LOS)
SENTINEL = [5, 9, 17, 21, 25, 28, 31, 32, 38, 42, 43, 46, 47, 53, 57, 58, 63,
            65, 84, 100, 103, 110, 130, 135, 150, 184, 195, 207, 235, 300,
            450, 500, 600, 620]


def snapshot(pdf):
    doc = fitz.open(pdf)
    spec = ",".join(str(p) for p in SENTINEL if p < doc.page_count)
    if not spec:
        # PDF quá ngắn, không trang sentinel nào tồn tại — parse_pages('') nghĩa
        # là 'all' sẽ âm thầm quét cả file; dừng rõ ràng thay vì snapshot lệch.
        raise SystemExit("PDF ngắn hơn mọi trang sentinel — không snapshot được")
    segs, layout = pdf_core.extract_segments(doc, spec)
    out = {}
    for s, l in zip(segs, layout):
        out.setdefault(str(l["page"]), []).append(
            {"text": s["text"][:80], "box": [round(v, 1) for v in l["box"]],
             "size": round(l["size"], 1), "nredact": len(l["redact"])})
    return out


if __name__ == "__main__":
    cmd, pdf = sys.argv[1], sys.argv[2]
    if cmd == "snap":
        json.dump(snapshot(pdf), open(sys.argv[3], "w"), ensure_ascii=False, indent=0)
        print(f"snapped {len(SENTINEL)} pages")
    else:  # diff
        base = json.load(open(sys.argv[3]))
        cur = snapshot(pdf)
        changed = []
        for p in sorted(set(base) | set(cur), key=int):
            b, c = base.get(p, []), cur.get(p, [])
            if b != c:
                changed.append(p)
                bt = {x["text"] for x in b}
                ct = {x["text"] for x in c}
                print(f"— trang {p}: {len(b)}→{len(c)} segs; "
                      f"-{len(bt - ct)} +{len(ct - bt)} text; "
                      f"box/size đổi: {sum(1 for x, y in zip(b, c) if x != y and x['text'] == y['text'])}")
                for t in sorted(bt - ct)[:3]:
                    print(f"   - {t[:70]}")
                for t in sorted(ct - bt)[:3]:
                    print(f"   + {t[:70]}")
        print(json.dumps({"changed_pages": changed}))
