import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RepairRequest } from "@cfa-translate/shared";
import {
  attachRepairRun,
  createRepairRequest,
  finishRepairRequest,
  listRepairRequests,
  validateRepairRequestInput,
} from "./repair-requests.js";

function request(id = "r1"): RepairRequest {
  return {
    id,
    tag: "book",
    page: 7,
    kind: "layout",
    note: "Lệch khung bên phải",
    status: "running",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

describe("repair request persistence", () => {
  it("persists, attaches a run, and applies a one-way terminal transition", () => {
    const root = mkdtempSync(join(tmpdir(), "cfa-repair-"));
    createRepairRequest(root, request());
    attachRepairRun(root, "r1", "sid-1");
    finishRepairRequest(root, "r1", "completed");
    finishRepairRequest(root, "r1", "failed", "late duplicate event");

    const saved = listRepairRequests(root);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].run_sid, "sid-1");
    assert.equal(saved[0].status, "completed");
    assert.equal(saved[0].error, undefined);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "repair_requests.json"), "utf8")), saved);
  });

  it("validates page, kind and bounded notes without coercing input", () => {
    assert.deepEqual(validateRepairRequestInput({ page: 2, kind: "formula", note: "  vỡ phân số  " }, 3), {
      ok: true,
      value: { page: 2, kind: "formula", note: "vỡ phân số" },
    });
    assert.equal(validateRepairRequestInput({ page: "2", kind: "formula" }, 3).ok, false);
    assert.equal(validateRepairRequestInput({ page: 4, kind: "formula" }, 3).ok, false);
    assert.equal(validateRepairRequestInput({ page: 2, kind: "unknown" }, 3).ok, false);
    assert.equal(validateRepairRequestInput({ page: 2, kind: "other", note: "x".repeat(1_001) }, 3).ok, false);
  });

  it("fails closed on a corrupt persistence file", () => {
    const root = mkdtempSync(join(tmpdir(), "cfa-repair-corrupt-"));
    writeFileSync(join(root, "repair_requests.json"), "not-json");
    assert.deepEqual(listRepairRequests(root), []);
  });
});
