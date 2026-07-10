import type { AgentEvent } from "@cfa-translate/shared";

/** Parse one stdout line from `claude -p --output-format stream-json`. */
export function parseClaudeLine(line: string): AgentEvent[] {
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
        out.push({ type: "text_delta", text: d.text });
      }
    }
  } else if (t === "assistant") {
    const msg = (obj.message || {}) as { content?: Array<Record<string, unknown>> };
    for (const c of msg.content || []) {
      if (c.type === "tool_use") {
        out.push({
          type: "tool_call",
          name: String(c.name || "tool"),
          id: typeof c.id === "string" ? c.id : undefined,
        });
      }
    }
  } else if (t === "result" && typeof obj.session_id === "string") {
    out.push({ type: "session", sessionId: obj.session_id });
  } else if (
    t === "system" &&
    obj.subtype === "init" &&
    typeof obj.session_id === "string"
  ) {
    out.push({ type: "session", sessionId: obj.session_id });
  }
  return out;
}
