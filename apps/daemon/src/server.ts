import express, { type Request, type Response, type NextFunction } from "express";
import {
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  renameSync,
} from "node:fs";
import { join, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  ADAPTERS,
  detectAgents,
  getAdapter,
  capabilitiesOf,
  listModelsForEngines,
  ENGINE_IDS,
  type EngineId,
} from "@cfa-translate/agent-adapters";
import {
  agentEventToChatSse,
  type AppConfig,
  type RepairRequest,
  type Volume,
} from "@cfa-translate/shared";
import {
  ENGINES,
  MODELS,
  POSTURES,
  loadCfg,
  saveCfg,
  modelsByEngine,
  applyConfigPatch,
} from "./config.js";
import { cliModelArg } from "@cfa-translate/shared";
import {
  ensureDirs,
  REPO_ROOT,
  resolveUiRoot,
  INPUT_DIR,
  PYTHON_DIR,
  pythonBin,
} from "./paths.js";
import { getReadingBookmark, saveReadingBookmark } from "./reading-progress.js";
import {
  attachRepairRun,
  createRepairRequest,
  finishRepairRequest,
  listRepairRequests,
  validateRepairRequestInput,
} from "./repair-requests.js";
import {
  createReaderAnnotation,
  deleteReaderAnnotation,
  listReaderAnnotations,
  validateReaderAnnotationInput,
  type ReaderAnnotation,
} from "./reader-annotations.js";
import {
  SelectionTranslationError,
  translateSelection,
  validateSelectionTranslationInput,
} from "./selection-translation.js";
import { execFile } from "node:child_process";
import {
  findVolume,
  extractPageText,
  loadEnginePref,
  loadRenderReportPage,
  loadVolumes,
  pdfPageCount,
  readJson,
  renderPagePng,
  resetStage,
  saveEnginePref,
  userDocumentTag,
  volumeToApi,
} from "./volumes.js";
import { chatContextSafe, type RunOpts } from "./prompts.js";
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
  beginBlockUpdate,
  endBlockUpdate,
  isVolumeBusy,
  isVolumeRunning,
  launchVolume,
  recoverInterruptedBlockUpdate,
  resetAutoResume,
  stopVolume,
} from "./runs.js";
import { createStatusVolumeCache } from "./status-cache.js";

const BLOCK_UPDATE_TIMEOUT_MS = 10 * 60_000;

function scanStatusVolumesInWorker(config: AppConfig): Promise<Volume[]> {
  const workerUrl = new URL(
    import.meta.url.endsWith(".ts") ? "./status-worker.ts" : "./status-worker.mjs",
    import.meta.url
  );
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { config } });
    let received = false;
    worker.once("message", (message: { volumes: Volume[] }) => {
      received = true;
      resolve(message.volumes);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!received) reject(new Error(`status worker exited with code ${code}`));
    });
  });
}

