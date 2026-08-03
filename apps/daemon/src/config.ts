import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AppConfig, EngineId, ModelOption } from "@cfa-translate/shared";
import {
  CLI_DEFAULT_MODEL,
  isEngineId,
  modelOptionsForEngine,
  normalizeModel,
} from "@cfa-translate/shared";
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
  model: CLI_DEFAULT_MODEL, // omit flag — let installed CLI choose
  posture: "allowlist",
  vision: true,
  codex_batch: 25,
  agents: 3,
  budget: 100,
  budget_warn: 90,
};

export const ENGINES: EngineId[] = ["claude", "codex", "grok"];
/** @deprecated no static product list — discovery + free-text */
export const MODELS: string[] = [];
export const POSTURES = ["allowlist", "bypass"];

/**
 * Build model options for API: CLI default + discovered ids (no frozen catalog).
 */
export function modelsByEngine(
  discovered: Partial<Record<EngineId, string[]>> = {}
): Record<EngineId, ModelOption[]> {
  return {
    claude: modelOptionsForEngine("claude", discovered.claude),
    codex: modelOptionsForEngine("codex", discovered.codex),
    grok: modelOptionsForEngine("grok", discovered.grok),
  };
}

/** Normalize engine+model pair so config never keeps Claude aliases under Grok. */
export function normalizeConfig(cfg: AppConfig): AppConfig {
  const engine = isEngineId(cfg.engine) ? cfg.engine : DEFAULT_CFG.engine;
  return {
    ...cfg,
    engine,
    model: normalizeModel(engine, cfg.model),
  };
}

/**
 * Apply a partial config body (same rules as POST /api/config).
 * Engine-only update (no `model` field) → reset model to CLI_DEFAULT_MODEL
 * so spawn omits --model (Settings setEngine + EngineSwitch contract).
 */
export function applyConfigPatch(
  current: AppConfig,
  body: Record<string, unknown>
): AppConfig {
  const next: AppConfig = { ...current };
  const engineInBody =
    typeof body.engine === "string" &&
    ENGINES.includes(body.engine as EngineId);
  if (engineInBody) {
    next.engine = body.engine as EngineId;
  }
  if (typeof body.model === "string") {
    next.model = normalizeModel(next.engine, body.model);
  } else if (engineInBody) {
    // Engine switch without explicit model — never keep previous CLI's id.
    next.model = CLI_DEFAULT_MODEL;
  }
  if (typeof body.posture === "string") next.posture = body.posture;
  if ("vision" in body) next.vision = !!body.vision;
  if (typeof body.codex_batch === "number") next.codex_batch = body.codex_batch;
  if (typeof body.agents === "number") next.agents = body.agents;
  if (typeof body.budget === "number") next.budget = body.budget;
  if (typeof body.budget_warn === "number") next.budget_warn = body.budget_warn;
  return normalizeConfig(next);
}

export function loadCfg(): AppConfig {
  const cfg: AppConfig = { ...DEFAULT_CFG };
  if (existsSync(CFG_PATH)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(CFG_PATH, "utf8")));
    } catch {
      /* ignore */
    }
  }
  return normalizeConfig(cfg);
}

export function saveCfg(cfg: AppConfig) {
  writeFileSync(
    CFG_PATH,
    JSON.stringify(normalizeConfig(cfg), null, 1),
    "utf8"
  );
}

// re-export resolve helpers used by tests / server
export { CLI_DEFAULT_MODEL, modelOptionsForEngine, normalizeModel };
