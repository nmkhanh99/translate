"use client";
// CLI picker (dropdown), open-design AgentPicker style: pick which local coding
// CLI drives the work — Claude / Codex / Grok. Lists every CLI with a status
// dot; a not-detected CLI is dimmed + noted but still selectable (detection can
// be wrong/slow — never hard-lock the choice). Optional ↻ rescan.
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
  onRescan,
}: {
  value: Engine;
  onChange: (e: Engine) => void;
  ariaLabel?: string;
  /** From GET /api/agents; a not-detected CLI is dimmed + noted, still selectable. */
  available?: Partial<Record<Engine, boolean>>;
  /** When set, shows a ↻ button to re-scan CLIs on PATH. */
  onRescan?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const isOk = (id: Engine) => (available ? available[id] !== false : true);
  const current = ENGINES.find((e) => e.id === value) || ENGINES[0];

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(id: Engine) {
    setOpen(false);
    if (id !== value) onChange(id);
  }

  return (
    <div className="engine-picker" ref={rootRef}>
      <span className="picker-label">CLI</span>
      <button
        type="button"
        className="engine-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={"dot" + (isOk(value) ? " on" : "")} />
        <span className="lbl">{current.label}</span>
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {onRescan ? (
        <button
          type="button"
          className="btn btn-icon engine-rescan"
          onClick={onRescan}
          title="Quét lại CLI trên PATH"
          aria-label="Quét lại CLI"
        >
          ↻
        </button>
      ) : null}
      {open ? (
        <ul className="engine-picker-menu" role="listbox" aria-label={ariaLabel}>
          {ENGINES.map((e) => {
            const ok = isOk(e.id);
            return (
              <li key={e.id} role="option" aria-selected={e.id === value}>
                <button
                  type="button"
                  className={"engine-opt" + (e.id === value ? " active" : "")}
                  onClick={() => pick(e.id)}
                  title={ok ? "Dùng " + e.label : e.label + " — chưa dò thấy trên PATH (vẫn thử được)"}
                >
                  <span className={"dot" + (ok ? " on" : "")} />
                  <span className="lbl">{e.label}</span>
                  {ok ? null : <span className="note">· chưa cài</span>}
                  {e.id === value ? <span className="check" aria-hidden="true">✓</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
