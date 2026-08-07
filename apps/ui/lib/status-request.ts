import { getStatus } from "./api";
import type { StatusResponse } from "./types";

export const STATUS_REQUEST_TIMEOUT_MS = 5000;

export function withAbortTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return request(controller.signal).finally(() => clearTimeout(timer));
}

export function requestStatus(): Promise<StatusResponse> {
  return withAbortTimeout(getStatus, STATUS_REQUEST_TIMEOUT_MS);
}
