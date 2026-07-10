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

Từ root repo:

```bash
pnpm dist        # build:ui + bundle daemon (esbuild) + electron-builder --mac
```

Ra `apps/desktop/dist/mac/CFA Translate Studio.app`. Bản đóng gói bundle vào
`Contents/Resources/`:

- `ui-out/` — renderer tĩnh (từ apps/ui)
- `daemon/cli.mjs` — daemon gộp 1 file ESM (esbuild), chạy bằng Node của Electron
  (`ELECTRON_RUN_AS_NODE=1`)
- `python/` — engine PDF + MCP

Khi đóng gói, các thư mục cần ghi (input/output/tool/work, config) chuyển sang
`app.getPath('userData')`; `main.js` truyền `CFA_ROOT_DIR` (writable) +
`CFA_PYTHON_DIR` / `CFA_UI_OUT` (Resources) cho daemon. Dev thì daemon chạy
thẳng TS bằng `tsx`.
