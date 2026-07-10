import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Repo root (…/translate). A packaged Electron app has no source tree, so
 * CFA_ROOT_DIR relocates every writable dir derived below (input/output/
 * tool/work, config) to a writable location such as userData.
 */
export const REPO_ROOT = process.env.CFA_ROOT_DIR || resolve(here, "../../..");

/** Python domain engine. Override via CFA_PYTHON_DIR (packaged app → Resources/python). */
export const PYTHON_DIR = process.env.CFA_PYTHON_DIR || join(REPO_ROOT, "python");

/** Legacy tool workdirs (volumes.json still points here). */
export const TOOL_DIR = join(REPO_ROOT, "tool");

export const MANIFEST = join(PYTHON_DIR, "volumes.json");
export const VOLUME_JS = join(PYTHON_DIR, "translate_volume.js");
export const INPUT_DIR = join(REPO_ROOT, "input");
export const OUTPUT_DIR = join(REPO_ROOT, "output");
export const USER_WORK = join(TOOL_DIR, "work");
export const CFG_PATH = join(TOOL_DIR, "dashboard.json");

/** In-app UI static export, served by the daemon. Override via CFA_UI_OUT
 *  (packaged → Resources/ui-out). */
export const UI_OUT = process.env.CFA_UI_OUT || join(REPO_ROOT, "apps/ui/out");

export function ensureDirs() {
  for (const d of [INPUT_DIR, OUTPUT_DIR, USER_WORK]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

export function resolveUiRoot(): string | null {
  if (existsSync(join(UI_OUT, "index.html"))) return UI_OUT;
  return null;
}

export function pythonBin(): string {
  return (
    process.env.CFA_PYTHON ||
    (process.platform === "win32" ? "python" : "python3")
  );
}
