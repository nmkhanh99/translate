## Cấu trúc Skill Chuẩn Chính Thức (theo Anthropic Agent Skills)

### Frontmatter (bắt buộc)
---
name: ten-skill
description: Mô tả ngắn + trigger (bắt buộc)
---

### Thư mục khuyến nghị
├── SKILL.md
├── scripts/          # Python/Bash (black-box)
├── references/       # Template, tài liệu tĩnh
└── examples/         # Few-shot learning

### Các section khuyến nghị trong SKILL.md
- ## Goal
- ## When to use this skill
- ## Instructions (step-by-step)
- ## Constraints (Do not...)
- ## Best practices

Progressive Disclosure: Agent chỉ thấy name + description trước, sau đó mới đọc full SKILL.md nếu phù hợp.