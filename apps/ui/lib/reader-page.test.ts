import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampReaderZoom,
  readerZoomFromWheel,
  validReaderPage,
} from "./reader-page.js";

describe("validReaderPage", () => {
  it("accepts whole pages inside the document", () => {
    assert.equal(validReaderPage("1", 20), 1);
    assert.equal(validReaderPage(" 12 ", 20), 12);
    assert.equal(validReaderPage(20, 20), 20);
  });

  it("rejects blank, fractional and out-of-range pages", () => {
    assert.equal(validReaderPage("", 20), null);
    assert.equal(validReaderPage("1.5", 20), null);
    assert.equal(validReaderPage(true, 20), null);
    assert.equal(validReaderPage(0, 20), null);
    assert.equal(validReaderPage(21, 20), null);
    assert.equal(validReaderPage(1, 0), null);
  });
});

describe("reader zoom", () => {
  it("clamps zoom to the supported range", () => {
    assert.equal(clampReaderZoom(0.1), 0.5);
    assert.equal(clampReaderZoom(3), 2.5);
    assert.equal(clampReaderZoom(Number.NaN), 1);
  });

  it("maps trackpad wheel direction to zoom direction", () => {
    assert.ok(readerZoomFromWheel(1, -20) > 1);
    assert.ok(readerZoomFromWheel(1, 20) < 1);
    assert.equal(readerZoomFromWheel(2.5, -200), 2.5);
    assert.equal(readerZoomFromWheel(0.5, 200), 0.5);
  });
});
