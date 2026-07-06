// CFA Translate Studio — vỏ macOS (Electron) cho dashboard.py.
// ---------------------------------------------------------------------------
// App này KHÔNG tự chứa agent. Đúng tinh thần open-design (agent-native): nó
// khởi động backend Python `dashboard.py` (đã có sẵn trong tool/) trên một cổng
// local, rồi hiển thị UI đó trong cửa sổ native. Backend spawn `claude` hoặc
// `codex` như tiến trình con để dịch — user chọn engine ngay trong app.
//
// Vòng đời: app mở -> tìm cổng trống -> spawn `python3 dashboard.py --port N`
// -> chờ /api/status trả 200 -> nạp http://127.0.0.1:N. App đóng -> tắt backend
// (các tiến trình claude/codex đang chạy được checkpoint theo file nên mở lại
// bấm Chạy là tự resume).

const { app, BrowserWindow, shell, Menu, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");

// node-pty là native module (đã electron-rebuild). Nạp mềm để app vẫn chạy nếu
// thiếu — chỉ tính năng Terminal bị vô hiệu.
let pty = null;
let ptyErr = null;
try {
  pty = require("node-pty");
} catch (e) {
  ptyErr = e;
}

const TOOL_DIR = path.join(__dirname, ".."); // .../translate/tool
const TRANSLATE_ROOT = path.join(TOOL_DIR, ".."); // .../translate
let py = null; // tiến trình dashboard.py
let baseURL = null;
let win = null;

// ---- chọn python3 khả dụng ------------------------------------------------
function pythonBin() {
  return process.env.CFA_PYTHON || "python3";
}

// ---- xin 1 cổng TCP trống -------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// ---- chờ backend sẵn sàng (poll /api/status) ------------------------------
function waitReady(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/ping", timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve();
          retry(n);
        }
      );
      req.on("error", () => retry(n));
      req.on("timeout", () => {
        req.destroy();
        retry(n);
      });
    };
    const retry = (n) => {
      if (n <= 0) return reject(new Error("backend không phản hồi"));
      setTimeout(() => tick(n - 1), 400);
    };
    tick(tries);
  });
}

// ---- khởi động dashboard.py ----------------------------------------------
async function startBackend() {
  const port = await freePort();
  console.log("[backend] spawning dashboard.py on port", port);
  py = spawn(pythonBin(), ["dashboard.py", "--port", String(port)], {
    cwd: TOOL_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  let stderr = "";
  py.stderr.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  py.on("exit", (code) => {
    py = null;
    // Backend chết bất ngờ khi app còn mở -> báo lỗi (thường do thiếu pymupdf).
    if (!app.isQuitting && win) {
      dialog.showErrorBox(
        "Backend dừng đột ngột",
        `dashboard.py thoát (code ${code}).\n\n${stderr || "(không có stderr)"}`
      );
    }
  });
  await waitReady(port);
  baseURL = `http://127.0.0.1:${port}`;
  return baseURL;
}

// ---- cửa sổ chính ---------------------------------------------------------
function createWindow(url) {
  win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "CFA Translate Studio",
    backgroundColor: "#0f1117",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(url);

  // Link "PDF↗" mở target=_blank -> mở cửa sổ mới trong app (Chromium xem PDF
  // được); link ngoài localhost -> mở bằng trình duyệt hệ thống.
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith("http://127.0.0.1")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: { width: 900, height: 1000, title: "PDF" },
      };
    }
    shell.openExternal(u);
    return { action: "deny" };
  });
  win.on("closed", () => (win = null));
}

// ---- Terminal nhúng (xterm ↔ node-pty) ------------------------------------
// Cửa sổ Terminal thật (PTY) mở trong app để chạy `claude`/`codex` INTERACTIVE
// — tận dụng đủ harness (Claude) và duyệt MCP tương tác (Codex), điều mà luồng
// headless không làm được. node-pty giữ ở main process; renderer chỉ nói chuyện
// qua preload/IPC.
let ptySeq = 0;
const ptys = new Map(); // id -> pty process

ipcMain.handle("pty:create", (e, opts = {}) => {
  if (!pty) throw new Error("node-pty không nạp được: " + (ptyErr && ptyErr.message));
  const id = String(++ptySeq);
  const shell = process.env.SHELL || "/bin/zsh";
  const p = pty.spawn(shell, ["-l"], {
    name: "xterm-256color",
    cols: opts.cols || 100,
    rows: opts.rows || 30,
    cwd: TRANSLATE_ROOT,
    env: process.env,
  });
  const wc = e.sender;
  p.onData((d) => {
    if (!wc.isDestroyed()) wc.send("pty:data", { id, data: d });
  });
  p.onExit(({ exitCode }) => {
    if (!wc.isDestroyed()) wc.send("pty:exit", { id, code: exitCode });
    ptys.delete(id);
  });
  ptys.set(id, p);
  return id;
});
ipcMain.on("pty:write", (_e, { id, data }) => {
  const p = ptys.get(id);
  if (p) p.write(data);
});
ipcMain.on("pty:resize", (_e, { id, cols, rows }) => {
  const p = ptys.get(id);
  if (p) {
    try {
      p.resize(cols, rows);
    } catch (_) {}
  }
});
ipcMain.on("pty:kill", (_e, { id }) => {
  const p = ptys.get(id);
  if (p) {
    try {
      p.kill();
    } catch (_) {}
    ptys.delete(id);
  }
});

function openTerminal() {
  const t = new BrowserWindow({
    width: 940,
    height: 580,
    title: "Terminal",
    backgroundColor: "#0a0c12",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  t.loadFile(path.join(__dirname, "terminal.html"));
  return t;
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    {
      label: "Xem",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Terminal",
      submenu: [
        {
          label: "Terminal mới",
          accelerator: "CmdOrCtrl+T",
          click: () => openTerminal(),
        },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- lifecycle ------------------------------------------------------------
app.whenReady().then(async () => {
  console.log("[app] ready, starting backend… python=", pythonBin(), "cwd=", TOOL_DIR);
  buildMenu();
  try {
    const url = await startBackend();
    console.log("[app] backend ready at", url);
    createWindow(url);
  } catch (e) {
    console.error("[app] backend failed:", e && e.message);
    dialog.showErrorBox(
      "Không khởi động được backend",
      `${e.message}\n\nKiểm tra: đã cài phụ thuộc chưa?\n` +
        `  pip3 install -r ${path.join(TOOL_DIR, "requirements.txt")}\n` +
        `và có 'python3' trong PATH (hoặc đặt biến CFA_PYTHON).`
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && baseURL) createWindow(baseURL);
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
  for (const p of ptys.values()) {
    try {
      p.kill();
    } catch (_) {}
  }
  if (py) {
    try {
      py.kill("SIGTERM");
    } catch (_) {}
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
