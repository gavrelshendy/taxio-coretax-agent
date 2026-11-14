/* Taxio Pilot - halaman Runs: semua proses hari ini dalam tiga bagian (Needs You / In Progress / Done), satu baris
   per proses, batch ("unduh untuk banyak klien") sebagai satu baris yang bisa dibuka. Data dari GET /api/runs
   (kontrak: README "Halaman Runs"), dimuat ulang saat kabar SSE 'runs' datang; aksi memakai route kontrol lama
   dengan ?session=run:<id>. Tidak ada panel samping: baris dibuka di tempat. */
(function () {
    'use strict';
    const P = window.Pilot;
    const esc = P.esc;
    const L = P.L;
    const X = P.runsPage = { data: null, expanded: new Set(), details: {} };
    const EMPTY = { needsYou: [], inProgress: [], done: [], batches: [], limits: {} };
    const FINISHED = { done: 1, failed: 1, stopped: 1 };
    let root = null, painted = false, pressed = false, pendingRender = false, lastSig = null, loading = false, again = false, timer = null;

    // ---------- Data ----------
    const flat = (d) => d.needsYou.concat(d.inProgress, d.done);
    function normalize(d) {
        d = d || {};
        return { needsYou: d.needsYou || [], inProgress: d.inProgress || [], done: d.done || [], batches: d.batches || [], limits: d.limits || {} };
    }
    const onPage = () => P.state.page === 'runs' && !!root && root.isConnected;
    async function loadDetails() {
        const live = new Set(flat(X.data).map((r) => r.key));
        await Promise.all(Array.from(X.expanded).filter((k) => live.has(k)).map(async (k) => {
            try { const r = await P.api('/api/runs/' + encodeURIComponent(k)); X.details[k] = { lines: r.lines || [] }; }
            catch (e) { delete X.details[k]; }
        }));
    }
    X.load = async function () {
        if (!P.isConnected()) return;
        if (loading) { again = true; return; }
        loading = true;
        try {
            X.data = normalize(await P.api('/api/runs'));
            if (onPage()) await loadDetails();
            P.emit('runs-data');
        } catch (e) { /* server tidak terjangkau: coba lagi nanti */ }
        loading = false;
        if (again) { again = false; X.load(); }
    };
    /** Kabar SSE datang beruntun (maks. 4/detik dari server): satukan jadi satu pemuatan. */
    X.schedule = function () { clearTimeout(timer); timer = setTimeout(X.load, 150); };
    X.start = function () {
        X.load();
        P.every(X.load, 20000); // jaring pengaman; berhenti saat tersembunyi dan mengejar saat terlihat (P.every)
    };
    P.on('server-event', (ev) => { if (ev === 'runs') X.schedule(); });
    P.on('session', () => X.load());

    // ---------- Lencana sidebar ----------
    /** Kuning = jumlah proses yang menunggu keputusanmu; kalau tidak ada, jumlah proses yang sedang berjalan / antre. */
    X.navBadgeHtml = function () {
        const d = X.data; if (!d) return '';
        const need = d.needsYou.length, act = d.inProgress.length;
        const tip = (need ? need + (need === 1 ? ' run needs' : ' runs need') + ' your decision' : '') + (need && act ? ' · ' : '') + (act ? act + (act === 1 ? ' run' : ' runs') + ' in progress' : '');
        if (need) return '<span class="nb warn" id="nav-runs-badge" title="' + esc(tip) + '">' + need + '</span>';
        if (act) return '<span class="nb" id="nav-runs-badge" title="' + esc(tip) + '">' + act + '</span>';
        return '';
    };

    // ---------- Tampilan ----------
    function picText(r) {
        const pool = r.pic;
        if (!pool || pool === 'manual' || /^manual/.test(pool)) return 'Manual session';
        let name = '';
        for (const e of ((P.ent && (P.ent.group || [])) || []).concat((P.ent && P.ent.personal) || [])) {
            const p = (e.pics || []).find((x) => x.pic_id === pool);
            if (p && p.pic_name) { name = p.pic_name; break; }
            if (e.pic_id === pool && e.pic_name) { name = e.pic_name; break; }
        }
        const who = (name || String(pool).replace(/^p-/, '')).split(/\s+/)[0].toUpperCase();
        return 'PIC ' + who + (r.windowNo ? ' #' + r.windowNo : '');
    }
    const ICON = {
        running: ['loader', 'run', 'spin'], paused: ['pause', 'mute'], stopping: ['loader', 'bad', 'spin'], queued: ['clock', 'mute'],
        hold: ['warn', 'warn'], done: ['check', 'ok'], failed: ['x', 'bad'], stopped: ['stop', 'mute']
    };
    const icoHtml = (name, tone, spin) => '<span class="rn-ico ' + tone + '">' + P.icon(name, 15, spin || '', 2.2) + '</span>';
    const pct = (done, total) => (total > 0 ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0);
    const barHtml = (p) => '<div class="bar"><span class="ok" style="width:' + p + '%"></span></div>';
    const lineHtml = (raw) => { const l = L.parseLogLine(raw); return '<div class="log-line ' + L.logLevel(l.msg) + '"><span class="log-time">' + esc(l.time) + '</span><span class="log-msg">' + esc(l.msg) + '</span></div>'; };

    function controlsHtml(r) {
        const c = r.controls || {};
        const k = esc(r.key);
        const btn = (act, icon, text, cls, extra) => '<button type="button" class="btn btn-sm ' + cls + '" data-rn-act="' + act + '" data-key="' + k + '"' + (extra || '') + '>' + P.icon(icon, 13) + text + '</button>';
        const stop = c.stop === false ? '' : btn('stop', 'stop', 'Stop', 'btn-ghost', ' data-confirm="1"');
        switch (r.state) {
            case 'stopping': return '<span class="rn-fb">Stopping…</span>';
            case 'paused': return btn('resume', 'play', 'Resume', 'btn-primary') + stop;
            case 'running':
                return (c.pause ? (r.pauseRequested ? btn('pause', 'pause', 'Pausing…', '', ' title="Click to cancel the pause"') : btn('pause', 'pause', 'Pause', '')) : '') + stop;
            case 'queued': return '<button type="button" class="icon-btn" data-rn-act="stop" data-key="' + k + '" aria-label="Cancel this queued run" title="Cancel (it has not started yet)">' + P.icon('x', 16) + '</button>';
            case 'done': case 'failed': case 'stopped':
                return r.outputDir ? '<button type="button" class="icon-btn" data-rn-folder data-key="' + k + '" aria-label="Open output folder" title="Open output folder">' + P.icon('folder', 16) + '</button>' : '';
            default: return '';
        }
    }
    function holdHtml(r) {
        const h = r.hold; if (!h) return '';
        const choices = (h.choices || []).map((c) => {
            const id = c.id || c.action;
            const cls = id === 'retry' ? 'btn-primary' : id === 'stop' ? 'btn-ghost' : '';
            const icon = id === 'retry' ? 'retry' : id === 'skip' ? 'skipF' : id === 'stop' ? 'stop' : 'play';
            return '<button type="button" class="btn btn-sm ' + cls + '" data-rn-act="' + esc(c.action) + '" data-key="' + esc(r.key) + '" title="' + esc(c.label) + '">' + P.icon(icon, 13) + '<span class="rn-cl">' + esc(c.label) + '</span></button>';
        }).join('');
        return '<div class="rn-hold"><div class="rn-hold-t">' + esc(String(h.reason || 'The current step has a problem').replace(/[.\s]+$/, '')) + '.</div><div class="rn-choices">' + choices + '</div></div>';
    }
    function detailHtml(r) {
        const d = X.details[r.key];
        let h = '<div class="rn-detail">';
        if (r.queue && r.queue.reasonText) h += '<div class="hint">' + esc(r.queue.reasonText) + '</div>';
        const items = r.progress && r.progress.items;
        if (items && items.length) h += P.run.pillsHtml({ items, states: items.map((i) => i.state) });
        const lines = d ? d.lines.slice(-14) : null;
        h += '<div class="rn-log">' + (lines && lines.length ? lines.map(lineHtml).join('') : '<span class="muted">' + (d ? 'No log lines yet.' : 'Loading…') + '</span>') + '</div></div>';
        return h;
    }
    function runRow(r, sub) {
        const open = X.expanded.has(r.key);
        const ic = ICON[r.state] || ICON.running;
        const name = (r.entity && (r.entity.name || r.entity.id)) || 'No entity';
        const p = r.progress;
        let body = '';
        if (r.state === 'hold') body += holdHtml(r);
        if (p && p.total && (r.state === 'running' || r.state === 'paused' || r.state === 'stopping' || r.state === 'hold')) {
            body += '<div class="rn-prog">' + barHtml(pct(p.done, p.total)) + '<span class="rn-pt">' + p.done + ' of ' + p.total + '</span>' + (p.current ? '<span class="rn-cur" title="' + esc(p.current.label) + '">' + esc(p.current.short || p.current.label) + '</span>' : '') + '</div>';
        }
        if (r.state === 'queued') body += '<div class="rn-note" title="' + esc((r.queue && r.queue.reasonText) || '') + '">Waiting' + (r.queue && r.queue.position ? ' · #' + r.queue.position + ' in line' : '') + '</div>';
        const outcome = FINISHED[r.state] && r.outcome && r.outcome.text ? '<span class="rn-t3 ' + esc(r.state) + '" title="' + esc(r.outcome.text) + '">' + esc(r.outcome.text) + '</span>' : '';
        return '<li class="rn-row ' + esc(r.state) + (sub ? ' sub' : '') + '" data-flip="' + esc(r.key) + '" data-state="' + esc(r.state) + '">'
            + '<div class="rn-main"><button type="button" class="rn-head" data-rn-toggle="' + esc(r.key) + '" aria-expanded="' + open + '">' + icoHtml(ic[0], ic[1], ic[2])
            + '<span class="rn-txt"><span class="rn-t1"><b title="' + esc(name) + '">' + esc(name) + '</b><span class="rn-pic">' + esc(picText(r)) + '</span></span>'
            + '<span class="rn-t2" title="' + esc(r.label || r.feature || '') + '">' + esc(r.label || r.feature || 'Process') + '</span>' + outcome + '</span>'
            + '<span class="rn-chev">' + P.icon('down', 15) + '</span></button><div class="rn-ctl">' + controlsHtml(r) + '</div></div>'
            + (body ? '<div class="rn-body">' + body + '</div>' : '') + (open ? detailHtml(r) : '') + '</li>';
    }
    /** Baris kedua batch: nama fitur yang ramah (label menu) + parameter dari label proses pertama ("SPT · PPh 21/26 · Masa Pajak ..."). */
    function batchSub(b) {
        const meta = P.pages && P.pages.meta ? P.pages.meta(b.feature) : null;
        const name = (meta && meta.label) || b.feature || 'Batch';
        const first = b.members && b.members[0];
        const params = first && first.label ? String(first.label).split(' · ').slice(1).join(' · ') : '';
        return params ? name + ' · ' + params : name;
    }
    function batchRow(b) {
        const key = 'batch:' + b.id, open = X.expanded.has(key);
        const c = b.counts, fin = c.done + c.failed + c.stopped, total = Math.max(b.total || 0, b.members.length + c.hold);
        const bits = [];
        if (c.running) bits.push(c.running + ' running');
        if (c.queued) bits.push(c.queued + ' waiting');
        if (c.hold) bits.push(c.hold + ' need' + (c.hold === 1 ? 's' : '') + ' you');
        if (c.failed) bits.push(c.failed + ' failed');
        if (c.stopped) bits.push(c.stopped + ' stopped');
        const ic = b.open ? ICON.running : (c.failed || c.stopped ? ['warn', 'warn'] : ICON.done);
        const sub = fin + ' of ' + total + (total === 1 ? ' client' : ' clients');
        return '<li class="rn-row batch ' + (b.open ? 'open' : 'finished') + '" data-flip="' + esc(key) + '">'
            + '<div class="rn-main"><button type="button" class="rn-head" data-rn-toggle="' + esc(key) + '" aria-expanded="' + open + '">' + icoHtml(b.open ? 'layers' : ic[0], b.open ? 'run' : ic[1])
            + '<span class="rn-txt"><span class="rn-t1"><b title="' + esc(b.label) + '">' + esc(b.label) + '</b></span><span class="rn-t2">' + esc(batchSub(b)) + '</span></span>'
            + '<span class="rn-chev">' + P.icon('down', 15) + '</span></button>'
            + '<div class="rn-ctl">' + (b.open ? '<button type="button" class="btn btn-sm btn-ghost" data-rn-stop-batch="' + esc(b.id) + '">' + P.icon('stop', 13) + 'Stop all</button>' : '') + '</div></div>'
            + '<div class="rn-body"><div class="rn-prog">' + barHtml(pct(fin, total)) + '<span class="rn-pt">' + esc(sub) + '</span>' + (bits.length ? '<span class="rn-cur">' + esc(bits.join(' · ')) + '</span>' : '') + '</div></div>'
            + (open ? '<ul class="rn-subs">' + b.members.map((r) => runRow(r, true)).join('') + '</ul>' : '') + '</li>';
    }

    /** Dari tiga daftar server menjadi baris tampilan: batch yang masih jalan -> satu baris di In Progress, batch yang
     *  seluruhnya selesai -> satu baris di Done. Proses yang ditahan selalu tampil sendiri di Needs You. */
    function layout(d) {
        const meta = new Map(d.batches.map((b) => [b.id, b]));
        const members = new Map();
        flat(d).forEach((r) => { if (r.batch && r.batch.id) { if (!members.has(r.batch.id)) members.set(r.batch.id, []); members.get(r.batch.id).push(r); } });
        const isOpen = (id) => { const m = meta.get(id); return m ? m.endedAt == null : members.get(id).some((r) => !FINISHED[r.state]); };
        const build = (id) => {
            const m = meta.get(id) || {};
            const list = members.get(id).filter((r) => r.state !== 'hold').sort((a, b) => ((a.batch && a.batch.index) || 0) - ((b.batch && b.batch.index) || 0));
            const counts = Object.assign({ queued: 0, running: 0, hold: 0, done: 0, failed: 0, stopped: 0 }, m.counts);
            if (!m.counts) members.get(id).forEach((r) => { const k = r.state === 'paused' || r.state === 'stopping' ? 'running' : r.state; counts[k] = (counts[k] || 0) + 1; });
            const first = members.get(id)[0];
            return { kind: 'batch', id, label: m.label || (first.batch && first.batch.label) || 'Batch', feature: m.feature || first.feature || '', total: m.total || (first.batch && first.batch.total) || list.length, counts, members: list, open: isOpen(id) };
        };
        const out = { needs: d.needsYou.map((r) => ({ kind: 'run', run: r })), prog: [], done: [] };
        const seen = new Set();
        d.inProgress.forEach((r) => {
            const id = r.batch && r.batch.id;
            if (!id || !isOpen(id)) return out.prog.push({ kind: 'run', run: r });
            if (!seen.has(id)) { seen.add(id); out.prog.push(build(id)); }
        });
        members.forEach((list, id) => { if (isOpen(id) && !seen.has(id) && list.some((r) => r.state !== 'hold')) { seen.add(id); out.prog.push(build(id)); } });
        d.done.forEach((r) => {
            const id = r.batch && r.batch.id;
            if (!id) return out.done.push({ kind: 'run', run: r });
            if (isOpen(id)) return;
            if (!seen.has(id)) { seen.add(id); out.done.push(build(id)); }
        });
        return out;
    }
    const rowHtml = (x) => (x.kind === 'batch' ? batchRow(x) : runRow(x.run, false));
    function sectionHtml(id, title, rows, extra) {
        if (!rows.length) return '';
        return '<section class="rn-sec ' + id + '" data-sec="' + id + '"><div class="rn-sec-h"><h2>' + title + '</h2><span class="rn-count">' + rows.length + '</span>' + (extra || '') + '</div><ul class="rn-list">' + rows.map(rowHtml).join('') + '</ul></section>';
    }
    function pageHtml() {
        const d = X.data;
        if (!d) return '<div class="rn"></div>';
        const lay = layout(d);
        if (!lay.needs.length && !lay.prog.length && !lay.done.length) {
            return '<div class="rn"><div class="rn-empty"><span class="rn-ico mute big">' + P.icon('runs', 22) + '</span><b>No runs yet today</b><span class="hint">Start one from a page in the sidebar, such as SPT or e-Bupot. It will show up here.</span></div></div>';
        }
        return '<div class="rn">' + sectionHtml('needs', 'Needs You', lay.needs) + sectionHtml('prog', 'In Progress', lay.prog)
            + sectionHtml('done', 'Done', lay.done, '<span class="rn-sub-h">Today</span><button type="button" class="lnk rn-clear" data-rn-clear>Clear</button>') + '</div>';
    }

    // ---------- Gambar + FLIP ----------
    /** Gambar ulang; baris yang berpindah / baru digeser-dimunculkan dengan transform + opacity saja (120-240 ms). */
    function render(animate) {
        if (!onPage() || !X.data) return;
        const sig = JSON.stringify([X.data, Array.from(X.expanded).sort(), X.details]);
        if (sig === lastSig) return;
        if (pressed) { pendingRender = true; return; } // jangan mengganti tombol di antara tekan dan lepas mouse
        lastSig = sig;
        const before = new Map(), widths = new Map();
        root.querySelectorAll('[data-flip]').forEach((el) => {
            before.set(el.dataset.flip, el.getBoundingClientRect());
            const w = el.querySelector(':scope > .rn-body .bar .ok'); if (w) widths.set(el.dataset.flip, w.style.width);
        });
        const top = root.parentElement ? root.parentElement.scrollTop : 0;
        const fresh = document.createElement('div'); fresh.innerHTML = pageHtml();
        root.replaceChildren(...fresh.childNodes);
        if (root.parentElement) root.parentElement.scrollTop = top;
        root.querySelectorAll('.rn-log').forEach((el) => { el.scrollTop = el.scrollHeight; });
        const motion = animate && painted && !P.reducedMotion() && typeof Element.prototype.animate === 'function';
        painted = true;
        root.querySelectorAll('[data-flip]').forEach((el) => {
            const k = el.dataset.flip, was = before.get(k);
            const w = el.querySelector(':scope > .rn-body .bar .ok');
            if (w && widths.has(k) && widths.get(k) !== w.style.width && motion) { const target = w.style.width; w.style.width = widths.get(k); void w.offsetWidth; w.style.width = target; }
            if (!motion) return;
            if (was) {
                const dy = was.top - el.getBoundingClientRect().top;
                if (Math.abs(dy) > 1) el.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
            } else el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
        });
    }
    P.on('runs-data', () => render(true));

    // ---------- Aksi ----------
    const failed = (e) => P.toast('Failed: ' + e.message);
    async function control(btn) {
        const act = btn.dataset.rnAct, key = btn.dataset.key;
        if (btn.dataset.confirm) {
            const row = btn.closest('.rn-row'), who = row && row.querySelector('.rn-t1 b'), what = row && row.querySelector('.rn-t2');
            if (!await P.confirmDialog({ title: 'Stop Run', body: 'This run stops safely after the current step. Other runs keep going.', details: [['Run', who && who.textContent], ['Task', what && what.textContent]], confirmLabel: 'Stop run', danger: true })) return;
        }
        btn.disabled = true;
        try { await P.post('/api/run/' + act + '?session=' + encodeURIComponent(key)); } catch (e) { failed(e); }
        X.load();
    }
    async function toggle(key) {
        if (X.expanded.has(key)) X.expanded.delete(key); else { X.expanded.add(key); if (!key.startsWith('batch:')) await loadDetails(); }
        render(true);
    }
    function bind(el) {
        el.addEventListener('pointerdown', () => { pressed = true; });
        el.addEventListener('click', async (e) => {
            const t = e.target.closest('[data-rn-toggle]'); if (t) return toggle(t.dataset.rnToggle);
            const a = e.target.closest('[data-rn-act]'); if (a) return control(a);
            const f = e.target.closest('[data-rn-folder]');
            if (f) { try { await P.post('/api/runs/open-folder', { key: f.dataset.key }); } catch (err) { failed(err); } return; }
            const sb = e.target.closest('[data-rn-stop-batch]');
            if (sb) {
                const brow = sb.closest('li, .rn-batch'), bn = brow && brow.querySelector('b');
                if (!await P.confirmDialog({ title: 'Stop All Runs', body: 'Running clients stop at a safe point and waiting ones are cancelled.', details: [['Batch', bn && bn.textContent]], confirmLabel: 'Stop all', danger: true })) return;
                sb.disabled = true;
                try { await P.post('/api/runs/stop-batch', { id: sb.dataset.rnStopBatch }); } catch (err) { failed(err); }
                X.load(); return;
            }
            if (e.target.closest('[data-rn-clear]')) {
                if (!await P.confirmDialog({ title: 'Clear Done', body: 'This removes the finished runs from this list. Downloaded files stay in their folders.', confirmLabel: 'Clear Done' })) return;
                try { await P.post('/api/runs/clear-done'); } catch (err) { failed(err); } X.load(); }
        });
    }
    document.addEventListener('pointerup', () => { pressed = false; if (pendingRender) { pendingRender = false; setTimeout(() => render(true), 0); } });
    document.addEventListener('pointercancel', () => { pressed = false; });

    // ---------- Halaman (didaftarkan di P.pages, lihat pages.js NAV) ----------
    P.pages.all.runs = {
        id: 'runs',
        mount(el) {
            root = el; painted = false; lastSig = null; pressed = false;
            bind(el);
            X.load();
            render(false); // muatan pertama (juga yang datang menyusul) tanpa animasi
        },
        refresh() { render(true); },
        updateRail() {}
    };
})();
