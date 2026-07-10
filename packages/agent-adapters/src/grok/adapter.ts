import type { AgentCapabilities, AgentDetection } from "@cfa-translate/shared";
import type {
  AgentAdapter,
  ChatRunParams,
  PipelineRunParams,
} from "../types.js";
import { baseDetect } from "../detect.js";
import { cancelRun, spawnLineStream } from "../spawn-stream.js";
import { parseGrokLine } from "./stream.js";

export const grokAdapter: AgentAdapter = {
  id: "grok",
  displayName: "Grok",

  async detect(): Promise<AgentDetection | null> {
    return baseDetect({
      id: "grok",
      displayName: "Grok",
      bin: "grok",
      configDirRel: ".grok",
    });
  },

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      resume: true,
      headlessMcp: true, // --always-approve
      permissionMode: "permissive",
      pipeline: "mcp-batch",
    };
  },

  async *chat(params: ChatRunParams) {
    const cmd = [
      "grok",
      "-p",
      params.prompt,
      "--output-format",
      "streaming-json",
      "--cwd",
      params.cwd,
      "--permission-mode",
      "auto",
    ];
    if (params.session) {
      cmd.push("--resume", params.session);
    }
    yield* spawnLineStream({
      runId: params.runId,
      cmd,
      cwd: params.cwd,
      parseLine: parseGrokLine,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
  },

  buildPipelineCmd(params: PipelineRunParams): string[] {
    return [
      "grok",
      "-p",
      params.prompt,
      "--output-format",
      "plain",
      "--cwd",
      params.cwd,
      "--always-approve",
    ];
  },

  cancel(runId: string) {
    return cancelRun(runId);
  },
};
