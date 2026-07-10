# tool/ — runtime data only

Không còn chứa app/UI/engine ở đây.

| Path | Vai trò |
|---|---|
| `work/` | Workdir pipeline (volume checkpoints). `volumes.json` trỏ absolute path vào đây. |
| `dashboard.json` | Config app (engine, model, posture…) — daemon đọc/ghi. |

Engine Python: `../python/`  
App: `pnpm start` (Electron + daemon + `apps/ui`).
