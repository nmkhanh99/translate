"use client";
// Chi tiết một lần chạy/tài liệu: tiến độ từng stage (dịch → rà soát → soát
// layout → sửa), số trang defect còn lại, và log hoạt động trực tiếp. Mở từ
// Hàng đợi (bấm vào một dòng) hoặc /run?tag=<tag>.
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useStatus } from "../../lib/useStatus";
import {
  volClass,
  stageLabel,
  runVolume,
  stopVolume,
  setVolEngine,
  redoStage,
  getLog,
  getDefectReport,
  type DefectCluster,
} from "../../lib/api";
import { Badge } from "../../components/Badge";
import { Cover } from "../../components/Cover";
import { EngineSwitch } from "../../components/EngineSwitch";
import { useToast, useEngine } from "../../components/Providers";
import type { Volume, Engine } from "../../lib/types";

export default function RunPage() {
  return (
    <React.Suspense fallback={<div className="page">Đang tải…</div>}>
      <RunDetail />
    </React.Suspense>
  );
}

function pct(t?: [number, number]): number {
  if (!t || !t[1]) return 0;
  return Math.round((100 * (t[0] || 0)) / t[1]);
}

function RunDetail() {
  const sp = useSearchParams();
  const tag = sp.get("tag") || "";
  const s = useStatus(2000);
  const toast = useToast();
  const { available, rescanAgents } = useEngine();
  const v = (s?.volumes || []).find((x) => x.tag === tag);
  // Engine chọn riêng cho cuốn này: local pick > pref đã lưu > engine global.
  // Fallback lấy TỪ s.config.engine (hydrate cùng trang) chứ không phải giá trị
  // mặc định "claude" của provider — tránh chạy nhầm Claude khi global là Codex/Grok.
  const [engineSel, setEngineSel] = React.useState<Engine | null>(null);
  const effEngine = (engineSel ||
    (v?.pref_engine as Engine) ||
    (s?.config?.engine as Engine) ||
    "claude") as Engine;

  const [redoPages, setRedoPages] = React.useState("");
  const redo = (stage: "translate" | "verify" | "vision", pages?: string) =>
    act(
      () => redoStage(tag, stage, { pages, engine: effEngine }),
      pages
        ? `Đang soát lại trang ${pages}`
        : stage === "translate"
        ? "Đang dịch lại"
        : stage === "verify"
        ? "Đang rà soát lại"
        : "Đang soát layout lại",
    );

  const pickEngine = async (e: Engine) => {
    setEngineSel(e);
    if (tag) {
      try {
        await setVolEngine(tag, e);
        toast("Cuốn này sẽ dịch bằng: " + e);
      } catch (err) {
        toast("Lỗi: " + (err as Error).message);
      }
    }
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
    } catch (e) {
      toast("Lỗi: " + (e as Error).message);
    }
  };

  if (!s) return <div className="page">Đang tải…</div>;
  if (!v) {
    return (
      <>
        <div className="topbar">
          <div>
            <h1>Chi tiết</h1>
            <div className="sub">Không tìm thấy tài liệu “{tag}”.</div>
          </div>
        </div>
        <div className="page">
          <Link className="btn btn-secondary" href="/queue">
            ← Về Hàng đợi
          </Link>
        </div>
      </>
    );
  }

  const cls = volClass(v);
  const running = !!v.running;
  const defects = v.defects || 0;

  return (
    <>
      <div className="topbar">
        <Link className="btn btn-ghost btn-sm" href="/queue" title="Về Hàng đợi">
          ← Hàng đợi
        </Link>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {v.display}
          </h1>
          <div className="sub num" style={{ fontSize: "var(--text-xs)" }}>
            {v.tag} · {v.engine || "—"} · {stageLabel(v.stage)}
          </div>
        </div>
        <span className="spacer" />
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <Badge kind={cls} />
          {!running && (
            <EngineSwitch
              value={effEngine}
              onChange={pickEngine}
              available={available}
              onRescan={rescanAgents}
              ariaLabel="Chọn CLI dịch cuốn này"
            />
          )}
          {running ? (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => act(() => stopVolume(v.tag), "Đã dừng")}
            >
              Dừng
            </button>
          ) : v.stage === "review" ? (
            <button
              className="btn btn-primary btn-sm"
              onClick={() =>
                act(() => runVolume(v.tag, effEngine), "Đang chạy để sửa layout")
              }
            >
              Chạy để sửa ({defects})
            </button>
          ) : v.stage !== "done" ? (
            <button
              className="btn btn-primary btn-sm"
              onClick={() =>
                act(() => runVolume(v.tag, effEngine), "Đang chạy (headless)")
              }
            >
              {cls === "error" ? "Chạy tiếp" : "Chạy"}
            </button>
          ) : null}
          {v.out_exists && (
            <Link
              className="btn btn-secondary btn-sm"
              href={"/document?tag=" + encodeURIComponent(v.tag)}
            >
              Đọc song song
            </Link>
          )}
        </div>
      </div>

      <div className="page stack-6">
        <section className="row" style={{ gap: "var(--space-4)", alignItems: "flex-start" }}>
          <Cover tag={v.tag} dpi={80} style={{ width: 90, flex: "none" }} />
          <div className="stack-4" style={{ flex: 1, minWidth: 0 }}>
            <StageBar label="Dịch" t={v.translate} sub="đoạn văn bản đã dịch" />
            <StageBar label="Rà soát" t={v.verify} sub="đối chiếu số/bỏ sót vs bản Anh" />
            <StageBar
              label="Soát layout"
              t={v.vision}
              sub="trang đã review layout (vision)"
            />
            <div className="card card-pad-sm">
              <div className="row-between">
                <div>
                  <strong>Lỗi layout cần sửa</strong>
                  <div className="muted" style={{ fontSize: "var(--text-xs)", marginTop: 2 }}>
                    Trang bị tràn/vỡ khung (defect ≥ medium, chưa chấp nhận). Chạy lại
                    để pipeline tự rút gọn bản dịch và soát lại đúng các trang này.
                  </div>
                </div>
                <span
                  className="num"
                  style={{
                    fontSize: "var(--text-xl)",
                    color: defects ? "var(--warn)" : "var(--success)",
                  }}
                >
                  {defects}
                </span>
              </div>
              {defects > 0 && (
                <DefectClusters
                  tag={v.tag}
                  defects={defects}
                  stage={v.stage}
                  onPickPages={setRedoPages}
                />
              )}
            </div>
          </div>
        </section>

        {!running && (
          <div className="panel">
            <div className="panel-head">Chạy lại</div>
            <div className="stack-4" style={{ padding: "var(--space-4)" }}>
              <div className="row wrap" style={{ gap: "var(--space-2)" }}>
                <button className="btn btn-secondary btn-sm" onClick={() => redo("translate")}>
                  Dịch lại
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => redo("verify")}>
                  Rà soát lại
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => redo("vision")}>
                  Soát layout lại (cả cuốn)
                </button>
              </div>
              <div
                className="row wrap"
                style={{ gap: "var(--space-2)", alignItems: "center" }}
              >
                <input
                  className="input"
                  placeholder="VD: 5-10, 12, 15"
                  value={redoPages}
                  onChange={(e) => setRedoPages(e.target.value)}
                  style={{ width: 170 }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!redoPages.trim()}
                  onClick={() => redo("vision", redoPages.trim())}
                >
                  Soát lại trang cụ thể
                </button>
                <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                  Số trang (1-based), cách nhau dấu phẩy hoặc dạng khoảng a-b.
                </span>
              </div>
              <div className="muted" style={{ fontSize: "var(--text-xs)" }}>
                Rà soát & Soát layout chạy bằng pipeline <b>Claude</b> (chọn engine ở
                trên). “Dịch lại” xoá bản dịch cũ và làm lại các bước sau.
              </div>
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panel-head">
            Hoạt động (log)
            <span className="spacer" />
            {running ? (
              <span className="badge badge-accent">
                <span className="dot" />
                đang chạy
              </span>
            ) : (
              <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                {stageLabel(v.stage)}
              </span>
            )}
          </div>
          <LogPanel tag={v.tag} live={running} />
        </div>
      </div>
    </>
  );
}

