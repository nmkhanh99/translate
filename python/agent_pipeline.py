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
import fcntl
import hashlib
import json
import os
import re
import signal
import shutil
import sys
import time

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


def _assert_artifact_source_current(pdf, workdir):
    """Read-only provenance gate for an edit of an existing rendered baseline.

    Unlike `_ensure_artifact_manifest`, this must never invalidate artifacts:
    a rejected block edit is not authority to delete the last usable report.
    """
    pdf = os.path.abspath(pdf)
    manifest = _load(_wd(workdir, "artifact-manifest.json"), {})
    old_source = manifest.get("source", {}) if isinstance(manifest, dict) else {}
    expected = old_source.get("sha256")
    if not isinstance(expected, str) or not expected:
        raise _partial_render_error("artifact manifest thiếu SHA-256 của PDF nguồn")
    if _sha256_file(pdf) != expected:
        raise _partial_render_error("PDF nguồn đã thay đổi")


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


def cmd_apply(pdf, workdir, out, fixes_override=None, report_out=None):
    """Whole-document apply, serialized with partial-page writers."""
    handle = _acquire_block_update_lock(workdir)
    try:
        _recover_block_update_transaction(workdir, out)
        return _cmd_apply(pdf, workdir, out, fixes_override, report_out)
    finally:
        _release_block_update_lock(workdir, handle)


def _cmd_apply(pdf, workdir, out, fixes_override=None, report_out=None):
    prepared = _ensure_artifact_manifest(pdf, workdir)
    if prepared["invalidation"]:
        print(f"  (artifact invalidation={prepared['invalidation']} before apply)")
    text2vi = _load(_wd(workdir, "text2vi.json"), {})
    # fixes.json = override RÚT GỌN theo SEGMENT ID (ưu tiên cao nhất). Khoá theo
    # id (không phải EN) nên chỉ đổi đúng đoạn trên trang bị lỗi — các trang khác
    # dùng cùng chuỗi EN KHÔNG bị ảnh hưởng (điều kiện để only-vision hợp lệ) — và
    # sống sót qua merge-tr/merge-vr/apply-all vì các bước đó chỉ ghi text2vi.
    fixes = (fixes_override if fixes_override is not None
             else _load(_wd(workdir, "fixes.json"), {}))
    doc = fitz.open(pdf)
    segs, layout = pdf_core.extract_segments(doc, "all")
    trans = {l["id"]: (_fix_lookup(fixes, l["id"], s["text"])
                       or text2vi.get(s["text"], ""))
             for s, l in zip(segs, layout)}
    miss = sum(1 for s, l in zip(segs, layout)
               if not (_fix_lookup(fixes, l["id"], s["text"])
                       or text2vi.get(s["text"])))
    render_report = {}
    layout_generation = hashlib.sha256(
        f"{os.getpid()}-{time.time_ns()}".encode("ascii")
    ).hexdigest()[:24]
    applied, m = pdf_core.apply_translations(
        doc, layout, trans, report=render_report
    )
    render_report["layout_generation"] = layout_generation
    # Persist source/translation alongside fit telemetry for the block editor.
    source_by_id = {l["id"]: s["text"] for s, l in zip(segs, layout)}
    translation_by_id = {l["id"]: trans.get(l["id"], "") for l in layout}
    for entry in render_report.get("segments", []):
        sid = entry["id"]
        entry["source"] = source_by_id.get(sid, "")
        entry["translation"] = translation_by_id.get(sid, "")
    out_dir = os.path.dirname(out) or "."
    os.makedirs(out_dir, exist_ok=True)
    # Never leave a half-written PDF visible to the renderer after cancellation.
    tmp_out = f"{out}.tmp-{os.getpid()}"
    try:
        doc.save(tmp_out, garbage=4, deflate=True)
        render_report["output_identity"] = _pdf_identity(tmp_out)
        render_report["partial_render_state"] = {
            "base_size": render_report["output_identity"]["size"],
            "edits_since_compaction": 0,
        }
        os.replace(tmp_out, out)
    finally:
        doc.close()
        if os.path.exists(tmp_out):
            os.remove(tmp_out)
    # Keep the previous report visible until its matching PDF is safely in place.
    _write_json_atomic(report_out or _wd(workdir, "render_report.json"), render_report)
    # `cmd_apply` re-extracts with the current engine. Keep the persisted global
    # ID/geometry baseline in lock-step with that output; otherwise a later
    # one-page edit could combine a fresh report with stale pre-upgrade layout.
    _write_json_atomic(
        _wd(workdir, "layout.json"),
        {
            "pdf": os.path.abspath(pdf),
            "layout_generation": layout_generation,
            "layout": layout,
        },
    )
    print(f"applied={applied} missing={miss} fixes={len(fixes)} -> {out}")
    return render_report


