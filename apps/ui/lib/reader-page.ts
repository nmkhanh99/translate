/** Return a valid 1-based page number for this document, or null. */
export function validReaderPage(value: unknown, total: number): number | null {
  if (!Number.isSafeInteger(total) || total < 1) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const page = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= total ? page : null;
}
