# Changelog

## 2026-07-12 (engine riêng từng cuốn + chạy song song)

### Added

- **Chọn engine RIÊNG cho từng tài liệu.** Mỗi cuốn có thể dịch bằng Claude /
  Codex / Grok khác nhau. Chọn ở màn chi tiết run (`/run?tag=`); lưu vào
  `workdir/pref.json` và dùng cho mọi lần chạy sau (kể cả batch). Ưu tiên:
  engine chỉ định lúc chạy > pref của cuốn > engine global.
- **Chạy nhiều tài liệu song song.** Nút "▶ Chạy tất cả" ở Hàng đợi với ô chọn
  số cuốn chạy cùng lúc (1–8); batch lấp đầy tới hạn mức, mỗi cuốn dùng engine
  riêng của nó. Nút chuyển thành "Dừng tất cả (N)" khi đang chạy; badge hiện
  "Song song N/limit". (Chạy lẻ từng cuốn vốn đã song song được.)

### Technical

- Endpoint mới `POST /api/volconfig {tag, engine}` (chọn engine không chạy ngay);
  `POST /api/run` nhận `engine`; `POST /api/batch {action:"start", limit}`.
  `launchVolume(vol, cfg, engineOverride?)`; `BATCH` thêm `running:Set` + `limit`,
  `runBatch` chạy tối đa `limit` cuốn đồng thời. Status trả `batch.running[]` +
  `limit`, `Volume.pref_engine`. Chọn engine ngay trên mỗi dòng Hàng đợi.

### Fixed (sau Codex review — engine + song song)

- **[High] `launchVolume` không an toàn ngoại lệ sau spawn.** Nếu `saveRunMeta`
  lỗi sau khi spawn, sẽ rò `starting`, không gắn listener, và ném ra khiến batch
  scheduler kẹt. Giờ clear `starting` + gắn listener TRƯỚC, `saveRunMeta` là
  best-effort (try/catch).
- **[Medium] Race stop→start chạy 2 scheduler.** `BATCH.gen` (generation token):
  stop/start tăng gen → vòng `runBatch` cũ tự thoát, không xử lý queue mới.
- **[Medium] `limit` không phải trần đồng thời thật.** `runningCount()` đếm MỌI
  cuốn đang chạy (kể cả chạy lẻ) → đúng "tối đa N cùng lúc".
- **[Medium] `/api/run` engine sai bị nuốt; lưu pref trước khi chạy.** Giờ engine
  sai → 400; chỉ lưu pref SAU khi chạy thành công. pref.json hỏng bị bỏ qua.
- **[Medium] Nút Chạy ở Hàng đợi không dùng engine vừa chọn.** `launch` truyền
  thẳng engine đang chọn vào `runVolume` (không phụ thuộc pref lưu kịp hay chưa).
- **[Medium] Màn chi tiết fallback cứng "claude".** Lấy fallback từ
  `s.config.engine` → không chạy nhầm Claude khi global là Codex/Grok.
- **[Low] `/api/batch`**: start khi đang chạy → 409; limit ép số nguyên.
- **[Low] Dòng đang chạy hiện engine THẬT (`v.engine`)**, không phải pref sắp dùng.
- Còn lại (nhỏ, tự lành): stop→start tức thì có thể bỏ qua cuốn vừa SIGTERM chưa
  thoát (lần chạy sau tự nhận lại); reap theo tag chưa theo sid.

## 2026-07-11 (chiều — pipeline dịch + màn chi tiết run)

### Added

- **Stage "review" (đã dịch xong chữ nhưng CHƯA sạch layout).** `_status` giờ chỉ
  trả "done" khi mọi trang defect ≥ medium đã được sửa/accepted; còn lại là
  "review" kèm số `defects`. Trước đây "done" chỉ nghĩa "đã vision review hết",
  che giấu các trang lỗi (vd v1 hiện ra **111 trang cần sửa**).
- **Vòng auto-fix trong Workflow dịch.** Sau Vision, `translate_volume.js` lặp
  (tối đa 2 vòng): lấy trang defect → rút gọn bản dịch tràn khung (agent) →
  re-apply → **chỉ re-vision đúng các trang vừa sửa** → tới khi hết defect. Trang
  không hội tụ giữ nguyên → stage "review" (trung thực, không auto-accept).
  Thêm helper `page-segments`, `merge-fix`, và chế độ `vis-pages ... <only>`.
- **Màn chi tiết run riêng (`/run?tag=`).** Bấm một dòng trong Hàng đợi → mở màn
  chi tiết: tiến độ từng stage (Dịch / Rà soát / Soát layout), số trang defect,
  và **log hoạt động trực tiếp** (full, auto-scroll). Có nút Dừng / Chạy để sửa /
  Đọc song song.

### Fixed