def _partial_render_error(detail):
    return RuntimeError(
        "partial_render_unavailable: " + detail
        + "; hãy tạo lại tách đoạn (chunk) rồi Apply để có baseline mới"
    )


def _pdf_identity(path):
    """Strong identity coupling report state to one concrete PDF revision."""
    doc = fitz.open(path)
    try:
        kind, trailer_id = doc.xref_get_key(-1, "ID")
        if kind != "array" or not trailer_id:
            raise _partial_render_error("PDF không có trailer ID")
        return {
            "trailer_id": trailer_id,
            "size": os.path.getsize(path),
            "sha256": _sha256_file(path),
        }
    finally:
        doc.close()


def _rects_match(left, right, tolerance=0.05):
    if not isinstance(left, (list, tuple)) or not isinstance(right, (list, tuple)):
        return False
    if len(left) != 4 or len(right) != 4:
        return False
    try:
        return all(abs(float(a) - float(b)) <= tolerance for a, b in zip(left, right))
    except (TypeError, ValueError):
        return False


def _layout_values_match(left, right, tolerance=0.05):
    """Tolerant recursive equality for JSON-like render geometry."""
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return abs(float(left) - float(right)) <= tolerance
    if isinstance(left, (list, tuple)) and isinstance(right, (list, tuple)):
        return len(left) == len(right) and all(
            _layout_values_match(a, b, tolerance) for a, b in zip(left, right)
        )
    if isinstance(left, dict) and isinstance(right, dict):
        return set(left) == set(right) and all(
            _layout_values_match(left[key], right[key], tolerance) for key in left
        )
    return left == right


