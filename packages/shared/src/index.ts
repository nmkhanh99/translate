/** Shared types for CFA Translate Studio (daemon + web + adapters). */

export type EngineId = "claude" | "codex" | "grok";

// ── Model resolution (no hardcoded CLI product lineup) ─────────────────────
// Options come from runtime discovery + "CLI default" + free-text.
// We never ship a frozen multi-id catalog of model names that go stale.

/** Sentinel: omit --model / -m so the installed CLI picks its own default. */
export const CLI_DEFAULT_MODEL = "default";

export interface ModelOption {
  id: string;
  label: string;
  /** true when discovered from installed CLI at runtime */
  discovered?: boolean;
}

/**
 * Short Claude CLI aliases used ONLY to detect cross-engine contamination
 * (e.g. leftover "sonnet" under Grok). Not presented as a product catalog.
 */
const CLAUDE_ALIAS_RE = /^(sonnet|opus|haiku)([-\s].*)?$/i;

export function isEngineId(v: unknown): v is EngineId {
  return v === "claude" || v === "codex" || v === "grok";
}

export function isCliDefault(model: string | undefined | null): boolean {
  const m = (model || "").trim().toLowerCase();
  return !m || m === "default" || m === "auto" || m === "cli-default";
}

export function defaultModel(_engine?: string | null): string {
  return CLI_DEFAULT_MODEL;
}

/**
 * Normalize stored model for an engine.
 * - empty / "default" → CLI default sentinel
 * - Claude alias under codex/grok → CLI default (wrong engine leftover)
 * - otherwise pass-through user/discovery id (do not invent product names)
 */
export function normalizeModel(
  engine: string | undefined | null,
  model: string | undefined | null
): string {
  const e = isEngineId(engine) ? engine : "claude";
  const raw = (model || "").trim();
  if (isCliDefault(raw)) return CLI_DEFAULT_MODEL;
  if (e !== "claude" && CLAUDE_ALIAS_RE.test(raw)) return CLI_DEFAULT_MODEL;
  return raw;
}

/** CLI argv model string, or undefined to omit the flag entirely. */
export function cliModelArg(
  engine: string | undefined | null,
  model: string | undefined | null
): string | undefined {
  const m = normalizeModel(engine, model);
  if (isCliDefault(m)) return undefined;
  return m;
}

/**
 * Build UI options: always CLI default first, then discovered ids (if any).
 * Free-text is handled separately in Settings — not a fake fixed list.
 */
export function modelOptionsForEngine(
  engine: string | undefined | null,
  discovered: string[] | undefined | null = []
): ModelOption[] {
  const e = isEngineId(engine) ? engine : "claude";
  const opts: ModelOption[] = [
    { id: CLI_DEFAULT_MODEL, label: "Mặc định CLI (để CLI tự chọn)" },
  ];
  const seen = new Set<string>([CLI_DEFAULT_MODEL]);
  for (const id of discovered || []) {
    const t = String(id || "").trim();
    if (!t || seen.has(t)) continue;
    if (e !== "claude" && CLAUDE_ALIAS_RE.test(t)) continue;
    seen.add(t);
    opts.push({ id: t, label: t, discovered: true });
  }
  return opts;
}

/** @deprecated use modelOptionsForEngine(engine, discovered) — no static catalog */
export function modelsForEngine(
  engine: string | undefined | null,
  discovered: string[] | undefined | null = []
): ModelOption[] {
  return modelOptionsForEngine(engine, discovered);
}

/** @deprecated removed static product tables; empty export for old imports */
export const ENGINE_MODEL_CATALOG: Record<EngineId, readonly ModelOption[]> = {
  claude: [{ id: CLI_DEFAULT_MODEL, label: "Mặc định CLI (để CLI tự chọn)" }],
  codex: [{ id: CLI_DEFAULT_MODEL, label: "Mặc định CLI (để CLI tự chọn)" }],
  grok: [{ id: CLI_DEFAULT_MODEL, label: "Mặc định CLI (để CLI tự chọn)" }],
};

export function fieldVisibleForEngine(
  field: "model" | "agents" | "codex_batch" | "posture",
  engine: string | undefined | null
): boolean {
  const e = isEngineId(engine) ? engine : "claude";
  if (field === "model" || field === "posture") return true;
  if (field === "agents") return true;
  if (field === "codex_batch") return e === "codex" || e === "grok";
  return true;
}

export type Stage = "translate" | "verify" | "vision" | "done" | "error" | string;

export type AuthState = "ok" | "missing" | "unknown";

export interface AgentDetection {
  id: EngineId;
  displayName: string;
  executablePath: string;
  version?: string;
  configDir?: string;
  authState: AuthState;
  available: boolean;
}

export interface AgentCapabilities {
  streaming: boolean;
  resume: boolean;
  /** MCP tool calls work headless without interactive approval. */
  headlessMcp: boolean;
  permissionMode: "strict" | "permissive" | "none";
  pipeline: "workflow" | "mcp-batch";
}

/** Optional error codes the UI/daemon can act on (open-design style). */
export type AgentErrorCode = "resume_failed" | "spawn_failed" | "timeout" | string;

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; id?: string }
  | { type: "session"; sessionId: string }
  | { type: "progress"; stage?: string; detail?: string }
  | { type: "error"; error: string; code?: AgentErrorCode }
  | { type: "done"; reason: "completed" | "cancelled" | "error" };

/** SSE events the browser chat UI consumes (compatible with legacy dashboard). */
export type ChatSseEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; text: string }
  | { type: "done"; session?: string | null }
  | { type: "error"; text: string }
  | { type: "info"; text: string };

