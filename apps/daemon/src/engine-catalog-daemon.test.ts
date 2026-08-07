/**
 * No-hardcode model resolution + discovery parser + spawn structural.
 * Run: pnpm --filter @cfa-translate/daemon test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeConfig,
  modelsByEngine,
  DEFAULT_CFG,
  applyConfigPatch,
} from "./config.js";
import { resolveEngine, shouldUsePipelineRunner } from "./runs.js";
import {
  cliModelArg,
  normalizeModel,
  defaultModel,
  isCliDefault,
  modelOptionsForEngine,
  CLI_DEFAULT_MODEL,
} from "@cfa-translate/shared";
import {
  parseGrokModelsOutput,
  parseModelIdLines,
} from "@cfa-translate/agent-adapters";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("no static product catalog as sole truth", () => {
  it("default model is CLI default sentinel for every engine", () => {
    assert.equal(defaultModel("claude"), CLI_DEFAULT_MODEL);
    assert.equal(defaultModel("codex"), CLI_DEFAULT_MODEL);
    assert.equal(defaultModel("grok"), CLI_DEFAULT_MODEL);
    assert.equal(DEFAULT_CFG.model, CLI_DEFAULT_MODEL);
  });

  it("modelOptions without discovery is only CLI default", () => {
    for (const e of ["claude", "codex", "grok"] as const) {
      const opts = modelOptionsForEngine(e, []);
      assert.deepEqual(
        opts.map((o) => o.id),
        [CLI_DEFAULT_MODEL]
      );
    }
  });

  it("modelOptions merges discovered ids without inventing them", () => {
    const opts = modelOptionsForEngine("grok", ["grok-4.5", "grok-4.5"]);
    assert.equal(opts[0].id, CLI_DEFAULT_MODEL);
    assert.equal(opts.length, 2);
    assert.equal(opts[1].id, "grok-4.5");
    assert.equal(opts[1].discovered, true);
  });

  it("normalizeModel: default omit; pass-through user id; snap Claude alias under grok", () => {
    assert.equal(normalizeModel("claude", ""), CLI_DEFAULT_MODEL);
    assert.equal(normalizeModel("claude", "sonnet"), "sonnet"); // pass-through alias OK for claude
    assert.equal(normalizeModel("grok", "sonnet"), CLI_DEFAULT_MODEL);
    assert.equal(normalizeModel("codex", "opus"), CLI_DEFAULT_MODEL);
    assert.equal(normalizeModel("grok", "grok-4.5"), "grok-4.5");
    assert.equal(normalizeModel("codex", "o3"), "o3");
  });

  it("cliModelArg omits default; passes free-text", () => {
    assert.equal(cliModelArg("grok", "default"), undefined);
    assert.equal(cliModelArg("claude", ""), undefined);
    assert.equal(cliModelArg("claude", "sonnet"), "sonnet");
    assert.equal(cliModelArg("codex", "o3"), "o3");
    assert.notEqual(cliModelArg("codex", "sonnet"), "sonnet");
  });
});

describe("parseGrokModelsOutput (real CLI shape)", () => {
  it("parses grok models listing", () => {
    const sample = `
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  * grok-4
`;
    const ids = parseGrokModelsOutput(sample);
    assert.ok(ids.includes("grok-4.5"));
    assert.ok(ids.includes("grok-4") || ids[0] === "grok-4.5");
    // Must not invent names not in text
    assert.ok(!ids.includes("sonnet"));
    assert.ok(!ids.includes("gpt-5.1"));
  });
});

describe("normalizeConfig", () => {
  it("snaps sonnet under grok to default", () => {
    const c = normalizeConfig({ engine: "grok", model: "sonnet" });
    assert.equal(c.model, CLI_DEFAULT_MODEL);
  });
  it("keeps free-text for claude", () => {
    const c = normalizeConfig({ engine: "claude", model: "claude-opus-4-6" });
    assert.equal(c.model, "claude-opus-4-6");
  });
  it("drops removed budget fields from legacy config and patch payloads", () => {
    const legacy = { ...DEFAULT_CFG, budget: 250, budget_warn: 95 };
    const normalized = normalizeConfig(legacy);
    assert.equal("budget" in normalized, false);
    assert.equal("budget_warn" in normalized, false);

    const patched = applyConfigPatch(legacy, { budget: 500, budget_warn: 70 });
    assert.equal("budget" in patched, false);
    assert.equal("budget_warn" in patched, false);
  });
});

describe("applyConfigPatch engine-only POST (EngineSwitch + /api/config)", () => {
  it("engine-only: grok + grok-4.5 → claude without model → default omit", () => {
    const cur = { engine: "grok", model: "grok-4.5" };
    const next = applyConfigPatch(cur, { engine: "claude" });
    assert.equal(next.engine, "claude");
    assert.equal(next.model, CLI_DEFAULT_MODEL);
    assert.equal(cliModelArg(next.engine, next.model), undefined);
  });

  it("engine+model explicit keeps free-text for that engine", () => {
    const next = applyConfigPatch(
      { engine: "claude", model: "default" },
      { engine: "claude", model: "sonnet" }
    );
    assert.equal(next.model, "sonnet");
    assert.equal(cliModelArg("claude", next.model), "sonnet");
  });

  it("model-only update under current engine passes through", () => {
    const next = applyConfigPatch(
      { engine: "grok", model: "default" },
      { model: "grok-4.5" }
    );
    assert.equal(next.engine, "grok");
    assert.equal(next.model, "grok-4.5");
  });

  it("Providers/EngineSwitch must send model default with engine", () => {
    const ui = readFileSync(
      join(__dirname, "../../ui/components/Providers.tsx"),
      "utf8"
    );
    assert.match(ui, /saveConfig\(\{\s*engine:\s*e,\s*model:\s*["']default["']/);
  });
});

describe("engine switch must yield CLI default omit (Settings contract)", () => {
  /**
   * Mirrors apps/ui setEngine: on engine change, model = CLI_DEFAULT_MODEL
   * (not normalizeModel of the old id). Save/run must omit --model.
   */
  function settingsSetEngine(
    prev: { engine: string; model: string },
    nextEngine: string
  ) {
    return {
      engine: nextEngine,
      model: CLI_DEFAULT_MODEL,
    };
  }

  it("grok-4.5 → switch to claude → default → cliModelArg omit", () => {
    const after = settingsSetEngine(
      { engine: "grok", model: "grok-4.5" },
      "claude"
    );
    assert.equal(after.engine, "claude");
    assert.equal(after.model, CLI_DEFAULT_MODEL);
    const saved = normalizeModel(after.engine, after.model);
    assert.equal(saved, CLI_DEFAULT_MODEL);
    assert.equal(cliModelArg(after.engine, saved), undefined);
  });

  it("would-be-wrong if only normalizeModel kept old id under new engine", () => {
    // Document the bug: normalizeModel("claude", "grok-4.5") passes through
    // (not a Claude alias) — so setEngine MUST force default, not normalize only.
    assert.equal(normalizeModel("claude", "grok-4.5"), "grok-4.5");
    assert.equal(cliModelArg("claude", "grok-4.5"), "grok-4.5");
  });

  it("settings setEngine source assigns CLI_DEFAULT_MODEL", () => {
    const ui = readFileSync(
      join(__dirname, "../../ui/app/settings/page.tsx"),
      "utf8"
    );
    assert.match(ui, /function setEngine/);
    assert.match(ui, /model:\s*CLI_DEFAULT_MODEL/);
    // Must not only normalizeModel(engine, next.model) on switch
    assert.ok(
      !/setEngine[\s\S]{0,200}normalizeModel\(engine,\s*next\.model\)/.test(ui),
      "setEngine still only normalizes old model"
    );
  });
});

