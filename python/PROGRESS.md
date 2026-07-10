# Tiến trình dịch CFA L1 — bản giao để dịch tiếp

Cập nhật: 2026-07-06. File này ghi **đang ở đâu** và **làm gì tiếp**. Chi tiết engine/lệnh xem `README.md`.

## 1. Tổng quan

- Dịch 10 tài liệu trong `2024 CFA L1 Curriculum/` sang tiếng Việt, **giữ layout**.
- Pipeline 1 volume: **translate → verify → apply → vision (review layout) → fix → re-vision**.
- Mọi bước **checkpoint theo file**, resume được: ngắt/hết token chỉ cần chạy lại.
- Output (cả bộ) tích luỹ ở: `2024 CFA L1 Curriculum - VI (agent)/` (mỗi `apply` ghi đè PDF cuối vào đây).

## 2. Trạng thái 10 tài liệu (xem lại bất cứ lúc nào)

```bash
cd python && python3 agent_pipeline.py batch-status volumes.json
```

| Volume | Workdir | Stage hiện tại |
|---|---|---|
| Topic Outlines | `work/topic_outlines` | vision (vis 0/27) |
| L1V1-Prereq Quant | — | **skip** (đã dịch qua `agent_pilot/`) |
| L1V1 | `work/v1` | vision — fix #15 vừa apply full 0–623, defect=169 (đã re-vision đủ) — xem mục 4.3/4.4 |
| L1V2-Prereq Econ | `work/econ_pre` | verify (15/98) |
| L1V2 | `work/v2` | verify (0/315) |
| L1V3-Prereq FSA | `work/fsa_pre` | verify (0/112) |
| L1V3 | `work/v3` | translate (148/157) |
| L1V4 | `work/v4` | verify (chưa vchunk) |
| L1V5 | `work/v5` | translate (81/136) |
| L1V6 | `work/v6` | translate (0/133) |

> Output đã có trong thư mục đích: Topic Outlines, Quant, L1V1, L1V2, L1V4 (các bản cũ áp engine cũ — chạy `apply-all` để đồng bộ về engine mới có 6 fix).

## 3. Cách dịch tiếp (qua Claude Code — Workflow do Claude gọi)

Nhắn Claude một trong các câu:

- **Cả bộ:** "chạy batch dịch CFA" → chạy đến khi cạn budget rồi báo `{processed, of}`. Hết token nhắn lại "dịch tiếp".
- **1 volume:** "dịch v3" / "dịch L1V6".
- **Vision phần còn lại của v1:** "vision v1 tiếp" (trang 400–623; 0–399 đã hội tụ, xem mục 4.1/4.2).
- **Bỏ vision cho nhẹ:** thêm "không cần review layout".

Quy trình chuẩn mỗi volume (để mỗi trang chỉ vision 1 lần):
**dịch → verify → apply → vision MẪU nhỏ (bắt lỗi hệ thống) → fix engine nếu cần → vision ĐẦY ĐỦ một lượt.**

## 4. Vòng lặp per-page: vision → fix đến khi hết DEFECT

Mỗi lỗi vision được phân loại `kind`:
- **`fit`** = chữ co nhỏ/nhồi sát cho vừa khung nhưng nội dung ĐỦ, đọc được → **chấp nhận, KHÔNG fix**. Vẫn lưu trong `review_issues.json` để có hồ sơ, nhưng `problems` bỏ qua.
- **`defect`** = lỗi thật (mất/cắt nội dung, đè không đọc được, công thức/bảng/highlight vỡ) → **cần fix**.

Vòng lặp (Claude lái, vì "fix" = sửa `pdf_core.py`), hội tụ khi `defect=0`:

```bash
cd python
python3 agent_pipeline.py review-summary work/v1     # defect? fit? accepted? -> ĐÃ HỘI TỤ chưa
python3 agent_pipeline.py problems     work/v1        # JSON các trang còn DEFECT (kind defect, chưa accept)
# ... (Claude) fix engine pdf_core.py cho các defect ...
python3 agent_pipeline.py apply <pdf> work/v1 <out>  # áp lại
python3 agent_pipeline.py revision work/v1 problems  # đánh dấu re-vision đúng trang defect (hoặc "17,18")
# ... nhắn Claude "vision lại v1" (only:vision) -> render lại + review lại đúng trang đó
# lặp tới khi review-summary báo defect=0
```

**Lỗi không-fix mà agent vẫn báo defect** (đánh giá sai) → ép chấp nhận:
```bash
python3 agent_pipeline.py accept work/v1 "35,52" "co chữ, đọc được"   # -> accepted.json, problems bỏ qua
```
`accepted.json` + `kind:"fit"` là 2 cơ chế "lưu lại để biết không cần fix".

## 4.1. ✅ XONG: vòng fix L1V1 trang 0–199 (defect=0, ĐÃ HỘI TỤ)

