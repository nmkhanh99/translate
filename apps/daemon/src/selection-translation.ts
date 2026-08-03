export const SELECTION_TRANSLATION_MAX_LENGTH = 4_000;

export type SelectionTranslationTarget = "vi" | "en";

export interface SelectionTranslationInput {
  text: string;
  target: SelectionTranslationTarget;
}

export interface SelectionTranslationResult {
  translation: string;
  detected_language: string | null;
  target_language: SelectionTranslationTarget;
}

export type SelectionTranslationValidation =
  | { ok: true; value: SelectionTranslationInput }
  | { ok: false; error: string };

export type SelectionTranslationErrorCode =
  | "timeout"
  | "upstream"
  | "invalid_response";

export class SelectionTranslationError extends Error {
  readonly code: SelectionTranslationErrorCode;

  constructor(code: SelectionTranslationErrorCode, message: string) {
    super(message);
    this.name = "SelectionTranslationError";
    this.code = code;
  }
}

export function validateSelectionTranslationInput(
  body: unknown
): SelectionTranslationValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body phải là object" };
  }

  const input = body as Record<string, unknown>;
  const extra = Object.keys(input).find((key) => key !== "text" && key !== "target");
  if (extra) return { ok: false, error: `field không hỗ trợ: ${extra}` };
  if (typeof input.text !== "string") {
    return { ok: false, error: "text phải là string" };
  }

  const text = input.text.trim();
  if (!text || text.length > SELECTION_TRANSLATION_MAX_LENGTH) {
    return {
      ok: false,
      error: `text phải có từ 1 đến ${SELECTION_TRANSLATION_MAX_LENGTH} ký tự`,
    };
  }

  const target = input.target === undefined ? "vi" : input.target;
  if (target !== "vi" && target !== "en") {
    return { ok: false, error: "target phải là vi hoặc en" };
  }

  return { ok: true, value: { text, target } };
}

export function parseGoogleSelectionTranslation(
  payload: unknown,
  target: SelectionTranslationTarget
): SelectionTranslationResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SelectionTranslationError(
      "invalid_response",
      "Google Dịch trả về dữ liệu không hợp lệ"
    );
  }

  const data = payload as Record<string, unknown>;
  if (!Array.isArray(data.sentences)) {
    throw new SelectionTranslationError(
      "invalid_response",
      "Google Dịch không trả về danh sách câu"
    );
  }

  const translation = data.sentences
    .flatMap((sentence) => {
      if (!sentence || typeof sentence !== "object" || Array.isArray(sentence)) return [];
      const value = (sentence as Record<string, unknown>).trans;
      return typeof value === "string" ? [value] : [];
    })
    .join("")
    .trim();
  if (!translation) {
    throw new SelectionTranslationError(
      "invalid_response",
      "Google Dịch không trả về nội dung bản dịch"
    );
  }

  const source = typeof data.src === "string" ? data.src.trim() : "";
  return {
    translation,
    detected_language: source || null,
    target_language: target,
  };
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface TranslateSelectionOptions {
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

const GOOGLE_TRANSLATE_ENDPOINT =
  "https://translate.googleapis.com/translate_a/single";

export async function translateSelection(
  input: SelectionTranslationInput,
  options: TranslateSelectionOptions
): Promise<SelectionTranslationResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError("timeoutMs phải lớn hơn 0");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const body = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: input.target,
    dt: "t",
    dj: "1",
    q: input.text,
  });

  try {
    let response: Response;
    try {
      response = await (options.fetchImpl || globalThis.fetch)(GOOGLE_TRANSLATE_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SelectionTranslationError("timeout", "Google Dịch phản hồi quá lâu");
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new SelectionTranslationError(
        "upstream",
        detail ? `Không kết nối được Google Dịch: ${detail}` : "Không kết nối được Google Dịch"
      );
    }

    if (!response.ok) {
      throw new SelectionTranslationError(
        "upstream",
        `Google Dịch trả về HTTP ${response.status}`
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new SelectionTranslationError("timeout", "Google Dịch phản hồi quá lâu");
      }
      throw new SelectionTranslationError(
        "invalid_response",
        "Google Dịch trả về JSON không hợp lệ"
      );
    }
    return parseGoogleSelectionTranslation(payload, input.target);
  } finally {
    clearTimeout(timeout);
  }
}
