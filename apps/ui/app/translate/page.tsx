"use client";
import * as React from "react";
import Link from "next/link";
import { getStatus, uploadPdf, runVolume, pagesLabel } from "../../lib/api";
import { useToast, useEngine } from "../../components/Providers";
import { EngineSwitch } from "../../components/EngineSwitch";
import { Cover } from "../../components/Cover";
import { IconUpload } from "../../components/icons";
import type { Volume } from "../../lib/types";

export default function Translate() {
  const toast = useToast();
  const { engine, setEngine, available } = useEngine();
  const [drag, setDrag] = React.useState(false);
  const [selected, setSelected] = React.useState<Volume | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function upload(f: File) {
    if (!/\.pdf$/i.test(f.name)) {
      toast("Chỉ nhận PDF");
      return;
    }
    toast("Đang tải “" + f.name + "”…");
    try {
      await uploadPdf(f);
      const st = await getStatus();
      const name = f.name.replace(/\.pdf$/i, "");
      const users = st.volumes.filter((x) => x.user);
      const v = users.filter((x) => x.display === name)[0] || users.slice(-1)[0];
      if (v) {
        setSelected(v);
        toast("Đã thêm “" + name + "” — bấm Bắt đầu dịch");
      }
    } catch (e) {
      toast("Lỗi tải: " + (e as Error).message);
    }
  }

  async function start() {
    if (!selected) {
      toast("Chọn/tải một PDF trước");
      return;
    }
    try {
      await runVolume(selected.tag);
      toast("Đã bắt đầu dịch (headless) — xem ở Hàng đợi");
    } catch (e) {
      toast("Lỗi: " + (e as Error).message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Dịch tài liệu</h1>
          <div className="sub">Tải PDF lên → chọn CLI dịch → Bắt đầu dịch.</div>
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
      </div>

      <div className="page narrow stack-6">
        <div
          className={"dropzone" + (drag ? " drag" : "")}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            e.preventDefault();
            setDrag(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer?.files?.[0];
            if (f) upload(f);
          }}
        >
          <div className="dz-mark">
            <IconUpload />
          </div>
          <h3>Kéo thả PDF vào đây, hoặc bấm để chọn</h3>
          <p className="muted" style={{ marginTop: 6 }}>
            File được copy vào <span className="num">input/</span>; bản dịch xuất ra{" "}
            <span className="num">output/&lt;tên&gt;_vi.pdf</span>.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
        </div>

        {selected && (
          <section className="card">
            <div className="row-between wrap" style={{ gap: "var(--space-4)" }}>
              <div className="row" style={{ gap: "var(--space-4)" }}>
                <Cover tag={selected.tag} dpi={60} style={{ width: 48, flex: "none" }} />
                <div>
                  <h3>{selected.display}</h3>
                  <div className="sub muted num" style={{ fontSize: "var(--text-xs)" }}>
                    {pagesLabel(selected)} · PDF gốc
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: "var(--space-2)" }}>
                <Link
                  className="btn btn-ghost btn-sm"
                  href={"/document?tag=" + encodeURIComponent(selected.tag)}
                >
                  Mở chi tiết
                </Link>
                <button className="btn btn-primary" onClick={start}>
                  Bắt đầu dịch
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="card card-pad-sm">
          <h3 style={{ fontSize: "var(--text-base)" }}>Các bước</h3>
          <ol className="muted" style={{ margin: "var(--space-2) 0 0", paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Tải hoặc kéo-thả một file PDF (curriculum hoặc tài liệu bất kỳ).</li>
            <li>
              Chọn <b>CLI dịch</b> ở góc phải trên: <b>Claude</b> (4 bước, chất
              lượng cao nhất), <b>Codex</b> hoặc <b>Grok</b> (dịch qua MCP theo lô
              trang). Lựa chọn được lưu và dùng cho nút Dịch ở mọi nơi.
            </li>
            <li>
              Bấm <b>Bắt đầu dịch</b> để chạy headless; theo dõi ở <b>Hàng đợi</b>.
            </li>
            <li>
              Cần hỏi/điều khiển AI theo cuốn cụ thể → mở <b>chi tiết tài liệu</b>
              {" "}(bấm vào cuốn trong <b>Thư viện</b>, hoặc <b>Mở chi tiết</b> ở
              trên) rồi bấm <b>Hỏi AI</b>.
            </li>
          </ol>
        </section>
      </div>
    </>
  );
}
