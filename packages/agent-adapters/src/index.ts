import type { AgentAdapter, EngineId } from "./types.js";
import { claudeAdapter } from "./claude/adapter.js";
import { codexAdapter } from "./codex/adapter.js";
import { grokAdapter } from "./grok/adapter.js";
import type { AgentDetection } from "@cfa-translate/shared";

export * from "./types.js";
export { parseClaudeLine } from "./claude/stream.js";
export { parseCodexLine } from "./codex/stream.js";
export { parseGrokLine } from "./grok/stream.js";
export { cancelRun } from "./spawn-stream.js";

export const ADAPTERS: Record<EngineId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
};

export const ENGINE_IDS: EngineId[] = ["claude", "codex", "grok"];

export function getAdapter(id: string): AgentAdapter | null {
  if (id in ADAPTERS) return ADAPTERS[id as EngineId];
  return null;
}

/** Detect all local CLIs in parallel (open-design style). */
export async function detectAgents(): Promise<AgentDetection[]> {
  const results = await Promise.all(
    ENGINE_IDS.map(async (id) => {
      const d = await ADAPTERS[id].detect();
      if (d) return d;
      // Always surface known engines so UI can grey them out
      return {
        id,
        displayName: ADAPTERS[id].displayName,
        executablePath: "",
        authState: "missing" as const,
        available: false,
      };
    })
  );
  return results;
}

export function capabilitiesOf(id: EngineId) {
  return ADAPTERS[id].capabilities();
}
