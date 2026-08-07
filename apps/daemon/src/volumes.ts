import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig, ReaderTextSpan, Volume } from "@cfa-translate/shared";
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

interface UserDocumentMeta {
  version: 1;
  document_id: string;
  source_sha256: string;
  original_name: string;
  stored_name: string;
}

function userSlug(name: string): string {
  return (
    basename(name, extname(name))
      .normalize("NFC")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .toLowerCase()
      .slice(0, 40) || "doc"
  );
}

/** Stable UI/workdir tag: readable stem + filename discriminator + content id. */
export function userDocumentTag(originalName: string, documentId: string): string {
  const nameId = createHash("sha256")
    .update(basename(originalName).normalize("NFC"))
    .digest("hex")
    .slice(0, 6);
  return `user_${userSlug(originalName)}_${nameId}_${documentId.slice(0, 12)}`;
}

function readUserDocumentMeta(pdfPath: string): UserDocumentMeta | null {
  const raw = readJson(pdfPath + ".cfa.json") as Partial<UserDocumentMeta> | null;
  if (
    raw?.version !== 1 ||
    typeof raw.document_id !== "string" ||
    !/^[a-f0-9]{64}$/i.test(raw.document_id) ||
    typeof raw.source_sha256 !== "string" ||
    raw.source_sha256 !== raw.document_id ||
    typeof raw.original_name !== "string" ||
    basename(raw.original_name) !== raw.original_name ||
    typeof raw.stored_name !== "string" ||
    basename(pdfPath) !== raw.stored_name
  ) {
    return null;
  }
  return raw as UserDocumentMeta;
}

