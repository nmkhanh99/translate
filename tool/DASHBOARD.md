# Màn hình quản lý dịch — `dashboard.py`

Web dashboard (local) để **theo dõi tiến độ** và **chạy/dừng** pipeline dịch CFA
cho từng volume hoặc cả batch — thay cho việc gõ lệnh `Workflow` bằng tay trong Claude.

Chỉ dùng **thư viện chuẩn Python** (`http.server`) + `agent_pipeline.py` có sẵn.
Không cần Flask.

## Chạy

```bash
cd /Users/khanhnm/Desktop/translate/tool
python3 dashboard.py                # http://127.0.0.1:8756
python3 dashboard.py --port 9000    # đổi cổng
```

Mở địa chỉ in ra trong trình duyệt. Trang tự refresh mỗi 3 giây.

**Yêu cầu:** `claude` CLI (đã đăng nhập), `python3`, `pymupdf` (đã có trong
`requirements.txt`). Dashboard gọi `claude` như một tiến trình con nên máy phải
chạy được `claude -p`.

## Màn hình có gì

| Cột / nút | Ý nghĩa |
|-----------|---------|
| **Volume** | Tên tài liệu + `tag` (thư mục làm việc) + `sid`/`rc` lần chạy gần nhất. |
| **Trạng thái** | Stage hiện tại: `translate → verify → vision → done`. Chấm tím nhấp nháy = đang chạy. |
| **Tiến độ** | 3 thanh: translate / verify / vision (done/total, nguồn = filesystem). |
| **PDF↗** | Mở PDF tiếng Việt đã xuất (khi đã có file đích). |
| **log** | Xem log chạy trực tiếp (tóm tắt các bước agent đang làm). |
| **▶ Chạy / ■ Dừng / ↻ Chạy lại** | Bật/tắt pipeline cho volume đó. |
| **▶ Chạy cả batch** | Lần lượt chạy mọi volume chưa `done` (bỏ volume `skip`), tuần tự. |
| **Engine** | `claude` (Workflow 4-phase) hoặc `codex` (MCP đơn giản, dịch theo lô trang). |
| **Model / Quyền / Vision / Lô trang** | Cấu hình cho lần chạy kế tiếp (lưu `dashboard.json`). Model/Vision chỉ cho Claude; "Lô trang" chỉ cho Codex. |

## Engine Codex (luồng MCP đơn giản)

Chọn **Engine = codex** → nút Chạy spawn `codex exec` (thay vì `claude -p`), dùng
MCP server `cfa-pdf-translator` để dịch **cả volume theo lô trang nối chuỗi**: lô
đầu đọc PDF nguồn → ghi OUT; các lô sau đọc file làm việc `codex_work.pdf` (bản
sao OUT đã tích luỹ) → ghi OUT → cập nhật lại `codex_work.pdf`. Không đọc-ghi
trùng path (tránh lỗi PyMuPDF "save to original must be incremental").

- Resume nhẹ: `codex_state.json` (`done_through`, `last`) + `codex_work.pdf`.
  Dừng rồi Chạy lại là dịch tiếp từ trang dở.
- Không có stage verify/vision — nhanh & gọn, chất lượng = 1 lượt dịch của Codex.
- Cần đăng ký MCP cho Codex trong `~/.codex/config.toml` (xem `app/README.md`).
- **Giới hạn headless:** `codex exec` không tương tác **tự huỷ mọi MCP tool call**
  (elicitation `mcp_tool_call_approval` bị Cancel), kể cả `approval_policy=never`.
  Nên **Quyền = allowlist** (`-s workspace-write`) sẽ KHÔNG hoàn tất. Chỉ **Quyền
  = bypass** (`--dangerously-bypass-approvals-and-sandbox`, bỏ cả sandbox) mới
  auto-approve để luồng chạy. **Khuyến nghị:** dùng **Claude** cho headless, và
  chạy **`codex` interactive trong Terminal của app** (duyệt MCP bình thường).

## "Chạy" hoạt động thế nào

Bấm **Chạy** → dashboard spawn một tiến trình:

```
claude -p "<dùng Workflow chạy translate_volume.js cho volume này>" \
       --model <model> --permission-mode default \
       --allowedTools Bash(cd *) Bash(python3 *) Write Edit Read Agent Task Workflow ... \
       --add-dir <.../translate> --output-format stream-json --session-id <uuid>
```

Đây đúng là luồng `translate_volume.js` (translate → verify → apply → vision) bạn
vẫn chạy trong Claude, chỉ khác là được khởi động tự động. Vì pipeline **checkpoint
theo file**, nên:

- **Dừng** giữa chừng an toàn — bấm **Chạy** lại là **tự resume** phần còn dở.
- Nếu `claude` thoát sớm (`rc != 0`) mà volume chưa `done`, chỉ cần bấm Chạy lại.
- Tiến độ hiển thị lấy từ **filesystem** (không phụ thuộc tiến trình `claude` còn
  sống hay không), nên luôn phản ánh đúng thực tế.

## Quyền (posture) — lưu ý bảo mật

Khi spawn `claude` không tương tác, cần cấp quyền để agent không kẹt chờ duyệt:

- **`allowlist` (mặc định — ít quyền nhất):** `--permission-mode default` + chỉ cấp
  đúng các tool pipeline cần (`Bash(cd *)`, `Bash(python3 *)`, `Write`, `Read`,
  `Agent`, `Workflow`...). **Không tắt** cơ chế hỏi quyền; tool ngoài danh sách bị
  từ chối. Đã kiểm chứng chạy trọn pipeline không phát sinh từ chối quyền.
- **`bypass` (tự chọn):** `--permission-mode bypassPermissions` — bỏ **mọi** cửa hỏi
  quyền cho agent con. Tiện nhưng rủi ro hơn. Chỉ bật nếu bạn hiểu và chấp nhận.

Đổi ở ô **Quyền** trên đầu trang. Server chỉ bind `127.0.0.1` (máy bạn), không mở
ra mạng; các POST đổi trạng thái có chặn cross-origin (Origin phải là localhost) để
một trang web khác không tự ý bật `bypass` hay khởi chạy hộ bạn.

## File sinh ra

| File (trong mỗi `work/<tag>/`) | Vai trò |
|--------------------------------|---------|
| `run.log` | Log stream của lần chạy `claude` (dùng cho panel **log**). |
| `run.json` | pid/sid/model/trạng thái lần chạy (để biết còn chạy hay đã thoát). |
| `dashboard.json` (trong `tool/`) | Cấu hình model/posture/vision đã lưu. |

## Mẹo

- Muốn chất lượng cao nhất: chọn **Model = opus**. Cân bằng: **sonnet** (mặc định).
- Chạy cả batch để trống máy qua đêm; hết token hay tắt máy giữa chừng, mở lại
  dashboard và bấm batch tiếp — mỗi volume tự resume.
- `Vision` tắt đi sẽ bỏ bước review layout bằng ảnh (nhanh hơn, nhưng không soi lỗi
  trình bày từng trang). Khi tắt Vision, volume được tính **done** ngay sau khi
  translate + verify + xuất PDF xong (batch nhờ đó hội tụ, không chạy lại volume đã dịch).
