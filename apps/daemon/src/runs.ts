import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { getAdapter, ENGINE_IDS, type EngineId } from "@cfa-translate/agent-adapters";
import type { AppConfig } from "@cfa-translate/shared";
import { cliModelArg, normalizeModel } from "@cfa-translate/shared";
import {
  buildMcpBatchPrompt,
  type RunOpts,
} from "./prompts.js";
import { PYTHON_DIR, REPO_ROOT, RUNNER_PATH, pythonBin } from "./paths.js";
import { finishRepairRequest } from "./repair-requests.js";
import {
  codexDone,
  effectiveStage,
  findVolume,
  loadEnginePref,
  loadRunMeta,
  loadVolumes,
  pidAlive,
  pythonStatus,
  saveRunMeta,
  type VolumeRec,
} from "./volumes.js";

/**
 * Thứ tự engine thống nhất mọi entry point (run / redo / batch / chat nếu dùng):
 *   body override → pref.json cuốn → config global → "claude"
 * Pref/global không hợp lệ bị bỏ (không để getAdapter fail).
 */
export function resolveEngine(
  override: string | undefined | null,
  pref: string | undefined | null,
  globalEngine: string | undefined | null
): EngineId {
  const pick = (v: string | undefined | null): EngineId | undefined =>
    v && ENGINE_IDS.includes(v as EngineId) ? (v as EngineId) : undefined;
  return pick(override) || pick(pref) || pick(globalEngine) || "claude";
}

/**
 * Stage redo (translate/verify/vision) và stage=review ("Chạy để sửa") luôn đi
 * pipeline-runner — Codex/Grok full-run dùng MCP batch (không có autoFixText).
 * runOpts != null (kể cả {}) → runner. forceRunner=true khi stage=review.
 */
export function shouldUsePipelineRunner(
  engine: EngineId,
  runOpts?: RunOpts | null,
  forceRunner = false
): boolean {
  if (forceRunner) return true;
  if (runOpts != null) return true; // mọi stage redo / only=vision / review-fix
  return engine === "claude";
}

/** stage=review → phải runner (autoFixText), mọi engine. */
export function needsReviewFixRunner(workdir: string): boolean {
  try {
    return pythonStatus(workdir).stage === "review";
  } catch {
    return false;
  }
}

export interface RunInfo {
  proc: ChildProcess | null;
  sid: string;
  mode: string;
  pid?: number;
  engine?: string;
}

const RUNS = new Map<string, RunInfo>();
const starting = new Set<string>();

const TRANSLATION_PROMPT_VERSION = "cfa-translate-v3";

export interface ArtifactPrepareResult {
  invalidation: "source" | "translation" | null;
  removed: string[];
  source_sha256: string;
}

/** Run the Python provenance gate before looking at resumable stage state. */
export function prepareVolumeArtifacts(
  vol: VolumeRec,
  context?: {
    target_language: string;
    translator: EngineId;
    model: string;
    prompt_version: string;
    profile?: string;
  }
): { ok: true; result: ArtifactPrepareResult } | { ok: false; error: string } {
  const r = spawnSync(
    pythonBin(),
    [
      join(PYTHON_DIR, "agent_pipeline.py"),
      "prepare",
      vol.pdf,
      vol.workdir,
      JSON.stringify(context ?? null),
    ],
    {
      cwd: PYTHON_DIR,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  if (r.status !== 0) {
    return {
      ok: false,
      error: (r.stderr || r.stdout || `prepare rc=${r.status}`).trim(),
    };
  }
  const lines = String(r.stdout || "").trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ArtifactPrepareResult;
      if (typeof parsed.source_sha256 === "string") {
        return { ok: true, result: parsed };
      }
    } catch {
      /* skip non-JSON progress lines */
    }
  }
  return { ok: false, error: "prepare không trả artifact manifest hợp lệ" };
}

// Watchdog "thoát non": CLI headless đôi khi gọi Workflow (chạy nền) rồi KẾT
// THÚC LƯỢT ("đang chờ workflow...") -> process thoát rc=0, workflow bị giết
// giữa chừng dù pipeline chưa xong. Checkpoint theo file nên chạy lại là resume
// đúng chỗ — tự relaunch tối đa AUTO_RESUME_MAX lần; đặt lại đếm khi user bấm
// Chạy thủ công (resetAutoResume từ /api/run).
const AUTO_RESUME_MAX = 3;
const autoResume = new Map<string, number>();
const autoResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function resetAutoResume(tag: string) {
  autoResume.delete(tag);
}

