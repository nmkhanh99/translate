"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStatus } from "../../lib/useStatus";
import { volClass, volPct, pagesLabel, runVolume } from "../../lib/api";
import { Badge } from "../../components/Badge";
import { Cover } from "../../components/Cover";
import { IconSearch } from "../../components/icons";
import { useToast, useEngine } from "../../components/Providers";
import { EngineSwitch } from "../../components/EngineSwitch";
import type { Volume } from "../../lib/types";

const FILTERS = [
  { id: "all", label: "Tất cả" },
  { id: "done", label: "Đã dịch" },
  { id: "active", label: "Đang dịch" },
  { id: "draft", label: "Chưa dịch" },
];

export default function Library() {
  const s = useStatus();
  const toast = useToast();
  const router = useRouter();
  const { engine, setEngine, available } = useEngine();
  const [filter, setFilter] = React.useState("all");
  const [q, setQ] = React.useState("");

  const vols = (s?.volumes || []).filter((v) => !v.skip);
  const shown = vols.filter((v) => {
    const c = volClass(v);
    if (filter !== "all" && c !== filter) return false;
    if (q && v.display.toLowerCase().indexOf(q.toLowerCase()) === -1) return false;
    return true;
  });

  async function onRun(tag: string) {
    try {
      await runVolume(tag);
      toast("Đã bắt đầu dịch (headless)");
    } catch (e) {
      toast("Lỗi: " + (e as Error).message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Thư viện</h1>
          <div className="sub">Mọi cuốn curriculum + tài liệu bạn tự thêm.</div>
        </div>
        <span className="spacer" />
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
            CLI dịch
          </span>
          <EngineSwitch
            value={engine}
            onChange={setEngine}
            available={available}
            ariaLabel="Chọn CLI dịch"
          />
        </div>
        <div className="searchbox">
          <IconSearch />
          <input
            className="input"
            placeholder="Tìm theo tên…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 220 }}
          />
        </div>
      </div>

      <div className="page stack-4">
        <div className="row wrap" style={{ gap: "var(--space-2)" }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={"chip" + (filter === f.id ? " active" : "")}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="grid-auto" id="doc-grid">
          {shown.map((v) => (
            <DocCard
              key={v.tag}
              v={v}
              onRun={onRun}
              onOpen={(tag) => router.push("/document?tag=" + encodeURIComponent(tag))}
            />
          ))}
          {s && shown.length === 0 && (
            <p className="muted">Không có cuốn nào khớp bộ lọc.</p>
          )}
        </div>
      </div>
    </>
  );
}

function DocCard({
  v,
  onRun,
  onOpen,
}: {
  v: Volume;
  onRun: (tag: string) => void;
  onOpen: (tag: string) => void;
}) {
  const c = volClass(v);
  const p = volPct(v);
  const showBar = c === "active" || (v.translate && v.translate[0] > 0 && c !== "done");
  // Whole card opens the document detail (nơi có Chat). Inner action buttons
  // stop propagation so they keep their own behavior.
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <article
      className="doc-card doc-card-link"
      data-status={c}
      role="link"
      tabIndex={0}
      title="Mở chi tiết tài liệu"
      onClick={() => onOpen(v.tag)}
      onKeyDown={(e) => {
        // Only when the card itself is focused, not a bubbling Enter/Space from
        // an inner action button/link.
        if (
          (e.key === "Enter" || e.key === " ") &&
          e.target === e.currentTarget
        ) {
          e.preventDefault();
          onOpen(v.tag);
        }
      }}
    >
      <Cover tag={v.tag} alt={"Bìa: " + v.display} />
      <div className="body">
        <div className="row-between">
          <h3>{v.display}</h3>
          <Badge kind={c} />
        </div>
        {v.user && (
          <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: 2 }}>
            📄 tài liệu tự thêm
          </p>
        )}
        {showBar && (
          <div className="progress" style={{ marginTop: "var(--space-3)" }}>
            <i style={{ width: p + "%" }} />
          </div>
        )}
        <div
          className="row-between"
          style={{ marginTop: "var(--space-3)", gap: "var(--space-2)" }}
        >
          <span className="num muted" style={{ fontSize: "var(--text-xs)" }}>
            {showBar ? p + "% · " : ""}
            {pagesLabel(v)}
          </span>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            {c === "done" ? (
              <Link
                className="btn btn-secondary btn-sm"
                href={"/document?tag=" + encodeURIComponent(v.tag)}
                onClick={stop}
              >
                Đọc song song
              </Link>
            ) : c === "active" ? (
              <Link className="btn btn-ghost btn-sm" href="/queue" onClick={stop}>
                Xem tiến độ
              </Link>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                onClick={(e) => {
                  stop(e);
                  onRun(v.tag);
                }}
              >
                {c === "error" ? "Chạy tiếp" : "Dịch"}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
