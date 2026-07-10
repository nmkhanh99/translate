import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentDetection, AuthState, EngineId } from "@cfa-translate/shared";

const execFileAsync = promisify(execFile);

export async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [bin], {
      env: process.env,
      timeout: 3000,
    });
    const p = stdout.trim().split("\n")[0];
    return p || null;
  } catch {
    return null;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function versionOf(
  binPath: string,
  args: string[] = ["--version"]
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, args, {
      timeout: 5000,
      env: process.env,
    });
    const text = (stdout || stderr || "").trim().split("\n")[0];
    return text || undefined;
  } catch {
    return undefined;
  }
}

export function homeConfig(rel: string): string {
  return join(homedir(), rel);
}

export async function baseDetect(opts: {
  id: EngineId;
  displayName: string;
  bin: string;
  configDirRel: string;
}): Promise<AgentDetection | null> {
  const executablePath = await which(opts.bin);
  const configDir = homeConfig(opts.configDirRel);
  const hasConfig = await pathExists(configDir);

  if (!executablePath && !hasConfig) return null;

  let authState: AuthState = "unknown";
  if (hasConfig) authState = "ok";
  if (!executablePath) {
    return {
      id: opts.id,
      displayName: opts.displayName,
      executablePath: "",
      configDir,
      authState: "missing",
      available: false,
    };
  }

  const version = await versionOf(executablePath);
  return {
    id: opts.id,
    displayName: opts.displayName,
    executablePath,
    version,
    configDir: hasConfig ? configDir : undefined,
    authState,
    available: true,
  };
}
