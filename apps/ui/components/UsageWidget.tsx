"use client";
// Sidebar budget widget. Cost isn't tracked (billing lives in the Claude/Codex/
// Grok plans on the machine) — we only show the configured monthly budget.
import * as React from "react";
import { getStatus } from "../lib/api";

export function UsageWidget() {
  const [budget, setBudget] = React.useState<number | null>(null);
  React.useEffect(() => {
    let alive = true;
    getStatus()
      .then((s) => {
        if (alive) setBudget(s.config?.budget ?? 100);
      })
      .catch(() => {
        if (alive) setBudget(100);
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="usage">
      <div className="row-between">
        <small>Ngân sách tháng</small>
        <b className="num">${budget ?? "—"}</b>
      </div>
      <div className="progress">
        <i style={{ width: "0%" }} />
      </div>
      <small className="muted">
        Chi phí tính theo gói Claude/Codex/Grok trên máy — app không theo dõi $
        riêng.
      </small>
    </div>
  );
}
