import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig, Volume } from "@cfa-translate/shared";
import { createStatusVolumeCache } from "./status-cache.js";

const config = {} as AppConfig;
const first = [{ tag: "first", display: "First", stage: "translate" }] as Volume[];
const next = [{ tag: "next", display: "Next", stage: "done" }] as Volume[];

describe("status volume snapshot cache", () => {
  it("returns the current snapshot while one background refresh is shared", async () => {
    let scans = 0;
    let finish!: (volumes: Volume[]) => void;
    const cache = createStatusVolumeCache(first, () => {
      scans++;
      return new Promise<Volume[]>((resolve) => {
        finish = resolve;
      });
    });

    const refreshA = cache.refresh(config);
    const refreshB = cache.refresh(config);

    assert.equal(scans, 1);
    assert.strictEqual(refreshA, refreshB);
    assert.strictEqual(cache.get(), first);

    finish(next);
    await refreshA;
    assert.strictEqual(cache.get(), next);
  });

  it("keeps the last good snapshot when refresh fails", async () => {
    const cache = createStatusVolumeCache(first, async () => {
      throw new Error("scan failed");
    });

    assert.strictEqual(await cache.refresh(config), first);
    assert.strictEqual(cache.get(), first);
  });

  it("runs one trailing scan after a mutation supersedes in-flight work", async () => {
    const configs: AppConfig[] = [];
    const finishes: Array<(volumes: Volume[]) => void> = [];
    const cache = createStatusVolumeCache(first, (nextConfig) => {
      configs.push(nextConfig);
      return new Promise<Volume[]>((resolve) => finishes.push(resolve));
    });
    const oldConfig = { engine: "claude" } as AppConfig;
    const newConfig = { engine: "codex" } as AppConfig;

    const oldRefresh = cache.refresh(oldConfig);
    const newRefresh = cache.refresh(newConfig, true);
    finishes[0](next);
    await oldRefresh;

    assert.strictEqual(cache.get(), first, "superseded scan replaced the snapshot");
    assert.deepEqual(configs, [oldConfig, newConfig]);

    const newest = [{ tag: "newest", display: "Newest", stage: "done" }] as Volume[];
    finishes[1](newest);
    assert.strictEqual(await newRefresh, newest);
    assert.strictEqual(cache.get(), newest);
  });
});
