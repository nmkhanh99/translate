"use client";
import * as React from "react";
import { getStatus } from "./api";
import type { StatusResponse } from "./types";

// Poll /api/status on an interval (default 4s), matching the old dashboard's
// live-refresh behavior. Returns the latest snapshot (or null before first load).
export function useStatus(intervalMs = 4000): StatusResponse | null {
  const [data, setData] = React.useState<StatusResponse | null>(null);
  React.useEffect(() => {
    let alive = true;
    const tick = () =>
      getStatus()
        .then((s) => {
          if (alive) setData(s);
        })
        .catch(() => {});
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return data;
}
