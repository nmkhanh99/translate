---
name: meta-agent-architect
description: Phân tích dự án và thiết kế Multi-Agent Team chuẩn Anthropic. Tạo/cải tiến file .claude/agents/agents.md. Use when user asks to add, create, design, build, review or optimize AI agents / team agents.
---

# Meta Agent Architect

## Goal
Xác định các Agent (persona) cần thiết và tạo file `.claude/agents/agents.md` chuẩn.

## When to use this skill
- “xác định agents”, “thiết kế team agent”, “build multi-agent”
- “review team agent”, “cải tiến agents”
- "thêm agent", "tạo agent mới", "tôi cần agent cho X"    
- User đề cập vai trò cần agent (BA, PM, DevOps, QA...)  

## Instructions
1. Phân tích dự án.
2. Chạy script Python trong `scripts/`.
3. Dùng template từ `references/AGENT_TEMPLATE.md` và checklist.
4. Sau khi xong: liệt kê các @role có thể mention.

## Constraints
- Mỗi persona chỉ chịu trách nhiệm 1 lĩnh vực.
- Phải có @role để mention trong chat.

## Best practices
- Luôn đọc `references/COMMON_ROLES.md`.
- Bắt đầu với 4-6 role cho hầu hết dự án.
- Tham khảo `references/examples/` (nếu có) để học pattern team theo The Complete Guide to Building Skill for Claude.