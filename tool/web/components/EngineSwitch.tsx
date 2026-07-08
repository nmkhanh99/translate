"use client";
// Reusable CLI/engine picker (segmented control), open-design style: pick which
// coding CLI drives the work — Claude / Codex / Grok. Used for the translation
// engine (topbars) and inside the per-document chat.
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
}: {
  value: Engine;
  onChange: (e: Engine) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="engine-switch" role="tablist" aria-label={ariaLabel}>
      {ENGINES.map((e) => (
        <button
          key={e.id}
          type="button"
          role="tab"
          aria-selected={value === e.id}
          className={value === e.id ? "active" : ""}
          onClick={() => onChange(e.id)}
          title={"Dùng " + e.label}
        >
          {e.label}
        </button>
      ))}
    </div>
  );
}
