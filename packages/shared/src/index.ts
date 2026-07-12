/** Shared types for CFA Translate Studio (daemon + web + adapters). */

export type EngineId = "claude" | "codex" | "grok";

export type Stage = "translate" | "verify" | "vision" | "done" | "error" | string;

export type AuthState = "ok" | "missing" | "unknown";

export interface AgentDetection {
  id: EngineId;
  displayName: string;
  executablePath: string;
  version?: string;
  configDir?: string;
  authState: AuthState;
  available: boolean;
}

export interface AgentCapabilities {
  streaming: boolean;
  resume: boolean;
  /** MCP tool calls work headless without interactive approval. */
  headlessMcp: boolean;
  permissionMode: "strict" | "permissive" | "none";
  pipeline: "workflow" | "mcp-batch";
}

/** Optional error codes the UI/daemon can act on (open-design style). */
export type AgentErrorCode = "resume_failed" | "spawn_failed" | "timeout" | string;

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; id?: string }
  | { type: "session"; sessionId: string }
  | { type: "progress"; stage?: string; detail?: string }
  | { type: "error"; error: string; code?: AgentErrorCode }
  | { type: "done"; reason: "completed" | "cancelled" | "error" };

/** SSE events the browser chat UI consumes (compatible with legacy dashboard). */
export type ChatSseEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; text: string }
  | { type: "done"; session?: string | null }
  | { type: "error"; text: string }
  | { type: "info"; text: string };

export interface AppConfig {
  engine?: EngineId | string;
  model?: string;
  budget?: number;
  budget_warn?: number;
  vision?: boolean;
  posture?: "allowlist" | "bypass" | string;
  codex_batch?: number;
  /** Số agent dịch/soát chạy SONG SONG trong 1 run (pipeline Claude), 1..10. */
  agents?: number;
}

export interface Volume {
  tag: string;
  display: string;
  stage: Stage;
  running?: boolean;
  skip?: boolean;
  user?: boolean;
  pages?: number;
  engine?: string;
  logpath?: string;
  translate?: [number, number];
  verify?: [number, number];
  vision?: [number, number];
  out_exists?: boolean;
  sid?: string;
  mode?: string;
  rc?: number | null;
  /** Số trang còn lỗi layout cần fix (kind 'defect' >= medium, chưa accepted). */
  defects?: number;
  /** Engine đã chọn RIÊNG cho cuốn này (ghi đè engine global). undefined = dùng global. */
  pref_engine?: string;
}

export interface StatusResponse {
  volumes: Volume[];
  config: AppConfig;
  engines?: EngineId[];
  models?: string[];
  postures?: string[];
  done?: number;
  total?: number;
  running?: number;
  batch?: {
    active: boolean;
    current?: string | null;
    queue?: string[];
    running?: string[];
    limit?: number;
  };
  agents?: AgentDetection[];
}

export interface PageInfo {
  tag?: string;
  display: string;
  pages: number;
  out_exists: boolean;
}

export interface ChatRequest {
  tag: string;
  engine: EngineId;
  message: string;
  session?: string | null;
}

export function agentEventToChatSse(ev: AgentEvent): ChatSseEvent | null {
  switch (ev.type) {
    case "text_delta":
      return { type: "delta", text: ev.text };
    case "tool_call":
      return { type: "tool", text: "🔧 " + ev.name };
    case "error":
      // resume_failed is handled by the daemon (auto-retry); don't surface to UI.
      if (ev.code === "resume_failed") return null;
      return { type: "error", text: ev.error };
    case "done":
      return { type: "done" };
    case "session":
      return null; // carried on done by daemon
    case "progress":
      return ev.detail ? { type: "info", text: ev.detail } : null;
    default:
      return null;
  }
}
