# Layout Playbook — sửa lỗi layout "cho chuẩn"

Tài liệu quy trình khi vision review phát hiện defect layout. Nguyên tắc cốt lõi:
**mỗi defect phải được sửa ở ĐÚNG KÊNH của nó** — rút gọn bản dịch không chữa
được lỗi engine, và sửa engine phải có lưới an toàn chống regression.

## 0. Hai bất biến làm mọi thứ rẻ và an toàn

1. **Bản dịch cache theo TEXT** (`text2vi.json` + override theo id `fixes.json`)
   → `apply` chạy lại **không tốn agent**, chỉ tốn vài phút CPU.
2. **`apply` là DETERMINISTIC** (đã kiểm chứng: cùng cache → pixel giống 100%)
   → so pixel-hash từng trang là ground truth rẻ để biết trang nào đổi.

Hệ quả: sửa engine (pdf_core) xong chỉ cần `apply` lại + so hash + re-vision
đúng các trang đổi. KHÔNG phải dịch lại toàn bộ vì lý do layout.

⚠ **Ngoại lệ quan trọng:** nếu engine fix ĐỔI SEGMENTATION (tách/gộp/thêm đoạn
trích), các text MỚI chưa có trong cache → `apply` để nguyên tiếng Anh (đếm ở
`missing=`), và override `fixes.json` theo id tự vô hiệu (apply xác minh `en`
từng entry, entry lệch bị bỏ). Khi đó chạy thêm:

```bash
python3 agent_pipeline.py chunk "$SRC" "$WD" --force   # merge out/ cũ rồi re-chunk
# -> todo mới = CHỈ các text chưa có cache; chạy pipeline để dịch phần đó
python3 agent_pipeline.py vchunk "$SRC" "$WD" --force  # tương tự cho verify
```
(`--force` đã an toàn: tự merge tiến độ cũ vào cache TRƯỚC khi xoá output cũ —
tránh va index giữa chunking cũ/mới.)

## 1. Phân loại defect: `defect-report`

```bash
python3 agent_pipeline.py defect-report <workdir>      # JSON cụm + kênh sửa
```

| Kênh    | Nghĩa                                   | Cách xử lý                          |
|---------|------------------------------------------|-------------------------------------|
| text    | Bản dịch dài → tràn/đè                   | Vòng auto-fix rút gọn (tự động)     |
| code    | Engine trích/ghi sai (công thức, bảng…)  | Sửa `pdf_core.py` theo mục 3        |
| policy  | Hành vi cố ý (vd xoá highlight)          | Đổi chính sách hoặc `accept`        |
| mixed   | Một phần text + một phần code            | Auto-fix trước, còn lại theo code   |
| unknown | Chưa nhận diện pattern                   | Xem tay từng cái, bổ sung RULES     |

Vòng auto-fix trong `translate_volume.js` chỉ lấy trang kênh **text**
(`problems <wd> medium text`) — không phí agent rút gọn trang lỗi engine,
không làm hỏng bản dịch đang đúng.

Số liệu v1 (2026-07-12): 111 trang defect thì chỉ **17 trang kênh text**;
94 trang còn lại là code/policy — đây là lý do playbook này tồn tại.

## 2. Vòng sửa TEXT (tự động — đã có)

`translate_volume.js` phase Fix: `problems text` → agent rút gọn → `merge-fix`
(ghi `fixes.json` theo segment id) → `apply` → re-vision đúng trang đó.
Tối đa 2 vòng; không hội tụ thì giữ stage `review` (trung thực).

## 3. Vòng sửa CODE (engine `pdf_core.py`) — golden regression

Sửa engine là sửa **một-lần-chữa-mọi-trang** cùng pattern, nhưng cũng có thể
phá trang đang đúng. Quy trình bắt buộc:

```bash
WD=tool/work/v1; SRC="..."; OUT="..."

# 1) Baseline TRƯỚC khi sửa code
python3 agent_pipeline.py golden-snap "$OUT" "$WD"

# 2) Sửa pdf_core.py (một pattern mỗi lần — dễ quy trách nhiệm)

# 3) Apply lại từ cache (không tốn agent)
python3 agent_pipeline.py apply "$SRC" "$WD" "$OUT"

# 4) Trang nào đổi?
python3 agent_pipeline.py golden-diff "$OUT" "$WD"
#    -> {"changed":[...]} PHẢI ⊆ các trang defect nhắm tới.
#    Trang khác cũng đổi = tác dụng phụ -> soi lại code trước khi nhận.

# 5) Re-vision CHỈ các trang đổi
python3 agent_pipeline.py revision "$WD" "<changed, csv>"
#    rồi chạy pipeline (only=vision) hoặc để lần chạy sau tự soát.
```

