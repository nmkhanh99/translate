#!/usr/bin/env python3
"""
agent_pipeline.py — Helper cho pipeline AGENT dịch 1 volume (dùng với Workflow).
Các bước xác định (không cần AI) gom ở đây; phần dịch/verify/review do Workflow.

Quy trình 1 volume:
  1) chunk   : trích đoạn + chia lô dịch (chunks/)
  2) [Workflow dịch -> out/]
  3) merge-tr: gộp out/ -> text2vi.json (key theo TEXT, bền với đổi tool)
  4) vchunk  : tạo lô verify cho đoạn có SỐ/nghi chưa dịch (vchunks/)
  5) [Workflow verify -> vout/]
  6) merge-vr: gộp sửa lỗi vào text2vi.json
  7) apply   : ghi đè giữ layout -> file đích

Cache text2vi.json đặt trong workdir, có thể tái dùng giữa các bước/đổi tool.
"""
import glob
import hashlib
import json
import os
import re
import shutil
import sys

import fitz
import pdf_core

DIGIT = re.compile(r"\d")


def _wd(workdir, *p):
    return os.path.join(workdir, *p)


def _load(p, default):
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else default


def cmd_chunk(pdf, workdir, size=40, force=False):
    """Resume-safe: chỉ tạo chunks/ một lần. KHÔNG xoá out/ (giữ tiến độ dịch).
    Đã có chunks/ -> no-op trừ khi force=True.
    force: MERGE out/ cũ vào text2vi trước (giữ tiến độ) rồi xoá cả chunks/ lẫn
    out/ — out cũ đánh index theo chunking CŨ, giữ lại sẽ va index với chunks
    mới (merge-tr dán nhầm bản dịch). Dùng sau khi sửa engine đổi segmentation:
    todo mới = các text CHƯA có trong cache -> chỉ dịch phần mới."""
    os.makedirs(workdir, exist_ok=True)
    existing = glob.glob(_wd(workdir, "chunks", "c_*.json"))
    if existing and not force:
        print(f"chunk: đã có {len(existing)} chunks, bỏ qua (dùng force để tạo lại).")
        return len(existing)
    if force and glob.glob(_wd(workdir, "out", "c_*.json")):
        cmd_merge_tr(pdf, workdir)  # gom tiến độ cũ vào text2vi trước khi xoá
        shutil.rmtree(_wd(workdir, "out"), ignore_errors=True)
    shutil.rmtree(_wd(workdir, "chunks"), ignore_errors=True)
    os.makedirs(_wd(workdir, "chunks"))
    os.makedirs(_wd(workdir, "out"), exist_ok=True)
    doc = fitz.open(pdf)
    segs, layout = pdf_core.extract_segments(doc, "all")
    json.dump({"pdf": pdf, "layout": layout}, open(_wd(workdir, "layout.json"), "w"),
              ensure_ascii=False)
    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    seen, todo = set(), []
    for s in segs:
        if s["text"] in text2vi or s["text"] in seen:
            continue
        seen.add(s["text"])
        todo.append({"id": f"t{len(todo)}", "text": s["text"]})
    for i in range(0, len(todo), size):
        json.dump(todo[i:i + size], open(_wd(workdir, "chunks", f"c_{i//size:03d}.json"), "w"),
                  ensure_ascii=False)
    nch = (len(todo) + size - 1) // size
    print(f"pages={doc.page_count} segs={len(segs)} cached={len(segs)-len(todo)} "
          f"todo={len(todo)} chunks={nch}")
    return nch


def cmd_merge_tr(pdf, workdir):
    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    n = 0
    for f in glob.glob(_wd(workdir, "out", "c_*.json")):
        idx = os.path.basename(f).split("_")[1].split(".")[0]
        src = {it["id"]: it["text"] for it in json.load(open(_wd(workdir, "chunks", f"c_{idx}.json")))}
        for cid, vi in json.load(open(f)).items():
            if cid in src and vi:
                text2vi[src[cid]] = vi
                n += 1
    json.dump(text2vi, open(_wd(workdir, "text2vi.json"), "w"), ensure_ascii=False)
    doc = fitz.open(pdf)
    segs, _ = pdf_core.extract_segments(doc, "all")
    miss = sum(1 for s in segs if s["text"] not in text2vi)
    print(f"merged={n} total_text2vi={len(text2vi)} still_missing={miss}")
    return miss


