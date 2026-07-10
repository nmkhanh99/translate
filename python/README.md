# cfa-pdf-translator — Dịch PDF giữ nguyên layout (MCP)

> Engine Python của monorepo **CFA Translate Studio**. HTTP UI/agent spawn nằm ở
> `apps/daemon` (Node). App desktop: `pnpm desktop`. Xem root `README.md`.

Dịch PDF sang **bất kỳ ngôn ngữ nào** (mặc định tiếng Việt) mà **giữ nguyên cấu
trúc**: hình ảnh, đồ thị vector, công thức, bảng số, vị trí và cỡ trang đều
không bị đụng tới — **chỉ dịch phần văn xuôi**.

Theo **Model Context Protocol (MCP)** qua stdio nên dùng được với mọi MCP client:
Claude Code, Claude Desktop, Codex, Cursor, Grok...

## Cách hoạt động

Cơ chế: redact (xóa) chữ gốc của từng đoạn văn xuôi rồi vẽ lại bản dịch vào đúng
ô, tự co cỡ chữ và tràn vào khoảng trắng giữa các đoạn để không đè layout. Các
phần không phải văn xuôi (heading, công thức, số, bảng, đồ thị, hình) được **giữ
nguyên** — heuristic thích nghi theo cỡ chữ thân bài của từng trang (không
hard-code cho riêng bộ PDF nào).

Nhận diện THÍCH NGHI hai kiểu trang:
- **Trang văn xuôi** (sách volume): gom theo block đoạn văn.
- **Trang danh sách bullet** (vd *Topic Outlines*, các LOS có ô `□`): dựng lại
  từng mục bullet TỪ DÒNG, **giữ nguyên ký tự bullet** (chỉ redact phần chữ, không
  đụng glyph `□`), canh **lề treo** (hanging indent). Heading module và dòng
  "The candidate should be able to:" giữ nguyên tiếng Anh.

**Bảng số** (báo cáo tài chính...): tự nhận diện DÒNG BẢNG (ô số nằm theo cột,
kể cả khi mỗi số là 1 "line" riêng lệch phải) và **giữ nguyên cả dòng** — tránh
dịch nhãn rồi kéo các con số ra khỏi cột.

Có **2 luồng dịch**:

### A. Agent tự dịch (chất lượng cao, khuyến nghị) — qua MCP
1. `extract_segments(pdf_path, pages)` → trả về các đoạn `[{id, text}]` + tạo session.
2. **Agent (Claude/Codex...) tự dịch** các đoạn đó (giữ thuật ngữ, "VN (English term)").
3. `apply_translations(session_id, {id: bản_dịch}, out_pdf)` → xuất PDF giữ layout.

Không cần API key, không tốn phí (chính agent dịch trong hội thoại).

### B. Pipeline AGENT đầy đủ 1 volume, RESUME được — `translate_volume.js` (Workflow)

Luồng nặng nhất, chất lượng cao nhất: **translate → verify (đối chiếu số/bỏ sót vs
bản Anh) → apply (giữ layout) → vision review (so layout từng trang)**. ~5.5M
token/volume nên **dễ hết token giữa chừng** → toàn bộ được thiết kế **checkpoint
theo file để gọi lại là tự chạy tiếp**.

**Cơ chế resume (2 tầng):**
1. **Unit file (bền qua hết-token/đóng máy):** mỗi lô dịch là `out/c_XXX.json`, mỗi
   lô verify là `vout/v_XXX.json`, mỗi trang vision là `vis/page_XXX.json`. Stage
   chỉ làm unit nào **thiếu output** (lệnh `pending`). `text2vi.json` là cache key
   theo TEXT, bền khi đổi tool. `chunk`/`vchunk` **không xoá** output cũ (no-op nếu
   đã có; `--force` để tạo lại nhưng vẫn giữ `out/`).
2. **state.json + `resumeFromRunId`:** `status` quét dir → ghi `state.json`
   (`stage` + tiến độ từng phase). Trong cùng session, gọi lại Workflow với
   `resumeFromRunId` cho cache-hit tức thì các agent đã chạy.

**Manifest 10 volume** — `volumes.json` khai báo cả bộ (pdf → workdir → out → vision).
Quant prerequisite đánh `skip` (đã dịch qua agent pilot). Là nguồn cấu hình cho batch.

**Chạy 1 volume:**
```js
Workflow({ scriptPath: "/Users/khanhnm/Desktop/translate/python/translate_volume.js",
  args: { pdf: "<source.pdf>", workdir: "<repo>/tool/work/v3",
          out: "<đích.pdf>", tool: "/Users/khanhnm/Desktop/translate/python",
          vision: true } })   // vision:false để bỏ stage review ảnh
```

