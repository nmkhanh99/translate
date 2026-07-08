// Thin fetch layer over dashboard.py's /api/*. The static build is served by
// dashboard.py itself, so requests are same-origin ("" base). For `next dev`
// (port 3000) set NEXT_PUBLIC_API_BASE to the dashboard URL to proxy.
import type { StatusResponse, PageInfo, AppConfig } from "./types";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(API_BASE + path, opts);
  let d: unknown = null;
  try {
    d = await r.json();
  } catch {
    /* empty / non-json */
  }
  if (!r.ok) {
    const msg = (d as { error?: string } | null)?.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return d as T;
}

export function getStatus(): Promise<StatusResponse> {
  return req<StatusResponse>("/api/status");
}

export function getPageInfo(tag: string): Promise<PageInfo> {
  return req<PageInfo>("/api/pageinfo?tag=" + encodeURIComponent(tag));
}

export function getCommand(tag: string, pages = "all") {
  return req<{ cmd: string; log: string; engine: string; pages: string }>(
    "/api/command?tag=" + encodeURIComponent(tag) + "&pages=" + encodeURIComponent(pages)
  );
}

export function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  return req<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

export function runVolume(tag: string) {
  return post("/api/run", { tag });
}
export function stopVolume(tag: string) {
  return post("/api/stop", { tag });
}
export function saveConfig(cfg: Partial<AppConfig>) {
  return post("/api/config", cfg);
}
export function uploadPdf(file: File) {
  return fetch(API_BASE + "/api/upload?name=" + encodeURIComponent(file.name), {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
}

export function pageImg(tag: string, which: "source" | "out", page0: number, dpi = 150) {
  return (
    API_BASE +
    "/api/page?tag=" +
    encodeURIComponent(tag) +
    "&which=" +
    which +
    "&page=" +
    page0 +
    "&dpi=" +
    dpi
  );
}

// ---- derived helpers (ported from the old app.js) ----
import type { Volume } from "./types";

export function volClass(v: Volume): "done" | "error" | "active" | "draft" {
  if (v.stage === "done") return "done";
  if (v.stage === "error") return "error";
  if (v.running) return "active";
  const t = v.translate || [0, 0];
  if (t[0] > 0) return "active";
  return "draft";
}

export function volPct(v: Volume): number {
  if (v.stage === "done") return 100;
  let d = 0,
    tot = 0;
  [v.translate, v.verify, v.vision].forEach((a) => {
    if (a && a[1]) {
      d += a[0] || 0;
      tot += a[1];
    }
  });
  return tot ? Math.round((100 * d) / tot) : 0;
}

export function pagesLabel(v: Volume): string {
  if (v.pages) return v.pages + " trang";
  const t = v.translate || [0, 0];
  return t[1] ? t[0] + "/" + t[1] + " lô" : "chưa rõ";
}

export const STATUS_TEXT: Record<string, string> = {
  done: "Đã dịch",
  active: "Đang dịch",
  error: "Lỗi",
  draft: "Chưa dịch",
};