// "5-10, 12, 15" (SỐ TRANG người dùng, 1-based) -> mảng CHỈ SỐ 0-based, clamp
// trong [0, total). Dùng cho redo vision theo trang cụ thể.
function parsePageList(spec: unknown, total: number): number[] {
  if (typeof spec !== "string") return [];
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (a > b) [a, b] = [b, a];
      // Clamp TRƯỚC khi loop — "1-1000000000" sẽ khoá event loop; endpoint gần
      // Number.MAX_SAFE_INTEGER còn làm p++ đứng yên (vòng lặp vô hạn).
      if (a > total || b < 1) continue; // khoảng hoàn toàn ngoài phạm vi -> bỏ
      a = Math.max(1, a);
      b = Math.min(b, total);
      for (let p = a; p <= b; p++) out.add(p - 1);
    } else if (/^\d+$/.test(s)) {
      const i = parseInt(s, 10) - 1;
      if (i >= 0 && i < total) out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function createApp() {
  ensureDirs();
  const initialVolumeRecords = loadVolumes();
  for (const volume of initialVolumeRecords) {
    void recoverInterruptedBlockUpdate(volume);
  }
  const app = express();
  let CFG = loadCfg();
  const statusVolumes = createStatusVolumeCache(
    initialVolumeRecords.map((volume) =>
      volumeToApi(volume, CFG, isVolumeRunning(volume))
    ),
    scanStatusVolumesInWorker
  );

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

  // CLI/version detection is slow. Status always returns the latest cached value
  // and shares one background refresh for the 45-second cache window.
  type DetectedAgents = Awaited<ReturnType<typeof detectAgents>>;
  let agentsCache: { at: number; data: DetectedAgents } | null = null;
  let agentsInflight: Promise<DetectedAgents> | null = null;
  const AGENTS_TTL_MS = 45_000;

  function refreshAgents(force = false): Promise<DetectedAgents> {
    if (
      !force &&
      agentsCache &&
      Date.now() - agentsCache.at < AGENTS_TTL_MS
    ) {
      return Promise.resolve(agentsCache.data);
    }
    if (agentsInflight) return agentsInflight;
    agentsInflight = detectAgents()
      .then((agents) => {
        agentsCache = { at: Date.now(), data: agents };
        return agents;
      })
      .catch(() => agentsCache?.data || [])
      .finally(() => {
        agentsInflight = null;
      });
    return agentsInflight;
  }

  function getAgentsCached(): DetectedAgents {
    if (!agentsCache || Date.now() - agentsCache.at >= AGENTS_TTL_MS) {
      void refreshAgents();
    }
    return agentsCache?.data || [];
  }

  // Model discovery can invoke a CLI command (`grok models`). It is refreshed
  // only by the explicit /api/agents rescan endpoint, never by status polling.
  type DiscoveredMap = Awaited<ReturnType<typeof listModelsForEngines>>;
  let modelsCache: DiscoveredMap | null = null;
  let modelsInflight: Promise<DiscoveredMap> | null = null;

  function emptyDiscovered(): DiscoveredMap {
    return { claude: [], codex: [], grok: [] };
  }

  function getDiscoveredModelsCached(): DiscoveredMap {
    return modelsCache || emptyDiscovered();
  }

  function refreshDiscoveredModels(): Promise<DiscoveredMap> {
    if (modelsInflight) return modelsInflight;
    modelsInflight = listModelsForEngines()
      .then((data) => {
        modelsCache = data;
        return data;
      })
      .catch(() => modelsCache || emptyDiscovered())
      .finally(() => {
        modelsInflight = null;
      });
    return modelsInflight;
  }

  app.get("/api/agents", async (_req, res) => {
    // Explicit rescan path — refresh models too (Settings "Quét lại CLI")
    const [agents, discovered] = await Promise.all([
      refreshAgents(true),
      refreshDiscoveredModels(),
    ]);
    res.json({
      agents,
      capabilities: Object.fromEntries(
        ENGINE_IDS.map((id) => [id, capabilitiesOf(id)])
      ),
      models_discovered: discovered,
      models_by_engine: modelsByEngine(discovered),
    });
  });

  app.get("/api/status", (_req, res) => {
    // Hot path: return the last complete snapshot, then refresh in a worker.
    const discovered = getDiscoveredModelsCached();
    const agents = getAgentsCached();
    const volumes = statusVolumes.get();
    void statusVolumes.refresh(CFG);
    const done = volumes.filter((v) => v.stage === "done" || v.skip).length;
    const running = volumes.filter((v) => v.running).length;
    res.json({
      volumes,
      config: CFG,
      engines: ENGINES,
      /** @deprecated empty — use models_by_engine (default + discovered) */
      models: MODELS,
      models_by_engine: modelsByEngine(discovered),
      models_discovered: discovered,
      postures: POSTURES,
      done,
      total: volumes.length,
      running,
      batch: {
        active: BATCH.active,
        current: BATCH.current,
        queue: BATCH.queue,
        running: [...BATCH.running],
        limit: BATCH.limit,
      },
      agents,
    });
  });

  app.post("/api/config", (req, res) => {
    const body = req.body || {};
    // Clamp numeric fields then applyConfigPatch (engine-only → CLI default model).
    const patch: Record<string, unknown> = { ...body };
    if (
      typeof body.codex_batch === "number" &&
      (body.codex_batch < 5 || body.codex_batch > 200)
    ) {
      delete patch.codex_batch;
    }
    if (typeof body.agents === "number") {
      if (body.agents < 1 || body.agents > 10) delete patch.agents;
      else patch.agents = Math.floor(body.agents);
    }
    if (typeof body.posture === "string" && !POSTURES.includes(body.posture)) {
      delete patch.posture;
    }
    if (typeof body.engine === "string" && !ENGINES.includes(body.engine)) {
      delete patch.engine;
    }
    CFG = applyConfigPatch(CFG, patch);
    saveCfg(CFG);
    CFG = loadCfg();
    void statusVolumes.refresh(CFG, true);
    res.json({ ok: true, config: CFG });
  });

  app.post("/api/run", async (req, res) => {
    const vol = findVolume(String(req.body?.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    if (vol.skip) return res.status(400).json({ error: "volume này đánh skip" });
    // Cho phép chọn engine RIÊNG cho cuốn này lúc chạy. Engine gửi lên mà không
    // hợp lệ thì TỪ CHỐI (không âm thầm dùng engine cũ). Chỉ lưu làm mặc định
    // SAU KHI chạy thành công (tránh đổi hành vi batch khi lệnh chạy 409).
    const bodyEngine = req.body?.engine;
    if (
      bodyEngine != null &&
      (typeof bodyEngine !== "string" || !ENGINE_IDS.includes(bodyEngine as EngineId))
    ) {
      return res.status(400).json({ error: "engine không hợp lệ" });
    }
    const engine = typeof bodyEngine === "string" ? bodyEngine : undefined;

    // redo: chạy LẠI 1 stage (xoá output stage đó để pipeline làm lại). Với
    // 'vision' có thể chỉ định trang cụ thể + chạy only='vision' (chỉ soát lại
    // đúng trang đó, không dịch/apply lại cả cuốn).
    // Mọi engine (Claude/Codex/Grok) đều được: launchVolume dùng pipeline-runner
    // khi có runOpts — MCP batch prompt không hiểu stage redo. Pref engine
    // KHÔNG bị đổi sang Claude chỉ vì redo (chỉ lưu khi body gửi engine).
    let runOpts: RunOpts | undefined;
    const redo = req.body?.redo;
    if (redo && typeof redo === "object") {
      const stage = redo.stage;
      if (stage !== "translate" && stage !== "verify" && stage !== "vision") {
        return res.status(400).json({ error: "redo.stage không hợp lệ" });
      }
      // KHÔNG reset khi cuốn đang chạy/lưu block — resetStage xoá output, sẽ hỏng tiến trình
      // đang dở. Chặn TRƯỚC khi xoá (launchVolume cũng chặn nhưng quá muộn).
      if (isVolumeBusy(vol)) {
        return res.status(409).json({ error: "cuốn đang có tiến trình — không thể chạy lại" });
      }
      let pages: number[] | undefined;
      if (stage === "vision" && redo.pages != null && String(redo.pages).trim() !== "") {
        const totalPages = await pdfPageCount(vol.pdf);
        // Another request may have started while page count was loading.
        if (isVolumeBusy(vol)) {
          return res.status(409).json({ error: "cuốn đang có tiến trình — không thể chạy lại" });
        }
        pages = parsePageList(redo.pages, totalPages);
        // Người dùng CÓ nhập trang nhưng parse ra rỗng (gõ sai/ngoài phạm vi):
        // từ chối thay vì rơi xuống nhánh xoá TOÀN BỘ vision (mất mọi verdict).
        if (!pages.length) {
          return res.status(400).json({ error: "redo.pages không hợp lệ" });
        }
      }
      // Quyết định pipeline TRƯỚC khi xoá checkpoint (invariant: không wipe nếu
      // không launch được — launchVolume fail 409 sau reset là đã quá muộn nên
      // chặn running ở trên; engine invalid cũng đã chặn ở body parse).
      resetStage(vol.workdir, stage, pages);
      if (stage === "vision") {
        // vision:true — redo vision phải chạy được cả khi config tắt vision.
        // visPages — CHỈ re-render các trang này; thiếu nó, vis-pages sẽ thấy
        // mọi pair cũ hơn OUT (luôn vậy sau apply) và xoá TOÀN BỘ verdict.
        runOpts = {
          only: "vision",
          vision: true,
          redoStage: "vision",
          ...(pages ? { visPages: pages.join(",") } : {}),
        };
      } else {
        // translate/verify redo: object rỗng vẫn kích hoạt pipeline-runner
        // (shouldUsePipelineRunner) thay vì MCP batch — resume theo pending files.
        runOpts = { redoStage: stage };
      }
    }

    resetAutoResume(vol.tag); // chạy thủ công: cấp lại quota watchdog tự-chạy-tiếp
    const r = await launchVolume(vol, CFG, engine, runOpts);
    if (!r.ok) return res.status(409).json({ error: r.error });
    // Chỉ ghi pref khi user CHỌN engine trên request — không ép Claude vì redo.
    if (engine) saveEnginePref(vol.workdir, engine);
    void statusVolumes.refresh(CFG, true);
    res.json({
      ok: true,
      sid: r.sid,
      engine: engine || loadEnginePref(vol.workdir) || CFG.engine || "claude",
      redo: !!redo,
    });
  });

  // Chọn engine cho 1 cuốn mà KHÔNG chạy ngay (lưu pref để dùng khi chạy/batch).
  app.post("/api/volconfig", (req, res) => {
    const vol = findVolume(String(req.body?.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const engine = req.body?.engine;
    if (typeof engine !== "string" || !ENGINE_IDS.includes(engine as EngineId)) {
      return res.status(400).json({ error: "engine không hợp lệ" });
    }
    saveEnginePref(vol.workdir, engine);
    void statusVolumes.refresh(CFG, true);
    res.json({ ok: true, engine });
  });

  app.post("/api/stop", (req, res) => {
    const vol = findVolume(String(req.body?.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const ok = stopVolume(vol);
    if (ok) void statusVolumes.refresh(CFG, true);
    res.json({ ok });
  });

  app.post("/api/batch", (req, res) => {
    const action = req.body?.action;
    if (action === "start") {
      const n = Number(req.body?.limit);
      const limit = Number.isFinite(n) ? Math.floor(n) : 1; // batchStart clamp 1..8
      const ok = batchStart(CFG, limit);
      if (!ok) return res.status(409).json({ error: "batch đang chạy" });
      void statusVolumes.refresh(CFG, true);
      return res.json({ ok: true, queue: BATCH.queue, limit: BATCH.limit });
    }
    if (action === "stop") {
      batchStop();
      void statusVolumes.refresh(CFG, true);
      return res.json({ ok: true });
    }
    res.status(400).json({ error: "action không hợp lệ" });
  });

  // Báo cáo defect theo CỤM pattern + kênh sửa (text/code/policy) — chạy
  // python defect-report (nguồn sự thật duy nhất cho rule phân cụm; không port
  // sang TS để khỏi lệch). Gọi 1 lần khi mở màn chi tiết, không poll.
  app.get("/api/defects", (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    // execFile ASYNC — spawnSync ở đây sẽ khoá event loop tới 20s mỗi request
    // (fitz import chậm / máy bận), chặn cả /api/stop lẫn status polling.
    execFile(
      pythonBin(),
      [join(PYTHON_DIR, "agent_pipeline.py"), "defect-report", vol.workdir],
      { cwd: PYTHON_DIR, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          return res.status(500).json({ error: "defect-report failed" });
        }
        try {
          const lines = stdout.trim().split("\n");
          res.json(JSON.parse(lines[lines.length - 1]));
        } catch {
          res.status(500).json({ error: "defect-report: output không hợp lệ" });
        }
      }
    );
  });

  // Yêu cầu xử lý lại từ viewer được lưu độc lập với review_issues.json (file
  // review tự sinh và bị merge-vis ghi lại). Mỗi request luôn nhắm đúng 1 trang.
  app.get("/api/repair-requests", (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });

    // Hồi phục trạng thái sau khi daemon bị restart và bỏ lỡ child exit event.
    const meta = readJson(join(vol.workdir, "run.json"));
    const volumeRunning = isVolumeRunning(vol);
    for (const request of listRepairRequests(vol.workdir)) {
      if (request.status !== "running") continue;
      if (!request.run_sid) {
        // A daemon crash can happen between create and attach. Do not leave a
        // ghost request forever, but allow the synchronous launch path a small
        // grace window to finish its metadata write.
        const age = Date.now() - Date.parse(request.created_at);
        if (!volumeRunning && Number.isFinite(age) && age > 30_000) {
          finishRepairRequest(vol.workdir, request.id, "failed", "không ghi nhận được tiến trình xử lý");
        }
        continue;
      }
      if (meta?.sid !== request.run_sid) {
        if (!volumeRunning) {
          finishRepairRequest(vol.workdir, request.id, "failed", "tiến trình xử lý bị gián đoạn");
        }
        continue;
      }
      if (meta.mode === "exited") {
        const rc = typeof meta.rc === "number" ? meta.rc : null;
        finishRepairRequest(
          vol.workdir,
          request.id,
          rc === 0 ? "completed" : "failed",
          rc === 0 ? undefined : `tiến trình kết thúc với mã ${rc ?? "unknown"}`
        );
      } else if (!volumeRunning) {
        finishRepairRequest(vol.workdir, request.id, "failed", "tiến trình xử lý bị gián đoạn");
      }
    }
    res.json({ requests: listRepairRequests(vol.workdir).slice(0, 20) });
  });

  app.post("/api/repair-request", async (req, res) => {
    const vol = findVolume(String(req.body?.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    if (vol.skip) return res.status(400).json({ error: "volume này đánh skip" });
    if (!existsSync(vol.out)) {
      return res.status(409).json({ error: "chưa có bản dịch để xử lý lại" });
    }
    if (isVolumeBusy(vol)) {
      return res.status(409).json({ error: "cuốn đang có tiến trình — hãy gửi yêu cầu sau khi tiến trình dừng" });
    }

    const totalPages = await pdfPageCount(vol.pdf);
    if (isVolumeBusy(vol)) {
      return res.status(409).json({ error: "cuốn đang có tiến trình — hãy gửi yêu cầu sau khi tiến trình dừng" });
    }
    const parsed = validateRepairRequestInput(req.body, totalPages);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const bodyEngine = req.body?.engine;
    if (
      bodyEngine != null &&
      (typeof bodyEngine !== "string" || !ENGINE_IDS.includes(bodyEngine as EngineId))
    ) {
      return res.status(400).json({ error: "engine không hợp lệ" });
    }
    const engine = typeof bodyEngine === "string" ? bodyEngine : undefined;
    const now = new Date().toISOString();
    const request: RepairRequest = {
      id: randomUUID(),
      tag: vol.tag,
      page: parsed.value.page,
      kind: parsed.value.kind,
      note: parsed.value.note,
      status: "running",
      created_at: now,
      updated_at: now,
    };

    try {
      createRepairRequest(vol.workdir, request);
    } catch (error) {
      console.error("[repair-request] save failed", error);
      return res.status(500).json({ error: "không lưu được yêu cầu" });
    }

    const runOpts: RunOpts = {
      only: "repair",
      vision: true,
      visPages: String(parsed.value.page - 1),
      repairKind: parsed.value.kind,
      repairNote: parsed.value.note,
      repairRequestId: request.id,
    };
    resetAutoResume(vol.tag);
    const launched = await launchVolume(vol, CFG, engine, runOpts);
    if (!launched.ok) {
      const failed = finishRepairRequest(vol.workdir, request.id, "failed", launched.error);
      return res.status(409).json({ error: launched.error, request: failed || request });
    }
    const saved = attachRepairRun(vol.workdir, request.id, launched.sid) || request;
    if (engine) saveEnginePref(vol.workdir, engine);
    void statusVolumes.refresh(CFG, true);
    res.json({
      ok: true,
      sid: launched.sid,
      engine: engine || loadEnginePref(vol.workdir) || CFG.engine || "claude",
      request: saved,
    });
  });

  app.get("/api/log", (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const logPath = join(vol.workdir, "run.log");
    let lines: string[] = [];
    if (existsSync(logPath)) {
      // Read only a bounded tail — run.log grows unbounded over a long
      // translation, and this endpoint is polled every 2.5s per active row, so
      // reading the whole file would repeatedly block the daemon's event loop.
      const MAX = 64 * 1024;
      const size = statSync(logPath).size;
      const start = Math.max(0, size - MAX);
      const len = size - start;
      let text = "";
      if (len > 0) {
        const buf = Buffer.allocUnsafe(len);
        const fd = openSync(logPath, "r");
        try {
          readSync(fd, buf, 0, len, start);
        } finally {
          closeSync(fd);
        }
        text = buf.toString("utf8");
        // Drop the partial first line when we started mid-file.
        if (start > 0) {
          const nl = text.indexOf("\n");
          if (nl >= 0) text = text.slice(nl + 1);
        }
      }
      lines = text.split("\n").slice(-200);
    }
    res.json({ tag: vol.tag, lines });
  });

  // Block report produced by Python apply. This is deliberately read-only;
  // edits go through /api/blocks/update so marker validation and atomic PDF
  // rendering remain in one trusted path.
  app.get("/api/blocks", (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const page = Number.parseInt(String(req.query.page ?? "0"), 10);
    if (!Number.isInteger(page) || page < 0) {
      return res.status(400).json({ error: "page không hợp lệ" });
    }
    const report = loadRenderReportPage(vol.workdir, page);
    if (!report) {
      return res.status(404).json({ error: "chưa có render report; hãy chạy apply trước" });
    }
    res.json({
      tag: vol.tag,
      page,
      ...report,
    });
  });

  app.get("/api/preflight", (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const report = readJson(join(vol.workdir, "preflight.json"));
    if (!report) return res.status(404).json({ error: "chưa chạy preflight" });
    res.json(report);
  });

  // Selectable text layer for the raster reader. Keep the public page number
  // 1-based; only this boundary converts to PyMuPDF's 0-based index.
  app.get("/api/page-text", async (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const side = String(req.query.side || "source");
    if (side !== "source" && side !== "translated") {
      return res.status(400).json({ error: "side không hợp lệ" });
    }
    const path = side === "translated" ? vol.out : vol.pdf;
    if (!existsSync(path)) return res.status(404).json({ error: "file chưa có" });
    const page = Number(req.query.page);
    // Source/output are page-for-page; use one cached source count for both.
    const total = await pdfPageCount(vol.pdf);
    if (!Number.isSafeInteger(page) || page < 1 || page > total) {
      return res.status(400).json({ error: `trang phải từ 1 đến ${total}` });
    }
    const textPage = await extractPageText(path, page - 1);
    if (!textPage) return res.status(500).json({ error: "không đọc được lớp chữ PDF" });
    res.json({ tag: vol.tag, page, side, ...textPage });
  });

  app.post("/api/translate-selection", async (req, res) => {
    const parsed = validateSelectionTranslationInput(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    try {
      const result = await translateSelection(parsed.value, { timeoutMs: 15_000 });
      return res.json(result);
    } catch (error) {
      if (error instanceof SelectionTranslationError) {
        const status = error.code === "timeout" ? 504 : 502;
        return res.status(status).json({ error: error.message });
      }
      console.error("[translate-selection] failed", error);
      return res.status(502).json({ error: "Không dịch được đoạn văn đã chọn" });
    }
  });

  app.get("/api/reader-annotations", async (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const page = Number(req.query.page);
    const total = await pdfPageCount(vol.pdf);
    if (!Number.isSafeInteger(page) || page < 1 || page > total) {
      return res.status(400).json({ error: `trang phải từ 1 đến ${total}` });
    }
    res.json({
      annotations: listReaderAnnotations(vol.workdir)
        .filter((annotation) => annotation.tag === vol.tag && annotation.page === page)
        .slice(0, 200),
    });
  });

  app.post("/api/reader-annotations", async (req, res) => {
    const vol = findVolume(String(req.body?.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const parsed = validateReaderAnnotationInput(req.body, await pdfPageCount(vol.pdf));
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (parsed.value.side === "translated" && !existsSync(vol.out)) {
      return res.status(409).json({ error: "chưa có bản dịch để ghi chú" });
    }
    const now = new Date().toISOString();
    const annotation: ReaderAnnotation = {
      id: randomUUID(),
      tag: vol.tag,
      ...parsed.value,
      created_at: now,
      updated_at: now,
    };
    createReaderAnnotation(vol.workdir, annotation);
    res.json({ ok: true, annotation });
  });

  app.post("/api/reader-annotations/delete", (req, res) => {
    const vol = findVolume(String(req.body?.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    res.json({ ok: deleteReaderAnnotation(vol.workdir, id) });
  });

  app.post("/api/blocks/update", (req, res) => {
    const vol = findVolume(String(req.body?.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const id = String(req.body?.id || "").trim();
    const translation = typeof req.body?.translation === "string"
      ? req.body.translation.trim()
      : "";
    if (!/^s\d+$/.test(id) || !translation || translation.length > 50_000) {
      return res.status(400).json({ error: "block hoặc bản dịch không hợp lệ" });
    }
    if (!beginBlockUpdate(vol)) {
      return res.status(409).json({ error: "cuốn đang chạy hoặc đang lưu block khác" });
    }
    try {
      execFile(
        pythonBin(),
        [
          join(PYTHON_DIR, "agent_pipeline.py"),
          "block-update",
          vol.pdf,
          vol.workdir,
          vol.out,
          id,
          translation,
        ],
        { cwd: PYTHON_DIR, timeout: BLOCK_UPDATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            void recoverInterruptedBlockUpdate(vol).finally(() => {
              endBlockUpdate(vol.tag);
            });
            const childError = err as Error & { killed?: boolean; code?: string | number | null };
            const timedOut = childError.killed === true &&
              childError.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
            if (timedOut) {
              return res.status(504).json({
                error: "render block quá 10 phút; hãy tải lại tài liệu trước khi thử lại",
              });
            }
            const detail = String(stderr || stdout || err.message).trim().split("\n").pop();
            return res.status(400).json({ error: detail || "block update failed" });
          }
          endBlockUpdate(vol.tag);
          try {
            const lines = String(stdout || "").trim().split("\n");
            const result = JSON.parse(lines[lines.length - 1]);
            return res.json({ ok: true, block: result.segment, translation: result.translation });
          } catch {
            return res.status(500).json({ error: "block update: output không hợp lệ" });
          }
        }
      );
    } catch (error) {
      endBlockUpdate(vol.tag);
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: `không khởi động được render block: ${message}` });
    }
  });

  app.get("/api/pageinfo", async (req, res) => {
    const vol = findVolume(String(req.query.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const pages = await pdfPageCount(vol.pdf);
    const savedPage = getReadingBookmark(vol.tag);
    res.json({
      tag: vol.tag,
      display: vol.display,
      pages,
      out_exists: existsSync(vol.out),
      bookmark_page: savedPage && savedPage <= pages ? savedPage : null,
    });
  });

  app.post("/api/reading-bookmark", async (req, res) => {
    const vol = findVolume(String(req.body?.tag || ""));
    if (!vol) return res.status(404).json({ error: "tag không tồn tại" });
    const page = req.body?.page;
    const pages = await pdfPageCount(vol.pdf);
    if (!Number.isSafeInteger(page) || page < 1 || page > pages) {
      return res.status(400).json({ error: `trang phải từ 1 đến ${pages}` });
    }
    try {
      saveReadingBookmark(vol.tag, page);
      res.json({ ok: true, tag: vol.tag, bookmark_page: page });
    } catch (error) {
      console.error("[reading-bookmark] save failed", error);
      res.status(500).json({ error: "không lưu được dấu đọc" });
    }
  });

  app.get("/api/page", async (req, res) => {
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
    const priority = which !== "out" && page === 0 && dpi <= 90
      ? "thumbnail"
      : "interactive";
    const png = await renderPagePng(path, page, dpi, priority);
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

  // Raw PDF upload → immutable content-addressed record in input/.
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
    const sourceSha256 = createHash("sha256").update(body).digest("hex");
    const stem = basename(name, ".pdf") || "document";
    const storedName = `${stem}.${sourceSha256.slice(0, 12)}.pdf`;
    const storedPath = join(INPUT_DIR, storedName);
    if (!existsSync(storedPath)) {
      const tempPath = join(INPUT_DIR, `.upload-${randomUUID()}.tmp`);
      writeFileSync(tempPath, body);
      renameSync(tempPath, storedPath);
    }
    const meta = {
      version: 1,
      document_id: sourceSha256,
      source_sha256: sourceSha256,
      original_name: name,
      stored_name: storedName,
    };
    writeFileSync(storedPath + ".cfa.json", JSON.stringify(meta, null, 1), "utf8");
    void statusVolumes.refresh(CFG, true);
    res.json({
      ok: true,
      name,
      stored_name: storedName,
      document_id: sourceSha256,
      tag: userDocumentTag(name, sourceSha256),
    });
    // Import creates the single canonical cover in the low-priority queue.
    void renderPagePng(storedPath, 0, 90, "thumbnail").catch(() => {});
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

    // No silent fall-through to Claude adapter when engine id is wrong.
    const adapter = getAdapter(engine);
    if (!adapter) {
      return res.status(400).json({ error: `engine không hợp lệ: ${engine}` });
    }
    // Model only if valid for this engine (never pass sonnet/opus to codex/grok).
    const model = cliModelArg(engine, CFG.model);

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
            readOnly: true,
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
