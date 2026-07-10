# CFA Translate Studio — **desktop app (macOS + Windows)**

App **desktop (Electron)** dịch PDF CFA sang tiếng Việt **giữ layout**, điều phối qua **CLI local** trên máy: **Claude Code · Codex · Grok**.

Cùng tinh thần [open-design](https://github.com/nexu-io/open-design): **agent-native** — app không chứa model, chỉ spawn CLI có sẵn.

> PDF giáo trình **không** nằm trong git (bản quyền). Chỉ mã nguồn + tool.

## Cách chạy (app)

```bash
pnpm install
pip3 install -r python/requirements.txt

pnpm start          # mở app Electron (tự build UI nếu cần: pnpm build:ui)
# tương đương:
pnpm app
```

Lần đầu / sau khi sửa UI:

```bash
pnpm build:ui       # build renderer vào apps/ui/out
pnpm start          # Electron cửa sổ app
```

**Không** phải mở trình duyệt. Daemon chạy **bên trong** app (loopback), cửa sổ Electron nạp UI.

## Kiến trúc

```
apps/desktop     ← SẢN PHẨM: Electron macOS app
apps/daemon      ← backend local (Express): /api/*, spawn claude|codex|grok
apps/ui          ← renderer (Next.js static) — chỉ giao diện TRONG app, không phải website
packages/agent-adapters   detect + stream 3 CLI
packages/shared
python/          engine PDF + MCP cfa-pdf-translator
tool/work/       checkpoint pipeline (runtime data)
input/ output/   thả PDF → nhận bản dịch
```

Open Design cũng vậy: `apps/desktop` = app, UI renderer trong cửa sổ, `apps/daemon` = process local.

## Local agents

Cài và đăng nhập ít nhất một CLI: `claude` / `codex` / `grok`.

MCP PDF (một lần):

```bash
claude mcp add cfa-pdf-translator -- python3 "$(pwd)/python/server.py"
# Codex: ~/.codex/config.toml → command/args trỏ python/server.py
# Grok:  grok mcp add cfa-pdf-translator python3 -- "$(pwd)/python/server.py"
```

Trong app: **Cài đặt → Quét lại CLI**.

| Engine | Pipeline |
|---|---|
| Claude | Workflow 4-phase (chất lượng cao) |
| Codex | MCP lô trang (headless cần posture **bypass**) |
| Grok | MCP lô trang (`--always-approve`) |

## Lệnh khác (dev)

```bash
pnpm daemon         # chỉ backend (debug API), không phải luồng chính
pnpm test           # unit test stream parsers
pnpm build          # UI + daemon (daemon gộp 1 file ESM bằng esbuild)
pnpm dist           # đóng gói cho HĐH hiện tại: macOS universal (.dmg/.zip) HOẶC Windows (.exe)
```

Build cả **macOS (Intel + Apple Silicon) + Windows** qua CI:
`.github/workflows/build-desktop.yml` (matrix `macos` + `windows`, push tag `v*`
hoặc chạy tay). Chi tiết đóng gói: `apps/desktop/README.md`.

## Tài liệu

- `AGENTS.md` — contract cho coding agent
- `python/README.md` — MCP + pipeline PDF
- `apps/desktop/README.md` — app Electron

Chỉ dùng cá nhân; không redistribute nội dung có bản quyền của CFA Institute.