describe("modelsByEngine with discovery", () => {
  it("only default when no discovery", () => {
    const m = modelsByEngine();
    assert.equal(m.claude.length, 1);
    assert.equal(m.claude[0].id, CLI_DEFAULT_MODEL);
  });
  it("includes discovered for grok only", () => {
    const m = modelsByEngine({ grok: ["grok-4.5"] });
    assert.ok(m.grok.some((x) => x.id === "grok-4.5"));
    assert.equal(m.codex.length, 1); // only default
  });
});

describe("engine resolve still works", () => {
  it("override wins", () => {
    assert.equal(resolveEngine("grok", "codex", "claude"), "grok");
  });
  it("codex full run not runner; redo is", () => {
    assert.equal(shouldUsePipelineRunner("codex", undefined), false);
    assert.equal(shouldUsePipelineRunner("codex", {}), true);
  });
  it("review fix forceRunner for codex", () => {
    assert.equal(shouldUsePipelineRunner("codex", undefined, true), true);
  });
});

describe("status path uses background caches (structural)", () => {
  it("does not scan volumes or CLIs on the request path", () => {
    const src = readFileSync(join(__dirname, "server.ts"), "utf8");
    assert.match(src, /createStatusVolumeCache/);
    assert.match(src, /scanStatusVolumesInWorker/);
    assert.match(src, /AGENTS_TTL_MS\s*=\s*45_000/);
    const statusBlock = src.slice(
      src.indexOf('app.get("/api/status"'),
      src.indexOf('app.post("/api/config"')
    );
    assert.match(statusBlock, /getDiscoveredModelsCached/);
    assert.match(statusBlock, /getAgentsCached/);
    assert.match(statusBlock, /statusVolumes\.get\(\)/);
    assert.match(statusBlock, /statusVolumes\.refresh\(CFG\)/);
    assert.ok(!statusBlock.includes("loadVolumes()"));
    assert.ok(!statusBlock.includes("volumeToApi("));
    assert.ok(!statusBlock.includes("detectAgents()"));
    assert.ok(!statusBlock.includes("listModelsForEngines()"));
  });
  it("ships the status worker with the desktop app", () => {
    const daemonPackage = readFileSync(
      join(__dirname, "../package.json"),
      "utf8"
    );
    const desktopPackage = readFileSync(
      join(__dirname, "../../desktop/package.json"),
      "utf8"
    );
    assert.match(daemonPackage, /src\/status-worker\.ts/);
    assert.match(desktopPackage, /daemon\/status-worker\.mjs/);
  });
  it("launchVolume forces runner when stage=review", () => {
    const src = readFileSync(join(__dirname, "runs.ts"), "utf8");
    assert.match(src, /needsReviewFixRunner/);
    assert.match(src, /reviewFix/);
  });
});

