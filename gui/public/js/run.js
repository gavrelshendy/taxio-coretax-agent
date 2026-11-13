/* Taxio Pilot - proses yang sedang berjalan: polling status, antrean e-Bupot, tampilan proses
   (progres per masa, proses ditahan, kontrol), ringkasan hasil, dan log. */
(function () {
    'use strict';
    const P = window.Pilot;
    const L = P.L;
    const R = P.run = { queue: [], finished: null, dismissed: null };

    // ---------- Polling ----------
    // Setiap jendela Chrome (beberapa per PIC, atau sesi manual) punya prosesnya sendiri dan proses
    // berbeda bisa berjalan bersamaan (lib/runcontrol.js), juga beberapa proses untuk PIC yang sama. Tampilan
    // proses, tombol kontrol, dan tombol mulai mengikuti proses ENTITAS yang sedang dipilih (pool PIC + entitas);
    // P.state.runs memuat semua proses (penanda sibuk di tab sesi, proses yang antre).
    let last = '';
    let wasActive = false;
    let lastLabel = '';
    let lastKey;
    R.sessionKey = () => L.sessionKeyOf(P.ent && P.ent.current ? P.ent.current() : null);
    /** Entitas terpilih (bukan untuk sesi manual - satu jendela, dan entitasnya dibaca dari jendela itu). */
    R.entityId = () => { const e = P.ent && P.ent.current ? P.ent.current() : null; return e && !L.isManualLike(e) ? String(e.entity_id || '') : ''; };
    const statusUrl = (key, entity) => '/api/run/status' + (key ? '?session=' + encodeURIComponent(key) + (entity ? '&entity=' + encodeURIComponent(entity) : '') : '');
    const viewKey = () => R.sessionKey() + '|' + R.entityId();
    R.poll = async function () {
        const key = R.sessionKey(), ent = R.entityId(), vk = viewKey();
        let st;
        try { st = await P.api(statusUrl(key, ent)); } catch (e) { return; }
        if (vk !== viewKey()) return; // pilihan entitas berubah selagi menunggu - poll berikutnya yang benar
        setStatus(st, vk);
    };
    function setStatus(st, key) {
        st = st || { active: false };
        P.state.runs = st.runs || [];
        if (key !== lastKey) {
            // Pindah sesi: jangan anggap proses sesi sebelumnya "baru saja selesai" di sesi ini.
            lastKey = key; wasActive = !!st.active; lastLabel = st.active ? st.label : ''; R.finished = null; R.dismissed = null;
        }
        P.state.run = st;
        if (st.active && st.label) lastLabel = st.label;
        if (wasActive && !st.active) {
            // Proses baru saja selesai: simpan hasil akhirnya untuk ringkasan di halaman.
            R.finished = { label: lastLabel || st.lastLabel, plan: st.plan, tally: st.jenisTally, requested: st.jenisRequested, at: Date.now() };
            R.dismissed = null;
        }
        if (st.active) R.finished = null;
        wasActive = !!st.active;
        const sig = JSON.stringify(st);
        if (sig !== last) { last = sig; P.emit('run', P.state.run); }
    }
    // Berhenti saat dashboard tersembunyi (P.every); proses mulai/selesai juga dikabarkan server lewat /events.
    R.startPolling = function () { R.poll(); P.every(R.poll, 1500); };
    /** Proses sesi `key` sedang berjalan? (dari polling terakhir). */
    R.busy = (key) => !!key && (P.state.runs || []).some((r) => r.key === key && r.active);
    R.runOf = (key) => (P.state.runs || []).find((r) => r.key === key) || null;
    /** Proses aktif (berjalan / antre) untuk entitas `flat` (pool PIC + entitas), atau null. */
    R.entityRun = (flat) => {
        const pool = L.sessionKeyOf(flat); if (!pool) return null;
        return (P.state.runs || []).find((r) => r.active && (r.pool || r.key) === pool && (!r.entity || r.entity === String(flat.entity_id || ''))) || null;
    };

    // ---------- Antrean e-Bupot (satu jenis per proses, berantai) ----------
    // Alur unduh e-Bupot dibangun per jenis dengan mesin run-control yang sudah teruji; di sini
    // beberapa jenis dijalankan berurutan, menunggu tiap proses selesai sebelum yang berikutnya.
    /** Menunggu proses `key` (kunci jendela / pool / "run:<id>"; bawaan: entitas terpilih saat dipanggil) selesai.
     *  `entity`: saring ke proses entitas itu (pool PIC bisa menjalankan beberapa entitas sekaligus). */
    function waitForRunToFinish(key, entity) {
        const k = key === undefined ? R.sessionKey() : key;
        const ent = key === undefined ? R.entityId() : (entity || '');
        return new Promise((resolve) => {
            const check = async () => {
                let st; try { st = await P.api(statusUrl(k, /^run:/.test(String(k)) ? '' : ent)); } catch (e) { st = { active: false }; }
                if (k + '|' + ent === viewKey()) setStatus(st, viewKey()); else P.state.runs = st.runs || P.state.runs;
                if (st && st.active) setTimeout(check, 1200); else resolve();
            };
            setTimeout(check, 1200);
        });
    }
    R.waitIdle = waitForRunToFinish;
    R.runQueue = async function (items) {
        R.queue = items.slice();
        const key = R.sessionKey(), ent = R.entityId();
        while (R.queue.length) {
            const next = R.queue.shift();
            P.emit('log-local', 'e-Bupot: starting ' + next.bupotType.toUpperCase() + (R.queue.length ? ' (' + R.queue.length + ' more type(s) to follow)' : '') + '…');
            try {
                const r = await P.post('/api/actions/download-ebupot', next);
                R.poll();
                await waitForRunToFinish(r && r.run ? 'run:' + r.run : ((r && r.session) || key), ent);
            } catch (e) {
                alert('Failed to start ' + next.bupotType.toUpperCase() + ': ' + e.message);
                R.queue = [];
            }
        }
    };

    // ---------- Aksi kontrol ----------
    // Selalu ke proses yang sedang ditampilkan (lewat id prosesnya), bukan "proses mana saja" di jendela / PIC itu.
    async function control(act, body) {
        const run = P.state.run || {};
        const key = run.id ? 'run:' + run.id : run.key;
        try { await P.post('/api/run/' + act + (key ? '?session=' + encodeURIComponent(key) : ''), body); R.poll(); } catch (e) { alert('Failed: ' + e.message); }
    }
    R.control = {
        pauseResume: () => control(P.state.run.paused ? 'resume' : 'pause'),
        skip: () => control('skip'), retry: () => control('retry'), back: () => control('back'),
        stop: () => { if (confirm(P.state.run && P.state.run.queued ? 'Cancel this queued process? It has not started yet.' : 'Stop the process in this session? Other sessions keep running.')) { R.queue = []; if (P.batch) P.batch.cancel(); control('stop'); } },
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
        const names = { pph21: 'PPh 21/26', unifikasi: 'PPh Unifikasi', ppn: 'PPN', badan: 'PPh Badan', spt_op: 'PPh Orang Pribadi' };
        return '<div class="stack" style="gap:8px"><div class="eyebrow">Results per Jenis Pajak</div><div class="tally">' + req.map((k) => {
            const t = (st.jenisTally || {})[k] || { ok: 0, fail: 0 };
            const cls = t.ok > 0 ? 'ok' : t.fail > 0 ? 'fail' : (st.active ? '' : 'empty');
            return '<span class="' + cls + '">' + P.icon(t.ok > 0 ? 'check' : t.fail > 0 ? 'x' : (st.active ? 'loader' : 'warn'), 13, !t.ok && !t.fail && st.active ? 'spin' : '', 2.4) + P.esc(names[k] || k) + (t.ok || t.fail ? ' · ' + t.ok + ' ok' + (t.fail ? ', ' + t.fail + ' failed' : '') : (st.active ? '' : ' · no data')) + '</span>';
        }).join('') + '</div></div>';
    }
    /** Kontrol yang benar-benar dikerjakan fitur proses ini (server: lib/run-controls.js). Server lama tanpa `controls`:
     *  Stop + Jeda + pilihan saat ditahan (perilaku lama). Dashboard hanya menawarkan Stop dan Jeda/Lanjut selama proses
     *  berjalan; Coba lagi / Lewati hanya muncul saat proses DITAHAN karena gagal (keputusan pemilik 2026-11-13). Mundur
     *  dan ukuran halaman tetap ada di server (MCP / tes) tetapi tidak ditawarkan di sini. */
    const controlsOf = (st) => st.controls || { stop: true, pause: true, skip: true, retry: true };
    function holdBanner(st, cur) {
        const c = controlsOf(st);
        const what = cur ? cur.label : 'this combination';
        return '<div class="banner warn"><span class="ico">' + P.icon('warn', 18, '', 2) + '</span><div class="body"><b>Process on hold — your decision needed</b><span>' + P.esc(String(st.holdReason || 'The current combination has a problem').replace(/[.\s]+$/, '')) + '. Nothing is skipped automatically. You can also fix it in the Coretax window, then press Resume.</span>'
            + '<div class="row decide">'
            + (c.retry ? '<button type="button" class="btn btn-sm btn-primary" data-run="retry">' + P.icon('retry', 14) + 'Try again</button>' : '')
            + (c.skip ? '<button type="button" class="btn btn-sm" data-run="skip" title="' + P.esc(what) + '">' + P.icon('skipF', 14) + 'Skip ' + P.esc(what) + '</button>' : '')
            + '<button type="button" class="btn btn-sm btn-ghost" data-run="stop">' + P.icon('stop', 13) + 'Stop</button></div></div></div>';
    }
    /** Stop / Jeda sudah diminta tetapi proses belum sampai di titik aman berikutnya. */
    function pendingBanner(st) {
        if (st.stopRequested) return '<div class="banner info"><span class="ico">' + P.icon('loader', 18, 'spin') + '</span><div class="body"><b>Stopping after the current step…</b><span>Nothing is cut off halfway. The activity log says what was and was not done.</span></div></div>';
        if (st.pauseRequested) return '<div class="banner info"><span class="ico">' + P.icon('loader', 18, 'spin') + '</span><div class="body"><b>Pausing after the current step…</b><span>After that nothing more is sent to Coretax until you press Resume.</span></div></div>';
        return '';
    }
    /** Proses yang menunggu jendela bebas: posisi antrean + alasannya, hanya Stop (= batalkan). */
    const WAIT_TEXT = {
        lock: 'The same command for this entity is still running; this one starts right after it.',
        total: 'All automation windows are in use (Parallel sessions limit in Settings). It starts as soon as one is free.',
        busy: 'All Coretax windows of this PIC are in use (Parallel sessions limit in Settings). It starts as soon as one is free.'
    };
    const runHead = (tag, cls, label, sub) => '<div class="run-head"><span class="tag lg ' + cls + '">' + tag + '</span><h2>' + P.esc(label || 'Process') + '</h2>' + (sub ? '<div class="hint">' + sub + '</div>' : '') + '</div>';
    function queuedHtml(st) {
        return '<div class="run-view">' + runHead('Queued · Position ' + (st.position || 1), 'manual', st.label, '')
            + '<div class="banner info"><span class="ico">' + P.icon('loader', 18) + '</span><div class="body"><b>Waiting for a Coretax window</b><span>' + P.esc(WAIT_TEXT[st.waitReason] || WAIT_TEXT.busy) + ' Nothing has been done in Coretax yet.</span></div></div></div>'
            + '<div class="abar run-abar" id="abar"><div class="abar-sum"><div class="abar-line"><b>Queued</b><span class="abar-dot"> · </span>Position ' + (st.position || 1) + '</div><div class="abar-sub">Other entities can still be started meanwhile.</div></div>'
            + '<button type="button" class="btn btn-ghost" data-run-hide>' + P.icon('plus', 15) + 'Start another command</button>'
            + '<button type="button" class="btn btn-danger" data-run="stop">' + P.icon('stop', 14) + 'Cancel queued process</button></div>';
    }
    /** "Start another command": halaman fitur tampil lagi selagi proses entitas ini berjalan / antre (sampai proses
     *  berikutnya); penanda kecil di atas halaman membawa kembali ke tampilan proses. */
    R.hidden = null;
    R.isHidden = (st) => !!(st && st.id && R.hidden === st.id);
    R.backBannerHtml = function (st) {
        if (!R.isHidden(st)) return '';
        return '<div class="banner info"><span class="ico">' + P.icon(st.queued ? 'loader' : 'play', 18) + '</span><div class="body"><b>' + P.esc(st.label || 'Process') + (st.queued ? ' — queued' : ' — running') + '</b><span>You can start another command for this entity meanwhile; it gets its own Coretax window.</span></div><button type="button" class="btn btn-sm" data-run-show>View progress</button></div>';
    };
    R.viewHtml = function (st) {
        if (st.queued) return queuedHtml(st);
        const prog = L.planProgress(st.plan);
        const held = st.paused && st.holdReason;
        const cur = prog && st.plan.index >= 0 ? st.plan.items[st.plan.index] : null;
        const tag = st.stopRequested ? ['Stopping…', 'danger'] : held ? ['Needs your decision', 'warn'] : st.pauseRequested ? ['Pausing…', 'manual'] : st.paused ? ['Paused', 'manual'] : ['Running', 'auto'];
        const box = pendingBanner(st) || (held ? holdBanner(st, cur) : (st.paused ? '<div class="banner info"><span class="ico">' + P.icon('pause', 18) + '</span><div class="body"><b>Paused</b><span>Nothing is sent to Coretax while paused. Resume continues where it stopped.</span></div></div>' : ''));
        const unit = prog ? (String(st.label || '').indexOf('Bupot') !== -1 || String(st.label || '').indexOf('Bukti') !== -1 ? 'Downloads' : 'Masa Pajak') : '';
        const bar = prog ? '<div class="bar"><span class="ok" style="width:' + prog.pct + '%"></span><span class="hold" style="width:' + prog.holdPct + '%"></span></div>' : '<div class="bar indet"><span class="ok"></span></div>';
        const progress = '<section class="run-sec"><div class="row run-sec-h"><div class="eyebrow">Progress' + (unit ? ' · ' + unit : '') + '</div>'
            + (prog ? '<span class="hint">' + prog.finished + ' done' + (prog.hold ? ' · ' + prog.hold + ' need a decision' : '') + ' · ' + (prog.wait + prog.run) + ' waiting</span>' : '') + '</div>'
            + (prog ? '<div class="big-num"><b>' + prog.finished + '</b><small>/ ' + prog.total + '</small></div>' : '') + bar
            + (prog ? pillsHtml(st.plan) : '<div class="hint">This process is not split by period. Follow it in the activity log below.</div>') + '</section>';
        const facts = '<dl class="kv run-facts"><div><dt>Now</dt><dd>' + P.esc(cur ? cur.label : (st.label || '')) + '</dd></div>'
            + (st.coretaxAs ? '<div><dt>Coretax login</dt><dd>' + P.esc(st.coretaxAs) + '</dd></div>' : '') + '</dl>';
        const c = controlsOf(st);
        const pauseBtn = c.pause || st.paused
            ? '<button type="button" class="btn ' + (st.paused ? 'btn-primary' : '') + '" data-run="pause"' + (st.pauseRequested ? ' title="Click to cancel the pause"' : '') + '>' + P.icon(st.paused ? 'play' : 'pause', 15) + (st.pauseRequested ? 'Pausing…' : st.paused ? 'Resume' : 'Pause') + '</button>' : '';
        const stopBtn = c.stop === false ? '' : '<button type="button" class="btn btn-danger" data-run="stop"' + (st.stopRequested ? ' disabled' : '') + '>' + P.icon('stop', 14) + (st.stopRequested ? 'Stopping…' : 'Stop this run') + '</button>';
        return '<div class="run-view">' + runHead(tag[0], tag[1], st.label, '') + box + progress + tallyHtml(st) + facts + '</div>'
            + '<div class="abar run-abar" id="abar"><div class="abar-sum"><div class="abar-line">' + (prog ? '<b>' + prog.finished + ' of ' + prog.total + '</b><span class="abar-dot"> · </span>' : '') + P.esc(cur ? cur.label : (st.label || 'Running…')) + '</div><div class="abar-sub">Stop and Pause take effect after the current step. Other sessions keep running.</div></div>'
            + '<button type="button" class="btn btn-ghost" data-run-hide>' + P.icon('plus', 15) + 'Start another command</button>'
            + (pauseBtn ? '<span class="ctl-grid">' + pauseBtn + '</span>' : '') + stopBtn + '</div>';
    };
    R.bindView = function (root) {
        root.addEventListener('click', (e) => {
            if (e.target.closest('[data-run-hide]')) { R.hidden = P.state.run && P.state.run.id; P.emit('run', P.state.run); return; }
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
        let text = 'Process finished. Detailed results are in the activity log.';
        let kind = 'ok';
        if (prog) {
            text = prog.ok + ' done' + (prog.skip ? ', ' + prog.skip + ' skipped' : '') + (prog.wait + prog.run + prog.hold ? ', ' + (prog.wait + prog.run + prog.hold) + ' not processed' : '') + ' of ' + prog.total + ' combinations.';
            if (prog.skip || prog.wait || prog.hold) kind = 'warn';
        }
        const tally = f.tally || {};
        const anyFail = Object.keys(tally).some((k) => tally[k].fail > 0);
        if (anyFail) kind = 'warn';
        return '<div class="banner ' + kind + '" style="margin-bottom:16px"><span class="ico">' + P.icon(kind === 'ok' ? 'check' : 'warn', 20, '', 2.2) + '</span><div class="body"><b>' + P.esc(f.label || 'Process') + ' — finished</b><span>' + P.esc(text) + '</span></div><button type="button" class="icon-btn" data-dismiss-run aria-label="Close summary">' + P.icon('x', 16) + '</button></div>';
    };

    // ---------- Log aktivitas (baris layout di bawah konten, tidak pernah menutupi halaman) ----------
    // Beberapa sesi bisa menulis log bersamaan; tiap baris dari sebuah proses berlabel entitasnya
    // ("[HBI] ...") dan membawa kunci sesinya. "This entity" menyaring ke proses entitas terpilih
    // (baris umum tanpa sesi - mis. dari dashboard - tetap tampil di log lengkap).
    // Strip satu baris saat tertutup menampilkan baris TERAKHIR yang berarti untuk entitas terpilih (atau proses mana pun
    // bila belum ada entitas) - bukan baris global seperti updater / koneksi Taxio Hub.
    // Dock adalah anak flex .main (flex: none): saat dibuka, konten menyusut dan tetap bisa digulir di atasnya.
    const D = P.dock = { open: !!P.store.get('logOpen', false), count: 0, scope: P.store.get('logScope', 'all') === 'session' ? 'session' : 'all', height: Number(P.store.get('logH', 220)) || 220 };
    const scopeLabel = () => (D.scope === 'session' ? 'This entity' : 'All sessions');
    const forEntity = (b) => {
        if (!b.session) return false;
        const pool = R.sessionKey();
        if (!pool) return true; // belum ada entitas: baris proses mana pun
        if (!b.pool) return b.session === pool;
        const ent = R.entityId();
        return b.pool === pool && (!ent || !b.entity || b.entity === ent);
    };
    const visible = (b) => D.scope !== 'session' || !b.session || forEntity(b);
    function stripLine() {
        for (let i = buffered.length - 1; i >= 0; i--) if (forEntity(buffered[i])) return buffered[i];
        return null;
    }
    const emptyText = () => (R.sessionKey() ? 'No activity for this entity yet.' : 'No runs yet.');
    function paintStrip() {
        const l = P.$('dock-last'); if (!l) return;
        const b = stripLine();
        l.className = 'dock-last' + (b ? ' ' + L.logLevel(b.msg) : ' empty');
        l.innerHTML = b ? '<em>' + P.esc(b.time) + '</em>' + P.esc(b.msg) : P.esc(emptyText());
    }
    const clampH = (h) => { const main = document.querySelector('.main'); const max = Math.max(140, Math.round((main ? main.clientHeight : 700) * 0.6)); return Math.max(110, Math.min(max, Math.round(h))); };
    D.html = function () {
        return '<footer class="dock' + (D.open ? ' open' : '') + '" id="dock" style="--dock-h:' + clampH(D.height) + 'px">'
            + '<div class="dock-resize" id="dock-resize" role="separator" aria-orientation="horizontal" aria-label="Resize the activity log" title="Drag to resize"></div>'
            + '<div class="dock-bar"><button type="button" class="dock-main" id="dock-toggle" aria-expanded="' + D.open + '" aria-controls="log-view" title="Show or hide the activity log">'
            + P.icon('term', 15) + '<b>Activity log</b><span class="dock-last" id="dock-last"></span></button>'
            + '<button type="button" class="dock-tool" id="dock-scope" title="Show the log of all sessions, or only the processes of the selected entity" aria-pressed="' + (D.scope === 'session') + '">' + scopeLabel() + '</button>'
            + '<button type="button" class="dock-tool" id="dock-clear">Clear</button>'
            + '<button type="button" class="icon-btn dock-chev" id="dock-chev" aria-label="' + (D.open ? 'Hide log' : 'Show log') + '">' + P.icon('up', 16) + '</button></div>'
            + '<div class="log-view" id="log-view" role="log"></div></footer>';
    };
    function rerenderLog() {
        const view = P.$('log-view'); if (!view) return;
        view.innerHTML = '';
        buffered.filter(visible).forEach((b) => appendNode(view, b.time, b.msg));
        view.scrollTop = view.scrollHeight;
    }
    function setOpen(open) {
        D.open = open; P.store.set('logOpen', open);
        const el = P.$('dock'); if (!el) return;
        el.classList.toggle('open', open);
        P.$('dock-toggle').setAttribute('aria-expanded', String(open));
        P.$('dock-chev').setAttribute('aria-label', open ? 'Hide log' : 'Show log');
        const view = P.$('log-view'); if (open && view) view.scrollTop = view.scrollHeight;
    }
    D.bind = function () {
        const dock = P.$('dock');
        dock.addEventListener('click', (e) => {
            if (e.target.closest('#dock-clear')) { clear(); return; }
            const sc = e.target.closest('#dock-scope');
            if (sc) {
                D.scope = D.scope === 'session' ? 'all' : 'session';
                P.store.set('logScope', D.scope);
                sc.textContent = scopeLabel(); sc.setAttribute('aria-pressed', String(D.scope === 'session'));
                rerenderLog();
                return;
            }
            if (e.target.closest('#dock-toggle, #dock-chev')) setOpen(!D.open);
        });
        // Tinggi log bisa diubah dengan menyeret tepi atasnya; diingat.
        const grip = P.$('dock-resize');
        grip.addEventListener('pointerdown', (e) => {
            if (!D.open) return;
            e.preventDefault();
            const y0 = e.clientY, h0 = dock.getBoundingClientRect().height;
            grip.setPointerCapture(e.pointerId);
            dock.classList.add('resizing');
            const move = (ev) => { D.height = clampH(h0 + (y0 - ev.clientY)); dock.style.setProperty('--dock-h', D.height + 'px'); };
            const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); dock.classList.remove('resizing'); P.store.set('logH', D.height); };
            grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
        });
        grip.addEventListener('dblclick', () => { D.height = 220; dock.style.setProperty('--dock-h', clampH(220) + 'px'); P.store.set('logH', 220); });
        paintStrip();
    };
    async function clear() {
        const v = P.$('log-view'); if (v) v.innerHTML = '';
        buffered.length = 0; paintStrip();
        try { await P.post('/api/log/clear'); } catch (e) { /* diabaikan */ }
    }
    const buffered = [];
    function addLine(rawLine, session, scope) {
        const { time, msg } = L.parseLogLine(rawLine);
        const b = { time, msg, session: session || null, pool: (scope && scope.pool) || null, entity: (scope && scope.entity) || '' };
        buffered.push(b);
        if (buffered.length > 600) buffered.shift();
        if (forEntity(b)) paintStrip();
        if (!visible(b)) return;
        const view = P.$('log-view');
        if (view) appendNode(view, time, msg);
    }
    // Pindah entitas/sesi: saringan "This entity" dan strip mengikuti entitas yang baru.
    P.on('entity', () => { if (D.scope === 'session') rerenderLog(); paintStrip(); });
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
        buffered.filter(visible).forEach((b) => appendNode(view, b.time, b.msg));
        view.scrollTop = view.scrollHeight;
        paintStrip();
    };
    window.addEventListener('resize', () => { const d = P.$('dock'); if (d) d.style.setProperty('--dock-h', clampH(D.height) + 'px'); });
    P.on('log-local', (msg) => addLine('[gui] ' + msg));

    R.connectEvents = function () {
        const es = new EventSource('/events');
        es.onmessage = (ev) => {
            try {
                const entry = JSON.parse(ev.data);
                if (entry.notice) { P.notice(entry.notice); return; }
                // Kabar perubahan dari server (lib/ui-events.js): 'run' | 'login' | 'sessions' | 'session'.
                if (entry.event) { if (!P.isHidden()) P.emit('server-event', entry.event); return; }
                if (entry.line != null) addLine(entry.line, entry.session, entry);
            } catch (e) { /* baris rusak diabaikan */ }
        };
        es.onerror = () => { /* EventSource menyambung ulang sendiri */ };
    };
})();
