// Re-export shared contracts; keep Engine alias for existing UI imports.
export type {
  Stage,
  Volume,
  AppConfig,
  StatusResponse,
  PageInfo,
  EngineId,
  AgentDetection,
  AgentCapabilities,
} from "@cfa-translate/shared";

export type Engine = import("@cfa-translate/shared").EngineId;

export type ChatRole = "user" | "assistant" | "tool" | "error" | "info";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  engine?: Engine;
  streaming?: boolean;
}

