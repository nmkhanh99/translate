// Thin fetch layer over daemon /api/*. Static build is served by the daemon
// (same origin). For `next dev` set NEXT_PUBLIC_API_BASE=http://127.0.0.1:8756.
import type {
  StatusResponse,
  PageInfo,
  AppConfig,
  AgentDetection,
  AgentCapabilities,
  Engine,
  BlockReport,
  PreflightReport,
  RepairRequest,
  RepairRequestKind,
  ReaderAnnotation,
  ReaderAnnotationKind,
  ReaderAnnotationRect,
  ReaderAnnotationSide,
  ReaderTextPage,
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

export function getStatus(signal?: AbortSignal): Promise<StatusResponse> {
  return req<StatusResponse>("/api/status", { signal });
}

export interface AgentScanResponse {
  agents: AgentDetection[];
  capabilities: Record<Engine, AgentCapabilities>;
  models_discovered?: StatusResponse["models_discovered"];
  models_by_engine?: StatusResponse["models_by_engine"];
}

export function getAgents(): Promise<AgentScanResponse> {
  return req("/api/agents");
}

export function getPageInfo(tag: string): Promise<PageInfo> {
  return req<PageInfo>("/api/pageinfo?tag=" + encodeURIComponent(tag));
}

export function saveReadingBookmark(
  tag: string,
  page: number
): Promise<{ ok: boolean; tag: string; bookmark_page: number }> {
  return post("/api/reading-bookmark", { tag, page });
}

export function getBlocks(tag: string, page0: number): Promise<BlockReport> {
  return req<BlockReport>(
    "/api/blocks?tag=" + encodeURIComponent(tag) + "&page=" + page0
  );
}

export function getPageText(
  tag: string,
  page: number,
  side: ReaderAnnotationSide
): Promise<ReaderTextPage> {
  return req<ReaderTextPage>(
    "/api/page-text?tag=" + encodeURIComponent(tag) +
      "&page=" + page +
      "&side=" + encodeURIComponent(side)
  );
}

export type ReaderTranslationLanguage = "en" | "vi";

export interface ReaderSelectionTranslationResponse {
  translation: string;
  detected_language: string | null;
  target_language: ReaderTranslationLanguage;
}

export function translateReaderSelection(
  text: string,
  target: ReaderTranslationLanguage,
  signal?: AbortSignal
): Promise<ReaderSelectionTranslationResponse> {
  return req("/api/translate-selection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target }),
    signal,
  });
}

export function getReaderAnnotations(
  tag: string,
  page: number
): Promise<{ annotations: ReaderAnnotation[] }> {
  return req(
    "/api/reader-annotations?tag=" + encodeURIComponent(tag) + "&page=" + page
  );
}

export function createReaderAnnotation(body: {
  tag: string;
  page: number;
  side: ReaderAnnotationSide;
  kind: ReaderAnnotationKind;
  text: string;
  note?: string;
  rects: ReaderAnnotationRect[];
}): Promise<{ ok: true; annotation: ReaderAnnotation }> {
  return post("/api/reader-annotations", body);
}

export function deleteReaderAnnotation(
  tag: string,
  id: string
): Promise<{ ok: boolean }> {
  return post("/api/reader-annotations/delete", { tag, id });
}

export function getPreflight(tag: string): Promise<PreflightReport> {
  return req<PreflightReport>("/api/preflight?tag=" + encodeURIComponent(tag));
}

export function updateBlock(
  tag: string,
  id: string,
  translation: string
): Promise<{ ok: boolean; block: import("./types").DocumentBlock }> {
  return post("/api/blocks/update", { tag, id, translation });
}

export function getLog(tag: string): Promise<{ tag: string; lines: string[] }> {
  return req("/api/log?tag=" + encodeURIComponent(tag));
}

// ---- Báo cáo defect layout theo cụm (từ python defect-report) ----
export interface DefectCluster {
  name: string;
  channel: "text" | "code" | "policy" | "mixed" | "unknown";
  count: number;
  pages: number[];
  sample_details: { page: number; detail: string }[];
}
export function getDefectReport(
  tag: string
): Promise<{ defect_pages: number; clusters: DefectCluster[] }> {
  return req("/api/defects?tag=" + encodeURIComponent(tag));
}

export function getRepairRequests(
  tag: string
): Promise<{ requests: RepairRequest[] }> {
  return req("/api/repair-requests?tag=" + encodeURIComponent(tag));
}

export function submitRepairRequest(
  tag: string,
  page: number,
  kind: RepairRequestKind,
  note: string,
  engine: string
): Promise<{ ok: true; sid: string; engine: string; request: RepairRequest }> {
  if (!engine || !engine.trim()) {
    return Promise.reject(new Error("engine bắt buộc khi xử lý lại"));
  }
  return post("/api/repair-request", { tag, page, kind, note, engine: engine.trim() });
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

/**
 * Start (or resume) a volume pipeline.
 * `engine` is required so the body always matches the engine the UI shows —
 * server resolveEngine is override → pref → global; omitting override lets a
 * stale volume pref silently disagree with the EngineSwitch on Library/Translate.
 */
export function runVolume(
  tag: string,
  engine: string
): Promise<{ ok: boolean; sid?: string; engine?: string }> {
  if (!engine || !String(engine).trim()) {
    return Promise.reject(new Error("engine bắt buộc khi chạy volume"));
  }
  return post("/api/run", { tag, engine: String(engine).trim() });
}
/** Chọn engine riêng cho 1 cuốn mà không chạy ngay. */
export function setVolEngine(tag: string, engine: string): Promise<{ ok: boolean }> {
  return post("/api/volconfig", { tag, engine });
}
/**
 * Chạy LẠI một stage của cuốn (xoá output stage đó rồi làm lại).
 * stage='vision' + pages="5-10,12" (1-based) = chỉ soát lại đúng các trang đó.
 */
export function redoStage(
  tag: string,
  stage: "translate" | "verify" | "vision",
  opts?: { pages?: string; engine?: string }
): Promise<{ ok: boolean; sid?: string }> {
  return post("/api/run", {
    tag,
    redo: { stage, pages: opts?.pages },
    ...(opts?.engine ? { engine: opts.engine } : {}),
  });
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
export interface UploadPdfResult {
  ok: true;
  name: string;
  stored_name: string;
  document_id: string;
  tag: string;
}

export async function uploadPdf(file: File): Promise<UploadPdfResult> {
  const r = await fetch(API_BASE + "/api/upload?name=" + encodeURIComponent(file.name), {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  const data = (await r.json().catch(() => null)) as
    | UploadPdfResult
    | { error?: string }
    | null;
  if (!r.ok) throw new Error(data && "error" in data && data.error ? data.error : `HTTP ${r.status}`);
  return data as UploadPdfResult;
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
  // Prefer sequential overall from daemon (honest under re-chunk / stale later stages).
  if (typeof v.overall_pct === "number" && Number.isFinite(v.overall_pct)) {
    return Math.max(0, Math.min(100, Math.round(v.overall_pct)));
  }
  // Fallback: sequential weights matching python _overall_pct / daemon overallPct.
  const frac = (a?: [number, number]) =>
    a && a[1] ? Math.max(0, Math.min(1, (a[0] || 0) / a[1])) : 0;
  if (v.stage === "translate") return Math.round(40 * frac(v.translate));
  if (v.stage === "verify") return Math.round(40 + 30 * frac(v.verify));
  if (v.stage === "vision") return Math.round(70 + 25 * frac(v.vision));
  if (v.stage === "review") return 95;
  return 0;
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
