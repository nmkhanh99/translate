// Thin fetch layer over daemon /api/*. Static build is served by the daemon
// (same origin). For `next dev` set NEXT_PUBLIC_API_BASE=http://127.0.0.1:8756.
import type {
  StatusResponse,
  PageInfo,
  AppConfig,
  AgentDetection,
  AgentCapabilities,
  Engine,
} from "./types";

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

export function getAgents(): Promise<{
  agents: AgentDetection[];
  capabilities: Record<Engine, AgentCapabilities>;
}> {
  return req("/api/agents");
}

export function getPageInfo(tag: string): Promise<PageInfo> {
  return req<PageInfo>("/api/pageinfo?tag=" + encodeURIComponent(tag));
}

export function getLog(tag: string): Promise<{ tag: string; lines: string[] }> {
  return req("/api/log?tag=" + encodeURIComponent(tag));
}

// ---- Per-document chat conversations (SQLite-persisted on the daemon) ----
export interface ConversationMeta {
  id: string;
  tag: string;
  title: string | null;
  engine: string | null;
  created_at: number;
  updated_at: number;
  msg_count: number;
}
export interface StoredMessage {
  id: string;
  role: string;
  text: string;
  engine?: string | null;
}

export function listConversations(
  tag: string
): Promise<{ persist: boolean; conversations: ConversationMeta[] }> {
  return req("/api/conversations?tag=" + encodeURIComponent(tag));
}
export function createConversation(
  tag: string,
  title: string | null,
  engine: string | null
): Promise<ConversationMeta> {
  return post("/api/conversations", { tag, title, engine });
}
export function loadConversation(id: string): Promise<{
  conversation: ConversationMeta | null;
  messages: StoredMessage[];
  sessions: Record<string, string>;
}> {
  return req("/api/conversation?id=" + encodeURIComponent(id));
}
export function saveConversationApi(
  id: string,
  body: {
    title?: string | null;
    engine?: string | null;
    messages: StoredMessage[];
    sessions?: Record<string, string>;
  }
): Promise<{ ok: boolean }> {
  return post("/api/conversation/save", { id, ...body });
}
export function deleteConversationApi(id: string): Promise<{ ok: boolean }> {
  return post("/api/conversation/delete", { id });
}

export function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  return req<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

export function runVolume(
  tag: string,
  engine?: string
): Promise<{ ok: boolean; sid?: string; engine?: string }> {
  return post("/api/run", engine ? { tag, engine } : { tag });
}
/** Chọn engine riêng cho 1 cuốn mà không chạy ngay. */
export function setVolEngine(tag: string, engine: string): Promise<{ ok: boolean }> {
  return post("/api/volconfig", { tag, engine });
}
/** Chạy hàng loạt các cuốn còn dở, tối đa `limit` cuốn song song. */
export function startBatch(limit: number): Promise<{ ok: boolean; limit: number }> {
  return post("/api/batch", { action: "start", limit });
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

export function volClass(
  v: Volume
): "done" | "error" | "active" | "draft" | "review" {
  if (v.stage === "done") return "done";
  if (v.stage === "error") return "error";
  if (v.running) return "active";
  if (v.stage === "review") return "review";
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

// Human-readable Vietnamese label for a run stage shown on the queue card.
export function stageLabel(stage: string): string {
  const m: Record<string, string> = {
    translate: "Đang dịch",
    verify: "Đang rà soát",
    vision: "Đang soát layout",
    fix: "Đang sửa layout tràn khung",
    review: "Cần sửa layout",
    done: "Hoàn tất",
    error: "Lỗi",
  };
  return m[stage] || stage || "Đang chuẩn bị";
}
