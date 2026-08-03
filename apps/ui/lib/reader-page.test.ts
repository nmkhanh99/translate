import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validReaderPage } from "./reader-page.js";

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