**Chạy cả 10 (batch, theo `volumes.json`):**
```js
Workflow({ scriptPath: "/Users/khanhnm/Desktop/translate/python/translate_volume.js",
  args: { tool: "/Users/khanhnm/Desktop/translate/python" } })   // không có pdf -> batch
```
Batch quét manifest, bỏ volume đã `done`, xử lý tuần tự từng volume (mỗi volume tự
resume mid-pipeline). Có **budget-guard**: token còn dưới ~200k thì dừng sạch trước
volume mới (`{processed, of}` cho biết làm tới đâu).

**Hết token → gọi lại y hệt** (cùng `scriptPath`+`args`): tự skip phần đã xong, đi
tiếp từ unit/volume dở. Cùng session thì thêm `resumeFromRunId: "<runId lần trước>"`.

**Lệnh kiểm tra/glue (chạy tay khi cần):**
```bash
python3 agent_pipeline.py batch-status volumes.json     # tổng quan tiến độ cả 10 volume
python3 agent_pipeline.py apply-all    volumes.json     # XUẤT CẢ BỘ: merge + apply lại mọi volume
python3 agent_pipeline.py volumes      volumes.json     # JSON các volume chưa done (cho batch)
python3 agent_pipeline.py status   <workdir>            # tiến độ 1 volume + ghi state.json
python3 agent_pipeline.py pending  <workdir> translate  # JSON các lô chưa dịch
python3 agent_pipeline.py vis-pages <pdf> <out> <workdir>  # render ảnh ghép thiếu + vis_todo
python3 agent_pipeline.py merge-vis <workdir>           # gộp issue trang -> review_issues.json
# --- vòng lặp review per-page (xem mục B ở trên) ---
python3 agent_pipeline.py review-summary <workdir>      # defect vs fit vs accepted -> hội tụ chưa
python3 agent_pipeline.py problems  <workdir> [high|medium|low]  # trang còn DEFECT (loại fit/accepted)
python3 agent_pipeline.py revision  <workdir> "17,20"|problems   # đánh dấu re-vision đúng trang
python3 agent_pipeline.py accept    <workdir> "35,52" "lý do"    # won't-fix -> accepted.json
```

### C. App desktop (Electron) — không còn `dashboard.py`

UI + spawn CLI nằm ở monorepo Node (open-design style):

```bash
# từ root repo
pnpm install && pnpm start    # Electron → daemon → apps/ui
```

- Daemon: `apps/daemon` (REST/SSE, agent adapters Claude/Codex/Grok)
- Engine PDF/MCP: thư mục `python/` này
- Workdir runtime: `../tool/work/` (giữ path cũ trong `volumes.json`)

## Cài đặt

```bash
pip3 install -r requirements.txt
```
Cần 1 font Unicode hỗ trợ tiếng Việt. Tool tự dò theo HĐH; có thể chỉ định:
```bash
export CFA_TRANSLATE_FONT="/đường/dẫn/tới/font.ttf"
```

## Đăng ký MCP server cho từng client

> `pages` dùng **chỉ số 0-based** (trang đầu PDF = 0). Số trang in trong sách
> thường lệch do phần đầu (bìa, mục lục). Dùng `list_pdf_info` để biết tổng số trang.

### Claude Code (CLI)
```bash
claude mcp add cfa-pdf-translator -- python3 /Users/khanhnm/Desktop/translate/python/server.py
```

### Claude Desktop — `claude_desktop_config.json`
```json
{
  "mcpServers": {
    "cfa-pdf-translator": {
      "command": "python3",
      "args": ["/Users/khanhnm/Desktop/translate/python/server.py"]
    }
  }
}
```

### Codex / client khác — `~/.codex/config.toml` (hoặc tương đương)
```toml
[mcp_servers.cfa-pdf-translator]
command = "python3"
args = ["/Users/khanhnm/Desktop/translate/python/server.py"]
```

Mọi client MCP đều khai báo cùng một kiểu: chạy `python3 server.py` qua stdio.

## Tools của MCP server

| Tool | Mô tả |
|------|------|
| `list_pdf_info(pdf_path)` | Số trang, kích thước trang. |
| `extract_segments(pdf_path, pages, max_segments=400)` | Trích đoạn văn xuôi + tạo session. |
| `apply_translations(session_id, translations, out_pdf)` | Ghi đè bản dịch, giữ layout. |
| `render_page(pdf_path, page, out_png, dpi=140)` | Xuất 1 trang ra PNG để đối chiếu. |

## File

