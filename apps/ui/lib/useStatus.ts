"use client";
import * as React from "react";
import { requestStatus } from "./status-request";
import type { StatusResponse } from "./types";

export const STATUS_POLL_INTERVAL_MS = 2000;

interface StatusContextValue {
  data: StatusResponse | null;
  refresh: (afterInflight?: boolean) => Promise<StatusResponse>;
}

const StatusContext = React.createContext<StatusContextValue | null>(null);

export function StatusProvider({
  children,
  intervalMs = STATUS_POLL_INTERVAL_MS,
}: {
  children: React.ReactNode;
  intervalMs?: number;
}) {
  const [data, setData] = React.useState<StatusResponse | null>(null);
  const inFlight = React.useRef<Promise<StatusResponse> | null>(null);
  const mounted = React.useRef(false);

  const refresh = React.useCallback((afterInflight = false) => {
    const start = () => {
      const request = requestStatus().then((status) => {
        if (mounted.current) setData(status);
        return status;
      });
      inFlight.current = request;
      const clear = () => {
        if (inFlight.current === request) inFlight.current = null;
      };
      void request.then(clear, clear);
      return request;
    };

    const current = inFlight.current;
    if (!current) return start();
    if (!afterInflight) return current;
    return current.then(start, start);
  }, []);

  React.useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {});
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [intervalMs, refresh]);

  const value = React.useMemo(() => ({ data, refresh }), [data, refresh]);
  return React.createElement(StatusContext.Provider, { value }, children);
}

function useStatusContext(): StatusContextValue {
  const value = React.useContext(StatusContext);
  if (!value) throw new Error("useStatus must be used inside StatusProvider");
  return value;
}

// intervalMs is retained for source compatibility. Polling cadence is owned by
// the app-level provider so mounting a route never creates another timer.
export function useStatus(_intervalMs = 4000): StatusResponse | null {
  return useStatusContext().data;
}

export function useRefreshStatus(): (
  afterInflight?: boolean
) => Promise<StatusResponse> {
  return useStatusContext().refresh;
}
