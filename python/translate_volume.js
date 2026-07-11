export const meta = {
  name: 'translate-volume',
  description: 'Dịch CFA sang tiếng Việt giữ layout: translate → verify → apply → vision. Resume được (checkpoint theo file). Chạy 1 volume hoặc cả manifest 10 volume.',
  whenToUse: 'Dịch/tiếp tục 1 volume: args={pdf,workdir,out,vision}. Cả bộ: args={} hoặc {manifest}. Hết token gọi lại là tự chạy tiếp.',
  phases: [
    { title: 'Translate', detail: 'fan-out dịch các chunk còn thiếu out/' },
    { title: 'Verify', detail: 'đối chiếu số/bỏ sót vs bản Anh, sửa vào cache' },
    { title: 'Apply', detail: 'ghi đè giữ layout -> file đích' },
    { title: 'Vision', detail: 'review layout từng trang còn thiếu vis/' },
    { title: 'Fix', detail: 'rút gọn bản dịch tràn khung -> re-apply -> re-vision tới khi hết defect' },
  ],
}

// ---- args ---- (chấp nhận cả object lẫn JSON string)
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const TOOL = A.tool || '/Users/khanhnm/Desktop/translate/python'
const PY = `cd ${TOOL} && python3 agent_pipeline.py`
const MANIFEST = A.manifest || `${TOOL}/volumes.json`
const STOP_BUDGET = 200_000   // còn dưới mức này thì không bắt đầu volume mới

const SH = { type: 'object', properties: { stdout: { type: 'string' } }, required: ['stdout'] }
async function sh(cmd, label) {
  const r = await agent(
    `Chạy CHÍNH XÁC lệnh bash sau, không thêm gì:\n\n${cmd}\n\n` +
    `Trả về trong field "stdout" đúng DÒNG CUỐI mà lệnh in ra stdout (thường là JSON). Không bịa.`,
    { label, model: 'haiku', effort: 'low', schema: SH })
  return r ? r.stdout : ''
}
function parseList(s) { try { const d = JSON.parse(s); return Array.isArray(d) ? d : [] } catch { return [] } }

const STYLE =
  'Dịch sang tiếng Việt tự nhiên, văn phong học thuật tài chính. ' +
  'GIỮ NGUYÊN thuật ngữ tiếng Anh trong ngoặc đơn ở lần xuất hiện đầu, ví dụ "lãi suất chiết khấu (discount rate)". ' +
  'GIỮ NGUYÊN mọi con số, ký hiệu, công thức, mã (LOS, §). KHÔNG bỏ sót ý. Không thêm lời bình.'

const pad = p => String(p).padStart(3, '0')

// Prompt review layout 1 trang (ảnh ghép gốc|dịch) -> ghi vis/page_XXX.json.
// Dùng cho cả vision lần đầu lẫn re-vision trong vòng auto-fix.
const visPrompt = (WD, p) =>
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
  `Trang ổn thì ghi []. File này là checkpoint resume — BẮT BUỘC phải ghi. Không in gì khác.`

// Số vòng auto-fix tối đa (rút gọn bản dịch tràn khung -> re-apply -> re-vision).
const MAX_FIX_ROUNDS = 2