def _load_partial_page_state(pdf, workdir, out, segment_id):
    """Load the existing full-apply baseline without extracting every page.

    `layout.json` owns the stable global segment IDs and render geometry;
    `render_report.json` owns the exact translations currently visible in
    `out`. Any disagreement is a fail-closed migration case, never a reason to
    silently fall back to a whole-document apply.
    """
    _assert_artifact_source_current(pdf, workdir)

    layout_path = _wd(workdir, "layout.json")
    report_path = _wd(workdir, "render_report.json")
    missing = [path for path in (out, layout_path, report_path) if not os.path.exists(path)]
    if missing:
        raise _partial_render_error(
            "thiếu baseline " + ", ".join(os.path.basename(path) for path in missing)
        )
    try:
        layout_doc = _load(layout_path, {})
        report = _load(report_path, {})
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise _partial_render_error("artifact baseline không đọc được") from exc
    layout = layout_doc.get("layout") if isinstance(layout_doc, dict) else None
    segments = report.get("segments") if isinstance(report, dict) else None
    if not isinstance(layout, list) or not isinstance(segments, list):
        raise _partial_render_error("layout/report không đúng schema")
    missing_ids = report.get("missing_ids")
    if not isinstance(missing_ids, list):
        raise _partial_render_error("report thiếu missing_ids")
    layout_ids = [item.get("id") for item in layout if isinstance(item, dict)]
    report_ids = [entry.get("id") for entry in segments if isinstance(entry, dict)]
    if (any(not isinstance(sid, str) or not sid
            for sid in layout_ids + report_ids + missing_ids)
            or len(layout_ids) != len(layout) or len(set(layout_ids)) != len(layout_ids)
            or None in layout_ids or len(report_ids) != len(segments)
            or len(set(report_ids)) != len(report_ids) or None in report_ids
            or len(set(missing_ids)) != len(missing_ids)):
        raise _partial_render_error("ID trong layout/report bị thiếu hoặc trùng")
    applied_ids, missing_set = set(report_ids), set(missing_ids)
    if (applied_ids & missing_set
            or set(layout_ids) != applied_ids | missing_set
            or report.get("applied") != len(segments)):
        raise _partial_render_error("applied/missing_ids không phủ đúng layout")
    layout_pdf = layout_doc.get("pdf")
    if not isinstance(layout_pdf, str) or os.path.abspath(layout_pdf) != os.path.abspath(pdf):
        raise _partial_render_error("layout không thuộc PDF nguồn hiện tại")
    layout_generation = layout_doc.get("layout_generation")
    report_generation = report.get("layout_generation")
    if (not isinstance(layout_generation, str) or not layout_generation
            or not isinstance(report_generation, str) or not report_generation
            or layout_generation != report_generation):
        raise _partial_render_error("layout/report không cùng generation")
    expected_output = report.get("output_identity")
    current_output_identity = _pdf_identity(out)
    if not isinstance(expected_output, dict) or current_output_identity != expected_output:
        raise _partial_render_error("render report không thuộc output PDF hiện tại")

    selected = [entry for entry in segments if entry.get("id") == segment_id]
    if len(selected) != 1:
        raise _partial_render_error("segment không duy nhất trong render report")
    target = selected[0]
    try:
        page_number = int(target["page"])
    except (KeyError, TypeError, ValueError) as exc:
        raise _partial_render_error("segment không có số trang hợp lệ") from exc
    if page_number < 0:
        raise _partial_render_error("số trang âm")

    page_layout = [item for item in layout if item.get("page") == page_number]
    page_segments = [entry for entry in segments if entry.get("page") == page_number]
    layout_by_id = {item.get("id"): item for item in page_layout if item.get("id")}
    report_by_id = {entry.get("id"): entry for entry in page_segments if entry.get("id")}
    if (not page_layout or not page_segments
            or len(layout_by_id) != len(page_layout)
            or len(report_by_id) != len(page_segments)):
        raise _partial_render_error("segment/layout của trang bị thiếu hoặc trùng ID")
    for sid, entry in report_by_id.items():
        item = layout_by_id.get(sid)
        if item is None or not _rects_match(item.get("box"), entry.get("box")):
            raise _partial_render_error(f"layout của {sid} không khớp report")
        if not isinstance(entry.get("source"), str) or not entry["source"].strip():
            raise _partial_render_error(f"report của {sid} thiếu source")
        if not isinstance(entry.get("translation"), str) or not entry["translation"].strip():
            raise _partial_render_error(f"report của {sid} thiếu translation")

    cap = report.get("document_scale_cap")
    if not isinstance(cap, (int, float)) or isinstance(cap, bool) or not 0 < cap <= 1:
        raise _partial_render_error("document_scale_cap không hợp lệ")
    verified_layout = None
    source_by_id = None
    try:
        source_doc = fitz.open(pdf)
        output_doc = fitz.open(out)
        if (source_doc.page_count != output_doc.page_count
                or source_doc.page_count != report.get("page_count")
                or page_number >= source_doc.page_count):
            raise _partial_render_error("page count của source/output/report không khớp")
        source_rect = source_doc[page_number].rect
        output_rect = output_doc[page_number].rect
        if any(abs(a - b) > 0.05 for a, b in zip(source_rect, output_rect)):
            raise _partial_render_error("kích thước trang source/output không khớp")

        # Re-extract this page only. This independently verifies every
        # render-critical field and source string while preserving global IDs
        # from the full baseline. It catches stale/tampered redact/fx geometry
        # without paying the cost of extracting the rest of the document.
        fresh_segments, fresh_layout = pdf_core.extract_segments(source_doc, str(page_number))
        if (len(fresh_segments) != len(fresh_layout)
                or len(fresh_layout) != len(page_layout)):
            raise _partial_render_error("segmentation của trang không còn khớp baseline")
        verified_layout = []
        source_by_id = {}
        for saved, fresh_segment, fresh_item in zip(
                page_layout, fresh_segments, fresh_layout):
            sid = saved.get("id")
            saved_shape = {key: value for key, value in saved.items()
                           if key not in ("id", "page")}
            fresh_shape = {key: value for key, value in fresh_item.items()
                           if key not in ("id", "page")}
            if not sid or not _layout_values_match(saved_shape, fresh_shape):
                raise _partial_render_error("render geometry của trang không còn khớp baseline")
            source_text = fresh_segment.get("text")
            if not isinstance(source_text, str) or not source_text.strip():
                raise _partial_render_error(f"source của {sid} không hợp lệ")
            old_entry = report_by_id.get(sid)
            if old_entry is not None and old_entry.get("source") != source_text:
                raise _partial_render_error(f"source của {sid} không khớp report")
            markers = re.findall(r"\{v(\d+)\}", source_text)
            formula_count = len(fresh_item.get("fx") or [])
            if markers != [str(index) for index in range(1, formula_count + 1)]:
                raise _partial_render_error(f"marker/formula của {sid} không khớp")
            verified_layout.append(dict(fresh_item, id=sid, page=page_number))
            source_by_id[sid] = source_text
    except RuntimeError:
        raise
    except Exception as exc:
        raise _partial_render_error("PDF source/output không đọc được") from exc
    finally:
        if "source_doc" in locals():
            source_doc.close()
        if "output_doc" in locals():
            output_doc.close()

    return {
        "page": page_number,
        "layout": verified_layout,
        "report": report,
        "page_segments": page_segments,
        "selected": target,
        "source_by_id": source_by_id,
        "output_identity": current_output_identity,
        "scale_cap": float(cap),
    }


