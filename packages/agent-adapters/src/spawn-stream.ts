import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent } from "@cfa-translate/shared";

export type LineParser = (line: string) => Iterable<AgentEvent>;

const active = new Map<string, ChildProcess>();

export function getActiveProcess(runId: string) {
  return active.get(runId);
}

export async function* spawnLineStream(opts: {
  runId: string;
  cmd: string[];
  cwd: string;
  parseLine: LineParser;
  timeoutMs?: number;
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const [bin, ...args] = opts.cmd;
  let proc: ChildProcess;
  try {
    proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (e) {
    yield {
      type: "error",
      error:
        e instanceof Error
          ? e.message
          : `Không spawn được ${bin}`,
    };
    yield { type: "done", reason: "error" };
    return;
  }

  active.set(opts.runId, proc);
  // A missing binary (ENOENT) surfaces asynchronously via "error", not by
  // throwing from spawn() above. Capture it so an unavailable engine yields an
  // error event instead of crashing the daemon with an unhandled "error".
  let spawnErr: string | null = null;
  proc.once("error", (e) => {
    spawnErr = e instanceof Error ? e.message : String(e);
  });
  const errBuf: string[] = [];
  if (proc.stderr) {
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      errBuf.push(chunk);
      if (errBuf.length > 40) errBuf.splice(0, 20);
    });
  }

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      killTree(proc);
    }, opts.timeoutMs);
  }

  const onAbort = () => killTree(proc);
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (!proc.stdout) {
      yield { type: "error", error: "CLI không có stdout" };
      yield { type: "done", reason: "error" };
      return;
    }
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      for (const ev of opts.parseLine(line)) {
        yield ev;
      }
    }
    const code: number | null = await new Promise((resolve) => {
      if (proc.exitCode != null) return resolve(proc.exitCode);
      proc.once("exit", (c) => resolve(c));
      proc.once("error", () => resolve(null));
    });

    if (spawnErr) {
      yield { type: "error", error: spawnErr };
      yield { type: "done", reason: "error" };
      return;
    }

    if (timedOut) {
      yield {
        type: "error",
        error: `Quá thời gian (${Math.round((opts.timeoutMs || 0) / 1000)}s) — đã dừng.`,
      };
      yield { type: "done", reason: "error" };
      return;
    }
    if (opts.signal?.aborted) {
      yield { type: "done", reason: "cancelled" };
      return;
    }
    if (code !== 0 && code != null) {
      const err = errBuf.join("").trim().slice(-600);
      yield {
        type: "error",
        error: err || `${bin} thoát mã ${code}`,
      };
      yield { type: "done", reason: "error" };
      return;
    }
    yield { type: "done", reason: "completed" };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    killTree(proc);
    active.delete(opts.runId);
  }
}

export function killTree(proc: ChildProcess | undefined) {
  if (!proc || proc.killed) return;
  try {
    if (proc.pid) process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

export async function cancelRun(runId: string): Promise<void> {
  const proc = active.get(runId);
  if (proc) killTree(proc);
}
