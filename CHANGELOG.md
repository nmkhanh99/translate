# Changelog

## 2026-07-12 (ENGINE FIX đợt 1 — sửa 7 lớp cơ chế trong pdf_core)

### Fixed

Sửa engine render theo LỚP CƠ CHẾ (áp dụng mọi PDF cùng họ, không vá theo trang;
mỗi fix theo điều kiện an toàn từ vòng phản biện 15-agent trước đó):

- **Bảng có mã tiền tệ vỡ cột** (`_num_cell`): strip tiền tố EUR/USD + nhận dấu
  trừ Unicode − → hàng `EUR0/EUR50/EUR1,000` được giữ nguyên cột.
- **Mất highlight** (tier-1, `apply_translations`): chỉ xoá annotation GIAO vùng
  redact — highlight trên công thức/vùng giữ-nguyên được GIỮ LẠI.
- **Nhãn bold run-in tách rời câu** (`_line_is_heading`): phân loại heading theo
  TỶ LỆ ký tự đậm/lớn (≥0.8) thay vì span trội.
- **Bullet vỡ hình học** (`_extract_bulleted`): continuation nhận theo (cùng
  block ∨ thẳng lề text −6) thay vì so cột glyph; clamp left ≥ tx0; tx0 bỏ span
  toàn whitespace (2 chỗ).
- **Tràn/đè viền khung & ngoặc nhọn** (`_collect_drawing_lines`): lấy đường kẻ
  vector từ `page.get_drawings()` (primitive mỏng + 4 cạnh khung stroke + path
  hẹp-cao) làm obstacle; kẹp đáy (`_clamp_bottom_hlines`: chỉ chặn phần nới thêm,
  phủ ≥60% bề ngang) + kẹp mép phải (`_clamp_right_vlines`, sàn = rect gốc).
- **Công thức bị redact nửa vời** (`_line_is_formula_fragment`): guard per-line
  7 rule (FORMULA_HEAD+mật độ, 'biến =' ngắn ít từ, ký hiệu mạnh+ít từ, dòng
  toàn glyph gạch/overline, span lệch cỡ ≥60%, ≥2 ZWSP, token mồ côi ≤2 ký tự)
  ở cả 3 đường đi; mảnh làm boundary kẹp đáy (không đè).
- **Redact ăn glyph xuyên block** (`_shave_redacts`): shave phần chờm ≤3pt/≤30%
  vào dòng giữ-nguyên, 2 chiều, guard chống rect lộn ngược.

### Kiểm chứng

- Extraction-diff bộ sentinel 34 trang (v1 + v2): mọi thay đổi truy được về đúng
  fix; text chỉ merge/giữ-có-chủ-đích, không rớt.
- Golden pixel-diff: v1 364/624 trang đổi (89/111 trang defect được chạm),
  v2 386/656; `ok:true` cả hai.
- 21 agent chấm trực quan (src|cũ|mới): **12 better / 4 same / 3 mixed / 2
  worse** — mọi điểm trừ là cache-miss chờ dịch bù hoặc highlight tier-2 (chưa
  làm, có chủ đích); 1 regression thật (`FVt = PVer t.` vẽ đè 2 lớp p57) đã vá
  bằng rule 'biến = ngắn ít từ' + unit test 4 case biên + render lại xác nhận.
- `chunk --force` v1: 272 text cần dịch bù (7 chunk) — chạy pipeline là xong.

### Fixed (vòng review thứ 2 — /code-review đa-agent, 10 findings CONFIRMED)

Codex hết quota ("usage limit") nên dùng bộ review đa-agent của Claude thay thế
(finder theo góc + verifier độc lập, có case verify bằng chạy thật). Sửa cả 10:

- Guard formula per-line quá rộng: `σ`/`±`/`→∞` giữa câu prose, `'Yes.'`,
  `'of 0.05.'`, `'so'`… bị coi là công thức → siết: strong-math cần mật độ
  math≥3 + ≤2 từ; orphan-token cần KHÔNG có từ thật nào + có chữ số.