def _render_partial_page(pdf, state, translations):
    """Render exactly one clean source page; returned document stays open."""
    source_doc = fitz.open(pdf)
    rendered = fitz.open()
    try:
        pno = state["page"]
        rendered.insert_pdf(
            source_doc,
            from_page=pno,
            to_page=pno,
            # Existing target-page navigation/annotations stay on its stable
            # output page object; this temporary document only supplies content.
            links=False,
            annots=False,
            widgets=False,
        )
    except BaseException:
        rendered.close()
        raise
    finally:
        source_doc.close()

    local_layout = [dict(item, page=0) for item in state["layout"]]
    partial_report = {}
    try:
        pdf_core.apply_translations(
            rendered,
            local_layout,
            translations,
            report=partial_report,
            document_scale_cap=state["scale_cap"],
        )
    except BaseException:
        rendered.close()
        raise
    return rendered, partial_report


def _merge_partial_report(state, partial_report, translations):
    """Replace target-page telemetry while preserving document-level truth."""
    pno = state["page"]
    old_report = state["report"]
    old_page_by_id = {entry["id"]: entry for entry in state["page_segments"]}
    new_page_by_id = {}
    for entry in partial_report.get("segments", []):
        sid = entry.get("id")
        old = old_page_by_id.get(sid)
        if old is None or sid in new_page_by_id:
            raise _partial_render_error("telemetry trang mới không khớp baseline")
        enriched = dict(entry)
        enriched["page"] = pno
        enriched["source"] = old["source"]
        enriched["translation"] = translations[sid]
        new_page_by_id[sid] = enriched
    if set(new_page_by_id) != set(old_page_by_id):
        raise _partial_render_error("số segment đã render trên trang bị thay đổi")

    merged = dict(old_report)
    merged["segments"] = [
        new_page_by_id[entry["id"]] if entry.get("page") == pno else entry
        for entry in old_report["segments"]
    ]
    merged["applied"] = len(merged["segments"])
    merged["review_count"] = sum(
        bool(entry.get("review_required")) for entry in merged["segments"]
    )
    return merged


def _splice_page_contents_incrementally(current_pdf, staged_pdf, rendered_page, pno):
    """Graft one rendered page without replacing its page-tree identity.

    Keeping the target page xref preserves inbound links, outlines, named
    destinations, labels, widgets and annotations. Only `/Contents` and
    `/Resources` change; the temporary appended page merely imports their
    referenced objects into the staged PDF. A normal/full save is deliberately
    not used as a fallback.
    """
    shutil.copy2(current_pdf, staged_pdf)  # never hard-link: saveIncr mutates in place
    doc = fitz.open(staged_pdf)
    original_count = doc.page_count
    original_xrefs = [page.xref for page in doc]
    try:
        if pno < 0 or pno >= original_count or rendered_page.page_count != 1:
            raise _partial_render_error("trang ghép không hợp lệ")
        if any(abs(a - b) > 0.05
               for a, b in zip(doc[pno].rect, rendered_page[0].rect)):
            raise _partial_render_error("kích thước trang ghép không khớp")
        target_xref = doc.page_xref(pno)
        doc.insert_pdf(
            rendered_page,
            from_page=0,
            to_page=0,
            start_at=original_count,
            links=False,
            annots=False,
            widgets=False,
        )
        appended_xref = doc.page_xref(original_count)
        for key in ("Contents", "Resources"):
            kind, value = doc.xref_get_key(appended_xref, key)
            if kind == "null" or not value:
                raise _partial_render_error(f"trang render thiếu /{key}")
            doc.xref_set_key(target_xref, key, value)
        doc.delete_page(original_count)  # delete only the temporary tail page
        if doc.page_count != original_count:
            raise _partial_render_error("page count thay đổi khi ghép")
        if not doc.can_save_incrementally():
            raise _partial_render_error("PDF không hỗ trợ incremental save")
        doc.saveIncr()
    finally:
        doc.close()

    check_doc = fitz.open(staged_pdf)
    try:
        if (check_doc.page_count != original_count
                or [page.xref for page in check_doc] != original_xrefs):
            raise _partial_render_error("PDF ghép lại không giữ nguyên page tree")
    finally:
        check_doc.close()


