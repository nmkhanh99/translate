// SSE client for /api/chat. Daemon spawns the selected local CLI headless and
// streams JSON events; we parse `data:` frames. fetch+ReadableStream (POST).
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
    // SSE frames are separated by a blank line.
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      const payload = dataLines.join("\n");
      try {
        onEvent(JSON.parse(payload) as ChatEvent);
      } catch {
        // Non-JSON payload — treat as a raw text delta.
        onEvent({ type: "delta", text: payload });
      }
    }
  }
}
