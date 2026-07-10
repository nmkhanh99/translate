import { test, expect } from "vitest";
import { spawnLineStream } from "../src/spawn-stream.js";

// Regression for the P1 fix: a missing CLI must yield an error event and end
// the stream gracefully — NOT crash the process with an unhandled "error".
test("missing binary yields error+done, no unhandled crash", async () => {
  const events: Array<{ type: string }> = [];
  for await (const ev of spawnLineStream({
    runId: "spawn-missing-check",
    cmd: ["___no_such_binary___cfa_check"],
    cwd: process.cwd(),
    parseLine: () => [],
    timeoutMs: 5000,
  })) {
    events.push(ev as { type: string });
  }
  expect(events.some((e) => e.type === "error")).toBe(true);
  expect(events.some((e) => e.type === "done")).toBe(true);
});
