#!/usr/bin/env node
// pipeline-runner.mjs — orchestrator pipeline dịch 1 volume, chạy TÁCH TIẾN TRÌNH
// (daemon spawn detached, stdout/err đổ vào run.log).
//
// Vì sao tồn tại: trước đây daemon spawn `claude -p` và bảo model gọi công cụ
// Workflow (chạy nền) rồi "chờ" — model kết thúc lượt là process thoát, workflow
// nền bị giết giữa chừng ("chạy 1 lúc lại bị dừng"). Runner này đảo ngược vai
// trò: NODE điều phối vòng đời (vòng lặp, checkpoint, retry), model CHỈ dịch —
// mỗi đơn vị việc là một lệnh `claude -p` ngắn, đồng bộ, không có gì chạy nền.
//
// Resume-safe y như cũ: mọi bước đọc pending từ file (chunks/out, vchunks/vout,
// vis/), chạy lại là tiếp đúng chỗ. Dừng = kill process group (stopVolume).
//
// Usage: node pipeline-runner.mjs '<json>'
//   { pdf, workdir, out, tool, python, claudeBin?, model?, posture?,
//     vision?, only?, visPages? }
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const A = JSON.parse(process.argv[2] || "{}");
const PY = A.python || "python3";
const TOOL = A.tool;
const WD = A.workdir;
const CLAUDE = A.claudeBin || process.env.CFA_CLAUDE_BIN || "claude";
const MODEL = A.model || "sonnet";
const CONCURRENCY = 3;
const UNIT_TIMEOUT_MS = 15 * 60 * 1000; // 1 đơn vị việc (chunk/trang) tối đa 15'
const MAX_FIX_ROUNDS = 2;

const log = (m) => console.log(`[runner ${new Date().toISOString().slice(11, 19)}] ${m}`);
const pad = (p) => String(p).padStart(3, "0");

const STYLE =
  "Dịch sang tiếng Việt tự nhiên, văn phong học thuật tài chính. " +
  'GIỮ NGUYÊN thuật ngữ tiếng Anh trong ngoặc đơn ở lần xuất hiện đầu, ví dụ "lãi suất chiết khấu (discount rate)". ' +
  "GIỮ NGUYÊN mọi con số, ký hiệu, công thức, mã (LOS, §). KHÔNG bỏ sót ý. Không thêm lời bình.";

/** Chạy python agent_pipeline, trả stdout (echo vào run.log). */
function py(...args) {
  const r = spawnSync(PY, ["agent_pipeline.py", ...args], {
    cwd: TOOL,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) throw new Error(`python ${args[0]} rc=${r.status}`);
  return (r.stdout || "").trim();
}
const lastJson = (s, fallback) => {
  const lines = s.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* not json */
    }
  }
  return fallback;
};

/** Một lượt `claude -p` đồng bộ: model làm việc bằng tool-call tuần tự rồi thoát. */
function claudeCall(prompt, label) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--model", MODEL, "--output-format", "text"];
    if (A.posture === "bypass") args.push("--permission-mode", "bypassPermissions");
    else args.push("--permission-mode", "default", "--allowedTools", "Read", "Write");
    const child = spawn(CLAUDE, args, { cwd: WD, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", () => {}); // text cuối không cần, output là FILE
    const t = setTimeout(() => {
      log(`⏱ ${label}: quá ${UNIT_TIMEOUT_MS / 60000}' — kill`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, UNIT_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) log(`✗ ${label}: rc=${code} ${err.slice(-200).replace(/\n/g, " ")}`);
      resolve(code === 0);
    });
    child.on("error", (e) => {
      clearTimeout(t);
      log(`✗ ${label}: ${e.message}`);
      resolve(false);
    });
  });
}

/** Pool đơn giản: chạy jobs (mảng thunk async) với tối đa CONCURRENCY song song. */
async function pool(jobs) {
  let i = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      await j();
    }
  });
  await Promise.all(workers);
}

