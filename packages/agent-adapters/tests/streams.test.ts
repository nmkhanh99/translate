import { describe, expect, it } from "vitest";
import {
  parseClaudeLine,
  createClaudeLineParser,
} from "../src/claude/stream.js";
import { parseCodexLine, createCodexLineParser } from "../src/codex/stream.js";
import { parseGrokLine } from "../src/grok/stream.js";
import {
  isClaudeResumeFailure,
  isCodexResumeFailure,
  isAgentResumeFailure,
  hasClaudeResumeFailureResultEvent,
} from "../src/resume-fail.js";

describe("parseClaudeLine", () => {
  it("maps text_delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "xin chào" },
      },
    });
    expect(parseClaudeLine(line)).toEqual([
      { type: "text_delta", text: "xin chào" },
    ]);
  });

  it("maps tool_use and session", () => {
    const tool = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", id: "t1" }] },
    });
    expect(parseClaudeLine(tool)[0]).toMatchObject({
      type: "tool_call",
      name: "Read",
    });
    const sess = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc",
    });
    expect(parseClaudeLine(sess)).toEqual([
      { type: "session", sessionId: "abc" },
    ]);
  });

  it("falls back to assistant text when no partials streamed", () => {
    const parse = createClaudeLineParser();
    const final = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{ type: "text", text: "full reply" }],
      },
    });
    expect(parse(final)).toEqual([{ type: "text_delta", text: "full reply" }]);
  });

  it("does not duplicate assistant text after partials", () => {
    const parse = createClaudeLineParser();
    parse(
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hi" },
        },
      })
    );
    const final = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{ type: "text", text: "hi there" }],
      },
    });
    expect(parse(final)).toEqual([]);
  });

  it("emits resume_failed on local result error (0 turns, 0 api ms)", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      num_turns: 0,
      duration_api_ms: 0,
      session_id: "dead",
      result: "No conversation found with session ID: dead",
    });
    const evs = parseClaudeLine(line);
    expect(evs).toContainEqual({
      type: "session",
      sessionId: "dead",
    });
    expect(evs.find((e) => e.type === "error")).toMatchObject({
      type: "error",
      code: "resume_failed",
    });
  });
});

describe("parseCodexLine", () => {
  it("maps thread + agent_message", () => {
    expect(
      parseCodexLine(
        JSON.stringify({ type: "thread.started", thread_id: "th1" })
      )
    ).toEqual([{ type: "session", sessionId: "th1" }]);
    expect(
      parseCodexLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "hello" },
        })
      )
    ).toEqual([{ type: "text_delta", text: "hello" }]);
  });

  it("maps mcp tool call", () => {
    const ev = parseCodexLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "mcp_tool_call", tool: "extract_segments" },
      })
    );
    expect(ev[0].type).toBe("tool_call");
  });

  it("surfaces a plain-text failure reason (usage limit)", () => {
    const ev = parseCodexLine(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "You've hit your usage limit." },
      })
    );
    expect(ev).toEqual([
      { type: "error", error: "You've hit your usage limit." },
    ]);
  });

  it("unwraps a nested JSON error envelope", () => {
    const ev = parseCodexLine(
      JSON.stringify({
        type: "error",
        message: JSON.stringify({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", message: "Model not supported." },
        }),
      })
    );
    expect(ev).toEqual([{ type: "error", error: "Model not supported." }]);
  });

  it("dedupes error + turn.failed to a single error event", () => {
    const parse = createCodexLineParser();
    const first = parse(
      JSON.stringify({ type: "error", message: "You've hit your usage limit." })
    );
    const second = parse(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "You've hit your usage limit." },
      })
    );
    expect(first).toEqual([
      { type: "error", error: "You've hit your usage limit." },
    ]);
    expect(second).toEqual([]);
  });

  it("still surfaces a different, more definitive turn.failed reason", () => {
    const parse = createCodexLineParser();
    parse(JSON.stringify({ type: "error", message: "stream error" }));
    const term = parse(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "You've hit your usage limit." },
      })
    );
    expect(term).toEqual([
      { type: "error", error: "You've hit your usage limit." },
    ]);
  });

  it("ignores a whitespace-only error message", () => {
    expect(
      parseCodexLine(JSON.stringify({ type: "error", message: "   " }))
    ).toEqual([]);
  });

  it("unwraps a doubly-nested JSON envelope", () => {
    const inner = JSON.stringify({
      error: { message: "Deep reason." },
    });
    const ev = parseCodexLine(
      JSON.stringify({ type: "turn.failed", error: { message: inner } })
    );
    expect(ev).toEqual([{ type: "error", error: "Deep reason." }]);
  });

  it("falls back to top-level message when nested is blank", () => {
    const ev = parseCodexLine(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "   " },
        message: "Model not supported.",
      })
    );
    expect(ev).toEqual([{ type: "error", error: "Model not supported." }]);
  });
});

describe("parseGrokLine", () => {
  it("maps text and session; ignores thought", () => {
    expect(
      parseGrokLine(JSON.stringify({ type: "text", data: "vi" }))
    ).toEqual([{ type: "text_delta", text: "vi" }]);
    expect(
      parseGrokLine(JSON.stringify({ type: "thought", data: "hmm" }))
    ).toEqual([]);
    expect(
      parseGrokLine(JSON.stringify({ type: "end", sessionId: "s9" }))
    ).toEqual([{ type: "session", sessionId: "s9" }]);
  });
});

describe("resume failure detection", () => {
  it("detects Claude prose on stderr", () => {
    expect(
      isClaudeResumeFailure(
        "No conversation found with session ID: abc-123\n"
      )
    ).toBe(true);
  });

  it("detects Claude structured result on stdout", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      num_turns: 0,
      duration_api_ms: 0,
    });
    expect(hasClaudeResumeFailureResultEvent(stdout)).toBe(true);
    expect(isClaudeResumeFailure("", stdout)).toBe(true);
  });

  it("does not treat in-turn API error as resume failure", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      num_turns: 2,
      duration_api_ms: 1200,
      result: "overload",
    });
    expect(isClaudeResumeFailure("", stdout)).toBe(false);
  });

  it("detects Codex resume miss", () => {
    expect(
      isCodexResumeFailure(
        "Error: thread/resume: thread/resume failed: no rollout found for thread id xyz"
      )
    ).toBe(true);
  });

  it("dispatches per agent", () => {
    expect(
      isAgentResumeFailure(
        "codex",
        "no rollout found for thread id x",
        ""
      )
    ).toBe(true);
    expect(
      isAgentResumeFailure(
        "claude",
        "No conversation found with session ID: z",
        ""
      )
    ).toBe(true);
  });
});
