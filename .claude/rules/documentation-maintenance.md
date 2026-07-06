# Documentation Maintenance

**Activation:** Always On

## Mục tiêu

Luôn duy trì tài liệu đồng bộ với code để một developer khác có thể clone repository, hiểu hệ thống, chạy ứng dụng và tiếp tục phát triển mà không phải dựa vào kiến thức ngầm.

Rule này áp dụng cho mọi task, mọi thay đổi code và mọi commit trong dự án **app học CFA**.

## Các tài liệu bắt buộc

Claude phải duy trì song song bốn file tài liệu sau tại thư mục gốc của repository:

### `DEVELOPMENT.md`

Tài liệu kỹ thuật dành cho developer. Nội dung phải phản ánh trạng thái thực tế của dự án và bao gồm, khi có:

- Kiến trúc hệ thống.
- Cấu trúc thư mục và trách nhiệm của các module chính.
- Công nghệ, framework, thư viện và phiên bản quan trọng.
- Yêu cầu môi trường và cách cài đặt.
- Cách chạy ứng dụng.
- Command cho test, lint, type-check, format và build.
- Quy ước code.
- Quy ước Git và commit.
- Mô hình dữ liệu (data model), schema nội dung (JSON bóc tách từ PDF), và chiến lược lưu trữ (IndexedDB cho tiến độ/ghi chú/SRS).
- Pipeline bóc tách nội dung từ PDF curriculum sang JSON.
- State management và các luồng xử lý chính.
- Các quyết định kỹ thuật quan trọng và lý do lựa chọn.
- Dependencies quan trọng và mục đích sử dụng.
- Yêu cầu và lưu ý về bảo mật.
- Các hạn chế kỹ thuật đã biết.

Mọi thay đổi liên quan đến kiến trúc, mô hình dữ liệu, pipeline nội dung, state management, cấu trúc thư mục, command, script hoặc dependency đều phải được cập nhật vào `DEVELOPMENT.md`.

### `USER_GUIDE.md`

Hướng dẫn dành cho người dùng cuối (người học CFA). Nội dung phải phản ánh hành vi thực tế của ứng dụng và bao gồm, khi có:

- Mục đích và phạm vi của ứng dụng.
- Cách chọn topic / Learning Module để học.
- Cách đọc bài học, theo dõi và đánh dấu (tick) các LOS đã học.
- Cách ghi chú cá nhân cho từng bài.
- Cách làm quiz / practice, xem chấm điểm và lời giải.
- Cách ôn flashcard với spaced repetition (SRS).
- Cách dùng các Lab tương tác (máy tính TVM, đồ thị phân phối, cây xác suất, mô phỏng CLT, kiểm định giả thuyết...).
- Cách xem dashboard tiến độ học và điểm yếu.
- Giải thích các thuật ngữ tài chính / định lượng được sử dụng trong ứng dụng.
- Các lỗi thường gặp và cách xử lý.

Mọi tính năng mới hoặc thay đổi hành vi mà người dùng có thể nhìn thấy hoặc tương tác đều phải được cập nhật vào `USER_GUIDE.md`.

### `CHANGELOG.md`

Ghi lại lịch sử thay đổi theo ngày, sử dụng cấu trúc:

```markdown
## YYYY-MM-DD

### Added

- ...

### Changed

- ...

### Fixed

- ...

### Technical

- ...
```

Chỉ giữ các mục có nội dung. Không tạo bullet rỗng và không mô tả thay đổi chưa thực sự hoàn thành.

### `ROADMAP.md`

Duy trì backlog theo các mục:

- `Done`: công việc đã hoàn thành.
- `In Progress`: công việc đang được thực hiện.
- `Next`: công việc ưu tiên tiếp theo.
- `Later`: công việc dự kiến làm sau.
- `Technical Debt`: nợ kỹ thuật cần xử lý.

