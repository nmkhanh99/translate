import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { READING_PROGRESS_PATH } from "./paths.js";

interface ReadingProgressFile {
  version: 1;
  bookmarks: Record<string, number>;
}

function readBookmarks(filePath: string): Record<string, number> {
  const bookmarks: Record<string, number> = Object.create(null);
  if (!existsSync(filePath)) return bookmarks;

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ReadingProgressFile>;
    if (raw.version !== 1 || !raw.bookmarks || typeof raw.bookmarks !== "object") {
      return bookmarks;
    }
    for (const [tag, page] of Object.entries(raw.bookmarks)) {
      if (tag && Number.isSafeInteger(page) && page >= 1) bookmarks[tag] = page;
    }
  } catch {
    // A missing/corrupt progress file must not prevent documents from opening.
  }
  return bookmarks;
}

export function getReadingBookmark(
  tag: string,
  filePath = READING_PROGRESS_PATH
): number | null {
  return readBookmarks(filePath)[tag] ?? null;
}

export function saveReadingBookmark(
  tag: string,
  page: number,
  filePath = READING_PROGRESS_PATH
): void {
  if (!tag) throw new Error("tag trống");
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("trang không hợp lệ");

  const bookmarks = readBookmarks(filePath);
  bookmarks[tag] = page;
  const data: ReadingProgressFile = { version: 1, bookmarks };
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 1), "utf8");
  renameSync(tempPath, filePath);
}
