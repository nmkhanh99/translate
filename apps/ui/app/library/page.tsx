"use client";
import * as React from "react";
import Link from "next/link";
import { useStatus } from "../../lib/useStatus";
import { volClass, volPct, pagesLabel, runVolume } from "../../lib/api";
import { Badge } from "../../components/Badge";
import { IconSearch, IconChat } from "../../components/icons";
import { useChat, useToast, useEngine } from "../../components/Providers";
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
  const { openChat } = useChat();
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
            <DocCard key={v.tag} v={v} onRun={onRun} onChat={openChat} />
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
  onChat,
}: {
  v: Volume;
  onRun: (tag: string) => void;
  onChat: (d: { tag: string; display: string; pages?: number }) => void;
}) {
  const c = volClass(v);
  const p = volPct(v);
  const showBar = c === "active" || (v.translate && v.translate[0] > 0 && c !== "done");
  return (
    <article className="doc-card" data-status={c}>
      <div className="thumb" />
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
            <button
              className="btn btn-ghost btn-sm"
              title="Trò chuyện với AI về cuốn này"
              onClick={() => onChat({ tag: v.tag, display: v.display, pages: v.pages })}
            >
              <IconChat /> Chat
            </button>
            {c === "done" ? (
              <Link
                className="btn btn-secondary btn-sm"
                href={"/document?tag=" + encodeURIComponent(v.tag)}
              >
                Đọc song song
              </Link>
            ) : c === "active" ? (
              <Link className="btn btn-ghost btn-sm" href="/queue">
                Xem tiến độ
              </Link>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => onRun(v.tag)}>
                {c === "error" ? "Chạy tiếp" : "Dịch"}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