- **Daemon tính sai tổng số trang.** `pythonStatus` lấy `pages` từ số ảnh
  `pair_*.png` khi `layout.pdf` (đường dẫn tương đối) không `existsSync` được từ
  cwd của daemon → đếm dư (650 vs 624 trang) khiến volume kẹt ở "vision". Giờ ưu
  tiên `state.json.vision[1]` (nguồn chuẩn từ python cmd_status).

### Technical

- `defectPages()` (daemon) mirror `_defect_pages` (python) để phân biệt "reviewed"
  với "sạch layout" mà không spawn python. Volume "review" được `pendingTags`
  coi là còn việc → batch tự chạy lại để sửa.

### Fixed (sau Codex review — 9 findings)

- **[High] Fix bị mất khi chạy lại / apply-all.** Auto-fix giờ ghi override theo
  **segment id** vào `fixes.json` (không sửa `text2vi`), và `apply` ưu tiên
  `fixes[id]` → sống sót qua `merge-tr`/`merge-vr`/`apply-all`.
- **[High] Sửa 1 trang đổi luôn trang khác cùng chuỗi EN.** Vì override theo id
  (per-occurrence), chỉ đúng đoạn trên trang lỗi đổi → việc "chỉ re-vision trang
  vừa sửa" (only=csv) trở nên ĐÚNG (trước đây có thể 'done' với trang chưa soát).
- **[High] Rút gọn cả công thức/bảng.** Prompt fix chỉ rút gọn đoạn văn xuôi
  ĐANG tràn, giữ nguyên đoạn đã gọn + mọi số/công thức/thuật ngữ; lỗi phi-văn-bản
  giữ "review" trung thực (không sửa ẩu).
- **[High] "Chạy để sửa" có thể bị đánh 'done' giả.** `codexDone()` không còn
  ghi đè khi stage='review' (còn defect).
- **[Medium] Resume 'review' re-vision cả cuốn.** Fast-path `stage:"review"` bỏ
  qua translate/verify/apply + vision toàn bộ, vào thẳng vòng fix trên checkpoint.
- **[Medium] 'done' giả khi thiếu review_issues.json.** Gate 'done' phải có
  `review_issues.json` (merge-vis đã chạy) — cả python `_status` lẫn daemon.
- **[Medium] Enter/Space từ nút con nhảy sang trang chi tiết.** onKeyDown chỉ
  kích hoạt khi `e.target === e.currentTarget`.
- **[Medium] Ảnh bìa spawn Python mỗi request, chặn daemon.** `/api/page` cache
  ra đĩa theo (file, mtime, page, dpi) — lần 2 nhanh ~200× (0.67s → 0.003s).
- **[Low] review-summary lệch ngưỡng với status.** Dùng chung `FIX_SEV`, báo lỗi
  'low' riêng (không chặn 'done').

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

### Fixed (sau Codex review lần 2)

- **Chat — cô lập theo "generation":** thêm bộ đếm owner + khóa `hydrating`;
  đổi tài liệu/hội thoại là vô hiệu hóa đồng bộ các ref cũ và chặn gửi trong lúc
  đang nạp. Vá 3 lỗi race (High) làm lẫn transcript/session giữa các hội thoại
  khi thao tác giữa chừng: gửi lúc đang hydrate, chọn hội thoại rồi gửi trước
  khi nạp xong, và đổi tài liệu ngay trong lúc `createConversation` đang chạy.
  `session` snapshot lấy TRƯỚC mọi `await`; `busy` luôn được clear khi stream
  kết thúc dù đã chuyển tài liệu.
- **Chat — lưu bị đè:** hai lần lưu mỗi lượt (user-turn + full) giờ được xếp
  hàng tuần tự (`saveChainRef`) nên bản lưu tạm không thể ghi đè mất câu trả lời.
- **Hàng đợi:** chip “Đang khởi động…” tự tắt ngay khi CHÍNH lần chạy đó (khớp
  `sid`) đã thoát (spawn lỗi/chạy xong tức thì), không còn phụ thuộc mỗi timeout
  20s; tránh false-positive từ metadata cũ khi bấm “Chạy tiếp”.
- **Hàng đợi:** progress bar của dòng đang chạy trước đây ngắn hơn ~44px (do ô
  % nằm trong cột 220px) → mọi dòng giờ dùng chung khe % cố định nên track thẳng
  hàng tuyệt đối.

### Technical (sau Codex review lần 2)

- `/api/log` chỉ đọc **64KB cuối** của `run.log` (bounded tail) thay vì
  `readFileSync` toàn bộ file mỗi 2.5s → không còn chặn event loop của daemon
  khi log lớn; client LogTail thêm cờ chống chồng request.
- Còn nợ (không blocking): đóng gói `better-sqlite3` cho bản Electron (electron
  -rebuild + ship module) để chat lưu bền trong app đóng gói.

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
