"use client";
import * as React from "react";
import Link from "next/link";
import { useStatus } from "../../lib/useStatus";
import { volClass, volPct, pagesLabel, runVolume, stopVolume, post } from "../../lib/api";
import { Badge } from "../../components/Badge";
import { useToast } from "../../components/Providers";
import type { Volume } from "../../lib/types";

type Kind = "active" | "waiting" | "done" | "error";

export default function Queue() {
  const s = useStatus(3500);
  const toast = useToast();
  const vols = (s?.volumes || []).filter((v) => !v.skip);
  const active = vols.filter((v) => v.running);
  const waiting = vols.filter(
    (v) => v.stage !== "done" && !v.running && v.stage !== "error"
  );
  const donev = vols.filter((v) => v.stage === "done");
  const errv = vols.filter((v) => v.stage === "error" && !v.running);
  const cur = active[0];

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
    } catch (e) {
      toast("Lỗi: " + (e as Error).message);
    }
  };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Hàng đợi</h1>
          <div className="sub">Chạy tuần tự từng cuốn — dừng/chạy lại là tự resume.</div>
        </div>
        <span className="spacer" />
        <button
          className="btn btn-secondary"
          onClick={() => act(() => post("/api/batch", { action: "stop" }), "Đã dừng batch")}
        >
          Tạm dừng tất cả
        </button>
      </div>

      <div className="page stack-6">
        <section className="grid-3">
          <Stat n={cur ? volPct(cur) : 0} suffix="%" l="Tiến độ cuốn đang dịch" />
          <Stat n={active.length} l="Đang chạy" />
          <Stat n={waiting.length} l="Đang chờ trong hàng đợi" />
        </section>

        <div className="panel">
          <div className="panel-head">
            Đang xử lý
            <span className="spacer" />
            <span className="badge badge-accent">
              <span className="dot" />
              Tuần tự
            </span>
          </div>
          {active.map((v) => (
            <Job key={v.tag} v={v} kind="active" act={act} />
          ))}
          {waiting.map((v) => (
            <Job key={v.tag} v={v} kind="waiting" act={act} />
          ))}
          {!active.length && !waiting.length && (
            <div style={{ padding: "var(--space-4)" }} className="muted">
              Không có cuốn nào trong hàng đợi.
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">Hoàn tất gần đây</div>
          {donev.map((v) => (
            <Job key={v.tag} v={v} kind="done" act={act} />
          ))}
          {errv.map((v) => (
            <Job key={v.tag} v={v} kind="error" act={act} />
          ))}
          {!donev.length && !errv.length && (
            <div style={{ padding: "var(--space-4)" }} className="muted">
              Chưa có gì.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ n, l, suffix }: { n: number; l: string; suffix?: string }) {
  return (
    <div className="card">
      <div className="stat">
        <div className="n num">
          {n}
          {suffix && <small>{suffix}</small>}
        </div>
        <div className="l">{l}</div>
      </div>
    </div>
  );
}

function Job({
  v,
  kind,
  act,
}: {
  v: Volume;
  kind: Kind;
  act: (fn: () => Promise<unknown>, ok: string) => void;
}) {
  const p = volPct(v);
  return (
    <div
      className="row-between"
      style={{
        padding: "var(--space-4)",
        borderTop: "1px solid var(--border-soft)",
        gap: "var(--space-4)",
      }}
    >
      <div className="row" style={{ gap: "var(--space-3)", minWidth: 0 }}>
        <div className="thumb" style={{ width: 40, flex: "none" }} />
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <strong>{v.display}</strong>
            <Badge kind={kind === "waiting" ? "draft" : volClass(v)} />
          </div>
          <div className="muted num" style={{ fontSize: "var(--text-xs)" }}>
            {v.tag} · {v.engine || ""}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, maxWidth: 320 }}>
        {kind === "active" && (
          <>
            <div className="row" style={{ gap: "var(--space-3)" }}>
              <div className="progress" style={{ flex: 1 }}>
                <i style={{ width: p + "%" }} />
              </div>
              <span
                className="num muted"
                style={{ fontSize: "var(--text-xs)", minWidth: 32, textAlign: "right" }}
              >
                {p}%
              </span>
            </div>
            <div className="muted" style={{ fontSize: "var(--text-xs)", marginTop: 6 }}>
              {v.stage} · {pagesLabel(v)}
            </div>
          </>
        )}
        {kind === "waiting" && (
          <div className="progress">
            <i style={{ width: p + "%" }} />
          </div>
        )}
        {kind === "done" && (
          <div className="progress ok">
            <i style={{ width: "100%" }} />
          </div>
        )}
        {kind === "error" && (
          <div className="progress warn">
            <i style={{ width: p + "%" }} />
          </div>
        )}
      </div>

      <div className="row" style={{ gap: "var(--space-2)" }}>
        {kind === "active" && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => act(() => stopVolume(v.tag), "Đã dừng")}
          >
            Dừng
          </button>
        )}
        {kind === "waiting" && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => act(() => runVolume(v.tag), "Đang chạy (headless)")}
          >
            Chạy ngay
          </button>
        )}
        {kind === "done" && (
          <Link
            className="btn btn-secondary btn-sm"
            href={"/document?tag=" + encodeURIComponent(v.tag)}
          >
            Đọc song song
          </Link>
        )}
        {kind === "error" && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => act(() => runVolume(v.tag), "Đang chạy tiếp")}
          >
            Chạy tiếp
          </button>
        )}
      </div>
    </div>
  );
}
