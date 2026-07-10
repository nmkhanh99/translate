import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { getAdapter, type EngineId } from "@cfa-translate/agent-adapters";
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
};

export function isVolumeRunning(vol: VolumeRec): boolean {
  const r = RUNS.get(vol.tag);
  if (r?.proc && r.proc.exitCode == null && !r.proc.killed) return true;
  const meta = loadRunMeta(vol.workdir);
  return !!(meta && meta.mode === "running" && pidAlive(meta.pid));
}

export function launchVolume(
  vol: VolumeRec,
  cfg: AppConfig
): { ok: true; sid: string } | { ok: false; error: string } {
  if (vol.skip) return { ok: false, error: "volume này đánh skip" };
  if (starting.has(vol.tag) || isVolumeRunning(vol)) {
    return { ok: false, error: "đang chạy" };
  }
  starting.add(vol.tag);

  const engine = (cfg.engine || "claude") as EngineId;
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
  saveRunMeta(vol.workdir, meta);
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
    process.kill(-pid, "SIGTERM");
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

export function batchStart(cfg: AppConfig): boolean {
  if (BATCH.active) return false;
  BATCH.queue = pendingTags(cfg);
  BATCH.active = true;
  BATCH.stop = false;
  BATCH.current = null;
  void runBatch(cfg);
  return true;
}

export function batchStop() {
  BATCH.stop = true;
  if (BATCH.current) {
    const vol = findVolume(BATCH.current);
    if (vol) stopVolume(vol);
  }
  BATCH.active = false;
  BATCH.current = null;
}

async function runBatch(cfg: AppConfig) {
  while (BATCH.queue.length && !BATCH.stop) {
    const tag = BATCH.queue.shift()!;
    BATCH.current = tag;
    const vol = findVolume(tag);
    if (!vol) continue;
    const res = launchVolume(vol, cfg);
    if (!res.ok) continue;
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (!isVolumeRunning(vol) || BATCH.stop) return resolve();
        setTimeout(tick, 1500);
      };
      tick();
    });
  }
  BATCH.active = false;
  BATCH.current = null;
}
