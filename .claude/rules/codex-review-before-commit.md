# Codex Review Before Commit

## Activation
- Always On

## Mục tiêu
Mỗi khi hoàn thành một task (đã viết xong code), bắt buộc để Codex review lại TRƯỚC KHI commit, nhằm bắt lỗi và phản biện thiết kế bằng một góc nhìn độc lập.

## Rules

### 1. Bắt buộc review trước commit
- Sau khi code xong và test/build pass, TRƯỚC KHI chạy `git commit`, phải chạy Codex review qua plugin codex:
  - `/codex:review` cho review thường (read-only) trên thay đổi chưa commit.
  - `/codex:adversarial-review` khi cần phản biện thiết kế/đánh đổi/giả định.
- Với thay đổi nhiều file, ưu tiên chạy `--background` rồi xem kết quả qua `/codex:status` và `/codex:result`.

### 2. Xử lý kết quả review
- Phải đọc toàn bộ phát hiện của Codex.
- Mỗi phát hiện hợp lệ phải được sửa trước khi commit; nếu không sửa, phải giải trình rõ lý do (đánh giá là không áp dụng / chấp nhận rủi ro) cho user.
- Không commit khi còn phát hiện nghiêm trọng (đúng và ảnh hưởng tính đúng đắn/bảo mật/mất dữ liệu) chưa được xử lý.

### 3. Phối hợp với quy trình
- Đây là một bước BỔ SUNG trong vòng lặp trước commit của [[documentation-maintenance]]: code xong → test/lint/build → cập nhật tài liệu → **Codex review** → commit.
- Nếu sau review phải sửa code, chạy lại test/build và (nếu cần) review lại phần sửa trước khi commit.

### 4. Khi không chạy được Codex
- Nếu Codex chưa cài/đăng nhập (cần `/codex:setup` hoặc `!codex login`) hoặc review thất bại, dừng lại và báo user; không tự ý bỏ qua bước review trừ khi user đồng ý rõ ràng.

## @ References
@.claude/rules/documentation-maintenance.md
