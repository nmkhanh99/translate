"use client";
import * as React from "react";
import { getStatus, saveConfig } from "../../lib/api";
import { useToast } from "../../components/Providers";
import type { AppConfig } from "../../lib/types";

export default function Settings() {
  const toast = useToast();
  const [cfg, setCfg] = React.useState<AppConfig | null>(null);

  React.useEffect(() => {
    getStatus()
      .then((s) => setCfg(s.config || {}))
      .catch((e) => toast("Lỗi tải cài đặt: " + e.message));
  }, [toast]);

  function set<K extends keyof AppConfig>(k: K, v: AppConfig[K]) {
    setCfg((c) => ({ ...(c || {}), [k]: v }));
  }

  async function save() {
    if (!cfg) return;
    try {
      await saveConfig({
        engine: cfg.engine || "claude",
        model: cfg.model || "sonnet",
        budget: cfg.budget ?? 100,
        budget_warn: cfg.budget_warn ?? 90,
      });
      toast("Đã lưu cài đặt");
    } catch (e) {
      toast("Lỗi lưu: " + (e as Error).message);
    }
  }

  if (!cfg) return <div className="page">Đang tải…</div>;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Cài đặt</h1>
          <div className="sub">Engine, model và ngân sách cho lần chạy kế tiếp.</div>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={save}>
          Lưu
        </button>
      </div>

      <div className="page narrow stack-6">
        <section className="card stack-4">
          <h2>Engine dịch</h2>
          <div className="grid-2">
            <div className="field">
              <label>Engine</label>
              <select
                className="input"
                value={cfg.engine || "claude"}
                onChange={(e) => set("engine", e.target.value)}
              >
                <option value="claude">Claude — 4 bước, chất lượng cao</option>
                <option value="codex">Codex — MCP theo lô trang</option>
                <option value="grok">Grok — nhanh, gọn</option>
              </select>
              <span className="hint">
                Cũng là engine mặc định gợi ý cho khung chat theo tài liệu.
              </span>
            </div>
            <div className="field">
              <label>Model (Claude)</label>
              <select
                className="input"
                value={/opus/i.test(cfg.model || "") ? "opus" : "sonnet"}
                onChange={(e) => set("model", e.target.value)}
              >
                <option value="sonnet">Sonnet — cân bằng (mặc định)</option>
                <option value="opus">Opus — chất lượng cao nhất</option>
              </select>
              <span className="hint">Chỉ áp dụng cho engine Claude.</span>
            </div>
          </div>
        </section>

        <section className="card stack-4">
          <h2>Ngân sách</h2>
          <div className="grid-2">
            <div className="field">
              <label>Ngân sách tháng (USD)</label>
              <input
                className="input num"
                type="number"
                value={cfg.budget ?? 100}
                onChange={(e) => set("budget", parseFloat(e.target.value) || 100)}
              />
            </div>
            <div className="field">
              <label>Cảnh báo khi đạt (%)</label>
              <select
                className="input"
                value={String(cfg.budget_warn ?? 90)}
                onChange={(e) => set("budget_warn", parseInt(e.target.value) || 90)}
              >
                {[70, 80, 90, 95].map((n) => (
                  <option key={n} value={n}>
                    {n}%
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="hint">
            App không tự trừ tiền — chi phí thực nằm ở gói Claude/Codex/Grok trên
            máy. Con số này chỉ để bạn theo dõi.
          </p>
        </section>
      </div>
    </>
  );
}
