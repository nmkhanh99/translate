// CFA Translate Studio — vỏ macOS (Electron) cho dashboard.py.
// ---------------------------------------------------------------------------
// Cửa sổ ĐƠN, toàn màn hình: nạp giao diện Next.js (tool/web, build tĩnh) do
// backend dashboard.py phục vụ tại cùng origin với /api/*. KHÔNG còn Terminal
// nhúng (xterm/node-pty) — thay bằng KHUNG CHAT theo tài liệu ngay trong UI
// (Claude / Codex / Grok qua /api/chat).
//
// App KHÔNG tự chứa agent (agent-native như open-design): dashboard.py spawn
// `claude`/`codex`/`grok` headless và stream kết quả về trình duyệt.

const { app, BrowserWindow, shell, Menu, dialog } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

const TOOL_DIR = path.join(__dirname, ".."); // .../translate/tool
const WEB_OUT = path.join(TOOL_DIR, "web", "out"); // bản Next.js đã build

let py = null; // tiến trình dashboard.py
let baseURL = null;
let win = null;

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

// ---- cửa sổ ---------------------------------------------------------------
function createWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 1000,
    minHeight: 600,
    title: "CFA Translate Studio",
    backgroundColor: "#fafafa",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(url);
  // PDF/bản dịch mở ở cửa sổ con (cùng localhost); link ngoài -> trình duyệt hệ thống.
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
  win.on("closed", () => {
    win = null;
  });
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
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
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
  if (!fs.existsSync(WEB_OUT)) {
    // Chưa build giao diện Next.js -> dashboard.py sẽ lùi về UI cũ. Nhắc user.
    dialog.showMessageBoxSync({
      type: "warning",
      title: "Chưa build giao diện Next.js",
      message: "Không thấy tool/web/out.",
      detail:
        "Chạy một lần:\n  cd tool/web && npm install && npm run build\n\n" +
        "Tạm thời app sẽ hiển thị giao diện cũ.",
    });
  }
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
    if (!win && baseURL) createWindow(baseURL);
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (py) {
    try {
      py.kill("SIGTERM");
    } catch (_) {}
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
