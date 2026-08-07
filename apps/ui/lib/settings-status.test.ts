import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  discoveredModelsFromStatus,
  settingsStateFromStatus,
} from "./settings-status.js";
import type { StatusResponse } from "./types.js";

function status(
  overrides: Partial<StatusResponse> = {}
): StatusResponse {
  return {
    volumes: [],
    config: {},
    ...overrides,
  };
}

describe("settings status cache", () => {
  it("merges raw discovery with model options returned by status", () => {
    const discovered = discoveredModelsFromStatus(
      status({
        models_discovered: {
          claude: ["claude-raw"],
          grok: ["grok-raw"],
        },
        models_by_engine: {
          claude: [
            { id: "default", label: "CLI default" },
            { id: "claude-live", label: "claude-live", discovered: true },
          ],
          codex: [
            { id: "codex-live", label: "codex-live", discovered: true },
          ],
        },
      })
    );

    assert.deepEqual(discovered, {
      claude: ["claude-live"],
      codex: ["codex-live"],
      grok: ["grok-raw"],
    });
  });

  it("selects a discovered configured model without rescanning", () => {
    const result = settingsStateFromStatus(
      status({
        config: { engine: "codex", model: "codex-live", posture: "bypass" },
        models_discovered: { codex: ["codex-live"] },
      })
    );

    assert.deepEqual(result.config, {
      engine: "codex",
      model: "codex-live",
      posture: "bypass",
    });
    assert.equal(result.modelMode, "pick");
  });

  it("keeps CLI default and custom model modes distinct", () => {
    assert.equal(
      settingsStateFromStatus(
        status({ config: { engine: "claude", model: "default" } })
      ).modelMode,
      "default"
    );
    assert.equal(
      settingsStateFromStatus(
        status({ config: { engine: "grok", model: "private-model" } })
      ).modelMode,
      "custom"
    );
  });
});
