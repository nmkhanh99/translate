import type { AgentEvent } from "@cfa-translate/shared";

/** Parse one stdout line from `grok -p --output-format streaming-json`. */
export function parseGrokLine(line: string): AgentEvent[] {
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

  if (t === "text" && typeof obj.data === "string" && obj.data) {
    out.push({ type: "text_delta", text: obj.data });
  } else if (t && t.includes("tool")) {
    out.push({
      type: "tool_call",
      name: String(obj.name || obj.data || t),
    });
  } else if (t === "end" && typeof obj.sessionId === "string") {
    out.push({ type: "session", sessionId: obj.sessionId });
  }
  // 'thought' intentionally ignored
  return out;
}
