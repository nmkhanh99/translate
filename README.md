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
| `tool/dashboard.py` | Web dashboard: theo dõi tiến độ + Chạy/Dừng, chọn engine **Claude/Codex**. |
| `tool/translate_pdf.py`, `tool/translate_all.py` | Dịch tự động (Google) 1 file / cả thư mục, có cache. |
| **`tool/app/`** | **App macOS (Electron)**: dashboard + **Terminal bên cạnh** (xterm + node-pty) để chạy `claude`/`codex` interactive/scoped. |
| **`input/`** | Thả **PDF bất kỳ** vào đây → tự thành mục để dịch (app/dashboard tự phát hiện). |
| **`output/`** | Bản dịch xuất ra `output/<tên>_vi.pdf`. |
| `.claude/` | CLAUDE.md + rules + skills (meta-engineer setup). |

## Bắt đầu

```bash
# 1) tool: cài phụ thuộc Python
cd tool && pip3 install -r requirements.txt

# 2) app macOS
cd app && npm install
npx electron-rebuild -f -w node-pty     # node-pty là native, rebuild theo Electron
npm start                                # mở app; ⌘T để bật Terminal
```

Chi tiết: `tool/README.md`, `tool/DASHBOARD.md`, `tool/app/README.md`.

## Ghi chú kỹ thuật

- Engine **Claude** (headless, Workflow 4-phase) là luồng chất lượng cao nhất.
- Engine **Codex**: `codex exec` headless **không tự duyệt được MCP tool call**
  (elicitation bị auto-cancel) → dùng **Terminal** chạy `codex` interactive, hoặc
  posture `bypass`. Xem `tool/DASHBOARD.md`.

Nội dung giáo trình chỉ dùng cá nhân; không sao chép/redistribute nội dung có bản
quyền của CFA Institute.
