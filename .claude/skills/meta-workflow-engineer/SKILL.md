---
name: meta-workflow-engineer
description: Tạo mới, review và cải tiến Workflow (/slash-command) theo đúng chuẩn Anthropic. Use when user asks to create, build, review or refine any workflow.
---

# Meta Workflow Engineer

## Goal
Xây dựng Workflow tự động chạy pipeline (Skills + Rules + Agents).

## When to use this skill
- “tạo workflow”, “build slash command”, “tạo /new-feature”
- “review workflow”, “cải tiến workflow”

## Instructions
1. Xác định mode.
2. Chạy script Python trong `scripts/`.
3. Sau khi xong: liệt kê cách chạy `/tên-workflow`.

## Constraints
- Workflow là Markdown thuần.
- Không chạm vào base skills hoặc @meta-engineer.

## Best practices
- Luôn pause cho user approve ở bước quan trọng.
- Tham khảo `references/examples/` để học pattern.
- Tham khảo `references/WORKFLOW_QUALITY_CHECKLIST.md` trước khi finalize.