| File | Vai trò |
|------|------|
| `pdf_core.py` | Lõi: trích đoạn văn xuôi (thích nghi) + ghi đè giữ layout. |
| `server.py` | MCP server (agent tự dịch qua MCP — Codex/Grok dùng path này). |
| `agent_pipeline.py` | Glue xác định cho pipeline AGENT 1 volume (chunk/merge/apply/status/pending/vis). |
| `translate_volume.js` | Workflow 4 phase resume được, chạy 1 volume hoặc batch cả manifest. |
| `volumes.json` | Manifest 10 tài liệu (pdf → workdir → out). |
| `requirements.txt` | Phụ thuộc. |
| *(app UI)* | `pnpm start` từ root — Electron + `apps/daemon` (thay dashboard.py cũ). |

## Xử lý lỗi layout đã biết (trong engine)
- **Header bản quyền nhân đôi:** nhiều trang nguồn in dòng `© CFA Institute. For
  candidate use only...` **2 lần chồng khít** (faux-bold). `apply_redactions` re-encode
  trang làm bản sao thứ 2 lệch → chữ garbled. `_header_dups` phát hiện token lặp, redact
  rồi vẽ lại **1 bản sạch** (chỉ đụng header thật sự bị lặp; header thường để nguyên).
- **Bản dịch đè dòng kế / công thức / ảnh:** nguồn để các block prose chồng y, hoặc
  đặt công thức/ảnh sát ngay đáy đoạn; `_bottom_limit` bỏ sót phần tử bắt đầu đúng tại
  đáy block nên box bị nới quá xuống, bản dịch (dài hơn) đè lên. `_extract_blocky` kẹp
  đáy mỗi box theo mép trên của BẤT KỲ phần tử nào (prose/công thức/ảnh) bắt đầu dưới
  mép-trên block và giao ngang → text dịch không tràn sang hàng/công thức kế.
- **Dòng công thức bị dịch (vỡ phân số/biến):** dòng ngắn dạng `V0= 0.75S0+p0`,
  `p0 = CNY42/...` (kể cả có ■) từng bị nhận là prose. `_is_formula_like` (high-precision:
  ngắn + mở đầu `biến=` nhiều ký hiệu, HOẶC gần như toàn số/ký hiệu) chặn ở cả đường
  blocky lẫn bulleted → giữ nguyên công thức. Đoạn dài lẫn công thức+prose vẫn dịch.
- **Highlight annotation lệch:** nguồn có Highlight (vàng); chữ Việt reflow làm rect cố
  định lệch, đè đoạn khác. `apply_translations` xoá annotation markup (Highlight/Underline/
  StrikeOut/Squiggly) trên trang được xử lý.
- **Mục lục (TOC) dịch gộp lệch dòng:** `_is_toc_block` nhận block có >=3 dòng số-trang
  đứng riêng CĂN PHẢI (cột số trang) → giữ nguyên. Ràng buộc hình học nên không nuốt
  prose/công thức (chỉ trúng contents page + bảng số, vốn đều phải giữ nguyên).
- **Trang bản quyền (copyright/ISBN) reflow vỡ dòng:** cả khối pháp lý (copyright +
  trademark + ISBN + ngày) là 1 block, dịch gộp làm mất dòng ISBN/ngày. `_COPYRIGHT_RE`
  mở rộng bắt `©20xx`/`All rights reserved`/`ISBN` → giữ nguyên tiếng Anh (đúng cho văn
  bản pháp lý). Chỉ trúng trang bản quyền, không đụng thân bài.

## Hạn chế đã biết
- **Tiếng Việt dài hơn tiếng Anh ~30%** mà ô giữ nguyên kích thước → chữ co nhỏ (tối
  thiểu 6.5pt), có thể nhồi sát/cắt ở đáy cột hoặc cỡ chữ không đồng đều giữa các đoạn.
  Đây là đánh đổi nền tảng của dịch-giữ-layout; đã giảm thiểu (kẹp đáy chống đè) nhưng
  không loại bỏ hoàn toàn.
- **Mục lục (CONTENTS):** tên mục + số trang ở cột riêng nên dịch gộp dễ lệch dòng. Chưa
  xử lý đặc biệt (thử auto-detect nhưng false-positive cao nên bỏ) → trang front-matter
  mục lục có thể hơi lệch; nội dung học không ảnh hưởng.
- Đoạn tiếng Việt dài hơn nhiều mà khoảng trắng dưới nó hẹp → chữ co nhỏ (tối thiểu 6.5pt).
- Văn xuôi có chữ in đậm xen giữa được dịch theo cả đoạn; heading/định nghĩa in đậm giữ nguyên tiếng Anh.
- Nội dung là ảnh scan (không có lớp text) sẽ không trích được — cần OCR trước (chưa hỗ trợ).
