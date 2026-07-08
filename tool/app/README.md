# CFA Translate Studio — app macOS (Electron)

Vỏ **macOS native** cho pipeline dịch PDF CFA. Tham khảo kiến trúc của
[nexu-io/open-design](https://github.com/nexu-io/open-design): **agent-native,
model-agnostic** — app KHÔNG tự chứa agent, mà **spawn các CLI có sẵn trên máy**
(**Claude Code**, **Codex**, **Grok**) để dịch và để **trò chuyện theo tài liệu**.

Giao diện là một app **Next.js 16 + React + TypeScript** (thư mục `tool/web`,
build tĩnh) do backend `dashboard.py` (Python stdlib) phục vụ tại cùng origin với
`/api/*`. Cửa sổ Electron chỉ nạp URL đó.

## Cách chạy (dev)

```bash
# 1) Build giao diện Next.js (một lần, hoặc mỗi khi sửa tool/web)
cd tool/web
npm install
npm run build            # xuất ra tool/web/out (static export)

# 2) Mở app
cd ../app
npm install              # cài Electron (1 lần)
npm start                # app tự khởi động dashboard.py và nạp giao diện
```

Yêu cầu: `python3` + phụ thuộc tool (`pip3 install -r ../requirements.txt`); các
CLI đã đăng nhập tuỳ nhu cầu (`claude`, `codex`, `grok`). Nếu `python3` không nằm
trong PATH, đặt biến `CFA_PYTHON=/đường/dẫn/python3`.

> Nếu chưa build `tool/web/out`, app hiện cảnh báo và `dashboard.py` tạm lùi về
> bộ HTML tĩnh cũ trong `tool/ui/`.

## App làm gì

- **Trang chủ / Thư viện / Hàng đợi / Dịch tài liệu / Cài đặt / Đọc song song** —
  bảng tiến độ mọi volume trong `../volumes.json`, chạy/dừng pipeline (headless),
  upload PDF (nút/kéo-thả), đọc bản dịch song song với bản gốc.
- **Chọn CLI dịch** ngay trên thanh đầu trang **Dịch tài liệu** và **Thư viện**
  (segmented Claude / Codex / Grok) — lựa chọn lưu vào config và dùng cho mọi nút
  **Dịch**. (Cũng đổi được ở **Cài đặt**.)
  - **Claude** — Workflow 4-phase (translate → verify → apply → vision), chất
    lượng cao nhất. Chạy `claude -p` với `translate_volume.js`.
  - **Codex** — MCP `cfa-pdf-translator` (`codex exec`), dịch cả volume theo lô
    trang. Headless cần posture **bypass** (codex tự huỷ MCP elicitation).
  - **Grok** — CÙNG MCP `cfa-pdf-translator`, chạy `grok -p --always-approve`
    (auto-duyệt tool call nên headless không bị huỷ như codex). Cần đăng ký MCP:
    `grok mcp add cfa-pdf-translator <python3> -- <tool/server.py>` (đã cấu hình).
- Checkpoint theo file: **Dừng** giữa chừng rồi **Chạy** lại là **tự resume**.

## Khung chat theo tài liệu (thay cho Terminal cũ)

Terminal nhúng (xterm + node-pty) đã được **bỏ**. Thay vào đó, mỗi tài liệu có một
**khung chat AI** trượt ra từ bên phải:

- Mở bằng nút **💬 Chat** trên thẻ tài liệu ở **Thư viện**, nút **Mở chat** sau khi
  upload ở **Dịch tài liệu**, hoặc **Hỏi AI** trong màn **Đọc song song**.
- **Chọn engine** ngay trong khung chat: **Claude / Codex / Grok**.
- AI chạy **headless** trong thư mục `translate` và được cấp ngữ cảnh của đúng cuốn
  đó (đường dẫn PDF nguồn/bản dịch) để dịch, giải thích thuật ngữ, hoặc soát lỗi.
- **Mỗi cuốn giữ hội thoại riêng** và nhớ ngữ cảnh giữa các lượt (resume theo
  session id của từng engine).
- Kết quả **stream token** về trình duyệt qua SSE (`POST /api/chat`).

Chi tiết endpoint chat và cách parse stream của từng engine: xem `../DASHBOARD.md`.

## Đóng gói .app / DMG (sau)

`package.json` đã có config `electron-builder` (đóng gói kèm `tool/web/out`). Khi
muốn build bản phân phối:

```bash
npm i -D electron-builder
npm run dist          # tạo .app trong dist/ (target: dir)
```

Icon, code-sign / notarize để sau (MVP chưa làm).

## Kiến trúc (ngắn)

```
Electron main.js  (cửa sổ ĐƠN, không còn pane Terminal)
  ├─ freePort() → spawn `python3 dashboard.py --port N`  (cwd = tool/)
  ├─ chờ /api/ping = 200  → BrowserWindow.loadURL(http://127.0.0.1:N)
  └─ before-quit → SIGTERM backend
dashboard.py
  ├─ phục vụ giao diện Next.js tĩnh (tool/web/out) + /api/*
  ├─ /api/run|stop|batch → spawn `claude -p` / `codex exec`
  └─ /api/chat (SSE)     → spawn `claude|codex|grok` headless, stream token
```
