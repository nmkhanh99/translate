import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type { AppConfig } from "@cfa-translate/shared";
import type { VolumeRec } from "./volumes.js";

const root = mkdtempSync(join(tmpdir(), "cfa-run-lifecycle-"));
const pythonDir = join(root, "python");
const fakePython = join(root, "fake-python.cjs");
const eventsFile = join(root, "events.jsonl");

mkdirSync(pythonDir, { recursive: true });
writeFileSync(join(pythonDir, "volumes.json"), "[]");
writeFileSync(join(pythonDir, "agent_pipeline.py"), "# fake entrypoint\n");
writeFileSync(eventsFile, "");
writeFileSync(
  fakePython,
  `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const op = process.argv[3] || "unknown";
const workdir = op === "prepare" ? process.argv[5] : process.argv[4];
const name = path.basename(workdir || "missing");
const event = (kind) => fs.appendFileSync(
  process.env.RUN_LIFECYCLE_EVENTS,
  JSON.stringify({ kind, op, name, pid: process.pid }) + "\\n"
);
event("start");
let delay = 100;
if (name.includes("fast")) delay = 80;
if (name.includes("slow")) delay = 220;
if (op === "recover-block-update") delay = 40;
setTimeout(() => {
  if (op === "recover-block-update") {
    if (name.includes("failed")) {
      event("end");
      process.exit(7);
      return;
    }
    for (const file of ["block-update.lock.json", "block-update.txn.json"]) {
      try { fs.unlinkSync(path.join(workdir, file)); } catch {}
    }
    process.stdout.write("{}\\n");
  } else {
    process.stdout.write(JSON.stringify({
      invalidation: null,
      removed: [],
      source_sha256: "a".repeat(64),
    }) + "\\n");
  }
  event("end");
}, delay);
`
);
chmodSync(fakePython, 0o755);

process.env.CFA_ROOT_DIR = root;
process.env.CFA_PYTHON_DIR = pythonDir;
process.env.CFA_PYTHON = fakePython;
process.env.RUN_LIFECYCLE_EVENTS = eventsFile;

const {
  BATCH,
  batchStart,
  batchStop,
  beginBlockUpdate,
  isVolumeBusy,
  launchVolume,
  prepareVolumeArtifacts,
  recoverInterruptedBlockUpdate,
} = await import("./runs.js");

after(() => rmSync(root, { recursive: true, force: true }));

const config = {
  engine: "claude",
  model: "default",
  posture: "allowlist",
  vision: true,
  agents: 1,
  codex_batch: 25,
} as AppConfig;

function volume(name: string): VolumeRec {
  const workdir = join(root, "work", name);
  const pdf = join(root, "pdf", `${name}.pdf`);
  mkdirSync(workdir, { recursive: true });
  mkdirSync(dirname(pdf), { recursive: true });
  writeFileSync(pdf, "fake pdf");
  return {
    tag: name,
    display: name,
    pdf,
    workdir,
    out: join(root, "output", `${name}.pdf`),
  };
}

