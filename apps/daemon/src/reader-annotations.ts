import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const READER_ANNOTATION_SIDES = ["source", "translated"] as const;
export const READER_ANNOTATION_KINDS = ["highlight", "note"] as const;

export type ReaderAnnotationSide = (typeof READER_ANNOTATION_SIDES)[number];
export type ReaderAnnotationKind = (typeof READER_ANNOTATION_KINDS)[number];
export interface ReaderAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReaderAnnotation {
  id: string;
  tag: string;
  /** Reader page number; always 1-based. */
  page: number;
  side: ReaderAnnotationSide;
  kind: ReaderAnnotationKind;
  text: string;
  note: string;
  /** Rectangles normalized to the page; each coordinate and extent is in [0, 1]. */
  rects: ReaderAnnotationRect[];
  created_at: string;
  updated_at: string;
}

export interface ReaderAnnotationInput {
  page: number;
  side: ReaderAnnotationSide;
  kind: ReaderAnnotationKind;
  text: string;
  note: string;
  rects: ReaderAnnotationRect[];
}

export const MAX_SAVED_READER_ANNOTATIONS = 2_000;
export const MAX_READER_ANNOTATION_TEXT_LENGTH = 20_000;
export const MAX_READER_ANNOTATION_NOTE_LENGTH = 4_000;
export const MAX_READER_ANNOTATION_RECTS = 256;

const FILE_VERSION = 1;
const MAX_ID_LENGTH = 128;
const MAX_TAG_LENGTH = 256;

interface ReaderAnnotationsFile {
  version: typeof FILE_VERSION;
  annotations: ReaderAnnotation[];
}

function annotationsPath(workdir: string): string {
  return join(workdir, "reader_annotations.json");
}

function isSide(value: unknown): value is ReaderAnnotationSide {
  return typeof value === "string" &&
    (READER_ANNOTATION_SIDES as readonly string[]).includes(value);
}

function isKind(value: unknown): value is ReaderAnnotationKind {
  return typeof value === "string" &&
    (READER_ANNOTATION_KINDS as readonly string[]).includes(value);
}

function isBoundedKey(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function normalizeRects(value: unknown): ReaderAnnotationRect[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_READER_ANNOTATION_RECTS
  ) {
    return null;
  }

  const rects: ReaderAnnotationRect[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const raw = candidate as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !["x", "y", "width", "height"].includes(key))) {
      return null;
    }
    const { x, y, width, height } = raw;
    if (
      typeof x !== "number" || !Number.isFinite(x) ||
      typeof y !== "number" || !Number.isFinite(y) ||
      typeof width !== "number" || !Number.isFinite(width) ||
      typeof height !== "number" || !Number.isFinite(height) ||
      x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > 1 || y + height > 1
    ) {
      return null;
    }
    rects.push({ x, y, width, height });
  }
  return rects;
}

function normalizeAnnotation(value: unknown): ReaderAnnotation | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const rects = normalizeRects(raw.rects);
  if (
    !isBoundedKey(raw.id, MAX_ID_LENGTH) ||
    !isBoundedKey(raw.tag, MAX_TAG_LENGTH) ||
    !Number.isSafeInteger(raw.page) || Number(raw.page) < 1 ||
    !isSide(raw.side) ||
    !isKind(raw.kind) ||
    typeof raw.text !== "string" ||
    raw.text.length < 1 ||
    raw.text.length > MAX_READER_ANNOTATION_TEXT_LENGTH ||
    raw.text !== raw.text.trim() ||
    typeof raw.note !== "string" ||
    raw.note.length > MAX_READER_ANNOTATION_NOTE_LENGTH ||
    raw.note !== raw.note.trim() ||
    (raw.kind === "note" && raw.note.length === 0) ||
    !rects ||
    !isIsoTimestamp(raw.created_at) ||
    !isIsoTimestamp(raw.updated_at)
  ) {
    return null;
  }

  return {
    id: raw.id,
    tag: raw.tag,
    page: Number(raw.page),
    side: raw.side,
    kind: raw.kind,
    text: raw.text,
    note: raw.note,
    rects,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function readAnnotations(workdir: string): ReaderAnnotation[] {
  const path = annotationsPath(workdir);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ReaderAnnotationsFile>;
    if (raw.version !== FILE_VERSION || !Array.isArray(raw.annotations)) return [];
    return raw.annotations
      .map(normalizeAnnotation)
      .filter((item): item is ReaderAnnotation => item !== null)
      .slice(0, MAX_SAVED_READER_ANNOTATIONS);
  } catch {
    // A corrupt annotation file must not prevent a document from opening.
    return [];
  }
}