export const BATCH = {
  active: false,
  stop: false,
  current: null as string | null,
  queue: [] as string[],
  running: new Set<string>(),
  limit: 1,
  // Tăng mỗi lần start/stop. runBatch bám theo gen của nó — stop→start nhanh sẽ
  // đổi gen nên vòng cũ (đang chờ sleep) tự thoát, không chạy song song với vòng
  // mới trên cùng state.
  gen: 0,
};

export function isVolumeRunning(vol: VolumeRec): boolean {
  const r = RUNS.get(vol.tag);
  if (r?.proc && r.proc.exitCode == null && !r.proc.killed) return true;
  const meta = loadRunMeta(vol.workdir);
  return !!(meta && meta.mode === "running" && pidAlive(meta.pid));
}

export function launchVolume(
  vol: VolumeRec,
  cfg: AppConfig,
  engineOverride?: string,
  runOpts?: RunOpts
): { ok: true; sid: string } | { ok: false; error: string } {
  if (vol.skip) return { ok: false, error: "volume này đánh skip" };
  if (starting.has(vol.tag) || isVolumeRunning(vol)) {
    return { ok: false, error: "đang chạy" };
  }
  starting.add(vol.tag);

  // Ưu tiên: override lúc gọi > pref cuốn > global (resolveEngine).
  const engine = resolveEngine(
    engineOverride,
    loadEnginePref(vol.workdir),
    cfg.engine
  );
  const adapter = getAdapter(engine);
  if (!adapter) {
    starting.delete(vol.tag);
    return { ok: false, error: `engine không hợp lệ: ${engine}` };
  }

  const sid = randomUUID();
  let cmd: string[];
  // Model snapped to selected engine — never pass Claude sonnet/opus to codex/grok.
  const modelForEngine = normalizeModel(engine, cfg.model);
  const modelCli = cliModelArg(engine, modelForEngine);

  // Validate source provenance before trusting stage=review/done. Source-only
  // prepare preserves the translation context until we know this run actually
  // translates (verify/vision/fix may use another reviewing CLI).
  const sourcePrepared = prepareVolumeArtifacts(vol);
  if (!sourcePrepared.ok) {
    starting.delete(vol.tag);
    return { ok: false, error: `artifact preflight: ${sourcePrepared.error}` };
  }

  // "Chạy để sửa" (stage=review) gửi plain runVolume without runOpts — still
  // must use pipeline-runner so autoFixText runs for codex/grok (MCP batch
  // is translate-only and would skip the fix loop).
  let effectiveOpts = runOpts;
  const reviewFix = needsReviewFixRunner(vol.workdir);
  if (reviewFix && (effectiveOpts == null)) {
    effectiveOpts = {}; // truthy runOpts → shouldUsePipelineRunner
  }

  const translates =
    !reviewFix &&
    (effectiveOpts == null || effectiveOpts.redoStage === "translate");
  let contextPrepared: ArtifactPrepareResult | null = null;
  if (translates) {
    const prepared = prepareVolumeArtifacts(vol, {
      target_language: "vi",
      translator: engine,
      model: modelForEngine || "default",
      prompt_version: TRANSLATION_PROMPT_VERSION,
      profile: process.env.CFA_PDF_PROFILE || "native",
    });
    if (!prepared.ok) {
      starting.delete(vol.tag);
      return { ok: false, error: `translation cache preflight: ${prepared.error}` };
    }
    contextPrepared = prepared.result;
  }

  if (shouldUsePipelineRunner(engine, effectiveOpts, reviewFix)) {
    // Orchestration ở RUNNER (node) — agent chỉ dịch/soát từng đơn vị (file I/O).
    // engine truyền vào runner để unit call dùng đúng CLI (claude/codex/grok).
    cmd = [
      process.execPath,
      RUNNER_PATH,
      JSON.stringify({
        pdf: vol.pdf,
        workdir: vol.workdir,
        out: vol.out,
        tool: PYTHON_DIR,
        python: pythonBin(),
        engine,
        model: modelForEngine,
        posture: cfg.posture,
        vision: !!cfg.vision,
        concurrency: cfg.agents,
        ...(effectiveOpts || {}),
      }),
    ];
  } else {
    const prompt = buildMcpBatchPrompt(vol, cfg.codex_batch ?? 25);
    cmd = adapter.buildPipelineCmd({
      runId: sid,
      cwd: REPO_ROOT,
      workdir: vol.workdir,
      prompt,
      model: modelCli,
      posture: cfg.posture,
      sessionId: sid,
    });
  }

  mkdirSync(vol.workdir, { recursive: true });
  const logPath = join(vol.workdir, "run.log");
  const header =
    `\n===== RUN ${new Date().toISOString()} engine=${engine} model=${cfg.model} ` +
    `posture=${cfg.posture} vision=${cfg.vision} sid=${sid} =====\n` +
    `[artifacts] source=${sourcePrepared.result.source_sha256.slice(0, 12)} ` +
    `invalidation=${contextPrepared?.invalidation || sourcePrepared.result.invalidation || "none"}\n`;

  let fd: number;
  try {
    fd = openSync(logPath, "a");
    writeSync(fd, header);
  } catch (e) {
    starting.delete(vol.tag);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  let proc: ChildProcess;
  try {
    proc = spawn(cmd[0], cmd.slice(1), {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", fd, fd],
      detached: true,
    });
  } catch (e) {
    closeSync(fd);
    starting.delete(vol.tag);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  closeSync(fd);

  const meta = {
    pid: proc.pid,
    sid,
    log: logPath,
    started: Date.now() / 1000,
    mode: "running",
    model: cfg.model,
    engine,
  };
  RUNS.set(vol.tag, { proc, sid, mode: "running", pid: proc.pid, engine });
  // Clear `starting` and attach lifecycle listeners BEFORE the (best-effort)
  // meta write — so a failing saveRunMeta can't leak `starting`, skip the
  // exit/error listeners, or throw out of launchVolume (which would reject the
  // batch scheduler's promise and wedge BATCH.active).
  starting.delete(vol.tag);

  proc.on("exit", (code) => {
    const m = loadRunMeta(vol.workdir) || {};
    saveRunMeta(vol.workdir, {
      ...m,
      mode: "exited",
      rc: code,
      ended: Date.now() / 1000,
    });
    const r = RUNS.get(vol.tag);
    if (r?.proc === proc) {
      r.proc = null;
      r.mode = "exited";
    }
    if (runOpts?.repairRequestId) {
      finishRepairRequest(
        vol.workdir,
        runOpts.repairRequestId,
        code === 0 ? "completed" : "failed",
        code === 0 ? undefined : `tiến trình kết thúc với mã ${code ?? "unknown"}`
      );
    }
    maybeAutoResume(vol, cfg, engine, runOpts, code, logPath);
  });

  // spawn() reports a missing binary (ENOENT) via an async "error" event, not
  // by throwing — the try/catch above cannot see it. Without this listener an
  // unavailable CLI would raise an unhandled error and crash the daemon after
  // the run was already recorded as "running".
  proc.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const efd = openSync(logPath, "a");
      writeSync(efd, `\n[spawn error] ${msg}\n`);
      closeSync(efd);
    } catch {
      /* ignore */
    }
    const m = loadRunMeta(vol.workdir) || {};
    saveRunMeta(vol.workdir, {
      ...m,
      mode: "exited",
      rc: -1,
      error: msg,
      ended: Date.now() / 1000,
    });
    const r = RUNS.get(vol.tag);
    if (r?.proc === proc) {
      r.proc = null;
      r.mode = "error";
    }
    if (runOpts?.repairRequestId) {
      finishRepairRequest(vol.workdir, runOpts.repairRequestId, "failed", msg);
    }
  });

  try {
    saveRunMeta(vol.workdir, meta);
  } catch {
    /* meta write best-effort — status recomputes from files; the exit handler
       re-writes run.json on completion. */
  }
  return { ok: true, sid };
}