describe("structural: no frozen multi-id product table in UI source of truth", () => {
  it("shared index has no o4-mini/gpt-5.1/grok-4 product table", () => {
    const shared = readFileSync(
      join(__dirname, "../../../packages/shared/src/index.ts"),
      "utf8"
    );
    assert.ok(!shared.includes("o4-mini"));
    assert.ok(!shared.includes("gpt-5.1"));
    assert.ok(!shared.includes('{ id: "grok-4"'));
    assert.ok(!shared.includes('{ id: "sonnet", label: "Sonnet'));
    assert.match(shared, /CLI_DEFAULT_MODEL/);
    assert.match(shared, /modelOptionsForEngine/);
  });

  it("pipeline-runner does not hardcode sonnet as default model", () => {
    const src = readFileSync(join(__dirname, "pipeline-runner.mjs"), "utf8");
    assert.ok(!src.includes('A.model || "sonnet"'));
    assert.ok(!src.includes('claudeModel = CLAUDE_ONLY'));
    assert.match(src, /if \(MODEL\)/);
  });

  it("settings uses discovery/free-text path", () => {
    const ui = readFileSync(
      join(__dirname, "../../ui/app/settings/page.tsx"),
      "utf8"
    );
    assert.match(ui, /modelOptionsForEngine|__custom__/);
    assert.match(ui, /Mặc định CLI|CLI default|default/);
    assert.ok(!ui.includes("Sonnet — cân bằng"));
    assert.ok(!ui.includes("o4-mini"));
  });

  it("claude adapter buildPipelineCmd does not force sonnet", () => {
    const src = readFileSync(
      join(__dirname, "../../../packages/agent-adapters/src/claude/adapter.ts"),
      "utf8"
    );
    assert.ok(!src.includes('params.model || "sonnet"'));
  });
});
