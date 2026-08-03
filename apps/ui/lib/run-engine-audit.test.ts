/**
 * Structural audit: every runVolume / redoStage call site must pass the engine
 * the UI presents (no bare runVolume(tag) that omits engine).
 *
 * Run: pnpm exec tsx --test apps/ui/lib/run-engine-audit.test.ts
 * (from repo root)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const UI_ROOT = join(import.meta.dirname, "..");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "out" || name === ".next") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(name) && !name.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}

describe("runVolume call sites pass engine", () => {
  const files = walk(UI_ROOT);
  const bare: string[] = [];
  const withEngine: string[] = [];

  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // bare: runVolume( tag ) or runVolume(tag) without second arg on same call
    // Match call expressions carefully.
    const re = /runVolume\s*\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const args = m[1];
      // skip type-only / import shadows in comments
      if (args.includes("tag: string")) continue;
      const rel = relative(UI_ROOT, f);
      // Count top-level commas outside nested parens/braces — simple split is ok
      // for our call sites (runVolume(x) or runVolume(x, y)).
      const parts = args.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) {
        bare.push(`${rel}: runVolume(${args.trim()})`);
      } else {
        withEngine.push(`${rel}: runVolume(${args.trim().slice(0, 60)})`);
      }
    }
  }

  it("no bare runVolume(tag) without engine", () => {
    assert.deepEqual(bare, [], `bare callers:\n${bare.join("\n")}`);
  });

  it("at least one call site passes engine (Library/Translate/Queue/Run)", () => {
    assert.ok(withEngine.length >= 3, `expected multi-surface callers, got ${withEngine.length}: ${withEngine.join("; ")}`);
  });

  it("api.runVolume requires engine param in signature", () => {
    const api = readFileSync(join(UI_ROOT, "lib/api.ts"), "utf8");
    assert.match(api, /export function runVolume\(\s*tag:\s*string,\s*engine:\s*string/);
    assert.match(api, /engine bắt buộc/);
  });
});

describe("redoStage call sites pass engine when UI has one", () => {
  const runPage = readFileSync(join(UI_ROOT, "app/run/page.tsx"), "utf8");
  it("run page redo includes engine: effEngine", () => {
    assert.match(runPage, /redoStage\([^)]*engine:\s*effEngine/);
  });
  it("run page full runVolume includes effEngine", () => {
    assert.match(runPage, /runVolume\(\s*v\.tag\s*,\s*effEngine\s*\)/);
  });
});

describe("Library + Translate pass useEngine().engine", () => {
  it("library onRun uses engine", () => {
    const t = readFileSync(join(UI_ROOT, "app/library/page.tsx"), "utf8");
    assert.match(t, /runVolume\(\s*tag\s*,\s*engine\s*\)/);
  });
  it("translate start uses engine", () => {
    const t = readFileSync(join(UI_ROOT, "app/translate/page.tsx"), "utf8");
    assert.match(t, /runVolume\(\s*selected\.tag\s*,\s*engine\s*\)/);
  });
});
