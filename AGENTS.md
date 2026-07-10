# AGENTS.md — CFA Translate Studio

## Sản phẩm = desktop app

**Primary surface:** `apps/desktop` (Electron macOS).  
User chạy `pnpm start` → cửa sổ app. Không ship “website”.

| Path | Role |
|---|---|
| `apps/desktop` | **App** Electron — spawn daemon, BrowserWindow |
| `apps/daemon` | Local Express (loopback) — REST/SSE, spawn CLIs |
| `apps/ui` | **Renderer** in-app (Next static export) — không phải product web |
| `packages/agent-adapters` | Claude / Codex / Grok (local CLI only) |
| `packages/shared` | Shared types |
| `python/` | PDF engine + MCP |

Open Design mapping: `desktop` + `daemon` + UI renderer; agents = PATH CLIs only (no BYOK in this project).

## Commands

```bash
pnpm start              # APP
pnpm build:ui           # build renderer → apps/ui/out
pnpm test
```

## Do not

- Present browser/`pnpm dev` as the main product path
- Embed cloud model APIs (local CLI only)
- Touch `.claude/skills/meta-*`