function events(): Array<{
  kind: "start" | "end";
  op: string;
  name: string;
  pid: number;
}> {
  const text = readFileSync(eventsFile, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function peakConcurrency(rows = events()): number {
  let active = 0;
  let peak = 0;
  for (const event of rows) {
    active += event.kind === "start" ? 1 : -1;
    peak = Math.max(peak, active);
  }
  return peak;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 6000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("async run lifecycle", { concurrency: false }, () => {
  it("runs prepare/recovery in a two-process pool and prioritizes recovery", async () => {
    const startedAt = performance.now();
    const firstBatch = Promise.all(
      ["pool-a", "pool-b", "pool-c", "pool-d"].map((name) =>
        prepareVolumeArtifacts(volume(name))
      )
    );
    assert.ok(performance.now() - startedAt < 30, "prepare blocked the event loop");
    assert.ok((await firstBatch).every((result) => result.ok));
    assert.equal(peakConcurrency(), 2);

    writeFileSync(eventsFile, "");
    const fast = prepareVolumeArtifacts(volume("priority-fast"));
    const slow = prepareVolumeArtifacts(volume("priority-slow"));
    const queued = prepareVolumeArtifacts(volume("priority-queued"));
    await new Promise((resolve) => setTimeout(resolve, 15));

    const recoveryVolume = volume("priority-recovery");
    writeFileSync(join(recoveryVolume.workdir, "block-update.lock.json"), "{}");
    writeFileSync(join(recoveryVolume.workdir, "block-update.txn.json"), "{}");
    const recoveryA = recoverInterruptedBlockUpdate(recoveryVolume);
    const recoveryB = recoverInterruptedBlockUpdate(recoveryVolume);
    assert.strictEqual(recoveryA, recoveryB, "recovery request was not deduped");

    const [, , , recovered] = await Promise.all([fast, slow, queued, recoveryA]);
    assert.equal(recovered, true);
    const starts = events().filter((event) => event.kind === "start");
    assert.ok(
      starts.findIndex((event) => event.name === "priority-recovery") <
        starts.findIndex((event) => event.name === "priority-queued"),
      "recovery stayed behind queued prepare work"
    );
    assert.equal(peakConcurrency(), 2);
    assert.equal(isVolumeBusy(recoveryVolume), false);
  });

  it("keeps recovery fail-closed without blocking the event loop", async () => {
    writeFileSync(eventsFile, "");
    const vol = volume("failed-recovery");
    const lock = join(vol.workdir, "block-update.lock.json");
    const journal = join(vol.workdir, "block-update.txn.json");
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647 }));
    writeFileSync(journal, "{bad");

    const startedAt = performance.now();
    assert.equal(isVolumeBusy(vol), true);
    assert.ok(performance.now() - startedAt < 30, "recovery blocked the event loop");
    assert.equal(beginBlockUpdate(vol), false);
    assert.equal(await recoverInterruptedBlockUpdate(vol), false);
    assert.equal(existsSync(lock), true);
    assert.equal(existsSync(journal), true);

    assert.equal(isVolumeBusy(vol), true, "failed recovery released the lock");
    assert.equal(await recoverInterruptedBlockUpdate(vol), false);
  });

  it("holds the starting lock across prepare and releases it on cancellation", async () => {
    writeFileSync(eventsFile, "");
    const vol = volume("cancelled-launch");
    let cancelled = false;
    const startedAt = performance.now();
    const first = launchVolume(vol, config, "claude", undefined, {
      cancelled: () => cancelled,
    });
    assert.ok(performance.now() - startedAt < 30, "launch prepare blocked the event loop");

    const duplicate = await launchVolume(vol, config, "claude");
    assert.deepEqual(duplicate, { ok: false, error: "đang chạy" });
    cancelled = true;
    assert.deepEqual(await first, { ok: false, error: "đã hủy" });
    assert.equal(isVolumeBusy(vol), false, "starting lock leaked after cancellation");
    assert.equal(existsSync(join(vol.workdir, "run.json")), false);
    assert.deepEqual(
      events().filter((event) => event.kind === "start").map((event) => event.op),
      ["prepare"]
    );
  });

  it("skips a cancelled prepare before it takes a pool slot", async () => {
    writeFileSync(eventsFile, "");
    const blockerA = prepareVolumeArtifacts(volume("queued-cancel-slow-a"));
    const blockerB = prepareVolumeArtifacts(volume("queued-cancel-slow-b"));
    await waitFor(
      () => events().filter((event) => event.kind === "start").length === 2,
      "pool blockers did not start"
    );

    const vol = volume("queued-cancel-target");
    let cancelled = false;
    const launch = launchVolume(vol, config, "claude", undefined, {
      cancelled: () => cancelled,
    });
    cancelled = true;

    assert.deepEqual(await launch, { ok: false, error: "đã hủy" });
    await Promise.all([blockerA, blockerB]);
    assert.equal(
      events().some((event) => event.name === "queued-cancel-target"),
      false,
      "cancelled queued prepare still spawned Python"
    );
    assert.equal(isVolumeBusy(vol), false);
  });

  it("wires batch generation cancellation into launch", () => {
    const source = readFileSync(new URL("./runs.ts", import.meta.url), "utf8");
    const batch = source.slice(source.indexOf("async function runBatch"));
    assert.match(batch, /cancelled:\s*\(\)\s*=>\s*!alive\(\)/);
    assert.match(batch, /if \(!alive\(\)\)[\s\S]*stopVolume\(vol\)/);
  });

  it("cancels an in-flight batch prepare and preserves a quick restart", async () => {
    writeFileSync(eventsFile, "");
    const vol = volume("batch-cancel-restart");
    writeFileSync(
      join(pythonDir, "volumes.json"),
      JSON.stringify([{
        pdf: vol.pdf,
        workdir: vol.workdir,
        out: vol.out,
        vision: true,
      }])
    );

    try {
      assert.equal(batchStart(config, 1), true);
      await waitFor(
        () => events().filter((event) => event.kind === "start").length >= 1,
        "first batch prepare did not start"
      );
      batchStop();

      // The previous generation still owns `starting` until its async prepare
      // settles. The new generation must requeue, not lose this volume.
      assert.equal(batchStart(config, 1), true);
      await waitFor(
        () => events().filter((event) => event.kind === "start").length >= 2,
        "restarted batch dropped the volume while old prepare was settling"
      );
      batchStop();
      await waitFor(
        () => events().filter((event) => event.kind === "end").length >= 2,
        "cancelled prepares did not settle"
      );
      await waitFor(
        () => !isVolumeBusy(vol),
        "starting lock remained after batch cancellation"
      );

      assert.equal(BATCH.active, false);
      assert.deepEqual(BATCH.queue, []);
      assert.equal(existsSync(join(vol.workdir, "run.json")), false);
      assert.deepEqual(
        events().filter((event) => event.kind === "start").map((event) => event.op),
        ["prepare", "prepare"]
      );
    } finally {
      batchStop();
      writeFileSync(join(pythonDir, "volumes.json"), "[]");
    }
  });
});
