import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { AppConfig, Volume } from "@cfa-translate/shared";
import {
  INPUT_DIR,
  MANIFEST,
  OUTPUT_DIR,
  USER_WORK,
  TOOL_DIR,
  pythonBin,
  PYTHON_DIR,
} from "./paths.js";

export interface VolumeRec {
  pdf: string;
  workdir: string;
  out: string;
  vision?: boolean;
  skip?: boolean;
  user?: boolean;
  note?: string;
  tag: string;
  display: string;
}

function prettyName(pdfPath: string): string {
  const base = basename(pdfPath, extname(pdfPath));
  return base.replace("2024 CFA level I ", "").replace("2024 ", "");
}

function discoverUserVolumes(): VolumeRec[] {
  if (!existsSync(INPUT_DIR)) return [];
  return readdirSync(INPUT_DIR)
    .filter((fn) => fn.toLowerCase().endsWith(".pdf"))
    .sort()
    .map((fn) => {
      const name = basename(fn, ".pdf");
      const slug =
        name
          .replace(/[^A-Za-z0-9]+/g, "_")
          .replace(/^_|_$/g, "")
          .toLowerCase()
          .slice(0, 40) || "doc";
      return {
        pdf: join(INPUT_DIR, fn),
        workdir: join(USER_WORK, "user_" + slug),
        out: join(OUTPUT_DIR, name + "_vi.pdf"),
        user: true,
        tag: "user_" + slug,
        display: prettyName(fn),
      };
    });
}

export function loadVolumes(): VolumeRec[] {
  const raw = JSON.parse(readFileSync(MANIFEST, "utf8")) as Omit<
    VolumeRec,
    "tag" | "display"
  >[];
  const vols: VolumeRec[] = [
    ...raw.map((v) => ({
      ...v,
      tag: basename(v.workdir.replace(/\/$/, "")),
      display: prettyName(v.pdf),
    })),
    ...discoverUserVolumes(),
  ];
  return vols;
}

export function findVolume(tag: string): VolumeRec | null {
  return loadVolumes().find((v) => v.tag === tag) || null;
}

export function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(filePath: string, data: unknown) {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 1), "utf8");
}

export function runMetaPath(workdir: string) {
  return join(workdir, "run.json");
}

/**
 * Xoá output của MỘT stage để pipeline làm lại (resume-safe: các bước sau tự
 * chạy vì thiếu output). translate/verify xoá toàn bộ chunk-output; vision có
 * thể xoá theo TRANG cụ thể (chỉ soát lại đúng trang đó) hoặc toàn bộ.
 */
export function resetStage(
  workdir: string,
  stage: "translate" | "verify" | "vision",
  pages?: number[]
): void {
  const rm = (p: string) => {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  const pad = (n: number) => String(n).padStart(3, "0");
  if (stage === "translate") {
    rm(join(workdir, "out"));
    mkdirSync(join(workdir, "out"), { recursive: true });
    // fixes.json là bản rút gọn của bản dịch CŨ -> bỏ khi dịch lại.
    rm(join(workdir, "fixes.json"));
    // Artifacts verify được sinh từ bản dịch CŨ: nếu giữ, cmd_vchunk sẽ no-op
    // (đã có vchunks/) và merge-vr đè các sửa lỗi CŨ lên bản dịch MỚI -> bản
    // dịch lại gần như bị vứt bỏ. Xoá để verify chạy lại trên bản mới.
    rm(join(workdir, "vchunks"));
    rm(join(workdir, "vout"));
    mkdirSync(join(workdir, "vout"), { recursive: true });
    rm(join(workdir, "vid2en.json"));
  } else if (stage === "verify") {
    // Xoá cả vchunks/vid2en: vchunk chứa snapshot {en, vi} tại thời điểm tạo —
    // giữ lại thì lần verify sau đối chiếu bản vi CŨ thay vì text2vi hiện tại.
    rm(join(workdir, "vchunks"));
    rm(join(workdir, "vout"));
    mkdirSync(join(workdir, "vout"), { recursive: true });
    rm(join(workdir, "vid2en.json"));
  } else if (stage === "vision") {
    if (pages && pages.length) {
      for (const p of pages) {
        rm(join(workdir, "vis", `page_${pad(p)}.json`));
        rm(join(workdir, "review", `pair_${pad(p)}.png`));
      }
    } else {
      for (const d of ["vis", "review"]) {
        rm(join(workdir, d));
        mkdirSync(join(workdir, d), { recursive: true });
      }
      rm(join(workdir, "vis_todo.json"));
      rm(join(workdir, "review_issues.json"));
    }
  }
}

/** Engine chọn riêng cho 1 volume (ghi đè engine global). Lưu ở workdir/pref.json. */
export function loadEnginePref(workdir: string): string | undefined {
  const p = readJson(join(workdir, "pref.json"));
  return typeof p?.engine === "string" ? p.engine : undefined;
}

export function saveEnginePref(workdir: string, engine: string) {
  mkdirSync(workdir, { recursive: true });
  writeJson(join(workdir, "pref.json"), { engine });
}

export function loadRunMeta(workdir: string) {
  return readJson(runMetaPath(workdir));
}

export function saveRunMeta(workdir: string, meta: Record<string, unknown>) {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(runMetaPath(workdir), JSON.stringify(meta, null, 1), "utf8");
}

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function codexState(vol: VolumeRec) {
  return readJson(join(vol.workdir, "codex_state.json"));
}

export function codexDone(vol: VolumeRec): boolean {
  const s = codexState(vol);
  if (!s || !existsSync(vol.out)) return false;
  const last = s.last;
  const done = s.done_through;
  return (
    typeof last === "number" &&
    typeof done === "number" &&
    done >= last &&
    last >= 0
  );
}

function countFiles(dir: string, re: RegExp): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => re.test(f)).length;
  } catch {
    return 0;
  }
}

