import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VolumeRec } from "./volumes.js";
import { PYTHON_DIR, VOLUME_JS } from "./paths.js";

export function chatContextSafe(vol: VolumeRec): string {
  return (
    "Bạn là trợ lý dịch thuật của app CFA Translate Studio, đang hỗ trợ người " +
    "dùng về MỘT tài liệu cụ thể. Trả lời bằng tiếng Việt, ngắn gọn, đúng " +
    "trọng tâm.\n" +
    `- Tên tài liệu: ${vol.display}\n` +
    `- PDF nguồn (tiếng Anh): ${vol.pdf}\n` +
    `- PDF bản dịch (tiếng Việt): ${vol.out} (${existsSync(vol.out) ? "đã có" : "chưa có"})\n` +
    `- Thư mục làm việc: ${vol.workdir}\n` +
    "Bạn đang chạy trong thư mục 'translate'. Có thể đọc file nguồn để giải " +
    "thích thuật ngữ, đề xuất bản dịch, hoặc soát lỗi trình bày. KHÔNG tự chạy " +
    "pipeline dịch cả cuốn trừ khi người dùng yêu cầu rõ."
  );
}

export function buildClaudePipelinePrompt(
  vol: VolumeRec,
  vision: boolean
): string {
  const runArgs = {
    pdf: vol.pdf,
    workdir: vol.workdir,
    out: vol.out,
    vision: !!vision,
    tool: PYTHON_DIR,
  };
  return (
    "Bạn đang chạy pipeline dịch 1 volume CFA sang tiếng Việt (giữ layout). " +
    `Dùng công cụ Workflow với scriptPath "${VOLUME_JS}" và args (JSON) sau:\n` +
    `${JSON.stringify(runArgs)}\n\n` +
    "CHỜ workflow chạy XONG hoàn toàn rồi báo lại đúng status JSON cuối cùng " +
    "của nó. KHÔNG kết thúc lượt cho tới khi workflow hoàn tất. Không hỏi lại."
  );
}

function parsePages(
  pages: string | undefined
): [number, number] | null {
  if (!pages || pages.trim().toLowerCase() === "all") return null;
  const s = pages.trim();
  if (!s.includes("-")) return null;
  const [lo, hi] = s.split("-", 2);
  if (!/^\d+$/.test(lo.trim()) || !/^\d+$/.test(hi.trim())) return null;
  const a = parseInt(lo, 10);
  const b = parseInt(hi, 10);
  return [Math.min(a, b), Math.max(a, b)];
}

export function buildMcpBatchPrompt(
  vol: VolumeRec,
  batch: number,
  pages = "all"
): string {
  const src = vol.pdf;
  const out = vol.out;
  const wd = vol.workdir;
  const rng = parsePages(pages);
  const tag = rng ? `_${rng[0]}_${rng[1]}` : "";
  const state = join(wd, `codex_state${tag}.json`);
  const work = join(wd, `codex_work${tag}.pdf`);

  let scope: string;
  let lastLine: string;
  let initLine: string;
  if (rng) {
    const [a, b] = rng;
    scope = `CHỈ dịch KHOẢNG TRANG ${a}..${b} (0-based). first_page = ${a}; last = ${b}.\n`;
    lastLine = `1) last = ${b}; first_page = ${a}.\n`;
    initLine =
      "2) Đọc STATE (shell `cat`) lấy done_through; nếu chưa có " +
      `STATE/WORK thì done_through = first_page-1 = ${a - 1}.\n`;
  } else {
    scope = "Dịch CẢ volume.\n";
    lastLine =
      "1) list_pdf_info(SOURCE) để lấy page_count " +
      "(last = page_count-1; first_page = 0).\n";
    initLine =
      "2) Đọc STATE (shell `cat` nếu có) lấy done_through (0-based, " +
      "trang cuối đã dịch); nếu chưa có STATE hoặc chưa có WORK thì " +
      "done_through = -1.\n";
  }

  return (
    "Bạn là trình dịch PDF CFA sang TIẾNG VIỆT, GIỮ NGUYÊN layout, qua MCP " +
    "server `cfa-pdf-translator` (các tool: list_pdf_info, extract_segments, " +
    "apply_translations). Làm việc TỰ ĐỘNG tới khi xong, KHÔNG hỏi lại.\n\n" +
    `SOURCE = ${src}\nOUT = ${out}\nWORK = ${work}\nSTATE = ${state}\n` +
    `BATCH = ${batch | 0} trang mỗi lô. ${scope}\n` +
    "LƯU Ý apply_translations MỞ LẠI đúng PDF đã extract rồi lưu ra file đích. " +
    "TUYỆT ĐỐI không để file nguồn và file đích TRÙNG đường dẫn (PyMuPDF sẽ " +
    "lỗi). Vì vậy luôn đọc từ WORK và ghi ra OUT, rồi copy OUT->WORK.\n\n" +
    "QUY TRÌNH:\n" +
    lastLine +
    initLine +
    "3) LẶP tới khi done_through == last:\n" +
    "   - start = done_through+1; end = min(start+BATCH-1, last); " +
    'pages = f"{start}-{end}".\n' +
    "   - input_pdf = WORK nếu file WORK đã tồn tại, ngược lại = SOURCE.\n" +
    "   - extract_segments(input_pdf, pages). Dịch text từng segment sang " +
    "tiếng Việt tự nhiên, GIỮ NGUYÊN số/ký hiệu/công thức và thuật ngữ (ETF, " +
    "CAPM...). Với thuật ngữ chuyên ngành dùng dạng 'tiếng Việt (English term)' " +
    "khi hữu ích.\n" +
    "   - apply_translations(session_id, {id: bản_dịch}, OUT)  # đọc input_pdf, ghi OUT.\n" +
    "   - Sao chép OUT sang WORK bằng shell: `cp OUT WORK` (để lô sau đọc từ " +
    "WORK đã tích luỹ). Dùng đúng đường dẫn tuyệt đối ở trên.\n" +
    '   - done_through = end; ghi STATE = {"done_through": end, "last": ' +
    "last} (shell, ghi đè file).\n" +
    "4) Khi xong in ĐÚNG một dòng JSON: " +
    '{"engine":"codex","out":"...","pages":<page_count>,"done":true}.\n' +
    "Không dịch heading/công thức/bảng số/mục lục — extract_segments đã lọc sẵn."
  );
}
