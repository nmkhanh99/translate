import type { AgentEvent } from "@cfa-translate/shared";
import { isCodexResumeFailure } from "../resume-fail.js";

/**
 * Codex surfaces a failure reason on `error` / `turn.failed`, and the message is
 * sometimes a raw JSON envelope (e.g. a 400 from the model gateway), occasionally
 * nested more than once. Unwrap the inner `.error.message` / `.message` (bounded
 * recursion) so the UI shows a human sentence instead of `{"type":"error",...}`.
 */
function cleanCodexError(msg: string, depth = 0): string {
  const s = msg.trim();
  if (depth < 3 && s.startsWith("{")) {
    try {
      const j = JSON.parse(s) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const inner = j?.error?.message ?? j?.message;
      if (typeof inner === "string" && inner.trim()) {
        return cleanCodexError(inner, depth + 1);
      }
    } catch {
      /* not JSON — fall through to the raw string */
    }
  }
  return s;
}

/**
 * Pull the human-readable reason out of a Codex `error` / `turn.failed` event.
 * turn.failed nests it under `error.message`; the top-level `error` event uses
 * `message`. Try the nested value first, then the top-level, and take whichever
 * cleans to a non-empty string (so a whitespace-only nested value cannot mask a
 * real top-level message). Returns "" when there is no usable reason.
 */
function extractCodexError(obj: Record<string, unknown>): string {
  const nested = (obj.error || {}) as Record<string, unknown>;
  for (const raw of [nested.message, obj.message]) {
    if (typeof raw === "string" && raw.trim()) {
      const cleaned = cleanCodexError(raw);
      if (cleaned) return cleaned;
    }
  }
  return "";
}

/**
 * Parse `codex exec --json` JSONL into agent events.
 *
 * On failure Codex emits BOTH a top-level `error` and a terminal `turn.failed`
 * carrying the reason (usage limit, unsupported model, …). They usually repeat
 * the same message, so we dedupe by CONTENT (not a one-shot flag) — an identical
 * follow-up is dropped, but a genuinely different, more definitive reason still
 * gets through. (Codex also prints a benign `Reading additional input from
 * stdin...` line to stderr on every run — that noise must not be shown as the
 * failure reason.)
 */
export function createCodexLineParser(): (line: string) => AgentEvent[] {
  let lastError = "";

  return function parseCodexLine(line: string): AgentEvent[] {
    const out: AgentEvent[] = [];
    const raw = line.trim();
    if (!raw) return out;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw);
    } catch {
      return out;
    }
    const t = obj.type as string | undefined;

    if (t === "thread.started" && typeof obj.thread_id === "string") {
      out.push({ type: "session", sessionId: obj.thread_id });
    } else if (t === "item.completed") {
      const item = (obj.item || {}) as Record<string, unknown>;
      const it = item.type as string | undefined;
      if (it === "agent_message" && typeof item.text === "string" && item.text) {
        out.push({ type: "text_delta", text: item.text });
      } else if (
        it === "command_execution" ||
        it === "mcp_tool_call" ||
        it === "file_change"
      ) {
        out.push({
          type: "tool_call",
          name: String(item.command || item.tool || it),
        });
      }
    } else if (t === "error" || t === "turn.failed") {
      const message = extractCodexError(obj);
      if (message && message !== lastError) {
        lastError = message;
        // A dead `--resume` target reports on stderr in current builds, but if a
        // build ever surfaces it as a structured turn.failed on stdout, tag it
        // resume_failed here so the daemon still auto-retries with a fresh
        // session. Safe: we match the FAILURE message, never assistant text.
        out.push(
          isCodexResumeFailure(message)
            ? { type: "error", error: message, code: "resume_failed" }
            : { type: "error", error: message }
        );
      }
    }
    return out;
  };
}

/** Stateless convenience used by unit tests (no cross-line error dedupe). */
export function parseCodexLine(line: string): AgentEvent[] {
  return createCodexLineParser()(line);
}
