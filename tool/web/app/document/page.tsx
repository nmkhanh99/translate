"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getStatus, getPageInfo, pageImg } from "../../lib/api";
import { useToast, useChat } from "../../components/Providers";
import { IconChat } from "../../components/icons";
import type { PageInfo } from "../../lib/types";

export default function DocumentPage() {
  // useSearchParams must be inside Suspense for static export.
  return (
    <React.Suspense fallback={<div className="page">Đang tải…</div>}>
      <Reader />
    </React.Suspense>
  );
}

type ViewMode = "split" | "original" | "translated";

function Reader() {
  const sp = useSearchParams();
  const toast = useToast();
  const { openChat } = useChat();
  const [tag, setTag] = React.useState<string | null>(sp.get("tag"));
  const [info, setInfo] = React.useState<PageInfo | null>(null);
  const [cur, setCur] = React.useState(1);
  const [mode, setMode] = React.useState<ViewMode>("split");

  // Resolve a tag (fall back to first done/available volume) then load info.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      let t = sp.get("tag");
      if (!t) {
        try {
          const s = await getStatus();
          const done =
            s.volumes.filter((v) => !v.skip && v.stage === "done")[0] ||
            s.volumes.filter((v) => !v.skip)[0];
          t = done?.tag || null;
        } catch {
          /* ignore */
        }
      }
      if (!alive) return;
      setTag(t);
      if (!t) {
        toast("Không có tài liệu");
        return;
      }
      try {
        const i = await getPageInfo(t);
        if (alive) {
          setInfo(i);
          setCur(1);
        }
      } catch (e) {
        toast("Lỗi: " + (e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sp, toast]);

  const total = Math.max(1, info?.pages || 1);
  const clamp = (n: number) => Math.max(1, Math.min(total, n));

  if (!info || !tag) {
    return <div className="page">Đang tải…</div>;
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{info.display}</h1>
          <div className="sub">
            {info.pages} trang{info.out_exists ? "" : " · chưa có bản dịch"}
          </div>
        </div>
        <span className="spacer" />
        <div className="row" style={{ gap: "var(--space-2)" }}>
          {(["split", "original", "translated"] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={"btn btn-sm " + (mode === m ? "btn-secondary" : "btn-ghost")}
              onClick={() => setMode(m)}
            >
              {m === "split" ? "Song song" : m === "original" ? "Bản gốc" : "Bản dịch"}
            </button>
          ))}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              openChat({ tag, display: info.display, pages: info.pages })
            }
          >
            <IconChat /> Hỏi AI
          </button>
        </div>
      </div>

      <div className="page stack-4">
        <div className="row-between">
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setCur((c) => clamp(c - 1))}>
              ‹ Trước
            </button>
            <span className="num muted" style={{ minWidth: 70, textAlign: "center" }}>
              {cur} / {total}
            </span>
            <button className="btn btn-secondary btn-sm" onClick={() => setCur((c) => clamp(c + 1))}>
              Sau ›
            </button>
          </div>
        </div>

        <div
          className="reader"
          style={{
            gridTemplateColumns: mode === "split" ? "1fr 1fr" : "1fr",
          }}
        >
          {mode !== "translated" && (
            <Sheet cap={"English · trang " + cur} src={pageImg(tag, "source", cur - 1)} />
          )}
          {mode !== "original" &&
            (info.out_exists ? (
              <Sheet
                accent
                cap={"Tiếng Việt · trang " + cur}
                src={pageImg(tag, "out", cur - 1)}
              />
            ) : (
              <div className="page-sheet">
                <div className="sheet-cap" style={{ color: "var(--accent)" }}>
                  Tiếng Việt
                </div>
                <p className="muted">
                  Chưa có bản dịch cho cuốn này. Dịch ở trang{" "}
                  <Link href="/library">Thư viện</Link>.
                </p>
              </div>
            ))}
        </div>
      </div>
    </>
  );
}

function Sheet({ cap, src, accent }: { cap: string; src: string; accent?: boolean }) {
  return (
    <div>
      <div
        className="sheet-cap"
        style={{ color: accent ? "var(--accent)" : undefined, marginBottom: 8, fontSize: "var(--text-xs)" }}
      >
        {cap}
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={cap}
        style={{
          width: "100%",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          display: "block",
        }}
      />
    </div>
  );
}
