import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  RepairRequest,
  RepairRequestKind,
  RepairRequestStatus,
} from "@cfa-translate/shared";

export const REPAIR_REQUEST_KINDS = [
  "translation",
  "layout",
  "formula",
  "table",
  "other",
] as const satisfies readonly RepairRequestKind[];

const REPAIR_REQUEST_STATUSES = [
  "running",
  "completed",
  "failed",
] as const satisfies readonly RepairRequestStatus[];

const MAX_SAVED_REQUESTS = 200;
const MAX_NOTE_LENGTH = 1_000;

function requestPath(workdir: string): string {
  return join(workdir, "repair_requests.json");
}

function isKind(value: unknown): value is RepairRequestKind {
  return typeof value === "string" &&
    (REPAIR_REQUEST_KINDS as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is RepairRequestStatus {
  return typeof value === "string" &&
    (REPAIR_REQUEST_STATUSES as readonly string[]).includes(value);
}

function normalizeRequest(value: unknown): RepairRequest | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" || !raw.id ||
    typeof raw.tag !== "string" || !raw.tag ||
    !Number.isSafeInteger(raw.page) || Number(raw.page) < 1 ||
    !isKind(raw.kind) || !isStatus(raw.status) ||
    typeof raw.note !== "string" || raw.note.length > MAX_NOTE_LENGTH ||
    typeof raw.created_at !== "string" ||
    typeof raw.updated_at !== "string"
  ) {
    return null;
  }
  return {
    id: raw.id,
    tag: raw.tag,
    page: Number(raw.page),
    kind: raw.kind,
    note: raw.note,
    status: raw.status,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    ...(typeof raw.run_sid === "string" ? { run_sid: raw.run_sid } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
  };
}

function writeRequests(workdir: string, requests: RepairRequest[]): void {
  mkdirSync(workdir, { recursive: true });
  const path = requestPath(workdir);
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, JSON.stringify(requests.slice(0, MAX_SAVED_REQUESTS), null, 1), "utf8");
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* best-effort cleanup */
    }
  }
}

export function listRepairRequests(workdir: string): RepairRequest[] {
  const path = requestPath(workdir);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeRequest).filter((x): x is RepairRequest => x !== null);
  } catch {
    return [];
  }
}

export function validateRepairRequestInput(
  body: unknown,
  totalPages: number
): { ok: true; value: { page: number; kind: RepairRequestKind; note: string } } |
  { ok: false; error: string } {
  const raw = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  const page = raw.page;
  if (!Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > totalPages) {
    return { ok: false, error: `trang phải từ 1 đến ${totalPages}` };
  }
  if (!isKind(raw.kind)) {
    return { ok: false, error: "loại yêu cầu không hợp lệ" };
  }
  if (raw.note != null && typeof raw.note !== "string") {
    return { ok: false, error: "mô tả yêu cầu không hợp lệ" };
  }
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: `mô tả tối đa ${MAX_NOTE_LENGTH} ký tự` };
  }
  return { ok: true, value: { page: Number(page), kind: raw.kind, note } };
}

export function createRepairRequest(
  workdir: string,
  request: RepairRequest
): RepairRequest {
  const requests = listRepairRequests(workdir).filter((x) => x.id !== request.id);
  writeRequests(workdir, [request, ...requests]);
  return request;
}

export function attachRepairRun(
  workdir: string,
  id: string,
  runSid: string
): RepairRequest | null {
  const requests = listRepairRequests(workdir);
  const request = requests.find((x) => x.id === id);
  if (!request) return null;
  request.run_sid = runSid;
  request.updated_at = new Date().toISOString();
  writeRequests(workdir, requests);
  return request;
}

/** Terminal transition is one-way so duplicate child events cannot flip results. */
export function finishRepairRequest(
  workdir: string,
  id: string,
  status: "completed" | "failed",
  error?: string
): RepairRequest | null {
  const requests = listRepairRequests(workdir);
  const request = requests.find((x) => x.id === id);
  if (!request || request.status !== "running") return request || null;
  request.status = status;
  request.updated_at = new Date().toISOString();
  if (status === "failed") request.error = String(error || "xử lý lại thất bại").slice(0, 500);
  else delete request.error;
  writeRequests(workdir, requests);
  return request;
}
