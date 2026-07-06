---
name: verify-engine-with-codex
description: Dùng Codex như một "oracle" độc lập (model khác) để kiểm chứng chéo engine tính toán của app CFA — Codex tự tính lại từ công thức + Example trong sách rồi đối chiếu với output engine để bắt sai công thức/sai số. Use when building or fixing a calc engine (TVM, NPV/IRR, statistics, regression, hypothesis test...) and cần verify nó khớp đáp án/Example trong curriculum bằng một nguồn độc lập, cross-check, second implementation.
---

# Verify Engine with Codex

## Goal
Tận dụng Codex (một model độc lập, khác Claude) làm **ground truth thứ hai** để kiểm chứng engine tính toán: cho Codex công thức + dữ liệu của một Example trong sách, để Codex **tự tính độc lập**, rồi đối chiếu với cả đáp án sách **và** output engine của app. Mục tiêu là bắt lỗi công thức, lỗi làm tròn, lỗi cận biên mà self-check một phía dễ bỏ sót.

Khớp rule project: *"Engine tính toán phải kiểm chứng bằng ví dụ/đáp án có sẵn trong sách (ground truth độc lập)"*.

## When to use this skill
- Vừa viết/sửa một engine tính toán (TVM, NPV/IRR, mean/variance, probability, regression, hypothesis test...) và cần xác nhận đúng.
- Engine ra kết quả lệch với Example trong sách và cần tìm nguyên nhân từ góc nhìn độc lập.
- Muốn cross-check một công thức trước khi tin tưởng đưa vào app.
- KHÔNG dùng để Codex tự sửa code (→ `/codex:rescue`) hay review diff chung chung (→ `/codex:review`).

## Instructions
1. **Thu thập ground truth từ sách (bắt buộc, không phỏng đoán).** Theo rule `reread-book-when-needed`: mở PDF curriculum, lấy đúng **công thức, dữ liệu input và đáp án** của Example (ghi rõ Volume → LM → Section → trang/Example). Không bịa số.

2. **Chạy engine của app** với đúng input đó, ghi lại output (kèm số chữ số/đơn vị).

3. **Tìm runtime Codex** (luồng chính không có `${CLAUDE_PLUGIN_ROOT}`):
   ```bash
   SCRIPT=$(ls -t ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs 2>/dev/null | head -1)
   ```
   Rỗng → bảo user chạy `/codex:setup`.

4. **Giao Codex tính ĐỘC LẬP (read-only, KHÔNG `--write`).** Soạn prompt gồm: công thức, input, yêu cầu Codex tự tính từng bước và đưa con số cuối — **KHÔNG** cho Codex biết đáp án sách hay output engine trước (tránh mồi). Có thể tham chiếu `codex:gpt-5-4-prompting`. Prompt có thể chứa ký tự `$`/backtick → truyền qua `--prompt-file` (heredoc nháy đơn), KHÔNG nội suy vào chuỗi lệnh:
   ```bash
   PF=$(mktemp); cat > "$PF" <<'CODEX_EOF'
   Tính độc lập [đại lượng] theo công thức [...] với input [...]. Trình bày từng bước và con số cuối cùng. Chỉ tính toán, đừng sửa file nào.
   CODEX_EOF
   node "$SCRIPT" task --prompt-file "$PF"; rm -f "$PF"
   ```
   Tính nặng/nhiều bước → thêm `--background`; nhận `job-id` rồi lấy kết quả bằng `node "$SCRIPT" result <job-id>` (KHÔNG dùng `/codex:result` — bị `disable-model-invocation`, Claude không gọi được).

5. **Đối chiếu 3 nguồn:** đáp án sách ↔ output engine ↔ kết quả Codex.
   - Cả 3 khớp (trong sai số làm tròn) → engine xác nhận đúng. Báo PASS kèm vị trí Example.
   - Lệch → khoanh vùng: sai ở công thức, thứ tự phép tính, làm tròn, hay đơn vị. Nếu cần đào sâu, hỏi tiếp Codex bằng `--resume-last`.

6. **Báo kết luận cho user:** PASS/FAIL, ba con số đặt cạnh nhau, vị trí Example trong sách, và (nếu FAIL) nguyên nhân nghi ngờ + đề xuất sửa engine.

## Constraints
- KHÔNG thêm `--write` — đây là kiểm chứng, Codex không sửa code.
- KHÔNG mồi đáp án sách/engine cho Codex ở lượt tính đầu (mất tính độc lập).
- KHÔNG lấy công thức/đáp án từ trí nhớ — phải trích từ PDF curriculum (rule `reread-book-when-needed`).
- KHÔNG kết luận PASS nếu chưa thực sự chạy engine và nhận kết quả Codex.
- KHÔNG đụng 4 base meta-skills hay file plugin Codex.

## Best practices
- Cung cấp đủ input + đơn vị + số chữ số mong muốn để so sánh công bằng (tránh "lệch" do làm tròn).
- Khi lệch, sửa engine rồi chạy lại đủ vòng (sách ↔ engine ↔ Codex) tới khi hội tụ.
- Nêu rõ sai số chấp nhận được (vd ±0.01) để phán định khách quan.
- Lưu vị trí Example đã đối chiếu vào ghi chú/in-app reference để người học tra lại được.