def _compact_partial_output(staged_pdf):
    """Bound incremental growth without re-rendering or renumbering page objects.

    `garbage=1` removes unreachable graft objects but preserves xrefs. Higher
    garbage levels deliberately are not used because they can renumber pages,
    links and annotations. Failure is non-fatal: the already valid incremental
    staged PDF remains available for this edit.
    """
    compact_pdf = staged_pdf + ".compact.pdf"
    try:
        doc = fitz.open(staged_pdf)
        try:
            original_count = doc.page_count
            original_xrefs = [page.xref for page in doc]
            doc.save(compact_pdf, garbage=1, deflate=False)
        finally:
            doc.close()
        with open(compact_pdf, "rb") as compacted:
            os.fsync(compacted.fileno())
        check = fitz.open(compact_pdf)
        try:
            if (check.page_count != original_count
                    or [page.xref for page in check] != original_xrefs):
                raise RuntimeError("compaction changed PDF page identity")
        finally:
            check.close()
        os.replace(compact_pdf, staged_pdf)
        _fsync_parent(staged_pdf)
        print(f"  (partial PDF maintenance compacted to {os.path.getsize(staged_pdf)} bytes)")
        return True
    except _BlockUpdateInterrupted:
        raise
    except Exception as exc:
        print(f"  (partial PDF maintenance deferred: {exc})", file=sys.stderr)
        return False
    finally:
        _remove_quietly(compact_pdf)


def _maintain_partial_output(state, staged_pdf):
    """Compact occasionally; never turn one block edit into a document render."""
    current_size = state["output_identity"]["size"]
    raw = state["report"].get("partial_render_state")
    if isinstance(raw, dict):
        base_size = raw.get("base_size")
        edits = raw.get("edits_since_compaction")
    else:
        base_size = edits = None
    if (not isinstance(base_size, int) or isinstance(base_size, bool)
            or base_size <= 0 or base_size > current_size
            or not isinstance(edits, int) or isinstance(edits, bool) or edits < 0):
        base_size = current_size
        edits = 0

    edits += 1
    staged_size = os.path.getsize(staged_pdf)
    due = (
        edits >= PARTIAL_COMPACT_EDIT_THRESHOLD
        or staged_size - base_size >= PARTIAL_COMPACT_GROWTH_THRESHOLD
    )
    if due and _compact_partial_output(staged_pdf):
        return {
            "base_size": os.path.getsize(staged_pdf),
            "edits_since_compaction": 0,
        }
    return {"base_size": base_size, "edits_since_compaction": edits}


def _clear_visual_artifacts(workdir, page=None, output=None):
    """Invalidate review data for the changed page, not the whole volume."""
    if page is None:
        removed = _remove_generated(
            workdir,
            ("vis", "review"),
            ("review_issues.json", "vis_todo.json", "state.json"),
        )
        ws = _load_workset(workdir)
        ws.pop("vision_gen", None)
        _write_json_atomic(_wd(workdir, "workset.json"), ws)
        return removed

    page = int(page)
    removed = []
    for path in (
        _wd(workdir, "vis", f"page_{page:03d}.json"),
        _wd(workdir, "review", f"pair_{page:03d}.png"),
        _wd(workdir, "fix", f"page_{page:03d}.json"),
        _wd(workdir, "fix", f"page_{page:03d}_issues.json"),
        _wd(workdir, "fixout", f"page_{page:03d}.json"),
    ):
        if os.path.exists(path):
            os.remove(path)
            removed.append(os.path.relpath(path, workdir))

    issues_path = _wd(workdir, "review_issues.json")
    if os.path.exists(issues_path):
        issues = _load_checkpoint(issues_path)
        if isinstance(issues, list):
            kept = [entry for entry in issues
                    if not isinstance(entry, dict) or entry.get("page") != page]
            if kept != issues:
                _write_json_atomic(issues_path, kept)
                removed.append("review_issues.json[target-page]")
        else:
            os.remove(issues_path)
            removed.append("review_issues.json")

    # Keep state.json: the daemon uses its vision denominator when the source
    # path stored in layout.json is not resolvable from the daemon cwd. Removing
    # it after deleting one pair can make N-1 cached pairs look like an N-1 page
    # completed document. The per-page vis checkpoint below already makes the
    # stage incomplete while preserving the true denominator.
    for name in ("vis_todo.json", "defect_clusters.json"):
        path = _wd(workdir, name)
        if os.path.exists(path):
            os.remove(path)
            removed.append(name)

    # A manual edit reopens this page: an older won't-fix decision must not hide
    # a newly introduced defect when the page is reviewed again.
    accepted_path = _wd(workdir, "accepted.json")
    accepted = _load_checkpoint(accepted_path) if os.path.exists(accepted_path) else None
    if isinstance(accepted, dict):
        old_pages = accepted.get("pages") if isinstance(accepted.get("pages"), list) else []
        old_notes = accepted.get("notes") if isinstance(accepted.get("notes"), dict) else {}
        new_pages = [value for value in old_pages if value != page]
        new_notes = {key: value for key, value in old_notes.items() if str(key) != str(page)}
        if new_pages != old_pages or new_notes != old_notes:
            accepted = dict(accepted)
            accepted["pages"] = new_pages
            accepted["notes"] = new_notes
            _write_json_atomic(accepted_path, accepted)
            removed.append("accepted.json[target-page]")

    # `vis-pages` uses output mtime as a stale gate. The other pages are proven
    # unchanged by the content-only splice, so advance only their cached pair
    # mtimes; otherwise one block edit would queue the whole document again.
    if output and os.path.exists(output):
        stamp = os.path.getmtime(output)
        target_name = f"pair_{page:03d}.png"
        for path in glob.glob(_wd(workdir, "review", "pair_*.png")):
            if os.path.basename(path) != target_name:
                os.utime(path, (stamp, stamp))
    return removed


