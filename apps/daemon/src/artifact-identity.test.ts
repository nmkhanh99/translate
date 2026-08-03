import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { userDocumentTag } from "./volumes.js";

describe("content-addressed user document identity", () => {
  it("includes content id so a replacement cannot reuse the old workdir", () => {
    const a = userDocumentTag("report.pdf", "a".repeat(64));
    const b = userDocumentTag("report.pdf", "b".repeat(64));
    assert.notEqual(a, b);
    assert.match(a, /^user_report_[a-f0-9]{6}_a{12}$/);
  });

  it("disambiguates filenames that collapse to the same readable slug", () => {
    const id = "c".repeat(64);
    assert.notEqual(userDocumentTag("a-b.pdf", id), userDocumentTag("a_b.pdf", id));
  });

  it("normalises Unicode filename identity deterministically", () => {
    const id = "d".repeat(64);
    assert.equal(
      userDocumentTag("Cafe\u0301.pdf", id),
      userDocumentTag("Café.pdf", id)
    );
  });
});