const SEV_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/**
 * Mirror python agent_pipeline._defect_pages — trang còn LỖI CẦN FIX (kind
 * 'defect', >= medium, chưa accepted) từ review_issues.json. Dùng để phân biệt
 * "đã review xong" với "đã sạch layout".
 */
export function defectPages(workdir: string, minSev = "medium"): number[] {
  const thr = SEV_RANK[minSev] || 1;
  const issues = readJson(join(workdir, "review_issues.json"));
  const acceptedRaw = readJson(join(workdir, "accepted.json"));
  const accepted = new Set<number>(
    Array.isArray(acceptedRaw?.pages) ? (acceptedRaw!.pages as number[]) : []
  );
  const arr = Array.isArray(issues) ? (issues as Record<string, unknown>[]) : [];
  const pages = new Set<number>();
  for (const x of arr) {
    const kind = (x.kind as string) || "defect";
    const sev = SEV_RANK[(x.severity as string) || "low"] || 1;
    const page = x.page as number;
    if (kind !== "fit" && sev >= thr && !accepted.has(page)) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Mirror python agent_pipeline._status — pure filesystem, no Python spawn
 * (fast enough for 3s UI poll of many volumes).
 */
export function pythonStatus(workdir: string): {
  stage: string;
  translate?: [number, number];
  verify?: [number, number];
  vision?: [number, number];
  defects?: number;
} {
  const c = countFiles(join(workdir, "chunks"), /^c_.*\.json$/i);
  const co = countFiles(join(workdir, "out"), /^c_.*\.json$/i);
  const v = countFiles(join(workdir, "vchunks"), /^v_.*\.json$/i);
  const vo = countFiles(join(workdir, "vout"), /^v_.*\.json$/i);
  const pairs = countFiles(join(workdir, "review"), /^pair_.*\.png$/i);
  const vis = countFiles(join(workdir, "vis"), /^page_.*\.json$/i);

  // Total page count. state.json (written by python cmd_status) is the
  // authoritative source and is preferred FIRST — layout.json stores a pdf path
  // relative to the python cwd, so existsSync() on it fails from the daemon and
  // must not gate the page count. `pairs` is a last resort and can overcount
  // when stale re-render PNGs linger (would wrongly keep a volume in 'vision').
  let pages: number | null = null;
  const cached = readJson(join(workdir, "state.json"));
  if (cached?.vision && Array.isArray(cached.vision) && cached.vision[1]) {
    pages = Number(cached.vision[1]) || null;
  }
  if (pages == null && pairs > 0) pages = pairs;

  const defects = defectPages(workdir).length;
  // 'done' chỉ khi review_issues.json đã ghi (merge-vis xong) — thiếu nghĩa là
  // vision chưa chốt, tránh 'done' giả (mirror python _status).
  const hasReview = existsSync(join(workdir, "review_issues.json"));
  let stage: string;
  if (c === 0 || co < c) stage = "translate";
  else if (vo < v || v === 0) stage = "verify";
  else if (pages != null && (vis < pages || !hasReview)) stage = "vision";
  else if (c > 0 && co >= c && (v === 0 || vo >= v) && (pages == null || vis >= pages))
    // Đã review xong mọi trang: 'review' nếu còn defect chưa fix, ngược lại 'done'.
    stage = defects > 0 ? "review" : "done";
  else stage = "vision";

  return {
    stage,
    translate: [co, c],
    verify: [vo, v],
    vision: [vis, pages ?? 0],
    defects,
  };
}

export function effectiveStage(
  raw: string | undefined,
  cfg: AppConfig
): string {
  if (raw === "vision" && !cfg.vision) return "done";
  return raw || "translate";
}

export function pdfPageCount(path: string): number {
  if (!existsSync(path)) return 0;
  const script = `
import sys
try:
  import fitz
  d=fitz.open(sys.argv[1]); print(d.page_count)
except Exception:
  print(0)
`;
  const r = spawnSync(pythonBin(), ["-c", script, path], {
    encoding: "utf8",
    timeout: 15000,
  });
  return parseInt((r.stdout || "0").trim(), 10) || 0;
}

export function renderPagePng(
  path: string,
  page: number,
  dpi: number
): Buffer | null {
  // Disk cache keyed by (source path, mtime, page, dpi). /api/page renders one
  // page per spawnSync on the daemon's single thread; a library grid of covers
  // would otherwise serialize dozens of ~1s Python spawns and stall status/log/
  // run/stop. Rendering the SAME page again (invariant until the file changes)
  // is served from cache — no spawn.
  let cacheFile: string | null = null;
  try {
    const mtime = Math.floor(statSync(path).mtimeMs);
    const key = createHash("sha1")
      .update(`${path}|${mtime}|${page}|${dpi}`)
      .digest("hex");
    const dir = join(TOOL_DIR, "pagecache");
    cacheFile = join(dir, key + ".png");
    if (existsSync(cacheFile)) return readFileSync(cacheFile);
    mkdirSync(dir, { recursive: true });
  } catch {
    cacheFile = null;
  }

  const script = `
import sys, fitz
doc=fitz.open(sys.argv[1])
page=int(sys.argv[2]); dpi=int(sys.argv[3])
if not (0<=page<doc.page_count):
  sys.exit(2)
sys.stdout.buffer.write(doc[page].get_pixmap(dpi=dpi).tobytes("png"))
`;
  const r = spawnSync(pythonBin(), ["-c", script, path, String(page), String(dpi)], {
    encoding: "buffer",
    maxBuffer: 40 * 1024 * 1024,
    timeout: 30000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  const png = r.stdout as Buffer;
  if (cacheFile) {
    try {
      writeFileSync(cacheFile, png);
    } catch {
      /* cache best-effort */
    }
  }
  return png;
}

export function volumeToApi(
  vol: VolumeRec,
  cfg: AppConfig,
  running: boolean
): Volume {
  let st: ReturnType<typeof pythonStatus> = { stage: "translate" };
  try {
    st = pythonStatus(vol.workdir);
  } catch {
    /* ignore */
  }
  let stage = effectiveStage(st.stage, cfg);
  // codexDone chỉ đánh 'done' khi KHÔNG còn defect layout — nếu vision đã phát
  // hiện lỗi (stage 'review'), không được ghi đè thành 'done'.
  if (codexDone(vol) && stage !== "review") stage = "done";

  const meta = loadRunMeta(vol.workdir) || {};
  return {
    tag: vol.tag,
    display: vol.display,
    stage,
    running,
    skip: !!vol.skip,
    user: !!vol.user,
    translate: st.translate,
    verify: st.verify,
    vision: st.vision,
    out_exists: existsSync(vol.out),
    engine: typeof meta.engine === "string" ? meta.engine : undefined,
    logpath: join(vol.workdir, "run.log"),
    sid: typeof meta.sid === "string" ? meta.sid : undefined,
    mode: typeof meta.mode === "string" ? meta.mode : undefined,
    rc: typeof meta.rc === "number" ? meta.rc : null,
    defects: st.defects,
    pref_engine: loadEnginePref(vol.workdir),
    // Total page count when known (st.vision = [reviewed, totalPages]); lets the
    // Home/Library UI show real page totals for completed volumes.
    pages: st.vision && st.vision[1] ? st.vision[1] : undefined,
  };
}
