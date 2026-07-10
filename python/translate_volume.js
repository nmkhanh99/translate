export const meta = {
  name: 'translate-volume',
  description: 'Dịch CFA sang tiếng Việt giữ layout: translate → verify → apply → vision. Resume được (checkpoint theo file). Chạy 1 volume hoặc cả manifest 10 volume.',
  whenToUse: 'Dịch/tiếp tục 1 volume: args={pdf,workdir,out,vision}. Cả bộ: args={} hoặc {manifest}. Hết token gọi lại là tự chạy tiếp.',
  phases: [
    { title: 'Translate', detail: 'fan-out dịch các chunk còn thiếu out/' },
    { title: 'Verify', detail: 'đối chiếu số/bỏ sót vs bản Anh, sửa vào cache' },
    { title: 'Apply', detail: 'ghi đè giữ layout -> file đích' },
    { title: 'Vision', detail: 'review layout từng trang còn thiếu vis/' },
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

// ===== Dịch trọn 1 volume (mỗi phase chỉ làm unit còn thiếu output) =====
async function runVolume(V) {
  const PDF = V.pdf, WD = V.workdir, OUT = V.out, VISION = V.vision !== false
  const tag = WD.split('/').pop()
  const onlyVision = V.only === 'vision'   // bỏ qua translate/verify/apply (đã current)
  let ap = 'skipped (only=vision)'

  // -- Translate --
  if (!onlyVision) {
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
  if (VISION) {
    phase('Vision')
    await sh(`${PY} vis-pages "${PDF}" "${OUT}" "${WD}"`, `${tag}:render`)
    let total = 0
    try { total = (JSON.parse(await sh(`${PY} status "${WD}"`, `${tag}:total`)).vision || [0, 0])[1] || 0 } catch {}
    const lo0 = V.visFrom || 0
    const hi0 = V.visTo != null ? V.visTo : total
    const STEP = 30, pad = p => String(p).padStart(3, '0')
    let reviewed = 0
    for (let w = lo0; w < hi0; w += STEP) {
      const hw = Math.min(w + STEP, hi0)
      const pages = parseList(await sh(`${PY} pending "${WD}" vision ${w} ${hw}`, `${tag}:scan-vis ${w}`))
      if (!pages.length) continue
      reviewed += pages.length
      await parallel(pages.map(p => () => agent(
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
        `Trang ổn thì ghi []. File này là checkpoint resume — BẮT BUỘC phải ghi. Không in gì khác.`,
        { label: `${tag} vis:${p}`, phase: 'Vision' })))
    }
    log(`[${tag}] vision: đã review ${reviewed} trang [${lo0}..${hi0})`)
    vis = await sh(`${PY} merge-vis "${WD}"`, `${tag}:merge-vis`)
  }

  const st = await sh(`${PY} status "${WD}"`, `${tag}:status`)
  return { volume: tag, status: st, apply: ap, vision: vis }
}

// ===== Entry: 1 volume (A.pdf) hoặc batch cả manifest =====
let queue
if (A.pdf) {
  queue = [{ pdf: A.pdf, workdir: A.workdir, out: A.out, vision: A.vision,
             visFrom: A.visFrom, visTo: A.visTo, only: A.only }]
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
