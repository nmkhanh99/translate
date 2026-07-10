# CFA Translate Studio — app desktop (Electron)

**Đây là sản phẩm chính** của monorepo: cửa sổ native **macOS + Windows**.

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

## Đóng gói (macOS + Windows)

Mỗi HĐH build trên chính runner của nó (kiểu [open-design]) — **không** cross-build
Windows từ macOS (cần wine). `pnpm dist` build cho HĐH đang chạy:

```bash
pnpm dist        # build:ui + bundle daemon (esbuild) + electron-builder (host OS)
```

- **macOS:** `.dmg` + `.zip` **universal** (Intel x64 + Apple Silicon arm64) —
  1 file chạy native cho cả 2 dòng máy.
- **Windows:** `.exe` (NSIS, x64) — chạy `pnpm dist` trên máy Windows.

Kết quả trong `apps/desktop/dist/`.

**CI (tạo bản Windows không cần máy Windows):**
`.github/workflows/build-desktop.yml` build cả hai qua matrix
(`macos-latest` + `windows-latest`) khi push tag `v*` hoặc chạy tay
(`workflow_dispatch`), rồi upload artifact tải về.

Bản đóng gói bundle vào `Resources/` (macOS) / `resources/` (Windows):

- `ui-out/` — renderer tĩnh (từ apps/ui)
- `daemon/cli.mjs` — daemon gộp 1 file ESM (esbuild), chạy bằng Node của Electron
  (`ELECTRON_RUN_AS_NODE=1`)
- `python/` — engine PDF + MCP

Khi đóng gói, các thư mục cần ghi (input/output/tool/work, config) chuyển sang
`app.getPath('userData')`; `main.js` truyền `CFA_ROOT_DIR` (writable) +
`CFA_PYTHON_DIR` / `CFA_UI_OUT` (Resources) cho daemon. Dev thì daemon chạy
thẳng TS bằng `tsx`.

> Bản build **chưa ký** (unsigned): macOS chuột phải → *Mở* lần đầu (Gatekeeper);
> Windows SmartScreen → *More info* → *Run anyway*. Runtime cần `python3`/`python`
> + PyMuPDF và ít nhất một CLI `claude`/`codex`/`grok` trên máy người dùng.

[open-design]: https://github.com/nexu-io/open-design
