# input/ — thả tài liệu cần dịch vào đây

Bỏ **file PDF** (bất kỳ, không chỉ CFA) vào thư mục này. Dashboard/app sẽ **tự
phát hiện** mỗi PDF thành một mục để dịch.

- Bản dịch (giữ layout) xuất ra `../output/<tên>_vi.pdf`.
- File làm việc/cache/log để trong `../tool/work/user_<tên>/`.
- Trong app: mục hiện ở cuối danh sách với nhãn 📄; bấm **Chạy** (Claude) hoặc
  **▶ Term** (chạy ở Terminal; Codex hỗ trợ ô **Trang** để dịch 1 phần).

> PDF trong `input/`/`output/` KHÔNG được commit lên git (đã loại qua `.gitignore`).
> Chỉ file tài liệu cá nhân của bạn; không đưa nội dung có bản quyền lên GitHub.
