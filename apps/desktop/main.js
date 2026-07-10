// CFA Translate Studio — macOS Electron APP (sản phẩm chính).
// UI renderer = apps/ui (static). Daemon = apps/daemon (loopback).
// Agents = local CLIs only (claude / codex / grok).
const { app, BrowserWindow, shell, dialog, Menu } = require("electron");
const { spawn, execFileSync } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");

const REPO_ROOT = path.resolve(__dirname, "../..");
// A packaged .app ships the prebuilt renderer + python engine under Resources/
// (see electron-builder extraResources); dev runs straight from the repo.
const PACKAGED = app.isPackaged;
const RES_DIR = PACKAGED ? process.resourcesPath : REPO_ROOT;
const UI_OUT = PACKAGED
  ? path.join(process.resourcesPath, "ui-out")
  : path.join(REPO_ROOT, "apps/ui/out");
const PYTHON_DIR = PACKAGED
  ? path.join(process.resourcesPath, "python")
  : path.join(REPO_ROOT, "python");
// Dev: run the daemon TS source via tsx. Packaged: run the bundled compiled
// daemon (Resources/daemon/cli.js) with Electron's built-in Node.
const DAEMON_ENTRY = PACKAGED
  ? path.join(process.resourcesPath, "daemon", "cli.js")
  : path.join(REPO_ROOT, "apps/daemon/src/cli.ts");

let daemon = null;
let win = null;
let baseURL = null;
let starting = null;

/** GUI apps often get a minimal PATH (no nvm/homebrew). Merge login-shell PATH. */
function buildEnv() {
  const env = { ...process.env };
  const extras = [
    path.join(os.homedir(), ".local/bin"),
    path.join(os.homedir(), ".grok/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  let loginPath = "";
  try {
    loginPath = execFileSync(
      process.env.SHELL || "/bin/zsh",
      ["-ilc", "print -r -- $PATH"],
      { encoding: "utf8", timeout: 4000 }
    ).trim();
  } catch {
    /* ignore */
  }
  const parts = [
    ...(loginPath ? loginPath.split(":") : []),
    ...(env.PATH || "").split(":"),
    ...extras,
  ].filter(Boolean);
  env.PATH = [...new Set(parts)].join(":");
  env.PYTHONUNBUFFERED = "1";
  return env;
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

function waitReady(port, tries = 100) {
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
      if (n <= 0) return reject(new Error("daemon không phản hồi"));
      setTimeout(() => tick(n - 1), 400);
    };
    tick(tries);
  });
}

function ensureUiBuilt() {
  return fs.existsSync(path.join(UI_OUT, "index.html"));
}

/** Auto-build renderer if missing (dev convenience). */
function tryBuildUi() {
  if (ensureUiBuilt()) return true;
  if (PACKAGED) return false; // packaged app ships a prebuilt UI; no pnpm here
  console.log("[app] building UI (apps/ui)…");
  try {
    execFileSync("pnpm", ["--filter", "@cfa-translate/ui", "build"], {
      cwd: REPO_ROOT,
      env: buildEnv(),
      stdio: "inherit",
      timeout: 180000,
    });
  } catch (e) {
    console.error("[app] build:ui failed", e);
    return false;
  }
  return ensureUiBuilt();
}

function resolveTsx() {
  const name = process.platform === "win32" ? "tsx.cmd" : "tsx";
  const candidates = [
    path.join(REPO_ROOT, "apps/daemon/node_modules/.bin", name),
    path.join(REPO_ROOT, "node_modules/.bin", name),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

async function startDaemon() {
  if (baseURL && daemon) return baseURL;
  if (starting) return starting;

  starting = (async () => {
    const port = await freePort();
    console.log("[app] daemon on", port);

    const env = buildEnv();
    env.CFA_PORT = String(port);
    env.CFA_PYTHON_DIR = PYTHON_DIR;

    let bin;
    if (PACKAGED) {
      // Bundled daemon is plain JS → run it with Electron's own Node runtime.
      if (!fs.existsSync(DAEMON_ENTRY)) {
        throw new Error(
          "Bản đóng gói thiếu daemon (Resources/daemon). Cần bundle apps/daemon khi build."
        );
      }
      env.ELECTRON_RUN_AS_NODE = "1";
      bin = process.execPath;
    } else {
      const tsxBin = resolveTsx();
      if (!tsxBin) {
        throw new Error("Không tìm thấy tsx. Chạy: pnpm install");
      }
      bin = tsxBin;
    }

    daemon = spawn(bin, [DAEMON_ENTRY, "--port", String(port), "--no-open"], {
      cwd: RES_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    daemon.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
      process.stderr.write(d);
    });
    daemon.stdout.on("data", (d) => process.stdout.write(d));
    daemon.on("exit", (code) => {
      daemon = null;
      baseURL = null;
      starting = null;
      if (!app.isQuitting && win) {
        dialog.showErrorBox(
          "Backend dừng",
          `Daemon thoát (code ${code}).\n\n${stderr || "(không có stderr)"}`
        );
      }
    });

    await waitReady(port);
    baseURL = `http://127.0.0.1:${port}`;
    return baseURL;
  })();

  try {
    return await starting;
  } catch (e) {
    starting = null;
    throw e;
  }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 1000,
    minHeight: 600,
    title: "CFA Translate Studio",
    backgroundColor: "#fafafa",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(url);

  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 900,
          height: 1000,
          title: "PDF",
        },
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
  const template = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" }]
      : [{ label: "File", submenu: [{ role: "quit" }] }]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function stopDaemon() {
  if (!daemon) return;
  try {
    daemon.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  daemon = null;
  baseURL = null;
  starting = null;
}

app.whenReady().then(async () => {
  buildMenu();

  if (!tryBuildUi()) {
    dialog.showErrorBox(
      "Chưa build giao diện app",
      "Chạy từ thư mục repo:\n\n  pnpm install\n  pnpm build:ui\n  pnpm start\n"
    );
    app.quit();
    return;
  }

  try {
    const url = await startDaemon();
    createWindow(url);
  } catch (e) {
    dialog.showErrorBox(
      "Không khởi động được app",
      String(e) + "\n\nThử: pnpm install && pnpm build:ui && pnpm start"
    );
    stopDaemon();
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.isQuitting = true;
  stopDaemon();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopDaemon();
});

app.on("activate", async () => {
  if (win) return;
  if (!ensureUiBuilt()) return;
  try {
    const url = await startDaemon();
    createWindow(url);
  } catch {
    /* ignore */
  }
});
