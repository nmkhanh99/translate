/**
 * Runtime model discovery helpers — parse CLI output only, never invent names.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { which } from "./detect.js";

const execFileAsync = promisify(execFile);

/** Run CLI with short timeout; return stdout+stderr text or "". */
export async function runCliCapture(
  bin: string,
  args: string[],
  timeoutMs = 6000
): Promise<string> {
  const path = (await which(bin)) || bin;
  try {
    const { stdout, stderr } = await execFileAsync(path, args, {
      timeout: timeoutMs,
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    });
    return `${stdout || ""}\n${stderr || ""}`;
  } catch (e: unknown) {
    // Some CLIs exit non-zero but still print useful lists on stdout
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout || ""}\n${err.stderr || ""}`;
  }
}

/**
 * Parse `grok models` style output:
 *   Default model: grok-4.5
 *   Available models:
 *     * grok-4.5 (default)
 */
export function parseGrokModelsOutput(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\*\s*([A-Za-z0-9._-]+)/);
    if (m) {
      const id = m[1];
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
      continue;
    }
    const d = line.match(/Default model:\s*([A-Za-z0-9._-]+)/i);
    if (d && !seen.has(d[1])) {
      seen.add(d[1]);
      out.unshift(d[1]);
    }
  }
  return out;
}

/**
 * Generic line scrape for model-like tokens (fallback). Conservative:
 * only lines that look like model ids, not prose.
 */
export function parseModelIdLines(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    // bare id or "* id" or "- id"
    const m = t.match(/^(?:[*•-]\s+)?([a-z][a-z0-9._-]{2,40})$/i);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    // skip common help noise
    if (/^(use|the|and|for|with|model|models|options|commands)$/i.test(id))
      continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
