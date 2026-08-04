/**
 * Unit tests for engine resolution + pipeline-runner routing (stage redo).
 * Drives the real helpers in runs.ts — no reimplementation.
 *
 * Run: pnpm --filter @cfa-translate/daemon exec tsx --test src/engine-resolve.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginBlockUpdate,
  endBlockUpdate,
  isVolumeBusy,
  resolveEngine,
  shouldUsePipelineRunner,
} from "./runs.js";

describe("resolveEngine", () => {
  it("override wins over pref and global", () => {
    assert.equal(resolveEngine("grok", "codex", "claude"), "grok");
  });
  it("pref wins over global when no override", () => {
    assert.equal(resolveEngine(undefined, "codex", "claude"), "codex");
    assert.equal(resolveEngine(null, "grok", "claude"), "grok");
  });
  it("global when no override/pref", () => {
    assert.equal(resolveEngine(undefined, undefined, "codex"), "codex");
  });
  it("defaults to claude", () => {
    assert.equal(resolveEngine(undefined, undefined, undefined), "claude");
  });
  it("ignores invalid strings", () => {
    assert.equal(resolveEngine("not-an-engine", "also-bad", "codex"), "codex");
    assert.equal(resolveEngine("nope", "nope", "nope"), "claude");
  });
});

describe("shouldUsePipelineRunner", () => {
  it("claude full run uses runner", () => {
    assert.equal(shouldUsePipelineRunner("claude", undefined), true);
    assert.equal(shouldUsePipelineRunner("claude", null), true);
  });
  it("codex/grok full run use MCP batch (not runner)", () => {
    assert.equal(shouldUsePipelineRunner("codex", undefined), false);
    assert.equal(shouldUsePipelineRunner("grok", undefined), false);
    assert.equal(shouldUsePipelineRunner("codex", null), false);
  });
  it("any engine with runOpts (stage redo) uses runner", () => {
    // vision redo
    assert.equal(
      shouldUsePipelineRunner("codex", { only: "vision", vision: true }),
      true
    );
    assert.equal(
      shouldUsePipelineRunner("grok", {
        only: "vision",
        vision: true,
        visPages: "1,2,3",
      }),
      true
    );
    // translate/verify redo: empty object still forces runner (server sets runOpts={})
    assert.equal(shouldUsePipelineRunner("codex", {}), true);
    assert.equal(shouldUsePipelineRunner("grok", {}), true);
    assert.equal(shouldUsePipelineRunner("claude", {}), true);
  });
  it("forceRunner (stage=review Chạy để sửa) uses runner for codex/grok", () => {
    assert.equal(shouldUsePipelineRunner("codex", undefined, true), true);
    assert.equal(shouldUsePipelineRunner("grok", null, true), true);
    assert.equal(shouldUsePipelineRunner("claude", undefined, true), true);
  });
});

describe("block update lock", () => {
  it("prevents a pipeline or second save from starting for the same volume", () => {
    const workdir = mkdtempSync(join(tmpdir(), "cfa-block-lock-"));
    const vol = {
      tag: "block-lock-test",
      display: "Block lock test",
      pdf: join(workdir, "source.pdf"),
      out: join(workdir, "output.pdf"),
      workdir,
    };
    try {
      assert.equal(beginBlockUpdate(vol), true);
      assert.equal(isVolumeBusy(vol), true);
      assert.equal(beginBlockUpdate(vol), false);
      endBlockUpdate(vol.tag);
      assert.equal(isVolumeBusy(vol), false);
    } finally {
      endBlockUpdate(vol.tag);
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("honours a live Python renderer lock after a daemon restart", () => {
    const workdir = mkdtempSync(join(tmpdir(), "cfa-block-persisted-lock-"));
    const vol = {
      tag: "persisted-block-lock-test",
      display: "Persisted block lock test",
      pdf: join(workdir, "source.pdf"),
      out: join(workdir, "output.pdf"),
      workdir,
    };
    try {
      writeFileSync(
        join(workdir, "block-update.lock.json"),
        JSON.stringify({ pid: process.pid, token: "test" }),
        "utf8"
      );
      assert.equal(isVolumeBusy(vol), true);
      assert.equal(beginBlockUpdate(vol), false);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("stays busy when an interrupted transaction cannot be recovered", () => {
    const workdir = mkdtempSync(join(tmpdir(), "cfa-block-recovery-failed-"));
    const vol = {
      tag: "failed-block-recovery-test",
      display: "Failed block recovery test",
      pdf: join(workdir, "source.pdf"),
      out: join(workdir, "output.pdf"),
      workdir,
    };
    const journal = join(workdir, "block-update.txn.json");
    try {
      writeFileSync(
        join(workdir, "block-update.lock.json"),
        JSON.stringify({ pid: 2_147_483_647, token: "stale" }),
        "utf8"
      );
      writeFileSync(journal, "{bad", "utf8");
      assert.equal(isVolumeBusy(vol), true);
      assert.equal(existsSync(journal), true);
      assert.equal(beginBlockUpdate(vol), false);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("redo must not require claude brand", () => {
  it("codex+empty runOpts is allowed path (runner), not blocked", () => {
    const engine = resolveEngine("codex", "codex", "claude");
    assert.equal(engine, "codex");
    // Historical bug: server 400 when effEngine !== "claude". Decision helpers
    // must still route redo through runner so launch can proceed.
    assert.equal(shouldUsePipelineRunner(engine, {}), true);
  });
  it("pref grok + no body engine + vision redo → runner", () => {
    const engine = resolveEngine(undefined, "grok", "claude");
    assert.equal(engine, "grok");
    assert.equal(
      shouldUsePipelineRunner(engine, { only: "vision", vision: true }),
      true
    );
  });
});