const CLUSTER_VN: Record<string, string> = {
  congthuc_vo: "Công thức vỡ",
  bang_vo: "Bảng vỡ",
  bullet_indent: "Bullet / thụt lề",
  highlight_mat: "Mất highlight",
  chu_de_chong: "Chữ đè chồng",
  tran_khung: "Tràn khung",
  label_tach_dong: "Nhãn tách dòng",
  header_hong: "Header hỏng",
  khac: "Khác",
};
const CHANNEL_VN: Record<string, { label: string; cls: string }> = {
  text: { label: "tự rút gọn được", cls: "badge-success" },
  code: { label: "cần sửa engine", cls: "badge-warn" },
  policy: { label: "chính sách engine", cls: "" },
  mixed: { label: "text + engine", cls: "badge-accent" },
  unknown: { label: "chưa phân loại", cls: "" },
};

// Cụm lỗi layout (từ /api/defects). Bấm một cụm -> điền số trang (1-based) vào ô
// "Soát lại trang cụ thể" để chạy lại vision đúng các trang đó.
function DefectClusters({
  tag,
  defects,
  stage,
  onPickPages,
}: {
  tag: string;
  defects: number;
  stage: string;
  onPickPages: (pages: string) => void;
}) {
  const [clusters, setClusters] = React.useState<DefectCluster[] | null>(null);
  React.useEffect(() => {
    let alive = true;
    // Xoá danh sách cũ ngay khi refetch — cluster stale bấm vào sẽ điền nhầm
    // trang; refetch theo cả stage vì tập trang/kênh có thể đổi mà SỐ defect
    // tình cờ giữ nguyên.
    setClusters(null);
    getDefectReport(tag)
      .then((d) => {
        if (alive) setClusters(d.clusters || []);
      })
      .catch(() => {
        if (alive) setClusters([]);
      });
    return () => {
      alive = false;
    };
  }, [tag, defects, stage]);

  if (!clusters) {
    return (
      <div className="muted" style={{ fontSize: "var(--text-xs)", marginTop: 8 }}>
        Đang phân tích cụm lỗi…
      </div>
    );
  }
  if (!clusters.length) return null;
  return (
    <div className="stack-2" style={{ marginTop: "var(--space-3)" }}>
      {clusters.map((c) => (
        <button
          key={c.name}
          type="button"
          className="defect-cluster"
          title={
            (c.sample_details[0]?.detail || "") +
            "\n→ Bấm để điền các trang này vào ô Soát lại"
          }
          onClick={() => onPickPages(c.pages.map((p) => p + 1).join(", "))}
        >
          <span>{CLUSTER_VN[c.name] || c.name}</span>
          <span className={"badge " + (CHANNEL_VN[c.channel]?.cls || "")}>
            {CHANNEL_VN[c.channel]?.label || c.channel}
          </span>
          <span className="spacer" />
          <span className="num muted">
            {c.count} lỗi · {c.pages.length} trang
          </span>
        </button>
      ))}
      <div className="muted" style={{ fontSize: "var(--text-xs)" }}>
        “Cần sửa engine”: rút gọn bản dịch không chữa được — xem{" "}
        <span className="num">python/LAYOUT_PLAYBOOK.md</span> (quy trình golden-diff).
      </div>
    </div>
  );
}

