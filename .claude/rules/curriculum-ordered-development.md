# Curriculum-Ordered Development

## Activation
- Always On

## Mục tiêu
Phát triển app học CFA theo ĐÚNG cấu trúc và thứ tự của tài liệu gốc, để người dùng vừa học sách vừa dùng app thực hành hiểu sâu lý thuyết (application-first). Cấu trúc app phải là tấm gương phản chiếu mục lục sách, không sắp xếp theo ý chủ quan.

## Rules

### 1. Nhóm theo đúng Volume
- Mọi phần của app phải nằm đúng Volume của nó trong menu.
- Nội dung thuộc một file/PDF của Volume nào thì để trong menu Volume đó. Ví dụ: nội dung trong `2024 L1V1-Prerequisite Quant.pdf` và `2024 L1V1.pdf` đều thuộc **L1V1** → phải nằm trong menu L1V1.
- Tài liệu "Prerequisite" được coi là phần bổ trợ của chính Volume đó, KHÔNG tạo Volume riêng và KHÔNG dùng làm xương sống thay cho sách chính.

### 2. Theo đúng mục lục (table of contents)
- Thứ tự Topic → Learning Module → Section trong app phải khớp đúng thứ tự trong mục lục sách.
- Tên Topic, Learning Module và Section phải ghi đúng nguyên văn heading trong sách (giữ tiếng Anh theo sách).
- Các công cụ/ứng dụng trong một module phải được nhóm và sắp xếp theo đúng các Section của module đó, đúng thứ tự xuất hiện trong sách.
- Trước khi thêm/sắp xếp một phần, phải đối chiếu mục lục thật của PDF (dùng bookmark TOC hoặc trích trang) — không bịa thứ tự hay tên mục.

### 3. Phát triển tuần tự, không nhảy cóc
- Xây các Learning Module theo đúng thứ tự tăng dần (LM1 → LM2 → ...). Không bắt đầu module sau khi module trước chưa hoàn thành ở mức chạy được, trừ khi user yêu cầu rõ.
- Trong mỗi module, dựng các Section theo đúng thứ tự sách.
- Module/Section chưa làm phải hiển thị rõ trạng thái "sắp có" (planned), không ẩn đi khỏi cấu trúc.

### 4. Application-first gắn với lý thuyết
- Mỗi Learning Module phải có ít nhất một ứng dụng thực hành thật, ánh xạ tới lý thuyết và LOS của module đó — không chỉ hiển thị lý thuyết.
- Mỗi công cụ nên ghi rõ nó thuộc Section nào của sách để người học đối chiếu được sách ↔ app.
- Engine tính toán phải kiểm chứng bằng ví dụ/đáp án có sẵn trong sách (ground truth độc lập).

### 5. Nguồn sự thật là sách
- Khi cấu trúc app mâu thuẫn với mục lục sách, sửa app theo sách.
- Cập nhật `cfa-app/src/data/curriculum.ts` (Volume → Topic → Module → Section) làm nơi khai báo cấu trúc duy nhất, đồng bộ với mục lục PDF.

## @ References
@PLAN.md