- Ceiling redact LỘN NGƯỢC khi boundary cùng hàng (3 chỗ) → guard `y1>ceiling>y0`
  (rect rỗng làm chữ Anh sống sót, vẽ đè 2 lớp).
- `_line_is_heading` trả True cho dòng toàn whitespace → xé đoạn làm 2 → False.
- Inline-heading merge nuốt nhầm nhãn side-by-side (`Step 1 | nội dung`) → thêm
  điều kiện giao ngang thật.
- Annot trên header vẽ-lại không bị xoá (lệch chỗ) → red_rects gộp cả header.
- `_shave_redacts` kept-box mỏng NẰM TRỌN trong redact cắt cụt redact → yêu cầu
  straddle mép thật.
- `snap_extract` PDF ngắn hơn sentinel → spec rỗng = 'all' âm thầm → dừng rõ.

Sau sửa: 22/22 unit case biên PASS (giữ nguyên mọi true-positive: FVt, n−1, P,
ZWSP, thanh phân số, ∑(1/Xi); loại hết false-positive), sentinel diff ổn định
đúng 29 trang đã kiểm chứng.

### Technical

- `snap_extract.py` (mới): snapshot/diff extraction bộ trang sentinel — lưới
  regression khi sửa pdf_core, dùng kèm golden-diff.
- OUT thật CHƯA bị ghi đè (apply thử ra /tmp); lần chạy pipeline kế tiếp sẽ
  dịch bù + apply engine mới + vision quét lại. Playbook cập nhật trạng thái
  fix + thủ tục sau engine-change.

## 2026-07-12 (hệ thống sửa layout "cho chuẩn": defect-report + golden + playbook)

### Added

- **`defect-report`** — phân cụm defect theo pattern + kênh sửa (`text` = auto-fix
  rút gọn / `code` = sửa engine pdf_core / `policy` / `mixed`). Endpoint
  `GET /api/defects` + hiển thị cụm lỗi ở màn chi tiết run (bấm cụm → tự điền ô
  "Soát lại trang cụ thể"). Số liệu v1: 111 trang defect, chỉ 17 trang kênh text
  — còn lại cần sửa engine.
- **Golden regression harness** — `golden-snap` / `golden-diff` (pixel-hash từng
  trang). Đã kiểm chứng: `apply` DETERMINISTIC (27/27 trang giống hệt) → sửa
  pdf_core xong chỉ cần apply lại (không tốn agent) + diff → biết chính xác trang
  nào đổi; trang đổi ngoài dự kiến = regression bắt ngay. Test: no-change → diff
  rỗng; inject 1 thay đổi → bắt đúng trang.
- **`python/LAYOUT_PLAYBOOK.md`** — quy trình sửa layout theo kênh, kèm bảng
  root-cause ĐÃ XÁC MINH cho 8 cụm lỗi (workflow 8 agents đọc ảnh gốc|dịch +
  code, 7 phản biện đồng ý): `_NUM_CELL` cấm chữ cái → bảng có EUR/USD vỡ;
  line-art vector vô hình với extractor → tràn/đè khung; `_is_formula_like`
  không chạy per-line → công thức vỡ; highlight bị xoá cả trên vùng không redact;
  v.v. + thứ tự sửa khuyến nghị + rủi ro từng fix.

### Changed

- Vòng auto-fix trong `translate_volume.js` chỉ rút gọn trang có defect kênh
  **text** (`problems <wd> medium text`) — không phí agent vào trang lỗi engine,
  không rút gọn bừa bản dịch đang đúng.

### Fixed (sau Codex review — 11 findings: 4 High/6 Medium/1 Low)

