import {
  CLI_DEFAULT_MODEL,
  isCliDefault,
  isEngineId,
  normalizeModel,
  type ModelOption,
} from "@cfa-translate/shared";
import type { AppConfig, Engine, StatusResponse } from "./types";

export type SettingsModelMode = "default" | "pick" | "custom";

export function discoveredModelsFromStatus(
  status: Pick<StatusResponse, "models_discovered" | "models_by_engine">
): Partial<Record<Engine, string[]>> {
  const discovered = { ...(status.models_discovered || {}) };
  const fromOptions = status.models_by_engine as
    | Partial<Record<Engine, ModelOption[]>>
    | undefined;

  if (fromOptions) {
    for (const engine of ["claude", "codex", "grok"] as Engine[]) {
      const ids = (fromOptions[engine] || [])
        .map((model) => model.id)
        .filter((id) => id && id !== CLI_DEFAULT_MODEL);
      if (ids.length) discovered[engine] = ids;
    }
  }
  return discovered;
}

export function settingsStateFromStatus(status: StatusResponse): {
  config: AppConfig;
  discovered: Partial<Record<Engine, string[]>>;
  modelMode: SettingsModelMode;
} {
  const raw = status.config || {};
  const engine = isEngineId(raw.engine) ? raw.engine : "claude";
  const model = normalizeModel(engine, raw.model);
  const discovered = discoveredModelsFromStatus(status);
  const engineModels = discovered[engine] || [];
  const modelMode = isCliDefault(model)
    ? "default"
    : engineModels.includes(model)
      ? "pick"
      : "custom";

  return {
    config: { ...raw, engine, model },
    discovered,
    modelMode,
  };
}
