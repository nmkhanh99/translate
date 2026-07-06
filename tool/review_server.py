#!/usr/bin/env python3
"""review_server.py — Màn hình REVIEW layout (bổ trợ cho dashboard.py).
================================================================================
Xem trực quan kết quả dịch từng trang: ảnh ghép GỐC | DỊCH, kèm danh sách lỗi
layout mà bước vision đã chấm (defect = cần fix, fit = co chữ chấp nhận được).
Từ đây có thể:
  • ĐÁNH DẤU DỊCH LẠI (revision) 1 trang -> xoá checkpoint để bước vision render +
    review lại đúng trang đó ở lần chạy sau.
  • CHẤP NHẬN (accept won't-fix) 1 trang -> loại khỏi danh sách "cần fix" để vòng
    lặp fix hội tụ.

Đây là file ĐỘC LẬP, KHÔNG sửa dashboard.py. Chạy song song:
    python3 review_server.py            # http://127.0.0.1:8760
    python3 review_server.py --port X

Nguồn dữ liệu (chỉ đọc/ghi các file review, không đụng bản dịch):
    work/<tag>/review/pair_XXX.png      ảnh ghép gốc|dịch
    work/<tag>/review_issues.json       lỗi vision đã gộp
    work/<tag>/accepted.json            trang won't-fix
"""
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import agent_pipeline as ap

TOOL = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(TOOL, "volumes.json")


def pretty(pdf):
    return os.path.splitext(os.path.basename(pdf))[0].replace("2024 CFA level I ", "").replace("2024 ", "")


def load_volumes():
    vols = json.load(open(MANIFEST, encoding="utf-8"))
    for v in vols:
        v["tag"] = os.path.basename(v["workdir"].rstrip("/"))
        v["display"] = pretty(v["pdf"])
    return vols


def find_volume(tag):
    for v in load_volumes():
        if v["tag"] == tag:
            return v
    return None


def review_stats(wd):
    """Tổng hợp defect (cần fix) / fit (chấp nhận) / accepted của 1 volume."""
    issues = ap._load(ap._wd(wd, "review_issues.json"), [])
    accepted = set(ap._load(ap._wd(wd, "accepted.json"), {}).get("pages", []))
    defect = [x for x in issues if x.get("kind", "defect") != "fit" and x["page"] not in accepted]
    fit = [x for x in issues if x.get("kind") == "fit"]
    return {"issues_total": len(issues), "defect": len(defect), "fit": len(fit),
            "accepted": len(accepted), "defect_pages": sorted({x["page"] for x in defect})}


def volume_detail(tag):
    v = find_volume(tag)
    if not v:
        return {"error": "tag không tồn tại"}
    wd = v["workdir"]
    npair = ap._count(wd, "review", "pair_*.png")
    issues = ap._load(ap._wd(wd, "review_issues.json"), [])
    accepted = set(ap._load(ap._wd(wd, "accepted.json"), {}).get("pages", []))
    bypage = {}
    for x in issues:
        bypage.setdefault(x["page"], []).append(x)
    pages = []
    for i in range(npair):
        iss = bypage.get(i, [])
        defect = [x for x in iss if x.get("kind", "defect") != "fit"]
        fit = [x for x in iss if x.get("kind") == "fit"]
        reviewed = os.path.exists(ap._wd(wd, "vis", f"page_{i:03d}.json"))
        # trạng thái để tô màu: accepted > defect > fit > ok(reviewed) > chưa review
        if i in accepted:
            state = "accepted"
        elif defect:
            state = "defect"
        elif fit:
            state = "fit"
        elif reviewed:
            state = "ok"
        else:
            state = "todo"
        pages.append({"page": i, "state": state, "defect": len(defect),
                      "fit": len(fit), "issues": iss})
    return {"tag": tag, "display": v["display"], "pairs": npair,
            "review": review_stats(wd), "pages": pages}


