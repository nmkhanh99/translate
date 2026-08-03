import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, ChatRunParams } from "../src/types.js";

const spawned = vi.hoisted(() => ({
  commands: [] as string[][],
}));

vi.mock("../src/spawn-stream.js", () => ({
  cancelRun: vi.fn(async () => {}),
  spawnLineStream: vi.fn((opts: { cmd: string[] }) => {
    spawned.commands.push(opts.cmd);
    return (async function* () {})();
  }),
}));

import { claudeAdapter } from "../src/claude/adapter.js";
import { codexAdapter } from "../src/codex/adapter.js";
import { grokAdapter } from "../src/grok/adapter.js";

const baseParams: ChatRunParams = {
  runId: "readonly-test",
  cwd: "/tmp/reader",
  prompt: "Explain this selection",
  readOnly: true,
};

async function chatCommand(
  adapter: AgentAdapter,
  overrides: Partial<ChatRunParams> = {}
): Promise<string[]> {
  for await (const _event of adapter.chat({ ...baseParams, ...overrides })) {
    // Drain the adapter so it reaches spawnLineStream.
  }
  const cmd = spawned.commands.at(-1);
  if (!cmd) throw new Error("adapter did not spawn a command");
  return cmd;
}

function valuesAfter(cmd: string[], flag: string, count: number): string[] {
  const index = cmd.indexOf(flag);
  return index < 0 ? [] : cmd.slice(index + 1, index + 1 + count);
}

describe("read-only document chat commands", () => {
  beforeEach(() => {
    spawned.commands.length = 0;
  });

  it("limits Claude tools to Read, Grep and Glob", async () => {
    const cmd = await chatCommand(claudeAdapter, { session: "claude-session" });
    expect(valuesAfter(cmd, "--allowedTools", 3)).toEqual(["Read", "Grep", "Glob"]);
    expect(cmd).not.toContain("Write");
    expect(cmd).not.toContain("Edit");
    expect(cmd.some((arg) => arg.startsWith("Bash("))).toBe(false);
  });

  it("uses Codex read-only sandbox for a fresh chat", async () => {
    const cmd = await chatCommand(codexAdapter);
    expect(valuesAfter(cmd, "-s", 1)).toEqual(["read-only"]);
    expect(cmd).not.toContain("workspace-write");
  });

  it("uses Codex read-only sandbox when resuming", async () => {
    const cmd = await chatCommand(codexAdapter, { session: "codex-session" });
    expect(cmd).toContain("sandbox_mode=read-only");
    expect(cmd).not.toContain("sandbox_mode=workspace-write");
  });

  it("disables Grok mutation, web search, subagents and memory", async () => {
    const cmd = await chatCommand(grokAdapter, { session: "grok-session" });
    expect(valuesAfter(cmd, "--sandbox", 1)).toEqual(["read-only"]);
    expect(valuesAfter(cmd, "--permission-mode", 1)).toEqual(["dontAsk"]);
    expect(cmd).toEqual(
      expect.arrayContaining(["--disable-web-search", "--no-subagents", "--no-memory"])
    );
    expect(cmd).not.toContain("auto");
  });

  it("preserves existing mutable chat defaults when readOnly is omitted", async () => {
    const claude = await chatCommand(claudeAdapter, {
      readOnly: undefined,
      session: "claude-session",
    });
    expect(claude).toEqual(expect.arrayContaining(["Write", "Edit"]));

    const codex = await chatCommand(codexAdapter, { readOnly: undefined });
    expect(valuesAfter(codex, "-s", 1)).toEqual(["workspace-write"]);

    const grok = await chatCommand(grokAdapter, {
      readOnly: undefined,
      session: "grok-session",
    });
    expect(valuesAfter(grok, "--permission-mode", 1)).toEqual(["auto"]);
  });
});