/** Chạy 1 danh sách đơn vị việc: gọi claude, kiểm output file, retry 1 lần. */
async function runUnits(units, mkPrompt, outPath, tag) {
  let done = 0;
  const jobs = units.map((u) => async () => {
    const label = `${tag}:${u.idx ?? u}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await claudeCall(mkPrompt(u), label);
      if (existsSync(outPath(u))) break;
      if (attempt === 1) log(`↻ ${label}: thiếu output — thử lại`);
    }
    done++;
    log(`${existsSync(outPath(u)) ? "✔" : "✗"} ${label} (${done}/${units.length})`);
  });
  await pool(jobs);
  return units.filter((u) => !existsSync(outPath(u)));
}

const trPrompt = (u) =>
  `Đọc file JSON: ${u.in} (mảng các {id, text} tiếng Anh).\n${STYLE}\n` +
  `Ghi kết quả ra ${u.out} dạng JSON object {id: "bản dịch tiếng Việt"} cho MỌI id. ` +
  `Dùng tool Write. Chỉ ghi file, không in gì khác.`;

const vrPrompt = (u) =>
  `Đọc file JSON: ${u.in} (mảng {id, en, vi}: en = bản gốc tiếng Anh, vi = bản dịch hiện tại).\n` +
  `Với MỖI mục, đối chiếu vi với en, tập trung: SAI/THIẾU con số, đơn vị, ký hiệu, bỏ sót câu/ý, dịch sai nghĩa. ` +
  `Nếu cần sửa thì sửa; nếu vi đã đúng thì giữ nguyên. ${STYLE}\n` +
  `Ghi ra ${u.out} dạng JSON {id: "bản vi đúng nhất"} cho MỌI id. Dùng tool Write. Chỉ ghi file.`;

const visPrompt = (p) =>
  `Mở ảnh ghép bằng tool Read trên đường dẫn: ${WD}/review/pair_${pad(p)}.png. ` +
  `Bên TRÁI là trang gốc tiếng Anh, bên PHẢI là bản dịch tiếng Việt (cùng layout). ` +
  `So sánh layout. Chỉ soi lỗi LAYOUT/hiển thị, KHÔNG chấm chất lượng dịch.\n` +
  `PHÂN LOẠI mỗi lỗi bằng "kind":\n` +
  `• "fit" = chữ Việt co nhỏ/nhồi sát/giãn dòng khác bản gốc để vừa khung NHƯNG nội dung ĐỦ và ĐỌC ĐƯỢC ` +
  `(đánh đổi chấp nhận được, KHÔNG cần fix).\n` +
  `• "defect" = lỗi thật cần fix: MẤT/CẮT nội dung, chữ đè chồng không đọc được, công thức/phân số vỡ, ` +
  `bảng/checkbox vỡ, highlight/đồ thị lệch, header hỏng.\n` +
  `NHIỆM VỤ DUY NHẤT: dùng tool Write ghi ra file ${WD}/vis/page_${pad(p)}.json một MẢNG JSON các lỗi. ` +
  `Mỗi lỗi {"page": ${p}, "kind": "fit|defect", "severity": "high|medium|low", "detail": "..."}. ` +
  `Trang ổn thì ghi []. Không in gì khác.`;

const fixPrompt = (p) =>
  `Một số đoạn văn xuôi tiếng Việt trên trang ${p} đang TRÀN/vỡ khung layout vì dài hơn bản Anh. ` +
  `Đọc file JSON ${WD}/fix/page_${pad(p)}.json (mảng {id, en, vi}).\n` +
  `Với MỖI mục: nếu 'vi' DÀI gây tràn thì RÚT GỌN cho súc tích (~15–25% ngắn hơn, bỏ từ thừa) NHƯNG GIỮ ĐỦ Ý ` +
  `và GIỮ NGUYÊN mọi số/đơn vị/ký hiệu/công thức/thuật ngữ + cụm "(English term)". Nếu 'vi' đã gọn thì GIỮ NGUYÊN. ` +
  `KHÔNG bịa, KHÔNG bỏ ý.\nGhi ra ${WD}/fixout/page_${pad(p)}.json dạng JSON {id: "bản vi"} cho MỌI id ` +
  `(kể cả id giữ nguyên). Dùng tool Write. Chỉ ghi file, không in gì khác.`;

async function visionPass(pagesCsv) {
  py("vis-pages", A.pdf, A.out, WD, ...(pagesCsv ? [pagesCsv] : []));
  const pages = lastJson(py("pending", WD, "vision"), []);
  if (!pages.length) return;
  log(`vision: ${pages.length} trang cần soát`);
  await runUnits(pages, visPrompt, (p) => join(WD, "vis", `page_${pad(p)}.json`), "vis");
  py("merge-vis", WD);
}

async function main() {
  log(`bắt đầu: ${A.pdf} -> ${A.out} (model=${MODEL}, only=${A.only || "-"})`);
  const onlyVision = A.only === "vision";
  let st = lastJson(py("status", WD), { stage: "?" });
  if (st.stage === "done" && !onlyVision) {
    // Đã xong hoàn toàn: chạy lại không được apply/re-vision lại cả cuốn
    // (apply ghi đè OUT làm mọi pair stale -> re-review 100% trang vô ích).
    log("volume đã done — không có gì để làm");
    process.exit(0);
  }
  const reviewResume = !onlyVision && st.stage === "review";

  if (!onlyVision && !reviewResume) {
    // -- Translate --
    py("chunk", A.pdf, WD);
    let pend = lastJson(py("pending", WD, "translate"), []);
    log(`translate: ${pend.length} chunk`);
    const missTr = await runUnits(pend, trPrompt, (u) => u.out, "tr");
    py("merge-tr", A.pdf, WD);
    // -- Verify --
    py("vchunk", A.pdf, WD);
    pend = lastJson(py("pending", WD, "verify"), []);
    log(`verify: ${pend.length} vchunk`);
    const missVr = await runUnits(pend, vrPrompt, (u) => u.out, "vr");
    py("merge-vr", WD);
    if (missTr.length || missVr.length) {
      log(`⚠ còn thiếu output: translate=${missTr.length} verify=${missVr.length} — dừng để không apply thiếu`);
      process.exit(2);
    }
    // -- Apply --
    py("apply", A.pdf, WD, A.out);
  }

  // -- Vision --
  if (A.vision !== false || onlyVision) {
    if (!reviewResume) await visionPass(A.visPages);

    // -- Auto-fix (chỉ trang kênh text; xem LAYOUT_PLAYBOOK) --
    if (!onlyVision) {
      for (let round = 1; round <= MAX_FIX_ROUNDS; round++) {
        const bad = lastJson(py("problems", WD, "medium", "text"), []);
        if (!bad.length) {
          log("auto-fix: hết defect kênh text ✓");
          break;
        }
        log(`auto-fix vòng ${round}/${MAX_FIX_ROUNDS}: ${bad.length} trang`);
        const csv = bad.join(",");
        const fpages = lastJson(py("page-segments", A.pdf, WD, csv), []);
        await runUnits(fpages, fixPrompt, (p) => join(WD, "fixout", `page_${pad(p)}.json`), "fix");
        py("merge-fix", WD);
        py("apply", A.pdf, WD, A.out);
        await visionPass(csv);
      }
      py("review-summary", WD);
    }
  }

  st = lastJson(py("status", WD), { stage: "?" });
  log(`kết thúc: stage=${st.stage} defects=${st.defects ?? "?"}`);
  process.exit(["done", "review"].includes(st.stage) || onlyVision ? 0 : 2);
}

main().catch((e) => {
  log(`LỖI: ${e.message}`);
  process.exit(1);
});