# ------------------------------- HTTP ---------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        try:
            return json.loads(self.rfile.read(n).decode()) if n else {}
        except Exception:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/":
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if u.path == "/api/vols":
            out = []
            for v in load_volumes():
                if v.get("skip"):
                    continue
                out.append({"tag": v["tag"], "display": v["display"],
                            "pairs": ap._count(v["workdir"], "review", "pair_*.png"),
                            "review": review_stats(v["workdir"])})
            return self._send(200, {"volumes": out})
        if u.path == "/api/volume":
            return self._send(200, volume_detail((q.get("tag") or [""])[0]))
        if u.path == "/api/pair":
            return self._serve_pair((q.get("tag") or [""])[0], int((q.get("page") or [0])[0]))
        return self._send(404, {"error": "not found"})

    def _serve_pair(self, tag, page):
        v = find_volume(tag)
        if not v:
            return self._send(404, {"error": "tag không tồn tại"})
        png = ap._wd(v["workdir"], "review", f"pair_{page:03d}.png")
        if not os.path.exists(png):
            return self._send(404, {"error": "chưa render ảnh trang này"})
        data = open(png, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        u = urlparse(self.path)
        b = self._body()
        v = find_volume(b.get("tag", ""))
        if not v:
            return self._send(404, {"error": "tag không tồn tại"})
        if u.path == "/api/accept":
            ap.cmd_accept(v["workdir"], str(b.get("pages", "")), b.get("note", ""))
            return self._send(200, {"ok": True, "review": review_stats(v["workdir"])})
        if u.path == "/api/revision":
            ap.cmd_revision(v["workdir"], str(b.get("pages", "")))
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not found"})


# ------------------------------- HTML ---------------------------------------
PAGE = r"""<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CFA Review Layout</title>
<style>
:root{--bg:#0f1117;--panel:#171a23;--line:#262a36;--fg:#e6e8ee;--mut:#9aa3b2;
--acc:#4f8cff;--ok:#33c481;--fit:#e0b341;--def:#ff5d5d;--acp:#7c5cff;--bar:#222735}
@media(prefers-color-scheme:light){:root{--bg:#f5f6f9;--panel:#fff;--line:#e3e6ee;
--fg:#1b1f2a;--mut:#5b6472;--bar:#eef0f6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;align-items:center;gap:14px;padding:12px 20px;flex-wrap:wrap;
border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:6}
h1{font-size:16px;margin:0;font-weight:650}.grow{flex:1}.mut{color:var(--mut)}
select{font:inherit;background:var(--panel);color:var(--fg);border:1px solid var(--line);
border-radius:8px;padding:6px 9px}
.legend{display:flex;gap:12px;font-size:12px;flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:5px}
.sw{width:12px;height:12px;border-radius:3px;display:inline-block;border:1px solid var(--line)}
.sw.ok{background:var(--ok)}.sw.fit{background:var(--fit)}.sw.defect{background:var(--def)}
.sw.accepted{background:var(--acp)}.sw.todo{background:var(--bar)}
main{display:flex;gap:0;height:calc(100vh - 52px)}
#grid{width:320px;min-width:280px;overflow:auto;padding:12px;border-right:1px solid var(--line)}
.gcells{display:grid;grid-template-columns:repeat(auto-fill,minmax(38px,1fr));gap:5px;margin-top:8px}
.cell{aspect-ratio:1;border:1px solid var(--line);border-radius:6px;cursor:pointer;
display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#0a0c12}
.cell.ok{background:var(--ok)}.cell.fit{background:var(--fit)}.cell.defect{background:var(--def);color:#fff}
.cell.accepted{background:var(--acp);color:#fff}.cell.todo{background:var(--bar);color:var(--mut)}
.cell.sel{outline:3px solid var(--acc);outline-offset:1px}
#viewer{flex:1;overflow:auto;padding:16px}
#pair{width:100%;border:1px solid var(--line);border-radius:8px;background:#fff}
.issue{border:1px solid var(--line);border-radius:8px;padding:9px 11px;margin:7px 0;background:var(--panel)}
.tag{font-size:11px;font-weight:700;padding:1px 7px;border-radius:20px;margin-right:6px}
.tag.defect{background:var(--def);color:#fff}.tag.fit{background:var(--fit);color:#111}
.tag.high{background:#7a1414;color:#fff}.tag.medium{background:#7a5b14;color:#fff}.tag.low{background:var(--bar);color:var(--mut)}
button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--fg);
padding:6px 12px;border-radius:8px;cursor:pointer;font-weight:600}
button:hover{border-color:var(--acc)}button:disabled{opacity:.4}
button.acp{border-color:var(--acp)}button.rev{border-color:var(--acc)}
.note{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;
font-size:12.5px;color:var(--mut);margin-bottom:12px}
.stat{font-size:13px}.stat b{color:var(--fg)}
.bar{display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap}
</style></head><body>
<header>
  <h1>🔍 CFA Review Layout</h1>
  <label class="mut">Volume <select id="vol"></select></label>
  <span id="sum" class="stat mut"></span>
  <span class="grow"></span>
  <div class="legend">
    <span><i class="sw defect"></i>defect (cần fix)</span>
    <span><i class="sw fit"></i>fit (co chữ, OK)</span>
    <span><i class="sw accepted"></i>accepted</span>
    <span><i class="sw ok"></i>đã review sạch</span>
    <span><i class="sw todo"></i>chưa review</span>
  </div>
</header>
<main>
  <div id="grid">
    <div class="note">Bấm 1 ô = 1 trang để xem ảnh ghép <b>gốc | dịch</b>. Màu ô theo mức lỗi
      vision đã chấm. <b>defect</b> = lỗi hiển thị thật cần sửa; <b>fit</b> = chữ Việt co/nhồi
      cho vừa khung nhưng vẫn đọc được (đánh đổi chấp nhận được).</div>
    <div id="gcells" class="gcells"></div>
  </div>
  <div id="viewer">
    <div id="vhead" class="mut">Chọn một trang bên trái.</div>
    <div class="bar" id="vbar" style="display:none">
      <button class="rev" id="btnRev">↻ Đánh dấu dịch lại trang này</button>
      <button class="acp" id="btnAcp">✓ Chấp nhận (won't-fix)</button>
      <span class="mut" id="vstate"></span>
    </div>
    <div id="issues"></div>
    <img id="pair" style="display:none" alt="pair">
  </div>
</main>
<script>
const $=s=>document.querySelector(s);
let TAG=null, DET=null, SEL=null;

async function loadVols(){
  const d=await (await fetch('/api/vols')).json();
  const sel=$('#vol');
  sel.innerHTML=d.volumes.map(v=>{
    const r=v.review;
    return `<option value="${v.tag}">${v.display} — ${r.defect} defect · ${r.fit} fit · ${r.accepted} accepted (${v.pairs} trang)</option>`;
  }).join('');
  sel.onchange=()=>loadVol(sel.value);
  if(d.volumes.length){ loadVol(d.volumes[0].tag); }
}
async function loadVol(tag){
  TAG=tag; SEL=null;
  DET=await (await fetch('/api/volume?tag='+tag)).json();
  const r=DET.review||{};
  $('#sum').innerHTML=`<b>${DET.pairs}</b> trang · <b style="color:var(--def)">${r.defect}</b> defect · `
    +`<b style="color:var(--fit)">${r.fit}</b> fit · <b style="color:var(--acp)">${r.accepted}</b> accepted`;
  $('#gcells').innerHTML=(DET.pages||[]).map(p=>
    `<div class="cell ${p.state}" data-p="${p.page}" title="trang ${p.page}: ${p.defect} defect, ${p.fit} fit"
      onclick="pick(${p.page})">${p.page}</div>`).join('');
  $('#vhead').textContent='Chọn một trang bên trái.';
  $('#vbar').style.display='none';$('#issues').innerHTML='';$('#pair').style.display='none';
}
function pick(p){
  SEL=p;
  document.querySelectorAll('.cell').forEach(c=>c.classList.toggle('sel',+c.dataset.p===p));
  const pg=(DET.pages||[]).find(x=>x.page===p)||{issues:[],state:'todo'};
  $('#vhead').innerHTML=`<b>Trang ${p}</b> — trạng thái: ${pg.state}`;
  $('#vbar').style.display='flex';
  $('#vstate').textContent=pg.state==='accepted'?'(đang là accepted)':'';
  $('#btnAcp').onclick=()=>doAccept(p);
  $('#btnRev').onclick=()=>doRevision(p);
  $('#issues').innerHTML=(pg.issues||[]).map(x=>{
    const kind=x.kind||'defect', sev=x.severity||'low';
    return `<div class="issue"><span class="tag ${kind}">${kind}</span>`
      +`<span class="tag ${sev}">${sev}</span>${(x.detail||'').replace(/</g,'&lt;')}</div>`;
  }).join('')|| '<div class="mut" style="margin:8px 0">Trang này không có lỗi vision nào ghi nhận.</div>';
  const img=$('#pair');
  img.style.display='block';
  img.src=`/api/pair?tag=${TAG}&page=${p}&_=${Date.now()}`;
}
async function doAccept(p){
  const note=prompt('Ghi chú won\'t-fix cho trang '+p+' (tuỳ chọn):','')??'';
  await fetch('/api/accept',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({tag:TAG,pages:String(p),note})});
  await loadVol(TAG); pick(p);
}
async function doRevision(p){
  if(!confirm('Đánh dấu trang '+p+' để bước vision render + review lại ở lần chạy sau?'))return;
  await fetch('/api/revision',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({tag:TAG,pages:String(p)})});
  await loadVol(TAG); pick(p);
}
loadVols();
</script></body></html>"""


def main():
    ap_ = argparse.ArgumentParser(description="Review layout dịch CFA (bổ trợ dashboard)")
    ap_.add_argument("--host", default="127.0.0.1")
    ap_.add_argument("--port", type=int, default=8760)
    a = ap_.parse_args()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"🔍 CFA Review Layout: http://{a.host}:{a.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nĐã dừng.")


if __name__ == "__main__":
    main()
