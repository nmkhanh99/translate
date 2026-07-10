import type { AgentEvent } from "@cfa-translate/shared";

/** Parse one stdout line from `codex exec --json`. */
export function parseCodexLine(line: string): AgentEvent[] {
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
  }
  return out;
}
