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
  /** When set, written to child stdin then closed (open-design promptViaStdin). */
  stdinText?: string;
  /**
   * Detect a dead resume target from CLI failure channels. When true, yields
   * `{ type: "error", code: "resume_failed" }` so the daemon can retry fresh.
   */
  isResumeFailure?: (stderr: string, stdout: string) => boolean;
}): AsyncGenerator<AgentEvent> {
  const [bin, ...args] = opts.cmd;
  const useStdin = typeof opts.stdinText === "string";
  let proc: ChildProcess;
  try {
    proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (e) {
    yield {
      type: "error",
      error:
        e instanceof Error ? e.message : `Không spawn được ${bin}`,
      code: "spawn_failed",
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

  if (useStdin && proc.stdin) {
    // The child may exit before consuming stdin (stale resume, bad arg, …).
    // Writing then triggers an ASYNC "error" (EPIPE) on the stdin stream that
    // the try/catch below cannot see; unhandled, it can crash the daemon.
    proc.stdin.on("error", () => {
      /* child closed stdin early — safe to ignore */
    });
    try {
      proc.stdin.end(opts.stdinText);
    } catch {
      /* ignore — child may already have exited */
    }
  }

  const errBuf: string[] = [];
  const outBuf: string[] = [];
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
      yield { type: "error", error: "CLI không có stdout", code: "spawn_failed" };
      yield { type: "done", reason: "error" };
      return;
    }
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      // Keep a rolling stdout window for structured resume-failure detection
      // (Claude stream-json `result` events land here, not on stderr).
      outBuf.push(line);
      if (outBuf.length > 80) outBuf.splice(0, 40);
      for (const ev of opts.parseLine(line)) {
        yield ev;
      }
    }
    // Wait for the child to fully terminate. Guard against the terminal event
    // having ALREADY fired (common after killTree on abort/timeout, or a fast
    // ENOENT): re-subscribing to "close"/"exit" would then never resolve and
    // strand this iterator forever (heartbeat leak, response never ends). Wait
    // on "close" rather than "exit" so stderr is fully drained before we read
    // errBuf for resume-failure detection. Capture the signal so a child killed
    // by an unexpected signal is reported as an error, not a clean completion.
    const { code, signal }: { code: number | null; signal: NodeJS.Signals | null } =
      await new Promise((resolve) => {
        if (spawnErr != null || proc.exitCode != null || proc.signalCode != null) {
          return resolve({ code: proc.exitCode, signal: proc.signalCode });
        }
        proc.once("close", (c, s) => resolve({ code: c, signal: s }));
        proc.once("error", () => resolve({ code: null, signal: null }));
      });

    if (spawnErr) {
      yield {
        type: "error",
        error: spawnErr,
        code: "spawn_failed",
      };
      yield { type: "done", reason: "error" };
      return;
    }

    if (timedOut) {
      yield {
        type: "error",
        error: `Quá thời gian (${Math.round((opts.timeoutMs || 0) / 1000)}s) — đã dừng.`,
        code: "timeout",
      };
      yield { type: "done", reason: "error" };
      return;
    }
    if (opts.signal?.aborted) {
      yield { type: "done", reason: "cancelled" };
      return;
    }
    // Killed by a signal we did not initiate (segfault, OOM/SIGKILL, external
    // term). exitCode is null in this case, so it would otherwise slip past the
    // numeric-code check below and be reported as a clean completion.
    if (signal && code == null) {
      const stderr = errBuf.join("").trim();
      yield {
        type: "error",
        error: stderr.slice(-600) || `${bin} bị dừng bởi tín hiệu ${signal}`,
      };
      yield { type: "done", reason: "error" };
      return;
    }
    if (code !== 0 && code != null) {
      const stderr = errBuf.join("").trim();
      const stdout = outBuf.join("\n");
      if (opts.isResumeFailure?.(stderr, stdout)) {
        yield {
          type: "error",
          error: "Phiên CLI cũ không còn (resume failed).",
          code: "resume_failed",
        };
        yield { type: "done", reason: "error" };
        return;
      }
      const err = stderr.slice(-600);
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
  if (!proc || proc.killed || !proc.pid) return;
  try {
    if (process.platform === "win32") {
      // Windows has no process groups; taskkill /T kills the whole tree.
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    } else {
      process.kill(-proc.pid, "SIGKILL"); // negative pid = process group (detached)
    }
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
