import { randomUUID } from "node:crypto";
import type { AgentCapabilities, AgentDetection } from "@cfa-translate/shared";
import type {
  AgentAdapter,
  ChatRunParams,
  PipelineRunParams,
} from "../types.js";
import { baseDetect } from "../detect.js";
import { cancelRun, spawnLineStream } from "../spawn-stream.js";
import { createClaudeLineParser } from "./stream.js";
import { isClaudeResumeFailure } from "../resume-fail.js";

const CHAT_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(cd *)",
  "Bash(python3 *)",
  "Write",
  "Edit",
];

const PIPELINE_TOOLS = [
  "Bash(cd *)",
  "Bash(python3 *)",
  "Write",
  "Edit",
  "Read",
  "Agent",
  "Task",
  "Workflow",
  "Glob",
  "Grep",
];

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  displayName: "Claude Code",

  async detect(): Promise<AgentDetection | null> {
    return baseDetect({
      id: "claude",
      displayName: "Claude Code",
      bin: "claude",
      configDirRel: ".claude",
    });
  },

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      resume: true,
      headlessMcp: true,
      permissionMode: "strict",
      pipeline: "workflow",
    };
  },

  async *chat(params: ChatRunParams) {
    const session = params.session || randomUUID();
    // Prefer argv for short prompts (stable across Claude Code builds). Switch
    // to stdin when large (open-design): avoids Linux E2BIG / Windows
    // ENAMETOOLONG. `claude -p` with no positional prompt reads stdin.
    const useStdin = params.prompt.length > 8000;
    const cmd = [
      "claude",
      "-p",
      ...(useStdin ? [] : [params.prompt]),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--add-dir",
      params.cwd,
      "--permission-mode",
      "default",
      "--allowedTools",
      ...CHAT_TOOLS,
    ];
    if (params.model) {
      cmd.push("--model", params.model);
    }
    if (params.session) {
      cmd.push("--resume", params.session);
    } else {
      cmd.push("--session-id", session);
      yield { type: "session" as const, sessionId: session };
    }
    yield* spawnLineStream({
      runId: params.runId,
      cmd,
      cwd: params.cwd,
      parseLine: createClaudeLineParser(),
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      stdinText: useStdin ? params.prompt : undefined,
      isResumeFailure: isClaudeResumeFailure,
    });
  },

  buildPipelineCmd(params: PipelineRunParams): string[] {
    const sid = params.sessionId || randomUUID();
    const cmd = [
      "claude",
      "-p",
      params.prompt,
      "--model",
      params.model || "sonnet",
      "--add-dir",
      params.cwd,
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      sid,
    ];
    if (params.posture === "bypass") {
      cmd.push("--permission-mode", "bypassPermissions");
    } else {
      cmd.push("--permission-mode", "default", "--allowedTools", ...PIPELINE_TOOLS);
    }
    return cmd;
  },

  cancel(runId: string) {
    return cancelRun(runId);
  },
};
