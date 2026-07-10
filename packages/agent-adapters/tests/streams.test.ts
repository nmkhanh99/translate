import { describe, expect, it } from "vitest";
import { parseClaudeLine } from "../src/claude/stream.js";
import { parseCodexLine } from "../src/codex/stream.js";
import { parseGrokLine } from "../src/grok/stream.js";

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
