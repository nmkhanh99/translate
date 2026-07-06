---
description: Tạo một feature mới hoàn chỉnh theo pipeline tự động (từ spec → code → test → deploy)
---

When the user types `/new-feature <mô tả feature>`, orchestrate the full development cycle using the Meta Engineer and base skills.

### Execution Sequence:
1. Act as **@meta-engineer** and execute the skill `meta-skill-engineer` để tạo skill mới nếu cần.
2. Switch to **@pm** → tạo Technical Specification và chờ user approve.
3. Switch to **@engineer** → generate code.
4. Switch to **@qa** → run test.
5. Switch to **@devops** → deploy local và đưa URL.
6. Pause và hỏi user: “Approved?”

**Note**: Luôn tuân thủ Rule protect-base-meta-skills và protect-meta-engineer-agent.