def cmd_vchunk(pdf, workdir, size=25, mode="all", force=False):
    """mode='all': verify MỌI đoạn (bắt cả bỏ sót/sai nghĩa, chính xác hơn vision).
    mode='num': chỉ đoạn có số / nghi chưa dịch.
    Resume-safe: đã có vchunks/ -> no-op trừ khi force.
    force: MERGE vout/ cũ (theo vid2en CŨ) vào text2vi trước rồi xoá vchunks/ +
    vout/ — vout cũ đánh vid theo vid2en cũ, giữ lại sẽ dán sửa lỗi nhầm đoạn
    sau khi vid2en bị ghi đè."""
    existing = glob.glob(_wd(workdir, "vchunks", "v_*.json"))
    if existing and not force:
        print(f"vchunk: đã có {len(existing)} vchunks, bỏ qua (dùng force để tạo lại).")
        return len(existing)
    if force and glob.glob(_wd(workdir, "vout", "v_*.json")):
        cmd_merge_vr(workdir)  # gom theo vid2en CŨ trước khi ghi đè
        shutil.rmtree(_wd(workdir, "vout"), ignore_errors=True)
    shutil.rmtree(_wd(workdir, "vchunks"), ignore_errors=True)
    os.makedirs(_wd(workdir, "vchunks"))
    os.makedirs(_wd(workdir, "vout"), exist_ok=True)
    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    doc = fitz.open(pdf)
    segs, _ = pdf_core.extract_segments(doc, "all")

    def untranslated(en, vi):
        if not vi:
            return True
        return sum(1 for c in vi if ord(c) > 0x100) < max(3, len(vi) * 0.02)

    seen, uniq = set(), []
    for s in segs:
        en = s["text"]
        if en in seen:
            continue
        vi = text2vi.get(en, "")
        if mode == "all" or DIGIT.search(en) or untranslated(en, vi):
            seen.add(en)
            uniq.append({"id": f"v{len(uniq)}", "en": en, "vi": vi})
    json.dump({u["id"]: u["en"] for u in uniq}, open(_wd(workdir, "vid2en.json"), "w"),
              ensure_ascii=False)
    for i in range(0, len(uniq), size):
        json.dump(uniq[i:i + size], open(_wd(workdir, "vchunks", f"v_{i//size:03d}.json"), "w"),
                  ensure_ascii=False)
    nch = (len(uniq) + size - 1) // size
    print(f"verify_targets={len(uniq)} vchunks={nch}")
    return nch


def cmd_merge_vr(workdir):
    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    vid2en = _load(_wd(workdir, "vid2en.json"), {})
    n, bad = 0, 0
    for f in glob.glob(_wd(workdir, "vout", "v_*.json")):
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception:
            bad += 1
            continue
        for vid, corrected in d.items():
            if vid in vid2en and corrected:
                text2vi[vid2en[vid]] = corrected
                n += 1
    if bad:
        print(f"  (bỏ qua {bad} file vout hỏng JSON)")
    json.dump(text2vi, open(_wd(workdir, "text2vi.json"), "w"), ensure_ascii=False)
    print(f"corrections_applied={n}")
    return n


def _fix_lookup(fixes, sid, en):
    """Tra override rút gọn theo id, XÁC MINH en còn khớp (id sN đánh theo thứ tự
    trích xuất — engine fix đổi segmentation sẽ dịch chuyển id; entry lệch en bị
    bỏ qua). Chấp nhận format cũ (string, không có en để đối chiếu)."""
    f = fixes.get(sid)
    if f is None:
        return None
    if isinstance(f, str):
        return f  # legacy — không xác minh được
    if f.get("en") == en:
        return f.get("vi") or None
    return None  # id đã trỏ sang đoạn khác -> override hết hiệu lực


def cmd_apply(pdf, workdir, out):
    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    # fixes.json = override RÚT GỌN theo SEGMENT ID (ưu tiên cao nhất). Khoá theo
    # id (không phải EN) nên chỉ đổi đúng đoạn trên trang bị lỗi — các trang khác
    # dùng cùng chuỗi EN KHÔNG bị ảnh hưởng (điều kiện để only-vision hợp lệ) — và
    # sống sót qua merge-tr/merge-vr/apply-all vì các bước đó chỉ ghi text2vi.
    fixes = _load(_wd(workdir, "fixes.json"), {})
    doc = fitz.open(pdf)
    segs, layout = pdf_core.extract_segments(doc, "all")
    trans = {l["id"]: (_fix_lookup(fixes, l["id"], s["text"])
                       or text2vi.get(s["text"], ""))
             for s, l in zip(segs, layout)}
    miss = sum(1 for s, l in zip(segs, layout)
               if not (_fix_lookup(fixes, l["id"], s["text"])
                       or text2vi.get(s["text"])))
    applied, m = pdf_core.apply_translations(doc, layout, trans)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    doc.save(out, garbage=4, deflate=True)
    print(f"applied={applied} missing={miss} fixes={len(fixes)} -> {out}")


def _count(workdir, sub, pat):
    return len(glob.glob(_wd(workdir, sub, pat)))