BLOCK_UPDATE_LOCK_FILE = "block-update.lock.json"
BLOCK_UPDATE_TXN_FILE = "block-update.txn.json"
PARTIAL_COMPACT_EDIT_THRESHOLD = 32
PARTIAL_COMPACT_GROWTH_THRESHOLD = 64 * 1024 * 1024


class _BlockUpdateInterrupted(RuntimeError):
    """SIGTERM that must pass through broad OSError/maintenance fallbacks."""


def _block_transaction_paths(workdir, out, token):
    report = _wd(workdir, "render_report.json")
    fixes = _wd(workdir, "fixes.json")
    return {
        "out": out,
        "report": report,
        "fixes": fixes,
        "staged_out": out + token,
        "staged_report": report + token,
        "staged_fixes": fixes + token,
        "backup_out": out + token + ".bak",
        "backup_report": report + token + ".bak",
        "backup_fixes": fixes + token + ".bak",
    }


def _fsync_parent(path):
    """Persist directory-entry changes where the platform supports it."""
    fd = None
    try:
        fd = os.open(os.path.dirname(os.path.abspath(path)) or ".", os.O_RDONLY)
        os.fsync(fd)
    except OSError:
        pass
    finally:
        if fd is not None:
            os.close(fd)


def _durable_copy(source, destination):
    shutil.copy2(source, destination)
    with open(destination, "rb") as copied:
        os.fsync(copied.fileno())
    _fsync_parent(destination)


def _remove_quietly(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _recover_block_update_transaction(workdir, out):
    """Rollback an interrupted multi-file commit before exposing its state."""
    journal_path = _wd(workdir, BLOCK_UPDATE_TXN_FILE)
    if not os.path.exists(journal_path):
        # A crash after removing the journal but before deleting backups leaves
        # only harmless private files. Clean them while the writer flock is held.
        for pattern in (
            out + ".block-*",
            _wd(workdir, "render_report.json.block-*"),
            _wd(workdir, "fixes.json.block-*"),
        ):
            for path in glob.glob(pattern):
                _remove_quietly(path)
        return False
    journal = _load_checkpoint(journal_path)
    if not isinstance(journal, dict) or journal.get("version") != 1:
        raise RuntimeError("block-update transaction journal không hợp lệ")
    token = journal.get("token")
    if not isinstance(token, str) or not re.fullmatch(r"\.block-\d+-\d+", token):
        raise RuntimeError("block-update transaction token không hợp lệ")
    if os.path.abspath(str(journal.get("out") or "")) != os.path.abspath(out):
        raise RuntimeError("block-update transaction không thuộc output hiện tại")
    paths = _block_transaction_paths(workdir, out, token)
    had = journal.get("had")
    if not isinstance(had, dict):
        raise RuntimeError("block-update transaction thiếu trạng thái cũ")

    def restore(name, identity=None, sha256=None):
        live = paths[name]
        backup = paths["backup_" + name]
        existed = had.get(name)
        if not isinstance(existed, bool):
            raise RuntimeError("block-update transaction had flag không hợp lệ")
        if not existed:
            _remove_quietly(live)
            return
        if os.path.exists(backup):
            os.replace(backup, live)
            return
        # Recovery itself may have died after restoring this one file. Accept
        # the live artifact only when it proves to be the recorded old version.
        if not os.path.exists(live):
            raise RuntimeError(f"không thể recover {name}: thiếu backup")
        if identity is not None and _pdf_identity(live) == identity:
            return
        if sha256 is not None and _sha256_file(live) == sha256:
            return
        raise RuntimeError(f"không thể recover {name}: live không khớp baseline")

    restore("out", identity=journal.get("old_output_identity"))
    restore("report", sha256=journal.get("old_report_sha256"))
    restore("fixes", sha256=journal.get("old_fixes_sha256"))
    for key in ("staged_out", "staged_report", "staged_fixes",
                "backup_out", "backup_report", "backup_fixes"):
        _remove_quietly(paths[key])
    # Make every restored rename durable before deleting the recovery record.
    # `out` normally lives outside workdir, so flushing only the journal parent
    # could otherwise expose a mixed PDF/report state after a power loss.
    _fsync_parent(out)
    _fsync_parent(paths["report"])
    _remove_quietly(journal_path)
    _fsync_parent(journal_path)
    print("  (recovered interrupted block-update transaction)")
    return True


def _process_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _acquire_block_update_lock(workdir):
    """Cross-process writer lock backed by a live advisory file lock.

    The JSON PID remains useful to the daemon UI, while `flock` is the actual
    concurrency primitive. A dead process releases the kernel lock even if its
    path survives, avoiding stale-lock unlink races.
    """
    os.makedirs(workdir, exist_ok=True)
    path = _wd(workdir, BLOCK_UPDATE_LOCK_FILE)
    token = f"{os.getpid()}-{time.time_ns()}"
    payload = json.dumps({
        "pid": os.getpid(),
        "token": token,
        "started_at": time.time(),
    }).encode("utf-8")
    for _attempt in range(4):
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("đang có một lần ghi PDF khác") from exc
            # A previous owner may have unlinked this inode while we waited.
            # Never claim an unlinked lock: retry against the current path.
            try:
                live = os.stat(path)
            except FileNotFoundError:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)
                continue
            held = os.fstat(fd)
            if (live.st_dev, live.st_ino) != (held.st_dev, held.st_ino):
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)
                continue
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, payload)
            os.fsync(fd)
            return {"token": token, "fd": fd, "path": path}
        except BaseException:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(fd)
            raise
    raise RuntimeError("không lấy được khóa lưu block")


