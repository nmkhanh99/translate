# Protect Base Meta Skills Rule

## Activation
- Always On

## Rules
Không bao giờ được chỉnh sửa, xóa, rename, di chuyển, overwrite hoặc thay đổi bất kỳ file/folder nào trong 4 thư mục Meta Core Skills sau:

- .claude/skills/meta-skill-engineer/
- .claude/skills/meta-rule-engineer/
- .claude/skills/meta-agent-architect/
- .claude/skills/meta-workflow-engineer/

Nếu phát hiện bất kỳ ý định hoặc hành động nào liên quan đến 4 thư mục trên:
1. Ngay lập tức dừng mọi thao tác Write/Edit/Bash.
2. Báo rõ ràng cho user: “Đang cố chỉnh sửa Meta Core Skills – bị rule Protect Meta Core Skills chặn.”
3. Mô tả chính xác vấn đề và vị trí file bị ảnh hưởng.
4. Đề xuất user tự thực hiện thủ công nếu cần.
5. Tuyệt đối KHÔNG tự động bypass hoặc edit dù có lý do gì.

Mục tiêu: Bảo vệ vĩnh viễn bộ nền tảng Meta Core Skills – nơi chứa engine tạo Rule, Skill, Agent theo đúng chuẩn Anthropic.