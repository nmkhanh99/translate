import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AppConfig, EngineId } from "@cfa-translate/shared";
import { CFG_PATH } from "./paths.js";

export const DEFAULT_CFG: Required<
  Pick<
    AppConfig,
    | "engine"
    | "model"
    | "posture"
    | "vision"
    | "codex_batch"
    | "agents"
    | "budget"
    | "budget_warn"
  >
> = {
  engine: "claude",
  model: "sonnet",
  posture: "allowlist",
  vision: true,
  codex_batch: 25,
  agents: 3,
  budget: 100,
  budget_warn: 90,
};

export const ENGINES: EngineId[] = ["claude", "codex", "grok"];
export const MODELS = ["sonnet", "opus", "haiku"];
export const POSTURES = ["allowlist", "bypass"];

export function loadCfg(): AppConfig {
  const cfg: AppConfig = { ...DEFAULT_CFG };
  if (existsSync(CFG_PATH)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(CFG_PATH, "utf8")));
    } catch {
      /* ignore */
    }
  }
  return cfg;
}

export function saveCfg(cfg: AppConfig) {
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 1), "utf8");
}
