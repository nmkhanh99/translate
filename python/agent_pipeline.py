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

ARTIFACT_MANIFEST_VERSION = 1
ENGINE_SCHEMA_VERSION = "ir-lite-v3"

# Generated state grouped by dependency. Source changes invalidate everything;
# translator/prompt/glossary changes keep parsing/chunks but discard translated
# outputs and every review artifact derived from them.
_TRANSLATION_DIRS = ("out", "vchunks", "vout", "vis", "review", "fix", "fixout")
_TRANSLATION_FILES = (
    "text2vi.json", "fixes.json", "marker_drop.json", "vid2en.json",
    "review_issues.json", "vis_todo.json", "accepted.json", "state.json",
    "workset.json", "defect_clusters.json", "render_report.json",
)
_SOURCE_DIRS = ("chunks",) + _TRANSLATION_DIRS
_SOURCE_FILES = ("layout.json", "preflight.json") + _TRANSLATION_FILES


def _wd(workdir, *p):
    return os.path.join(workdir, *p)


def _load(p, default):
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else default


def _write_json_atomic(path, data):
    """Write small coordination files atomically (runner may be cancelled)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _glossary_sha256(workdir):
    path = _wd(workdir, "glossary.json")
    return _sha256_file(path) if os.path.exists(path) else ""


def _normalise_translation_context(workdir, context):
    if context is None:
        return None
    context = context if isinstance(context, dict) else {}
    return {
        "target_language": str(context.get("target_language") or "vi"),
        "translator": str(context.get("translator") or "unknown"),
        "model": str(context.get("model") or "default"),
        "prompt_version": str(context.get("prompt_version") or "unknown"),
        "profile": str(context.get("profile") or "native"),
        # Always compute from the file actually used by the runner. A caller
        # cannot accidentally claim a stale glossary hash.
        "glossary_sha256": _glossary_sha256(workdir),
    }


def _remove_generated(workdir, dirs, files):
    removed = []
    for name in dirs:
        path = _wd(workdir, name)
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
            removed.append(name + "/")
    for name in files:
        path = _wd(workdir, name)
        if os.path.exists(path):
            try:
                os.remove(path)
                removed.append(name)
            except OSError:
                pass
    # MCP batch checkpoints are also translations of this exact source/context.
    for pattern in ("codex_state*.json", "codex_work*.pdf"):
        for path in glob.glob(_wd(workdir, pattern)):
            try:
                os.remove(path)
                removed.append(os.path.basename(path))
            except OSError:
                pass
    return removed


def _legacy_source_looks_stale(pdf, workdir):
    """Conservative first-manifest migration without destroying valid progress.

    Old workdirs have no content hash. Invalidate only with concrete evidence:
    layout points at another source, or source mtime is newer than layout/chunks.
    """
    layout_path = _wd(workdir, "layout.json")
    layout = _load(layout_path, {})
    old_pdf = layout.get("pdf") if isinstance(layout, dict) else None
    if old_pdf and os.path.abspath(old_pdf) != os.path.abspath(pdf):
        return True
    evidence = [layout_path] + sorted(glob.glob(_wd(workdir, "chunks", "c_*.json")))
    evidence = [p for p in evidence if os.path.exists(p)]
    if not evidence:
        return False
    try:
        return os.path.getmtime(pdf) > max(os.path.getmtime(p) for p in evidence)
    except OSError:
        return False


def _ensure_artifact_manifest(pdf, workdir, translation_context=None):
    """Bind generated artifacts to source bytes and translation semantics.

    Returns a small result dict so daemon/tests can report whether source or
    translation state was invalidated. Missing legacy manifests are bootstrapped
    without wiping progress unless mtime/path evidence proves it stale.
    """
    os.makedirs(workdir, exist_ok=True)
    pdf = os.path.abspath(pdf)
    stat = os.stat(pdf)
    path = _wd(workdir, "artifact-manifest.json")
    old = _load(path, {})
    old_source = old.get("source", {}) if isinstance(old, dict) else {}
    old_translation = old.get("translation") if isinstance(old, dict) else None
    source = {
        "path": pdf,
        "sha256": _sha256_file(pdf),
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
    }
    translation = _normalise_translation_context(workdir, translation_context)
    invalidation = None
    removed = []

    if old_source.get("sha256") and old_source.get("sha256") != source["sha256"]:
        invalidation = "source"
        removed = _remove_generated(workdir, _SOURCE_DIRS, _SOURCE_FILES)
    elif not old_source.get("sha256") and _legacy_source_looks_stale(pdf, workdir):
        invalidation = "source"
        removed = _remove_generated(workdir, _SOURCE_DIRS, _SOURCE_FILES)
    elif translation is not None and old_translation is not None and old_translation != translation:
        invalidation = "translation"
        removed = _remove_generated(workdir, _TRANSLATION_DIRS, _TRANSLATION_FILES)

    manifest = {
        "manifest_version": ARTIFACT_MANIFEST_VERSION,
        "engine_schema_version": ENGINE_SCHEMA_VERSION,
        "source": source,
        # A source-only caller must preserve the context established by daemon.
        "translation": translation if translation is not None else old_translation,
    }
    _write_json_atomic(path, manifest)
    return {"invalidation": invalidation, "removed": removed, "manifest": manifest}


def cmd_prepare(pdf, workdir, context_json="{}"):
    """Daemon pre-run gate: validate source + translator/prompt/glossary cache."""
    try:
        context = json.loads(context_json) if isinstance(context_json, str) else context_json
    except json.JSONDecodeError as exc:
        raise ValueError(f"context JSON không hợp lệ: {exc}") from exc
    result = _ensure_artifact_manifest(pdf, workdir, context)
    print(json.dumps({
        "invalidation": result["invalidation"],
        "removed": result["removed"],
        "source_sha256": result["manifest"]["source"]["sha256"],
    }, ensure_ascii=False))
    return result


def _load_checkpoint(p):
    """Đọc file checkpoint (out/vout/vis). Trả None nếu file hỏng (JSON lỗi —
    di sản của tiến trình bị giết giữa lúc ghi) — caller XOÁ để đơn vị việc đó
    tự vào lại hàng đợi ở lần quét pending sau (self-healing, không sập merge)."""
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return None


def _chunk_gen(workdir):
    """Fingerprint work set dịch hiện tại (nội dung mọi chunks/c_*.json).
    Đổi khi force-rechunk / segmentation đổi — dùng làm generation gate cho
    verify/vision: artifact stage sau gắn gen cũ không được tính done."""
    h = hashlib.md5()
    files = sorted(glob.glob(_wd(workdir, "chunks", "c_*.json")))
    if not files:
        return ""
    for f in files:
        h.update(os.path.basename(f).encode())
        try:
            h.update(open(f, "rb").read())
        except OSError:
            h.update(b"?")
    return h.hexdigest()


def _load_workset(workdir):
    return _load(_wd(workdir, "workset.json"), {})


def _save_workset(workdir, **fields):
    """Ghi/merge workset.json (chunk_gen / vchunk_gen / vision_gen)."""
    ws = _load_workset(workdir)
    ws.update({k: v for k, v in fields.items() if v is not None})
    json.dump(ws, open(_wd(workdir, "workset.json"), "w"), ensure_ascii=False, indent=1)
    return ws


def _max_mtime(paths):
    mt = 0.0
    for p in paths:
        try:
            mt = max(mt, os.path.getmtime(p))
        except OSError:
            pass
    return mt


def _verify_matches_chunks(workdir):
    """True nếu vchunks/vout thuộc cùng generation với chunks hiện tại.
    workset có key vchunk_gen (kể cả rỗng sau force) → chỉ khớp khi == chunk_gen;
    không rơi xuống mtime (mtime cùng giây dễ false-positive)."""
    cg = _chunk_gen(workdir)
    if not cg:
        return False
    ws = _load_workset(workdir)
    if "vchunk_gen" in ws:
        vg = ws.get("vchunk_gen") or ""
        return bool(vg) and vg == cg
    # Legacy (chưa có stamp): vchunks phải tồn tại và không cũ hơn chunks
    vfiles = glob.glob(_wd(workdir, "vchunks", "v_*.json"))
    cfiles = glob.glob(_wd(workdir, "chunks", "c_*.json"))
    if not vfiles or not cfiles:
        return False
    return _max_mtime(vfiles) >= _max_mtime(cfiles)


def _vision_matches_chunks(workdir):
    """True nếu verdict vision gắn đúng generation chunks hiện tại.
    Key vision_gen có mặt (kể cả rỗng) → chỉ khớp khi == chunk_gen."""
    cg = _chunk_gen(workdir)
    if not cg:
        return False
    ws = _load_workset(workdir)
    if "vision_gen" in ws:
        vg = ws.get("vision_gen") or ""
        return bool(vg) and vg == cg
    # Legacy: vis + review_issues không cũ hơn chunks
    if not os.path.exists(_wd(workdir, "review_issues.json")):
        return False
    vfiles = glob.glob(_wd(workdir, "vis", "page_*.json"))
    cfiles = glob.glob(_wd(workdir, "chunks", "c_*.json"))
    if not vfiles or not cfiles:
        return False
    return (_max_mtime(vfiles) >= _max_mtime(cfiles)
            and os.path.getmtime(_wd(workdir, "review_issues.json")) >= _max_mtime(cfiles))


def _invalidate_later_stages(workdir, reason=""):
    """Xoá artifact verify/vision khi work set dịch đổi (force-rechunk).
    text2vi/fixes giữ nguyên — chỉ bỏ checkpoint stage sau (gắn index/gen cũ)."""
    removed = []
    for sub in ("vchunks", "vout"):
        p = _wd(workdir, sub)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
            removed.append(sub)
    # Verdict vision + issues: chấm trên bản/segmentation cũ → không còn hiệu lực
    n_vis = 0
    for f in glob.glob(_wd(workdir, "vis", "page_*.json")):
        try:
            os.remove(f)
            n_vis += 1
        except OSError:
            pass
    if n_vis:
        removed.append(f"vis×{n_vis}")
    for name in ("review_issues.json", "vis_todo.json", "vid2en.json"):
        p = _wd(workdir, name)
        if os.path.exists(p):
            os.remove(p)
            removed.append(name)
    # Xoá stamp stage sau; chunk_gen sẽ ghi lại sau khi tạo chunks mới
    ws = _load_workset(workdir)
    for k in ("vchunk_gen", "vision_gen"):
        ws.pop(k, None)
    json.dump(ws, open(_wd(workdir, "workset.json"), "w"), ensure_ascii=False, indent=1)
    if removed:
        print(f"  (invalidate later stages{': ' + reason if reason else ''}: "
              f"{', '.join(removed)})")
    return removed


def cmd_chunk(pdf, workdir, size=40, force=False, profile=None):
    """Resume-safe: chỉ tạo chunks/ một lần. KHÔNG xoá out/ (giữ tiến độ dịch).
    Đã có chunks/ -> no-op trừ khi force=True.
    force: MERGE out/ cũ vào text2vi trước (giữ tiến độ) rồi xoá cả chunks/ lẫn
    out/ — out cũ đánh index theo chunking CŨ, giữ lại sẽ va index với chunks
    mới (merge-tr dán nhầm bản dịch). Đồng thời INVALIDATE verify+vision
    (vchunks/vout/vis/review_issues) — artifact stage sau gắn gen cũ không được
    hiện như đã xong sau khi dịch bù. Dùng sau khi sửa engine đổi segmentation:
    todo mới = các text CHƯA có trong cache -> chỉ dịch phần mới."""
    os.makedirs(workdir, exist_ok=True)
    # Must run before the resume early-return. Otherwise replacing a PDF at the
    # same path silently reuses chunks/text2vi from the previous document.
    prepared = _ensure_artifact_manifest(pdf, workdir)
    if prepared["invalidation"]:
        print(f"  (artifact invalidation={prepared['invalidation']}: "
              f"{', '.join(prepared['removed']) or '-'})")
    profile = (profile or os.environ.get("CFA_PDF_PROFILE", "native")).strip().lower() or "native"
    doc = None
    preflight_path = _wd(workdir, "preflight.json")
    if not os.path.exists(preflight_path):
        doc = fitz.open(pdf)
        _write_json_atomic(preflight_path, pdf_core.preflight_document(doc))
    preflight = _load(preflight_path, {})
    scan_pages = [
        p.get("page") for p in preflight.get("pages", [])
        if isinstance(p, dict) and p.get("requires_ocr")
    ]
    if profile in ("native", "auto") and scan_pages:
        if doc is not None:
            doc.close()
        raise RuntimeError(
            "scan_detected: trang cần OCR " + ",".join(str(x + 1) for x in scan_pages[:30]) +
            (" …" if len(scan_pages) > 30 else "") +
            "; đặt CFA_PDF_PROFILE=experimental chỉ để kiểm tra, "
            "chưa có OCR reconstruction an toàn trong MVP"
        )
    if profile == "scanned":
        if doc is not None:
            doc.close()
        raise RuntimeError(
            "ocr_not_configured: profile scanned yêu cầu OCR engine có bounding box "
            "(OCRmyPDF/PaddleOCR), chưa được bật mặc định"
        )
    if profile not in ("native", "auto", "experimental"):
        if doc is not None:
            doc.close()
        raise ValueError("profile không hợp lệ: native|auto|experimental|scanned")
    existing = glob.glob(_wd(workdir, "chunks", "c_*.json"))
    if existing and not force:
        print(f"chunk: đã có {len(existing)} chunks, bỏ qua (dùng force để tạo lại).")
        # vẫn đảm bảo workset.chunk_gen khớp (workdir cũ thiếu stamp)
        cg = _chunk_gen(workdir)
        if cg and _load_workset(workdir).get("chunk_gen") != cg:
            _save_workset(workdir, chunk_gen=cg)
        if doc is not None:
            doc.close()
        return len(existing)
    if force and glob.glob(_wd(workdir, "out", "c_*.json")):
        cmd_merge_tr(pdf, workdir)  # gom tiến độ cũ vào text2vi trước khi xoá
        shutil.rmtree(_wd(workdir, "out"), ignore_errors=True)
    if force:
        _invalidate_later_stages(workdir, reason="chunk --force")
    shutil.rmtree(_wd(workdir, "chunks"), ignore_errors=True)
    os.makedirs(_wd(workdir, "chunks"))
    os.makedirs(_wd(workdir, "out"), exist_ok=True)
    doc = doc or fitz.open(pdf)
    segs, layout = pdf_core.extract_segments(doc, "all")
    json.dump({"pdf": os.path.abspath(pdf), "layout": layout}, open(_wd(workdir, "layout.json"), "w"),
              ensure_ascii=False)
    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    seen, todo = set(), []
    for source_order, (s, layout_item) in enumerate(zip(segs, layout)):
        if s["text"] in text2vi or s["text"] in seen:
            continue
        seen.add(s["text"])
        # Keep translation units small, but retain enough reading-order context
        # for the model without allowing it to rewrite neighboring segments.
        prev = segs[source_order - 1]["text"] if source_order else ""
        nxt = segs[source_order + 1]["text"] if source_order + 1 < len(segs) else ""
        todo.append({
            "id": f"t{len(todo)}",
            "text": s["text"],
            "page": layout_item.get("page"),
            "bbox": layout_item.get("box"),
            "source_order": source_order,
            "previous_tail": prev[-240:],
            "next_head": nxt[:240],
        })
    for i in range(0, len(todo), size):
        json.dump(todo[i:i + size], open(_wd(workdir, "chunks", f"c_{i//size:03d}.json"), "w"),
                  ensure_ascii=False)
    nch = (len(todo) + size - 1) // size
    cg = _chunk_gen(workdir)
    # chunk_gen mới; stage sau chưa có gen khớp
    _save_workset(workdir, chunk_gen=cg, vchunk_gen="", vision_gen="")
    print(f"pages={doc.page_count} segs={len(segs)} cached={len(segs)-len(todo)} "
          f"todo={len(todo)} chunks={nch} chunk_gen={cg[:8]}")
    return nch


def _log_marker_drop(workdir, entries):
    """Ghi các bản dịch bị LOẠI vì hỏng marker {vN} vào marker_drop.json (audit).
    Đoạn bị loại giữ nguyên tiếng Anh khi apply — không bao giờ mất công thức."""
    if not entries:
        return
    p = _wd(workdir, "marker_drop.json")
    cur = _load(p, [])
    cur.extend(entries)
    json.dump(cur[-500:], open(p, "w"), ensure_ascii=False, indent=1)


def cmd_merge_tr(pdf, workdir):
    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    n, bad, dropped = 0, 0, []
    for f in glob.glob(_wd(workdir, "out", "c_*.json")):
        d = _load_checkpoint(f)
        if not isinstance(d, dict):
            os.remove(f)            # hỏng -> xoá để pending re-queue chunk này
            bad += 1
            continue
        idx = os.path.basename(f).split("_")[1].split(".")[0]
        cf = _wd(workdir, "chunks", f"c_{idx}.json")
        src_items = _load_checkpoint(cf) if os.path.exists(cf) else None
        if not isinstance(src_items, list):
            continue                # chunk nguồn không khớp (đổi chunking) -> bỏ
        src = {it["id"]: it["text"] for it in src_items}
        for cid, vi in d.items():
            if cid in src and vi:
                # Marker {vN}/<b>/<i>/<sup> phải sống sót qua bản dịch: tự sửa
                # dạng lệch; mất/lệch placeholder -> LOẠI (giữ tiếng Anh) thay
                # vì áp bản mất công thức. Thẻ hỏng chỉ bị strip, không loại.
                fixed = pdf_core.check_markers(src[cid], vi)
                if fixed is None:
                    dropped.append({"chunk": idx, "id": cid,
                                    "en": src[cid][:160], "vi": str(vi)[:160]})
                    continue
                text2vi[src[cid]] = fixed
                n += 1
    if bad:
        print(f"  (xoá {bad} file out hỏng JSON — sẽ dịch lại các chunk đó)")
    if dropped:
        _log_marker_drop(workdir, dropped)
        print(f"  (loại {len(dropped)} bản dịch hỏng marker — xem marker_drop.json)")
    json.dump(text2vi, open(_wd(workdir, "text2vi.json"), "w"), ensure_ascii=False)
    doc = fitz.open(pdf)
    segs, _ = pdf_core.extract_segments(doc, "all")
    miss = sum(1 for s in segs if s["text"] not in text2vi)
    print(f"merged={n} total_text2vi={len(text2vi)} still_missing={miss}")
    return miss


def cmd_vchunk(pdf, workdir, size=25, mode="all", force=False):
    """mode='all': verify MỌI đoạn (bắt cả bỏ sót/sai nghĩa, chính xác hơn vision).
    mode='num': chỉ đoạn có số / nghi chưa dịch.
    Resume-safe: đã có vchunks/ khớp chunk_gen -> no-op trừ khi force.
    Stale (chunk --force / segmentation đổi mà vchunks cũ còn): tự tạo lại
    (không cần --force tay) — tránh status/pipeline coi verify đã xong.
    force: MERGE vout/ cũ (theo vid2en CŨ) vào text2vi trước rồi xoá vchunks/ +
    vout/ — vout cũ đánh vid theo vid2en cũ, giữ lại sẽ dán sửa lỗi nhầm đoạn
    sau khi vid2en bị ghi đè."""
    existing = glob.glob(_wd(workdir, "vchunks", "v_*.json"))
    stale = existing and not _verify_matches_chunks(workdir)
    if existing and not force and not stale:
        print(f"vchunk: đã có {len(existing)} vchunks, bỏ qua (dùng force để tạo lại).")
        return len(existing)
    if stale and not force:
        print(f"vchunk: {len(existing)} vchunks STALE vs chunks — tạo lại.")
    if (force or stale) and glob.glob(_wd(workdir, "vout", "v_*.json")):
        if force:  # chỉ merge khi user chủ động force (stale vout có thể lệch vid)
            cmd_merge_vr(workdir)
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
        p = pdf_core.strip_markers(vi)      # marker {vN}/<b>… là ASCII, bỏ khi đo
        return sum(1 for c in p if ord(c) > 0x100) < max(3, len(p) * 0.02)

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
    cg = _chunk_gen(workdir)
    # vision cũ (nếu còn) không còn khớp verify mới
    _save_workset(workdir, chunk_gen=cg or _load_workset(workdir).get("chunk_gen"),
                  vchunk_gen=cg, vision_gen="")
    print(f"verify_targets={len(uniq)} vchunks={nch} vchunk_gen={(cg or '')[:8]}")
    return nch


def cmd_merge_vr(workdir):
    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    vid2en = _load(_wd(workdir, "vid2en.json"), {})
    n, bad, skipped = 0, 0, 0
    for f in glob.glob(_wd(workdir, "vout", "v_*.json")):
        d = _load_checkpoint(f)
        if not isinstance(d, dict):
            os.remove(f)            # hỏng -> xoá để pending re-queue vchunk này
            bad += 1
            continue
        for vid, corrected in d.items():
            if vid in vid2en and corrected:
                # verify sửa hỏng marker -> GIỮ bản dịch cũ (đừng phá công thức)
                fixed = pdf_core.check_markers(vid2en[vid], corrected)
                if fixed is None:
                    skipped += 1
                    continue
                text2vi[vid2en[vid]] = fixed
                n += 1
    if bad:
        print(f"  (xoá {bad} file vout hỏng JSON — sẽ verify lại các vchunk đó)")
    if skipped:
        print(f"  (bỏ {skipped} bản sửa hỏng marker — giữ bản dịch trước đó)")
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
    prepared = _ensure_artifact_manifest(pdf, workdir)
    if prepared["invalidation"]:
        print(f"  (artifact invalidation={prepared['invalidation']} before apply)")
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
    render_report = {}
    applied, m = pdf_core.apply_translations(
        doc, layout, trans, report=render_report
    )
    # Persist source/translation alongside fit telemetry for the block editor.
    source_by_id = {l["id"]: s["text"] for s, l in zip(segs, layout)}
    translation_by_id = {l["id"]: trans.get(l["id"], "") for l in layout}
    for entry in render_report.get("segments", []):
        sid = entry["id"]
        entry["source"] = source_by_id.get(sid, "")
        entry["translation"] = translation_by_id.get(sid, "")
    _write_json_atomic(_wd(workdir, "render_report.json"), render_report)
    out_dir = os.path.dirname(out) or "."
    os.makedirs(out_dir, exist_ok=True)
    # Never leave a half-written PDF visible to the renderer after cancellation.
    tmp_out = f"{out}.tmp-{os.getpid()}"
    doc.save(tmp_out, garbage=4, deflate=True)
    os.replace(tmp_out, out)
    print(f"applied={applied} missing={miss} fixes={len(fixes)} -> {out}")


def _clear_visual_artifacts(workdir):
    """A changed translation invalidates only visual review, not translation."""
    removed = _remove_generated(
        workdir,
        ("vis", "review"),
        ("review_issues.json", "vis_todo.json", "state.json", "render_report.json"),
    )
    ws = _load_workset(workdir)
    ws.pop("vision_gen", None)
    _write_json_atomic(_wd(workdir, "workset.json"), ws)
    return removed


def cmd_block_update(pdf, workdir, out, segment_id, translation):
    """Persist one user override, re-render atomically, and emit its report."""
    if not segment_id or not isinstance(translation, str) or not translation.strip():
        raise ValueError("segment_id/translation rỗng")
    doc = fitz.open(pdf)
    segs, layout = pdf_core.extract_segments(doc, "all")
    source = None
    for s, item in zip(segs, layout):
        if item.get("id") == segment_id:
            source = s["text"]
            break
    if source is None:
        doc.close()
        raise ValueError("segment không tồn tại trong PDF nguồn hiện tại")
    fixed = pdf_core.check_markers(source, translation)
    if fixed is None:
        doc.close()
        raise ValueError("bản dịch làm mất hoặc sai marker công thức/định dạng")
    fixes = _load(_wd(workdir, "fixes.json"), {})
    fixes[segment_id] = {"en": source, "vi": fixed}
    _write_json_atomic(_wd(workdir, "fixes.json"), fixes)
    doc.close()
    _clear_visual_artifacts(workdir)
    cmd_apply(pdf, workdir, out)
    report = _load(_wd(workdir, "render_report.json"), {})
    selected = next((x for x in report.get("segments", []) if x.get("id") == segment_id), None)
    result = {"id": segment_id, "translation": fixed, "segment": selected}
    print(json.dumps(result, ensure_ascii=False))
    return result


def _count(workdir, sub, pat):
    return len(glob.glob(_wd(workdir, sub, pat)))


def _chunk_indices(workdir, sub, pfx):
    """Chỉ số unit hiện có trong work set (chunks/vchunks) — denominator ổn định
    theo work set, không đếm file out mồ côi sau re-chunk."""
    out = []
    for f in glob.glob(_wd(workdir, sub, f"{pfx}*.json")):
        idx = os.path.basename(f)[len(pfx):-5]
        out.append(idx)
    return sorted(out)


def _is_valid_out(workdir, idx):
    """out/c_IDX.json hợp lệ = dict, khớp chunk hiện tại, đủ id + vi non-empty.
    File rỗng {} / JSON hỏng / thiếu id (agent bị giết giữa chừng) = CHƯA xong."""
    cf = _wd(workdir, "chunks", f"c_{idx}.json")
    of = _wd(workdir, "out", f"c_{idx}.json")
    if not os.path.exists(cf) or not os.path.exists(of):
        return False
    items = _load_checkpoint(cf)
    d = _load_checkpoint(of)
    if not isinstance(items, list) or not isinstance(d, dict):
        return False
    if not items:
        return True  # chunk rỗng (edge) — coi xong
    for it in items:
        cid = it.get("id")
        if not cid:
            continue
        vi = d.get(cid)
        if not vi or not str(vi).strip():
            return False
    return True


def _is_valid_vout(workdir, idx):
    """vout/v_IDX.json hợp lệ = dict JSON (rỗng OK: agent không sửa gì).
    Phải khớp vchunk hiện tại — vout mồ côi sau vchunk --force không tính."""
    cf = _wd(workdir, "vchunks", f"v_{idx}.json")
    of = _wd(workdir, "vout", f"v_{idx}.json")
    if not os.path.exists(cf) or not os.path.exists(of):
        return False
    items = _load_checkpoint(cf)
    d = _load_checkpoint(of)
    return isinstance(items, list) and isinstance(d, dict)


def _is_valid_vis(workdir, page):
    """vis/page_XXX.json hợp lệ = list issue (rỗng = trang sạch, vẫn là đã review)."""
    f = _wd(workdir, "vis", f"page_{int(page):03d}.json")
    if not os.path.exists(f):
        return False
    return isinstance(_load_checkpoint(f), list)


def _count_valid_out(workdir):
    idxs = _chunk_indices(workdir, "chunks", "c_")
    return sum(1 for i in idxs if _is_valid_out(workdir, i)), len(idxs)


def _count_valid_vout(workdir):
    idxs = _chunk_indices(workdir, "vchunks", "v_")
    return sum(1 for i in idxs if _is_valid_vout(workdir, i)), len(idxs)


def _count_valid_vis(workdir, pages):
    """Đếm verdict hợp lệ trong [0, pages). pages=None -> 0/0."""
    if pages is None or pages <= 0:
        return 0, 0
    done = sum(1 for i in range(pages) if _is_valid_vis(workdir, i))
    return done, pages


def _page_count(workdir):
    """Số trang volume: layout.pdf (nếu path resolve được) -> state.json cache
    -> max index pair/vis. Không bịa số."""
    layout = _load(_wd(workdir, "layout.json"), {})
    pdf = layout.get("pdf") or ""
    if pdf and os.path.exists(pdf):
        try:
            return fitz.open(pdf).page_count
        except Exception:
            pass
    cached = _load(_wd(workdir, "state.json"), {})
    if cached.get("vision") and isinstance(cached["vision"], list) and cached["vision"][1]:
        try:
            return int(cached["vision"][1])
        except (TypeError, ValueError):
            pass
    # last resort: highest pair_/page_ index + 1 (stale may overcount — chỉ khi
    # chưa có nguồn khác; stage vision sẽ còn gate has_review)
    hi = -1
    for pat in ("review/pair_*.png", "vis/page_*.json"):
        for f in glob.glob(_wd(workdir, pat)):
            base = os.path.basename(f)
            m = re.search(r"(\d+)", base)
            if m:
                hi = max(hi, int(m.group(1)))
    return hi + 1 if hi >= 0 else None


def _overall_pct(stage, translate, verify, vision):
    """% tổng tuần tự: chỉ cộng dồn stage sau khi stage trước xong.
    done=100; review (vision xong + còn defect) = 95 — không bao giờ 100 khi
    còn việc translate/verify/vision hoặc defect ≥ medium."""
    if stage == "done":
        return 100

    def frac(pair):
        if not pair or not pair[1]:
            return 0.0
        return max(0.0, min(1.0, float(pair[0]) / float(pair[1])))

    # Trọng số: dịch 40 · rà 30 · layout 25 · chừa 5 cho review/khớp done
    if stage == "translate":
        return int(round(40 * frac(translate)))
    if stage == "verify":
        return int(round(40 + 30 * frac(verify)))
    if stage == "vision":
        return int(round(70 + 25 * frac(vision)))
    if stage == "review":
        return 95
    return 0


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
    """Tính tiến độ từng stage (nguồn sự thật = file checkpoint HỢP LỆ).
    - Chỉ đếm out/vout/vis khớp work set hiện tại và parse được đúng kiểu.
    - Generation gate: vout/vis chỉ tính khi khớp chunk_gen (hoặc mtime legacy).
      Sau force-rechunk, dù out được điền lại, vout/vis gen cũ KHÔNG → done.
    - Stage sau không báo 'xong' khi stage trước còn việc.
    - overall_pct tuần tự; 100 chỉ khi stage==done.
    Stage 'review' = vision xong nhưng CÒN defect ≥ medium chưa fix/accept."""
    co, c = _count_valid_out(workdir)
    pages = _page_count(workdir)
    pairs = _count(workdir, "review", "pair_*.png")
    tr_done = (c > 0 and co >= c)
    verify_ok = _verify_matches_chunks(workdir)
    vision_ok = _vision_matches_chunks(workdir)

    # Denominator verify: chỉ khi gen khớp; nếu stale → 0/0 (cần vchunk lại),
    # không dùng số vchunks cũ để giả vờ còn work set verify hiện tại.
    if verify_ok:
        v_total = len(_chunk_indices(workdir, "vchunks", "v_"))
    else:
        v_total = 0

    if not tr_done:
        defects = _defect_pages(workdir, FIX_SEV)
        stage = "translate"
        tr = [co, c]
        vr = [0, v_total]
        vis = [0, pages]
        return {
            "stage": stage, "translate": tr, "verify": vr, "vision": vis,
            "pairs": pairs, "defects": len(defects),
            "overall_pct": _overall_pct(stage, tr, vr, vis),
        }

    if not verify_ok:
        # Có thể còn file vchunks/vout cũ — không đếm; stage=verify (cần vchunk)
        defects = _defect_pages(workdir, FIX_SEV)
        stage = "verify"
        tr = [co, c]
        vr = [0, 0]
        vis = [0, pages]
        return {
            "stage": stage, "translate": tr, "verify": vr, "vision": vis,
            "pairs": pairs, "defects": len(defects),
            "overall_pct": _overall_pct(stage, tr, vr, vis),
        }

    vo, v = _count_valid_vout(workdir)
    vr_done = (v > 0 and vo >= v)
    if not vr_done:
        defects = _defect_pages(workdir, FIX_SEV)
        stage = "verify"
        tr = [co, c]
        vr = [vo, v]
        vis = [0, pages]
        return {
            "stage": stage, "translate": tr, "verify": vr, "vision": vis,
            "pairs": pairs, "defects": len(defects),
            "overall_pct": _overall_pct(stage, tr, vr, vis),
        }

    # Vision: chỉ đếm verdict khi gen khớp; review_issues stale không chốt done
    if vision_ok:
        vis_raw, _ = _count_valid_vis(workdir, pages)
        has_review = os.path.exists(_wd(workdir, "review_issues.json"))
        defects = _defect_pages(workdir, FIX_SEV)
    else:
        vis_raw, has_review = 0, False
        defects = []  # stale review_issues không chặn / không đếm

    n_defects = len(defects)
    if pages is not None and (vis_raw < pages or not has_review):
        stage = "vision"
    elif n_defects:
        stage = "review"
    else:
        stage = "done"

    tr = [co, c]
    vr = [vo, v]
    vis = [vis_raw, pages]
    return {
        "stage": stage,
        "translate": tr,
        "verify": vr,
        "vision": vis,
        "pairs": pairs,
        "defects": n_defects,
        "overall_pct": _overall_pct(stage, tr, vr, vis),
    }


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
    gap, rendered, invalidated, todo = 20, 0, 0, []
    for i in range(src.page_count):
        if only_set is not None and i not in only_set:
            continue
        png = _wd(rev, f"pair_{i:03d}.png")
        vjson = _wd(visd, f"page_{i:03d}.json")
        # only-mode: trang vừa fix -> LUÔN render lại + bỏ verdict cũ.
        stale = (os.path.exists(png) and os.path.getmtime(png) < out_mtime) or only_set is not None
        if not os.path.exists(png) or stale:
            # Pair budget is split between source/output so the combined PNG
            # remains bounded even for maliciously huge PDF page boxes.
            p1, _plan1 = pdf_core.raster_pixmap(
                src[i], dpi, max_pixels=6_000_000
            )
            p2, _plan2 = pdf_core.raster_pixmap(
                vi[i], dpi, max_pixels=6_000_000
            )
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
        # verdict hỏng JSON (tiến trình cũ bị giết giữa lúc ghi) -> xoá để trang
        # được review lại; nếu để nguyên, _status đếm nó là "đã review" nhưng
        # merge-vis bỏ qua -> lỗi của trang biến mất khỏi review_issues.
        if os.path.exists(vjson) and not isinstance(_load_checkpoint(vjson), list):
            os.remove(vjson)
        if not os.path.exists(vjson):
            todo.append({"page": i, "img": png})
    json.dump(todo, open(_wd(workdir, "vis_todo.json"), "w"), ensure_ascii=False)
    print(f"pages={src.page_count} rendered={rendered} invalidated_stale_verdicts={invalidated} review_todo={len(todo)}")
    return todo


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


def _rule_for_detail(detail):
    """Map free-text detail -> (cluster_name, channel)."""
    det = (detail or "").lower()
    for name, pat, channel in DEFECT_RULES:
        if re.search(pat, det):
            return name, channel
    return "khac", "unknown"


def _page_segments_map(pdf, workdir, pages):
    """{page: [{id,en,vi}, ...]} cho các trang trong `pages` (set/list int).
    Ưu tiên report của lần apply gần nhất; nếu report thiếu thì extract từ trang 0
    đến trang lớn nhất để giữ counter ID toàn tài liệu (không dùng ID reset của
    extract riêng trang). vi = fixes override rồi text2vi/report — đúng bản apply."""
    pages = set(int(p) for p in pages)
    if not pages or not pdf or not os.path.exists(pdf):
        return {}

    # Load the stable source/layout metadata before choosing the extraction
    # scope. A current render report already carries the IDs consumed by apply;
    # otherwise a prefix extraction is the only safe way to preserve the global
    # segment counter without scanning the suffix of a large PDF.
    saved_doc = _load(_wd(workdir, "layout.json"), {})
    if not isinstance(saved_doc, dict):
        return {}
    layout_pdf = saved_doc.get("pdf")
    if layout_pdf and os.path.abspath(str(layout_pdf)) != os.path.abspath(pdf):
        return {}
    saved_layout = saved_doc.get("layout", [])
    if not isinstance(saved_layout, list):
        return {}
    render_report = _load(_wd(workdir, "render_report.json"), {})
    report_segments = (
        render_report.get("segments", [])
        if isinstance(render_report, dict) and isinstance(render_report.get("segments"), list)
        else []
    )
    report_by_page = {
        p: [x for x in report_segments if isinstance(x, dict) and x.get("page") == p]
        for p in pages
    }
    report_usable = all(
        bool(items) and all(
            isinstance(x.get("id"), str) and isinstance(x.get("source"), str)
            for x in items
        )
        for items in report_by_page.values()
    )
    global_extract = not report_usable
    max_page = max(pages)
    pages_spec = (
        ",".join(str(p) for p in sorted(pages))
        if report_usable
        else f"0-{max_page}"
    )
    try:
        doc = fitz.open(pdf)
        segs, page_layout = pdf_core.extract_segments(doc, pages_spec)
    except Exception:
        return {}
    finally:
        try:
            doc.close()
        except (NameError, UnboundLocalError):
            pass

    # If extraction was page-only, its IDs restart at s0; remap them to the
    # current apply report. Prefix extraction already has global IDs.
    local_en = {s["id"]: s["text"] for s in segs}

    def same_slot(local, saved):
        a, b = local.get("box"), saved.get("box")
        if not (isinstance(a, (list, tuple)) and isinstance(b, (list, tuple))
                and len(a) == 4 and len(b) == 4):
            return False
        try:
            ax0, ay0, ax1, ay1 = [float(x) for x in a]
            bx0, by0, bx1, by1 = [float(x) for x in b]
            aw, ah = max(0.01, ax1 - ax0), max(0.01, ay1 - ay0)
            bw, bh = max(0.01, bx1 - bx0), max(0.01, by1 - by0)
            ix = max(0.0, min(ax1, bx1) - max(ax0, bx0))
            iy = max(0.0, min(ay1, by1) - max(ay0, by0))
            # Segmentation refinements can change a box ceiling/floor by a few
            # points. Require substantial overlap and nearby centres, while
            # rejecting a shifted/merged block instead of guessing its ID.
            return (
                ix / min(aw, bw) >= 0.90 and
                iy / min(ah, bh) >= 0.65 and
                max(aw, bw) / min(aw, bw) <= 1.35 and
                max(ah, bh) / min(ah, bh) <= 1.60 and
                abs((ax0 + ax1) / 2 - (bx0 + bx1) / 2) <= 3.0 and
                abs((ay0 + ay1) / 2 - (by0 + by1) / 2) <= 20.0
            )
        except (TypeError, ValueError):
            return False

    stable = {}
    for p in pages:
        local_items = [x for x in page_layout if x.get("page") == p]
        if report_usable:
            report_items = report_by_page.get(p, [])
            if len(local_items) != len(report_items):
                continue  # report is authoritative but incomplete: fail closed
            report_pairs = list(zip(local_items, report_items))
            if all(
                same_slot(local, report) and local_en.get(local.get("id")) == report.get("source")
                for local, report in report_pairs
            ):
                stable[p] = [{"id": report["id"], "en": local_en.get(local["id"], "")}
                             for local, report in report_pairs]
                continue
            # Do not fall back to an older ID map when a present report disagrees.
            continue
        saved_items = [x for x in saved_layout if x.get("page") == p]
        if len(local_items) != len(saved_items):
            continue
        pairs = list(zip(local_items, saved_items))
        if not all(same_slot(local, saved) for local, saved in pairs):
            continue
        if not all(isinstance(local.get("id"), str) and isinstance(saved.get("id"), str)
                   for local, saved in pairs):
            continue
        stable[p] = [{
            # Prefix extraction IDs are current/global; page-only IDs are only
            # possible with a usable report (handled above).
            "id": local["id"] if global_extract else saved["id"],
            "en": local_en.get(local["id"], ""),
        } for local, saved in pairs]

    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    fixes = _load(_wd(workdir, "fixes.json"), {})
    report_by_id = {
        x.get("id"): x for x in render_report.get("segments", [])
        if isinstance(x, dict) and isinstance(x.get("id"), str)
    } if isinstance(render_report, dict) and isinstance(render_report.get("segments"), list) else {}
    out = {p: [] for p in pages}
    for p, items in stable.items():
        for item in items:
            en = item["en"]
            cid = item["id"]
            vi = _fix_lookup(fixes, cid, en) or text2vi.get(en, "")
            if not vi:
                report_item = report_by_id.get(cid)
                if (isinstance(report_item, dict)
                        and report_item.get("source") == en
                        and isinstance(report_item.get("translation"), str)):
                    vi = report_item["translation"]
            if en and vi:
                out[p].append({"id": cid, "en": en, "vi": vi})
    return out


def _enrich_issues_light(issues):
    """Gắn cluster/channel từ rule trên detail — KHÔNG mở PDF (UI hot path)."""
    for x in issues:
        if not isinstance(x, dict):
            continue
        name, ch = _rule_for_detail(x.get("detail", ""))
        if not x.get("cluster"):
            x["cluster"] = name
        if not x.get("channel"):
            x["channel"] = ch
    return issues


def _enrich_issues(workdir, issues, pdf=None, with_segments=True):
    """Gắn channel/cluster; optionally segments cho text/mixed (PDF, chỉ trang cần).
    with_segments=False → pure light (dùng cho defect-report UI)."""
    issues = _enrich_issues_light(issues)
    if not with_segments:
        return issues
    if pdf is None:
        pdf = _load(_wd(workdir, "layout.json"), {}).get("pdf")
    text_pages = set()
    for x in issues:
        if not isinstance(x, dict):
            continue
        if x.get("kind", "defect") != "fit" and x.get("channel") in ("text", "mixed"):
            if "page" in x and not x.get("segments"):
                text_pages.add(int(x["page"]))
    if not text_pages:
        return issues
    seg_map = _page_segments_map(pdf, workdir, text_pages)
    for x in issues:
        if not isinstance(x, dict):
            continue
        if x.get("channel") in ("text", "mixed") and "page" in x:
            segs = seg_map.get(int(x["page"])) or []
            if segs:
                x["segments"] = segs
    return issues


def cmd_merge_vis(workdir):
    """Gộp vis/page_XXX.json -> review_issues.json (light cluster/channel).
    Segments PDF gắn khi page-segments/problems rich — không chặn merge-vis.
    Xoá cache cụm khi review_issues đổi."""
    issues = []
    bad = 0
    for f in sorted(glob.glob(_wd(workdir, "vis", "page_*.json"))):
        d = _load_checkpoint(f)
        if not isinstance(d, list):
            bad += 1
            continue
        issues.extend(x for x in d if isinstance(x, dict))
    issues = _enrich_issues(workdir, issues, with_segments=False)
    json.dump(issues, open(_wd(workdir, "review_issues.json"), "w"),
              ensure_ascii=False, indent=1)
    # invalidate cluster cache
    cache = _wd(workdir, "defect_clusters.json")
    if os.path.exists(cache):
        try:
            os.remove(cache)
        except OSError:
            pass
    cg = _chunk_gen(workdir)
    if cg:
        _save_workset(workdir, chunk_gen=cg, vision_gen=cg)
    hi = sum(1 for x in issues if x.get("severity") == "high")
    extra = f" bad_vis={bad}" if bad else ""
    print(f"review_issues={len(issues)} high={hi}{extra} -> {_wd(workdir,'review_issues.json')}")
    return issues


def _load_issues_light(workdir, persist=False):
    """Load review_issues + light cluster/channel (no PDF). UI/status hot path."""
    issues = _load(_wd(workdir, "review_issues.json"), [])
    if not isinstance(issues, list) or not issues:
        return issues if isinstance(issues, list) else []
    need = any(isinstance(x, dict) and (not x.get("cluster") or not x.get("channel"))
               for x in issues)
    if need:
        issues = _enrich_issues_light(issues)
        if persist:
            json.dump(issues, open(_wd(workdir, "review_issues.json"), "w"),
                      ensure_ascii=False, indent=1)
            cache = _wd(workdir, "defect_clusters.json")
            if os.path.exists(cache):
                try:
                    os.remove(cache)
                except OSError:
                    pass
    return issues


def _load_issues_enriched(workdir, persist=False):
    """Load + light enrich; segments PDF chỉ khi thiếu và persist/explicit heavy.
    Hot path callers should use _load_issues_light instead."""
    issues = _load_issues_light(workdir, persist=persist)
    if not issues:
        return issues
    need_seg = any(isinstance(x, dict)
                   and x.get("channel") in ("text", "mixed")
                   and not x.get("segments")
                   and x.get("kind", "defect") != "fit"
                   for x in issues)
    if need_seg and persist:
        issues = _enrich_issues(workdir, issues, with_segments=True)
        json.dump(issues, open(_wd(workdir, "review_issues.json"), "w"),
                  ensure_ascii=False, indent=1)
    return issues


def _classify_from_issues(issues, workdir, min_sev=FIX_SEV):
    """Pure classify from in-memory issues (no I/O except accepted.json)."""
    thr = _SEV.get(min_sev, 1)
    accepted = set(_load(_wd(workdir, "accepted.json"), {}).get("pages", []))
    defects = [x for x in issues
               if isinstance(x, dict)
               and x.get("kind", "defect") != "fit"
               and _SEV.get(x.get("severity", "low"), 1) >= thr
               and x.get("page") not in accepted]
    groups = {}
    for d in defects:
        key = d.get("cluster")
        ch = d.get("channel")
        if not key or not ch:
            key, ch = _rule_for_detail(d.get("detail", ""))
        g = groups.setdefault(key, {"name": key, "channel": ch, "count": 0,
                                    "pages": set(), "sample_details": []})
        g["count"] += 1
        g["pages"].add(d["page"])
        if len(g["sample_details"]) < 3:
            sample = {"page": d["page"], "detail": d.get("detail", "")[:160],
                      "severity": d.get("severity", "low"), "channel": ch}
            if d.get("segments"):
                sample["segment_ids"] = [s.get("id") for s in d["segments"][:8]]
            g["sample_details"].append(sample)
    out = []
    for g in sorted(groups.values(), key=lambda x: -x["count"]):
        g["pages"] = sorted(g["pages"])
        out.append(g)
    return out


def _classify_defects(workdir, min_sev=FIX_SEV):
    """Cluster list — light load only (no PDF)."""
    issues = _load_issues_light(workdir, persist=False)
    return _classify_from_issues(issues, workdir, min_sev)


def cmd_defect_report(workdir, min_sev=FIX_SEV):
    """Báo cáo defect theo CỤM (JSON) — UI hot path, KHÔNG extract PDF.
    Cache defect_clusters.json theo mtime review_issues (+ accepted).
    Light-persist cluster/channel nếu thiếu. Segments: page-segments / problems rich."""
    ri = _wd(workdir, "review_issues.json")
    acc = _wd(workdir, "accepted.json")
    cache = _wd(workdir, "defect_clusters.json")
    if os.path.exists(ri) and os.path.exists(cache):
        try:
            ri_m = os.path.getmtime(ri)
            ca_m = os.path.getmtime(cache)
            acc_m = os.path.getmtime(acc) if os.path.exists(acc) else 0
            if ca_m >= ri_m and ca_m >= acc_m:
                cached = json.load(open(cache, encoding="utf-8"))
                if cached.get("min_sev") == min_sev and "clusters" in cached:
                    print(json.dumps(cached, ensure_ascii=False))
                    return cached["clusters"]
        except Exception:
            pass
    issues = _load_issues_light(workdir, persist=True)
    clusters = _classify_from_issues(issues, workdir, min_sev)
    total_pages = sorted({p for c in clusters for p in c["pages"]})
    payload = {"min_sev": min_sev, "defect_pages": len(total_pages),
               "clusters": clusters}
    try:
        json.dump(payload, open(cache, "w"), ensure_ascii=False)
    except Exception:
        pass
    print(json.dumps(payload, ensure_ascii=False))
    return clusters


def cmd_problems(workdir, min_sev=FIX_SEV, channel=None):
    """In JSON các trang còn LỖI CẦN FIX = kind 'defect', >= mức nghiêm trọng, và
    KHÔNG nằm trong accepted.json (đã đánh dấu won't-fix). Lỗi kind 'fit' (co/nhồi
    chữ cho vừa layout) bị loại -> vòng lặp hội tụ. Rỗng = trang đã ổn.
    channel='text': CHỈ trang có defect kênh text/mixed (rút gọn bản dịch có tác
    dụng) — light path (no PDF).
    channel='rich': object đầy đủ + segments (có thể extract PDF các trang text)."""
    if channel == "rich":
        thr = _SEV.get(min_sev, 1)
        # Heavy once: attach segments for text/mixed so fix agents have en/vi
        issues = _load_issues_enriched(workdir, persist=True)
        accepted = set(_load(_wd(workdir, "accepted.json"), {}).get("pages", []))
        rich = []
        pages = set()
        for x in issues:
            if not isinstance(x, dict):
                continue
            if x.get("kind", "defect") == "fit":
                continue
            if _SEV.get(x.get("severity", "low"), 1) < thr:
                continue
            if x.get("page") in accepted:
                continue
            entry = {
                "page": x["page"],
                "kind": x.get("kind", "defect"),
                "severity": x.get("severity", "low"),
                "detail": x.get("detail", ""),
                "cluster": x.get("cluster") or _rule_for_detail(x.get("detail", ""))[0],
                "channel": x.get("channel") or _rule_for_detail(x.get("detail", ""))[1],
            }
            if x.get("segments"):
                entry["segments"] = x["segments"]
            rich.append(entry)
            pages.add(x["page"])
        payload = {"pages": sorted(pages), "issues": rich}
        print(json.dumps(payload, ensure_ascii=False))
        return payload
    if channel:
        want = {"text", "mixed"} if channel == "text" else {channel}
        # light classify — no PDF (auto-fix loop needs this fast)
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


def cmd_reopen(workdir, pages):
    """Mở lại đúng các trang từng được đánh dấu won't-fix.

    Một báo cáo mới của người dùng phải thắng quyết định accept cũ; nếu không,
    `problems` sẽ âm thầm bỏ qua defect vừa được xác nhận lại. Không đụng accept
    hay ghi chú của trang khác.
    """
    idxs = {int(x) for x in str(pages).split(",")
            if x.strip().lstrip("-").isdigit() and int(x) >= 0}
    path = _wd(workdir, "accepted.json")
    acc = _load(path, {"pages": [], "notes": {}})
    if not isinstance(acc, dict):
        acc = {"pages": [], "notes": {}}
    old_pages = acc.get("pages", []) if isinstance(acc.get("pages"), list) else []
    old_notes = acc.get("notes", {}) if isinstance(acc.get("notes"), dict) else {}
    removed = sorted({int(p) for p in old_pages
                      if isinstance(p, int) and p in idxs})
    acc["pages"] = sorted({int(p) for p in old_pages
                           if isinstance(p, int) and p >= 0 and p not in idxs})
    acc["notes"] = {str(k): v for k, v in old_notes.items()
                    if str(k).lstrip("-").isdigit() and int(k) not in idxs}
    if os.path.exists(path) or removed:
        _write_json_atomic(path, acc)
    cache = _wd(workdir, "defect_clusters.json")
    if os.path.exists(cache):
        os.remove(cache)
    result = {"pages": sorted(idxs), "reopened": removed}
    print(json.dumps(result, ensure_ascii=False))
    return result


def cmd_page_segments(pdf, workdir, pages_csv):
    """Ghi fix/page_XXX.json = {segments:[{id,en,vi}], issues:[...]} cho trang
    cần sửa. `segments` = bản vi hiện hành (fixes→text2vi); `issues` = defect
    text/mixed của trang (cluster/channel/detail) — agent sửa đủ ngữ cảnh.
    In JSON list trang có nội dung."""
    idxs = {int(x) for x in str(pages_csv).split(",") if x.strip().lstrip("-").isdigit()}
    seg_map = _page_segments_map(pdf, workdir, idxs)
    issues_all = _load_issues_enriched(workdir, persist=False)
    by_page_issues = {}
    for x in issues_all:
        if not isinstance(x, dict) or x.get("page") not in idxs:
            continue
        if x.get("kind", "defect") == "fit":
            continue
        ch = x.get("channel") or _rule_for_detail(x.get("detail", ""))[1]
        if ch not in ("text", "mixed", "unknown"):
            continue  # code/policy không thuộc vòng rút gọn text
        by_page_issues.setdefault(x["page"], []).append({
            "kind": x.get("kind", "defect"),
            "severity": x.get("severity", "low"),
            "detail": x.get("detail", ""),
            "cluster": x.get("cluster") or _rule_for_detail(x.get("detail", ""))[0],
            "channel": ch,
        })
    fixd = _wd(workdir, "fix")
    os.makedirs(fixd, exist_ok=True)
    os.makedirs(_wd(workdir, "fixout"), exist_ok=True)
    written = []
    for p in sorted(idxs):
        # Clear both sides before checking extraction. Otherwise an empty or
        # changed page could leave a stale valid-looking checkpoint to merge.
        stale_input = _wd(fixd, f"page_{p:03d}.json")
        stale_out = _wd(workdir, "fixout", f"page_{p:03d}.json")
        for stale in (stale_input, stale_out):
            if os.path.exists(stale):
                os.remove(stale)
        items = seg_map.get(p) or []
        if not items:
            continue
        # Format: list [{id,en,vi}] vẫn là nguồn chính (merge-fix đọc list);
        # kèm file meta page_XXX.meta.json cho issues — tránh phá merge-fix.
        # Đồng thời ghi issues vào key sidecar để agent đọc cùng thư mục.
        payload = list(items)  # backward-compat: merge-fix expects list of {id,en,vi}
        json.dump(payload, open(_wd(fixd, f"page_{p:03d}.json"), "w"),
                  ensure_ascii=False)
        # Tên KHÔNG khớp page_*.json (merge-fix glob) — dùng hậu tố _issues.json
        meta = {"page": p, "issues": by_page_issues.get(p, []),
                "segment_count": len(items)}
        json.dump(meta, open(_wd(fixd, f"page_{p:03d}_issues.json"), "w"),
                  ensure_ascii=False, indent=1)
        written.append(p)
    print(json.dumps(written))
    return written


def cmd_merge_fix(workdir, pages=None):
    """Gộp bản dịch RÚT GỌN từ fixout/page_XXX.json ({id: vi_ngắn}) vào
    fixes.json — override theo SEGMENT ID (KHÔNG đụng text2vi, nên không đổi bản
    dịch của cùng chuỗi EN trên các trang khác). Xoá fix/ + fixout/ sau khi gộp.
    Chỉ ghi khi vi_ngắn KHÁC bản hiện tại để tránh churn không cần thiết.
    `pages` là CSV 0-based tùy chọn để một repair request không merge checkpoint
    còn sót của trang khác."""
    fixes = _load(_wd(workdir, "fixes.json"), {})
    allowed = None
    if pages is not None and str(pages).strip():
        allowed = {int(x) for x in str(pages).split(",")
                   if x.strip().lstrip("-").isdigit() and int(x) >= 0}
    n = 0
    for f in glob.glob(_wd(workdir, "fix", "page_*.json")):
        match = re.search(r"page_(\d+)\.json$", os.path.basename(f))
        if not match:
            continue  # sidecar page_XXX_issues.json, not a fix payload
        if allowed is not None and int(match.group(1)) not in allowed:
            continue
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
                # Bản rút gọn cũng phải giữ marker {vN}/<b>… (rút gọn hay làm
                # rơi placeholder) — hỏng thì bỏ qua, giữ bản dài còn đúng.
                vi = pdf_core.check_markers(it.get("en", ""), vi)
                if vi is None or vi == it.get("vi", ""):
                    continue
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
    return [
        hashlib.md5(
            pdf_core.raster_pixmap(doc[i], dpi, max_pixels=6_000_000)[0].tobytes("png")
        ).hexdigest()
        for i in range(doc.page_count)
    ]


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
    """In JSON list các unit CHƯA có output HỢP LỆ (fan-out đúng phần còn dở).
    Khớp _status: out thiếu id/vi rỗng, vout hỏng JSON, vis không phải list
    đều vào lại hàng đợi. stage=vision -> số trang trong vis_todo (lọc [lo,hi))."""
    if stage == "vision":
        pages = [t["page"] for t in _load(_wd(workdir, "vis_todo.json"), [])]
        if lo is not None:
            lo, hi = int(lo), int(hi)
            pages = [p for p in pages if lo <= p < hi]
        print(json.dumps(pages))
        return pages
    out = []
    if stage == "translate":
        for idx in _chunk_indices(workdir, "chunks", "c_"):
            if _is_valid_out(workdir, idx):
                continue
            op = _wd(workdir, "out", f"c_{idx}.json")
            # hỏng/thiếu id -> xoá để agent ghi đè sạch (tránh merge dở)
            if os.path.exists(op) and not isinstance(_load_checkpoint(op), dict):
                os.remove(op)
            out.append({"idx": idx,
                        "in": os.path.abspath(_wd(workdir, "chunks", f"c_{idx}.json")),
                        "out": os.path.abspath(op)})
    else:
        for idx in _chunk_indices(workdir, "vchunks", "v_"):
            if _is_valid_vout(workdir, idx):
                continue
            op = _wd(workdir, "vout", f"v_{idx}.json")
            if os.path.exists(op) and not isinstance(_load_checkpoint(op), dict):
                os.remove(op)
            out.append({"idx": idx,
                        "in": os.path.abspath(_wd(workdir, "vchunks", f"v_{idx}.json")),
                        "out": os.path.abspath(op)})
    print(json.dumps(out, ensure_ascii=False))
    return out


if __name__ == "__main__":
    cmd = sys.argv[1]
    a = sys.argv[2:]
    force = "--force" in a
    a = [x for x in a if x != "--force"]
    profile = "native"
    for x in list(a):
        if x.startswith("--profile="):
            profile = x.split("=", 1)[1].strip().lower() or "native"
            a.remove(x)
    {
        "prepare": lambda: cmd_prepare(a[0], a[1], a[2] if len(a) > 2 else "{}"),
        "chunk": lambda: cmd_chunk(a[0], a[1], force=force, profile=profile),
        "merge-tr": lambda: cmd_merge_tr(a[0], a[1]),
        "vchunk": lambda: cmd_vchunk(a[0], a[1], force=force),
        "merge-vr": lambda: cmd_merge_vr(a[0]),
        "apply": lambda: cmd_apply(a[0], a[1], a[2]),
        "block-update": lambda: cmd_block_update(a[0], a[1], a[2], a[3], a[4]),
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
        "reopen": lambda: cmd_reopen(a[0], a[1]),
        "page-segments": lambda: cmd_page_segments(a[0], a[1], a[2]),
        "merge-fix": lambda: cmd_merge_fix(a[0], a[1] if len(a) > 1 else None),
        "defect-report": lambda: cmd_defect_report(a[0], a[1] if len(a) > 1 else FIX_SEV),
        "golden-snap": lambda: cmd_golden_snap(a[0], a[1], a[2] if len(a) > 2 else 100),
        "golden-diff": lambda: cmd_golden_diff(a[0], a[1]),
        "accept": lambda: cmd_accept(a[0], a[1], a[2] if len(a) > 2 else ""),
        "review-summary": lambda: cmd_review_summary(a[0]),
    }[cmd]()
