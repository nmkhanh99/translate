"use client";
import * as React from "react";
import { getStatus, getAgents, saveConfig } from "../../lib/api";
import { useToast } from "../../components/Providers";
import type { AppConfig, AgentDetection, Engine } from "../../lib/types";
import {
  normalizeModel,
  fieldVisibleForEngine,
  defaultModel,
  isCliDefault,
  modelOptionsForEngine,
  CLI_DEFAULT_MODEL,
  type ModelOption,
} from "@cfa-translate/shared";

export default function Settings() {
  const toast = useToast();
  const [cfg, setCfg] = React.useState<AppConfig | null>(null);
  const [agents, setAgents] = React.useState<AgentDetection[]>([]);
  /** Discovered model ids per engine from /api/status (runtime CLI, not git). */
  const [discovered, setDiscovered] = React.useState<
    Partial<Record<Engine, string[]>>
  >({});
  const [modelMode, setModelMode] = React.useState<"default" | "pick" | "custom">(
    "default"
  );

  React.useEffect(() => {
    Promise.all([getStatus(), getAgents()])
      .then(([s, a]) => {
        const raw = s.config || {};
        const engine = (raw.engine as Engine) || "claude";
        const model = normalizeModel(engine, raw.model);
        setCfg({ ...raw, engine, model });
        setAgents(a.agents || []);
        const byEng =
          (s as { models_discovered?: Partial<Record<Engine, string[]>> })
            .models_discovered || {};
        // Prefer discovered ids; also merge labels from models_by_engine if present
        const fromApi = (s as { models_by_engine?: Partial<Record<Engine, ModelOption[]>> })
          .models_by_engine;
        const d: Partial<Record<Engine, string[]>> = { ...byEng };
        if (fromApi) {
          for (const e of ["claude", "codex", "grok"] as Engine[]) {
            const ids = (fromApi[e] || [])
              .map((m) => m.id)
              .filter((id) => id && id !== CLI_DEFAULT_MODEL);
            if (ids.length) d[e] = ids;
          }
        }
        setDiscovered(d);
        const disc = d[engine] || [];
        if (isCliDefault(model)) setModelMode("default");
        else if (disc.includes(model)) setModelMode("pick");
        else setModelMode("custom");
      })
      .catch((e) => toast("Lỗi tải cài đặt: " + e.message));
  }, [toast]);

  function setEngine(engine: string) {
    // Match UI "Mặc định CLI": always reset model to CLI default on engine
    // switch — do NOT keep previous engine's id (e.g. grok-4.5 under claude).
    setCfg((c) => ({
      ...(c || {}),
      engine,
      model: CLI_DEFAULT_MODEL,
    }));
    setModelMode("default");
  }

  function setModelFromUi(mode: "default" | "pick" | "custom", value?: string) {
    setModelMode(mode);
    setCfg((c) => {
      const engine = (c?.engine as Engine) || "claude";
      let model = CLI_DEFAULT_MODEL;
      if (mode === "pick" && value) model = value;
      if (mode === "custom" && value != null) model = value.trim() || CLI_DEFAULT_MODEL;
      if (mode === "default") model = CLI_DEFAULT_MODEL;
      return { ...(c || {}), model: normalizeModel(engine, model) };
    });
  }

  async function save() {
    if (!cfg) return;
    const engine = (cfg.engine as Engine) || "claude";
    const model = normalizeModel(engine, cfg.model);
    try {
      await saveConfig({
        engine,
        model,
        posture: cfg.posture || "allowlist",
        vision: cfg.vision !== false,
        codex_batch: cfg.codex_batch ?? 25,
        agents: cfg.agents ?? 3,
      });
      setCfg((c) => ({ ...(c || {}), engine, model }));
      toast("Đã lưu cài đặt");
    } catch (e) {
      toast("Lỗi lưu: " + (e as Error).message);
    }
  }

  async function rescan() {
    try {
      const [a, s] = await Promise.all([getAgents(), getStatus()]);
      setAgents(a.agents || []);
      const byEng =
        (s as { models_discovered?: Partial<Record<Engine, string[]>> })
          .models_discovered || {};
      setDiscovered(byEng);
      toast("Đã quét lại CLI + model trên máy");
    } catch (e) {
      toast("Lỗi quét: " + (e as Error).message);
    }
  }

  if (!cfg) return <div className="page">Đang tải…</div>;

  const engine = (cfg.engine as Engine) || "claude";
  const modelVal = normalizeModel(engine, cfg.model);
  const modelOpts = modelOptionsForEngine(engine, discovered[engine] || []);
  const discoveredOpts = modelOpts.filter((m) => m.id !== CLI_DEFAULT_MODEL);
  const showCodexBatch = fieldVisibleForEngine("codex_batch", engine);
  const showAgents = fieldVisibleForEngine("agents", engine);
  const engineLabel =
    engine === "claude" ? "Claude" : engine === "codex" ? "Codex" : "Grok";

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
            bấm <b>Quét lại CLI</b>. Model list lấy từ CLI lúc quét — không hard-code
            trong app.
          </p>
        </section>

        <section className="card stack-4">
          <h2>Engine dịch</h2>
          <div className="grid-2">
            <div className="field">
              <label>Engine (CLI)</label>
              <select
                className="input"
                value={engine}
                onChange={(e) => setEngine(e.target.value)}
              >
                <option value="claude">Claude — pipeline runner</option>
                <option value="codex">Codex — MCP theo lô trang</option>
                <option value="grok">Grok — MCP + always-approve</option>
              </select>
            </div>
            <div className="field">
              <label>Model ({engineLabel})</label>
              <select
                className="input"
                value={
                  modelMode === "default"
                    ? CLI_DEFAULT_MODEL
                    : modelMode === "custom"
                      ? "__custom__"
                      : modelVal
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === CLI_DEFAULT_MODEL) setModelFromUi("default");
                  else if (v === "__custom__")
                    setModelFromUi(
                      "custom",
                      isCliDefault(modelVal) ? "" : modelVal
                    );
                  else setModelFromUi("pick", v);
                }}
              >
                <option value={CLI_DEFAULT_MODEL}>
                  Mặc định CLI (để {engineLabel} tự chọn)
                </option>
                {discoveredOpts.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.discovered ? " · từ CLI" : ""}
                  </option>
                ))}
                <option value="__custom__">Nhập tay (id model)…</option>
              </select>
              {modelMode === "custom" && (
                <input
                  className="input"
                  style={{ marginTop: 8 }}
                  placeholder={`vd. id model ${engineLabel} (không hard-code trong app)`}
                  value={isCliDefault(modelVal) ? "" : modelVal}
                  onChange={(e) => setModelFromUi("custom", e.target.value)}
                />
              )}
              <span className="hint">
                {discoveredOpts.length
                  ? `Đã quét ${discoveredOpts.length} model từ CLI ${engineLabel}.`
                  : `CLI chưa trả list model — dùng mặc định hoặc nhập tay.`}{" "}
                Không dùng danh sách model cố định trong repo (sẽ lệch khi CLI
                cập nhật).
              </span>
            </div>
            <div className="field">
              <label>Quyền (posture)</label>
              <select
                className="input"
                value={cfg.posture || "allowlist"}
                onChange={(e) =>
                  setCfg((c) => ({ ...(c || {}), posture: e.target.value }))
                }
              >
                <option value="allowlist">allowlist (an toàn)</option>
                <option value="bypass">bypass (Codex headless MCP)</option>
              </select>
              <span className="hint">
                Codex full-run MCP thường cần <b>bypass</b>.
              </span>
            </div>
            {showCodexBatch && (
              <div className="field">
                <label>Lô trang (Codex/Grok full-run)</label>
                <input
                  className="input num"
                  type="number"
                  min={5}
                  max={200}
                  value={cfg.codex_batch ?? 25}
                  onChange={(e) =>
                    setCfg((c) => ({
                      ...(c || {}),
                      codex_batch: parseInt(e.target.value, 10) || 25,
                    }))
                  }
                />
              </div>
            )}
            {showAgents && (
              <div className="field">
                <label>Agent song song (pipeline runner)</label>
                <input
                  className="input num"
                  type="number"
                  min={1}
                  max={10}
                  value={cfg.agents ?? 3}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10) || 3;
                    setCfg((c) => ({
                      ...(c || {}),
                      agents: Math.max(1, Math.min(10, n)),
                    }));
                  }}
                />
              </div>
            )}
          </div>
          <p className="hint">
            Engine: <b>{engine}</b> · model:{" "}
            <b>{isCliDefault(modelVal) ? "CLI default" : modelVal}</b>
            {modelVal === defaultModel(engine) ? "" : ""}.
          </p>
        </section>

      </div>
    </>
  );
}