// ===== Dịch trọn 1 volume (mỗi phase chỉ làm unit còn thiếu output) =====
async function runVolume(V) {
  const PDF = V.pdf, WD = V.workdir, OUT = V.out, VISION = V.vision !== false
  const tag = WD.split('/').pop()
  const onlyVision = V.only === 'vision'   // bỏ qua translate/verify/apply (đã current)
  // Resume ở stage 'review': translate/verify/vision đã xong, chỉ còn defect ->
  // NHẢY THẲNG vào vòng auto-fix, KHÔNG re-apply/re-vision cả cuốn (apply ghi đè
  // OUT khiến mọi ảnh pair stale -> vision lại toàn bộ). Dùng checkpoint sẵn có.
  const reviewOnly = V.stage === 'review'
  const skipTranslate = onlyVision || reviewOnly
  let ap = reviewOnly ? 'skipped (review resume)' : 'skipped (only=vision)'

  // -- Translate --
  if (!skipTranslate) {
  phase('Translate')
  await sh(`${PY} chunk "${PDF}" "${WD}"`, `${tag}:chunk`)
  const pend = parseList(await sh(`${PY} pending "${WD}" translate`, `${tag}:scan-tr`))
  log(`[${tag}] translate: ${pend.length} chunk còn lại`)
  if (pend.length) {
    await parallel(pend.map(u => () => agent(
      `Đọc file JSON: ${u.in} (mảng các {id, text} tiếng Anh).\n${STYLE}\n` +
      `Ghi kết quả ra ${u.out} dạng JSON object {id: "bản dịch tiếng Việt"} cho MỌI id. ` +
      `Dùng tool Write. Chỉ ghi file, không in gì khác.`,
      { label: `${tag} tr:${u.idx}`, phase: 'Translate' })))
  }
  await sh(`${PY} merge-tr "${PDF}" "${WD}"`, `${tag}:merge-tr`)

  // -- Verify --
  phase('Verify')
  await sh(`${PY} vchunk "${PDF}" "${WD}"`, `${tag}:vchunk`)
  const vpend = parseList(await sh(`${PY} pending "${WD}" verify`, `${tag}:scan-vr`))
  log(`[${tag}] verify: ${vpend.length} vchunk còn lại`)
  if (vpend.length) {
    await parallel(vpend.map(u => () => agent(
      `Đọc file JSON: ${u.in} (mảng {id, en, vi}: en = bản gốc tiếng Anh, vi = bản dịch hiện tại).\n` +
      `Với MỖI mục, đối chiếu vi với en, tập trung: SAI/THIẾU con số, đơn vị, ký hiệu, bỏ sót câu/ý, dịch sai nghĩa. ` +
      `Nếu cần sửa thì sửa; nếu vi đã đúng thì giữ nguyên. ${STYLE}\n` +
      `Ghi ra ${u.out} dạng JSON {id: "bản vi đúng nhất"} cho MỌI id. Dùng tool Write. Chỉ ghi file.`,
      { label: `${tag} vr:${u.idx}`, phase: 'Verify' })))
  }
  await sh(`${PY} merge-vr "${WD}"`, `${tag}:merge-vr`)

  // -- Apply --
  phase('Apply')
  ap = await sh(`${PY} apply "${PDF}" "${WD}" "${OUT}"`, `${tag}:apply`)
  log(`[${tag}] ${ap}`)
  } // hết khối !onlyVision

  // -- Vision -- (theo CỬA SỔ nhỏ: pending chỉ trả số trang trong [w,w+STEP),
  // tránh shuttle JSON lớn qua agent rồi mất dữ liệu)
  let vis = 'skipped'
  if (VISION || reviewOnly || onlyVision) {
    // Bỏ qua vision lần đầu khi resume review (checkpoint đã đủ) -> vào fix loop.
    if (!reviewOnly) {
      phase('Vision')
      // V.visPages (csv 0-based): redo theo trang — CHỈ re-render các trang đó.
      // Không giới hạn thì mọi pair cũ hơn OUT bị coi stale -> xoá sạch verdict.
      await sh(`${PY} vis-pages "${PDF}" "${OUT}" "${WD}"${V.visPages ? ` ${V.visPages}` : ''}`, `${tag}:render`)
      let total = 0
      try { total = (JSON.parse(await sh(`${PY} status "${WD}"`, `${tag}:total`)).vision || [0, 0])[1] || 0 } catch {}
      const lo0 = V.visFrom || 0
      const hi0 = V.visTo != null ? V.visTo : total
      const STEP = 30
      let reviewed = 0
      for (let w = lo0; w < hi0; w += STEP) {
        const hw = Math.min(w + STEP, hi0)
        const pages = parseList(await sh(`${PY} pending "${WD}" vision ${w} ${hw}`, `${tag}:scan-vis ${w}`))
        if (!pages.length) continue
        reviewed += pages.length
        await parallel(pages.map(p => () => agent(
          visPrompt(WD, p), { label: `${tag} vis:${p}`, phase: 'Vision' })))
      }
      log(`[${tag}] vision: đã review ${reviewed} trang [${lo0}..${hi0})`)
      vis = await sh(`${PY} merge-vis "${WD}"`, `${tag}:merge-vis`)
    }

    // -- Auto-fix -- CHỈ rút gọn đoạn văn xuôi bị TRÀN khung (>=medium defect),
    // re-apply rồi CHỈ re-vision đúng những trang đó, lặp tới khi hết defect hoặc
    // hết số vòng. Lỗi phi-văn-bản (công thức/bảng/header vỡ) không rút gọn được
    // -> giữ 'review' trung thực, KHÔNG tự accept. Override lưu theo segment id
    // (fixes.json) nên trang khác dùng cùng chuỗi EN không bị đổi ngoài kiểm soát.
    if (!onlyVision) {
      phase('Fix')
      for (let round = 1; round <= MAX_FIX_ROUNDS; round++) {
        // CHỈ lấy trang có defect kênh 'text' (tràn khung/đè do bản dịch dài) —
        // rút gọn text mới có tác dụng. Trang lỗi engine (công thức/bảng/bullet
        // vỡ) thuộc kênh 'code': xem defect-report + LAYOUT_PLAYBOOK.md, sửa
        // pdf_core rồi apply lại — không rút gọn bừa bản dịch đang đúng.
        const bad = parseList(await sh(`${PY} problems "${WD}" medium text`, `${tag}:problems ${round}`))
        if (!bad.length) { log(`[${tag}] auto-fix: hết defect kênh text ✓ (lỗi engine xem defect-report)`); break }
        const csv = bad.join(',')
        log(`[${tag}] auto-fix vòng ${round}/${MAX_FIX_ROUNDS}: ${bad.length} trang defect`)
        const fpages = parseList(await sh(`${PY} page-segments "${PDF}" "${WD}" ${csv}`, `${tag}:fix-prep ${round}`))
        if (fpages.length) {
          await parallel(fpages.map(p => () => agent(
            `Một số đoạn văn xuôi tiếng Việt trên trang ${p} đang TRÀN/vỡ khung layout vì dài hơn bản Anh. ` +
            `Đọc file JSON ${WD}/fix/page_${pad(p)}.json (mảng {id, en, vi}).\n` +
            `Với MỖI mục: nếu 'vi' DÀI gây tràn thì RÚT GỌN cho súc tích (~15–25% ngắn hơn, bỏ từ thừa, ` +
            `diễn đạt gọn) NHƯNG GIỮ ĐỦ Ý và GIỮ NGUYÊN mọi số/đơn vị/ký hiệu/công thức/thuật ngữ + cụm ` +
            `"(English term)". Nếu 'vi' đã ngắn gọn hợp lý thì GIỮ NGUYÊN không đổi. KHÔNG bịa, KHÔNG bỏ ý.\n` +
            `Ghi ra ${WD}/fixout/page_${pad(p)}.json dạng JSON {id: "bản vi"} cho MỌI id (kể cả id giữ nguyên). ` +
            `Dùng tool Write. Chỉ ghi file, không in gì khác.`,
            { label: `${tag} fix:${p}`, phase: 'Fix' })))
        }
        await sh(`${PY} merge-fix "${WD}"`, `${tag}:merge-fix ${round}`)
        ap = await sh(`${PY} apply "${PDF}" "${WD}" "${OUT}"`, `${tag}:reapply ${round}`)
        // re-render + re-vision CHỈ các trang vừa sửa (only=csv) — tránh review lại cả cuốn
        await sh(`${PY} vis-pages "${PDF}" "${OUT}" "${WD}" ${csv}`, `${tag}:re-render ${round}`)
        const reTodo = parseList(await sh(`${PY} pending "${WD}" vision`, `${tag}:re-scan ${round}`))
        if (reTodo.length) {
          await parallel(reTodo.map(p => () => agent(
            visPrompt(WD, p), { label: `${tag} re-vis:${p}`, phase: 'Fix' })))
        }
        vis = await sh(`${PY} merge-vis "${WD}"`, `${tag}:re-merge-vis ${round}`)
      }
      log(`[${tag}] ${await sh(`${PY} review-summary "${WD}"`, `${tag}:review-summary`)}`)
    }
  }

  const st = await sh(`${PY} status "${WD}"`, `${tag}:status`)
  return { volume: tag, status: st, apply: ap, vision: vis }
}

// ===== Entry: 1 volume (A.pdf) hoặc batch cả manifest =====
let queue
if (A.pdf) {
  queue = [{ pdf: A.pdf, workdir: A.workdir, out: A.out, vision: A.vision,
             visFrom: A.visFrom, visTo: A.visTo, only: A.only,
             visPages: A.visPages }]
} else {
  queue = parseList(await sh(`${PY} volumes "${MANIFEST}"`, 'scan:volumes'))
}
log(`Batch: ${queue.length} volume cần xử lý`)

const results = []
for (const V of queue) {
  if (results.length && budget.total && budget.remaining() < STOP_BUDGET) {
    log(`⏸ Dừng trước "${V.workdir.split('/').pop()}": token còn ${Math.round(budget.remaining() / 1000)}k. Gọi lại để tiếp.`)
    break
  }
  log(`▶ ${V.workdir.split('/').pop()} (stage ${V.stage || 'single'})`)
  results.push(await runVolume(V))
}
return { processed: results.length, of: queue.length, volumes: results }
