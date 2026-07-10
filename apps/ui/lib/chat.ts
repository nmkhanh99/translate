// SSE client for /api/chat. Daemon spawns the selected local CLI headless and
// streams JSON events; we parse frames open-design style (event/id/data/comment).
import { API_BASE } from "./api";
import type { Engine } from "./types";

export interface ChatEvent {
  type: "delta" | "tool" | "done" | "error" | "info";
  text?: string;
  session?: string;
}

export interface ChatRequest {
  tag: string;
  engine: Engine;
  message: string;
  session?: string | null;
}

/** open-design `parseSseFrame` — tolerant of CRLF, comments, multi-line data. */
export function parseSseFrame(frame: string): ChatEvent | null {
  const lines = frame.split("\n");
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(":")) {
      // heartbeat / comment — ignore
      continue;
    }
    if (line.startsWith("data:")) {
      // Spec allows optional space after "data:"; accept both "data:" and "data: ".
      dataLines.push(line.slice(5).replace(/^\s/, ""));
    }
    // event: / id: ignored — our daemon uses default "message" with JSON body
  }

  if (!dataLines.length) return null;

  const payload = dataLines.join("\n");
  try {
    return JSON.parse(payload) as ChatEvent;
  } catch {
    // Non-JSON payload — treat as a raw text delta.
    return { type: "delta", text: payload };
  }
}

export async function streamChat(
  reqBody: ChatRequest,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(API_BASE + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(reqBody),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    onEvent({ type: "error", text: msg });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Normalize CRLF so frame splits stay reliable on all platforms.
    buf = buf.replace(/\r\n/g, "\n");
    // SSE frames are separated by a blank line.
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSseFrame(frame);
      if (ev) onEvent(ev);
    }
  }
}
