"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStatus } from "../../lib/useStatus";
import {
  volClass,
  volPct,
  pagesLabel,
  stageLabel,
  runVolume,
  stopVolume,
  getLog,
  post,
} from "../../lib/api";
import { Badge } from "../../components/Badge";
import { Cover } from "../../components/Cover";
import { useToast } from "../../components/Providers";
import type { Volume } from "../../lib/types";

type Kind = "active" | "starting" | "waiting" | "done" | "error";

export default function Queue() {
  const s = useStatus(2000);
  const toast = useToast();
  const router = useRouter();
  const openRun = (t: string) => router.push("/run?tag=" + encodeURIComponent(t));
  // Tags the user just launched — shown as "đang khởi động" until the next
  // status poll confirms they are running (spawn + first status write lags a
  // few seconds, so without this the click looks like nothing happened). We
  // track the launch time plus the run's sid so we can distinguish OUR run's
  // outcome from stale run metadata left by a previous run of the same volume.
  const [starting, setStarting] = React.useState<
    Record<string, { at: number; sid?: string }>
  >({});

  const vols = (s?.volumes || []).filter((v) => !v.skip);
  const active = vols.filter((v) => v.running);
  const waiting = vols.filter(
    (v) => v.stage !== "done" && !v.running && v.stage !== "error"
  );
  const donev = vols.filter((v) => v.stage === "done");
  const errv = vols.filter((v) => v.stage === "error" && !v.running);
  const cur = active[0];

  // A launched tag stops being "starting" once it shows up running, once OUR
  // run (matched by sid) has already exited (spawn failed / finished instantly),
  // or after a 20s safety backstop. Matching sid avoids clearing on the stale
  // "exited" metadata a previous run left behind (e.g. "Chạy tiếp" on an error).
  React.useEffect(() => {
    setStarting((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const tag of Object.keys(prev)) {
        const v = vols.find((x) => x.tag === tag);
        const info = prev[tag];
        const ours = !!(v && info.sid && v.sid === info.sid);
        if (
          (v && v.running) ||
          (ours && !v!.running && v!.mode && v!.mode !== "running") ||
          Date.now() - info.at > 20000
        ) {
          delete next[tag];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  const startingSet = new Set(
    Object.keys(starting).filter((t) =>
      vols.some((v) => v.tag === t && !v.running && v.stage !== "done")
    )
  );
  const startingVols = [...startingSet]
    .map((t) => vols.find((v) => v.tag === t))
    .filter((v): v is Volume => !!v);
  const waitingRest = waiting.filter((v) => !startingSet.has(v.tag));
  const errRest = errv.filter((v) => !startingSet.has(v.tag));

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
    } catch (e) {
      toast("Lỗi: " + (e as Error).message);
    }
  };

  const launch = async (tag: string, ok: string) => {
    setStarting((prev) => ({ ...prev, [tag]: { at: Date.now() } }));
    try {
      const r = await runVolume(tag);
      setStarting((prev) =>
        prev[tag] ? { ...prev, [tag]: { at: prev[tag].at, sid: r?.sid } } : prev
      );
      toast(ok);
    } catch (e) {
      setStarting((prev) => {
        const next = { ...prev };
        delete next[tag];
        return next;
      });
      toast("Lỗi: " + (e as Error).message);
    }
  };

  const queueCount = startingVols.length + active.length + waitingRest.length;

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
          <Stat n={waitingRest.length} l="Đang chờ trong hàng đợi" />
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
            <Job key={v.tag} v={v} kind="active" act={act} launch={launch} onOpen={openRun} />
          ))}
          {startingVols.map((v) => (
            <Job key={v.tag} v={v} kind="starting" act={act} launch={launch} onOpen={openRun} />
          ))}
          {waitingRest.map((v) => (
            <Job key={v.tag} v={v} kind="waiting" act={act} launch={launch} onOpen={openRun} />
          ))}
          {queueCount === 0 && (
            <div style={{ padding: "var(--space-4)" }} className="muted">
              Không có cuốn nào trong hàng đợi.
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">Hoàn tất gần đây</div>
          {donev.map((v) => (
            <Job key={v.tag} v={v} kind="done" act={act} launch={launch} onOpen={openRun} />
          ))}
          {errRest.map((v) => (
            <Job key={v.tag} v={v} kind="error" act={act} launch={launch} onOpen={openRun} />
          ))}
          {!donev.length && !errRest.length && (
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

// Progress track with a fixed trailing slot for the percentage. Every row
// reserves the same slot (even when it shows no number) so all tracks start and
// end at the same x — otherwise active rows, which show a %, would end short.
function Track({ pct, cls, showPct }: { pct: number; cls?: string; showPct?: boolean }) {
  return (
    <div className="row" style={{ gap: "var(--space-3)" }}>
      <div className={"progress" + (cls ? " " + cls : "")} style={{ flex: 1 }}>
        <i style={{ width: pct + "%" }} />
      </div>
      <span className="num muted job-pct">{showPct ? pct + "%" : ""}</span>
    </div>
  );
}

// Live tail of the volume's run.log so the user can see *what* the run is doing
// right now, not just the coarse stage. Click to expand the last ~40 lines.
function LogTail({ tag }: { tag: string }) {
  const [lines, setLines] = React.useState<string[]>([]);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = () => {
      // Skip if the previous poll hasn't returned — never stack requests.
      if (inFlight) return;
      inFlight = true;
      getLog(tag)
        .then((d) => {
          if (alive) setLines(d.lines || []);
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [tag]);

  const nonEmpty = lines.filter((l) => l.trim());
  const last = nonEmpty[nonEmpty.length - 1] || "Đang khởi động…";
  if (open) {
    return (
      <div
        className="logtail open"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
        }}
        title="Ẩn log"
      >
        {nonEmpty.slice(-40).join("\n") || "Chưa có log."}
      </div>
    );
  }
  return (
    <div
      className="logtail"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(true);
      }}
      title="Bấm để xem log"
    >
      {last}
    </div>
  );
}

function Job({
  v,
  kind,
  act,
  launch,
  onOpen,
}: {
  v: Volume;
  kind: Kind;
  act: (fn: () => Promise<unknown>, ok: string) => void;
  launch: (tag: string, ok: string) => void;
  onOpen: (tag: string) => void;
}) {
  const p = volPct(v);
  return (
    <div
      className="job job-click"
      role="link"
      tabIndex={0}
      title="Xem chi tiết hoạt động"
      onClick={() => onOpen(v.tag)}
      onKeyDown={(e) => {
        // Only when the row itself is focused — not a bubbling Enter/Space from
        // an inner action button (those handle their own activation).
        if (
          (e.key === "Enter" || e.key === " ") &&
          e.target === e.currentTarget
        ) {
          e.preventDefault();
          onOpen(v.tag);
        }
      }}
    >
      <div className="row" style={{ gap: "var(--space-3)", minWidth: 0 }}>
        <Cover tag={v.tag} dpi={60} style={{ width: 40, flex: "none" }} />
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <strong>{v.display}</strong>
            <Badge
              kind={
                kind === "starting"
                  ? "draft"
                  : kind === "waiting"
                  ? v.stage === "review"
                    ? "review"
                    : "draft"
                  : volClass(v)
              }
            />
          </div>
          <div className="muted num" style={{ fontSize: "var(--text-xs)" }}>
            {v.tag} · {v.engine || ""}
          </div>
        </div>
      </div>

      <div className="job-mid">
        {kind === "active" && (
          <>
            <Track pct={p} showPct />
            <div
              className="row muted"
              style={{ fontSize: "var(--text-xs)", marginTop: 6, gap: "var(--space-2)" }}
            >
              <span className="job-live" />
              {stageLabel(v.stage)} · {pagesLabel(v)}
            </div>
            <LogTail tag={v.tag} />
          </>
        )}
        {kind === "starting" && (
          <>
            <Track pct={p || 4} />
            <div
              className="row muted"
              style={{ fontSize: "var(--text-xs)", marginTop: 6, gap: "var(--space-2)" }}
            >
              <span className="job-live" />
              Đang khởi động…
            </div>
          </>
        )}
        {kind === "waiting" && <Track pct={p} />}
        {kind === "done" && <Track pct={100} cls="ok" />}
        {kind === "error" && <Track pct={p} cls="warn" />}
      </div>

      <div className="job-actions" onClick={(e) => e.stopPropagation()}>
        {kind === "active" && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => act(() => stopVolume(v.tag), "Đã dừng")}
          >
            Dừng
          </button>
        )}
        {kind === "starting" && (
          <button className="btn btn-secondary btn-sm" disabled>
            Khởi động…
          </button>
        )}
        {kind === "waiting" && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() =>
              launch(
                v.tag,
                v.stage === "review" ? "Đang chạy để sửa layout" : "Đang chạy (headless)"
              )
            }
          >
            {v.stage === "review" ? `Chạy để sửa (${v.defects || 0})` : "Chạy ngay"}
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
            onClick={() => launch(v.tag, "Đang chạy tiếp")}
          >
            Chạy tiếp
          </button>
        )}
      </div>
    </div>
  );
}
