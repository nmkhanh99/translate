---
name: discuss-with-codex
description: Trao đổi / thảo luận hai chiều với Codex để xin second opinion, brainstorm, bàn thiết kế hoặc phản biện qua lại nhiều lượt, rồi Claude đọc và tổng hợp ý kiến Codex vào lập luận của mình. Use when the user wants to "trao đổi/thảo luận/hỏi ý kiến/bàn/brainstorm/lấy góc nhìn khác cùng Codex", consult Codex, get a second opinion, or debate a design with Codex (KHÁC với delegate kiểu /codex:rescue và review một lần kiểu /codex:review).
---

# Discuss with Codex

## Goal
Cho phép Claude (luồng chính) **đối thoại hai chiều** với Codex: gửi câu hỏi/đề xuất, đọc phản hồi, rồi **tổng hợp** ý kiến Codex vào lập luận của chính Claude và trình bày kết luận cho user. Có thể hỏi tiếp nhiều lượt để giữ ngữ cảnh hội thoại.

Khác biệt cốt lõi:
- `/codex:rescue` = giao việc một chiều, forward nguyên văn output. **Skill này KHÔNG forward nguyên văn** — Claude đọc, phản biện, tổng hợp.
- `/codex:review`, `/codex:adversarial-review` = review code một lần. Skill này là **hội thoại** về thiết kế/ý tưởng/đánh đổi.

## When to use this skill
- User muốn "trao đổi / thảo luận / hỏi ý kiến / bàn / brainstorm cùng Codex".
- Cần một góc nhìn thứ hai (second opinion) về một thiết kế, lựa chọn kỹ thuật, hoặc cách tiếp cận.
- Muốn phản biện qua lại (Claude ↔ Codex) trước khi chốt một quyết định.
- KHÔNG dùng khi user chỉ muốn Codex tự sửa code (→ `/codex:rescue`) hoặc review diff hiện tại (→ `/codex:review`).

## Instructions
1. **Xác định chủ đề trao đổi.** Tóm tắt câu hỏi/đề xuất cần bàn với Codex (gồm bối cảnh đủ để Codex hiểu mà không cần đọc lại repo). Nếu cần soạn prompt chặt chẽ hơn, tham chiếu skill `codex:gpt-5-4-prompting`.

2. **Tìm đường dẫn runtime** (chạy ở luồng chính nên `${CLAUDE_PLUGIN_ROOT}` không có sẵn — tự resolve, robust với version bump):
   ```bash
   SCRIPT=$(ls -t ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | head -1)
   ```
   Nếu rỗng → Codex chưa cài/chưa nhận plugin: dừng và bảo user chạy `/codex:setup`.

3. **Gửi lượt đầu (read-only, KHÔNG `--write`).** Prompt có thể chứa code/`$(...)`/backtick/`$VAR` → **KHÔNG nội suy thẳng vào chuỗi lệnh** (sẽ bị shell expand/exec). Ghi prompt ra file tạm rồi truyền `--prompt-file`:
   ```bash
   PF=$(mktemp); cat > "$PF" <<'CODEX_EOF'
   <câu hỏi + bối cảnh + nêu rõ: chỉ thảo luận, đừng sửa file>
   CODEX_EOF
   node "$SCRIPT" task --prompt-file "$PF"; rm -f "$PF"
   ```
   (Heredoc dùng `'CODEX_EOF'` có nháy đơn nên nội dung KHÔNG bị shell expand.)
   - Mặc định read-only để Codex không động vào code.
   - Chỉ thêm `--model`/`--effort` khi user yêu cầu rõ (`spark` → `gpt-5.3-codex-spark`); xem Constraints.
   - Task lâu/mở rộng → thêm `--background`; nhận lại `job-id` rồi theo dõi bằng `node "$SCRIPT" status <job-id>` và lấy kết quả bằng `node "$SCRIPT" result <job-id>` (KHÔNG dùng `/codex:status`, `/codex:result` — hai slash command này bị `disable-model-invocation`, Claude không gọi được).

4. **Đọc & phản biện.** Đọc kỹ phản hồi Codex. Đối chiếu với hiểu biết của Claude: chỗ nào đồng ý, chỗ nào không và vì sao. **Không** bê nguyên văn cho user.

5. **Hỏi tiếp (giữ ngữ cảnh hội thoại)** nếu cần làm rõ hoặc đẩy phản biện sâu hơn — dùng `--resume-last` để tiếp đúng luồng Codex vừa rồi (vẫn truyền qua `--prompt-file` như bước 3):
   ```bash
   PF=$(mktemp); cat > "$PF" <<'CODEX_EOF'
   <câu hỏi tiếp / điểm muốn phản biện>
   CODEX_EOF
   node "$SCRIPT" task --resume-last --prompt-file "$PF"; rm -f "$PF"
   ```
   Lặp lại bước 4–5 tới khi đủ rõ.

6. **Tổng hợp & trình bày.** Trình bày cho user: (a) tóm tắt quan điểm Codex, (b) đánh giá của Claude (đồng ý/không, lý do), (c) kết luận/khuyến nghị chung. Nêu rõ điểm hai bên còn khác biệt nếu có.

## Constraints
- KHÔNG thêm `--write` — đây là thảo luận, Codex không được sửa code.
- KHÔNG forward nguyên văn output Codex thay cho câu trả lời của mình (đó là việc của `/codex:rescue`).
- KHÔNG sửa/đụng 4 base meta-skills hay file trong plugin Codex.
- KHÔNG bịa nội dung Codex chưa trả lời; nếu Codex lỗi/không gọi được, báo user và đề xuất `/codex:setup`.
- KHÔNG tự thêm `--model`/`--effort` ngoài mặc định trừ khi user yêu cầu.

## Best practices
- Cho Codex đủ bối cảnh trong prompt (đây là tiến trình tách biệt, không thấy hội thoại của Claude).
- Mỗi lượt hỏi một trọng tâm rõ ràng để phản biện hội tụ, tránh hỏi lan man.
- Dùng `--resume-last` cho các lượt tiếp theo để giữ mạch hội thoại thay vì mở thread mới.
- Khi Claude và Codex bất đồng, nêu rõ cả hai phía cho user tự quyết — đừng giấu mâu thuẫn.
- Việc nặng/đa bước nên chạy `--background` rồi thu kết quả qua `node "$SCRIPT" result <job-id>`.
