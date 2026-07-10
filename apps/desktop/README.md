# CFA Translate Studio — app macOS (Electron)

**Đây là sản phẩm chính** của monorepo: cửa sổ native macOS.

App **không** chứa agent — spawn CLI local (**Claude / Codex / Grok**). Daemon Node chạy loopback; UI (Next static) nạp **trong** Electron.

## Chạy

Từ root repo:

```bash
pnpm install
pnpm build:ui    # một lần / khi sửa apps/ui
pnpm start       # Electron
```

Hoặc:

```bash
cd apps/desktop && pnpm start
```

## Luồng

```
Electron (apps/desktop/main.js)
  └─ spawn apps/daemon (Express, 127.0.0.1:port tự chọn)
       ├─ serve apps/ui/out  +  /api/*
       └─ spawn claude | codex | grok  (chat + pipeline)
```

## Đóng gói

```bash
cd apps/desktop
pnpm dist        # electron-builder → .app (cần approve electron build scripts)
```