function writeAnnotations(workdir: string, annotations: ReaderAnnotation[]): void {
  mkdirSync(workdir, { recursive: true });
  const path = annotationsPath(workdir);
  const temp = `${path}.tmp-${process.pid}`;
  const data: ReaderAnnotationsFile = {
    version: FILE_VERSION,
    annotations: annotations.slice(0, MAX_SAVED_READER_ANNOTATIONS),
  };
  try {
    writeFileSync(temp, JSON.stringify(data, null, 1), "utf8");
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* best-effort cleanup */
    }
  }
}

export function validateReaderAnnotationInput(
  body: unknown,
  totalPages: number
): { ok: true; value: ReaderAnnotationInput } | { ok: false; error: string } {
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
    return { ok: false, error: "số trang tài liệu không hợp lệ" };
  }
  const raw = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  if (
    !Number.isSafeInteger(raw.page) ||
    Number(raw.page) < 1 ||
    Number(raw.page) > totalPages
  ) {
    return { ok: false, error: `trang phải từ 1 đến ${totalPages}` };
  }
  if (!isSide(raw.side)) {
    return { ok: false, error: "bản tài liệu không hợp lệ" };
  }
  if (!isKind(raw.kind)) {
    return { ok: false, error: "loại đánh dấu không hợp lệ" };
  }
  if (typeof raw.text !== "string") {
    return { ok: false, error: "đoạn văn được chọn không hợp lệ" };
  }
  const selectedText = raw.text.trim();
  if (!selectedText || selectedText.length > MAX_READER_ANNOTATION_TEXT_LENGTH) {
    return {
      ok: false,
      error: `đoạn văn phải từ 1 đến ${MAX_READER_ANNOTATION_TEXT_LENGTH} ký tự`,
    };
  }
  if (raw.note != null && typeof raw.note !== "string") {
    return { ok: false, error: "ghi chú không hợp lệ" };
  }
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > MAX_READER_ANNOTATION_NOTE_LENGTH) {
    return {
      ok: false,
      error: `ghi chú tối đa ${MAX_READER_ANNOTATION_NOTE_LENGTH} ký tự`,
    };
  }
  if (raw.kind === "note" && !note) {
    return { ok: false, error: "nội dung ghi chú không được trống" };
  }
  const rects = normalizeRects(raw.rects);
  if (!rects) {
    return {
      ok: false,
      error: `tọa độ phải gồm 1 đến ${MAX_READER_ANNOTATION_RECTS} khung chuẩn hóa`,
    };
  }
  return {
    ok: true,
    value: {
      page: Number(raw.page),
      side: raw.side,
      kind: raw.kind,
      text: selectedText,
      note,
      rects,
    },
  };
}

export function listReaderAnnotations(workdir: string): ReaderAnnotation[] {
  return readAnnotations(workdir);
}

export function createReaderAnnotation(
  workdir: string,
  annotation: ReaderAnnotation
): ReaderAnnotation {
  const normalized = normalizeAnnotation(annotation);
  if (!normalized) throw new Error("annotation không hợp lệ");
  const existing = readAnnotations(workdir).filter((item) => item.id !== normalized.id);
  writeAnnotations(workdir, [normalized, ...existing]);
  return normalized;
}

export function deleteReaderAnnotation(workdir: string, id: string): boolean {
  if (!isBoundedKey(id, MAX_ID_LENGTH)) return false;
  const annotations = readAnnotations(workdir);
  const remaining = annotations.filter((item) => item.id !== id);
  if (remaining.length === annotations.length) return false;
  writeAnnotations(workdir, remaining);
  return true;
}
