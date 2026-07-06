# Màn hình Review Layout — `review_server.py`

Web bổ trợ cho `dashboard.py` để **xem trực quan kết quả dịch từng trang** (ảnh ghép
GỐC | DỊCH) và **xử lý lỗi layout** mà bước vision đã chấm. File độc lập, **không sửa**
`dashboard.py` — chạy song song.

## Chạy

```bash
cd /Users/khanhnm/Desktop/translate/tool
python3 review_server.py            # http://127.0.0.1:8760
python3 review_server.py --port 9100
```

Chỉ dùng thư viện chuẩn + `pymupdf`. Bind `127.0.0.1` (không mở ra mạng).

## Màn hình có gì

- **Chọn Volume** (trên đầu): mỗi volume kèm số `defect / fit / accepted` và số trang có ảnh.
- **Lưới trang** (trái): mỗi ô = 1 trang, tô màu theo mức lỗi:
  | Màu | Trạng thái | Ý nghĩa |
  |-----|-----------|---------|
  | 🔴 `defect` | có lỗi hiển thị thật | mất/cắt chữ, đè chồng, công thức/bảng vỡ — **cần fix** |
  | 🟡 `fit` | chỉ có lỗi "co chữ" | chữ Việt co/nhồi cho vừa khung nhưng **đọc được** (chấp nhận được) |
  | 🟣 `accepted` | đã đánh dấu won't-fix | loại khỏi danh sách cần fix |
  | 🟢 `ok` | đã review, sạch | vision đã chấm, không lỗi |
  | ⬜ `todo` | chưa review | chưa có `vis/page_XXX.json` |
- **Khung xem** (phải): bấm 1 ô để xem **ảnh ghép gốc|dịch** trang đó + danh sách lỗi vision
  (kind + severity + mô tả). Kèm 2 nút:
  - **↻ Đánh dấu dịch lại** (`revision`): xoá checkpoint `vis/` + `review/` của trang → lần
    chạy vision sau sẽ render lại (từ PDF đã fix) và review lại đúng trang đó.
  - **✓ Chấp nhận (won't-fix)** (`accept`): thêm trang vào `accepted.json` → vòng lặp fix hội tụ.

## Nguồn dữ liệu (trong mỗi `work/<tag>/`)

| File | Vai trò |
|------|---------|
| `review/pair_XXX.png` | ảnh ghép gốc\|dịch (do `agent_pipeline.py vis-pages`/`pairs` render) |
| `review_issues.json` | lỗi vision đã gộp (`merge-vis`) |
| `accepted.json` | danh sách trang won't-fix (nút Chấp nhận ghi vào đây) |

Server chỉ **đọc** ảnh/issue và **ghi** `accepted.json` (khi Chấp nhận) hoặc xoá checkpoint
trang (khi Dịch lại) — **không đụng** bản dịch (`text2vi.json`) hay PDF đích.

## Quan hệ với dashboard

`dashboard.py` (cổng 8756) lo **chạy pipeline + theo dõi tiến độ**; `review_server.py`
(cổng 8760) lo **soi lỗi layout + quyết định fix/accept**. Sau khi Chấp nhận/Dịch lại một
số trang, quay lại dashboard chạy lại stage **vision** cho volume đó để re-render + re-review
đúng các trang vừa đánh dấu.

> Ghi chú: đây là module tách riêng để không xung đột khi `dashboard.py` đang được chỉnh.
> Có thể gộp các endpoint review (`/api/volume`, `/api/pair`, `/api/accept`, `/api/revision`)
> vào `dashboard.py` sau khi bản đó ổn định.
