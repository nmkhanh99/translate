/**
 * Structural regression checks for app-wide status ownership.
 *
 * Run: apps/daemon/node_modules/.bin/tsx --test
 * apps/ui/lib/status-provider-audit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const UI_ROOT = join(import.meta.dirname, "..");

function source(path: string): string {
  return readFileSync(join(UI_ROOT, path), "utf8");
}

describe("app-wide status provider", () => {
  it("owns one polling timer while the consumer hook only reads context", () => {
    const hook = source("lib/useStatus.ts");
    assert.equal(hook.match(/\brequestStatus\s*\(/g)?.length, 1);
    assert.equal(hook.match(/\bsetInterval\s*\(/g)?.length, 1);
    assert.match(hook, /if \(!afterInflight\) return current/);
    assert.match(hook, /current\.then\(start, start\)/);

    const consumer = hook.slice(hook.indexOf("export function useStatus("));
    assert.doesNotMatch(consumer, /\b(?:requestStatus|setInterval|useEffect)\s*\(/);
  });

  it("wraps the persistent app tree above route content", () => {
    const layout = source("app/layout.tsx");
    const statusOpen = layout.indexOf("<StatusProvider>");
    const providersOpen = layout.indexOf("<Providers>");
    const appShellOpen = layout.indexOf("<AppShell>");

    assert.ok(statusOpen >= 0);
    assert.ok(statusOpen < providersOpen);
    assert.ok(providersOpen < appShellOpen);
  });

  it("does not scan status or agents while Settings mounts", () => {
    const settings = source("app/settings/page.tsx");
    const providers = source("components/Providers.tsx");
    const document = source("app/document/page.tsx");

    assert.doesNotMatch(settings, /\bget(?:Status|Agents)\s*\(/);
    assert.doesNotMatch(document, /\bgetStatus\s*\(/);
    assert.match(settings, /await rescanAgents\(\)/);
    assert.match(settings, /await refreshStatus\(true\)/);
    assert.doesNotMatch(providers, /\b(?:void\s+)?rescanAgents\s*\(\s*\)/);
  });

  it("does not wait for a stale status snapshot after upload", () => {
    const translate = source("app/translate/page.tsx");
    assert.doesNotMatch(translate, /\bgetStatus\s*\(/);
    assert.match(translate, /tag:\s*uploaded\.tag/);
  });
});