Khi hoàn thành task, chuyển task đó sang `Done`, cập nhật trạng thái liên quan và chọn task tiếp theo phù hợp cho `Next`. Không tự nhận một task là đã hoàn thành nếu code hoặc kiểm tra bắt buộc vẫn chưa hoàn tất.

## Quy tắc cập nhật bắt buộc

1. Không commit tính năng, bản sửa lỗi hoặc thay đổi kỹ thuật nếu chưa cập nhật các tài liệu liên quan.
2. Thêm tính năng mới phải cập nhật `USER_GUIDE.md`.
3. Thay đổi kiến trúc, mô hình dữ liệu, pipeline nội dung, state management hoặc cấu trúc thư mục phải cập nhật `DEVELOPMENT.md`.
4. Hoàn thành task phải cập nhật cả `CHANGELOG.md` và `ROADMAP.md`.
5. Thêm hoặc thay đổi command, script hay dependency phải cập nhật `DEVELOPMENT.md`.
6. Thay đổi hành vi người dùng nhìn thấy phải cập nhật `USER_GUIDE.md`.
7. Tài liệu phải đủ rõ để người khác clone repository, cài đặt, chạy ứng dụng, kiểm tra và tiếp tục phát triển.
8. Chỉ ghi thông tin đã được xác minh từ code, cấu hình, kết quả chạy command hoặc yêu cầu đã được xác nhận.
9. Không ghi thông tin giả hoặc suy đoán như sự thật. Phần chưa được triển khai hoặc chưa xác minh phải ghi rõ `Chưa có` hoặc `Sẽ bổ sung sau`.
10. Không ghi secret, token, private key, mật khẩu hoặc thông tin tài khoản thật vào bất kỳ tài liệu nào. Không sao chép nguyên văn nội dung có bản quyền của CFA Institute vào tài liệu; nội dung curriculum chỉ dùng cá nhân.
11. Khi tài liệu mâu thuẫn với code, phải coi code và kết quả kiểm tra thực tế là nguồn để xác minh, sau đó sửa tài liệu trong cùng task.
12. Không xóa thông tin lịch sử hợp lệ khỏi `CHANGELOG.md`; chỉ sửa khi thông tin đó sai hoặc gây hiểu nhầm.

## Vòng lặp bắt buộc trước mỗi commit

Trước khi tạo commit, Claude phải kiểm tra lần lượt:

1. Code của task đã hoàn thành.
2. Test, lint và build đã được chạy; nếu không chạy được, phải ghi rõ command chưa chạy, lý do và ảnh hưởng dự kiến.
3. `DEVELOPMENT.md` đã được cập nhật nếu có thay đổi kỹ thuật.
4. `USER_GUIDE.md` đã được cập nhật nếu có thay đổi đối với người dùng.
5. `CHANGELOG.md` đã ghi lại thay đổi đã hoàn thành theo đúng ngày và đúng nhóm.
6. `ROADMAP.md` đã chuyển task hoàn thành sang `Done` và xác định task tiếp theo trong `Next`.

Nếu bất kỳ mục bắt buộc nào chưa đạt, không được tạo commit cho đến khi mục đó được xử lý hoặc được ghi nhận rõ là không áp dụng kèm lý do hợp lệ.

## Summary bắt buộc sau mỗi commit

Sau mỗi commit, Claude phải báo cáo:

- Tính năng, bản sửa lỗi hoặc thay đổi đã thực hiện.
- Các file code đã thay đổi.
- Các file tài liệu đã cập nhật.
- Test, lint và build đã chạy, kèm kết quả; nếu không chạy được, nêu rõ lý do.
- Commit hash.
- Task tiếp theo dự kiến.

Sử dụng mẫu:

```markdown
## Commit Summary

- Thay đổi: ...
- File code: ...
- Tài liệu: ...
- Kiểm tra: ...
- Commit: `<commit-hash>`
- Tiếp theo: ...
```

Không báo cáo commit hash trước khi commit thực sự được tạo.
