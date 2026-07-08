# translate — CFA PDF translator + macOS app

Bộ công cụ **dịch PDF giáo trình CFA sang tiếng Việt GIỮ NGUYÊN layout** (chỉ dịch
văn xuôi; hình, đồ thị, công thức, bảng số giữ nguyên), kèm **app macOS** điều
phối dịch qua **Claude** và **Codex**.

> ⚠️ Repo này **không** chứa file PDF giáo trình CFA (có bản quyền) — chúng bị loại
> qua `.gitignore`. Chỉ chứa **mã nguồn + tài liệu + cấu hình**.

## Thành phần

| Thư mục / file | Vai trò |
|---|---|
| `tool/pdf_core.py` | Lõi engine dịch-giữ-layout (redact văn xuôi, vẽ lại tiếng Việt). |
| `tool/server.py` | MCP server `cfa-pdf-translator` (extract → dịch → apply). |
| `tool/agent_pipeline.py`, `tool/translate_volume.js` | Pipeline agent 4-phase resume được (translate → verify → apply → vision). |
| `tool/dashboard.py` | Web dashboard + API (`/api/*`): tiến độ, Chạy/Dừng, engine **Claude/Codex**, upload, render trang PDF, **chat theo tài liệu** (`/api/chat`, SSE). |
| **`tool/web/`** | **Giao diện Next.js 16 + React + TS** (build tĩnh ra `web/out`) do dashboard.py phục vụ: Trang chủ · Dịch · Thư viện · Hàng đợi · Cài đặt · Đọc song song + **khung chat Claude/Codex/Grok**. |
| `tool/ui/` | Bộ HTML tĩnh cũ (fallback khi chưa build `tool/web`). |
| `tool/translate_pdf.py`, `tool/translate_all.py` | Dịch tự động (Google) 1 file / cả thư mục, có cache. |
| **`tool/app/`** | **App macOS (Electron)**: cửa sổ đơn nạp giao diện Next.js; mỗi tài liệu có **khung chat AI** (Claude/Codex/Grok) thay cho Terminal cũ. |
| **`input/`** | Thả **PDF bất kỳ** vào đây → tự thành mục để dịch (app/dashboard tự phát hiện). |
| **`output/`** | Bản dịch xuất ra `output/<tên>_vi.pdf`. |
| `.claude/` | CLAUDE.md + rules + skills (meta-engineer setup). |

## Bắt đầu

```bash
# 1) tool: cài phụ thuộc Python
cd tool && pip3 install -r requirements.txt

# 2) build giao diện Next.js (một lần / mỗi khi sửa tool/web)
cd web && npm install && npm run build   # xuất ra tool/web/out

# 3) app macOS
cd ../app && npm install
npm start                                # mở app; 💬 Chat trên mỗi tài liệu
```

Chi tiết: `tool/README.md`, `tool/DASHBOARD.md`, `tool/app/README.md`.

## Ghi chú kỹ thuật

- Engine **Claude** (headless, Workflow 4-phase) là luồng chất lượng cao nhất.
- Engine **Codex** (pipeline dịch cả cuốn): `codex exec` headless **không tự duyệt
  được MCP tool call** (elicitation bị auto-cancel) → dùng posture `bypass`, hoặc
  chạy Claude cho headless. Xem `tool/DASHBOARD.md`.
- **Chat theo tài liệu** (`/api/chat`): Claude/Codex/Grok chạy headless, stream
  token qua SSE, mỗi cuốn giữ session riêng (resume). Đây là phần thay cho Terminal.

Nội dung giáo trình chỉ dùng cá nhân; không sao chép/redistribute nội dung có bản
quyền của CFA Institute.
