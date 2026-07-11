import express, { type Request, type Response, type NextFunction } from "express";
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ADAPTERS,
  detectAgents,
  getAdapter,
  capabilitiesOf,
  ENGINE_IDS,
  type EngineId,
} from "@cfa-translate/agent-adapters";
import { agentEventToChatSse } from "@cfa-translate/shared";
import {
  ENGINES,
  MODELS,
  POSTURES,
  loadCfg,
  saveCfg,
} from "./config.js";
import {
  ensureDirs,
  REPO_ROOT,
  resolveUiRoot,
  INPUT_DIR,
} from "./paths.js";
import {
  findVolume,
  loadVolumes,
  pdfPageCount,
  renderPagePng,
  volumeToApi,
} from "./volumes.js";
import { chatContextSafe } from "./prompts.js";
import {
  chatDbReady,
  listConversations,
  createConversation,
  deleteConversation,
  getConversation,
  saveConversation,
} from "./chat-db.js";
import {
  BATCH,
  batchStart,
  batchStop,
  isVolumeRunning,
  launchVolume,
  stopVolume,
} from "./runs.js";

export function createApp() {
  ensureDirs();
  const app = express();
  let CFG = loadCfg();

  app.use(express.json({ limit: "2mb" }));

  // CSRF: browser Origin must be localhost
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return next();
    }
    const origin = req.headers.origin;
    if (!origin) return next();
    try {
      const host = new URL(origin).hostname;
      if (["127.0.0.1", "localhost", "::1"].includes(host)) return next();
    } catch {
      /* fallthrough */
    }
    return res.status(403).json({ error: "cross-origin bị chặn" });
  });

  app.get("/api/ping", (_req, res) => {
    res.json({ ok: true, service: "cfa-translate-daemon" });
  });

  app.get("/api/agents", async (_req, res) => {
    const agents = await detectAgents();
    res.json({
      agents,
      capabilities: Object.fromEntries(
        ENGINE_IDS.map((id) => [id, capabilitiesOf(id)])
      ),
    });
  });

  app.get("/api/status", async (_req, res) => {
    const agents = await detectAgents();
    const volumes = loadVolumes().map((v) =>
      volumeToApi(v, CFG, isVolumeRunning(v))
    );
    const done = volumes.filter((v) => v.stage === "done" || v.skip).length;
    const running = volumes.filter((v) => v.running).length;
    res.json({
      volumes,
      config: CFG,
      engines: ENGINES,
      models: MODELS,
      postures: POSTURES,
      done,
      total: volumes.length,
      running,
      batch: {
        active: BATCH.active,
        current: BATCH.current,
        queue: BATCH.queue,
      },
      agents,
    });
  });

  app.post("/api/config", (req, res) => {
    const body = req.body || {};
    if (ENGINES.includes(body.engine)) CFG.engine = body.engine;
    if (MODELS.includes(body.model)) CFG.model = body.model;
    if (POSTURES.includes(body.posture)) CFG.posture = body.posture;
    if ("vision" in body) CFG.vision = !!body.vision;
    if (
      typeof body.codex_batch === "number" &&
      body.codex_batch >= 5 &&
      body.codex_batch <= 200
    ) {
      CFG.codex_batch = body.codex_batch;
    }
    if (typeof body.budget === "number" && body.budget >= 0) {
      CFG.budget = body.budget;
    }
    if (typeof body.budget_warn === "number") {
      CFG.budget_warn = body.budget_warn;
    }
    saveCfg(CFG);
    CFG = loadCfg();
    res.json({ ok: true, config: CFG });
  });

  app.post("/api/run", (req, res) => {
    const vol = findVolume(String(req.body?.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    if (vol.skip) return res.status(400).json({ error: "volume này đánh skip" });
    const r = launchVolume(vol, CFG);
    if (!r.ok) return res.status(409).json({ error: r.error });
    res.json({ ok: true, sid: r.sid });
  });

  app.post("/api/stop", (req, res) => {
    const vol = findVolume(String(req.body?.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    res.json({ ok: stopVolume(vol) });
  });

  app.post("/api/batch", (req, res) => {
    const action = req.body?.action;
    if (action === "start") {
      batchStart(CFG);
      return res.json({ ok: true, queue: BATCH.queue });
    }
    if (action === "stop") {
      batchStop();
      return res.json({ ok: true });
    }
    res.status(400).json({ error: "action không hợp lệ" });
  });

  app.get("/api/log", (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const logPath = join(vol.workdir, "run.log");
    let lines: string[] = [];
    if (existsSync(logPath)) {
      const text = readFileSync(logPath, "utf8");
      lines = text.split("\n").slice(-200);
    }
    res.json({ tag: vol.tag, lines });
  });

  app.get("/api/pageinfo", (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const pages = pdfPageCount(vol.pdf);
    res.json({
      tag: vol.tag,
      display: vol.display,
      pages,
      out_exists: existsSync(vol.out),
    });
  });

  app.get("/api/page", (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const which = String(req.query.which || "source");
    const path = which === "out" ? vol.out : vol.pdf;
    if (!existsSync(path)) return res.status(404).json({ error: "file chưa có" });
    const page = parseInt(String(req.query.page || "0"), 10) || 0;
    const dpi = Math.max(
      60,
      Math.min(220, parseInt(String(req.query.dpi || "150"), 10) || 150)
    );
    const png = renderPagePng(path, page, dpi);
    if (!png) return res.status(500).json({ error: "render failed" });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(png);
  });

  app.get("/api/file", (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const kind = String(req.query.kind || "out");
    const path = kind === "out" ? vol.out : vol.pdf;
    if (!existsSync(path)) return res.status(404).json({ error: "file chưa có" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${basename(path)}"`
    );
    createReadStream(path).pipe(res);
  });

  // Raw PDF upload → input/
  app.post("/api/upload", express.raw({ type: "*/*", limit: "400mb" }), (req, res) => {
    const name = basename(String(req.query.name || "")).trim();
    if (!name.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ error: "chỉ nhận file .pdf" });
    }
    const body = req.body as Buffer;
    if (!body || !body.length) {
      return res.status(400).json({ error: "file rỗng" });
    }
    mkdirSync(INPUT_DIR, { recursive: true });
    writeFileSync(join(INPUT_DIR, name), body);
    res.json({ ok: true, name });
  });

  // ── Per-document chat conversations (SQLite-persisted) ──────────────────
  // A document tag is the "project"; each can hold many named conversations.
  app.get("/api/conversations", (req, res) => {
    const tag = String(req.query.tag || "").trim();
    if (!tag) return res.status(400).json({ error: "thiếu tag" });
    res.json({ persist: chatDbReady(), conversations: listConversations(tag) });
  });

  app.post("/api/conversations", (req, res) => {
    const tag = String(req.body?.tag || "").trim();
    if (!tag) return res.status(400).json({ error: "thiếu tag" });
    if (!chatDbReady()) return res.status(503).json({ error: "SQLite không khả dụng" });
    const title = req.body?.title ? String(req.body.title).slice(0, 120) : null;
    const engine = req.body?.engine ? String(req.body.engine) : null;
    res.json(createConversation(tag, title, engine));
  });

  app.get("/api/conversation", (req, res) => {
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "thiếu id" });
    const data = getConversation(id);
    if (!data.conversation) return res.status(404).json({ error: "không tìm thấy hội thoại" });
    res.json(data);
  });

  app.post("/api/conversation/save", (req, res) => {
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ error: "thiếu id" });
    const rawMsgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages = rawMsgs.map((m: Record<string, unknown>) => ({
      id: m.id ? String(m.id) : undefined,
      role: String(m.role || "assistant"),
      text: String(m.text ?? ""),
      engine: m.engine ? String(m.engine) : null,
    }));
    const ok = saveConversation(id, {
      title: req.body?.title != null ? String(req.body.title).slice(0, 120) : undefined,
      engine: req.body?.engine != null ? String(req.body.engine) : undefined,
      messages,
      sessions:
        req.body?.sessions && typeof req.body.sessions === "object"
          ? (req.body.sessions as Record<string, string>)
          : undefined,
    });
    if (!ok) return res.status(404).json({ error: "không lưu được (hội thoại không tồn tại?)" });
    res.json({ ok: true });
  });

  app.post("/api/conversation/delete", (req, res) => {
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ error: "thiếu id" });
    res.json({ ok: deleteConversation(id) });
  });

  /**
   * Headless chat turn over SSE.
   *
   * Open-design patterns ported here:
   *  - SSE comment heartbeats so proxies don't drop long tool runs
   *  - resume_failed auto-retry: clear stale CLI session, reseed document
   *    context, spawn once more (user never sees a dead-session error)
   *  - model from app config when the adapter supports it
   */
  app.post("/api/chat", async (req, res) => {
    const tag = String(req.body?.tag || "").trim();
    const engine = (
      ENGINE_IDS.includes(req.body?.engine) ? req.body.engine : "claude"
    ) as EngineId;
    const message = String(req.body?.message || "").trim();
    let session = (req.body?.session as string | null) || null;
    const vol = findVolume(tag);
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    if (!message) return res.status(400).json({ error: "message rỗng" });

    const adapter = getAdapter(engine) || ADAPTERS.claude;
    const model =
      engine === "claude" && typeof CFG.model === "string" ? CFG.model : undefined;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "close");
    res.flushHeaders?.();

    const sse = (obj: unknown) => {
      try {
        res.write("data: " + JSON.stringify(obj) + "\n\n");
        return true;
      } catch {
        return false;
      }
    };

    // Keepalive comments (open-design SSE). Browsers ignore `:` lines; they
    // stop intermediate proxies from idle-closing a multi-minute tool run.
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* connection already closed */
      }
    }, 15_000);

    const ac = new AbortController();
    // Abort only when the RESPONSE connection closes (client actually
    // disconnected). Do NOT use req "close": Express fully consumes the JSON
    // request body, and the request stream then emits "close" within a few ms —
    // wiring abort to that killed the CLI child before it produced any output
    // (every engine appeared to "not reply"). The response stays open until we
    // res.end(), so res "close" is the true client-gone signal.
    res.on("close", () => ac.abort());
    let gotSession = session;
    let clientGone = false;

    try {
      // At most two attempts: original (maybe resume) + one fresh reseed.
      for (let attempt = 0; attempt < 2; attempt++) {
        const isResume = !!session && attempt === 0;
        const prompt = isResume
          ? message
          : chatContextSafe(vol) + "\n\nNGƯỜI DÙNG: " + message;
        if (attempt === 0 && !isResume) {
          // first turn — session will be minted by the adapter
        }
        if (attempt === 1) {
          session = null;
          gotSession = null;
          if (!sse({
            type: "info",
            text: "Phiên CLI cũ không còn — đang mở phiên mới và gửi lại ngữ cảnh tài liệu…",
          })) {
            clientGone = true;
            break;
          }
        }

        const runId = randomUUID();
        let resumeFailed = false;
        let sawDone = false;

        try {
          for await (const ev of adapter.chat({
            runId,
            cwd: REPO_ROOT,
            prompt,
            session,
            model,
            timeoutMs: 300_000,
            signal: ac.signal,
          })) {
            if (ac.signal.aborted) {
              clientGone = true;
              break;
            }
            if (ev.type === "session") {
              gotSession = ev.sessionId;
              continue;
            }
            if (ev.type === "error" && ev.code === "resume_failed") {
              resumeFailed = true;
              // Drain is automatic when the async iterator ends after done.
              continue;
            }
            if (ev.type === "done") {
              sawDone = true;
              if (resumeFailed && attempt === 0 && isResume && !ac.signal.aborted) {
                // Retry loop; don't send done yet.
                break;
              }
              sse({ type: "done", session: gotSession });
              break;
            }
            const mapped = agentEventToChatSse(ev);
            if (mapped && !sse(mapped)) {
              clientGone = true;
              break;
            }
          }
        } catch (e) {
          if (!resumeFailed) {
            sse({
              type: "error",
              text: e instanceof Error ? e.message : String(e),
            });
            sse({ type: "done", session: gotSession });
          }
          break;
        }

        if (clientGone || ac.signal.aborted) break;

        if (resumeFailed && attempt === 0 && isResume) {
          continue; // second attempt with full context
        }

        if (!sawDone && !resumeFailed) {
          // Iterator ended without an explicit done (rare) — close cleanly.
          sse({ type: "done", session: gotSession });
        }
        break;
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  // Static UI (prod)
  const ui = resolveUiRoot();
  if (ui) {
    app.use(express.static(ui, { extensions: ["html"] }));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      const index = join(ui, "index.html");
      if (existsSync(index)) return res.sendFile(index);
      next();
    });
  }

  return app;
}