def _release_block_update_lock(workdir, handle):
    if not isinstance(handle, dict):
        return
    path = handle.get("path") or _wd(workdir, BLOCK_UPDATE_LOCK_FILE)
    token = handle.get("token")
    fd = handle.get("fd")
    try:
        if not isinstance(fd, int):
            return
        try:
            held = os.fstat(fd)
            live = os.stat(path)
            os.lseek(fd, 0, os.SEEK_SET)
            current = json.loads(os.read(fd, 4096).decode("utf-8"))
            if ((live.st_dev, live.st_ino) == (held.st_dev, held.st_ino)
                    and current.get("token") == token):
                os.remove(path)
        except (FileNotFoundError, json.JSONDecodeError, OSError, UnicodeDecodeError):
            pass
    finally:
        if isinstance(fd, int):
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


def cmd_block_update(pdf, workdir, out, segment_id, translation):
    handle = _acquire_block_update_lock(workdir)
    try:
        _recover_block_update_transaction(workdir, out)
        return _cmd_block_update(pdf, workdir, out, segment_id, translation)
    finally:
        _release_block_update_lock(workdir, handle)


def cmd_recover_block_update(workdir, out):
    """Daemon/startup hook for recovery after SIGKILL or power loss."""
    handle = _acquire_block_update_lock(workdir)
    try:
        recovered = _recover_block_update_transaction(workdir, out)
    finally:
        _release_block_update_lock(workdir, handle)
    result = {"recovered": bool(recovered)}
    print(json.dumps(result))
    return result


