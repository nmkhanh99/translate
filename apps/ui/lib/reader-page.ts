/** Return a valid 1-based page number for this document, or null. */
export function validReaderPage(value: unknown, total: number): number | null {
  if (!Number.isSafeInteger(total) || total < 1) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const page = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= total ? page : null;
}

export const READER_ZOOM_MIN = 0.5;
export const READER_ZOOM_MAX = 2.5;

export type ReaderZoomSide = "source" | "translated";
export type ReaderZoomBySide = Record<ReaderZoomSide, number>;

export function clampReaderZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(READER_ZOOM_MAX, Math.max(READER_ZOOM_MIN, value));
}

/** Chromium/Electron exposes a macOS trackpad pinch as ctrl+wheel. */
export function readerZoomFromWheel(current: number, deltaY: number): number {
  if (!Number.isFinite(deltaY)) return clampReaderZoom(current);
  return clampReaderZoom(current * Math.exp(-deltaY * 0.002));
}

/** Update one document pane without coupling its zoom to the other pane. */
export function setReaderPaneZoom(
  current: Readonly<ReaderZoomBySide>,
  side: ReaderZoomSide,
  value: number
): ReaderZoomBySide {
  const next = clampReaderZoom(value);
  return next === current[side] ? current : { ...current, [side]: next };
}
