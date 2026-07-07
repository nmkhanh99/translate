// CFA Translate Studio — vỏ macOS (Electron) cho dashboard.py.
// ---------------------------------------------------------------------------
// Cửa sổ chia ĐÔI: TRÁI = dashboard (dashboard.py, remote) · PHẢI = Terminal
// thật (xterm + node-pty). Terminal bên cạnh để CHẠY 1 phần và XEM tiến trình
// live; dashboard có nút gửi lệnh/tail-log sang terminal (cầu nối qua preload).
//
// App KHÔNG tự chứa agent (agent-native như open-design): backend dashboard.py
// spawn `claude`/`codex`; terminal cho phép chạy interactive/scoped + lưu log.

const {
  app,
  BaseWindow,
  WebContentsView,
  BrowserWindow,
  shell,
  Menu,
  dialog,
  ipcMain,
} = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");

// node-pty là native module (đã electron-rebuild). Nạp mềm để app vẫn chạy nếu
// thiếu — chỉ Terminal bị vô hiệu.
let pty = null;
let ptyErr = null;
try {
  pty = require("node-pty");
} catch (e) {
  ptyErr = e;
}

const TOOL_DIR = path.join(__dirname, ".."); // .../translate/tool
const TRANSLATE_ROOT = path.join(TOOL_DIR, ".."); // .../translate
const PRELOAD = path.join(__dirname, "preload.js");

let py = null; // tiến trình dashboard.py
let baseURL = null;

// split window state
let baseWin = null;
let dashView = null;
let termView = null;
let termVisible = true;
let termFrac = 0.42; // bề rộng pane terminal theo tỉ lệ

// ---- python + cổng --------------------------------------------------------
function pythonBin() {
  return process.env.CFA_PYTHON || "python3";
}

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
    if (!app.isQuitting && baseWin) {
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

// ---- bố cục 2 pane --------------------------------------------------------
function layout() {
  if (!baseWin) return;
  const { width, height } = baseWin.getContentBounds();
  if (termVisible && termView) {
    const tw = Math.max(320, Math.round(width * termFrac));
    dashView.setBounds({ x: 0, y: 0, width: width - tw, height });
    termView.setBounds({ x: width - tw, y: 0, width: tw, height });
    termView.setVisible(true);
  } else {
    dashView.setBounds({ x: 0, y: 0, width, height });
    if (termView) termView.setVisible(false);
  }
}

function toggleTerminal(force) {
  termVisible = typeof force === "boolean" ? force : !termVisible;
  layout();
}

function createWindow(url) {
  baseWin = new BaseWindow({
    width: 1440,
    height: 880,
    minWidth: 1000,
    minHeight: 600,
    title: "CFA Translate Studio",
    backgroundColor: "#0f1117",
  });

  dashView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  dashView.webContents.loadURL(url);
  dashView.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith("http://127.0.0.1")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: { width: 900, height: 1000, title: "PDF" },
      };
    }
    shell.openExternal(u);
    return { action: "deny" };
  });

  termView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  termView.webContents.loadFile(path.join(__dirname, "terminal.html"));

  baseWin.contentView.addChildView(dashView);
  baseWin.contentView.addChildView(termView);
  baseWin.on("resize", layout);
  baseWin.on("closed", () => {
    baseWin = null;
    dashView = null;
    termView = null;
  });
  layout();
}

// ---- Terminal (xterm ↔ node-pty) + cầu nối dashboard→terminal --------------
let ptySeq = 0;
const ptys = new Map(); // id -> pty process
let sideTermPtyId = null; // pty của pane terminal (nhận lệnh từ dashboard)

ipcMain.handle("pty:create", (e, opts = {}) => {
  if (!pty) throw new Error("node-pty không nạp được: " + (ptyErr && ptyErr.message));
  const id = String(++ptySeq);
  const shellBin = process.env.SHELL || "/bin/zsh";
  const p = pty.spawn(shellBin, ["-l"], {
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
    if (sideTermPtyId === id) sideTermPtyId = null;
  });
  ptys.set(id, p);
  // pty của pane terminal chính = nơi nhận lệnh "chạy ở terminal".
  if (termView && e.sender === termView.webContents) sideTermPtyId = id;
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

// Cầu nối: dashboard (dashView) gửi lệnh/tail sang pane terminal.
function writeToSideTerm(text) {
  const p = sideTermPtyId && ptys.get(sideTermPtyId);
  if (!p) return false;
  toggleTerminal(true); // hiện pane để user thấy tiến trình
  p.write(text);
  if (termView) termView.webContents.focus();
  return true;
}
ipcMain.handle("term:run", (_e, { cmd }) => {
  if (!cmd) return false;
  return writeToSideTerm(cmd.trim() + "\n");
});
ipcMain.handle("term:tail", (_e, { path: logPath }) => {
  if (!logPath) return false;
  // Ctrl-C ngắt tail trước đó (nếu có) rồi tail file mới.
  return writeToSideTerm('tail -n 40 -f "' + logPath + '"\n');
});
ipcMain.handle("term:toggle", () => {
  toggleTerminal();
  return termVisible;
});

// Cửa sổ Terminal RỜI (tuỳ chọn) — ngoài pane cạnh dashboard.
function openTerminalWindow() {
  const t = new BrowserWindow({
    width: 940,
    height: 580,
    title: "Terminal",
    backgroundColor: "#0a0c12",
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
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
          label: "Ẩn/hiện Terminal bên cạnh",
          accelerator: "CmdOrCtrl+T",
          click: () => toggleTerminal(),
        },
        {
          label: "Terminal rộng hơn",
          accelerator: "CmdOrCtrl+Shift+.",
          click: () => {
            termFrac = Math.min(0.7, termFrac + 0.07);
            toggleTerminal(true);
          },
        },
        {
          label: "Terminal hẹp hơn",
          accelerator: "CmdOrCtrl+Shift+,",
          click: () => {
            termFrac = Math.max(0.25, termFrac - 0.07);
            toggleTerminal(true);
          },
        },
        { type: "separator" },
        { label: "Terminal cửa sổ rời", click: () => openTerminalWindow() },
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
    if (!baseWin && baseURL) createWindow(baseURL);
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
