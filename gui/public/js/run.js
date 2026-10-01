/* Taxio Pilot - proses yang sedang berjalan: polling status, antrean e-Bupot, tampilan proses
   (progres per masa, proses ditahan, kontrol), ringkasan hasil, dan log. */
(function () {
    'use strict';
    const P = window.Pilot;
    const L = P.L;
    const R = P.run = { queue: [], finished: null, dismissed: null };

    // ---------- Polling ----------
    let last = '';
    let wasActive = false;
    let lastLabel = '';
    R.poll = async function () {
        let st;
        try { st = await P.api('/api/run/status'); } catch (e) { return; }
        setStatus(st);
    };
    function setStatus(st) {
        P.state.run = st || { active: false };
        if (st && st.active && st.label) lastLabel = st.label;
        if (wasActive && !(st && st.active)) {
            // Proses baru saja selesai: simpan hasil akhirnya untuk ringkasan di halaman.
            R.finished = { label: lastLabel, plan: st.plan, tally: st.jenisTally, requested: st.jenisRequested, at: Date.now() };
            R.dismissed = null;
        }
        if (st && st.active) R.finished = null;
        wasActive = !!(st && st.active);
        const sig = JSON.stringify(st);
        if (sig !== last) { last = sig; P.emit('run', P.state.run); }
    }
    R.startPolling = function () { R.poll(); setInterval(R.poll, 1500); };

    // ---------- Antrean e-Bupot (satu jenis per proses, berantai) ----------
    // Alur unduh e-Bupot dibangun per jenis dengan mesin run-control yang sudah teruji; di sini
    // beberapa jenis dijalankan berurutan, menunggu tiap proses selesai sebelum yang berikutnya.
    function waitForRunToFinish() {
        return new Promise((resolve) => {
            const check = async () => {
                let st; try { st = await P.api('/api/run/status'); } catch (e) { st = { active: false }; }
                setStatus(st);
                if (st && st.active) setTimeout(check, 1200); else resolve();
            };
            setTimeout(check, 1200);
        });
    }
    R.waitIdle = waitForRunToFinish;
    R.runQueue = async function (items) {
        R.queue = items.slice();
        while (R.queue.length) {
            const next = R.queue.shift();
            P.emit('log-local', 'Bupot: memulai ' + next.bupotType.toUpperCase() + (R.queue.length ? ' (' + R.queue.length + ' jenis lagi menyusul)' : '') + '…');
            try {
                await P.post('/api/actions/download-ebupot', next);
                R.poll();
                await waitForRunToFinish();
            } catch (e) {
                alert('Gagal memulai ' + next.bupotType.toUpperCase() + ': ' + e.message);
                R.queue = [];
            }
        }
    };

    // ---------- Aksi kontrol ----------
    async function control(act, body) {
        try { setStatus(await P.post('/api/run/' + act, body)); } catch (e) { alert('Gagal: ' + e.message); }
    }
    R.control = {
        pauseResume: () => control(P.state.run.paused ? 'resume' : 'pause'),
        skip: () => control('skip'), retry: () => control('retry'), back: () => control('back'),
        stop: () => { if (confirm('Hentikan seluruh proses?')) { R.queue = []; if (P.batch) P.batch.cancel(); control('stop'); } },
        pageSize: (n) => control('pagesize', { size: n })
    };

    // ---------- Tampilan proses ----------
    const STATE_ICON = { ok: 'check', skip: 'skipF', run: 'loader', hold: 'x', wait: '' };
    function pillsHtml(plan) {
        return '<div class="pills-grid">' + plan.items.map((it, i) => {
            const s = plan.states[i];
            const icon = STATE_ICON[s] ? P.icon(STATE_ICON[s], 14, s === 'run' ? 'spin' : '', 2.6) : '';
            return '<span class="qpill ' + s + '" title="' + P.esc(it.label) + '">' + P.esc(it.short) + icon + '</span>';
        }).join('') + '</div>';
    }
    function tallyHtml(st) {
        const req = st.jenisRequested || [];
        if (!req.length) return '';
        const names = { pph21: 'PPh 21/26', unifikasi: 'PPh Unifikasi', ppn: 'PPN', badan: 'PPh Badan', spt_op: 'PPh OP' };
        return '<div class="stack" style="gap:8px"><div class="eyebrow">Hasil per jenis pajak</div><div class="tally">' + req.map((k) => {
            const t = (st.jenisTally || {})[k] || { ok: 0, fail: 0 };
            const cls = t.ok > 0 ? 'ok' : t.fail > 0 ? 'fail' : (st.active ? '' : 'empty');
            return '<span class="' + cls + '">' + P.icon(t.ok > 0 ? 'check' : t.fail > 0 ? 'x' : (st.active ? 'loader' : 'warn'), 13, !t.ok && !t.fail && st.active ? 'spin' : '', 2.4) + P.esc(names[k] || k) + (t.ok || t.fail ? ' · ' + t.ok + ' ok' + (t.fail ? ', ' + t.fail + ' gagal' : '') : (st.active ? '' : ' · tidak ada data')) + '</span>';
        }).join('') + '</div></div>';
    }
    function holdBanner(st) {
        return '<div class="banner warn"><span class="ico">' + P.icon('warn', 20, '', 2) + '</span><div class="body"><b>Proses ditahan — perlu keputusan Anda</b><span>' + P.esc(String(st.holdReason || 'Kombinasi saat ini bermasalah').replace(/[.\s]+$/, '')) + '. Tidak ada yang dilewati otomatis; atau perbaiki sendiri di jendela Coretax lalu tekan Lanjut.</span>'
            + '<div class="row" style="gap:8px;margin-top:8px"><button type="button" class="btn btn-sm" style="background:var(--ink);color:#fff;border-color:var(--ink)" data-run="retry">' + P.icon('retry', 15) + 'Ulang</button><button type="button" class="btn btn-sm" data-run="skip">' + P.icon('skipF', 15) + 'Lewati</button><button type="button" class="btn btn-sm" data-run="back">' + P.icon('skipB', 15) + 'Mundur</button></div></div></div>';
    }
    R.viewHtml = function (st) {
        const prog = L.planProgress(st.plan);
        const held = st.paused && st.holdReason;
        const cur = prog && st.plan.index >= 0 ? st.plan.items[st.plan.index] : null;
        const left = '<section class="card"><div class="queue-head"><h2>' + (prog ? 'Antrean ' + (String(st.label || '').indexOf('Bupot') !== -1 || String(st.label || '').indexOf('Bukti') !== -1 ? 'unduhan' : 'masa') : 'Proses berjalan') + '</h2>'
            + (prog ? '<span class="hint">' + prog.finished + ' selesai' + (prog.hold ? ' · ' + prog.hold + ' perlu keputusan' : '') + ' · ' + (prog.wait + prog.run) + ' menunggu</span>' : '') + '</div>'
            + (held ? holdBanner(st) : (st.paused ? '<div class="banner info"><span class="ico">' + P.icon('pause', 20) + '</span><div class="body"><b>Proses dijeda</b><span>Tekan Lanjut untuk meneruskan.</span></div></div>' : ''))
            + (prog ? pillsHtml(st.plan) : '<div class="hint" style="font-size:13.5px">Proses ini tidak dibagi per masa. Ikuti kemajuannya di log aktivitas di bawah.</div>')
            + tallyHtml(st) + '</section>';
        const bar = prog ? '<div class="bar"><span class="ok" style="width:' + prog.pct + '%"></span><span class="hold" style="width:' + prog.holdPct + '%"></span></div>' : '<div class="bar indet"><span class="ok"></span></div>';
        const sizes = [10, 25, 50, 100];
        const rail = '<div class="card"><div class="row" style="justify-content:space-between"><div class="eyebrow">Progres</div>' + (st.currentPageSize ? '<span class="mono muted" style="font-size:12px">' + st.currentPageSize + ' baris/hal</span>' : '') + '</div>'
            + (prog ? '<div class="big-num"><b>' + prog.finished + '</b><small>/ ' + prog.total + '</small></div>' : '<div class="big-num"><span style="font-size:15px;color:var(--ink);font-weight:600">' + P.esc(st.label || 'Berjalan…') + '</span></div>') + bar
            + '<div class="divider"></div><div class="stack-lg" style="gap:12px"><div class="hint">' + (prog ? 'Sekarang' : 'Proses') + '</div><div style="font-size:15px;font-weight:700;color:var(--ink);margin-top:-8px">' + P.esc(cur ? cur.label : (st.label || '')) + '</div>'
            + (st.coretaxAs ? '<div class="hint">Login Coretax: ' + P.esc(st.coretaxAs) + '</div>' : '') + '</div>'
            + '<div class="divider"></div><div class="stack" style="gap:8px"><div class="eyebrow">Baris per halaman</div><div class="seg">' + sizes.map((n) => '<button type="button" data-run-size="' + n + '" aria-pressed="' + (st.currentPageSize === n) + '">' + n + '</button>').join('') + '</div></div>'
            + '<div class="ctl-grid"><button type="button" class="btn ' + (st.paused ? 'btn-primary' : '') + '" data-run="pause">' + P.icon(st.paused ? 'play' : 'pause', 16) + (st.paused ? 'Lanjut' : 'Jeda') + '</button><button type="button" class="btn" data-run="back">' + P.icon('skipB', 16) + 'Mundur</button><button type="button" class="btn" data-run="retry">' + P.icon('retry', 16) + 'Ulang</button><button type="button" class="btn" data-run="skip">' + P.icon('skipF', 16) + 'Lewati</button></div>'
            + '<button type="button" class="btn btn-danger btn-block" data-run="stop">' + P.icon('stop', 15) + 'Hentikan seluruh proses</button></div>';
        return '<div class="cols"><div class="col-main">' + left + '</div><aside class="rail">' + rail + '</aside></div>';
    };
    R.bindView = function (root) {
        root.addEventListener('click', (e) => {
            const b = e.target.closest('[data-run]');
            if (b) { const a = b.dataset.run; if (a === 'pause') R.control.pauseResume(); else R.control[a](); return; }
            const s = e.target.closest('[data-run-size]');
            if (s) R.control.pageSize(Number(s.dataset.runSize));
        });
    };

    /** Ringkasan hasil proses terakhir, ditampilkan di atas halaman sampai ditutup. */
    R.summaryHtml = function () {
        const f = R.finished;
        if (!f || R.dismissed === f.at) return '';
        const prog = L.planProgress(f.plan);
        let text = 'Proses selesai. Hasil rincinya ada di log aktivitas.';
        let kind = 'ok';
        if (prog) {
            text = prog.ok + ' selesai' + (prog.skip ? ', ' + prog.skip + ' dilewati' : '') + (prog.wait + prog.run + prog.hold ? ', ' + (prog.wait + prog.run + prog.hold) + ' belum dikerjakan' : '') + ' dari ' + prog.total + ' kombinasi.';
            if (prog.skip || prog.wait || prog.hold) kind = 'warn';
        }
        const tally = f.tally || {};
        const anyFail = Object.keys(tally).some((k) => tally[k].fail > 0);
        if (anyFail) kind = 'warn';
        return '<div class="banner ' + kind + '" style="margin-bottom:16px"><span class="ico">' + P.icon(kind === 'ok' ? 'check' : 'warn', 20, '', 2.2) + '</span><div class="body"><b>' + P.esc(f.label || 'Proses') + ' — selesai</b><span>' + P.esc(text) + '</span></div><button type="button" class="icon-btn" data-dismiss-run aria-label="Tutup ringkasan">' + P.icon('x', 16) + '</button></div>';
    };

    // ---------- Log aktivitas ----------
    const D = P.dock = { open: false, count: 0 };
    let lastMsg = 'Siap.';
    D.html = function () {
        return '<footer class="dock' + (D.open ? ' open' : '') + '" id="dock"><button type="button" class="dock-bar" id="dock-toggle" aria-expanded="' + D.open + '">'
            + P.icon('term', 16) + '<b>Log aktivitas</b><span class="live"><i class="dot"></i>LIVE</span><span class="dock-last" id="dock-last">' + P.esc(lastMsg) + '</span>'
            + '<span class="dock-tool" id="dock-clear" role="button" tabindex="0">Bersihkan</span>' + P.icon(D.open ? 'down' : 'up', 18) + '</button><div class="log-view" id="log-view" role="log"></div></footer>';
    };
    D.bind = function () {
        const t = P.$('dock-toggle');
        t.addEventListener('click', (e) => {
            if (e.target.closest('#dock-clear')) { clear(); return; }
            D.open = !D.open;
            const el = P.$('dock'); el.classList.toggle('open', D.open); t.setAttribute('aria-expanded', String(D.open));
            const view = P.$('log-view'); if (D.open && view) view.scrollTop = view.scrollHeight;
        });
    };
    async function clear() {
        const v = P.$('log-view'); if (v) v.innerHTML = '';
        lastMsg = 'Siap.'; const l = P.$('dock-last'); if (l) l.textContent = lastMsg;
        try { await P.post('/api/log/clear'); } catch (e) { /* diabaikan */ }
    }
    const buffered = [];
    function addLine(rawLine) {
        const { time, msg } = L.parseLogLine(rawLine);
        buffered.push({ time, msg });
        if (buffered.length > 600) buffered.shift();
        lastMsg = msg;
        const view = P.$('log-view');
        if (!view) return;
        appendNode(view, time, msg);
        const l = P.$('dock-last'); if (l) l.textContent = msg;
    }
    function appendNode(view, time, msg) {
        const stick = view.scrollTop + view.clientHeight >= view.scrollHeight - 40;
        const div = document.createElement('div');
        div.className = 'log-line ' + L.logLevel(msg);
        const t = document.createElement('span'); t.className = 'log-time'; t.textContent = time;
        const m = document.createElement('span'); m.className = 'log-msg'; m.textContent = msg;
        div.append(t, m); view.appendChild(div);
        while (view.childElementCount > 600) view.removeChild(view.firstElementChild);
        if (stick) view.scrollTop = view.scrollHeight;
    }
    /** Dipanggil setelah dock dirender ulang: isi kembali dari buffer. */
    D.restore = function () {
        const view = P.$('log-view'); if (!view) return;
        buffered.forEach((b) => appendNode(view, b.time, b.msg));
    };
    P.on('log-local', (msg) => addLine('[gui] ' + msg));

    R.connectEvents = function () {
        const es = new EventSource('/events');
        es.onmessage = (ev) => {
            try {
                const entry = JSON.parse(ev.data);
                if (entry.notice) { P.notice(entry.notice); return; }
                if (entry.line != null) addLine(entry.line);
            } catch (e) { /* baris rusak diabaikan */ }
        };
        es.onerror = () => { /* EventSource menyambung ulang sendiri */ };
    };
})();