_SEV = {"high": 3, "medium": 2, "low": 1}
# Ngưỡng "phải sửa" dùng thống nhất cho gate trạng thái + vòng auto-fix: defect
# >= medium (kind != fit, chưa accepted) mới chặn 'done'. 'fit' và 'low' được coi
# là đánh đổi chấp nhận được nên không chặn (tránh kẹt vòng vô hạn vì lỗi vặt).
FIX_SEV = "medium"


def _defect_pages(workdir, min_sev="medium"):
    """Danh sách trang còn LỖI CẦN FIX: kind 'defect' (không phải 'fit'), >= mức
    nghiêm trọng, và KHÔNG nằm trong accepted.json (won't-fix). Nguồn sự thật =
    review_issues.json (đã merge từ vision)."""
    thr = _SEV.get(min_sev, 1)
    issues = _load(_wd(workdir, "review_issues.json"), [])
    accepted = set(_load(_wd(workdir, "accepted.json"), {}).get("pages", []))
    return sorted({x["page"] for x in issues
                   if x.get("kind", "defect") != "fit"
                   and _SEV.get(x.get("severity", "low"), 1) >= thr
                   and x["page"] not in accepted})


def _status(workdir):
    """Tính tiến độ từng stage (nguồn sự thật = các file). Không in.
    Stage 'review' = đã vision xong nhưng CÒN defect chưa fix -> 'done' CHỈ khi
    mọi defect >= medium đã được sửa/accepted."""
    c, co = _count(workdir, "chunks", "c_*.json"), _count(workdir, "out", "c_*.json")
    v, vo = _count(workdir, "vchunks", "v_*.json"), _count(workdir, "vout", "v_*.json")
    pairs = _count(workdir, "review", "pair_*.png")
    vis = _count(workdir, "vis", "page_*.json")
    layout = _load(_wd(workdir, "layout.json"), {})
    pages = fitz.open(layout["pdf"]).page_count if layout.get("pdf") and os.path.exists(layout.get("pdf", "")) else None
    defects = _defect_pages(workdir, FIX_SEV)
    # 'done' chỉ khi review_issues.json ĐÃ được ghi (merge-vis chạy xong) — nếu
    # thiếu (vd crash sau khi ghi các vis/page_*.json nhưng trước merge-vis) thì
    # coi như vision chưa chốt, tránh 'done' giả với defect chưa gộp.
    has_review = os.path.exists(_wd(workdir, "review_issues.json"))
    if c == 0 or co < c:
        stage = "translate"
    elif vo < v or v == 0:
        stage = "verify"
    elif pages is not None and (vis < pages or not has_review):
        stage = "vision"
    elif defects:
        stage = "review"
    else:
        stage = "done"
    return {"stage": stage, "translate": [co, c], "verify": [vo, v],
            "vision": [vis, pages], "pairs": pairs, "defects": len(defects)}


