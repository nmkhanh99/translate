import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampReaderSplitRatio,
  clampReaderZoom,
  readerSplitRatioFromPointer,
  readerZoomFromWheel,
  READER_SPLIT_CENTER,
  setReaderPaneZoom,
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

  it("updates source and translated pane zoom independently", () => {
    const initial = { source: 1, translated: 1.4 };
    const sourceChanged = setReaderPaneZoom(initial, "source", 1.8);
    assert.deepEqual(sourceChanged, { source: 1.8, translated: 1.4 });
    assert.deepEqual(initial, { source: 1, translated: 1.4 });

    const translatedChanged = setReaderPaneZoom(
      sourceChanged,
      "translated",
      readerZoomFromWheel(sourceChanged.translated, -20)
    );
    assert.equal(translatedChanged.source, 1.8);
    assert.ok(translatedChanged.translated > 1.4);
    assert.equal(setReaderPaneZoom(translatedChanged, "source", 99).source, 2.5);
  });
});

describe("reader split", () => {
  it("clamps pane ratios while keeping an equal reset point", () => {
    assert.equal(clampReaderSplitRatio(5), 20);
    assert.equal(clampReaderSplitRatio(68), 68);
    assert.equal(clampReaderSplitRatio(95), 80);
    assert.equal(clampReaderSplitRatio(Number.NaN), READER_SPLIT_CENTER);
  });

  it("maps the divider center to the available two-pane width", () => {
    assert.equal(readerSplitRatioFromPointer(500, 0, 1000, 28), 50);
    assert.equal(readerSplitRatioFromPointer(208.4, 0, 1000, 28), 20);
    assert.equal(readerSplitRatioFromPointer(791.6, 0, 1000, 28), 80);
    assert.equal(readerSplitRatioFromPointer(500, 0, 20, 28), 50);
  });
});
