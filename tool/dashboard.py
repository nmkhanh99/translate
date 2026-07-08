#!/usr/bin/env python3
"""
dashboard.py — Màn hình quản lý dịch CFA (web, chỉ dùng thư viện chuẩn).
================================================================================
Một trang web local để:
  • XEM tiến độ mọi volume trong volumes.json (translate / verify / vision),
    nguồn sự thật = filesystem (tái dùng agent_pipeline._status).
  • CHẠY / DỪNG pipeline AGENT cho từng volume hoặc cả batch, chọn ENGINE:
      - claude: spawn `claude -p` chạy Workflow translate_volume.js (4-phase).
      - codex:  spawn `codex exec` dùng MCP cfa-pdf-translator dịch cả volume
                theo lô trang nối chuỗi (đọc codex_work.pdf, ghi OUT).
    Checkpoint theo file nên DỪNG rồi CHẠY lại là tự resume (cả 2 engine).
  • Mở PDF đích, xem log chạy trực tiếp.

Không cần Flask — dùng http.server của stdlib. Chạy:
    python3 dashboard.py            # mở http://127.0.0.1:8756
    python3 dashboard.py --port 9000

QUYỀN (posture) khi spawn `claude`:
  • "allowlist" (MẶC ĐỊNH, ít quyền nhất): --permission-mode default và chỉ cấp
    đúng các tool pipeline cần (Bash cd/python3, Write, Read, Agent, Workflow...).
    Không tắt cơ chế hỏi quyền; tool ngoài danh sách bị từ chối.
  • "bypass" (TỰ CHỌN): --permission-mode bypassPermissions — bỏ MỌI cửa hỏi
    quyền cho agent con. Tiện nhưng rủi ro hơn; chỉ bật nếu bạn hiểu và chấp nhận.
"""
import argparse
import json
import os
import re
import signal
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import fitz  # PyMuPDF: render trang PDF cho màn đọc song song
import agent_pipeline as ap  # tái dùng _status/_load (glue xác định)

TOOL = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(TOOL, "volumes.json")
VOLUME_JS = os.path.join(TOOL, "translate_volume.js")
TRANSLATE_ROOT = os.path.dirname(TOOL)          # .../translate (chứa PDF nguồn + đích)
CFG_PATH = os.path.join(TOOL, "dashboard.json")

# Thư mục cho tài liệu tự thêm: thả PDF vào input/ -> tự thành mục dịch,
# bản dịch xuất ra output/<tên>_vi.pdf, workdir ở tool/work/user_<tên>/.
INPUT_DIR = os.path.join(TRANSLATE_ROOT, "input")
OUTPUT_DIR = os.path.join(TRANSLATE_ROOT, "output")
USER_WORK = os.path.join(TOOL, "work")
for _d in (INPUT_DIR, OUTPUT_DIR):
    os.makedirs(_d, exist_ok=True)

# UI tĩnh: ưu tiên bản Next.js đã build (tool/web/out); nếu chưa build thì lùi
# về bộ HTML tĩnh cũ (tool/ui) để dev vẫn chạy được.
WEB_OUT = os.path.join(TOOL, "web", "out")
UI_DIR = WEB_OUT if os.path.isdir(WEB_OUT) else os.path.join(TOOL, "ui")
CTYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
          ".json": "application/json", ".txt": "text/plain; charset=utf-8",
          ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
          ".map": "application/json", ".webp": "image/webp",
          ".woff2": "font/woff2", ".woff": "font/woff"}

# Least-privilege: đúng các tool mà translate_volume.js + agent con của nó dùng.
ALLOWED_TOOLS = ["Bash(cd *)", "Bash(python3 *)", "Write", "Edit", "Read",
                 "Agent", "Task", "Workflow", "Glob", "Grep"]

DEFAULT_CFG = {
    "engine": "claude",      # claude (Workflow 4-phase) | codex (MCP đơn giản)
    "model": "sonnet",       # sonnet | opus | haiku (opus = chất lượng cao nhất)
    "posture": "allowlist",  # allowlist (an toàn) | bypass (bỏ hỏi quyền)
    "vision": True,          # có chạy stage review layout bằng vision không
    "codex_batch": 25,       # số trang mỗi lô khi Codex dịch (chuỗi theo lô)
    "budget": 100,           # ngân sách tháng (USD) — hiển thị ở sidebar/settings
    "budget_warn": 90,       # cảnh báo khi dùng tới (% ngân sách)
}
ENGINES = ["claude", "codex", "grok"]
MODELS = ["sonnet", "opus", "haiku"]
POSTURES = ["allowlist", "bypass"]

LOCK = threading.Lock()
# tag -> {"proc": Popen|None, "sid", "log", "started", "mode", "model"}
RUNS = {}
BATCH = {"active": False, "stop": False, "current": None, "queue": []}


# ----------------------------- config ---------------------------------------
def load_cfg():
    cfg = dict(DEFAULT_CFG)
    if os.path.exists(CFG_PATH):
        try:
            cfg.update(json.load(open(CFG_PATH, encoding="utf-8")))
        except Exception:
            pass
    return cfg