- **[H] "Dịch lại" bị verify cũ đè mất:** resetStage(translate) giờ xoá cả
  `vchunks/vout/vid2en` (sinh từ bản dịch CŨ — giữ lại thì merge-vr đè sửa lỗi
  cũ lên bản dịch mới); resetStage(verify) cũng xoá vchunks (snapshot vi cũ).
- **[H] Redo xoá checkpoint rồi không chạy lại stage:** redo yêu cầu engine
  Claude (Codex/Grok không hiểu runOpts) → 400 TRƯỚC khi xoá; redo vision ép
  `vision:true` (chạy được cả khi config tắt vision).
- **[H] Engine fix đổi segmentation làm fixes.json dán nhầm chỗ:** fixes.json
  giờ lưu `{en, vi}` — apply xác minh id còn trỏ đúng đoạn (lệch en → bỏ qua);
  `chunk/vchunk --force` tự MERGE tiến độ cũ vào cache rồi mới xoá output cũ
  (tránh va index); playbook thêm thủ tục sau engine-fix.
- **[H] `accept` page-wide nuốt lỗi thật:** cảnh báo ⚠ khi trang còn defect
  kênh khác policy (vd trang 27/65 vừa mất highlight vừa vỡ công thức).
- **[M] Redo theo trang vẫn invalidate cả cuốn:** `visPages` truyền suốt
  server→Workflow → `vis-pages only=csv` (không còn cảnh mọi pair cũ hơn OUT bị
  coi stale → xoá sạch verdict).
- **[M] golden-diff fail-closed:** lệch số trang → các trang ngoài phần chung
  tính là changed + `"ok": false`; cảnh báo khi baseline chụp từ file khác.
- **[M] apply-all race với pipeline đang chạy:** tự bỏ qua volume có
  run.json mode=running + pid sống.
- **[M] `parsePageList` treo daemon với "1-999999999":** clamp endpoint trước
  khi loop (đo: 0s); khoảng ngoài phạm vi bị bỏ, không kéo về trang cuối.
- **[M] Cụm defect stale trong UI:** refetch theo cả stage + xoá list cũ khi
  đang tải (tránh bấm cụm cũ điền nhầm trang).
- **[M] `/api/defects` chặn event loop 20s:** chuyển spawnSync → execFile async.
- **[L] Regex chữ HOA tiếng Việt:** `[À-Ỵ]` lẫn chữ thường và thiếu Ỷ/Ỹ → liệt
  kê tường minh.
- Vá thêm (tự phát hiện): redo.pages nhập sai (parse rỗng) suýt xoá TOÀN BỘ
  vision verdicts → giờ trả 400.

## 2026-07-12 (chạy lại theo stage/trang + fix log)

### Added

- **Chạy lại theo stage ở màn chi tiết run.** Nút "Dịch lại" / "Rà soát lại" /
  "Soát layout lại (cả cuốn)" — xoá output stage đó rồi pipeline làm lại.
- **Chạy lại theo TRANG cụ thể (Soát layout).** Nhập "5-10, 12, 15" (số trang
  1-based) → chỉ render + soát lại đúng các trang đó (`only=vision`), không dịch/
  apply lại cả cuốn.

### Fixed

- **Log "dính vào nhau".** Log CLI (Codex/Grok) stream nhiều message nối liền
  không xuống dòng (vd `…PDF.MCP … chưa kết nối.Đang tìm…`). Panel giờ chèn ngắt
  dòng sau dấu kết câu khi ngay sau là chữ HOA/`` ` ``/`*` — KHÔNG tách số thập
  phân (3.14, 0.39%).

### Technical

- `resetStage(workdir, stage, pages?)` (xoá out/vout/vis/review theo stage/trang;
  dịch lại xoá luôn `fixes.json` cũ); `POST /api/run {redo:{stage,pages}}`;
  `launchVolume(..., runOpts)` + `buildClaudePipelinePrompt(..., runOpts)` truyền
  `only/visFrom/visTo` vào Workflow; `parsePageList` (1-based→0-based, clamp).

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
