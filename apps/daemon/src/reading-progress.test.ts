import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReadingBookmark, saveReadingBookmark } from "./reading-progress.js";

function withProgressFile(run: (filePath: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cfa-reading-progress-"));
  try {
    run(join(dir, "reading-progress.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("reading progress persistence", () => {
  it("stores and overwrites one bookmark per document", () => {
    withProgressFile((filePath) => {
      assert.equal(getReadingBookmark("v1", filePath), null);

      saveReadingBookmark("v1", 18, filePath);
      saveReadingBookmark("v2", 7, filePath);
      saveReadingBookmark("v1", 23, filePath);

      assert.equal(getReadingBookmark("v1", filePath), 23);
      assert.equal(getReadingBookmark("v2", filePath), 7);
    });
  });

  it("ignores corrupt and invalid stored values", () => {
    withProgressFile((filePath) => {
      writeFileSync(filePath, "not-json", "utf8");
      assert.equal(getReadingBookmark("v1", filePath), null);

      writeFileSync(
        filePath,
        JSON.stringify({ version: 1, bookmarks: { good: 4, zero: 0, decimal: 2.5, text: "3" } }),
        "utf8"
      );
      assert.equal(getReadingBookmark("good", filePath), 4);
      assert.equal(getReadingBookmark("zero", filePath), null);
      assert.equal(getReadingBookmark("decimal", filePath), null);
      assert.equal(getReadingBookmark("text", filePath), null);
    });
  });

  it("rejects invalid writes", () => {
    withProgressFile((filePath) => {
      assert.throws(() => saveReadingBookmark("", 1, filePath));
      assert.throws(() => saveReadingBookmark("v1", 0, filePath));
      assert.throws(() => saveReadingBookmark("v1", 1.5, filePath));
    });
  });
});
