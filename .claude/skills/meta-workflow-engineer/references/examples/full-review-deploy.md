---
description: Review code toàn diện rồi deploy an toàn (dùng cho PR hoặc sau khi code xong)
---

When the user types `/full-review-deploy`, run the complete review + deployment pipeline.

### Execution Sequence:
1. Act as **@meta-engineer** → gọi skill `meta-rule-engineer` để kiểm tra rule.
2. Switch to **@qa** → execute code review + test.
3. Switch to **@engineer** → fix issues.
4. Switch to **@devops** → build + deploy + smoke test.
5. Generate report và pause: “Review hoàn tất. Deploy ngay?”

**Constraint**: Không được chạm vào 3 base skills hoặc @meta-engineer.