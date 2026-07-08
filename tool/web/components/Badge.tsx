import * as React from "react";

const MAP: Record<string, { cls: string; label: string }> = {
  done: { cls: "badge-success", label: "Đã dịch" },
  active: { cls: "badge-accent", label: "Đang dịch" },
  draft: { cls: "", label: "Chưa dịch" },
  error: { cls: "badge-danger", label: "Lỗi" },
};

export function Badge({ kind }: { kind: "done" | "active" | "draft" | "error" }) {
  const b = MAP[kind] || MAP.draft;
  return (
    <span className={"badge " + b.cls}>
      <span className="dot" />
      {b.label}
    </span>
  );
}
