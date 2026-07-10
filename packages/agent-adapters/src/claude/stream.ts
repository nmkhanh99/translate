import type { AgentEvent } from "@cfa-translate/shared";

/**
 * Parse Claude Code `claude -p --output-format stream-json` JSONL.
 *
 * With `--include-partial-messages`, text arrives as `stream_event` deltas.
 * Without it (older builds / unknown flag rejected), only the final `assistant`
 * wrapper carries text. One spawn = one turn, so a single `hasStreamedText`
 * flag is enough to avoid duplicating partial + final text (open-design
 * claude-stream.ts pattern, simplified for headless one-shot turns).
 */
export function createClaudeLineParser(): (line: string) => AgentEvent[] {
  let hasStreamedText = false;

  return function parseClaudeLine(line: string): AgentEvent[] {
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

    if (t === "stream_event") {
      const ev = (obj.event || {}) as Record<string, unknown>;
      if (ev.type === "content_block_delta") {
        const d = (ev.delta || {}) as Record<string, unknown>;
        if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
          hasStreamedText = true;
          out.push({ type: "text_delta", text: d.text });
        }
      }
    } else if (t === "assistant") {
      const msg = (obj.message || {}) as {
        content?: Array<Record<string, unknown>>;
      };
      for (const c of msg.content || []) {
        if (c.type === "tool_use") {
          out.push({
            type: "tool_call",
            name: String(c.name || "tool"),
            id: typeof c.id === "string" ? c.id : undefined,
          });
        } else if (
          c.type === "text" &&
          typeof c.text === "string" &&
          c.text &&
          !hasStreamedText
        ) {
          // Fallback when partial streaming is off / unsupported.
          hasStreamedText = true;
          out.push({ type: "text_delta", text: c.text });
        }
      }
    } else if (t === "result") {
      if (typeof obj.session_id === "string") {
        out.push({ type: "session", sessionId: obj.session_id });
      }
      // Structured resume / hard failure: is_error with zero turns + zero API
      // time means the CLI failed locally (e.g. dead --resume) before calling
      // the model. Surface as resume_failed so the daemon can retry fresh.
      if (
        obj.is_error === true &&
        Number(obj.num_turns) === 0 &&
        Number(obj.duration_api_ms) === 0
      ) {
        const resultText =
          typeof obj.result === "string" && obj.result
            ? obj.result
            : "Phiên CLI cũ không còn (resume failed).";
        out.push({
          type: "error",
          error: resultText,
          code: "resume_failed",
        });
      } else if (obj.is_error === true) {
        const resultText =
          typeof obj.result === "string" && obj.result
            ? obj.result
            : "Claude trả lỗi.";
        out.push({ type: "error", error: resultText });
      }
    } else if (
      t === "system" &&
      obj.subtype === "init" &&
      typeof obj.session_id === "string"
    ) {
      out.push({ type: "session", sessionId: obj.session_id });
    }
    return out;
  };
}

/** Stateless convenience used by unit tests (no partial/final dedupe state). */
export function parseClaudeLine(line: string): AgentEvent[] {
  return createClaudeLineParser()(line);
}
