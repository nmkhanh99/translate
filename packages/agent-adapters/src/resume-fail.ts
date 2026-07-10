/**
 * Detect when a CLI refused to resume a stored session/thread (open-design
 * agent-session-resume patterns). On match the daemon clears the stale handle
 * and retries once with a fresh session + full document context.
 *
 * Match ONLY failure channels (stderr / structured result), never successful
 * assistant text — a reply that mentions "session not found" must not trip this.
 */

const CLAUDE_RESUME_FAILURE_PATTERNS: RegExp[] = [
  /no conversation found with session id/i,
  /no session found/i,
  /session .* not found/i,
];

const CODEX_RESUME_FAILURE_PATTERNS: RegExp[] = [
  /no rollout found for thread id/i,
  /thread\/resume failed/i,
];

const GROK_RESUME_FAILURE_PATTERNS: RegExp[] = [
  /session .* not found/i,
  /no session found/i,
  /unknown session/i,
];

/**
 * Version-stable Claude stream-json signal: resume miss fails LOCALLY before
 * any API call → `result` with is_error, zero turns, zero API time.
 */
export function hasClaudeResumeFailureResultEvent(text: string): boolean {
  if (!text) return false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"result"')) continue;
    let event: {
      type?: unknown;
      is_error?: unknown;
      num_turns?: unknown;
      duration_api_ms?: unknown;
    };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type !== "result") continue;
    if (
      event.is_error === true &&
      Number(event.num_turns) === 0 &&
      Number(event.duration_api_ms) === 0
    ) {
      return true;
    }
  }
  return false;
}

export function isClaudeResumeFailure(stderr: string, stdout = ""): boolean {
  if (stderr && CLAUDE_RESUME_FAILURE_PATTERNS.some((re) => re.test(stderr))) {
    return true;
  }
  return stdout ? hasClaudeResumeFailureResultEvent(stdout) : false;
}

export function isCodexResumeFailure(text: string): boolean {
  if (!text) return false;
  return CODEX_RESUME_FAILURE_PATTERNS.some((re) => re.test(text));
}

export function isGrokResumeFailure(text: string): boolean {
  if (!text) return false;
  return GROK_RESUME_FAILURE_PATTERNS.some((re) => re.test(text));
}

export function isAgentResumeFailure(
  agentId: string,
  stderr: string,
  stdout = ""
): boolean {
  if (agentId === "codex") return isCodexResumeFailure(stderr);
  if (agentId === "grok") return isGrokResumeFailure(stderr || stdout);
  // claude (default)
  return isClaudeResumeFailure(stderr, stdout);
}
