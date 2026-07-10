"use client";
import * as React from "react";
import { getStatus, getAgents, saveConfig } from "../../lib/api";
import { useToast } from "../../components/Providers";
import type { AppConfig, AgentDetection } from "../../lib/types";

export default function Settings() {
  const toast = useToast();
  const [cfg, setCfg] = React.useState<AppConfig | null>(null);
  const [agents, setAgents] = React.useState<AgentDetection[]>([]);

  React.useEffect(() => {
    Promise.all([getStatus(), getAgents()])
      .then(([s, a]) => {
        setCfg(s.config || {});
        setAgents(a.agents || []);
      })
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
        posture: cfg.posture || "allowlist",
        vision: cfg.vision !== false,
        codex_batch: cfg.codex_batch ?? 25,
      });
      toast("Đã lưu cài đặt");
    } catch (e) {
      toast("Lỗi lưu: " + (e as Error).message);
    }
  }

  async function rescan() {
    try {
      const a = await getAgents();
      setAgents(a.agents || []);
      toast("Đã quét lại CLI trên máy");
    } catch (e) {
      toast("Lỗi quét: " + (e as Error).message);
    }
  }

  if (!cfg) return <div className="page">Đang tải…</div>;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Cài đặt</h1>
          <div className="sub">
            Local CLI (Claude / Codex / Grok) — detect trên PATH như open-design.
          </div>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={rescan}>
          Quét lại CLI
        </button>
        <button className="btn btn-primary" onClick={save}>
          Lưu
        </button>
      </div>

      <div className="page narrow stack-6">
        <section className="card stack-4">
          <div className="row-between">
            <div>
              <h2>Chế độ chạy — Local CLI</h2>
              <div className="hint">
                Chạy qua CLI code-agent trên máy (agent-native) — không gọi API
                cloud.
              </div>
            </div>
            <span className="count-badge">
              {agents.filter((a) => a.available).length}/{agents.length} đã cài
            </span>
          </div>
          <div className="cli-list">
            {agents.map((a) => (
              <div key={a.id} className={"cli-row" + (a.available ? "" : " off")}>
                <span className={"cli-dot" + (a.available ? " on" : "")} />
                <div className="cli-main">
                  <strong>{a.displayName}</strong>
                  <div className="hint mono">
                    {a.available
                      ? `${a.executablePath}${a.version ? " · " + a.version : ""}`
                      : "chưa dò thấy trên PATH"}
                  </div>
                </div>
                <span className={"cli-status" + (a.available ? " ok" : "")}>
                  {a.available ? "sẵn sàng" : "thiếu"}
                </span>
              </div>
            ))}
          </div>
          <p className="hint">
            Cài <code>claude</code> / <code>codex</code> / <code>grok</code> rồi
            bấm <b>Quét lại CLI</b>. Dò theo PATH — CLI cài qua nvm/volta/bun vẫn
            nhận.
          </p>
        </section>

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
                <option value="claude">Claude — Workflow 4-phase</option>
                <option value="codex">Codex — MCP theo lô trang</option>
                <option value="grok">Grok — MCP + always-approve</option>
              </select>
            </div>
            <div className="field">
              <label>Model (Claude)</label>
              <select
                className="input"
                value={/opus/i.test(cfg.model || "") ? "opus" : "sonnet"}
                onChange={(e) => set("model", e.target.value)}
              >
                <option value="sonnet">Sonnet — cân bằng</option>
                <option value="opus">Opus — chất lượng cao</option>
              </select>
            </div>
            <div className="field">
              <label>Quyền (posture)</label>
              <select
                className="input"
                value={cfg.posture || "allowlist"}
                onChange={(e) => set("posture", e.target.value)}
              >
                <option value="allowlist">allowlist (an toàn)</option>
                <option value="bypass">bypass (Codex headless MCP)</option>
              </select>
              <span className="hint">
                Codex headless cần bypass để MCP tool call không bị auto-cancel.
              </span>
            </div>
            <div className="field">
              <label>Lô trang (Codex/Grok)</label>
              <input
                className="input num"
                type="number"
                min={5}
                max={200}
                value={cfg.codex_batch ?? 25}
                onChange={(e) =>
                  set("codex_batch", parseInt(e.target.value, 10) || 25)
                }
              />
            </div>
          </div>
        </section>

        <section className="card stack-4">
          <h2>Ngân sách (theo dõi)</h2>
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
        </section>
      </div>
    </>
  );
}
