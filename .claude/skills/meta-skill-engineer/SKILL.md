---
name: meta-skill-engineer
description: Quản lý toàn bộ vòng đời Skill theo đúng chuẩn Anthropic Agent Skills: tạo mới, review, cải tiến skill. Use when user asks to create, build, review, evaluate, improve, refine or fix any Skill.
---

# Meta Skill Engineer

## Goal
Tạo và duy trì Skill đúng 100% format Anthropic (YAML frontmatter + progressive disclosure + references/).

## When to use this skill
- “tạo skill mới”, “build skill”, “generate skill”
- “review skill”, “evaluate skill”, “improve skill”

## Instructions
1. Xác định mode (CREATE / REVIEW / IMPROVE).
2. Chạy script Python trong `scripts/`.
3. Luôn kiểm tra `references/SKILL_STRUCTURE_GUIDE.md`, `SKILL_QUALITY_CHECKLIST.md` và `references/examples/`.
4. Sau khi xong: liệt kê cấu trúc thư mục + cách test.

## Constraints
- Mỗi skill chỉ làm một việc duy nhất.
- Frontmatter chỉ có `name` + `description` (bắt buộc).
- Không thay đổi cấu trúc thư mục chuẩn của Anthropic.

## Best practices
- Description phải chứa trigger rõ ràng và cụ thể.
- Giữ SKILL.md ngắn gọn (<150 dòng).
- Sử dụng progressive disclosure: 
  - `references/` cho templates, checklists, guides.
  - `references/examples/` cho few-shot examples (basic-created-skill.md, improved-skill.md…).
- Tham khảo `references/examples/` trước khi create/improve skill để giữ tính nhất quán theo The Complete Guide to Building Skill for Claude.