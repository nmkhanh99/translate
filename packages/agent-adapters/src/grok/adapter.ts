import type { AgentCapabilities, AgentDetection } from "@cfa-translate/shared";
import type {
  AgentAdapter,
  ChatRunParams,
  PipelineRunParams,
} from "../types.js";
import { baseDetect } from "../detect.js";
import { cancelRun, spawnLineStream } from "../spawn-stream.js";
import { parseGrokLine } from "./stream.js";
import { isGrokResumeFailure } from "../resume-fail.js";
import { parseGrokModelsOutput, runCliCapture } from "../list-models.js";

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

  /** Parse `grok models` — live list from installed CLI, not a frozen table. */
  async listModels(): Promise<string[]> {
    const text = await runCliCapture("grok", ["models"], 8000);
    return parseGrokModelsOutput(text);
  },

  async *chat(params: ChatRunParams) {
    // Recent Grok Build CLIs require `-p <PROMPT>` as an argv value (no bare
    // stdin). Keep prompt on argv; open-design stages a --prompt-file for huge
    // OD system prompts, which we don't need for document-scoped chat.
    const cmd = [
      "grok",
      "-p",
      params.prompt,
      "--output-format",
      "streaming-json",
      "--cwd",
      params.cwd,
      ...(params.readOnly
        ? [
            "--sandbox",
            "read-only",
            "--permission-mode",
            "dontAsk",
            "--disable-web-search",
            "--no-subagents",
            "--no-memory",
          ]
        : ["--permission-mode", "auto"]),
    ];
    if (params.model) {
      cmd.push("--model", params.model);
    }
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
      isResumeFailure: (stderr, stdout) => isGrokResumeFailure(stderr || stdout),
    });
  },

  buildPipelineCmd(params: PipelineRunParams): string[] {
    const cmd = [
      "grok",
      "-p",
      params.prompt,
      "--output-format",
      "plain",
      "--cwd",
      params.cwd,
      "--always-approve",
    ];
    if (params.model) cmd.push("--model", params.model);
    return cmd;
  },

  cancel(runId: string) {
    return cancelRun(runId);
  },
};
