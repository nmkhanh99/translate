import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const root = mkdtempSync(join(tmpdir(), "cfa-pdf-runtime-"));
const fakePython = join(root, "fake-python.cjs");
const eventsFile = join(root, "events.jsonl");
const pdf = join(root, "sample.pdf");

writeFileSync(
  fakePython,
  `#!/usr/bin/env node
const fs = require("node:fs");
const code = process.argv[3] || "";
const page = Number(process.argv[5] || 0);
const event = (kind) => fs.appendFileSync(
  process.env.PDF_TEST_EVENTS,
  JSON.stringify({ kind, pid: process.pid, page, dpi: Number(process.argv[6] || 0) }) + "\\n"
);
event("start");
const delay = code.includes("get_pixmap") && page === 11 ? 180 : 80;
setTimeout(() => {
  event("end");
  if (code.includes('get_text("dict"')) {
    process.stdout.write(JSON.stringify({
      page_size: [612, 792],
      spans: [{ id: "t0", text: "hello", box: [1, 2, 3, 4], font_size: 10 }],
    }));
  } else if (code.includes("get_pixmap")) {
    process.stdout.write(Buffer.from([137, 80, 78, 71, page & 255]));
  } else {
    process.stdout.write("7\\n");
  }
}, delay);
`
);
chmodSync(fakePython, 0o755);
writeFileSync(eventsFile, "");
writeFileSync(pdf, "fake-pdf");
process.env.CFA_ROOT_DIR = root;
process.env.CFA_PYTHON = fakePython;
process.env.PDF_TEST_EVENTS = eventsFile;

const {
  extractPageText,
  loadRenderReportPage,
  pdfPageCount,
  renderPagePng,
} = await import("./volumes.js");

after(() => rmSync(root, { recursive: true, force: true }));

function events() {
  const text = readFileSync(eventsFile, "utf8").trim();
  return text
    ? text.split("\n").map((line) => JSON.parse(line) as {
        kind: "start" | "end";
        pid: number;
        page: number;
        dpi: number;
      })
    : [];
}

function starts() {
  return events().filter((event) => event.kind === "start");
}

describe("PDF runtime", () => {
  it("returns immediately, dedupes work, persists caches, and invalidates on replace", async () => {
    const callStarted = performance.now();
    const firstCount = pdfPageCount(pdf);
    assert.ok(firstCount instanceof Promise);
    assert.ok(performance.now() - callStarted < 30, "page count blocked the event loop");
    assert.equal(await firstCount, 7);
    assert.equal(await pdfPageCount(pdf), 7);
    assert.equal(starts().length, 1, "page count cache missed");

    const [textA, textB] = await Promise.all([
      extractPageText(pdf, 0),
      extractPageText(pdf, 0),
    ]);
    assert.deepEqual(textA, textB);
    assert.equal(starts().length, 2, "text request was not deduped");

    const [pngA, pngB] = await Promise.all([
      renderPagePng(pdf, 0, 150),
      renderPagePng(pdf, 0, 150),
    ]);
    assert.deepEqual(pngA, pngB);
    assert.equal(starts().length, 3, "raster request was not deduped");
    assert.ok(
      readdirSync(join(root, "tool", "pagecache")).some((name) => name.endsWith(".json")),
      "text layer was not persisted"
    );

    const old = statSync(pdf);
    const replacement = join(root, "replacement.pdf");
    writeFileSync(replacement, "new--pdf");
    utimesSync(replacement, old.atime, old.mtime);
    renameSync(replacement, pdf);
    assert.equal(await pdfPageCount(pdf), 7);
    assert.equal(starts().length, 4, "atomic file replacement reused a stale count");
  });

  it("bounds Python concurrency and prioritizes reader work over thumbnails", async () => {
    writeFileSync(eventsFile, "");
    await Promise.all([
      renderPagePng(pdf, 1, 101),
      renderPagePng(pdf, 2, 102),
      renderPagePng(pdf, 3, 103),
      renderPagePng(pdf, 4, 104),
    ]);
    let active = 0;
    let peak = 0;
    for (const event of events()) {
      active += event.kind === "start" ? 1 : -1;
      peak = Math.max(peak, active);
    }
    assert.equal(peak, 2);

    writeFileSync(eventsFile, "");
    const lowA = renderPagePng(pdf, 10, 90, "thumbnail");
    const lowB = renderPagePng(pdf, 11, 90, "thumbnail");
    const lowQueued = renderPagePng(pdf, 12, 90, "thumbnail");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const reader = renderPagePng(pdf, 13, 150, "interactive");
    await Promise.all([lowA, lowB, lowQueued, reader]);
    assert.equal(starts()[2]?.page, 13, "reader job stayed behind thumbnail backlog");
  });

  it("caches and indexes render reports by page, then reloads after atomic replace", () => {
    const workdir = join(root, "work");
    const report = join(workdir, "render_report.json");
    const first = JSON.stringify({
      segments: [
        { id: "s0", page: 0, translation: "old" },
        { id: "s1", page: 1, translation: "one" },
      ],
      page_sizes: [[612, 792], [612, 792]],
      review_count: 2,
    });
    mkdirSync(workdir, { recursive: true });
    writeFileSync(report, first);
    const page0 = loadRenderReportPage(workdir, 0);
    assert.equal(page0?.blocks.length, 1);
    assert.equal(page0?.blocks[0].translation, "old");

    const before = statSync(report);
    const replacement = join(workdir, "render_report.next.json");
    writeFileSync(replacement, first.replace('"old"', '"new"'));
    utimesSync(replacement, before.atime, before.mtime);
    renameSync(replacement, report);
    assert.equal(loadRenderReportPage(workdir, 0)?.blocks[0].translation, "new");
  });
});
