---
name: meta-rule-engineer
description: Quản lý toàn bộ vòng đời Rules theo đúng chuẩn Anthropic: tạo mới, review, cải tiến Rule. Use when user asks to create, build, review, evaluate, improve, refine or fix any Rule.
---

# Meta Rule Engineer

## Goal
Tạo và duy trì Rule đúng 100% format Anthropic (Always On / Manual / Model Decision / Glob).

## When to use this skill
- “tạo rule mới”, “build rule”, “create rule”
- “review rule”, “evaluate rule”
- “chỉnh sửa rule”, “improve rule”

## Instructions
1. Xác định mode theo Decision Tree trong references/.
2. Chạy script Python trong `scripts/`.
3. Luôn kiểm tra `references/ACTIVATION_MODES.md`, `RULE_QUALITY_CHECKLIST.md` và `references/examples/`.
4. Sau khi xong: liệt kê file path + activation mode.

## Constraints
- Rule là Markdown thuần.
- Giữ dưới 12.000 ký tự/file.
- Mỗi rule chỉ làm một việc.

## Best practices
- Luôn đọc `references/ACTIVATION_MODES.md` trước khi tạo.
- Dùng @ References để tái sử dụng.
- Tham khảo `references/examples/` (basic-rule.md, improved-rule.md) để học pattern và tuân thủ best practices của Anthropic.