function discoverUserVolumes(): VolumeRec[] {
  if (!existsSync(INPUT_DIR)) return [];
  return readdirSync(INPUT_DIR)
    .filter((fn) => fn.toLowerCase().endsWith(".pdf"))
    .sort()
    .map((fn) => {
      const pdf = join(INPUT_DIR, fn);
      const meta = readUserDocumentMeta(pdf);
      const originalName = meta?.original_name || fn;
      const name = basename(originalName, extname(originalName));
      // Legacy files retain their old tag/workdir. New uploads are immutable
      // content-addressed records and cannot collide on slug alone.
      const tag = meta
        ? userDocumentTag(originalName, meta.document_id)
        : "user_" + userSlug(fn);
      return {
        pdf,
        workdir: join(USER_WORK, tag),
        out: join(
          OUTPUT_DIR,
          meta ? `${name}.${meta.document_id.slice(0, 12)}_vi.pdf` : name + "_vi.pdf"
        ),
        user: true,
        tag,
        display: prettyName(originalName),
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
    // Vision chấm trên PDF/segmentation cũ — invalidate giống chunk --force.
    rm(join(workdir, "vis"));
    mkdirSync(join(workdir, "vis"), { recursive: true });
    rm(join(workdir, "review_issues.json"));
    rm(join(workdir, "vis_todo.json"));
    // Clear later-stage gens in workset; keep chunk_gen if present.
    try {
      const wsPath = join(workdir, "workset.json");
      const ws = (readJson(wsPath) || {}) as Record<string, unknown>;
      delete ws.vchunk_gen;
      delete ws.vision_gen;
      writeFileSync(wsPath, JSON.stringify(ws, null, 1));
    } catch {
      /* ignore */
    }
  } else if (stage === "verify") {
    // Xoá cả vchunks/vid2en: vchunk chứa snapshot {en, vi} tại thời điểm tạo —
    // giữ lại thì lần verify sau đối chiếu bản vi CŨ thay vì text2vi hiện tại.
    rm(join(workdir, "vchunks"));
    rm(join(workdir, "vout"));
    mkdirSync(join(workdir, "vout"), { recursive: true });
    rm(join(workdir, "vid2en.json"));
    try {
      const wsPath = join(workdir, "workset.json");
      const ws = (readJson(wsPath) || {}) as Record<string, unknown>;
      delete ws.vchunk_gen;
      delete ws.vision_gen;
      writeFileSync(wsPath, JSON.stringify(ws, null, 1));
    } catch {
      /* ignore */
    }
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

function listIndices(dir: string, re: RegExp): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => {
        const m = f.match(/_(\d+)\.json$/i);
        return m ? m[1] : "";
      })
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function loadJsonFile(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Mirror python _is_valid_out: dict covering all chunk ids with non-empty vi. */
function isValidOut(workdir: string, idx: string): boolean {
  const items = loadJsonFile(join(workdir, "chunks", `c_${idx}.json`));
  const d = loadJsonFile(join(workdir, "out", `c_${idx}.json`));
  if (!Array.isArray(items) || !d || typeof d !== "object" || Array.isArray(d))
    return false;
  const map = d as Record<string, unknown>;
  if (items.length === 0) return true;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const cid = (it as { id?: string }).id;
    if (!cid) continue;
    const vi = map[cid];
    if (vi == null || !String(vi).trim()) return false;
  }
  return true;
}

/** Mirror python _is_valid_vout: dict JSON (empty OK) matching vchunk. */
function isValidVout(workdir: string, idx: string): boolean {
  const items = loadJsonFile(join(workdir, "vchunks", `v_${idx}.json`));
  const d = loadJsonFile(join(workdir, "vout", `v_${idx}.json`));
  return Array.isArray(items) && !!d && typeof d === "object" && !Array.isArray(d);
}

/** Mirror python _is_valid_vis: list (empty = clean page, still reviewed). */
function isValidVis(workdir: string, page: number): boolean {
  const d = loadJsonFile(
    join(workdir, "vis", `page_${String(page).padStart(3, "0")}.json`)
  );
  return Array.isArray(d);
}

function countValidOut(workdir: string): [number, number] {
  const idxs = listIndices(join(workdir, "chunks"), /^c_\d+\.json$/i);
  return [idxs.filter((i) => isValidOut(workdir, i)).length, idxs.length];
}

function countValidVout(workdir: string): [number, number] {
  const idxs = listIndices(join(workdir, "vchunks"), /^v_\d+\.json$/i);
  return [idxs.filter((i) => isValidVout(workdir, i)).length, idxs.length];
}

function countValidVis(workdir: string, pages: number | null): [number, number] {
  if (pages == null || pages <= 0) return [0, 0];
  let done = 0;
  for (let i = 0; i < pages; i++) if (isValidVis(workdir, i)) done++;
  return [done, pages];
}

function maxMtime(paths: string[]): number {
  let mt = 0;
  for (const p of paths) {
    try {
      mt = Math.max(mt, statSync(p).mtimeMs);
    } catch {
      /* skip */
    }
  }
  return mt;
}

function listPaths(dir: string, re: RegExp): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Mirror python _chunk_gen — fingerprint of chunks/c_*.json content.
 * Used with workset.json generation gate so stale vout/vis after re-chunk
 * never count as complete once outs are refilled.
 */
function chunkGen(workdir: string): string {
  const files = listPaths(join(workdir, "chunks"), /^c_\d+\.json$/i).sort();
  if (!files.length) return "";
  const h = createHash("md5");
  for (const f of files) {
    h.update(f.split(/[/\\]/).pop() || f);
    try {
      h.update(readFileSync(f));
    } catch {
      h.update("?");
    }
  }
  return h.digest("hex");
}

/** Mirror python _verify_matches_chunks */
function verifyMatchesChunks(workdir: string): boolean {
  const cg = chunkGen(workdir);
  if (!cg) return false;
  const ws = (readJson(join(workdir, "workset.json")) || {}) as Record<
    string,
    unknown
  >;
  // Explicit key (even empty after force) → must equal chunk_gen; no mtime fallthrough.
  if (Object.prototype.hasOwnProperty.call(ws, "vchunk_gen")) {
    const vg = String(ws.vchunk_gen || "");
    return !!vg && vg === cg;
  }
  const vfiles = listPaths(join(workdir, "vchunks"), /^v_\d+\.json$/i);
  const cfiles = listPaths(join(workdir, "chunks"), /^c_\d+\.json$/i);
  if (!vfiles.length || !cfiles.length) return false;
  return maxMtime(vfiles) >= maxMtime(cfiles);
}

/** Mirror python _vision_matches_chunks */
function visionMatchesChunks(workdir: string): boolean {
  const cg = chunkGen(workdir);
  if (!cg) return false;
  const ws = (readJson(join(workdir, "workset.json")) || {}) as Record<
    string,
    unknown
  >;
  if (Object.prototype.hasOwnProperty.call(ws, "vision_gen")) {
    const vg = String(ws.vision_gen || "");
    return !!vg && vg === cg;
  }
  const ri = join(workdir, "review_issues.json");
  if (!existsSync(ri)) return false;
  const vfiles = listPaths(join(workdir, "vis"), /^page_\d+\.json$/i);
  const cfiles = listPaths(join(workdir, "chunks"), /^c_\d+\.json$/i);
  if (!vfiles.length || !cfiles.length) return false;
  const cmt = maxMtime(cfiles);
  return maxMtime(vfiles) >= cmt && maxMtime([ri]) >= cmt;
}

/** Sequential overall % — mirror python _overall_pct. */
export function overallPct(
  stage: string,
  translate: [number, number],
  verify: [number, number],
  vision: [number, number]
): number {
  if (stage === "done") return 100;
  const frac = (pair: [number, number]) => {
    if (!pair[1]) return 0;
    return Math.max(0, Math.min(1, pair[0] / pair[1]));
  };
  if (stage === "translate") return Math.round(40 * frac(translate));
  if (stage === "verify") return Math.round(40 + 30 * frac(verify));
  if (stage === "vision") return Math.round(70 + 25 * frac(vision));
  if (stage === "review") return 95;
  return 0;
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
 * Counts only VALID checkpoints; gates later-stage done when earlier incomplete.
 */
export function pythonStatus(workdir: string): {
  stage: string;
  translate?: [number, number];
  verify?: [number, number];
  vision?: [number, number];
  defects?: number;
  overall_pct?: number;
} {
  const [co, c] = countValidOut(workdir);
  const pairs = countFiles(join(workdir, "review"), /^pair_.*\.png$/i);

  // Total page count. state.json (written by python cmd_status) is preferred —
  // layout.json pdf path is relative to python cwd and often fails existsSync.
  let pages: number | null = null;
  const cached = readJson(join(workdir, "state.json"));
  if (cached?.vision && Array.isArray(cached.vision) && cached.vision[1]) {
    pages = Number(cached.vision[1]) || null;
  }
  if (pages == null && pairs > 0) pages = pairs;

  const trDone = c > 0 && co >= c;
  const verifyOk = verifyMatchesChunks(workdir);
  const visionOk = visionMatchesChunks(workdir);
  const vTotal = verifyOk
    ? listIndices(join(workdir, "vchunks"), /^v_\d+\.json$/i).length
    : 0;

  // Generation gate: after force-rechunk, stale vout/vis must not count even
  // when outs are fully refilled (criterion 2 / skeptic residual).
  if (!trDone) {
    const defects = defectPages(workdir).length;
    const tr: [number, number] = [co, c];
    const vr: [number, number] = [0, vTotal];
    const vis: [number, number] = [0, pages ?? 0];
    return {
      stage: "translate",
      translate: tr,
      verify: vr,
      vision: vis,
      defects,
      overall_pct: overallPct("translate", tr, vr, vis),
    };
  }

  if (!verifyOk) {
    const defects = defectPages(workdir).length;
    const tr: [number, number] = [co, c];
    const vr: [number, number] = [0, 0];
    const vis: [number, number] = [0, pages ?? 0];
    return {
      stage: "verify",
      translate: tr,
      verify: vr,
      vision: vis,
      defects,
      overall_pct: overallPct("verify", tr, vr, vis),
    };
  }

  const [vo, v] = countValidVout(workdir);
  const vrDone = v > 0 && vo >= v;
  if (!vrDone) {
    const defects = defectPages(workdir).length;
    const tr: [number, number] = [co, c];
    const vr: [number, number] = [vo, v];
    const vis: [number, number] = [0, pages ?? 0];
    return {
      stage: "verify",
      translate: tr,
      verify: vr,
      vision: vis,
      defects,
      overall_pct: overallPct("verify", tr, vr, vis),
    };
  }

  let visRaw = 0;
  let hasReview = false;
  let defects = 0;
  if (visionOk) {
    [visRaw] = countValidVis(workdir, pages);
    hasReview = existsSync(join(workdir, "review_issues.json"));
    defects = defectPages(workdir).length;
  }

  let stage: string;
  if (pages != null && (visRaw < pages || !hasReview)) stage = "vision";
  else if (defects > 0) stage = "review";
  else stage = "done";

  const tr: [number, number] = [co, c];
  const vr: [number, number] = [vo, v];
  const vis: [number, number] = [visRaw, pages ?? 0];

  return {
    stage,
    translate: tr,
    verify: vr,
    vision: vis,
    defects,
    overall_pct: overallPct(stage, tr, vr, vis),
  };
}

export function effectiveStage(
  raw: string | undefined,
  cfg: AppConfig
): string {
  if (raw === "vision" && !cfg.vision) return "done";
  return raw || "translate";
}

type ReaderTextPageData = {
  page_size: [number, number];
  spans: ReaderTextSpan[];
};

export type PdfJobPriority = "interactive" | "thumbnail";

// PyMuPDF imports are CPU/memory-heavy. Keep the daemon responsive by running
// them asynchronously with a small global bound; reader work jumps ahead of
// thumbnail backlog when a slot becomes available.
const PDF_WORKER_LIMIT = 2;
let activePdfWorkers = 0;
const interactivePdfJobs: Array<() => void> = [];
const thumbnailPdfJobs: Array<() => void> = [];

function schedulePdfJob<T>(
  run: () => Promise<T>,
  priority: PdfJobPriority = "interactive"
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      activePdfWorkers++;
      Promise.resolve()
        .then(run)
        .then(resolve, reject)
        .finally(() => {
          activePdfWorkers--;
          const next = interactivePdfJobs.shift() || thumbnailPdfJobs.shift();
          next?.();
        });
    };
    if (activePdfWorkers < PDF_WORKER_LIMIT) start();
    else if (priority === "thumbnail") thumbnailPdfJobs.push(start);
    else interactivePdfJobs.push(start);
  });
}

function execPdfText(
  args: string[],
  timeout: number,
  maxBuffer: number
): Promise<string | null> {
  return schedulePdfJob(
    () =>
      new Promise((resolve) => {
        execFile(
          pythonBin(),
          args,
          { encoding: "utf8", timeout, maxBuffer },
          (error, stdout) => resolve(error || !stdout ? null : String(stdout))
        );
      })
  );
}

function execPdfBuffer(
  args: string[],
  timeout: number,
  maxBuffer: number,
  priority: PdfJobPriority
): Promise<Buffer | null> {
  return schedulePdfJob(
    () =>
      new Promise((resolve) => {
        execFile(
          pythonBin(),
          args,
          { encoding: "buffer", timeout, maxBuffer },
          (error, stdout) => {
            if (error || !stdout) resolve(null);
            else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
          }
        );
      }),
    priority
  );
}

function fileRevision(path: string): string | null {
  try {
    const st = statSync(path);
    return `${path}|${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

function cachePath(kind: string, revision: string, suffix: string): string {
  const key = createHash("sha1").update(`${kind}|${revision}`).digest("hex");
  return join(TOOL_DIR, "pagecache", key + suffix);
}

async function writeCacheAtomic(path: string, data: string | Buffer): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    await writeFile(temp, data);
    await rename(temp, path);
  } catch {
    await unlink(temp).catch(() => {});
  }
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): V {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return value;
}

const pageCountCache = new Map<string, number>();
const pageCountInflight = new Map<string, Promise<number>>();

export async function pdfPageCount(path: string): Promise<number> {
  const revision = fileRevision(path);
  if (!revision) return 0;
  const cached = pageCountCache.get(revision);
  if (cached !== undefined) return remember(pageCountCache, revision, cached, 64);
  const inflight = pageCountInflight.get(revision);
  if (inflight) return inflight;

  const promise = (async () => {
    const diskPath = cachePath("page-count-v1", revision, ".txt");
    try {
      const diskValue = parseInt(await readFile(diskPath, "utf8"), 10);
      if (Number.isSafeInteger(diskValue) && diskValue > 0) {
        return remember(pageCountCache, revision, diskValue, 64);
      }
    } catch {
      /* cache miss */
    }

    const script = `
import sys
try:
  import fitz
  d=fitz.open(sys.argv[1]); print(d.page_count)
except Exception:
  print(0)
`;
    const stdout = await execPdfText(
      ["-c", script, path],
      15_000,
      1024 * 1024
    );
    const pages = parseInt((stdout || "0").trim(), 10) || 0;
    if (pages > 0) {
      remember(pageCountCache, revision, pages, 64);
      await writeCacheAtomic(diskPath, String(pages));
    }
    return pages;
  })().finally(() => pageCountInflight.delete(revision));
  pageCountInflight.set(revision, promise);
  return promise;
}

function parseReaderTextPage(value: unknown): ReaderTextPageData | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as { page_size?: unknown; spans?: unknown };
  if (
    !Array.isArray(parsed.page_size) ||
    parsed.page_size.length !== 2 ||
    !parsed.page_size.every(
      (part) => typeof part === "number" && Number.isFinite(part) && part > 0
    ) ||
    !Array.isArray(parsed.spans)
  ) {
    return null;
  }
  const spans = parsed.spans.filter((value): value is ReaderTextSpan => {
    if (!value || typeof value !== "object") return false;
    const span = value as Partial<ReaderTextSpan>;
    return (
      typeof span.id === "string" &&
      typeof span.text === "string" &&
      typeof span.font_size === "number" &&
      Number.isFinite(span.font_size) &&
      Array.isArray(span.box) &&
      span.box.length === 4 &&
      span.box.every(
        (part) => typeof part === "number" && Number.isFinite(part)
      )
    );
  });
  return {
    page_size: [parsed.page_size[0] as number, parsed.page_size[1] as number],
    spans,
  };
}

const pageTextCache = new Map<string, ReaderTextPageData>();
const pageTextInflight = new Map<string, Promise<ReaderTextPageData | null>>();

export async function extractPageText(
  path: string,
  page: number
): Promise<ReaderTextPageData | null> {
  if (!Number.isSafeInteger(page) || page < 0) return null;
  const revision = fileRevision(path);
  if (!revision) return null;
  const key = `${revision}|${page}`;
  const cached = pageTextCache.get(key);
  if (cached) return remember(pageTextCache, key, cached, 128);
  const inflight = pageTextInflight.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const diskPath = cachePath("reader-text-v1", key, ".json");
    try {
      const parsed = parseReaderTextPage(
        JSON.parse(await readFile(diskPath, "utf8"))
      );
      if (parsed) return remember(pageTextCache, key, parsed, 128);
    } catch {
      /* cache miss */
    }

    const script = `
import json, math, sys, fitz
doc = fitz.open(sys.argv[1])
page_no = int(sys.argv[2])
if not (0 <= page_no < doc.page_count):
  sys.exit(2)
page = doc[page_no]
data = page.get_text("dict", sort=True)
spans = []
for block in data.get("blocks", []):
  if block.get("type") != 0:
    continue
  for line in block.get("lines", []):
    for span in line.get("spans", []):
      text = span.get("text", "")
      box = span.get("bbox", [])
      size = span.get("size", 0)
      if not text.strip() or len(box) != 4:
        continue
      values = [float(v) for v in box]
      if not all(math.isfinite(v) for v in values) or not math.isfinite(float(size)):
        continue
      flags = int(span.get("flags", 0))
      spans.append({
        "id": "t" + str(len(spans)),
        "text": text,
        "box": values,
        "font_size": float(size),
        "bold": bool(flags & 16),
        "italic": bool(flags & 2),
      })
print(json.dumps({
  "page_size": [float(page.rect.width), float(page.rect.height)],
  "spans": spans,
}, ensure_ascii=False))
`;
    const stdout = await execPdfText(
      ["-c", script, path, String(page)],
      15_000,
      16 * 1024 * 1024
    );
    if (!stdout) return null;
    try {
      const parsed = parseReaderTextPage(JSON.parse(stdout));
      if (!parsed) return null;
      remember(pageTextCache, key, parsed, 128);
      await writeCacheAtomic(diskPath, JSON.stringify(parsed));
      return parsed;
    } catch {
      return null;
    }
  })().finally(() => pageTextInflight.delete(key));
  pageTextInflight.set(key, promise);
  return promise;
}

const rasterMemoryCache = new Map<string, Buffer>();
const rasterInflight = new Map<string, Promise<Buffer | null>>();
const RASTER_MEMORY_LIMIT = 24 * 1024 * 1024;
let rasterMemoryBytes = 0;

function rememberRaster(key: string, png: Buffer): Buffer {
  const previous = rasterMemoryCache.get(key);
  if (previous) rasterMemoryBytes -= previous.byteLength;
  rasterMemoryCache.delete(key);
  if (png.byteLength > RASTER_MEMORY_LIMIT) return png;
  rasterMemoryCache.set(key, png);
  rasterMemoryBytes += png.byteLength;
  while (rasterMemoryBytes > RASTER_MEMORY_LIMIT) {
    const oldest = rasterMemoryCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const removed = rasterMemoryCache.get(oldest);
    rasterMemoryCache.delete(oldest);
    rasterMemoryBytes -= removed?.byteLength || 0;
  }
  return png;
}

export async function renderPagePng(
  path: string,
  page: number,
  dpi: number,
  priority: PdfJobPriority = "interactive"
): Promise<Buffer | null> {
  const revision = fileRevision(path);
  if (!revision) return null;
  const key = `${revision}|${page}|${dpi}`;
  const memory = rasterMemoryCache.get(key);
  if (memory) return rememberRaster(key, memory);
  const inflight = rasterInflight.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const diskPath = cachePath("raster-v3", key, ".png");
    try {
      const png = await readFile(diskPath);
      if (png.length) return rememberRaster(key, png);
    } catch {
      /* cache miss */
    }

    const script = `
import sys, fitz
doc=fitz.open(sys.argv[1])
page=int(sys.argv[2]); dpi=int(sys.argv[3])
if not (0<=page<doc.page_count):
  sys.exit(2)
p=doc[page]
scale=dpi/72
max_pixels=12000000
requested=max(1, int(p.rect.width*scale+0.999)) * max(1, int(p.rect.height*scale+0.999))
if requested > max_pixels:
  scale *= (max_pixels/requested) ** 0.5
sys.stdout.buffer.write(p.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).tobytes("png"))
`;
    const png = await execPdfBuffer(
      ["-c", script, path, String(page), String(dpi)],
      30_000,
      40 * 1024 * 1024,
      priority
    );
    if (!png) return null;
    rememberRaster(key, png);
    await writeCacheAtomic(diskPath, png);
    return png;
  })().finally(() => rasterInflight.delete(key));
  rasterInflight.set(key, promise);
  return promise;
}

interface RenderReportCacheEntry {
  revision: string;
  pages: Map<number, Record<string, unknown>[]>;
  pageSizes: unknown[];
  reviewCount: number;
  generatedAt?: string;
}

const renderReportCache = new Map<string, RenderReportCacheEntry>();

export function loadRenderReportPage(
  workdir: string,
  page: number
): {
  page_size: [number, number] | null;
  blocks: Record<string, unknown>[];
  review_count: number;
  generated_at?: string;
} | null {
  const path = join(workdir, "render_report.json");
  const revision = fileRevision(path);
  if (!revision) return null;
  let entry = renderReportCache.get(path);
  if (!entry || entry.revision !== revision) {
    const raw = readJson(path);
    if (!raw || !Array.isArray(raw.segments)) return null;
    const pages = new Map<number, Record<string, unknown>[]>();
    for (const value of raw.segments) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const segment = value as Record<string, unknown>;
      const pageNumber = Number(segment.page);
      if (!Number.isInteger(pageNumber) || typeof segment.id !== "string") continue;
      const list = pages.get(pageNumber) || [];
      list.push(segment);
      pages.set(pageNumber, list);
    }
    entry = {
      revision,
      pages,
      pageSizes: Array.isArray(raw.page_sizes) ? raw.page_sizes : [],
      reviewCount: Number(raw.review_count || 0),
      generatedAt:
        typeof raw.generated_at === "string" ? raw.generated_at : undefined,
    };
  }
  remember(renderReportCache, path, entry, 3);
  const rawSize = entry.pageSizes[page];
  const pageSize =
    Array.isArray(rawSize) && rawSize.length >= 2
      ? ([Number(rawSize[0]), Number(rawSize[1])] as [number, number])
      : null;
  return {
    page_size: pageSize,
    blocks: entry.pages.get(page) || [],
    review_count: entry.reviewCount,
    ...(entry.generatedAt ? { generated_at: entry.generatedAt } : {}),
  };
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
    overall_pct: st.overall_pct,
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
