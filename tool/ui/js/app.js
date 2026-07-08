/* CFA Translate Studio — shared interactions, WIRED to the real backend.
 * Design behaviors (toast, nav, chips, search, reader, view toggle) kept from
 * the template; mock data replaced with fetch() to dashboard.py /api/* and the
 * Electron preload bridge (window.appBridge). Feature-detected per page. */
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $all = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  async function api(path, opts) {
    var r = await fetch(path, opts);
    var d = null;
    try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
    return d;
  }
  function post(path, body) {
    return api(path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}) });
  }

  /* ---- Toast ---------------------------------------------------------- */
  var toastEl;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast";
      document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove("show"); }, 2200);
  }
  window.cfaToast = toast;

  /* ---- Terminal bridge (Electron) ------------------------------------- */
  var INAPP = !!(window.appBridge && window.appBridge.runInTerminal);
  function termRun(cmd) {
    if (window.appBridge && window.appBridge.runInTerminal) return window.appBridge.runInTerminal(cmd);
    var a = window.cfa || window.api || window.electron;
    if (a && typeof a.termRun === "function") return a.termRun(cmd);
    return null;
  }
  function termTail(p) {
    if (window.appBridge && window.appBridge.tailLog) return window.appBridge.tailLog(p);
    return null;
  }

  /* ---- Active nav (by filename) --------------------------------------- */
  var here = (location.pathname.split("/").pop() || "index.html").toLowerCase() || "index.html";
  $all("[data-nav]").forEach(function (a) {
    if (a.getAttribute("data-nav").toLowerCase() === here) a.classList.add("active");
  });

  /* ---- Language swap (design) ----------------------------------------- */
  $all("[data-swap]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var bar = btn.closest(".lang-bar"); if (!bar) return;
      var langs = bar.querySelectorAll(".lang");
      if (langs.length === 2) bar.insertBefore(langs[1], langs[0]);
      btn.animate([{ transform: "rotate(0)" }, { transform: "rotate(180deg)" }],
        { duration: 260, easing: "cubic-bezier(0.2,0,0,1)" });
    });
  });

  /* ---- Filter chips + live search (design; operate on rendered rows) --- */
  function wireChips() {
    $all("[data-chipgroup]").forEach(function (group) {
      group.querySelectorAll(".chip").forEach(function (chip) {
        chip.onclick = function () {
          group.querySelectorAll(".chip").forEach(function (c) { c.classList.remove("active"); });
          chip.classList.add("active");
          var val = chip.getAttribute("data-filter");
          var scope = $(group.getAttribute("data-target") || "body");
          if (!scope) return;
          $all("[data-status]", scope).forEach(function (row) {
            row.style.display = (val === "all" || row.getAttribute("data-status") === val) ? "" : "none";
          });
        };
      });
    });
  }
  $all("[data-search]").forEach(function (input) {
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      var scope = $(input.getAttribute("data-search")); if (!scope) return;
      $all("[data-title]", scope).forEach(function (row) {
        row.style.display = row.getAttribute("data-title").toLowerCase().indexOf(q) !== -1 ? "" : "none";
      });
    });
  });

  /* ---- data-term buttons (CLI in Terminal) ---------------------------- */
  $all("[data-term]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var cmd = btn.getAttribute("data-term");
      termRun(cmd);
      toast(INAPP ? ("Đã gửi sang Terminal: " + cmd) : ("Mở app để chạy: " + cmd));
    });
  });

  /* ==================== Data model ==================== */
  var BADGE = {
    done: '<span class="badge badge-success"><span class="dot"></span>Đã dịch</span>',
    active: '<span class="badge badge-accent"><span class="dot"></span>Đang dịch</span>',
    draft: '<span class="badge"><span class="dot"></span>Chưa dịch</span>',
    error: '<span class="badge badge-danger"><span class="dot"></span>Lỗi</span>'
  };
  function cls(v) {
    if (v.stage === "done") return "done";
    if (v.stage === "error") return "error";
    if (v.running) return "active";
    // đã có tiến độ (translate/verify/vision) nhưng chưa xong -> đang dịch (dở)
    var t = v.translate || [0, 0];
    if (t[0] > 0) return "active";
    return "draft";
  }
  function pct(v) {
    if (v.stage === "done") return 100;
    // gộp tiến độ mọi stage đang có (translate + verify + vision) cho % tổng thể
    var d = 0, tot = 0;
    [v.translate, v.verify, v.vision].forEach(function (a) {
      if (a && a[1]) { d += a[0] || 0; tot += a[1]; }
    });
    return tot ? Math.round(100 * d / tot) : 0;
  }
  function pagesLabel(v) {
    if (v.pages) return v.pages + " trang";
    var t = v.translate || [0, 0];
    return t[1] ? (t[0] + "/" + t[1] + " lô") : "chưa rõ";
  }
  function statusText(v) {
    return { done: "Đã dịch", active: "Đang dịch", error: "Lỗi", draft: "Chưa dịch" }[cls(v)];
  }
  function loadStatus() { return api("/api/status"); }

  async function runVolume(tag, pages) {
    try {
      if (INAPP) {
        var d = await api("/api/command?tag=" + encodeURIComponent(tag) + "&pages=" + encodeURIComponent(pages || "all"));
        termRun(d.cmd);
        toast("Đang chạy ở Terminal — xem tiến trình bên phải");
      } else {
        await post("/api/run", { tag: tag });
        toast("Đã bắt đầu dịch (headless)");
      }
    } catch (e) { toast("Lỗi: " + e.message); }
  }
  async function stopVolume(tag) {
    try { await post("/api/stop", { tag: tag }); toast("Đã dừng"); } catch (e) { toast("Lỗi: " + e.message); }
  }

  /* ---- Sidebar usage widget (budget from config; cost not tracked) ---- */
  function renderUsage(cfg) {
    var b = (cfg && cfg.budget) != null ? cfg.budget : 100;
    $all(".side-foot .usage").forEach(function (u) {
      u.innerHTML =
        '<div class="row-between"><small>Ngân sách tháng</small><b class="num">$' + esc(b) + "</b></div>" +
        '<div class="progress"><i style="width:0%"></i></div>' +
        '<small class="muted">Chi phí tính theo gói Claude/Codex trên máy — app không theo dõi $ riêng.</small>';
    });
  }

  /* ==================== HOME (index.html) ==================== */
  async function initHome() {
    var statsEl = $('[data-od-id="stats"]');
    var contEl = $('[data-od-id="continue"]');
    var recentWrap = $('[data-od-id="recent"] .grid-3');
    if (!statsEl && !contEl && !recentWrap) return false;
    async function render() {
      var s = await loadStatus();
      renderUsage(s.config);
      var real = s.volumes.filter(function (v) { return !v.skip; });
      var done = real.filter(function (v) { return v.stage === "done"; });
      var running = real.filter(function (v) { return v.running; });
      var pending = real.filter(function (v) { return v.stage !== "done" && !v.running; });
      var pagesDone = done.reduce(function (a, v) { return a + (v.pages || 0); }, 0);
      if (statsEl) statsEl.innerHTML =
        card('<div class="stat"><div class="n num">' + done.length + '</div><div class="l">Cuốn đã dịch xong</div></div>') +
        card('<div class="stat"><div class="n num">' + pagesDone + '</div><div class="l">Trang trong các cuốn đã xong</div></div>') +
        card('<div class="stat"><div class="n num">' + (running.length + pending.length) + '</div><div class="l">Cuốn đang chạy / chờ</div></div>');
      if (contEl) {
        var cur = running[0] || pending[0];
        if (cur) {
          var p = pct(cur);
          contEl.innerHTML =
            '<div class="row-between wrap" style="gap:var(--space-4)">' +
              '<div class="row" style="gap:var(--space-4)">' +
                '<div class="thumb" style="width:48px;flex:none"></div>' +
                '<div><div class="row" style="gap:var(--space-2)"><strong>' +
                  (cur.running ? "Đang dịch · " : "Chờ · ") + esc(cur.display) + '</strong>' + BADGE[cls(cur)] + '</div>' +
                  '<div class="muted num" style="font-size:var(--text-xs);margin-top:2px">' + esc(pagesLabel(cur)) + ' · ' + esc(cur.stage) + '</div>' +
                  '<div class="progress" style="margin-top:var(--space-2);width:min(360px,60vw)"><i style="width:' + p + '%"></i></div></div></div>' +
              '<a class="btn btn-secondary" href="queue.html">Xem tiến độ</a></div>';
          contEl.style.display = "";
        } else { contEl.style.display = "none"; }
      }
      if (recentWrap) {
        var recent = done.slice(0, 6);
        recentWrap.innerHTML = recent.length ? recent.map(function (v) {
          return '<a class="doc-card" href="document.html?tag=' + encodeURIComponent(v.tag) + '">' +
            '<div class="thumb"></div><div class="body"><div class="row-between"><h3>' + esc(v.display) + '</h3>' +
            BADGE.done + '</div><p class="muted num" style="font-size:var(--text-xs);margin-top:4px">' + esc(pagesLabel(v)) + '</p></div></a>';
        }).join("") : '<p class="muted">Chưa có cuốn nào dịch xong.</p>';
      }
    }
    function card(inner) { return '<div class="card">' + inner + "</div>"; }
    await render(); setInterval(render, 4000); return true;
  }

  /* ==================== LIBRARY (library.html) ==================== */
  async function initLibrary() {
    var grid = $("#doc-grid"); if (!grid) return false;
    async function render() {
      var s = await loadStatus();
      renderUsage(s.config);
      var vols = s.volumes.filter(function (v) { return !v.skip; });
      grid.innerHTML = vols.map(function (v) {
        var c = cls(v), p = pct(v);
        var action;
        if (c === "done") action = '<a class="btn btn-secondary btn-sm" href="document.html?tag=' + encodeURIComponent(v.tag) + '">Đọc song song</a>';
        else if (c === "active") action = '<a class="btn btn-ghost btn-sm" href="queue.html">Xem tiến độ</a>';
        else action = '<button class="btn btn-primary btn-sm" data-run="' + esc(v.tag) + '">' + (c === "error" ? "Chạy tiếp" : "Dịch") + '</button>';
        var mid = (c === "active" || (v.translate && v.translate[0] > 0 && c !== "done"))
          ? '<div class="progress" style="margin-top:var(--space-3)"><i style="width:' + p + '%"></i></div>' +
            '<div class="row-between" style="margin-top:var(--space-2)"><span class="num muted" style="font-size:var(--text-xs)">' + p + '% · ' + esc(pagesLabel(v)) + '</span>' + action + '</div>'
          : '<div class="row-between" style="margin-top:var(--space-3)"><span class="num muted" style="font-size:var(--text-xs)">' + esc(pagesLabel(v)) + '</span>' + action + '</div>';
        return '<article class="doc-card" data-status="' + c + '" data-title="' + esc(v.display) + '">' +
          '<div class="thumb"></div><div class="body"><div class="row-between"><h3>' + esc(v.display) + '</h3>' +
          BADGE[c] + '</div>' + (v.user ? '<p class="muted" style="font-size:var(--text-sm);margin-top:2px">📄 tài liệu tự thêm</p>' : "") +
          mid + '</div></article>';
      }).join("");
      $all("[data-run]", grid).forEach(function (b) {
        b.onclick = function () { runVolume(b.getAttribute("data-run"), "all"); };
      });
      wireChips();
    }
    await render(); setInterval(render, 4000); return true;
  }

  /* ==================== QUEUE (queue.html) ==================== */
  async function initQueue() {
    var proc = $('[data-od-id="processing"]'); if (!proc) return false;
    var recent = $('[data-od-id="recent"]');
    var statsEl = $('[data-od-id="queue-stats"]');
    function jobRow(v, kind) {
      var p = pct(v);
      var badge = BADGE[cls(v)];
      var right, prog;
      if (kind === "active") {
        prog = '<div class="prog-cell"><div class="row" style="gap:var(--space-3)"><div class="progress" style="flex:1"><i style="width:' + p + '%"></i></div>' +
          '<span class="num muted" style="font-size:var(--text-xs);min-width:32px;text-align:right">' + p + '%</span></div>' +
          '<div class="muted" style="font-size:var(--text-xs);margin-top:6px">' + esc(v.stage) + ' · ' + esc(pagesLabel(v)) + '</div></div>';
        right = '<div class="act-cell row" style="gap:var(--space-2)">' +
          '<button class="btn btn-secondary btn-sm" data-stop="' + esc(v.tag) + '">Dừng</button>' +
          (INAPP ? '<button class="btn btn-ghost btn-sm" data-tail="' + esc(v.logpath) + '">📺 Log</button>' : "") + '</div>';
      } else if (kind === "waiting") {
        prog = '<div class="prog-cell"><div class="progress"><i style="width:' + p + '%"></i></div><div class="muted" style="font-size:var(--text-xs);margin-top:6px">Xếp hàng</div></div>';
        right = '<div class="act-cell row" style="gap:var(--space-2)"><button class="btn btn-primary btn-sm" data-run="' + esc(v.tag) + '">Chạy ngay</button></div>';
      } else if (kind === "done") {
        prog = '<div class="prog-cell"><div class="progress ok"><i style="width:100%"></i></div></div>';
        right = '<div class="act-cell"><a class="btn btn-secondary btn-sm" href="document.html?tag=' + encodeURIComponent(v.tag) + '">Đọc song song</a></div>';
      } else { /* error */
        prog = '<div class="prog-cell"><div class="progress warn"><i style="width:' + p + '%"></i></div></div>';
        right = '<div class="act-cell"><button class="btn btn-secondary btn-sm" data-run="' + esc(v.tag) + '">Chạy tiếp</button></div>';
      }
      return '<div class="job" data-status="' + (kind === "waiting" ? "waiting" : cls(v)) + '">' +
        '<div class="thumb"></div><div><div class="row" style="gap:var(--space-2)"><strong>' + esc(v.display) + '</strong>' + badge + '</div>' +
        '<div class="muted num" style="font-size:var(--text-xs)">' + esc(v.tag) + ' · ' + esc(v.engine || "") + '</div></div>' + prog + right + '</div>';
    }
    async function render() {
      var s = await loadStatus();
      renderUsage(s.config);
      var vols = s.volumes.filter(function (v) { return !v.skip; });
      var active = vols.filter(function (v) { return v.running; });
      var waiting = vols.filter(function (v) { return v.stage !== "done" && !v.running && v.stage !== "error"; });
      var donev = vols.filter(function (v) { return v.stage === "done"; });
      var errv = vols.filter(function (v) { return v.stage === "error" && !v.running; });
      if (statsEl) {
        var cur = active[0];
        statsEl.innerHTML =
          '<div class="card"><div class="stat"><div class="n num">' + (cur ? pct(cur) : 0) + '<small>%</small></div><div class="l">Tiến độ cuốn đang dịch</div></div></div>' +
          '<div class="card"><div class="stat"><div class="n num">' + active.length + '</div><div class="l">Đang chạy</div></div></div>' +
          '<div class="card"><div class="stat"><div class="n num">' + waiting.length + '</div><div class="l">Đang chờ trong hàng đợi</div></div></div>';
      }
      proc.innerHTML = '<div class="panel-head">Đang xử lý<span class="spacer"></span><span class="badge badge-accent"><span class="dot"></span>Tuần tự</span></div>' +
        (active.length ? active.map(function (v) { return jobRow(v, "active"); }).join("") : "") +
        (waiting.length ? waiting.map(function (v) { return jobRow(v, "waiting"); }).join("") : "") +
        (!active.length && !waiting.length ? '<div style="padding:var(--space-4)" class="muted">Không có cuốn nào trong hàng đợi.</div>' : "");
      if (recent) recent.innerHTML = '<div class="panel-head">Hoàn tất gần đây</div>' +
        (donev.concat(errv).length ? donev.concat(errv).map(function (v) { return jobRow(v, v.stage === "done" ? "done" : "error"); }).join("")
          : '<div style="padding:var(--space-4)" class="muted">Chưa có gì.</div>');
      bindJobActions();
    }
    function bindJobActions() {
      $all("[data-stop]").forEach(function (b) { b.onclick = function () { stopVolume(b.getAttribute("data-stop")); }; });
      $all("[data-run]").forEach(function (b) { b.onclick = function () { runVolume(b.getAttribute("data-run"), "all"); }; });
      $all("[data-tail]").forEach(function (b) { b.onclick = function () { termTail(b.getAttribute("data-tail")); toast("Đang tail log ở Terminal"); }; });
    }
    // "Tạm dừng tất cả" nút topbar
    var pauseAll = $(".topbar .btn-secondary");
    if (pauseAll && /dừng tất cả/i.test(pauseAll.textContent)) pauseAll.onclick = function () {
      post("/api/batch", { action: "stop" }).then(function () { toast("Đã dừng batch"); });
    };
    await render(); setInterval(render, 3500); return true;
  }

  /* ==================== TRANSLATE (translate.html) ==================== */
  async function initTranslate() {
    var dz = $("[data-dropzone]"); if (!dz) return false;
    var input = $("#file-input");
    var activeDoc = $('[data-od-id="active-doc"]');
    var selected = null; // {tag, display, pages}
    var s = await loadStatus().catch(function () { return { config: {} }; });
    renderUsage(s.config);

    dz.addEventListener("click", function () { input && input.click(); });
    ["dragenter", "dragover"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("drag"); }); });
    ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("drag"); }); });
    dz.addEventListener("drop", function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) upload(f); });
    input && input.addEventListener("change", function () { if (input.files[0]) upload(input.files[0]); input.value = ""; });

    async function upload(f) {
      if (!/\.pdf$/i.test(f.name)) { toast("Chỉ nhận PDF"); return; }
      toast("Đang tải “" + f.name + "”…");
      try {
        await fetch("/api/upload?name=" + encodeURIComponent(f.name),
          { method: "POST", headers: { "Content-Type": "application/pdf" }, body: f });
        var st = await loadStatus();
        var name = f.name.replace(/\.pdf$/i, "");
        var v = st.volumes.filter(function (x) { return x.user; })
          .filter(function (x) { return x.display === name; })[0] || st.volumes.filter(function (x) { return x.user; }).slice(-1)[0];
        if (v) { selectDoc(v); toast("Đã thêm “" + name + "” — bấm Bắt đầu dịch"); }
      } catch (e) { toast("Lỗi tải: " + e.message); }
    }
    function selectDoc(v) {
      selected = v;
      if (!activeDoc) return;
      activeDoc.querySelectorAll("h3").forEach(function (h) { h.textContent = v.display; });
      var meta = activeDoc.querySelector(".sub");
      if (meta) meta.innerHTML = '<span class="num">' + esc(pagesLabel(v)) + "</span> · PDF gốc";
      activeDoc.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    // "Bắt đầu dịch"
    var startBtn = $("[data-start]");
    if (startBtn) startBtn.addEventListener("click", function () {
      if (!selected) { toast("Chọn/tải một PDF trước"); return; }
      var pages = "all";
      runVolume(selected.tag, pages);
    });
    return true;
  }

  /* ==================== SETTINGS (settings.html) ==================== */
  async function initSettings() {
    var engineSel = $("[data-model]"); if (!engineSel) return false;
    var s = await loadStatus();
    var cfg = s.config || {};
    renderUsage(cfg);
    // engine
    engineSel.value = cfg.engine || "claude";
    // claude model select (2nd select in settings-model)
    var modelSel = $('[data-od-id="settings-model"] .grid-2 .field:nth-child(2) select');
    if (modelSel) {
      // map opus/sonnet
      $all("option", modelSel).forEach(function (o) {
        o.selected = new RegExp(cfg.model || "sonnet", "i").test(o.textContent);
      });
    }
    // budget
    var budgetInp = $('[data-od-id="settings-budget"] input.num');
    if (budgetInp) budgetInp.value = cfg.budget != null ? cfg.budget : 100;
    var warnSel = $('[data-od-id="settings-budget"] select');
    if (warnSel) $all("option", warnSel).forEach(function (o) {
      o.selected = parseInt(o.textContent) === (cfg.budget_warn || 90); });

    function save() {
      var model = "sonnet";
      if (modelSel) model = /opus/i.test(modelSel.value) ? "opus" : "sonnet";
      var body = { engine: engineSel.value, model: model };
      if (budgetInp) body.budget = parseFloat(budgetInp.value) || 100;
      if (warnSel) body.budget_warn = parseInt(warnSel.value) || 90;
      post("/api/config", body).then(function () { toast("Đã lưu cài đặt"); renderUsage(body); })
        .catch(function (e) { toast("Lỗi lưu: " + e.message); });
    }
    $all("[data-save]").forEach(function (b) { b.addEventListener("click", save); });
    return true;
  }

  /* ==================== DOCUMENT reader (document.html) ============ */
  async function initDocument() {
    var reader = $("[data-reader]"); if (!reader) return false;
    var s = await loadStatus().catch(function () { return { volumes: [], config: {} }; });
    renderUsage(s.config);
    var tag = new URLSearchParams(location.search).get("tag");
    // nếu không có tag: ưu tiên cuốn đã dịch xong, ngược lại cuốn đầu
    if (!tag) {
      var done = s.volumes.filter(function (v) { return !v.skip && v.stage === "done"; })[0]
        || s.volumes.filter(function (v) { return !v.skip; })[0];
      tag = done && done.tag;
    }
    if (!tag) { toast("Không có tài liệu"); return true; }
    var info;
    try { info = await api("/api/pageinfo?tag=" + encodeURIComponent(tag)); }
    catch (e) { toast("Lỗi: " + e.message); return true; }

    // title
    $all(".doc-title").forEach(function (t) { t.firstChild && (t.firstChild.textContent = info.display + " "); });
    var h1 = $(".topbar h1"); if (h1) h1.textContent = info.display;
    var subEl = $(".topbar .sub"); if (subEl) subEl.textContent = info.pages + " trang" + (info.out_exists ? "" : " · chưa có bản dịch");

    var total = Math.max(1, info.pages || 1);
    reader.setAttribute("data-total", total);
    var org = reader.querySelector("[data-col=original]");
    var trg = reader.querySelector("[data-col=translated]");
    var cur = 1;
    var label = $("[data-pagelabel]");

    function imgHTML(which, page, cap, capColor) {
      var src = "/api/page?tag=" + encodeURIComponent(tag) + "&which=" + which + "&page=" + (page - 1) + "&dpi=150";
      return '<div class="sheet-cap"' + (capColor ? ' style="color:var(--accent)"' : "") + ">" + cap + "</div>" +
        '<img src="' + src + '" alt="trang ' + page + '" style="width:100%;border:1px solid var(--border);border-radius:var(--radius-sm);display:block" />';
    }
    function render() {
      cur = Math.max(1, Math.min(total, cur));
      if (label) label.textContent = cur + " / " + total;
      if (org) org.innerHTML = imgHTML("source", cur, "English · trang " + cur, false);
      if (trg) {
        if (info.out_exists) trg.innerHTML = imgHTML("out", cur, "Tiếng Việt · trang " + cur, true);
        else trg.innerHTML = '<div class="sheet-cap" style="color:var(--accent)">Tiếng Việt</div><p class="muted">Chưa có bản dịch cho cuốn này. Dịch ở trang <a href="library.html">Thư viện</a>.</p>';
      }
    }
    $all("[data-page-prev]").forEach(function (b) { b.addEventListener("click", function () { cur--; render(); }); });
    $all("[data-page-next]").forEach(function (b) { b.addEventListener("click", function () { cur++; render(); }); });
    $all("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () {
        $all("[data-view]").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        var mode = b.getAttribute("data-view");
        reader.classList.toggle("single", mode === "translated" || mode === "original");
        if (org) org.style.display = mode === "translated" ? "none" : "";
        if (trg) trg.style.display = mode === "original" ? "none" : "";
      });
    });
    render();
    return true;
  }

  /* ==================== Dispatch ==================== */
  (async function () {
    try {
      // chạy đúng init của trang hiện tại (feature-detected)
      if (await initHome()) return;
      if (await initLibrary()) return;
      if (await initQueue()) return;
      if (await initTranslate()) return;
      if (await initSettings()) return;
      if (await initDocument()) return;
    } catch (e) {
      console.error("app init error:", e);
      toast("Lỗi tải dữ liệu: " + (e && e.message));
    }
  })();
})();