**Kết quả:** trang 0–199 `review-summary` báo **defect=0, fit=58, accepted=26 → HỘI TỤ ✓**.
PDF đích đã bake đủ **engine fix #8** (`applied=5939 missing=2`).

**Đã làm:**
- **Engine fix #8** trong `pdf_core.py` → `_is_formula_like` (xem mục 6). Validate trang
  0–400: **0 prose bị bỏ dịch, 0 regression**.
- Apply + re-vision 2 vòng → defect công thức **62/40 trang → 0**. Các trang công thức
  sạch hẳn: 110,114,115,118,141,145,150,152,155,161,162,163,165,195 …
- 26 trang còn lỗi đã `accept` (won't-fix) theo 5 nhóm đánh đổi nền tảng — xem `accepted.json`:
  - **Công thức nhúng trong prose / glyph X̄,R̄→'_'** (font thiếu combining macron): 20,116,117,119,127,147,151,153,164,173.
  - **Đè dòng do VN dài ~30%** (nội dung ĐỦ, option A/B/C đều được trích+dịch, chỉ chen/đè): 126,157,171,190,196,199.
  - **Bảng Exhibit / ma trận hiệp phương sai** (nhãn VN rộng đè cột số): 124,133,166.
  - **Legend/nhãn trục đồ thị vector** dịch bị đè: 125,134,187.
  - **Highlight vàng mất/thừa** (apply xoá annotation, fix #5): 106,167,188,189.

> Lưu ý: cache `text2vi.json` KHÔNG đổi — fix #8 chỉ đổi việc CÓ trích đoạn để dịch hay không, re-apply rẻ (0 token).
> Fix #8 lợi cho **cả 10 volume** → khi rảnh chạy `apply-all volumes.json` để propagate.

## 4.2. ✅ XONG: vòng fix L1V1 trang 200–399 (defect=0, ĐÃ HỘI TỤ)

**Kết quả:** trang 200–399 `review-summary` báo **defect=0, fit=103, accepted=66 → HỘI TỤ ✓**
(gộp với 0–199: cả 400 trang đầu của L1V1 đã hội tụ).

**Phát hiện quan trọng đầu phiên:** vòng vision đầu tiên cho 200–400 báo 217 defect, nhưng
**phần lớn là ảo** — `vis-pages` chỉ render ảnh ghép khi PNG **chưa tồn tại**, không kiểm tra
PNG có **cũ hơn PDF đích** hay không, nên agent đã chấm trên ảnh **từ TRƯỚC khi fix #8 apply**
(2026-06-24, trong khi PDF đã ghi lại 2026-06-29). Đã sửa `cmd_vis_pages` trong
`agent_pipeline.py`: nếu PNG cũ hơn PDF đích → render lại **và xoá `vis/page_XXX.json` cũ**
(verdict đó chấm trên ảnh sai) để trang tự vào lại hàng chờ review. Áp dụng cho mọi volume
từ nay, tránh lặp lại lỗi này.

**Engine fix #9, #10, #11** (mục 6) — 3 vòng fix→revision→vision liên tiếp, defect giảm dần
**217 → 150 → 133 → 122** rồi bulk-accept phần còn lại (tăng trưởng chậm dần, đúng nghĩa hội tụ):
- **#9** Bảng thủ tục "Step N | nội dung | dữ liệu" (Exhibit Step 1–6 rất phổ biến ở chương
  Hypothesis Testing/Regression) bị dịch gộp phẳng, mất cột + mất đậm nhãn "Step N" → dựng lại
  đúng cột, giữ nhãn nguyên (tiếng Anh, đúng quy ước heading-in-đậm-giữ-nguyên), dịch riêng
  từng cột nội dung.
- **#10** Bug gốc trong `_extract_bulleted` (đường xử lý trang có bullet): dòng văn xuôi KHÔNG
  bullet đứng một mình (vd đoạn INTRODUCTION ngay sau khối LEARNING OUTCOMES) không được gán
  làm `cur` nên MỌI dòng tiếp theo của đoạn cũng rơi vào nhánh "đứng một mình" → cả đoạn bị xé
  thành 1 segment/dòng, mỗi dòng tự co cỡ chữ riêng theo khung 1-dòng chật → cỡ chữ nhảy lung
  tung + đè dòng kế trong CÙNG một đoạn. Đây là nhóm lỗi **phổ biến nhất** khi review layout
  (bất kỳ trang nào có LEARNING OUTCOMES + đoạn giới thiệu ngay sau, tức phần lớn trang mở đầu
  Learning Module). Fix: dòng đứng một mình cũng mở `cur` để các dòng sau nối đúng vào nó.
- **#11** Fix #10 làm lộ 1 lỗi khác: `_extract_bulleted` gộp phẳng MỌI dòng trên trang theo
  (y, x), mất ranh giới BLOCK gốc, nên 2 mục/hàng liền kề KHÔNG có bullet (vd 2–3 dòng LOS
  trong bảng LEARNING OUTCOMES không có glyph "□"/"■") bị merge nhầm thành 1 đoạn nếu đứng đủ
  gần nhau theo chiều dọc. Fix: dòng không-bullet chỉ nối tiếp vào 1 mục không-bullet nếu
  **cùng block PyMuPDF gốc**.
- `_label_row_columns`/`_extract_label_row` (#9) còn 1 lớp phòng vệ nữa cho hàng Step bị
  PyMuPDF gộp NHIỀU Step vào 1 block (vd Step 1+2 chung 1 block do công thức dòng cao đẩy y0
  chồng lấn): dùng dung sai theo Y thay vì cắt cứng theo index để gán đúng dòng công thức về
  hàng của nó.

**66 trang còn lại đã `accept`** (won't-fix) theo 5 nhóm — đúng những đánh đổi ĐÃ THỐNG NHẤT ở
mục 4.1, chỉ khác là **dày đặc hơn hẳn** vì 200–399 là chương Quant/Thống kê (Sampling,
Hypothesis Testing, Regression) — công thức dày đặc hơn nhiều so với 0–199:
- **Công thức nhúng trong prose vỡ do sub/superscript PyMuPDF cắt rời** (X̄/σ/√/phân số/θ̂):
  37 trang — 203,204,213–219,228,232,252,253,275,278–281,288,291,295,297,300,305–307,309,311,
  327–329,332,333,335,363,378,392.
- **Bảng/Exhibit 3+ cột KHÔNG có nhãn đậm đầu cột** (khác mẫu "Step N" mà fix #9 xử lý được):
  11 trang — 243,244,255,256,299,301,324,372,375,376,382.
- **Highlight vàng mất/lệch** (fix #5 xoá annotation gốc): 5 trang — 229,245,321,322,330.
- **Mất định dạng list** (in đậm A/B/C, số thứ tự, bullet, hanging indent — hạn chế thiết kế
  redact-vẽ-lại 1 style/segment): 9 trang — 230,284,338,340,347,384,388,394,398.
- **Tràn nhẹ / khoanh đỏ lệch vị trí do VN dài hơn ~30%**: 4 trang — 241,323,336,348.

## 4.3. ✅ XONG: vòng fix L1V1 trang 400–623 (defect 188 → 69 → 0-thực-tế, đã re-vision xong 2026-07-06)

**Trạng thái cuối (2026-07-06):** đã revision + vision lại đúng 224 trang defect còn lại (188→150→
133→122→69), rồi `merge-vis` phát hiện review_issues.json đang STALE (chưa refresh sau vision cuối) —
chạy lại `merge-vis` cho ra defect=69 chính xác. Ngay sau đó phát hiện **fix #15** (mục 6) mở khoá
thêm rất nhiều nội dung mới trên CẢ 624 trang (không riêng 400–623) nên vòng fix này coi như đã xong,
gộp tiếp vào vòng fix #15 ở mục 4.4 bên dưới (đo defect lại trên TOÀN BỘ 0–623).

**Lịch sử lượt fix #12/#13 (2026-07-03):**
- Vision đủ 400–623 lần đầu → **188 defect**. Phần lớn thuộc 2 nhóm: `bold_bullet_list` (~110/188,
  chủ yếu là 1 pattern LẶP LẠI RẤT NHIỀU: nhãn `Solution:` in đậm bị dính vào cuối dòng đáp án C
  ngay trên nó, mất xuống dòng + mất đậm) và `table_col`/`font_size` (~74/188, khớp các nhóm đã
  chấp nhận ở mục 4.1/4.2: bảng nhiều cột không nhãn đậm, sơ đồ/chart nhãn đè, VN dài hơn).
- **Engine fix #12**: `_extract_blocky` chỉ xét span CHIẾM ĐA SỐ ký tự của CẢ block để quyết
  định block có phải heading không — nên khi 1 block gộp cả đáp án dài (đa số) + 1 dòng nhãn đậm
  ngắn ở cuối (vd `Solution:` ngay sau đáp án C, PyMuPDF gộp chung 1 block) → cả block bị dịch
  gộp phẳng, nhãn đậm bị nuốt vào giữa câu. Fix: `_heading_split_runs` tách dòng heading-like
  (dùng lại `_line_is_heading`) ra khỏi phần văn xuôi/đáp án bao quanh TRONG CÙNG 1 block, dịch
  riêng từng đoạn liên tục, giữ nguyên dòng heading.
- **Engine fix #13**: fix #12 (và tương tự cho `_extract_bulleted` vốn đã có logic loại dòng
  heading từ trước) làm lộ 1 lỗi tinh vi hơn: bbox của 2 "line"/span LIỀN KỀ trong PDF nguồn
  thường CHỒNG LẤN nhẹ theo chiều dọc (ascender/descender font) — nên dù đã loại đúng dòng
  heading khỏi bản dịch, REDACT (xoá chữ gốc) theo bbox thô của dòng/span NGAY TRƯỚC heading vẫn
  ăn lẹm vào phần TRÊN của heading, xoá mất 1 phần chữ của nó (`Solution:` → chỉ còn `Sol`/`So`).
  Fix: kẹp `redact` (không chỉ `box` vẽ) theo trần = mép trên dòng heading kế tiếp, cả ở
  `_extract_blocky` (qua `next_heading` trả về từ `_heading_split_runs`) lẫn `_extract_bulleted`
  (thêm `next_heading` vào `close()`, vì dòng heading bị loại hẳn khỏi `items` nên `next_top`
  cũ "nhảy cóc" qua nó, không thấy ranh giới thật).
- Đã `chunk --force` sau fix #12: **140 đoạn mới** (đoạn trước đây bị gộp vào nhãn heading, chưa
  từng dịch riêng) → dịch qua Workflow → `merge-tr` → `apply` (áp dụng=4304 missing=0). Fix #13
  KHÔNG lộ đoạn mới (`chunk --force` → todo=0, chỉ đổi hình học redact) → chỉ cần `apply` lại,
  không cần dịch thêm.
- Validate trực quan (zoom ảnh) xác nhận cả 2 fix hoạt động đúng trên trang mẫu (233, 415, 491, 573).
  Full-corpus regression scan (0 box âm/quá khổ) qua cả 3 fix trong lượt này — không phát hiện
  tác dụng phụ.

**Kết quả cuối vòng này (trước khi gộp sang fix #15):** revision+vision lặp lại tới defect=69
(400–623), sau đó phát hiện fix #15 (mục 4.4) nên dừng bulk-accept ở đây để làm fix #15 trước
(fix #15 mở khoá thêm nội dung MỚI trên chính các trang này, bulk-accept sớm sẽ phải làm lại).

> Engine fix #9/#10/#11 làm lộ THÊM đoạn/segment trước đây bị gộp sai (chưa từng dịch riêng) —
> khác fix #8 (chỉ ẩn/hiện lại đoạn ĐÃ dịch). Sau force-rechunk phải **dịch bù phần mới** rồi mới
> apply được (đã làm cho v1: +52, +6, +155 segment mới qua 3 vòng). Khi propagate fix này sang
> 9 volume còn lại (`apply-all`), PHẢI backup `chunks/`+`out/` cũ, force-rechunk, dịch phần
> `todo` mới rồi mới `apply` — không phải chạy `apply-all` free như fix #8 (xem cảnh báo mục 6).

> **Giới hạn còn lại (cần hướng khác nếu muốn 0 lỗi thật):** glyph X̄/R̄ cần font có combining
> macron hoặc vẽ công thức dạng ẢNH; đè dòng VN-dài cần cho phép cỡ chữ <6.5pt hoặc reflow khung;
> bảng 3+ cột không nhãn đậm cần 1 detector tổng quát hơn (rủi ro false-positive cao hơn, chưa làm).
> Cả ba ngoài phạm vi "dịch giữ layout" hiện tại → đang chấp nhận như đánh đổi.

## 4.4. 🚧 ĐANG DỞ: fix #15 (trang blocky không-bullet mất/nuốt nhãn đáp án A/B/C) + sự cố dịch lệch id (2026-07-06)

**Phát hiện:** trang Question Set KHÔNG có bullet glyph nào khác trên trang (vd trắc nghiệm ngay
sau đoạn văn xuôi) đi qua `_extract_blocky`, đường này KHÔNG có cơ chế giữ đậm nhãn `A./B./C.`
tương đương `_label_span_idx` mà `_extract_bulleted` đã có (fix #14). Hệ quả kép, xác nhận bằng
`extract_segments` trực tiếp (không suy đoán):
- Đáp án NGẮN đứng riêng 1 block bị `_is_prose_block` loại vì `< 5 từ` (vd `'A.\t Only Statement
  1 is true.'` chỉ có 4 "từ" tiếng Anh) → **cả block bị bỏ qua, KHÔNG dịch** (đáp án A/B ở trang
  418 vẫn nguyên tiếng Anh dù C ngay dưới đã dịch).
- Đáp án bị PyMuPDF gộp CHUNG block với dòng heading kế (`Solution:`) thì có dịch nhưng dịch PHẲNG
  cả dòng (nhãn `C.` gộp vào bản dịch) → **mất đậm nhãn**.

**Engine fix #15**: thêm `_extract_labeled_lines()` (dùng lại `_label_span_idx`) vào `_extract_blocky`
— trước khi xét `_is_prose_block`, nếu block có ít nhất 1 dòng dạng nhãn-đậm+nội-dung thì xử lý
riêng: dịch CHỈ phần nội dung (giữ nguyên glyph nhãn, không redact), dòng văn xuôi đứng một mình
sau 1 heading (vd đoạn giải thích ngay dưới `Solution:`) mở item MỚI thay vì bị bỏ rơi, và trần
`redact` kẹp theo mép trên heading kế tiếp (tái dùng đúng bài học fix #13). Validate bằng cách so
sánh `extract_segments` TRƯỚC/SAU trên toàn bộ v1 (không chỉ đọc code): **+608 đoạn mới hợp lệ**,
**0 mất nội dung** (so khớp normalize bỏ nhãn/hyphen — ban đầu có 2 "mất" hoá ra là bug thứ 2 trong
state machine, đã sửa), **0 box/redact lỗi mới phát sinh** (bad-box baseline=150 giữ nguyên, đều là
lỗi glyph macron đã biết từ trước, không liên quan fix #15).

**Sự cố dịch lệch id (phát hiện SAU khi apply, qua vision — không phải lỗi `pdf_core.py`):** sau
`chunk --force` + dịch batch 31 chunk mới, 2 chunk ĐẦU TIÊN (`c_000`, `c_001` = 80 đoạn) bị agent
dịch **lệch hoàn toàn** — vì 2 chunk này gom toàn đoạn NGẮN/phi ngữ cảnh (đáp án số liệu `"X
percent."`, nhãn đơn `"ETF 1"`, `"Maturity"`...) rải rác từ nhiều chương KHÁC NHAU, agent dịch đã
"tự chế" nội dung không khớp `id` (vd `"2.97 percent."` bị ghi thành `"Các bước kiểm định giả
thuyết..."` — nội dung của một câu hỏi thống kê hoàn toàn khác). Phát hiện bằng cách đối chiếu số
trong `en` vs `vi` cho mọi chunk mới: **chỉ 2/31 chunk bị** (0 chunk khác có sai số liệu). Đã sửa:
tự dịch lại thủ công 80 đoạn này (numeric `"X percent."` → `"X phần trăm."` theo đúng quy ước đã
có trong cache; phần còn lại dịch tay, verify khớp từng `id`), ghi đè `out/c_000.json`+`c_001.json`,
`merge-tr` lại, `apply` lại (`applied=4926 missing=0`). Validate trực quan lại đúng 2 trang gốc phát
hiện lỗi (29, 418) — khớp hoàn toàn.

**Bài học quy trình (áp dụng khi propagate fix #15 sang 9 volume còn lại):** chunk đầu tiên sau
`chunk --force` có thể gom nhiều đoạn ngắn/phi-ngữ-cảnh liền nhau (numeric-only, nhãn 1–3 từ) từ
CÁC CHƯƠNG KHÁC NHAU — rủi ro agent dịch lệch id cao hơn hẳn chunk thường. **Sau mỗi lần dịch batch
mới, PHẢI chạy kiểm tra số liệu (digit-match en vs vi cho mọi item có chữ số) trước khi tin
`merge-tr`** — không chỉ dựa vào agent tự báo cáo xong. Script kiểm tra nhanh (đối chiếu `chunks/`
vs `out/`):
```python
import json, glob, re
digit_re = re.compile(r'\d+')
for f in sorted(glob.glob('work/<vol>/chunks/c_*.json')):
    idx = f.split('_')[1].split('.')[0]
    out = json.load(open(f'work/<vol>/out/c_{idx}.json'))
    bad = [it['id'] for it in json.load(open(f))
           if set(digit_re.findall(it['text'])) and
           not (set(digit_re.findall(it['text'])) & set(digit_re.findall(out.get(it['id'], ''))))]
    if bad: print(idx, bad)
```

**Đã xử lý sau khi sửa (targeted, KHÔNG vision lại cả 624 trang):** xác định đúng 16 trang chứa 80
đoạn hỏng (qua `layout.json`), `touch` mtime mọi `review/pair_*.png` khác lên hiện tại (tránh
`vis-pages` invalidate nhầm ~600 trang đã review đúng), xoá riêng `pair_*.png`+`vis/page_*.json`
của 16 trang đó → `vis-pages` chỉ render lại + đưa vào hàng chờ ĐÚNG 16 trang → vision lại → `merge-vis`.
**Kết quả: defect 198 → 169** (trên TOÀN BỘ 0–623, không chỉ 400–623, vì fix #15 mở khoá nội dung
mới ở khắp cuốn sách).

**Phân loại 169 defect còn lại (đọc mẫu `review_issues.json`, chưa bulk-accept):**
- Phần lớn khớp ĐÚNG 4 nhóm đánh đổi đã thống nhất ở mục 4.1/4.2 (chỉ xuất hiện NHIỀU HƠN vì fix
  #15 mở khoá thêm nội dung để review): **highlight vàng mất** khi redact (fix #5, rất phổ biến:
  18,19,21,25,27,63,65,66,75,77,92,107,138,170,185,186,200,325…), **công thức/subscript vỡ** (glyph
  X̄/R̄/σ²/mũ — 21,28,42,87,90,97,104,148,163,193,220,236,237,239,293,294…), **bảng mất cấu trúc cột
  không nhãn đậm** (31,32,38,42,53,152…), **cỡ chữ đáp án A/B/C lệch nhau** do VN dài hơn
  (43,103,109,135,138,212…).
- **2 pattern CHƯA rõ, cần điều tra thêm trước khi bulk-accept hay fix engine #16:**
  1. **Bullet glyph (■/●) đè lên chữ cái đầu dòng nội dung** — lặp lại ở ít nhất 7 trang
     (88,90,107,132,152,163,165). Chưa xác định nguyên nhân gốc (có thể liên quan cách tính
     `bullet_x`/`left` khi văn bản VN thụt lề khác bản gốc).
  2. **Cụm chữ ĐẬM nằm GIỮA câu (inline, không phải dòng riêng) bị `_line_is_heading` nhận nhầm
     thành heading** khi PyMuPDF ngắt dòng khiến cụm đó chiếm trọn 1 "line" → bị loại khỏi bản dịch
     (giữ nguyên tiếng Anh) + từ liền trước bị cắt cụt do redact ăn lẹm. Ví dụ RÕ, đã validate bằng
     ảnh gốc/dịch: **trang 235** — `"...we believe are dependent, we use the **test of the mean of
     the differences** (a paired comparisons test)."` → bản dịch chỉ còn `"...mà chúng ta tin là\ndep
     **test of the mean of the differences**"` (mất `-endent`, cụm đậm không dịch). Đây là lỗi
     **CÓ TRƯỚC fix #15** (đường `_extract_blocky` gốc, không phải do thay đổi hôm nay), mức độ
     lặp lại trên toàn bộ 10 volume CHƯA khảo sát.

**LÀM TIẾP:**
1. Điều tra 2 pattern trên (đặc biệt #2 — mất nội dung thật, ưu tiên cao hơn #1) → nếu xác nhận hệ
   thống, làm fix #16 theo đúng quy trình mục 6 (validate extract_segments trước/sau, chunk --force,
   dịch bù, apply, revision đúng trang, vision lại).
2. Với phần còn lại KHỚP 4 nhóm đánh đổi đã thống nhất → `accept` theo đúng nhóm (xem cú pháp mục 4).
3. Lặp review-summary → problems tới khi defect chỉ còn 2 pattern mới (hoặc 0 nếu đã fix #16), cập
   nhật mục này thành ✅ XONG, gộp trạng thái L1V1 thành "0–623 ĐÃ HỘI TỤ".
4. Khi rảnh, propagate fix #15 (+ #16 nếu có) sang 9 volume còn lại theo đúng quy trình NGOẠI LỆ ở
   mục 6 (backup → chunk --force → dịch bù todo mới, **kèm kiểm tra digit-match trước khi merge-tr**
   → apply). Ưu tiên các volume nhiều Question Set (V2–V6) vì đây là nơi fix #15 có tác dụng nhất.

## 5. XUẤT CẢ BỘ (bản cuối)

Không có bước export riêng — thư mục đích **là** cả bộ. Sau khi sửa engine, đồng bộ mọi PDF về engine mới (rẻ, 0 token):

```bash
cd python && python3 agent_pipeline.py apply-all volumes.json
```

`apply-all` tự **merge** out/ + vout/ vào cache trước khi áp, nên phản ánh cả phần dịch dở.
Volume chưa dịch xong → PDF có phần tiếng Anh chưa dịch (`missing` > 0) là bình thường.

Cả bộ coi như **xong** khi `batch-status` báo mọi volume `done` (vision đủ 100%) và `apply-all` đã chạy lần cuối.

## 6. Engine đã fix (`pdf_core.py`, lợi cho cả 10 volume)

1. Header copyright nhân đôi → vẽ lại 1 bản sạch (`_header_dups`).
2. Bản dịch đè dòng prose kế → kẹp đáy box (`_extract_blocky`).
3. Bản dịch đè công thức/ảnh → kẹp đáy theo mọi phần tử.
4. Dòng công thức bị dịch (vỡ phân số) → `_is_formula_like` (blocky + bulleted).
5. Highlight annotation lệch → xoá markup annot khi `apply`.
6. TOC gộp dòng → `_is_toc_block` (cột số căn phải, FP-safe).
7. Trang bản quyền/ISBN reflow vỡ → `_COPYRIGHT_RE` bắt thêm `©20xx`/`All rights reserved`/`ISBN`, giữ nguyên tiếng Anh.
8. **Công thức bị dịch vỡ (trang quant/thống kê dày công thức)** → `_is_formula_like` thêm 2 đường (ngoài 2 đường cũ): (a) dòng **neo bởi `=` hoặc ký hiệu toán mạnh** (`∑∫√≤≥≠≈×÷⁄σ…`) + nhiều ký hiệu + **≤2 từ ngôn ngữ tự nhiên (≥4 chữ)** → bắt `P(...|...)`, `Cov(...)`, `σ²(...)`, Bayes; (b) **MẢNH NỐI** công thức nhiều dòng PyMuPDF cắt rời vì sub/superscript: **0 từ tự nhiên** + ≥3 ký hiệu toán + ≤3 token → giữ nguyên. Đã validate trang 0–400: 0 prose bị bỏ dịch, 0 regression.
9. **Bảng thủ tục "Step N | nội dung | dữ liệu" bị dịch gộp phẳng, mất cột + mất đậm nhãn** (rất phổ biến ở Hypothesis Testing/Regression: Exhibit Step 1–6) → `_label_rows`/`_row_columns`/`_extract_label_row`: nhận diện HÀNG có nhãn đậm-ngắn (`_is_short_bold`) nằm sát mép trái block + các "line" còn lại lệch phải xa (cột khác) → giữ NGUYÊN cột nhãn (đúng quy ước heading-in-đậm-giữ-nguyên), dịch RIÊNG từng cột nội dung với khung/kẹp-đáy riêng (không đè cột kế/hàng kế). Xử lý cả trường hợp PyMuPDF gộp NHIỀU hàng Step vào 1 block (gán dòng theo dung sai Y thay vì cắt cứng index, vì công thức cao có thể có y0 cao hơn nhãn CÙNG hàng). Cũng thêm `_is_code_font` (CourierStd) để không dịch code Excel/R/Python bị cuốn vào 1 "cột".
10. **Đoạn văn xuôi trên trang có bullet bị xé thành 1 segment/DÒNG** (bug trong `_extract_bulleted`: dòng đứng-một-mình không được gán làm `cur` nên dòng tiếp theo cũng rơi vào nhánh đó) → mỗi dòng tự co cỡ chữ theo khung 1-dòng chật riêng → **cỡ chữ nhảy lung tung + đè dòng kế trong CÙNG 1 đoạn** (lỗi phổ biến nhất khi review layout, vì hầu hết trang mở đầu Learning Module đều có đoạn INTRODUCTION ngay sau khối LEARNING OUTCOMES bullet). Fix: dòng đứng-một-mình cũng mở `cur` để dòng sau nối đúng.
11. **Fix #10 làm lộ over-merge**: `_extract_bulleted` gộp phẳng mọi dòng theo (y,x), mất ranh giới block gốc, nên 2 mục/hàng liền kề KHÔNG-bullet (vd 2–3 LOS trong bảng LEARNING OUTCOMES không có glyph bullet) bị merge nhầm nếu đứng đủ gần theo chiều dọc → `_collect_lines` gắn thêm `blk` (chỉ số block gốc); continuation của mục KHÔNG-bullet chỉ hợp lệ nếu **cùng block PyMuPDF gốc** (mục có bullet không đổi hành vi).
12. **`_extract_blocky` nuốt nhãn đậm ngắn kẹt trong block chủ yếu là văn xuôi/đáp án** (rất phổ biến: nhãn `Solution:` đứng riêng dòng ngay sau đáp án C, PyMuPDF gộp chung 1 block với đáp án) → block-level chỉ xét span CHIẾM ĐA SỐ ký tự nên bỏ sót nhãn thiểu số → dịch gộp phẳng, nhãn đậm bị dính vào cuối câu trước. `_heading_split_runs` tách các dòng heading-like (`_line_is_heading`) ra khỏi các run văn xuôi liên tục trong CÙNG 1 block, dịch riêng từng run, giữ NGUYÊN dòng heading (đúng quy ước nhãn đậm giữ nguyên).
13. **Redact bbox thô của dòng/span liền kề đè lên phần TRÊN của nhãn heading kế** (do bbox 2 dòng cạnh nhau trong PDF nguồn thường chồng lấn nhẹ vì ascender/descender font) → dù fix #12 đã loại đúng dòng heading khỏi bản dịch, XOÁ (redact) theo bbox thô của dòng ngay trước nó vẫn ăn lẹm phần đầu glyph của heading (`Solution:` → chỉ còn `Sol`/`So`). Kẹp `redact` (không chỉ khung vẽ) theo trần = mép trên dòng heading kế tiếp, ở cả `_extract_blocky` (`next_heading` từ `_heading_split_runs`) và `_extract_bulleted` (`next_heading` gắn vào `close()`, vì dòng heading bị loại hẳn khỏi `items` nên phép tính `next_top` cũ nhảy cóc qua nó).
14. **`_extract_bulleted` gộp phẳng nhãn đậm ngắn `A./B./C.` đứng ĐẦU DÒNG cùng "line" với nội dung không đậm** (đáp án trắc nghiệm, khi trang CÓ bullet glyph ở chỗ khác nên đi qua đường bulleted) → mất đậm nhãn. `_label_span_idx`: nhận diện span đầu dòng khớp `_LABEL_RE` + đậm, phần còn lại KHÔNG đậm và đủ dài (≥3 ký tự) → coi như "bullet" (giữ nguyên, không redact/dịch), chỉ dịch phần nội dung — dùng ở `_extract_bulleted` giống hệt cơ chế bullet glyph (mục 6 nhóm rule cũ).
15. **Trang KHÔNG có bullet glyph nào khác (đi qua `_extract_blocky`) mất/nuốt nhãn đáp án `A./B./C.`** vì đường này chưa có cơ chế tương đương fix #14: (a) đáp án ngắn (<5 "từ" tiếng Anh) đứng riêng 1 block bị `_is_prose_block` loại thẳng → KHÔNG dịch; (b) đáp án bị PyMuPDF gộp chung block với heading kế (`Solution:`) thì dịch phẳng cả dòng → mất đậm nhãn. `_extract_labeled_lines()` (dùng lại `_label_span_idx`): xét TRƯỚC `_is_prose_block`, nếu block có dòng nhãn-đậm+nội-dung thì dịch riêng từng nội dung (giữ nhãn), dòng văn xuôi đứng một mình sau heading mở item mới (không bị bỏ rơi), trần redact kẹp theo heading kế (tái dùng bài học fix #13). Xem chi tiết + sự cố dịch lệch id liên quan ở mục 4.4.

> Sau MỖI lần sửa engine: chạy `apply-all volumes.json` để bake vào tất cả PDF (nên gom nhiều fix rồi apply-all 1 lần).
> **NGOẠI LỆ — fix #9/#10/#11/#12/#15:** khác các fix khác (chỉ ẩn/hiện lại đoạn ĐÃ có trong cache
> `text2vi.json`, hoặc chỉ đổi hình học redact như fix #13), 5 fix này làm `extract_segments` trả
> về đoạn MỚI (trước đây bị gộp sai vào 1 đoạn khác hoặc bị loại hẳn nên chưa từng có key riêng
> trong cache) → `apply-all` sẽ để LẠI các đoạn mới này `missing` (tiếng Anh) nếu không dịch bù
> trước. Quy trình đúng cho MỖI volume trước khi apply: `chunk --force` (nhớ backup `chunks/`+`out/`
> cũ trước, vì force xoá `chunks/`) → dịch phần `todo` mới (Workflow `vision:false` hoặc tự dịch
> nếu ít) → **kiểm tra digit-match en/vi cho chunk ĐẦU TIÊN** (rủi ro dịch lệch id cao nhất — xem
> sự cố mục 4.4) → `merge-tr` → `apply`. Đã làm cho v1 (+52, +6, +155, +140, +1222 đoạn mới qua
> 5 vòng).

**Còn lại không fix** (đã thống nhất): đánh đổi nền tảng "tiếng Việt dài hơn ~30% → co chữ/nhồi sát" (low/medium); công thức nhúng trong prose vỡ do sub/superscript (glyph X̄/R̄ cần font combining macron hoặc vẽ ảnh); bảng 3+ cột KHÔNG nhãn đậm đầu cột (khác mẫu Step N mà fix #9 xử lý được — cần detector tổng quát hơn, rủi ro false-positive cao hơn, chưa làm); highlight vàng mất khi redact (fix #5 đã chấp nhận, xem mục 4.4). `missing=0` ở v1 sau fix #15 (trước đó `missing=2` = 2 câu tách ngang ngắt cột, đã hết vì extraction bao trọn). Còn 2 pattern CHƯA điều tra xong ở mục 4.4 (bullet đè chữ, cụm đậm giữa câu bị nhận nhầm heading).

## 7. Nơi xem kết quả (ví dụ v1)

- PDF dịch: `2024 CFA L1 Curriculum - VI (agent)/2024 L1V1.pdf` (cả volume; đã apply fix #15, vision lại đủ 0–623, defect=169 đang phân loại — xem mục 4.4).
- Báo cáo lỗi layout: `tool/work/v1/review_issues.json`.
- Ảnh ghép gốc|dịch: `tool/work/v1/review/pair_XXX.png`.
- Checkpoint review từng trang: `tool/work/v1/vis/page_XXX.json`.

## 8. File quan trọng

- `python/pdf_core.py` — engine trích đoạn + ghi đè giữ layout (15 fix ở mục 6).
- `python/agent_pipeline.py` — glue: chunk/merge/apply/status/pending/vis/problems/revision/volumes/apply-all.
- `python/translate_volume.js` — Workflow 4 phase, resume + batch + `only:'vision'` + vision theo cửa sổ.
- `python/volumes.json` — manifest 10 tài liệu (pdf → workdir → out).
- `tool/work/<vol>/text2vi.json` — cache bản dịch (key theo TEXT, bền; sửa engine KHÔNG mất).