def save_cfg(cfg):
    json.dump(cfg, open(CFG_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


CFG = load_cfg()


def _effective_stage(raw_stage):
    """Khi tắt Vision, pipeline dừng ở stage 'vision' (không sinh file vis) nhưng
    translate+verify+apply đã xong -> coi như 'done' để done/batch hội tụ."""
    if raw_stage == "vision" and not CFG.get("vision", True):
        return "done"
    return raw_stage


# ----------------------------- volumes --------------------------------------
def pretty_name(pdf_path):
    base = os.path.splitext(os.path.basename(pdf_path))[0]
    return base.replace("2024 CFA level I ", "").replace("2024 ", "")


def _discover_user_volumes():
    """Quét input/*.pdf -> mỗi PDF thành 1 volume tự thêm (user=True)."""
    out = []
    if not os.path.isdir(INPUT_DIR):
        return out
    for fn in sorted(os.listdir(INPUT_DIR)):
        if not fn.lower().endswith(".pdf"):
            continue
        name = os.path.splitext(fn)[0]
        slug = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").lower()[:40] or "doc"
        out.append({
            "pdf": os.path.join(INPUT_DIR, fn),
            "workdir": os.path.join(USER_WORK, "user_" + slug),
            "out": os.path.join(OUTPUT_DIR, name + "_vi.pdf"),
            "user": True,
        })
    return out


def load_volumes():
    vols = json.load(open(MANIFEST, encoding="utf-8"))
    vols += _discover_user_volumes()  # + tài liệu tự thêm trong input/
    for v in vols:
        v["tag"] = os.path.basename(v["workdir"].rstrip("/"))
        v["display"] = pretty_name(v["pdf"])
    return vols


def find_volume(tag):
    for v in load_volumes():
        if v["tag"] == tag:
            return v
    return None


def codex_state(vol):
    """Đọc <workdir>/codex_state.json do luồng Codex ghi (done_through, last).
    Trả None nếu chưa có / hỏng."""
    p = os.path.join(vol["workdir"], "codex_state.json")
    if not os.path.exists(p):
        return None
    try:
        d = json.load(open(p, encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def codex_done(vol):
    """Codex coi là xong khi OUT tồn tại và đã dịch tới trang cuối."""
    s = codex_state(vol)
    if not s or not os.path.exists(vol["out"]):
        return False
    last = s.get("last")
    return isinstance(last, int) and s.get("done_through", -1) >= last >= 0


# ----------------------------- run state ------------------------------------
def run_meta_path(workdir):
    return os.path.join(workdir, "run.json")


def load_run_meta(workdir):
    p = run_meta_path(workdir)
    if os.path.exists(p):
        try:
            return json.load(open(p, encoding="utf-8"))
        except Exception:
            return None
    return None


def save_run_meta(workdir, meta):
    os.makedirs(workdir, exist_ok=True)
    json.dump(meta, open(run_meta_path(workdir), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)


def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def is_running(vol):
    """Đang chạy nếu tiến trình trong RUNS còn sống, hoặc pid trong run.json còn
    sống (bền qua việc khởi động lại dashboard)."""
    r = RUNS.get(vol["tag"])
    if r and r.get("proc") is not None:
        return r["proc"].poll() is None
    meta = load_run_meta(vol["workdir"])
    return bool(meta and meta.get("mode") == "running" and pid_alive(meta.get("pid")))


# ----------------------------- launch / stop --------------------------------
# Hai ENGINE dịch, cùng checkpoint-theo-file nên DỪNG rồi CHẠY lại là resume:
#   • claude: Workflow 4-phase (translate → verify → apply → vision) — chất lượng
#     cao nhất. Đây là script translate_volume.js chạy trong Claude Code.
#   • codex:  luồng MCP đơn giản — `codex exec` dùng MCP cfa-pdf-translator dịch
#     cả volume theo LÔ TRANG nối chuỗi (lô đầu đọc source→ghi OUT; lô sau đọc OUT
#     đã dịch→ghi đè OUT). Không có verify/vision; nhanh & gọn.
def build_prompt(vol, vision):
    run_args = {"pdf": vol["pdf"], "workdir": vol["workdir"], "out": vol["out"],
                "vision": bool(vision), "tool": TOOL}
    return (
        "Bạn đang chạy pipeline dịch 1 volume CFA sang tiếng Việt (giữ layout). "
        f"Dùng công cụ Workflow với scriptPath \"{VOLUME_JS}\" và args (JSON) sau:\n"
        f"{json.dumps(run_args, ensure_ascii=False)}\n\n"
        "CHỜ workflow chạy XONG hoàn toàn rồi báo lại đúng status JSON cuối cùng "
        "của nó. KHÔNG kết thúc lượt cho tới khi workflow hoàn tất. Không hỏi lại."
    )


def _parse_pages(pages):
    """'40-80' -> (40, 80) (0-based, đã kẹp a<=b). 'all'/rỗng/không hợp lệ -> None."""
    if not pages or str(pages).strip().lower() == "all":
        return None
    s = str(pages).strip()
    if "-" not in s:
        return None
    lo, _, hi = s.partition("-")
    if not (lo.strip().isdigit() and hi.strip().isdigit()):
        return None
    a, b = int(lo), int(hi)
    return (min(a, b), max(a, b))


def build_prompt_codex(vol, batch, pages="all"):
    """Prompt cho `codex exec`: dịch volume (hoặc KHOẢNG TRANG) qua MCP theo lô
    trang, resume được.

    pages: "all" = cả volume; hoặc "a-b" (0-based) = chỉ dịch trang a..b.

    Cơ chế: apply_translations MỞ LẠI đúng PDF đã extract rồi lưu ra OUT. Nên lô
    đầu extract từ SOURCE và apply ra OUT; các lô sau extract TỪ OUT (đã có lô
    trước) và apply đè lại OUT → tích luỹ đúng, không mất bản dịch cũ."""
    src, out, wd = vol["pdf"], vol["out"], vol["workdir"]
    rng = _parse_pages(pages)  # (a,b) hoặc None
    # Partial dùng file state/work RIÊNG để không lệch trạng thái "done" cả volume.
    tag = f"_{rng[0]}_{rng[1]}" if rng else ""
    state = os.path.join(wd, f"codex_state{tag}.json")
    work = os.path.join(wd, f"codex_work{tag}.pdf")
    if rng:
        a, b = rng
        scope = (f"CHỈ dịch KHOẢNG TRANG {a}..{b} (0-based). first_page = {a}; "
                 f"last = {b}.\n")
        last_line = f"1) last = {b}; first_page = {a}.\n"
        init_line = ("2) Đọc STATE (shell `cat`) lấy done_through; nếu chưa có "
                     f"STATE/WORK thì done_through = first_page-1 = {a - 1}.\n")
    else:
        scope = "Dịch CẢ volume.\n"
        last_line = ("1) list_pdf_info(SOURCE) để lấy page_count "
                     "(last = page_count-1; first_page = 0).\n")
        init_line = ("2) Đọc STATE (shell `cat` nếu có) lấy done_through (0-based, "
                     "trang cuối đã dịch); nếu chưa có STATE hoặc chưa có WORK thì "
                     "done_through = -1.\n")
    return (
        "Bạn là trình dịch PDF CFA sang TIẾNG VIỆT, GIỮ NGUYÊN layout, qua MCP "
        "server `cfa-pdf-translator` (các tool: list_pdf_info, extract_segments, "
        "apply_translations). Làm việc TỰ ĐỘNG tới khi xong, KHÔNG hỏi lại.\n\n"
        f"SOURCE = {src}\nOUT = {out}\nWORK = {work}\nSTATE = {state}\n"
        f"BATCH = {int(batch)} trang mỗi lô. {scope}\n"
        "LƯU Ý apply_translations MỞ LẠI đúng PDF đã extract rồi lưu ra file đích. "
        "TUYỆT ĐỐI không để file nguồn và file đích TRÙNG đường dẫn (PyMuPDF sẽ "
        "lỗi). Vì vậy luôn đọc từ WORK và ghi ra OUT, rồi copy OUT->WORK.\n\n"
        "QUY TRÌNH:\n"
        + last_line
        + init_line
        + "3) LẶP tới khi done_through == last:\n"
        "   - start = done_through+1; end = min(start+BATCH-1, last); "
        "pages = f\"{start}-{end}\".\n"
        "   - input_pdf = WORK nếu file WORK đã tồn tại, ngược lại = SOURCE.\n"
        "   - extract_segments(input_pdf, pages). Dịch text từng segment sang "
        "tiếng Việt tự nhiên, GIỮ NGUYÊN số/ký hiệu/công thức và thuật ngữ (ETF, "
        "CAPM...). Với thuật ngữ chuyên ngành dùng dạng 'tiếng Việt (English term)' "
        "khi hữu ích.\n"
        "   - apply_translations(session_id, {id: bản_dịch}, OUT)  # đọc input_pdf, ghi OUT.\n"
        "   - Sao chép OUT sang WORK bằng shell: `cp OUT WORK` (để lô sau đọc từ "
        "WORK đã tích luỹ). Dùng đúng đường dẫn tuyệt đối ở trên.\n"
        "   - done_through = end; ghi STATE = {\"done_through\": end, \"last\": "
        "last} (shell, ghi đè file).\n"
        "4) Khi xong in ĐÚNG một dòng JSON: "
        "{\"engine\":\"codex\",\"out\":\"...\",\"pages\":<page_count>,\"done\":true}.\n"
        "Không dịch heading/công thức/bảng số/mục lục — extract_segments đã lọc sẵn."
    )


def build_cmd_claude(vol, cfg, sid):
    cmd = ["claude", "-p", build_prompt(vol, cfg["vision"]),
           "--model", cfg["model"],
           "--add-dir", TRANSLATE_ROOT,
           "--output-format", "stream-json", "--verbose",
           "--session-id", sid]
    if cfg.get("posture") == "bypass":
        cmd += ["--permission-mode", "bypassPermissions"]
    else:  # allowlist: không tắt hỏi quyền, chỉ cấp đúng tool cần
        cmd += ["--permission-mode", "default", "--allowedTools", *ALLOWED_TOOLS]
    return cmd


def build_cmd_codex(vol, cfg, sid):
    prompt = build_prompt_codex(vol, cfg.get("codex_batch", 25))
    base = ["codex", "exec", prompt, "--json", "--skip-git-repo-check",
            "-C", TRANSLATE_ROOT]          # cwd = translate root (source + out nằm trong)
    if cfg.get("posture") == "bypass":
        # QUAN TRỌNG: trong `codex exec` non-interactive, mỗi MCP tool call sinh
        # 1 elicitation "mcp_tool_call_approval" và bị TỰ HUỶ (decision:Cancel) —
        # kể cả approval_policy=never. Chỉ cờ bypass mới auto-approve được để
        # luồng MCP chạy không cần người bấm duyệt. Cờ này bỏ CẢ sandbox — rủi ro,
        # nên chỉ khi user tự chọn posture=bypass.
        return base + ["--dangerously-bypass-approvals-and-sandbox"]
    # allowlist (an toàn): sandbox workspace-write + không hỏi duyệt. LƯU Ý: do
    # giới hạn trên, các MCP tool call sẽ bị codex tự huỷ -> luồng KHÔNG hoàn tất.
    # Dùng khi chỉ muốn chạy sandbox chặt; để dịch thật hãy dùng bypass hoặc chạy
    # `codex` INTERACTIVE trong Terminal của app (duyệt MCP hoạt động bình thường).
    return base + ["-s", "workspace-write", "-c", "approval_policy=never"]


def build_cmd_grok(vol, cfg, sid):
    """Grok dịch qua CÙNG MCP `cfa-pdf-translator` như Codex (đã đăng ký ở
    ~/.grok/config.toml). Khác Codex: cờ `--always-approve` auto-duyệt MỌI tool
    call (kể cả MCP) nên chạy headless KHÔNG bị huỷ elicitation như codex exec."""
    prompt = build_prompt_codex(vol, cfg.get("codex_batch", 25))
    return ["grok", "-p", prompt, "--output-format", "plain",
            "--cwd", TRANSLATE_ROOT, "--always-approve"]


def build_cmd(vol, cfg, sid):
    engine = cfg.get("engine")
    if engine == "codex":
        return build_cmd_codex(vol, cfg, sid)
    if engine == "grok":
        return build_cmd_grok(vol, cfg, sid)
    return build_cmd_claude(vol, cfg, sid)


def _shq(s):
    """Bọc single-quote an toàn cho shell."""
    return "'" + str(s).replace("'", "'\\''") + "'"


def build_shell_cmd(vol, cfg, pages="all"):
    """Lệnh 1 dòng để CHẠY TRONG TERMINAL (xem live) và `tee` lưu log.

    - Prompt dài (nhiều dòng, có tiếng Việt) được ghi ra file rồi nạp bằng
      "$(cat file)" để tránh lỗi quoting.
    - Terminal-run dùng BYPASS (user tự bấm chạy + xem): Codex qua được rào duyệt
      MCP (headless không tự duyệt được); Claude chạy không kẹt hỏi quyền.
    - Codex nhận `pages` (khoảng trang) để CHẠY 1 PHẦN. Claude chạy cả volume
      (Workflow chunk cả doc; Dừng/Chạy lại để làm dần)."""
    wd = vol["workdir"]
    os.makedirs(wd, exist_ok=True)
    root = TRANSLATE_ROOT
    engine = cfg.get("engine", "claude")
    if engine == "codex":
        prompt = build_prompt_codex(vol, cfg.get("codex_batch", 25), pages)
        pf = os.path.join(wd, "codex.termprompt.txt")
        log = os.path.join(wd, "codex.terminal.log")
        open(pf, "w", encoding="utf-8").write(prompt)
        cmd = (f"cd {_shq(root)} && codex exec \"$(cat {_shq(pf)})\" "
               f"--skip-git-repo-check -C {_shq(root)} "
               f"--dangerously-bypass-approvals-and-sandbox 2>&1 | tee -a {_shq(log)}")
    else:
        prompt = build_prompt(vol, cfg.get("vision", True))
        pf = os.path.join(wd, "claude.termprompt.txt")
        log = os.path.join(wd, "claude.terminal.log")
        open(pf, "w", encoding="utf-8").write(prompt)
        cmd = (f"cd {_shq(root)} && claude -p \"$(cat {_shq(pf)})\" "
               f"--model {cfg.get('model', 'sonnet')} --add-dir {_shq(root)} "
               f"--permission-mode bypassPermissions 2>&1 | tee -a {_shq(log)}")
    rng = _parse_pages(pages)
    return {"cmd": cmd, "log": log, "engine": engine,
            "pages": f"{rng[0]}-{rng[1]}" if rng else "all"}


def launch(vol, cfg):
    """Spawn `claude -p` (nhóm tiến trình riêng để dừng sạch). Gắn reaper cập nhật
    run.json khi kết thúc. Trả (proc, sid) hoặc (None, reason)."""
    tag = vol["tag"]
    # Đặt chỗ NGUYÊN TỬ (check + reserve trong cùng 1 LOCK): chống 2 request cùng
    # tag spawn 2 tiến trình trên 1 workdir (double-click / batch đua với Chạy tay).
    with LOCK:
        held = RUNS.get(tag)
        if held and held.get("mode") == "starting":
            return None, "đang khởi động"
        if is_running(vol):
            return None, "đang chạy"
        RUNS[tag] = {"proc": None, "mode": "starting"}
    sid = str(uuid.uuid4())
    wd = vol["workdir"]
    try:
        os.makedirs(wd, exist_ok=True)
        log_path = os.path.join(wd, "run.log")
        logf = open(log_path, "ab", buffering=0)
        logf.write(f"\n===== RUN {time.strftime('%Y-%m-%d %H:%M:%S')} "
                   f"engine={cfg.get('engine', 'claude')} model={cfg['model']} "
                   f"posture={cfg['posture']} vision={cfg['vision']} "
                   f"sid={sid} =====\n".encode())
        proc = subprocess.Popen(
            build_cmd(vol, cfg, sid), cwd=TOOL,
            stdin=subprocess.DEVNULL,  # codex exec chờ đọc stdin -> sẽ treo nếu để inherit
            stdout=logf, stderr=subprocess.STDOUT,
            start_new_session=True,  # pgid == pid -> killpg dừng cả cây
        )
        logf.close()  # child giữ bản dup riêng
    except Exception:
        with LOCK:  # spawn lỗi -> nhả chỗ đã đặt để lần sau chạy lại được
            if (RUNS.get(tag) or {}).get("mode") == "starting":
                RUNS.pop(tag, None)
        raise
    meta = {"pid": proc.pid, "sid": sid, "log": log_path, "started": time.time(),
            "mode": "running", "model": cfg["model"],
            "engine": cfg.get("engine", "claude")}
    with LOCK:
        RUNS[tag] = {"proc": proc, **meta}
    save_run_meta(wd, meta)
    threading.Thread(target=_reap, args=(tag, wd, proc), daemon=True).start()
    return proc, sid


def _reap(tag, workdir, proc):
    rc = proc.wait()
    meta = load_run_meta(workdir) or {}
    meta.update({"mode": "exited", "rc": rc, "ended": time.time()})
    save_run_meta(workdir, meta)
    with LOCK:
        r = RUNS.get(tag)
        if r and r.get("proc") is proc:
            r["proc"] = None
            r["mode"] = "exited"


def _pid_of(vol):
    r = RUNS.get(vol["tag"])
    if r and r.get("proc") is not None and r["proc"].poll() is None:
        return r["proc"].pid
    # Chỉ tin pid trong run.json khi run được cho là CÒN chạy — tránh SIGTERM nhầm
    # một tiến trình khác được cấp lại pid cũ sau khi run đã thoát.
    meta = load_run_meta(vol["workdir"])
    return meta.get("pid") if meta and meta.get("mode") == "running" else None


def stop(vol):
    pid = _pid_of(vol)
    if not pid_alive(pid):
        return False
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
        return True
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
            return True
        except Exception:
            return False


# ----------------------------- batch ----------------------------------------
def _pending_tags():
    tags = []
    for v in load_volumes():
        if v.get("skip"):
            continue
        try:
            st = ap._status(v["workdir"])
        except Exception:
            st = {"stage": "translate"}
        if _effective_stage(st.get("stage")) != "done" and not codex_done(v):
            tags.append(v["tag"])
    return tags


def _batch_worker(cfg):
    try:
        for tag in list(BATCH["queue"]):
            if BATCH["stop"]:
                break
            vol = find_volume(tag)
            if not vol or is_running(vol):
                continue
            BATCH["current"] = tag
            proc, _ = launch(vol, cfg)
            if proc is None:
                continue
            while proc.poll() is None:      # chờ volume này xong, còn phản ứng Dừng
                if BATCH["stop"]:
                    stop(vol)
                    break
                time.sleep(2)
    finally:
        BATCH.update({"active": False, "current": None})


def batch_start(cfg):
    with LOCK:
        if BATCH["active"]:
            return False
        BATCH.update({"active": True, "stop": False, "current": None,
                      "queue": _pending_tags()})
    threading.Thread(target=_batch_worker, args=(dict(cfg),), daemon=True).start()
    return True


def batch_stop():
    BATCH["stop"] = True
    cur = BATCH.get("current")
    if cur:
        vol = find_volume(cur)
        if vol:
            stop(vol)


# ----------------------------- status snapshot ------------------------------
def vol_status(vol):
    try:
        st = ap._status(vol["workdir"])
    except Exception as e:
        st = {"stage": "error", "translate": [0, 0], "verify": [0, 0],
              "vision": [0, None], "pairs": 0, "error": str(e)}
    st["stage"] = _effective_stage(st.get("stage"))
    st["tag"] = vol["tag"]
    st["display"] = vol["display"]
    st["skip"] = bool(vol.get("skip"))
    st["running"] = is_running(vol)
    st["out_exists"] = os.path.exists(vol["out"])
    meta = load_run_meta(vol["workdir"]) or {}
    st["started"] = meta.get("started")
    st["mode"] = meta.get("mode")
    st["rc"] = meta.get("rc")
    st["sid"] = (meta.get("sid") or "")[:8]
    st["engine"] = meta.get("engine", CFG.get("engine", "claude"))
    st["logpath"] = os.path.join(vol["workdir"], "run.log")
    st["user"] = bool(vol.get("user"))
    st["pages"] = (st.get("vision") or [0, None])[1]  # số trang (None nếu chưa biết)
    # Luồng Codex không sinh file translate/verify/vision của Workflow; suy stage
    # + thanh tiến độ từ codex_state.json (dịch theo lô trang).
    cs = codex_state(vol)
    if cs is not None and st["stage"] != "done":
        last = cs.get("last")
        dt = cs.get("done_through", -1)
        if isinstance(last, int) and last >= 0:
            st["translate"] = [max(0, dt + 1), last + 1]
        if codex_done(vol):
            st["stage"] = "done"
        elif st["stage"] not in ("error",):
            st["stage"] = "translate"
    return st


# snapshot() gọi vol_status cho từng volume; vol_status -> ap._status mở PDF
# (fitz) để lấy page_count nên tốn ~vài trăm ms/volume. Parallel hoá qua thread
# (IO-bound) + cache TTL ngắn để nhiều request refresh trùng nhau tái dùng kết
# quả (client tự refresh mỗi vài giây).
_SNAP = {"t": 0.0, "data": None}
_SNAP_TTL = 4.0
_SNAP_LOCK = threading.Lock()


def _compute_snapshot():
    vols = load_volumes()
    with ThreadPoolExecutor(max_workers=min(8, len(vols) or 1)) as ex:
        items = list(ex.map(vol_status, vols))
    real = [i for i in items if not i["skip"]]
    done = sum(1 for i in real if i["stage"] == "done")
    return {
        "volumes": items,
        "done": done, "total": len(real),
        "running": sum(1 for i in items if i["running"]),
        "batch": {"active": BATCH["active"], "current": BATCH["current"]},
        "config": CFG, "engines": ENGINES, "models": MODELS, "postures": POSTURES,
    }


def snapshot():
    if _SNAP["data"] is not None and time.time() - _SNAP["t"] < _SNAP_TTL:
        return _SNAP["data"]
    # 1 request tính lại tại một thời điểm; các request trùng chờ rồi tái dùng.
    with _SNAP_LOCK:
        if _SNAP["data"] is not None and time.time() - _SNAP["t"] < _SNAP_TTL:
            return _SNAP["data"]
        data = _compute_snapshot()
        _SNAP["data"] = data
        _SNAP["t"] = time.time()  # tính TTL từ lúc XONG (compute có thể vài giây)
        return data


# ----------------------------- log parsing ----------------------------------
def _tool_hint(name, inp):
    if name == "Bash":
        return "⚙ Bash: " + str(inp.get("command", ""))[:90]
    if name in ("Write", "Edit", "Read"):
        return f"⚙ {name}: " + os.path.basename(str(inp.get("file_path", "")))
    if name == "Workflow":
        return "⚙ Workflow: " + os.path.basename(str(inp.get("scriptPath", "")))
    if name in ("Task", "Agent"):
        return "⚙ Agent: " + str(inp.get("description", ""))[:70]
    return "⚙ " + str(name)


def _summarize(obj):
    t = obj.get("type")
    if t == "assistant":
        parts = []
        for c in (obj.get("message", {}).get("content") or []):
            if c.get("type") == "text" and c.get("text", "").strip():
                parts.append("💬 " + c["text"].strip().replace("\n", " ")[:220])
            elif c.get("type") == "tool_use":
                parts.append(_tool_hint(c.get("name"), c.get("input", {})))
        return " | ".join(p for p in parts if p) or None
    if t == "result":
        return "✅ " + str(obj.get("result", ""))[:220]
    if t == "system" and obj.get("subtype") == "init":
        return "▶ session " + str(obj.get("session_id", ""))[:8]
    return _summarize_codex(obj, t)


def _summarize_codex(obj, t):
    """Tóm tắt 1 event JSONL của `codex exec --json` (khác schema Claude)."""
    if t in ("thread.started", "session.created"):
        return "▶ codex session"
    if t == "turn.completed":
        return None
    it = obj.get("item") or obj.get("msg") or {}
    itype = it.get("type") or it.get("item_type")
    if itype in ("agent_message", "assistant_message"):
        txt = str(it.get("text") or it.get("message") or "").strip()
        return "💬 " + txt.replace("\n", " ")[:220] if txt else None
    if itype in ("command_execution", "exec_command", "command"):
        return "⚙ Bash: " + str(it.get("command", ""))[:90]
    if itype in ("mcp_tool_call", "tool_call", "function_call"):
        tool = it.get("tool") or it.get("name") or ""
        return "⚙ MCP: " + str(tool)[:70]
    if itype in ("error",):
        return "⚠ " + str(it.get("message") or obj.get("message") or "")[:180]
    return None


def tail_log(vol, n=60):
    log_path = os.path.join(vol["workdir"], "run.log")
    if not os.path.exists(log_path):
        return []
    with open(log_path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 200_000))
        data = f.read().decode("utf-8", "replace")
    out = []
    for line in data.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("====="):
            out.append(line)
            continue
        try:
            s = _summarize(json.loads(line))
        except Exception:
            s = line[:220]
        if s:
            out.append(s)
    return out[-n:]


# ----------------------------- chat (per-document) --------------------------
# Khung chat theo TÀI LIỆU: spawn CLI (Claude/Codex/Grok) ở chế độ headless,
# streaming từng token về trình duyệt qua SSE (/api/chat). Mỗi cuốn giữ session
# riêng để nhớ ngữ cảnh giữa các lượt (resume theo session id của từng engine).
CHAT_ENGINES = ("claude", "codex", "grok")
CHAT_TIMEOUT = 300  # giây: watchdog cắt tiến trình nếu một lượt chạy quá lâu.
# Least-privilege cho agent chat (headless an toàn; tool ngoài danh sách bị TỪ
# CHỐI chứ không treo chờ duyệt). Đủ để đọc/tra nguồn, đề xuất & ghi bản dịch.
CHAT_TOOLS = ["Read", "Grep", "Glob", "Bash(cd *)", "Bash(python3 *)", "Write", "Edit"]


def chat_context(vol):
    """Preamble cấp cho agent biết 'cuốn này' là gì (đường dẫn nguồn/đích). Chỉ
    gửi ở LƯỢT ĐẦU (mở session mới); các lượt sau resume nên không lặp lại."""
    src, out, wd = vol["pdf"], vol["out"], vol["workdir"]
    return (
        "Bạn là trợ lý dịch thuật của app CFA Translate Studio, đang hỗ trợ người "
        "dùng về MỘT tài liệu cụ thể. Trả lời bằng tiếng Việt, ngắn gọn, đúng "
        "trọng tâm.\n"
        f"- Tên tài liệu: {vol['display']}\n"
        f"- PDF nguồn (tiếng Anh): {src}\n"
        f"- PDF bản dịch (tiếng Việt): {out} "
        f"({'đã có' if os.path.exists(out) else 'chưa có'})\n"
        f"- Thư mục làm việc: {wd}\n"
        "Bạn đang chạy trong thư mục 'translate'. Có thể đọc file nguồn để giải "
        "thích thuật ngữ, đề xuất bản dịch, hoặc soát lỗi trình bày. KHÔNG tự chạy "
        "pipeline dịch cả cuốn trừ khi người dùng yêu cầu rõ."
    )


def build_chat_cmd(engine, vol, message, session):
    """Trả (cmd, session, parser) cho 1 lượt chat headless streaming.
    session=None nghĩa là mở hội thoại mới; với claude ta tự sinh uuid, với
    grok/codex để CLI tự cấp rồi bắt lại từ stream (session event)."""
    root = TRANSLATE_ROOT
    first = not session
    text = message if not first else (chat_context(vol) + "\n\nNGƯỜI DÙNG: " + message)

    if engine == "grok":
        cmd = ["grok", "-p", text, "--output-format", "streaming-json",
               "--cwd", root, "--permission-mode", "auto"]
        if session:
            cmd += ["--resume", session]
        return cmd, session, "grok"

    if engine == "codex":
        # KHÔNG dùng --skip-git-repo-check để codex lưu session (resume được).
        # `codex exec resume` KHÔNG nhận -C/-s (kế thừa cwd + sandbox của phiên
        # gốc); cấu hình phải truyền qua -c và đặt TRƯỚC positional args.
        if session:
            cmd = ["codex", "exec", "resume", "--json",
                   "-c", "approval_policy=never", "-c", "sandbox_mode=workspace-write",
                   session, text]
        else:
            cmd = ["codex", "exec", text, "--json", "-C", root,
                   "-s", "workspace-write", "-c", "approval_policy=never"]
        return cmd, session, "codex"

    # claude (mặc định) — stream token thật + tool events, tool allowlist an toàn.
    base = ["claude", "-p", text, "--output-format", "stream-json", "--verbose",
            "--include-partial-messages", "--add-dir", root,
            "--permission-mode", "default", "--allowedTools", *CHAT_TOOLS]
    if session:
        cmd = base + ["--resume", session]
    else:
        session = str(uuid.uuid4())
        cmd = base + ["--session-id", session]
    return cmd, session, "claude"


def parse_chat_line(parser, line):
    """Chuyển 1 dòng stdout của CLI thành các sự kiện chuẩn hoá:
    ('delta', text) | ('tool', label) | ('session', id). Bỏ qua reasoning."""
    line = line.rstrip("\n")
    if not line.strip():
        return
    try:
        obj = json.loads(line)
    except Exception:
        return

    if parser == "claude":
        t = obj.get("type")
        if t == "stream_event":
            ev = obj.get("event", {})
            if ev.get("type") == "content_block_delta":
                d = ev.get("delta", {})
                if d.get("type") == "text_delta" and d.get("text"):
                    yield ("delta", d["text"])
        elif t == "assistant":
            for c in obj.get("message", {}).get("content", []):
                if c.get("type") == "tool_use":
                    yield ("tool", "🔧 " + (c.get("name") or "tool"))
        elif t == "result" and obj.get("session_id"):
            yield ("session", obj["session_id"])
        elif t == "system" and obj.get("subtype") == "init" and obj.get("session_id"):
            yield ("session", obj["session_id"])

    elif parser == "grok":
        t = obj.get("type")
        if t == "text" and obj.get("data"):
            yield ("delta", obj["data"])
        elif t and "tool" in t:
            yield ("tool", "🔧 " + str(obj.get("name") or obj.get("data") or t))
        elif t == "end" and obj.get("sessionId"):
            yield ("session", obj["sessionId"])
        # 'thought' -> ẩn reasoning cho gọn

    elif parser == "codex":
        t = obj.get("type")
        if t == "thread.started" and obj.get("thread_id"):
            yield ("session", obj["thread_id"])
        elif t == "item.completed":
            item = obj.get("item", {})
            it = item.get("type")
            if it == "agent_message" and item.get("text"):
                yield ("delta", item["text"])
            elif it in ("command_execution", "mcp_tool_call", "file_change"):
                yield ("tool", "🔧 " + str(item.get("command") or item.get("tool") or it))


# ----------------------------- HTTP handler ---------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # tắt log request ồn ào

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        # Yêu cầu application/json: request cross-origin dạng "simple" (text/plain)
        # không đặt được header này nếu không preflight -> chặn thêm 1 lớp CSRF.
        ctype = self.headers.get("Content-Type", "")
        if ctype and ctype.split(";")[0].strip() != "application/json":
            return {}
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            d = json.loads(self.rfile.read(n).decode())
        except Exception:
            return {}
        return d if isinstance(d, dict) else {}  # non-object -> {} (khỏi crash handler)

    def _origin_ok(self):
        """Chặn CSRF: nếu có Origin (request từ trình duyệt), host phải là localhost.
        Không có Origin (curl/same-origin) -> cho qua (không phải vector CSRF)."""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            host = urlparse(origin).hostname
        except Exception:
            return False
        return host in ("127.0.0.1", "localhost", "::1")

    def do_GET(self):
        try:
            self._route_get()
        except Exception as e:
            self._safe_500(e)

    def _route_get(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/ping":  # nhẹ, để app kiểm tra backend sẵn sàng
            return self._send(200, {"ok": True})
        if u.path == "/api/status":
            return self._send(200, snapshot())
        if u.path == "/api/log":
            vol = find_volume((q.get("tag") or [""])[0])
            if not vol:
                return self._send(404, {"error": "tag không tồn tại"})
            return self._send(200, {"tag": vol["tag"], "lines": tail_log(vol)})
        if u.path == "/api/command":
            vol = find_volume((q.get("tag") or [""])[0])
            if not vol:
                return self._send(404, {"error": "tag không tồn tại"})
            if vol.get("skip"):
                return self._send(400, {"error": "volume này đánh skip"})
            pages = (q.get("pages") or ["all"])[0]
            return self._send(200, build_shell_cmd(vol, CFG, pages))
        if u.path == "/api/file":
            return self._serve_file(q)
        if u.path == "/api/pageinfo":
            return self._pageinfo(q)
        if u.path == "/api/page":
            return self._render_page(q)
        # còn lại: phục vụ UI tĩnh (multi-page) từ tool/ui/
        return self._serve_static(u.path)

    def _serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(UI_DIR, rel))
        # chặn path traversal: phải nằm trong UI_DIR
        if not full.startswith(UI_DIR + os.sep) and full != UI_DIR:
            return self._send(403, {"error": "forbidden"})
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            # fallback: dashboard cũ (nếu UI chưa dựng) hoặc 404
            if rel in ("index.html", ""):
                return self._send(200, PAGE, "text/html; charset=utf-8")
            return self._send(404, {"error": "not found"})
        ctype = CTYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _pageinfo(self, q):
        vol = find_volume((q.get("tag") or [""])[0])
        if not vol:
            return self._send(404, {"error": "tag không tồn tại"})
        try:
            src = fitz.open(vol["pdf"]) if os.path.exists(vol["pdf"]) else None
            pages = src.page_count if src else 0
        except Exception:
            pages = 0
        return self._send(200, {"tag": vol["tag"], "display": vol["display"],
                                "pages": pages, "out_exists": os.path.exists(vol["out"])})

    def _render_page(self, q):
        """Render 1 trang PDF (source hoặc bản dịch) ra PNG cho màn đọc song song."""
        vol = find_volume((q.get("tag") or [""])[0])
        if not vol:
            return self._send(404, {"error": "tag không tồn tại"})
        which = (q.get("which") or ["source"])[0]
        path = vol["out"] if which == "out" else vol["pdf"]
        if not os.path.exists(path):
            return self._send(404, {"error": "file chưa có"})
        try:
            page = int((q.get("page") or ["0"])[0])
            dpi = max(60, min(220, int((q.get("dpi") or ["150"])[0])))
        except Exception:
            return self._send(400, {"error": "tham số không hợp lệ"})
        try:
            doc = fitz.open(path)
            if not (0 <= page < doc.page_count):
                return self._send(404, {"error": "page ngoài phạm vi"})
            png = doc[page].get_pixmap(dpi=dpi).tobytes("png")
        except Exception as e:
            return self._send(500, {"error": str(e)})
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(png)))
        self.end_headers()
        self.wfile.write(png)

    def _safe_500(self, e):
        try:
            self._send(500, {"error": str(e)})
        except Exception:
            pass  # header có thể đã gửi (vd đang stream file) -> bỏ qua

    def _serve_file(self, q):
        vol = find_volume((q.get("tag") or [""])[0])
        kind = (q.get("kind") or ["out"])[0]
        if not vol:
            return self._send(404, {"error": "tag không tồn tại"})
        path = vol["out"] if kind == "out" else vol["pdf"]  # chỉ 2 path hợp lệ
        if not os.path.exists(path):
            return self._send(404, {"error": "file chưa có"})
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Disposition",
                         f'inline; filename="{os.path.basename(path)}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        try:
            if not self._origin_ok():
                return self._send(403, {"error": "cross-origin bị chặn"})
            u = urlparse(self.path)
            if u.path == "/api/upload":  # đọc RAW bytes, không phải JSON
                return self._upload(u)
            body = self._read_body()
            if u.path == "/api/run":
                return self._run(body)
            if u.path == "/api/stop":
                return self._stop(body)
            if u.path == "/api/batch":
                return self._batch(body)
            if u.path == "/api/config":
                return self._config(body)
            if u.path == "/api/chat":
                return self._chat(body)
            return self._send(404, {"error": "not found"})
        except Exception as e:
            self._safe_500(e)

    def _run(self, body):
        vol = find_volume(body.get("tag", ""))
        if not vol:
            return self._send(404, {"error": "tag không tồn tại"})
        if vol.get("skip"):
            return self._send(400, {"error": "volume này đánh skip"})
        proc, info = launch(vol, CFG)
        if proc is None:
            return self._send(409, {"error": info})
        return self._send(200, {"ok": True, "sid": info})

    def _stop(self, body):
        vol = find_volume(body.get("tag", ""))
        if not vol:
            return self._send(404, {"error": "tag không tồn tại"})
        return self._send(200, {"ok": stop(vol)})

    def _batch(self, body):
        action = body.get("action")
        if action == "start":
            return self._send(200, {"ok": batch_start(CFG), "queue": BATCH["queue"]})
        if action == "stop":
            batch_stop()
            return self._send(200, {"ok": True})
        return self._send(400, {"error": "action không hợp lệ"})

    def _config(self, body):
        if body.get("engine") in ENGINES:
            CFG["engine"] = body["engine"]
        if body.get("model") in MODELS:
            CFG["model"] = body["model"]
        if body.get("posture") in POSTURES:
            CFG["posture"] = body["posture"]
        if "vision" in body:
            CFG["vision"] = bool(body["vision"])
        if isinstance(body.get("codex_batch"), int) and 5 <= body["codex_batch"] <= 200:
            CFG["codex_batch"] = body["codex_batch"]
        if isinstance(body.get("budget"), (int, float)) and body["budget"] >= 0:
            CFG["budget"] = body["budget"]
        if isinstance(body.get("budget_warn"), (int, float)):
            CFG["budget_warn"] = body["budget_warn"]
        save_cfg(CFG)
        return self._send(200, {"ok": True, "config": CFG})

    def _chat(self, body):
        """Chat theo tài liệu: spawn CLI headless, stream token về qua SSE.
        body = {tag, engine, message, session?}. Trả các frame `data: {...}`:
        {type:delta|tool|done|error, text?, session?}."""
        tag = (body.get("tag") or "").strip()
        engine = body.get("engine") if body.get("engine") in CHAT_ENGINES else "claude"
        message = (body.get("message") or "").strip()
        session = body.get("session") or None
        vol = find_volume(tag)
        if not vol:
            return self._send(404, {"error": "tag không tồn tại"})
        if not message:
            return self._send(400, {"error": "message rỗng"})

        cmd, session, parser = build_chat_cmd(engine, vol, message, session)

        # Header SSE (HTTP/1.0 + Connection: close -> client đọc tới khi đóng).
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()

        def sse(obj):
            try:
                self.wfile.write(
                    ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode()
                )
                self.wfile.flush()
                return True
            except Exception:
                return False

        try:
            proc = subprocess.Popen(
                cmd, cwd=TRANSLATE_ROOT, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={**os.environ, "PYTHONUNBUFFERED": "1"}, bufsize=1, text=True,
                start_new_session=True,  # pgid == pid -> killpg dừng CẢ CÂY (CLI + MCP con)
            )
        except FileNotFoundError:
            sse({"type": "error", "text": f"Không tìm thấy CLI '{engine}' trên máy."})
            return
        except Exception as e:
            sse({"type": "error", "text": str(e)})
            return

        def _terminate():
            """Dừng cả process group (CLI có thể spawn MCP server/tool con) rồi
            REAP — tránh để lại tiến trình mồ côi / zombie khi timeout hay client
            ngắt kết nối."""
            if proc.poll() is None:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
            try:
                proc.wait(timeout=5)
            except Exception:
                pass

        # Drain stderr ở luồng riêng (tránh deadlock khi pipe stderr đầy).
        err_buf = []
        def _drain():
            try:
                for l in proc.stderr:
                    err_buf.append(l)
                    if len(err_buf) > 200:
                        del err_buf[:100]
            except Exception:
                pass
        threading.Thread(target=_drain, daemon=True).start()

        # Watchdog: cắt tiến trình nếu chạy quá lâu.
        killed = {"v": False}
        def _kill():
            if proc.poll() is None:
                killed["v"] = True
                _terminate()
        timer = threading.Timer(CHAT_TIMEOUT, _kill)
        timer.daemon = True
        timer.start()

        got_session = session
        try:
            for line in proc.stdout:
                for kind, val in parse_chat_line(parser, line):
                    if kind == "session":
                        got_session = val
                    elif kind == "delta":
                        if not sse({"type": "delta", "text": val}):
                            raise BrokenPipeError()  # client ngắt
                    elif kind == "tool":
                        if not sse({"type": "tool", "text": val}):
                            raise BrokenPipeError()  # client ngắt (cả frame tool)
            proc.wait()
            if killed["v"]:
                sse({"type": "error", "text": f"Quá thời gian ({CHAT_TIMEOUT}s) — đã dừng."})
            elif proc.returncode not in (0, None):
                err = ("".join(err_buf)).strip()[-600:]
                sse({"type": "error", "text": err or f"{engine} thoát mã {proc.returncode}"})
            sse({"type": "done", "session": got_session})
        except (BrokenPipeError, ConnectionResetError):
            pass  # client ngắt -> dọn ở finally
        finally:
            timer.cancel()
            _terminate()  # luôn dừng cả cây tiến trình + reap
            try:
                proc.stdout.close()
            except Exception:
                pass

    def _upload(self, u):
        """Nhận 1 file PDF (raw bytes) và lưu vào input/ -> tự thành mục dịch.
        Tên file lấy từ ?name=; chỉ giữ basename (chống path traversal)."""
        q = parse_qs(u.query)
        name = os.path.basename((q.get("name") or [""])[0]).strip()
        if not name.lower().endswith(".pdf"):
            return self._send(400, {"error": "chỉ nhận file .pdf"})
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0:
            return self._send(400, {"error": "file rỗng"})
        if n > 400 * 1024 * 1024:
            return self._send(400, {"error": "file quá lớn (>400MB)"})
        data = self.rfile.read(n)
        os.makedirs(INPUT_DIR, exist_ok=True)
        with open(os.path.join(INPUT_DIR, name), "wb") as f:
            f.write(data)
        return self._send(200, {"ok": True, "name": name})


# ----------------------------- HTML page ------------------------------------
PAGE = r"""<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CFA Translate Manager</title>
<style>
:root{--bg:#0f1117;--panel:#171a23;--line:#262a36;--fg:#e6e8ee;--mut:#9aa3b2;
--acc:#4f8cff;--ok:#33c481;--warn:#e0b341;--run:#7c5cff;--bar:#222735}
@media(prefers-color-scheme:light){:root{--bg:#f5f6f9;--panel:#fff;--line:#e3e6ee;
--fg:#1b1f2a;--mut:#5b6472;--bar:#eef0f6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;align-items:center;gap:16px;padding:14px 22px;flex-wrap:wrap;
border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
h1{font-size:17px;margin:0;font-weight:650;letter-spacing:.2px}
.grow{flex:1}.mut{color:var(--mut)}
.pill{padding:2px 9px;border-radius:20px;font-size:12px;font-weight:600;
border:1px solid var(--line)}
.stage-translate{color:var(--acc)}.stage-verify{color:var(--warn)}
.stage-vision{color:var(--run)}.stage-done{color:var(--ok)}.stage-error{color:#ff5d5d}
main{padding:18px 22px;max-width:1180px;margin:0 auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;
color:var(--mut);padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
tr.skip{opacity:.45}
.name{font-weight:600}.sub{font-size:12px;color:var(--mut)}
.bars{display:flex;gap:10px;min-width:330px}
.b{flex:1}.b .lab{font-size:10px;color:var(--mut);display:flex;justify-content:space-between}
.track{height:7px;background:var(--bar);border-radius:6px;overflow:hidden;margin-top:3px}
.fill{height:100%;border-radius:6px;transition:width .4s}
.fill.tr{background:var(--acc)}.fill.vr{background:var(--warn)}.fill.vs{background:var(--run)}
button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--fg);
padding:6px 13px;border-radius:8px;cursor:pointer;font-weight:600}
button:hover{border-color:var(--acc)}button:disabled{opacity:.4;cursor:not-allowed}
button.run{background:var(--acc);border-color:var(--acc);color:#fff}
button.stop{background:#e0483f;border-color:#e0483f;color:#fff}
button.ghost{background:transparent}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot.live{background:var(--run);animation:pulse 1.4s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(124,92,255,.6)}
70%{box-shadow:0 0 0 7px rgba(124,92,255,0)}100%{box-shadow:0 0 0 0 rgba(124,92,255,0)}}
select{font:inherit;background:var(--panel);color:var(--fg);border:1px solid var(--line);
border-radius:8px;padding:5px 8px}
label.ck{display:inline-flex;align-items:center;gap:5px;color:var(--mut)}
.log{background:#0a0c12;color:#c7d0e0;border:1px solid var(--line);border-radius:10px;
padding:12px 14px;margin-top:8px;font:12px/1.55 ui-monospace,Menlo,monospace;
max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
a.link{color:var(--acc);text-decoration:none;font-weight:600;font-size:12px}
.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.warnbypass{color:var(--warn);font-size:12px}
</style></head><body>
<header>
  <h1>📘 CFA Translate Manager</h1>
  <span id="summary" class="mut" style="font-size:13px"></span>
  <span class="grow"></span>
  <div class="tools">
    <label class="mut">Engine <select id="engine"></select></label>
    <label class="mut" id="wrapModel">Model <select id="model"></select></label>
    <label class="mut" id="wrapBatch" style="display:none">Lô trang
      <input id="codex_batch" type="number" min="5" max="200" step="5"
             style="width:60px;font:inherit;background:var(--panel);color:var(--fg);
             border:1px solid var(--line);border-radius:8px;padding:5px 7px"></label>
    <label class="mut">Quyền <select id="posture"></select></label>
    <label class="ck" id="wrapVision"><input type="checkbox" id="vision"> Vision</label>
    <label class="mut" id="wrapPages" title="Chỉ Codex: chạy 1 phần theo khoảng trang (0-based)">Trang
      <input id="pages" placeholder="vd 40-80" style="width:82px;font:inherit;
      background:var(--panel);color:var(--fg);border:1px solid var(--line);
      border-radius:8px;padding:5px 7px"></label>
    <button id="addPdfBtn" title="Chọn PDF -> copy vào input/ để dịch">➕ Thêm PDF</button>
    <input id="pdfInput" type="file" accept="application/pdf,.pdf" multiple style="display:none">
    <button id="batchBtn" class="run">▶ Chạy cả batch</button>
    <span class="pill mut">⟳ auto 3s</span>
  </div>
</header>
<main>
  <div id="bypassWarn" class="warnbypass" style="display:none">
    ⚠ Đang bật <b>bypass</b>: agent con chạy Bash/Write không hỏi quyền. Chỉ dùng nếu bạn chấp nhận rủi ro.
  </div>
  <table>
    <thead><tr><th>Volume</th><th>Trạng thái</th><th>Tiến độ</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="logwrap" style="display:none">
    <h3 style="margin:22px 0 0">Log <span id="logtag" class="mut"></span>
      <button class="ghost" onclick="closeLog()" style="float:right">✕ đóng</button></h3>
    <div id="log" class="log"></div>
  </div>
</main>
<script>
const $=s=>document.querySelector(s);
const PLABEL={allowlist:"An toàn (allowlist)",bypass:"Bypass (bỏ hỏi quyền)"};
const ELABEL={claude:"Claude (Workflow 4-phase)",codex:"Codex (MCP đơn giản)"};
let CFG=null, openTag=null;
function applyEngineUI(){
  const codex=$('#engine').value==='codex';
  $('#wrapModel').style.display=codex?'none':'';
  $('#wrapVision').style.display=codex?'none':'';
  $('#wrapBatch').style.display=codex?'':'none';
}
let LAST={};  // tag -> volume status (cho runTerm/tailLog)
async function runTerm(tag){
  if(!window.appBridge) return;
  const pages=($('#pages').value||'all').trim()||'all';
  try{
    const r=await fetch('/api/command?tag='+encodeURIComponent(tag)+'&pages='+encodeURIComponent(pages));
    const d=await r.json();
    if(!r.ok){alert(d.error||'lỗi');return;}
    await window.appBridge.runInTerminal(d.cmd);
  }catch(e){alert('Không chạy được ở terminal: '+e);}
}
async function tailLog(tag){
  if(!window.appBridge) return;
  const v=LAST[tag]; if(!v||!v.logpath){alert('chưa có log');return;}
  await window.appBridge.tailLog(v.logpath);
}
async function addPdf(files){
  if(!files.length) return;
  const btn=$('#addPdfBtn'); const old=btn.textContent; btn.textContent='⏳ Đang copy…'; btn.disabled=true;
  let ok=0;
  for(const f of files){
    try{
      const r=await fetch('/api/upload?name='+encodeURIComponent(f.name),
        {method:'POST',headers:{'Content-Type':'application/pdf'},body:f});
      if(r.ok)ok++; else{const d=await r.json().catch(()=>({}));alert('Lỗi thêm '+f.name+': '+(d.error||''));}
    }catch(e){alert('Lỗi thêm '+f.name+': '+e);}
  }
  btn.textContent=old; btn.disabled=false;
  if(ok)await refresh();
}

function bar(cls,pair){
  const[d,t]=pair||[0,0]; const pct=t?Math.round(100*d/t):0;
  const lab=cls==='vs'?'vision':cls==='vr'?'verify':'translate';
  return `<div class="b"><div class="lab"><span>${lab}</span><span>${t?d+'/'+t:'–'}</span></div>
   <div class="track"><div class="fill ${cls}" style="width:${pct}%"></div></div></div>`;
}
function row(v){
  const skip=v.skip?' class="skip"':'';
  const live=v.running?'<span class="dot live"></span>':'';
  const stage=`<span class="pill stage-${v.stage}">${live}${v.stage}</span>`;
  const bars=`<div class="bars">${bar('tr',v.translate)}${bar('vr',v.verify)}${bar('vs',v.vision)}</div>`;
  let act='';
  if(v.skip){act='<span class="mut">skip</span>';}
  else if(v.running){act=`<button class="stop" onclick="act('stop','${v.tag}')">■ Dừng</button>`;}
  else if(v.stage==='done'){act=`<button class="run" onclick="act('run','${v.tag}')">↻ Chạy lại</button>`;}
  else{act=`<button class="run" onclick="act('run','${v.tag}')">▶ Chạy</button>`;}
  const links=[];
  if(v.out_exists)links.push(`<a class="link" href="/api/file?tag=${v.tag}&kind=out" target="_blank">PDF↗</a>`);
  links.push(`<a class="link" href="#" onclick="showLog('${v.tag}');return false">log</a>`);
  if(window.appBridge){
    links.push(`<a class="link" href="#" title="Chạy ở Terminal bên cạnh (xem live + lưu log)" onclick="runTerm('${v.tag}');return false">▶ Term</a>`);
    links.push(`<a class="link" href="#" title="Xem run.log ở Terminal (tail -f)" onclick="tailLog('${v.tag}');return false">📺 Log</a>`);
  }
  const eng=v.engine?(v.engine==='codex'?'🤖 codex':'✳ claude'):'';
  const sub=[eng, v.sid?('sid '+v.sid):'', (v.mode==='exited'&&v.rc!=null)?('rc '+v.rc):''].filter(Boolean).join(' · ');
  return `<tr${skip}>
    <td><div class="name">${v.user?'📄 ':''}${v.display}</div><div class="sub">${v.tag}${sub?' · '+sub:''}</div></td>
    <td>${stage}</td><td>${bars}</td>
    <td><div class="actions">${links.join('')}${act}</div></td></tr>`;
}
function fillSelect(sel,opts,val,labels){
  sel.innerHTML=opts.map(o=>`<option value="${o}" ${o===val?'selected':''}>${labels?labels[o]:o}</option>`).join('');
}
async function refresh(){
  const s=await (await fetch('/api/status')).json();
  LAST={}; s.volumes.forEach(v=>LAST[v.tag]=v);
  if(!CFG){
    CFG=s.config;
    fillSelect($('#engine'),s.engines,CFG.engine,ELABEL);
    fillSelect($('#model'),s.models,CFG.model);
    fillSelect($('#posture'),s.postures,CFG.posture,PLABEL);
    $('#vision').checked=CFG.vision;
    $('#codex_batch').value=CFG.codex_batch||25;
    applyEngineUI();
    $('#engine').onchange=()=>{applyEngineUI();saveCfg();};
    $('#model').onchange=$('#posture').onchange=$('#vision').onchange=$('#codex_batch').onchange=saveCfg;
    $('#addPdfBtn').onclick=()=>$('#pdfInput').click();
    $('#pdfInput').onchange=e=>{const fs=[...e.target.files];e.target.value='';addPdf(fs);};
  }
  $('#bypassWarn').style.display=($('#posture').value==='bypass')?'block':'none';
  $('#rows').innerHTML=s.volumes.map(row).join('');
  $('#summary').textContent=`xong ${s.done}/${s.total} · ${s.running} đang chạy`
    +(s.batch.active?` · batch ▶ ${s.batch.current||'...'}`:'');
  const bb=$('#batchBtn');
  bb.textContent=s.batch.active?'■ Dừng batch':'▶ Chạy cả batch';
  bb.className=s.batch.active?'stop':'run';
  bb.onclick=()=>fetch('/api/batch',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:s.batch.active?'stop':'start'})}).then(refresh);
  if(openTag)loadLog();
}
async function saveCfg(){
  CFG={engine:$('#engine').value,model:$('#model').value,posture:$('#posture').value,
    vision:$('#vision').checked,codex_batch:parseInt($('#codex_batch').value)||25};
  $('#bypassWarn').style.display=(CFG.posture==='bypass')?'block':'none';
  await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(CFG)});
}
async function act(kind,tag){
  const r=await fetch('/api/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({tag})});
  if(!r.ok){const e=await r.json().catch(()=>({}));alert(e.error||'lỗi');}
  refresh();
}
function showLog(tag){openTag=tag;$('#logwrap').style.display='block';
  $('#logtag').textContent='· '+tag;loadLog();
  $('#logwrap').scrollIntoView({behavior:'smooth'});}
function closeLog(){openTag=null;$('#logwrap').style.display='none';}
async function loadLog(){
  const d=await (await fetch('/api/log?tag='+openTag)).json();
  $('#log').textContent=(d.lines||[]).join('\n')||'(chưa có log)';
}
refresh();setInterval(refresh,3000);
</script></body></html>"""


# ----------------------------- main -----------------------------------------
def reconcile_on_start():
    """Đồng bộ run.json cũ: pid không còn sống -> đánh dấu exited."""
    for v in load_volumes():
        meta = load_run_meta(v["workdir"])
        if meta and meta.get("mode") == "running" and not pid_alive(meta.get("pid")):
            meta["mode"] = "exited"
            save_run_meta(v["workdir"], meta)


def main():
    parser = argparse.ArgumentParser(description="Màn hình quản lý dịch CFA")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8756)
    a = parser.parse_args()
    reconcile_on_start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"▶ CFA Translate Manager: http://{a.host}:{a.port}")
    print(f"  tool={TOOL}  model={CFG['model']}  posture={CFG['posture']}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nĐã dừng.")


if __name__ == "__main__":
    main()