def cmd_status(workdir, write=True):
    """Quét workdir, tính tiến độ từng stage, ghi state.json."""
    st = _status(workdir)
    if write:
        json.dump(st, open(_wd(workdir, "state.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(st, ensure_ascii=False))
    return st


def cmd_volumes(manifest):
    """In JSON các volume CHƯA done (bỏ skip) để Workflow lặp batch."""
    vols = _load(manifest, [])
    todo = []
    for v in vols:
        if v.get("skip"):
            continue
        st = _status(v["workdir"]) if os.path.exists(_wd(v["workdir"], "layout.json")) else {"stage": "translate"}
        if st["stage"] != "done":
            todo.append({"pdf": v["pdf"], "workdir": v["workdir"], "out": v["out"],
                         "vision": v.get("vision", True), "stage": st["stage"]})
    print(json.dumps(todo, ensure_ascii=False))
    return todo


def cmd_apply_all(manifest):
    """XUẤT CẢ BỘ: apply lại mọi volume (bỏ skip) -> ghi đè PDF cuối vào thư mục
    đích bằng engine HIỆN TẠI + bản dịch đã cache. Rẻ, không gọi agent. Dùng sau
    khi sửa engine để đồng bộ tất cả PDF về bản mới nhất."""
    vols = _load(manifest, [])
    done = 0
    for v in vols:
        if v.get("skip"):
            print(f"  [skip] {os.path.basename(v['pdf'])}")
            continue
        if not os.path.exists(_wd(v["workdir"], "layout.json")):
            print(f"  [bỏ]  {os.path.basename(v['pdf'])}: chưa chunk")
            continue
        # Volume đang có pipeline chạy: merge out/vout dở dang + ghi đè PDF sẽ
        # RACE với tiến trình đó (mất cache update / hỏng file đích). Bỏ qua.
        meta = _load(_wd(v["workdir"], "run.json"), {})
        if meta.get("mode") == "running" and meta.get("pid"):
            try:
                os.kill(int(meta["pid"]), 0)
                print(f"  [đang chạy — bỏ qua] {os.path.basename(v['pdf'])}")
                continue
            except (OSError, ValueError):
                pass  # pid chết -> meta cũ, xử lý bình thường
        # gom out/ + vout/ vào text2vi trước (volume đang dịch dở có thể chưa merge)
        if glob.glob(_wd(v["workdir"], "out", "c_*.json")):
            cmd_merge_tr(v["pdf"], v["workdir"])
        if glob.glob(_wd(v["workdir"], "vout", "v_*.json")):
            cmd_merge_vr(v["workdir"])
        print(f"  {os.path.basename(v['pdf'])}: ", end="")
        cmd_apply(v["pdf"], v["workdir"], v["out"])
        done += 1
    print(f"apply-all xong: {done} volume -> {os.path.dirname(vols[0]['out']) if vols else ''}")


def cmd_batch_status(manifest):
    """Tổng quan tiến độ cả manifest (người đọc)."""
    vols = _load(manifest, [])
    done = 0
    for v in vols:
        if v.get("skip"):
            print(f"  [skip] {os.path.basename(v['pdf'])}  ({v.get('note','')})")
            continue
        st = _status(v["workdir"]) if os.path.exists(_wd(v["workdir"], "layout.json")) else {"stage": "(chưa chunk)", "translate": [0, 0], "verify": [0, 0], "vision": [0, None]}
        done += st["stage"] == "done"
        print(f"  [{st['stage']:9}] {os.path.basename(v['pdf']):42} "
              f"tr={st['translate']} vr={st['verify']} vis={st['vision']}")
    real = [v for v in vols if not v.get("skip")]
    print(f"done {done}/{len(real)} (bỏ {len(vols)-len(real)} skip)")


def cmd_vis_pages(pdf, out, workdir, dpi=130, only=None):
    """Render ảnh ghép gốc|dịch (trang còn thiếu PNG, HOẶC PNG đã CŨ hơn file đích
    -> apply sau đã ghi đè PDF -> ảnh cache stale) và liệt kê trang chưa review
    (chưa có vis/page_XXX.json) -> vis_todo.json. Resume-safe per-page.
    PNG stale kéo theo xoá luôn verdict vis/page_XXX.json cũ (nếu có) vì nó được
    chấm trên ảnh sai -> trang tự động vào lại todo để review lại đúng bản mới.

    only=CSV: CHỈ xử lý các trang đó (dùng cho vòng auto-fix). apply ghi đè CẢ
    file đích nên MỌI png thành stale; nếu không giới hạn, mỗi vòng fix sẽ render
    lại + review lại toàn bộ volume. Các trang không-fix nội dung KHÔNG đổi nên
    verdict cũ vẫn đúng -> chỉ re-render + re-review đúng trang vừa sửa."""
    rev, visd = _wd(workdir, "review"), _wd(workdir, "vis")
    os.makedirs(rev, exist_ok=True)
    os.makedirs(visd, exist_ok=True)
    only_set = None
    if only:
        only_set = {int(x) for x in str(only).split(",") if x.strip().lstrip("-").isdigit()}
    src, vi = fitz.open(pdf), fitz.open(out)
    out_mtime = os.path.getmtime(out)
    m = fitz.Matrix(dpi / 72, dpi / 72)
    gap, rendered, invalidated, todo = 20, 0, 0, []
    for i in range(src.page_count):
        if only_set is not None and i not in only_set:
            continue
        png = _wd(rev, f"pair_{i:03d}.png")
        vjson = _wd(visd, f"page_{i:03d}.json")
        # only-mode: trang vừa fix -> LUÔN render lại + bỏ verdict cũ.
        stale = (os.path.exists(png) and os.path.getmtime(png) < out_mtime) or only_set is not None
        if not os.path.exists(png) or stale:
            p1, p2 = src[i].get_pixmap(matrix=m), vi[i].get_pixmap(matrix=m)
            W, H = p1.width + gap + p2.width, max(p1.height, p2.height)
            d = fitz.open()
            pg = d.new_page(width=W, height=H)
            pg.insert_image(fitz.Rect(0, 0, p1.width, p1.height), pixmap=p1)
            pg.insert_image(fitz.Rect(p1.width + gap, 0, p1.width + gap + p2.width, p2.height), pixmap=p2)
            pg.get_pixmap(matrix=fitz.Matrix(1, 1)).save(png)
            rendered += 1
            if stale and os.path.exists(vjson):
                os.remove(vjson)
                invalidated += 1
        if not os.path.exists(vjson):
            todo.append({"page": i, "img": png})
    json.dump(todo, open(_wd(workdir, "vis_todo.json"), "w"), ensure_ascii=False)
    print(f"pages={src.page_count} rendered={rendered} invalidated_stale_verdicts={invalidated} review_todo={len(todo)}")
    return todo


def cmd_merge_vis(workdir):
    """Gộp vis/page_XXX.json (mỗi file = list issue của 1 trang) -> review_issues.json."""
    issues = []
    for f in sorted(glob.glob(_wd(workdir, "vis", "page_*.json"))):
        try:
            issues.extend(json.load(open(f, encoding="utf-8")))
        except Exception:
            pass
    json.dump(issues, open(_wd(workdir, "review_issues.json"), "w"),
              ensure_ascii=False, indent=1)
    hi = sum(1 for x in issues if x.get("severity") == "high")
    print(f"review_issues={len(issues)} high={hi} -> {_wd(workdir,'review_issues.json')}")
    return issues


# ── Phân loại defect theo CỤM pattern + kênh sửa ─────────────────────────────
# channel: 'text'   = rút gọn bản dịch là đủ (vòng auto-fix hiện có)
#          'code'   = phải sửa engine pdf_core (extraction/apply) — sửa 1 lần
#                     chữa MỌI trang cùng pattern
#          'policy' = hành vi cố ý của engine (vd xoá highlight) — đổi chính
#                     sách hoặc accept
#          'mixed'  = phần text + phần code
DEFECT_RULES = [
    ("highlight_mat",   r"highlight|nền vàng|màu vàng",                                    "policy"),
    ("congthuc_vo",     r"công thức|phân số|subscript|superscript|số mũ|overline|căn bậc", "code"),
    ("bang_vo",         r"bảng|exhibit.*cột|cột.*dồn|2 cột|3 cột|hàng.*giá trị",           "code"),
    ("bullet_indent",   r"bullet|indent|thụt lề|đánh dấu đầu dòng",                        "code"),
    ("chu_de_chong",    r"đè|chồng|overlap|xuyên qua",                                     "mixed"),
    ("tran_khung",      r"tràn|sát viền|chạm viền|vượt khung|bị cắt|clip",                 "text"),
    ("label_tach_dong", r"tách.*dòng riêng|thành.*tiêu đề|run-in",                         "code"),
    ("header_hong",     r"header|đầu trang.*lặp",                                          "code"),
]


def _classify_defects(workdir, min_sev=FIX_SEV):
    """Trả về list cluster: {name, channel, count, pages, sample_details}."""
    thr = _SEV.get(min_sev, 1)
    issues = _load(_wd(workdir, "review_issues.json"), [])
    accepted = set(_load(_wd(workdir, "accepted.json"), {}).get("pages", []))
    defects = [x for x in issues
               if x.get("kind", "defect") != "fit"
               and _SEV.get(x.get("severity", "low"), 1) >= thr
               and x["page"] not in accepted]
    groups = {}
    for d in defects:
        det = d.get("detail", "").lower()
        for name, pat, channel in DEFECT_RULES:
            if re.search(pat, det):
                key, ch = name, channel
                break
        else:
            key, ch = "khac", "unknown"
        g = groups.setdefault(key, {"name": key, "channel": ch, "count": 0,
                                    "pages": set(), "sample_details": []})
        g["count"] += 1
        g["pages"].add(d["page"])
        if len(g["sample_details"]) < 3:
            g["sample_details"].append(
                {"page": d["page"], "detail": d.get("detail", "")[:160]})
    out = []
    for g in sorted(groups.values(), key=lambda x: -x["count"]):
        g["pages"] = sorted(g["pages"])
        out.append(g)
    return out


def cmd_defect_report(workdir, min_sev=FIX_SEV):
    """Báo cáo defect theo CỤM + kênh sửa gợi ý (JSON). Dùng để quyết định:
    cụm nào để vòng auto-fix rút gọn text, cụm nào phải sửa engine (pdf_core),
    cụm nào là policy/accept. Xem python/LAYOUT_PLAYBOOK.md."""
    clusters = _classify_defects(workdir, min_sev)
    total_pages = sorted({p for c in clusters for p in c["pages"]})
    print(json.dumps({"min_sev": min_sev, "defect_pages": len(total_pages),
                      "clusters": clusters}, ensure_ascii=False))
    return clusters


def cmd_problems(workdir, min_sev=FIX_SEV, channel=None):
    """In JSON các trang còn LỖI CẦN FIX = kind 'defect', >= mức nghiêm trọng, và
    KHÔNG nằm trong accepted.json (đã đánh dấu won't-fix). Lỗi kind 'fit' (co/nhồi
    chữ cho vừa layout) bị loại -> vòng lặp hội tụ. Rỗng = trang đã ổn.
    channel='text': CHỈ trang có defect kênh text/mixed (rút gọn bản dịch có tác
    dụng) — để vòng auto-fix không phí công rút gọn trang lỗi engine."""
    if channel:
        want = {"text", "mixed"} if channel == "text" else {channel}
        pages = sorted({p for c in _classify_defects(workdir, min_sev)
                        if c["channel"] in want for p in c["pages"]})
    else:
        pages = _defect_pages(workdir, min_sev)
    print(json.dumps(pages))
    return pages


def cmd_accept(workdir, pages, note=""):
    """Đánh dấu trang là WON'T-FIX (lỗi chấp nhận, vd co chữ) -> accepted.json.
    'problems' sẽ bỏ qua các trang này nên vòng lặp fit→fix→re-vision hội tụ.
    CẢNH BÁO nếu trang còn defect KÊNH KHÁC policy — accept là PAGE-WIDE nên sẽ
    nuốt luôn các lỗi thật đó (vd trang vừa mất highlight vừa vỡ công thức)."""
    p = _wd(workdir, "accepted.json")
    acc = _load(p, {"pages": [], "notes": {}})
    idxs = [int(x) for x in str(pages).split(",") if x.strip().lstrip("-").isdigit()]
    issues = _load(_wd(workdir, "review_issues.json"), [])
    for i in idxs:
        others = []
        for x in issues:
            if x["page"] != i or x.get("kind", "defect") == "fit":
                continue
            if _SEV.get(x.get("severity", "low"), 1) < _SEV[FIX_SEV]:
                continue
            det = x.get("detail", "").lower()
            ch = "unknown"
            for name, pat, channel in DEFECT_RULES:
                if re.search(pat, det):
                    ch = channel
                    break
            if ch != "policy":
                others.append(f"[{ch}] {x.get('detail', '')[:80]}")
        if others:
            print(f"  ⚠ trang {i} còn {len(others)} defect KHÔNG phải policy — "
                  f"accept sẽ nuốt luôn: {others[0]}")
    for i in idxs:
        if i not in acc["pages"]:
            acc["pages"].append(i)
        if note:
            acc["notes"][str(i)] = note
    acc["pages"] = sorted(set(acc["pages"]))
    json.dump(acc, open(p, "w"), ensure_ascii=False, indent=1)
    print(f"accepted {len(idxs)} trang (won't-fix); tổng {len(acc['pages'])} trang.")
    return acc["pages"]


def cmd_revision(workdir, pages):
    """ĐÁNH DẤU các trang để vision lại: xoá checkpoint vis/page_XXX.json + ảnh
    review/pair_XXX.png của chúng. Lần vision sau sẽ render lại (từ PDF đã fix)
    và review lại ĐÚNG những trang này — không đụng trang khác.
    pages='problems' -> lấy mọi trang có lỗi (>=medium); hoặc danh sách '3,5,7'."""
    if str(pages) == "problems":
        idxs = cmd_problems(workdir, FIX_SEV)
    else:
        idxs = [int(p) for p in str(pages).split(",") if p.strip().lstrip("-").isdigit()]
    removed = 0
    for i in idxs:
        for sub, pat in (("vis", f"page_{i:03d}.json"), ("review", f"pair_{i:03d}.png")):
            f = _wd(workdir, sub, pat)
            if os.path.exists(f):
                os.remove(f)
                removed += 1
    print(f"đánh dấu {len(idxs)} trang để vision lại (xoá {removed} file checkpoint)")
    return idxs


def cmd_page_segments(pdf, workdir, pages_csv):
    """Ghi fix/page_XXX.json = [{id,en,vi}] cho các đoạn TRÊN những trang cần sửa
    (để agent rút gọn bản dịch bị tràn khung). In JSON list trang có nội dung."""
    idxs = {int(x) for x in str(pages_csv).split(",") if x.strip().lstrip("-").isdigit()}
    doc = fitz.open(pdf)
    segs, layout = pdf_core.extract_segments(doc, "all")
    id2en = {s["id"]: s["text"] for s in segs}
    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    fixes = _load(_wd(workdir, "fixes.json"), {})
    fixd = _wd(workdir, "fix")
    os.makedirs(fixd, exist_ok=True)
    os.makedirs(_wd(workdir, "fixout"), exist_ok=True)
    written = []
    for p in sorted(idxs):
        items = []
        for l in layout:
            if l["page"] != p:
                continue
            en = id2en.get(l["id"], "")
            # Bản vi HIỆN HÀNH = override fix (nếu có, đã xác minh en) rồi mới
            # tới text2vi — agent thấy đúng bản đang hiển thị.
            vi = _fix_lookup(fixes, l["id"], en) or text2vi.get(en, "")
            if en and vi:
                items.append({"id": l["id"], "en": en, "vi": vi})
        if items:
            json.dump(items, open(_wd(fixd, f"page_{p:03d}.json"), "w"), ensure_ascii=False)
            written.append(p)
    print(json.dumps(written))
    return written


def cmd_merge_fix(workdir):
    """Gộp bản dịch RÚT GỌN từ fixout/page_XXX.json ({id: vi_ngắn}) vào
    fixes.json — override theo SEGMENT ID (KHÔNG đụng text2vi, nên không đổi bản
    dịch của cùng chuỗi EN trên các trang khác). Xoá fix/ + fixout/ sau khi gộp.
    Chỉ ghi khi vi_ngắn KHÁC bản hiện tại để tránh churn không cần thiết."""
    fixes = _load(_wd(workdir, "fixes.json"), {})
    n = 0
    for f in glob.glob(_wd(workdir, "fix", "page_*.json")):
        outf = _wd(workdir, "fixout", os.path.basename(f))
        if not os.path.exists(outf):
            continue
        try:
            items = {it["id"]: it for it in json.load(open(f, encoding="utf-8"))}
            short = json.load(open(outf, encoding="utf-8"))
        except Exception:
            continue
        for cid, vi in short.items():
            it = items.get(cid)
            if it and vi and vi != it.get("vi", ""):
                # Lưu kèm 'en' để apply xác minh id vẫn trỏ đúng đoạn đó — id sN
                # đánh theo THỨ TỰ trích xuất, một engine fix đổi segmentation sẽ
                # dịch chuyển id; entry lệch en bị bỏ qua thay vì dán nhầm chỗ.
                fixes[cid] = {"en": it.get("en", ""), "vi": vi}
                n += 1
    json.dump(fixes, open(_wd(workdir, "fixes.json"), "w"), ensure_ascii=False)
    shutil.rmtree(_wd(workdir, "fix"), ignore_errors=True)
    shutil.rmtree(_wd(workdir, "fixout"), ignore_errors=True)
    print(f"fixes_applied={n} total_overrides={len(fixes)}")
    return n


def cmd_review_summary(workdir):
    """Tổng quan review 1 volume. 'Hội tụ' bám ĐÚNG ngưỡng chặn 'done' của status
    (defect >= FIX_SEV, chưa accepted) — lỗi 'low' báo riêng, không chặn."""
    issues = _load(_wd(workdir, "review_issues.json"), [])
    accepted = set(_load(_wd(workdir, "accepted.json"), {}).get("pages", []))
    dp = _defect_pages(workdir, FIX_SEV)   # trang chặn 'done' (>= medium)
    low = sorted({x["page"] for x in issues
                  if x.get("kind", "defect") != "fit"
                  and _SEV.get(x.get("severity", "low"), 1) < _SEV[FIX_SEV]
                  and x["page"] not in accepted})
    fit = [x for x in issues if x.get("kind") == "fit"]
    print(f"defect cần fix (>= {FIX_SEV})={len(dp)} ở trang {dp} | "
          f"low(không chặn)={len(low)} | fit(chấp nhận)={len(fit)} | "
          f"accepted={sorted(accepted)} | {'ĐÃ HỘI TỤ ✓' if not dp else 'còn việc'}")
    return dp


# ── Golden regression: sửa engine (pdf_core) an toàn ────────────────────────
# apply là DETERMINISTIC (cùng text2vi/fixes -> cùng pixel, đã kiểm chứng), nên
# pixel-hash từng trang là ground truth rẻ để phát hiện trang thay đổi.
# Quy trình: golden-snap -> sửa pdf_core -> apply -> golden-diff:
#   trang đổi = đúng các trang defect nhắm tới -> OK, re-vision đúng các trang đó
#   trang KHÁC cũng đổi -> engine fix gây tác dụng phụ, soi lại trước khi nhận.


def _page_hashes(pdf_path, dpi=100):
    doc = fitz.open(pdf_path)
    m = fitz.Matrix(dpi / 72, dpi / 72)
    return [hashlib.md5(doc[i].get_pixmap(matrix=m).tobytes("png")).hexdigest()
            for i in range(doc.page_count)]


def cmd_golden_snap(out_pdf, workdir, dpi=100):
    """Chụp baseline pixel-hash từng trang của PDF đích hiện tại -> golden.json.
    Chạy TRƯỚC khi sửa pdf_core."""
    hashes = _page_hashes(out_pdf, int(dpi))
    json.dump({"dpi": int(dpi), "out": out_pdf, "pages": len(hashes),
               "hashes": hashes},
              open(_wd(workdir, "golden.json"), "w"))
    print(f"golden-snap: {len(hashes)} trang @dpi{dpi} -> golden.json")
    return len(hashes)


def cmd_golden_diff(out_pdf, workdir):
    """So pixel-hash hiện tại với baseline -> JSON {changed:[trang 0-based], same}.
    Chạy SAU khi sửa pdf_core + apply lại. Trang đổi ngoài dự kiến = regression."""
    g = _load(_wd(workdir, "golden.json"), None)
    if not g:
        print(json.dumps({"error": "chưa có golden.json — chạy golden-snap trước"}))
        return None
    cur = _page_hashes(out_pdf, g["dpi"])
    n = min(len(cur), len(g["hashes"]))
    changed = [i for i in range(n) if cur[i] != g["hashes"][i]]
    # Fail-closed: lệch SỐ TRANG là thay đổi nghiêm trọng nhất — các trang ngoài
    # phần chung được coi là changed (mất trang cuối không được phép trả []).
    hi = max(len(cur), len(g["hashes"]))
    changed += list(range(n, hi))
    result = {"changed": changed, "same": n - len([i for i in changed if i < n]),
              "pages_before": len(g["hashes"]), "pages_after": len(cur),
              "ok": len(cur) == len(g["hashes"])}
    if g.get("out") and g["out"] != out_pdf:
        result["warn"] = f"baseline chụp từ file khác: {g['out']}"
    print(json.dumps(result, ensure_ascii=False))
    return result


def cmd_pending(workdir, stage, lo=None, hi=None):
    """In JSON list các unit CHƯA có output (để Workflow fan-out đúng phần còn dở).
    stage=translate -> chunks thiếu out/; verify -> vchunks thiếu vout/;
    vision -> CHỈ SỐ TRANG (nhẹ) trong vis_todo, lọc theo [lo,hi) nếu có.
    (Trả số trang thay vì object để output nhỏ, tránh lỗi khi shuttle qua agent.)"""
    if stage == "vision":
        pages = [t["page"] for t in _load(_wd(workdir, "vis_todo.json"), [])]
        if lo is not None:
            lo, hi = int(lo), int(hi)
            pages = [p for p in pages if lo <= p < hi]
        print(json.dumps(pages))
        return pages
    sub, osub, pfx = (("chunks", "out", "c_") if stage == "translate"
                      else ("vchunks", "vout", "v_"))
    out = []
    for f in sorted(glob.glob(_wd(workdir, sub, f"{pfx}*.json"))):
        idx = os.path.basename(f)[len(pfx):-5]
        op = _wd(workdir, osub, f"{pfx}{idx}.json")
        if not os.path.exists(op):
            out.append({"idx": idx, "in": os.path.abspath(f), "out": os.path.abspath(op)})
    print(json.dumps(out, ensure_ascii=False))
    return out


if __name__ == "__main__":
    cmd = sys.argv[1]
    a = sys.argv[2:]
    force = "--force" in a
    a = [x for x in a if x != "--force"]
    {
        "chunk": lambda: cmd_chunk(a[0], a[1], force=force),
        "merge-tr": lambda: cmd_merge_tr(a[0], a[1]),
        "vchunk": lambda: cmd_vchunk(a[0], a[1], force=force),
        "merge-vr": lambda: cmd_merge_vr(a[0]),
        "apply": lambda: cmd_apply(a[0], a[1], a[2]),
        "status": lambda: cmd_status(a[0]),
        "vis-pages": lambda: cmd_vis_pages(a[0], a[1], a[2], only=(a[3] if len(a) > 3 else None)),
        "merge-vis": lambda: cmd_merge_vis(a[0]),
        "pending": lambda: cmd_pending(a[0], a[1], *(a[2:4] if len(a) > 3 else [])),
        "volumes": lambda: cmd_volumes(a[0]),
        "batch-status": lambda: cmd_batch_status(a[0]),
        "apply-all": lambda: cmd_apply_all(a[0]),
        "problems": lambda: cmd_problems(a[0], a[1] if len(a) > 1 else FIX_SEV,
                                         a[2] if len(a) > 2 else None),
        "revision": lambda: cmd_revision(a[0], a[1]),
        "page-segments": lambda: cmd_page_segments(a[0], a[1], a[2]),
        "merge-fix": lambda: cmd_merge_fix(a[0]),
        "defect-report": lambda: cmd_defect_report(a[0], a[1] if len(a) > 1 else FIX_SEV),
        "golden-snap": lambda: cmd_golden_snap(a[0], a[1], a[2] if len(a) > 2 else 100),
        "golden-diff": lambda: cmd_golden_diff(a[0], a[1]),
        "accept": lambda: cmd_accept(a[0], a[1], a[2] if len(a) > 2 else ""),
        "review-summary": lambda: cmd_review_summary(a[0]),
    }[cmd]()
