import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SELECTION_TRANSLATION_MAX_LENGTH,
  SelectionTranslationError,
  parseGoogleSelectionTranslation,
  translateSelection,
  validateSelectionTranslationInput,
} from "./selection-translation.js";

describe("selection translation input", () => {
  it("trims text and defaults target to Vietnamese", () => {
    assert.deepEqual(validateSelectionTranslationInput({ text: "  Hello\n " }), {
      ok: true,
      value: { text: "Hello", target: "vi" },
    });
    assert.deepEqual(validateSelectionTranslationInput({ text: "Xin chào", target: "en" }), {
      ok: true,
      value: { text: "Xin chào", target: "en" },
    });
  });

  it("rejects malformed, blank, oversized, unsupported, and extra fields", () => {
    for (const body of [
      null,
      [],
      { text: 42 },
      { text: "   " },
      { text: "x".repeat(SELECTION_TRANSLATION_MAX_LENGTH + 1) },
      { text: "hello", target: "fr" },
      { text: "hello", target: null },
      { text: "hello", extra: true },
    ]) {
      assert.equal(validateSelectionTranslationInput(body).ok, false);
    }
  });
});

describe("Google selection translation response", () => {
  it("joins translated sentence fragments and reports detected language", () => {
    assert.deepEqual(
      parseGoogleSelectionTranslation(
        {
          sentences: [
            { trans: "Xin chào ", orig: "Hello " },
            { backend: 3 },
            { trans: "thế giới", orig: "world" },
          ],
          src: " en ",
        },
        "vi"
      ),
      {
        translation: "Xin chào thế giới",
        detected_language: "en",
        target_language: "vi",
      }
    );
  });

  it("uses null when Google omits a detected language", () => {
    assert.deepEqual(
      parseGoogleSelectionTranslation({ sentences: [{ trans: "Hello" }] }, "en"),
      {
        translation: "Hello",
        detected_language: null,
        target_language: "en",
      }
    );
  });

  it("rejects array-shaped and incomplete responses", () => {
    for (const payload of [null, [], {}, { sentences: [] }, { sentences: [{ orig: "Hello" }] }]) {
      assert.throws(
        () => parseGoogleSelectionTranslation(payload, "vi"),
        (error) => error instanceof SelectionTranslationError && error.code === "invalid_response"
      );
    }
  });
});

describe("Google selection translation request", () => {
  it("uses the fixed endpoint, dj object response, and caller target", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const result = await translateSelection(
      { text: "Hello world", target: "vi" },
      {
        timeoutMs: 1_000,
        fetchImpl: async (url, init) => {
          seenUrl = String(url);
          seenInit = init;
          return new Response(
            JSON.stringify({ sentences: [{ trans: "Xin chào thế giới" }], src: "en" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        },
      }
    );

    assert.equal(seenUrl, "https://translate.googleapis.com/translate_a/single");
    assert.equal(seenInit?.method, "POST");
    const form = new URLSearchParams(String(seenInit?.body));
    assert.deepEqual(Object.fromEntries(form), {
      client: "gtx",
      sl: "auto",
      tl: "vi",
      dt: "t",
      dj: "1",
      q: "Hello world",
    });
    assert.deepEqual(result, {
      translation: "Xin chào thế giới",
      detected_language: "en",
      target_language: "vi",
    });
  });

  it("maps caller timeout and upstream failures to typed errors", async () => {
    await assert.rejects(
      translateSelection(
        { text: "Hello", target: "vi" },
        {
          timeoutMs: 5,
          fetchImpl: async (_url, init) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            }),
        }
      ),
      (error) => error instanceof SelectionTranslationError && error.code === "timeout"
    );

    await assert.rejects(
      translateSelection(
        { text: "Hello", target: "vi" },
        {
          timeoutMs: 1_000,
          fetchImpl: async () => new Response("unavailable", { status: 503 }),
        }
      ),
      (error) => error instanceof SelectionTranslationError && error.code === "upstream"
    );
  });
});
