"use client";
import * as React from "react";
import Link from "next/link";
import { useStatus } from "../lib/useStatus";
import { volClass, volPct, pagesLabel } from "../lib/api";
import { Badge } from "../components/Badge";
import { Cover } from "../components/Cover";
import { IconUpload } from "../components/icons";
import type { Volume } from "../lib/types";

export default function Home() {
  const s = useStatus();
  const vols = (s?.volumes || []).filter((v) => !v.skip);
  const done = vols.filter((v) => v.stage === "done");
  const running = vols.filter((v) => v.running);
  const pending = vols.filter((v) => v.stage !== "done" && !v.running);
  const pagesDone = done.reduce((a, v) => a + (v.pages || 0), 0);
  const cur = running[0] || pending[0];

  return (
    <div className="page stack-6">
      <section
        className="card"
        style={{
          background:
            "radial-gradient(120% 140% at 100% 0%, var(--accent-wash), transparent 55%), var(--surface)",
          borderRadius: "var(--radius-lg)",
          padding: "var(--space-8)",
        }}
      >
        <p className="eyebrow">CFA · Level I curriculum</p>
        <h1 style={{ maxWidth: "22ch", marginTop: "var(--space-3)" }}>
          Dịch trọn cả cuốn PDF sang Tiếng Việt, giữ nguyên bố cục.
        </h1>
        <p
          className="muted"
          style={{ maxWidth: "56ch", marginTop: "var(--space-3)" }}
        >
          Tải cuốn curriculum lên, chọn engine (Claude / Codex / Grok), và đọc bản
          dịch song song với sách gốc — heading, bảng, công thức khớp từng trang.
        </p>
        <div
          className="row wrap"
          style={{ gap: "var(--space-3)", marginTop: "var(--space-6)" }}
        >
          <Link className="btn btn-primary" href="/translate">
            <IconUpload /> Tải PDF lên để dịch
          </Link>
          <Link className="btn btn-secondary" href="/library">
            Mở thư viện
          </Link>
        </div>
      </section>

      {cur && <ContinueCard v={cur} />}

      <section className="grid-3">
        <Stat n={done.length} l="Cuốn đã dịch xong" />
        <Stat n={pagesDone} l="Trang trong các cuốn đã xong" />
        <Stat n={running.length + pending.length} l="Cuốn đang chạy / chờ" />
      </section>

      <section>
        <div
          className="row-between"
          style={{ marginBottom: "var(--space-4)" }}
        >
          <h2>Mở lại gần đây</h2>
          <Link className="btn btn-ghost btn-sm" href="/library">
            Xem tất cả
          </Link>
        </div>
        <div className="grid-3">
          {done.slice(0, 6).map((v) => (
            <Link
              key={v.tag}
              className="doc-card"
              href={"/document?tag=" + encodeURIComponent(v.tag)}
            >
              <Cover tag={v.tag} alt={"Bìa: " + v.display} />
              <div className="body">
                <div className="row-between">
                  <h3>{v.display}</h3>
                  <Badge kind="done" />
                </div>
                <p
                  className="muted num"
                  style={{ fontSize: "var(--text-xs)", marginTop: 4 }}
                >
                  {pagesLabel(v)}
                </p>
              </div>
            </Link>
          ))}
          {done.length === 0 && (
            <p className="muted">Chưa có cuốn nào dịch xong.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({ n, l }: { n: number; l: string }) {
  return (
    <div className="card">
      <div className="stat">
        <div className="n num">{n}</div>
        <div className="l">{l}</div>
      </div>
    </div>
  );
}

function ContinueCard({ v }: { v: Volume }) {
  const p = volPct(v);
  return (
    <section className="card">
      <div className="row-between wrap" style={{ gap: "var(--space-4)" }}>
        <div className="row" style={{ gap: "var(--space-4)" }}>
          <Cover tag={v.tag} dpi={60} style={{ width: 48, flex: "none" }} />
          <div>
            <div className="row" style={{ gap: "var(--space-2)" }}>
              <strong>
                {v.running ? "Đang dịch · " : "Chờ · "}
                {v.display}
              </strong>
              <Badge kind={volClass(v)} />
            </div>
            <div
              className="muted num"
              style={{ fontSize: "var(--text-xs)", marginTop: 2 }}
            >
              {pagesLabel(v)} · {v.stage}
            </div>
            <div
              className="progress"
              style={{ marginTop: "var(--space-2)", width: "min(360px,60vw)" }}
            >
              <i style={{ width: p + "%" }} />
            </div>
          </div>
        </div>
        <Link className="btn btn-secondary" href="/queue">
          Xem tiến độ
        </Link>
      </div>
    </section>
  );
}