export interface AppConfig {
  engine?: EngineId | string;
  model?: string;
  budget?: number;
  budget_warn?: number;
  vision?: boolean;
  posture?: "allowlist" | "bypass" | string;
  codex_batch?: number;
  /** Số agent dịch/soát chạy SONG SONG trong 1 run (pipeline Claude), 1..10. */
  agents?: number;
}

export interface Volume {
  tag: string;
  display: string;
  stage: Stage;
  running?: boolean;
  skip?: boolean;
  user?: boolean;
  pages?: number;
  engine?: string;
  logpath?: string;
  translate?: [number, number];
  verify?: [number, number];
  vision?: [number, number];
  /**
   * % tổng tuần tự từ daemon (0–100). 100 chỉ khi stage===done.
   * UI nên ưu tiên field này thay vì cộng thô 3 stage (tránh near-100% khi
   * vision artifact cũ đầy mà translate vừa re-chunk về 0).
   */
  overall_pct?: number;
  out_exists?: boolean;
  sid?: string;
  mode?: string;
  rc?: number | null;
  /** Số trang còn lỗi layout cần fix (kind 'defect' >= medium, chưa accepted). */
  defects?: number;
  /** Engine đã chọn RIÊNG cho cuốn này (ghi đè engine global). undefined = dùng global. */
  pref_engine?: string;
}

export interface StatusResponse {
  volumes: Volume[];
  config: AppConfig;
  engines?: EngineId[];
  /** @deprecated empty; use models_by_engine */
  models?: string[];
  /** Per-engine options: CLI default + discovered ids (runtime). */
  models_by_engine?: Partial<
    Record<EngineId, { id: string; label: string; discovered?: boolean }[]>
  >;
  /** Raw discovered model ids from installed CLIs (may be empty). */
  models_discovered?: Partial<Record<EngineId, string[]>>;
  postures?: string[];
  done?: number;
  total?: number;
  running?: number;
  batch?: {
    active: boolean;
    current?: string | null;
    queue?: string[];
    running?: string[];
    limit?: number;
  };
  agents?: AgentDetection[];
}

export interface PageInfo {
  tag?: string;
  display: string;
  pages: number;
  out_exists: boolean;
  /** Trang 1-based được người dùng đánh dấu để đọc tiếp. */
  bookmark_page: number | null;
}

/** Loại yêu cầu xử lý lại được gửi từ trình đọc tài liệu. */
export type RepairRequestKind =
  | "translation"
  | "layout"
  | "formula"
  | "table"
  | "other";

export type RepairRequestStatus = "running" | "completed" | "failed";

/** Yêu cầu xử lý đúng một trang; `page` luôn là số trang 1-based của UI. */
export interface RepairRequest {
  id: string;
  tag: string;
  page: number;
  kind: RepairRequestKind;
  note: string;
  status: RepairRequestStatus;
  created_at: string;
  updated_at: string;
  run_sid?: string;
  error?: string;
}

/** Persisted block-level fit data consumed by the in-app editor overlay. */
export interface DocumentBlock {
  id: string;
  page: number;
  type?: string;
  box: [number, number, number, number];
  source: string;
  translation: string;
  actual_scale?: number;
  review_scale_floor?: number;
  review_required?: boolean;
  status?: string;
  fallback?: string | null;
  overflow?: boolean;
  formula_count?: number;
}

export interface BlockReport {
  tag: string;
  page: number;
  page_size: [number, number] | null;
  blocks: DocumentBlock[];
  review_count?: number;
  generated_at?: string;
}

/** Selectable text span extracted from the actual source/translated PDF page. */
export interface ReaderTextSpan {
  id: string;
  text: string;
  box: [number, number, number, number];
  font_size: number;
  bold?: boolean;
  italic?: boolean;
}

/** Text layer data uses the reader's public 1-based page convention. */
export interface ReaderTextPage {
  tag: string;
  page: number;
  side: "source" | "translated";
  page_size: [number, number];
  spans: ReaderTextSpan[];
}

export type ReaderAnnotationSide = "source" | "translated";
export type ReaderAnnotationKind = "highlight" | "note";

/** Rectangle normalized to the rendered page image (all values in 0..1). */
export interface ReaderAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Highlight/note kept as a viewer overlay; the immutable PDFs are untouched. */
export interface ReaderAnnotation {
  id: string;
  tag: string;
  page: number;
  side: ReaderAnnotationSide;
  kind: ReaderAnnotationKind;
  text: string;
  note: string;
  rects: ReaderAnnotationRect[];
  created_at: string;
  updated_at: string;
}

export interface PreflightPage {
  page: number;
  classification: string;
  confidence: number;
  text_chars: number;
  image_coverage: number;
  requires_ocr: boolean;
  manual_review: boolean;
  roundtrip_probe?: Record<string, unknown> | null;
}

export interface PreflightReport {
  version: number;
  document_mode: "native" | "mixed" | "scanned" | string;
  page_count: number;
  counts: Record<string, number>;
  pages: PreflightPage[];
}

export interface ChatRequest {
  tag: string;
  engine: EngineId;
  message: string;
  session?: string | null;
}

export function agentEventToChatSse(ev: AgentEvent): ChatSseEvent | null {
  switch (ev.type) {
    case "text_delta":
      return { type: "delta", text: ev.text };
    case "tool_call":
      return { type: "tool", text: "🔧 " + ev.name };
    case "error":
      // resume_failed is handled by the daemon (auto-retry); don't surface to UI.
      if (ev.code === "resume_failed") return null;
      return { type: "error", text: ev.error };
    case "done":
      return { type: "done" };
    case "session":
      return null; // carried on done by daemon
    case "progress":
      return ev.detail ? { type: "info", text: ev.detail } : null;
    default:
      return null;
  }
}