function StageBar({
  label,
  t,
  sub,
}: {
  label: string;
  t?: [number, number];
  sub: string;
}) {
  const p = pct(t);
  const done = t?.[0] ?? 0;
  const tot = t?.[1] ?? 0;
  return (
    <div>
      <div className="row-between" style={{ marginBottom: 4 }}>
        <strong style={{ fontSize: "var(--text-sm)" }}>{label}</strong>
        <span className="num muted" style={{ fontSize: "var(--text-xs)" }}>
          {done}/{tot} · {p}%
        </span>
      </div>
      <div className="progress">
        <i style={{ width: p + "%" }} />
      </div>
      <div className="muted" style={{ fontSize: "var(--text-xs)", marginTop: 3 }}>
        {sub}
      </div>
    </div>
  );
}

function LogPanel({ tag, live }: { tag: string; live: boolean }) {
  const [lines, setLines] = React.useState<string[]>([]);
  const boxRef = React.useRef<HTMLPreElement>(null);
  React.useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = () => {
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
    // Poll faster while running; slow ticks when idle just to catch a restart.
    const id = setInterval(tick, live ? 2000 : 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [tag, live]);

  React.useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // CLI (Codex/Grok) hay stream nhiều message NỐI LIỀN không xuống dòng. Chèn
  // ngắt sau dấu kết câu ) . ! ? : khi ngay sau là chữ HOA / ` / * (bắt đầu
  // message mới) để dễ đọc — không đụng số thập phân (theo sau là chữ số).
  // Lưu ý: KHÔNG dùng range [À-Ỵ] — dải đó lẫn cả chữ thường (à, đ…) và thiếu
  // Ỷ/Ỹ; liệt kê tường minh các chữ HOA tiếng Việt.
  const text = lines
    .filter((l) => l.length)
    .join("\n")
    .replace(
      /([.!?:)\]])(?=[A-Z`*ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬĐÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ])/g,
      "$1\n"
    );
  return (
    <pre className="log-panel" ref={boxRef}>
      {text || "Chưa có log. Bấm Chạy để bắt đầu."}
    </pre>
  );
}
