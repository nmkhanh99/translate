import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createReaderAnnotation,
  deleteReaderAnnotation,
  listReaderAnnotations,
  MAX_READER_ANNOTATION_NOTE_LENGTH,
  MAX_READER_ANNOTATION_RECTS,
  MAX_READER_ANNOTATION_TEXT_LENGTH,
  MAX_SAVED_READER_ANNOTATIONS,
  type ReaderAnnotation,
  validateReaderAnnotationInput,
} from "./reader-annotations.js";

const CREATED = "2026-08-02T00:00:00.000Z";
const UPDATED = "2026-08-02T00:01:00.000Z";

function annotation(
  id = "a1",
  overrides: Partial<ReaderAnnotation> = {}
): ReaderAnnotation {
  return {
    id,
    tag: "book-v1",
    page: 7,
    side: "source",
    kind: "highlight",
    text: "Selected paragraph",
    note: "",
    rects: [{ x: 0.1, y: 0.2, width: 0.7, height: 0.1 }],
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

function withWorkdir(run: (workdir: string) => void) {
  const workdir = mkdtempSync(join(tmpdir(), "cfa-reader-annotations-"));
  try {
    run(workdir);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

describe("reader annotation persistence", () => {
  it("creates, replaces, lists and deletes annotations atomically", () => {
    withWorkdir((workdir) => {
      assert.deepEqual(listReaderAnnotations(workdir), []);

      createReaderAnnotation(workdir, annotation("a1"));
      createReaderAnnotation(workdir, annotation("a2", {
        side: "translated",
        kind: "note",
        text: "Đoạn đã dịch",
        note: "Ôn lại công thức này",
        rects: [
          { x: 0, y: 0, width: 1, height: 0.1 },
          { x: 0.2, y: 0.2, width: 0.2, height: 0.05 },
        ],
      }));

      assert.deepEqual(listReaderAnnotations(workdir).map((item) => item.id), ["a2", "a1"]);
      const saved = JSON.parse(
        readFileSync(join(workdir, "reader_annotations.json"), "utf8")
      );
      assert.equal(saved.version, 1);
      assert.equal(saved.annotations.length, 2);
      assert.deepEqual(
        readdirSync(workdir).filter((name) => name.includes(".tmp-")),
        []
      );

      createReaderAnnotation(workdir, annotation("a1", {
        text: "Replacement selection",
        updated_at: UPDATED,
      }));
      const replaced = listReaderAnnotations(workdir);
      assert.deepEqual(replaced.map((item) => item.id), ["a1", "a2"]);
      assert.equal(replaced[0].text, "Replacement selection");
      assert.equal(replaced[0].updated_at, UPDATED);

      assert.equal(deleteReaderAnnotation(workdir, "missing"), false);
      assert.equal(deleteReaderAnnotation(workdir, " a2 "), false);
      assert.equal(deleteReaderAnnotation(workdir, "a2"), true);
      assert.deepEqual(listReaderAnnotations(workdir).map((item) => item.id), ["a1"]);
    });
  });

  it("tolerates corrupt files and ignores malformed stored rows", () => {
    withWorkdir((workdir) => {
      const path = join(workdir, "reader_annotations.json");
      writeFileSync(path, "not-json", "utf8");
      assert.deepEqual(listReaderAnnotations(workdir), []);
      assert.equal(deleteReaderAnnotation(workdir, "a1"), false);

      writeFileSync(path, JSON.stringify({ version: 2, annotations: [annotation()] }), "utf8");
      assert.deepEqual(listReaderAnnotations(workdir), []);

      writeFileSync(path, JSON.stringify({
        version: 1,
        annotations: [
          { ...annotation("bad-page"), page: 0 },
          { ...annotation("bad-time"), updated_at: "yesterday" },
          annotation("good"),
        ],
      }), "utf8");
      assert.deepEqual(listReaderAnnotations(workdir).map((item) => item.id), ["good"]);
    });
  });

  it("bounds the file and keeps the newest annotation first", () => {
    withWorkdir((workdir) => {
      const annotations = Array.from(
        { length: MAX_SAVED_READER_ANNOTATIONS + 5 },
        (_, index) => annotation(`seed-${index}`)
      );
      writeFileSync(
        join(workdir, "reader_annotations.json"),
        JSON.stringify({ version: 1, annotations }),
        "utf8"
      );

      assert.equal(listReaderAnnotations(workdir).length, MAX_SAVED_READER_ANNOTATIONS);
      createReaderAnnotation(workdir, annotation("newest"));
      const saved = listReaderAnnotations(workdir);
      assert.equal(saved.length, MAX_SAVED_READER_ANNOTATIONS);
      assert.equal(saved[0].id, "newest");
      assert.equal(saved.some((item) => item.id === `seed-${MAX_SAVED_READER_ANNOTATIONS - 1}`), false);
    });
  });
});

describe("reader annotation validation", () => {
  it("accepts bounded input without coercion and trims user text", () => {
    const parsed = validateReaderAnnotationInput({
      page: 2,
      side: "translated",
      kind: "note",
      text: "  Định giá trái phiếu  ",
      note: "  Xem lại trước kỳ thi  ",
      rects: [{ x: 0, y: 0.1, width: 1, height: 0.1 }],
    }, 3);
    assert.deepEqual(parsed, {
      ok: true,
      value: {
        page: 2,
        side: "translated",
        kind: "note",
        text: "Định giá trái phiếu",
        note: "Xem lại trước kỳ thi",
        rects: [{ x: 0, y: 0.1, width: 1, height: 0.1 }],
      },
    });

    assert.deepEqual(validateReaderAnnotationInput({
      page: 1,
      side: "source",
      kind: "highlight",
      text: "CAPM",
      rects: [{ x: 0.25, y: 0.25, width: 0.25, height: 0.25 }],
    }, 1), {
      ok: true,
      value: {
        page: 1,
        side: "source",
        kind: "highlight",
        text: "CAPM",
        note: "",
        rects: [{ x: 0.25, y: 0.25, width: 0.25, height: 0.25 }],
      },
    });
  });

  it("rejects invalid pages, enums, strings and note invariants", () => {
    const base = {
      page: 1,
      side: "source",
      kind: "highlight",
      text: "Selected",
      note: "",
      rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }],
    };
    const invalid = [
      [base, 0],
      [{ ...base, page: "1" }, 2],
      [{ ...base, page: 0 }, 2],
      [{ ...base, page: 3 }, 2],
      [{ ...base, side: "both" }, 2],
      [{ ...base, kind: "bookmark" }, 2],
      [{ ...base, text: 123 }, 2],
      [{ ...base, text: "   " }, 2],
      [{ ...base, text: "x".repeat(MAX_READER_ANNOTATION_TEXT_LENGTH + 1) }, 2],
      [{ ...base, note: 123 }, 2],
      [{ ...base, note: "x".repeat(MAX_READER_ANNOTATION_NOTE_LENGTH + 1) }, 2],
      [{ ...base, kind: "note", note: "   " }, 2],
    ] as const;
    for (const [body, pages] of invalid) {
      assert.equal(validateReaderAnnotationInput(body, pages).ok, false);
    }
  });

  it("rejects missing, excessive and non-normalized rectangles", () => {
    const base = {
      page: 1,
      side: "source",
      kind: "highlight",
      text: "Selected",
      note: "",
    };
    const invalidRects: unknown[] = [
      undefined,
      [],
      [{ x: 0, y: 0, width: 0, height: 0.1 }],
      [{ x: 0, y: 0, width: 0.1, height: 0 }],
      [{ x: -0.1, y: 0, width: 0.1, height: 0.1 }],
      [{ x: 0, y: 0, width: 1.1, height: 0.1 }],
      [{ x: 0, y: 0, width: Number.NaN, height: 0.1 }],
      [{ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 0.1 }],
      [{ x: 0, y: 0, width: "0.1", height: 0.1 }],
      [{ x: 0, y: 0, width: 0.1 }],
      [{ x: 0, y: 0, width: 0.1, height: 0.1, extra: 0 }],
      Array.from({ length: MAX_READER_ANNOTATION_RECTS + 1 }, () => ({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      })),
    ];
    for (const rects of invalidRects) {
      assert.equal(validateReaderAnnotationInput({ ...base, rects }, 1).ok, false);
    }
  });

  it("rejects malformed complete records before writing", () => {
    withWorkdir((workdir) => {
      const invalid: ReaderAnnotation[] = [
        annotation(" bad-id"),
        annotation("a1", { tag: "bad-tag\n" }),
        annotation("a1", { page: 0 }),
        annotation("a1", { text: " untrimmed" }),
        annotation("a1", { note: "untrimmed " }),
        annotation("a1", { kind: "note", note: "" }),
        annotation("a1", { created_at: "2026-08-02" }),
        annotation("a1", { updated_at: "invalid" }),
      ];
      for (const item of invalid) {
        assert.throws(() => createReaderAnnotation(workdir, item), /không hợp lệ/);
      }
      assert.deepEqual(listReaderAnnotations(workdir), []);
    });
  });
});
