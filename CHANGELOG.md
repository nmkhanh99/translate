# Changelog

## 2026-07-11

### Added

- **Chat lưu bền theo từng tài liệu (SQLite).** Mỗi document tag giờ là một
  "project" có thể chứa **nhiều hội thoại**, mô phỏng mô hình
  `projects → conversations → messages → agent_sessions` của open-design.
  - Daemon: module `apps/daemon/src/chat-db.ts` (better-sqlite3, file
    `tool/chat.sqlite`) + endpoint `GET/POST /api/conversations`,
    `GET /api/conversation`, `POST /api/conversation/save`,
    `POST /api/conversation/delete`.
  - UI: `ChatDrawer` chuyển từ store in-memory sang server-backed; thêm menu
    chọn/tạo/xóa hội thoại (`ConversationsMenu`), tự nạp lại hội thoại gần nhất
    khi mở cuốn, lưu transcript + `session_id` mỗi engine để **resume qua
    reload/restart**.
- **Hàng đợi:** trạng thái “Đang khởi động…” hiện ngay sau khi bấm *Chạy ngay*,
  nhãn stage tiếng Việt + chấm live, và **log tail trực tiếp** (đọc `/api/log`)
  để thấy tiến trình đang chạy gì.

### Changed

- Hàng đợi poll nhanh hơn (3.5s → 2s) để tiến trình cập nhật kịp thời.

### Fixed

- **Hàng đợi:** các dòng progress bar lệch nhau — chuyển mỗi dòng sang grid
  3 cột cố định (`1fr | 220px | 132px`) nên mọi thanh progress thẳng hàng.
- **Chat:** id tin nhắn có thể trùng sau khi reload (bộ đếm `m1,m2…` reset về 0
  trong khi transcript đã lưu dùng đúng các id đó) → dùng `crypto.randomUUID()`.
- **Chat:** khi đổi tài liệu/hội thoại lúc stream còn chạy, `session_id` có thể
  ghi nhầm sang hội thoại mới → mỗi lượt gửi dùng bản snapshot session riêng,
  chỉ mirror lại ref khi lượt đó vẫn là hội thoại đang xem.

### Technical

- `apps/daemon`: thêm dependency `better-sqlite3`; esbuild bundle thêm
  `--external:better-sqlite3` (native module không bundle được).
- `chat-db.ts` degrade an toàn: nếu native module lỗi (vd ABI mismatch), daemon
  log một dòng và trả `persist:false`; UI tự chuyển sang một hội thoại tạm
  in-memory thay vì sập.
- **Lưu ý đóng gói:** bản desktop chạy daemon bằng Node 20 của Electron 33
  (không có `node:sqlite` built-in). Muốn chat lưu bền trong bản đóng gói cần
  **electron-rebuild** `better-sqlite3` và ship kèm node_modules của nó vào
  `Resources/daemon/`. Trong dev (tsx/Node 24) đã chạy sẵn.
- Codex review trước commit chạy dở thì tiến trình chết (~24 phút không hoạt
  động); đã lấy các phát hiện Codex nêu được, tự đối chiếu code và sửa 2 lỗi
  hợp lệ ở trên. SQL/transaction/parameter hóa được Codex xác nhận đúng.
- `.gitignore`: bỏ qua `tool/chat.sqlite*`.
