import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { getAdapter, ENGINE_IDS, type EngineId } from "@cfa-translate/agent-adapters";
import type { AppConfig } from "@cfa-translate/shared";
import {
  buildClaudePipelinePrompt,
  buildMcpBatchPrompt,
} from "./prompts.js";
import { REPO_ROOT } from "./paths.js";
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

export interface RunInfo {
  proc: ChildProcess | null;
  sid: string;
  mode: string;
  pid?: number;
  engine?: string;
}

const RUNS = new Map<string, RunInfo>();
const starting = new Set<string>();

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
  engineOverride?: string
): { ok: true; sid: string } | { ok: false; error: string } {
  if (vol.skip) return { ok: false, error: "volume này đánh skip" };
  if (starting.has(vol.tag) || isVolumeRunning(vol)) {
    return { ok: false, error: "đang chạy" };
  }
  starting.add(vol.tag);

  // Ưu tiên: engine chỉ định lúc gọi > engine đã chọn riêng cho cuốn (pref.json)
  // > engine global. Bỏ qua pref không hợp lệ (pref.json hỏng) thay vì để
  // getAdapter fail. Cho phép mỗi tài liệu dịch bằng CLI khác nhau, song song.
  const prefRaw = loadEnginePref(vol.workdir);
  const pref =
    prefRaw && ENGINE_IDS.includes(prefRaw as EngineId) ? prefRaw : undefined;
  const engine = (engineOverride || pref || cfg.engine || "claude") as EngineId;
  const adapter = getAdapter(engine);
  if (!adapter) {
    starting.delete(vol.tag);
    return { ok: false, error: `engine không hợp lệ: ${engine}` };
  }

  const sid = randomUUID();
  const prompt =
    engine === "claude"
      ? buildClaudePipelinePrompt(vol, !!cfg.vision)
      : buildMcpBatchPrompt(vol, cfg.codex_batch ?? 25);

  const cmd = adapter.buildPipelineCmd({
    runId: sid,
    cwd: REPO_ROOT,
    workdir: vol.workdir,
    prompt,
    model: cfg.model,
    posture: cfg.posture,
    sessionId: sid,
  });

  mkdirSync(vol.workdir, { recursive: true });
  const logPath = join(vol.workdir, "run.log");
  const header =
    `\n===== RUN ${new Date().toISOString()} engine=${engine} model=${cfg.model} ` +
    `posture=${cfg.posture} vision=${cfg.vision} sid=${sid} =====\n`;

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
  });

  try {
    saveRunMeta(vol.workdir, meta);
  } catch {
    /* meta write best-effort — status recomputes from files; the exit handler
       re-writes run.json on completion. */
  }
  return { ok: true, sid };
}

export function stopVolume(vol: VolumeRec): boolean {
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