def _cmd_block_update(pdf, workdir, out, segment_id, translation):
    """Persist one override and atomically re-render only its containing page."""
    if not segment_id or not isinstance(translation, str) or not translation.strip():
        raise ValueError("segment_id/translation rỗng")
    state = _load_partial_page_state(pdf, workdir, out, segment_id)
    source = state["source_by_id"][segment_id]
    fixed = pdf_core.check_markers(source, translation)
    if fixed is None:
        raise ValueError("bản dịch làm mất hoặc sai marker công thức/định dạng")
    fixes_path = _wd(workdir, "fixes.json")
    report_path = _wd(workdir, "render_report.json")
    fixes = _load(fixes_path, {})
    if not isinstance(fixes, dict):
        raise ValueError("fixes.json không hợp lệ")
    fixes[segment_id] = {"en": source, "vi": fixed}
    translations = {
        entry["id"]: (fixed if entry["id"] == segment_id else entry["translation"])
        for entry in state["page_segments"]
    }

    # Build every replacement off to the side. The PDF is committed last, so a
    # render timeout cannot expose a new PDF without its matching report/fixes.
    token = f".block-{os.getpid()}-{time.time_ns()}"
    tx_paths = _block_transaction_paths(workdir, out, token)
    staged_out = tx_paths["staged_out"]
    staged_report = tx_paths["staged_report"]
    staged_fixes = tx_paths["staged_fixes"]
    backup_report = tx_paths["backup_report"]
    backup_fixes = tx_paths["backup_fixes"]
    backup_out = tx_paths["backup_out"]
    staged_paths = (staged_out, staged_report, staged_fixes)
    backup_paths = (backup_out, backup_report, backup_fixes)
    journal_path = _wd(workdir, BLOCK_UPDATE_TXN_FILE)
    for path in staged_paths + backup_paths:
        if os.path.exists(path):
            os.remove(path)

    report = None
    had_out = os.path.exists(out)
    had_report = os.path.exists(report_path)
    had_fixes = os.path.exists(fixes_path)
    previous_sigterm = None
    sigterm_handler_installed = False
    journal_written = False

    def interrupt_block_update(_signum, _frame):
        # execFile timeout uses SIGTERM. Convert it into a Python exception so
        # the transaction below can restore every live artifact before exit.
        raise _BlockUpdateInterrupted("block update interrupted")

    try:
        previous_sigterm = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGTERM, interrupt_block_update)
        sigterm_handler_installed = True
    except (AttributeError, ValueError):
        # SIGTERM is available on the macOS product path. A non-main-thread
        # library caller cannot install handlers, but still gets OSError rollback.
        pass

    try:
        rendered_page, partial_report = _render_partial_page(pdf, state, translations)
        try:
            report = _merge_partial_report(state, partial_report, translations)
            _splice_page_contents_incrementally(
                out, staged_out, rendered_page, state["page"]
            )
            report["partial_render_state"] = _maintain_partial_output(state, staged_out)
            # saveIncr closes the PDF correctly, but a directory fsync after the
            # later rename cannot make unwritten file data durable. Flush this
            # exact staged revision before its identity enters the journal/report.
            with open(staged_out, "rb") as staged_pdf:
                os.fsync(staged_pdf.fileno())
            staged_identity = _pdf_identity(staged_out)
            report["output_identity"] = staged_identity
        finally:
            rendered_page.close()
        _write_json_atomic(staged_report, report)
        _write_json_atomic(staged_fixes, fixes)

        # Prepare durable old versions, then publish a write-ahead journal before
        # the first live rename. A dead process is rolled back by the next writer
        # (and by the daemon recovery hook) instead of leaking a partial commit.
        if had_report:
            _durable_copy(report_path, backup_report)
        if had_fixes:
            _durable_copy(fixes_path, backup_fixes)
        if had_out:
            try:
                os.link(out, backup_out)
                _fsync_parent(backup_out)
            except OSError:
                _durable_copy(out, backup_out)
        journal = {
            "version": 1,
            "token": token,
            "out": os.path.abspath(out),
            "had": {"out": had_out, "report": had_report, "fixes": had_fixes},
            "old_output_identity": state["output_identity"] if had_out else None,
            "old_report_sha256": _sha256_file(report_path) if had_report else None,
            "old_fixes_sha256": _sha256_file(fixes_path) if had_fixes else None,
        }
        _write_json_atomic(journal_path, journal)
        _fsync_parent(journal_path)
        journal_written = True
        try:
            os.replace(staged_fixes, fixes_path)
            os.replace(staged_report, report_path)
            os.replace(staged_out, out)
            _fsync_parent(out)
            _fsync_parent(report_path)
            _clear_visual_artifacts(workdir, page=state["page"], output=out)
            os.remove(journal_path)  # commit point: recovery now keeps new state
            _fsync_parent(journal_path)
            journal_written = False
        except BaseException:
            _recover_block_update_transaction(workdir, out)
            journal_written = False
            raise
    finally:
        # If recovery itself failed, retain journal/backups for a later retry.
        if not journal_written and not os.path.exists(journal_path):
            for path in staged_paths + backup_paths:
                _remove_quietly(path)
        if sigterm_handler_installed:
            signal.signal(signal.SIGTERM, previous_sigterm)

    report = report or {}
    selected = next((x for x in report.get("segments", []) if x.get("id") == segment_id), None)
    result = {"id": segment_id, "translation": fixed, "segment": selected}
    print(
        f"partial-render page={state['page']} blocks={len(state['page_segments'])} "
        f"of document_pages={report.get('page_count')}"
    )
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
        "recover-block-update": lambda: cmd_recover_block_update(a[0], a[1]),
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
