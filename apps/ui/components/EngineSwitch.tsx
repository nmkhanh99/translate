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
  /** From GET /api/agents. Missing CLIs are dimmed as a HINT but still
   *  selectable — detection depends on the daemon PATH and can be wrong/slow,
   *  so we never hard-lock the choice. If a CLI truly can't run, the chat/run
   *  surfaces a clear error instead. */
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
            title={
              ok
                ? "Dùng " + e.label
                : e.label + " — chưa dò thấy trên PATH (vẫn chọn/thử được)"
            }
            style={ok ? undefined : { opacity: 0.55 }}
          >
            {e.label}
          </button>
        );
      })}
    </div>
  );
}