/**
 * Thoát SẠCH (rc=0) nhưng pipeline CHƯA tới done/review/error = agent kết thúc
 * lượt non (workflow nền bị giết). Tự chạy tiếp sau 5s (resume theo checkpoint),
 * tối đa AUTO_RESUME_MAX lần liên tiếp. rc != 0 (lỗi thật / bị Dừng SIGTERM)
 * thì KHÔNG tự chạy — tôn trọng người dùng và tránh lặp trên lỗi quota.
 */
function maybeAutoResume(
  vol: VolumeRec,
  cfg: AppConfig,
  engine: string,
  runOpts: RunOpts | undefined,
  code: number | null,
  logPath: string
) {
  if (code !== 0) return;
  let stage = "";
  try {
    stage = effectiveStage(pythonStatus(vol.workdir).stage, cfg);
  } catch {
    return;
  }
  if (["done", "review", "error"].includes(stage) || codexDone(vol)) return;
  const n = autoResume.get(vol.tag) || 0;
  const note =
    n >= AUTO_RESUME_MAX
      ? `\n[watchdog] thoát non ở stage=${stage} nhưng đã tự chạy lại ${n} lần — dừng, cần bấm Chạy thủ công.\n`
      : `\n[watchdog] tiến trình thoát rc=0 nhưng stage=${stage} chưa xong — tự chạy tiếp (lần ${n + 1}/${AUTO_RESUME_MAX})…\n`;
  try {
    const fd = openSync(logPath, "a");
    writeSync(fd, note);
    closeSync(fd);
  } catch {
    /* ignore */
  }
  if (n >= AUTO_RESUME_MAX) return;
  autoResume.set(vol.tag, n + 1);
  const t = setTimeout(() => {
    autoResumeTimers.delete(vol.tag);
    if (!isVolumeRunning(vol) && !starting.has(vol.tag)) {
      launchVolume(vol, cfg, engine, runOpts);
    }
  }, 5000);
  autoResumeTimers.set(vol.tag, t);
}

