import type { AgentCapabilities, AgentDetection } from "@cfa-translate/shared";
import type {
  AgentAdapter,
  ChatRunParams,
  PipelineRunParams,
} from "../types.js";
import { baseDetect } from "../detect.js";
import { cancelRun, spawnLineStream } from "../spawn-stream.js";
import { createCodexLineParser } from "./stream.js";
import { isCodexResumeFailure } from "../resume-fail.js";

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex",

  async detect(): Promise<AgentDetection | null> {
    return baseDetect({
      id: "codex",
      displayName: "Codex",
      bin: "codex",
      configDirRel: ".codex",
    });
  },

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      resume: true,
      // Headless MCP tool calls need --dangerously-bypass-approvals-and-sandbox
      headlessMcp: false,
      permissionMode: "strict",
      pipeline: "mcp-batch",
    };
  },

  async *chat(params: ChatRunParams) {
    // Prompt as last argv (Codex `exec` reads it as the user message). Long
    // prompts can still hit OS argv limits; resume path keeps the short form.
    let cmd: string[];
    if (params.session) {
      cmd = [
        "codex",
        "exec",
        "resume",
        "--json",
        "-c",
        "approval_policy=never",
        "-c",
        "sandbox_mode=workspace-write",
        params.session,
        params.prompt,
      ];
    } else {
      cmd = [
        "codex",
        "exec",
        params.prompt,
        "--json",
        "-C",
        params.cwd,
        "-s",
        "workspace-write",
        "-c",
        "approval_policy=never",
      ];
      if (params.model) {
        cmd.push("-c", `model=${params.model}`);
      }
    }
    yield* spawnLineStream({
      runId: params.runId,
      cmd,
      cwd: params.cwd,
      parseLine: createCodexLineParser(),
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      isResumeFailure: (stderr) => isCodexResumeFailure(stderr),
    });
  },

  buildPipelineCmd(params: PipelineRunParams): string[] {
    const base = [
      "codex",
      "exec",
      params.prompt,
      "--json",
      "--skip-git-repo-check",
      "-C",
      params.cwd,
    ];
    if (params.posture === "bypass") {
      return [...base, "--dangerously-bypass-approvals-and-sandbox"];
    }
    return [
      ...base,
      "-s",
      "workspace-write",
      "-c",
      "approval_policy=never",
    ];
  },

  cancel(runId: string) {
    return cancelRun(runId);
  },
};