Đã kiểm chứng harness: apply 2 lần không đổi → diff rỗng; inject 1 thay đổi
trang 5 → diff bắt đúng `[5]`.

### Map cụm lỗi → root cause đã XÁC MINH (workflow 8 agents đọc ảnh + code, 7 phản biện đồng ý, 2026-07-12)

| Cụm | Root cause (đã xác minh) | Fix chính | Rủi ro cần né |
|-----|--------------------------|-----------|----------------|
| congthuc_vo | `_is_formula_like` chỉ lọc mức BLOCK/ITEM, không per-LINE: mảnh công thức (overline, sub/superscript, tử/mẫu) trong block hỗn hợp bị gom vào run prose → redact nửa công thức + flatten. `_heading_font` match cả *italic* → ký hiệu toán italic được "giữ" nhưng box dịch vẫn phủ lên → chữ đè (p25) | Guard per-line ở `_extract_blocky` + nhánh continuation của `_extract_bulleted`: dòng formula-like / có glyph overline lẻ / span cỡ lệch >25% body → cắt run, giữ nguyên, kẹp đáy run trước | Guard quá nhạy bắt nhầm dòng prose nhiều số (`[100% + −50%]/2 = 25%`) → đoạn bị xé, không được dịch |
| bullet_indent | 3 bug hình học: (1) item mở bằng bullet không set `cur["blk"]` → nuốt dòng đầu đoạn kế + `min()` kéo mép trái box về cột glyph ■ → chữ đè glyph, mất hanging indent (p17); (2) `tx0` tính cả span TOÀN whitespace → box dán sát nhãn, lệch 6.8pt (p130); (3) `col_right` lấy max toàn trang → box trong khung vượt viền (p57) | (1) set `cur["blk"]`, clamp left ≥ tx0 ban đầu; (2) bỏ span whitespace khỏi tx0 (cả `_extract_labeled_lines` ~513 lẫn `_extract_bulleted` ~693); (3) kẹp mép phải theo viền khung từ `get_drawings()` | Set blk cứng quá → PDF block-per-line bị xé item thành nhiều segment (tái phát lỗi co font); chỉ chặn khi continuation kéo lề TRÁI hơn |
| bang_vo | `_NUM_CELL` regex cấm chữ cái → ô có mã tiền tệ (EUR0, USD1,000, −USD1,800) không được coi là ô số → `_is_table_row`=False → cả hàng bảng đi đường prose, dồn cột | Nới `_num_cell`: strip tiền tố tiền tệ (`[A-Z]{2,4}` trước số) + thêm dấu trừ Unicode −(U+2212) vào class | Câu justify có khoảng trắng giãn >24pt trước "USD100" có thể false-positive thành bảng → block bị bỏ dịch |
| khac | (A) redact rect dùng bbox dòng thô chờm 1.76pt vào nhãn 'Solution:' block kế → nhãn bị redact mất (p84); (B) cơ chế co font không đồng nhất giữa các item cùng danh sách | Kẹp redact XUYÊN block: shave rect khi giao bbox dòng heading/kept của trang (tổng quát hoá fix #13/#15) | Shave để sót sliver 1–2pt chữ Anh (đuôi y/g/p) sát heading |
| highlight_mat | `apply_translations` CHỦ Ý xoá mọi Highlight/Underline trên trang có dịch — kể cả annot phủ CÔNG THỨC không hề bị redact (p65) | Tầng 1 (an toàn, làm ngay): chỉ xoá annot GIAO redact-rect; annot trên vùng giữ nguyên thì giữ. Tầng 2: vẽ lại highlight theo box mới khi % giao đủ lớn | Tầng 2 over-highlight khi annot gốc chỉ phủ vài câu trong segment lớn — cần ngưỡng % giao |
| label_tach_dong | `_line_is_heading` phân loại theo span TRỘI (`_dominant`) → câu có bold run-in mà phần thường bị cắt vụn span → cả dòng thành "heading", giữ nguyên + tách rời | Đổi sang TỶ LỆ ký tự bold/oversize trên cả dòng (≥0.8 mới là heading); 'Solution:' (100% bold) vẫn đúng | Dòng nhãn đậm share 0.5–0.8 đổi hành vi → soi lại nhóm fix #14/#15 |
| chu_de_chong | Vật cản chỉ lấy từ `get_text('dict')` (text/ảnh raster) — **line-art vector (ngoặc nhọn, viền khung, cột bar) VÔ HÌNH** → box nới vượt, chữ Việt đè đồ hoạ | Bổ sung obstacle từ `page.get_drawings()` vào all_boxes (rect mảnh giữ nguyên; khung rỗng tách 4 dải mép) + thêm kẹp mép-PHẢI kiểu `_bottom_limit` | `get_drawings()` trả cả nền tô (shading bảng, thanh đen Exhibit) → phải lọc fill-only bao trùm segment, kẻo kẹp đáy quá tay |
| tran_khung | Cùng họ với chu_de_chong: viền khung (LEARNING MODULE OVERVIEW, QUESTION SET…) là vector 1pt → extractor không thấy → nới đáy/phải xuyên viền | h_lines/v_lines từ `get_drawings()` (h≤2.5&w≥30 / w≤2.5&h≥30), kẹp đáy tại `_extract_bulleted`~746, `_extract_blocky`~599, `_extract_labeled_lines`~539 | Đổi tràn-viền thành co-chữ 5.5pt → tăng báo cáo 'fit'; cân nhắc sàn cỡ chữ |

Ghi chú kênh: `tran_khung`/`chu_de_chong` là **kênh kép** — auto-fix text vẫn
chạy trước (rút gọn giúp vừa box), nhưng fix BỀN là code (obstacle từ
drawings). Cụm `khac` thực chất là code (redact chờm + co font), không đưa vào
vòng text.

Thứ tự sửa engine khuyến nghị (tác động/трang lớn nhất, rủi ro thấp nhất trước):
1. `highlight_mat` tầng 1 (1 điều kiện giao rect — an toàn nhất, 18 trang)
2. `bang_vo` (`_num_cell` strip tiền tệ — cục bộ, 23 trang)
3. `bullet_indent` (3 fix hình học nhỏ, 25 trang)
4. `chu_de_chong` + `tran_khung` (obstacle get_drawings — nền tảng chung, 17 trang)
5. `congthuc_vo` (guard per-line — nhiều rủi ro nhất, làm sau cùng, 19 trang)
6. `label_tach_dong` + `khac` (heading ratio + shave redact)

MỌI fix ở trên bắt buộc đi qua vòng golden (mục 3).

## 4. Kênh POLICY

Hành vi cố ý của engine mà vision cứ flag mãi (vd mất highlight):
- Sửa policy thật (vd vẽ lại highlight) → tốt nhất, hoặc
- `accept <wd> <pages> "lý do"` → đánh dấu won't-fix, thoát khỏi vòng lặp, hoặc
- Dạy prompt vision phân loại đó là `fit` (đánh đổi chấp nhận) — sửa
  `visPrompt` trong `translate_volume.js`.

⚠ `accept` là **PAGE-WIDE**: chỉ accept khi MỌI defect của trang đó đều là
policy/fit. Một trang có thể vừa mất highlight (policy) vừa vỡ công thức
(code) — vd v1 trang 27, 65 — accept sẽ nuốt luôn lỗi thật. Lệnh `accept` tự
cảnh báo (⚠) khi trang còn defect kênh khác; thấy cảnh báo thì đừng accept,
sửa lỗi kia trước.

## 5. Thứ tự làm việc khuyến nghị (mỗi volume)

1. Chạy pipeline đến hết vision → `defect-report`.
2. Vòng auto-fix text chạy tự động (phase Fix).
3. Cụm `code` lớn nhất trước (nhiều trang nhất / severity cao):
   golden-snap → sửa 1 pattern → apply → golden-diff → re-vision trang đổi.
4. Lặp 3 cho cụm kế; cụm `policy` quyết một lần (sửa hoặc accept).
5. `review-summary` → hội tụ khi defect ≥ medium = 0.

Sửa engine hưởng lợi MỌI volume: sau khi nhận một engine fix, chạy
`apply-all` + re-vision các trang golden-diff báo đổi ở từng volume.

⚠ `apply-all` yêu cầu: (1) KHÔNG có pipeline nào đang chạy (lệnh tự bỏ qua
volume có run.json mode=running + pid sống, nhưng tốt nhất dừng hết từ Hàng
đợi trước); (2) mỗi workdir phải có `golden-snap` MỚI chụp trước engine fix —
baseline cũ/thiếu làm golden-diff vô nghĩa; (3) golden-diff trả `"ok": false`
(lệch số trang) là lỗi nghiêm trọng — dừng lại soi ngay, đừng chỉ nhìn
`changed`.
