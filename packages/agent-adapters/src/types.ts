import type {
  AgentCapabilities,
  AgentDetection,
  AgentEvent,
  EngineId,
} from "@cfa-translate/shared";

export interface ChatRunParams {
  runId: string;
  cwd: string;
  /** Full user message (already includes document context on first turn). */
  prompt: string;
  /** Restrict document-reader chat to non-mutating CLI capabilities. */
  readOnly?: boolean;
  session?: string | null;
  model?: string;
  posture?: "allowlist" | "bypass" | string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PipelineRunParams {
  runId: string;
  cwd: string;
  /** Working directory for logs / state (volume workdir). */
  workdir: string;
  prompt: string;
  model?: string;
  posture?: "allowlist" | "bypass" | string;
  /** Session id for claude; ignored by others when unused. */
  sessionId?: string;
  logPath?: string;
  signal?: AbortSignal;
}

export interface AgentAdapter {
  readonly id: EngineId;
  readonly displayName: string;
  detect(): Promise<AgentDetection | null>;
  capabilities(): AgentCapabilities;
  /**
   * Best-effort list of model ids from the installed CLI (may be empty).
   * Never invent product names — empty means UI uses CLI default + free-text.
   */
  listModels?(): Promise<string[]>;
  /** Headless chat turn; yields unified AgentEvent stream. */
  chat(params: ChatRunParams): AsyncIterable<AgentEvent>;
  /** Build argv for a pipeline run (daemon may spawn with log redirection). */
  buildPipelineCmd(params: PipelineRunParams): string[];
  cancel(runId: string): Promise<void>;
}

export type { AgentCapabilities, AgentDetection, AgentEvent, EngineId };
