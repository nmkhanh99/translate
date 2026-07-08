// Shape of the objects dashboard.py returns from /api/status. Kept loose because
// the Python side is the source of truth; we only type the fields the UI reads.
export type Stage = "translate" | "verify" | "vision" | "done" | "error" | string;

export interface Volume {
  tag: string;
  display: string;
  stage: Stage;
  running?: boolean;
  skip?: boolean;
  user?: boolean; // user-added PDF (📄)
  pages?: number;
  engine?: string;
  logpath?: string;
  translate?: [number, number];
  verify?: [number, number];
  vision?: [number, number];
}

export interface AppConfig {
  engine?: string;
  model?: string;
  budget?: number;
  budget_warn?: number;
  vision?: boolean;
  posture?: string;
  codex_batch?: number;
}

export interface StatusResponse {
  volumes: Volume[];
  config: AppConfig;
}

export interface PageInfo {
  display: string;
  pages: number;
  out_exists: boolean;
}

export type Engine = "claude" | "codex" | "grok";

export type ChatRole = "user" | "assistant" | "tool" | "error";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  engine?: Engine;
  streaming?: boolean;
}
