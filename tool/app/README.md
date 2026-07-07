# CFA Translate Studio — app macOS (Electron)

Vỏ **macOS native** cho pipeline dịch PDF CFA. Tham khảo kiến trúc của
[nexu-io/open-design](https://github.com/nexu-io/open-design): **agent-native,
model-agnostic** — app KHÔNG tự chứa agent, mà **spawn các CLI có sẵn trên máy**
(hiện làm **Claude Code** và **Codex**) để dịch. UI tái dùng backend
`dashboard.py` (Python stdlib) đã có trong `tool/`.

## Cách chạy (dev)

```bash
cd tool/app
npm install          # cài Electron (1 lần)
npm start            # mở app; app tự khởi động dashboard.py trên cổng local
```

Yêu cầu: `python3` + phụ thuộc của tool (`pip3 install -r ../requirements.txt`),
`claude` và/hoặc `codex` CLI đã đăng nhập. Nếu `python3` không nằm trong PATH,
đặt biến `CFA_PYTHON=/đường/dẫn/python3`.

## App làm gì

- Mở cửa sổ hiển thị **CFA Translate Manager** (bảng tiến độ mọi volume trong
  `../volumes.json`), nút **Chạy / Dừng / Chạy cả batch**, xem **log** trực tiếp,
  mở **PDF** đích ngay trong app.
- Chọn **Engine** ở đầu trang:
  - **Claude** — Workflow 4-phase (translate → verify → apply → vision), chất
    lượng cao nhất. Chạy `claude -p` với `translate_volume.js`.
  - **Codex** — luồng **MCP đơn giản** (`codex exec` + MCP `cfa-pdf-translator`),
    dịch cả volume theo **lô trang** nối chuỗi. Không có verify/vision; nhanh,
    gọn. Ô **Lô trang** chỉnh số trang mỗi lô.
- Checkpoint theo file: **Dừng** giữa chừng rồi **Chạy** lại là **tự resume**
  (Claude theo unit file; Codex theo `codex_state.json` + `codex_work.pdf`).

## Bố cục chia đôi + Terminal bên cạnh

Cửa sổ chính chia **2 pane**: TRÁI = dashboard, PHẢI = **Terminal thật** (xterm.js
+ node-pty), shell đăng nhập tại thư mục `translate`.

- **⌘T**: ẩn/hiện pane Terminal. **⌘⇧.** / **⌘⇧,**: rộng/hẹp pane. Menu
  *Terminal → Terminal cửa sổ rời* mở terminal ở cửa sổ riêng.
- Dùng để chạy **`claude` / `codex` INTERACTIVE** — tận dụng đầy đủ harness của
  Claude Code và **duyệt MCP tương tác** của Codex.

### Thêm tài liệu để dịch (nút **➕ Thêm PDF**)

Bấm **➕ Thêm PDF** trên đầu trang → chọn 1 hay nhiều file PDF → app **copy vào
`input/`** (qua `POST /api/upload`) và tự **phát hiện** thành mục dịch (nhãn 📄),
bản dịch xuất ra `output/<tên>_vi.pdf`. (Hoặc thả file trực tiếp vào `input/`.)

### Chạy 1 phần + xem live + lưu log (nút trên mỗi volume)

Mỗi dòng volume có thêm 2 nút (chỉ hiện trong app):

- **▶ Term** — chạy volume đó **trong Terminal bên cạnh** để xem tiến trình LIVE,
  và `tee` **lưu log** vào `work/<tag>/<engine>.terminal.log`. Ô **Trang** ở đầu
  trang (vd `40-80`, 0-based) giới hạn **chạy 1 phần** (chỉ Codex; Claude chạy cả
  volume). Terminal-run dùng **bypass** (bạn tự bấm chạy + xem) nên Codex qua
  được rào duyệt MCP.
- **📺 Log** — `tail -f work/<tag>/run.log` trong Terminal để theo dõi một lần
  chạy **headless** (nút Chạy) đang diễn ra.

Vì sao cần: `codex exec` **headless không tự duyệt được MCP tool call** (mỗi call
sinh 1 elicitation `mcp_tool_call_approval` và bị tự huỷ trong chế độ không tương
tác — đã xác minh qua trace; chỉ cờ `--dangerously-bypass-approvals-and-sandbox`
mới qua). Chạy `codex` trong Terminal thì bạn **duyệt bình thường** nên MCP
`cfa-pdf-translator` hoạt động đầy đủ. Nút "claude"/"codex" trên thanh terminal
chèn nhanh tên lệnh.

> node-pty là native module: sau `npm install` phải **rebuild theo ABI Electron**
> `npx electron-rebuild -f -w node-pty` (đã chạy). Nếu đổi phiên bản Electron thì
> rebuild lại. Thiếu node-pty → app vẫn chạy, chỉ Terminal báo lỗi.

## Điều kiện cho engine Codex

MCP server phải được đăng ký cho Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.cfa-pdf-translator]
command = "python3"
args = ["/Users/khanhnm/Desktop/translate/tool/server.py"]
```

và thư mục `translate` nên được `trust_level = "trusted"`. (Đã cấu hình trong máy
này; `command` trỏ tuyệt đối tới python 3.11 có sẵn `mcp`+`pymupdf`.)

**Lưu ý luồng Codex headless:** với **Quyền = allowlist**, MCP tool call sẽ bị
`codex exec` tự huỷ (không hoàn tất) — xem mục Terminal ở trên. Muốn Codex dịch
tự động headless phải chọn **Quyền = bypass** (dùng
`--dangerously-bypass-approvals-and-sandbox`, bỏ cả sandbox — rủi ro, tự cân
nhắc). Khuyến nghị: chạy **Claude** cho headless, và dùng **Terminal** cho Codex
interactive.

## Đóng gói .app / DMG (sau)

`package.json` đã có config `electron-builder`. Khi muốn build bản phân phối:

```bash
npm i -D electron-builder
npm run dist          # tạo .app trong dist/ (target: dir)
```

Icon, code-sign / notarize để sau (MVP chưa làm).

## Kiến trúc (ngắn)

```
Electron main.js
  ├─ freePort() → spawn `python3 dashboard.py --port N`  (cwd = tool/)
  ├─ chờ /api/ping = 200  → BrowserWindow.loadURL(http://127.0.0.1:N)
  └─ before-quit → SIGTERM backend (agent con đang chạy vẫn resume được)
dashboard.py  (đã có sẵn, nay hỗ trợ engine claude|codex)
  └─ spawn `claude -p …`  hoặc  `codex exec …`
```
