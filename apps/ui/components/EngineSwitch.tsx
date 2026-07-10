"use client";
// Reusable CLI/engine picker (segmented control), open-design style: pick which
// local coding CLI drives the work — Claude / Codex / Grok.
import * as React from "react";
import type { Engine } from "../lib/types";

export const ENGINES: { id: Engine; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok" },
];

export function EngineSwitch({
  value,
  onChange,
  ariaLabel = "Chọn CLI",
  available,
}: {
  value: Engine;
  onChange: (e: Engine) => void;
  ariaLabel?: string;
  /** When set, missing CLIs are greyed out (from GET /api/agents). */
  available?: Partial<Record<Engine, boolean>>;
}) {
  return (
    <div className="engine-switch" role="tablist" aria-label={ariaLabel}>
      {ENGINES.map((e) => {
        const ok = available ? available[e.id] !== false : true;
        return (
          <button
            key={e.id}
            type="button"
            role="tab"
            aria-selected={value === e.id}
            className={value === e.id ? "active" : ""}
            onClick={() => onChange(e.id)}
            disabled={!ok}
            title={ok ? "Dùng " + e.label : e.label + " chưa có trên PATH"}
            style={ok ? undefined : { opacity: 0.4 }}
          >
            {e.label}
          </button>
        );
      })}
    </div>
  );
}