export function stopVolume(vol: VolumeRec): boolean {
  // Người dùng chủ động dừng: huỷ cả auto-resume đang chờ, kẻo 5s sau watchdog
  // lại tự chạy tiếp cái vừa bị dừng.
  const t = autoResumeTimers.get(vol.tag);
  if (t) {
    clearTimeout(t);
    autoResumeTimers.delete(vol.tag);
  }
  autoResume.set(vol.tag, AUTO_RESUME_MAX);
  const r = RUNS.get(vol.tag);
  let pid = r?.proc?.pid;
  if (!pid) {
    const meta = loadRunMeta(vol.workdir);
    if (meta?.mode === "running" && typeof meta.pid === "number") {
      pid = meta.pid;
    }
  }
  if (!pid || !pidAlive(pid)) return false;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, "SIGTERM"); // negative pid = process group (detached)
    }
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

function pendingTags(cfg: AppConfig): string[] {
  const tags: string[] = [];
  for (const v of loadVolumes()) {
    if (v.skip) continue;
    if (isVolumeRunning(v)) continue;
    let stage = "translate";
    try {
      stage = effectiveStage(pythonStatus(v.workdir).stage, cfg);
    } catch {
      /* ignore */
    }
    if (stage !== "done" && !codexDone(v)) tags.push(v.tag);
  }
  return tags;
}

export function batchStart(cfg: AppConfig, limit = 1): boolean {
  if (BATCH.active) return false;
  autoResume.clear(); // batch mới: cho phép watchdog hoạt động lại trên mọi cuốn
  const gen = ++BATCH.gen;
  BATCH.queue = pendingTags(cfg);
  BATCH.limit = Math.max(1, Math.min(8, Math.floor(limit) || 1));
  BATCH.active = true;
  BATCH.stop = false;
  BATCH.current = null;
  BATCH.running.clear();
  void runBatch(cfg, gen);
  return true;
}

export function batchStop() {
  BATCH.stop = true;
  BATCH.gen++; // vô hiệu hoá vòng runBatch hiện tại ngay lập tức
  for (const tag of BATCH.running) {
    const vol = findVolume(tag);
    if (vol) stopVolume(vol);
  }
  BATCH.active = false;
  BATCH.current = null;
  BATCH.running.clear();
  BATCH.queue = [];
}

// Chạy queue với tối đa BATCH.limit cuốn CÙNG LÚC (mỗi cuốn dùng engine riêng của
// nó). limit=1 = tuần tự như cũ. Vòng lặp: lấp đầy tới limit, chờ, thu cuốn xong.
// Thoát ngay nếu gen đổi (một start/stop khác đã tiếp quản).
// Tổng số cuốn ĐANG chạy (kể cả cuốn chạy lẻ bằng "Chạy ngày"), để limit là trần
// đồng thời THẬT, không chỉ đếm cuốn do batch mở.
function runningCount(): number {
  return loadVolumes().filter((v) => !v.skip && isVolumeRunning(v)).length;
}

async function runBatch(cfg: AppConfig, gen: number) {
  const alive = () => BATCH.gen === gen && !BATCH.stop;
  while (alive() && (BATCH.queue.length || BATCH.running.size)) {
    while (alive() && runningCount() < BATCH.limit && BATCH.queue.length) {
      const tag = BATCH.queue.shift()!;
      const vol = findVolume(tag);
      if (!vol) continue;
      if (isVolumeRunning(vol)) {
        BATCH.running.add(tag);
        continue;
      }
      const res = launchVolume(vol, cfg);
      if (res.ok) BATCH.running.add(tag);
      else console.error(`[batch] không chạy được ${tag}: ${res.error}`);
    }
    BATCH.current = BATCH.running.values().next().value ?? null;
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    if (BATCH.gen !== gen) return; // start/stop khác đã tiếp quản -> nhường
    for (const tag of [...BATCH.running]) {
      const vol = findVolume(tag);
      if (!vol || !isVolumeRunning(vol)) BATCH.running.delete(tag);
    }
  }
  // Chỉ dọn state nếu vòng này vẫn là vòng hiện hành (tránh xoá state của vòng mới).
  if (BATCH.gen === gen) {
    BATCH.active = false;
    BATCH.current = null;
    BATCH.running.clear();
  }
}
