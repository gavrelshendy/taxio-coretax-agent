/* Taxio Pilot - halaman fitur. Tiap halaman: form bertahap di kiri, ringkasan + tombol
   "Mulai Otomasi" di kanan. Aturan tiap fitur (jenis yang terkunci, format yang dipaksa, dsb)
   dibawa dari dashboard lama dan tetap ditegakkan juga oleh server. */
(function () {
    'use strict';
    const P = window.Pilot;
    const L = P.L;
    const E = P.ent;
    const esc = P.esc;

    // ---------- Navigasi ----------
    // Dikelompokkan menurut akibatnya (proposal 4.1): Download (hanya membaca), Change in Coretax (mengubah data),
    // Year-End. kind 'write' memberi label "Changes data in Coretax" di topbar. Halaman yang sama seperti sebelumnya.
    const NAV = [
        { title: '', items: [
            { id: 'runs', label: 'Runs', icon: 'runs', crumb: 'Activity' }
        ] },
        { title: 'Download', items: [
            { id: 'spt', label: 'SPT', icon: 'file', crumb: 'Download' },
            { id: 'ebupot', label: 'e-Bupot', icon: 'fileCheck', crumb: 'Download' },
            { id: 'bpsaya', label: 'Bukti Potong Saya', icon: 'inbox', crumb: 'Download' },
            { id: 'faktur', label: 'e-Faktur', icon: 'receipt', crumb: 'Download' }
        ] },
        { title: 'Change in Coretax', items: [
            { id: 'impor', label: 'e-Bupot Upload & Issue', full: 'e-Bupot Upload, Issue & Sign', icon: 'upload', crumb: 'Change in Coretax', kind: 'write', hideForRestricted: true },
            { id: 'kredit', label: 'Credit Faktur Masukan', icon: 'badge', crumb: 'Change in Coretax', kind: 'write' },
            { id: 'billing', label: 'PPh 25 Kode Billing', icon: 'bank', crumb: 'Change in Coretax', kind: 'write' },
            { id: 'dividen', label: 'e-Reporting', full: 'Laporan Realisasi Investasi (Dividen)', icon: 'coins', crumb: 'Change in Coretax', kind: 'write' }
        ] },
        { title: 'Year-End', items: [
            { id: 'a1', label: 'Annual PPh 21 Recap', icon: 'cal', crumb: 'Year-End', hideForRestricted: true }
        ] }
    ];

    // ---------- Potongan bersama ----------
    function loginText(ent) {
        if (!ent) return '-';
        if (ent.project === 'manual') return 'Manual · open session';
        // Lokal (kredensial tersimpan) login otomatis persis seperti Taxio Hub - ent sudah
        // diratakan (flattenSelection) jadi pic_name-nya sudah PIC yang benar-benar terpilih.
        return 'Automatic' + (ent.pic_name ? ' · PIC ' + ent.pic_name : '');
    }
    function readiness(ent) {
        if (!ent) return { ok: false, reason: 'Select an entity first' };
        if (L.isManualLike(ent) && !P.state.manual.loggedIn) return { ok: false, reason: 'Waiting for manual login' };
        return { ok: true };
    }
    /** Bilah aksi lengket di bawah formulir (menggantikan rail ringkasan kanan): satu kalimat tentang apa yang akan
     *  dijalankan + satu tombol utama. o: { count, unit, parts[] (HTML sudah di-escape), dest, sub (HTML), ready,
     *  blocked, cta, icon, act, extra (tombol sekunder) }. */
    const destText = () => P.saveRoot() || 'Downloads\\CoretaxAgent';
    const whoText = (ent) => (!ent ? '' : L.isManualLike(ent) ? 'Manual session' : ent.entity_name);
    function actionBar(o) {
        const ready = o.ready || { ok: true };
        const why = !ready.ok ? ready.reason : o.blocked;
        const bits = [];
        if (o.count !== undefined) bits.push('<b><span class="abar-n">' + o.count + '</span> ' + esc(o.unit || '') + '</b>');
        (o.parts || []).filter(Boolean).forEach((x) => bits.push(x));
        const line = bits.join('<span class="abar-dot"> · </span>') + (o.dest ? ' <span class="abar-to">→</span> <span class="mono abar-dest">' + esc(destText()) + '</span>' : '');
        const sub = why ? '<span class="abar-why">' + esc(why) + '</span>' + (o.sub ? '<span class="abar-dot"> · </span>' + o.sub : '') : (o.sub || '');
        return '<div class="abar-sum"><div class="abar-line">' + line + '</div>' + (sub ? '<div class="abar-sub">' + sub + '</div>' : '') + '</div>'
            + (o.extra || '')
            + '<button type="button" class="btn btn-primary btn-lg" data-act="' + (o.act || 'start') + '"' + (why ? ' disabled' : '') + ' title="Ctrl+Enter">' + P.icon(o.icon || 'play', 17, '', 2) + esc(o.cta || 'Start') + '</button>';
    }
    const loginSub = (ent) => (ent ? 'Login: ' + esc(loginText(ent)) : '');
    /** Halaman Download: bilah aksi untuk satu klien (kalimat seperti biasa) atau banyak klien (hitungan x klien,
     *  tombol "Start N downloads", terkunci sampai PIC tiap klien ber-PIC banyak dipilih). Bagian "siapa" selalu terakhir. */
    function withClients(o, ent) {
        const rows = P.multi.rows(), n = rows.length;
        if (n < 2) { o.parts.push(esc(whoText(ent))); return o; }
        const pend = rows.find((r) => r.pending);
        o.count = (o.count || 0) * n; o.unit = o.count === 1 ? 'download' : 'downloads';
        o.parts.push(n + ' clients');
        o.sub = 'Each client signs in with its own PIC';
        if (!o.blocked && pend) o.blocked = 'Choose a PIC for ' + pend.entity.entity_name;
        if (o.count > 0) o.cta = 'Start ' + o.count + ' downloads';
        return o;
    }
    // ---------- Baris "For": klien untuk unduhan (hanya halaman Download) ----------
    let chipSeen = new Set();
    function chipHtml(r, many) {
        const e = r.entity, pics = e.pics || [];
        const sel = r.primary ? (r.flat && r.flat.pic_id) : r.picId;
        let pic;
        if (pics.length > 1) {
            pic = '<select class="cc-pic' + (r.pending ? ' need' : '') + '" data-multi-pic="' + esc(r.key) + '" aria-label="PIC for ' + esc(e.entity_name) + '">'
                + (sel ? '' : '<option value="" selected>Choose PIC…</option>')
                + pics.map((p) => '<option value="' + esc(p.pic_id) + '"' + (p.pic_id === sel ? ' selected' : '') + '>PIC ' + esc(p.pic_name) + '</option>').join('') + '</select>';
        } else pic = '<span class="cc-sub">' + esc(pics.length === 1 ? 'PIC ' + pics[0].pic_name : E.typeLabel(e)) + '</span>';
        const can = many && P.multi.canRemove(r.key);
        const x = many ? '<button type="button" class="cc-x" data-act="multi-rm" data-key="' + esc(r.key) + '" aria-label="Remove ' + esc(e.entity_name) + '"' + (can ? '' : ' disabled title="Choose a PIC for another client first"') + '>' + P.icon('x', 13, '', 2.4) + '</button>' : '';
        return '<span class="cchip' + (r.pending ? ' pending' : '') + (chipSeen.has(r.key) ? '' : ' new') + '" data-chip="' + esc(r.key) + '"><span class="cc-av">' + esc(L.initials(e.entity_name)) + '</span>'
            + '<span class="cc-tx"><b title="' + esc(e.entity_name) + '">' + esc(e.entity_name) + '</b>' + pic + '</span>' + x + '</span>';
    }
    function forRowHtml() {
        const rows = P.multi.rows();
        if (!rows.length || rows[0].entity.project === 'manual') { chipSeen = new Set(); return ''; }
        const html = '<section class="for-bar" aria-label="Clients for this download"><span class="for-l">For</span><div class="for-chips">' + rows.map((r) => chipHtml(r, rows.length > 1)).join('') + '</div>'
            + '<button type="button" class="btn btn-sm" data-act="multi-add">' + P.icon('plus', 15, '', 2.2) + 'Add clients</button></section>';
        chipSeen = new Set(rows.map((r) => r.key));
        return html;
    }
    // ---------- Tinjau + kirim: satu permintaan aksi biasa per klien, `batch` yang sama ----------
    const batchId = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    /** send(flat) mengirim satu klien (melempar bila ditolak). Menutup dialog dan membuka Runs bila semuanya diterima. */
    async function reviewDialog(rows, total, label, send) {
        let limit = 0;
        try { const d = await P.api('/api/runs'); limit = Number(d && d.limits && d.limits.total) || 0; } catch (e) { /* tanpa angka batas */ }
        const scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.id = 'review';
        const nm = (r) => '<span class="rv-av">' + esc(L.initials(r.entity.entity_name)) + '</span><span class="rv-tx"><b>' + esc(r.entity.entity_name) + '</b><span>' + esc(r.flat && r.flat.pic_name ? 'PIC ' + r.flat.pic_name : E.typeLabel(r.entity)) + '</span></span>';
        const dl = total + (total === 1 ? ' download' : ' downloads');
        scrim.innerHTML = '<div class="dialog narrow rv" role="dialog" aria-label="Review downloads"><div class="dialog-head"><h2>Review Downloads</h2><button type="button" class="icon-btn" aria-label="Close" data-rv="close">' + P.icon('x', 18) + '</button></div>'
            + '<div class="dialog-body"><div class="rv-sum"><div><b>' + esc(dl) + '</b> · ' + rows.length + ' clients</div><span>' + esc(label) + '</span></div>'
            + '<ul class="rv-list">' + rows.map((r) => '<li class="rv-row" data-rv-key="' + esc(r.key) + '">' + nm(r) + '<span class="rv-st">Ready</span></li>').join('') + '</ul>'
            + '<p class="hint" id="rv-hint">Runs start as Coretax windows become available' + (limit ? ' (up to ' + limit + ' at a time)' : '') + '. The rest wait in line; follow them on the Runs page.</p></div>'
            + '<div class="dialog-foot"><span class="grow"></span><button type="button" class="btn" data-rv="close">Cancel</button><button type="button" class="btn btn-primary" data-rv="go">' + P.icon('play', 16, '', 2) + 'Start ' + esc(dl) + '</button></div></div>';
        document.body.appendChild(scrim);
        let sending = false;
        const close = () => { document.removeEventListener('keydown', onKey); scrim.remove(); };
        const onKey = (e) => { if (e.key === 'Escape' && !sending) close(); };
        document.addEventListener('keydown', onKey);
        scrim.addEventListener('mousedown', (e) => { if (e.target === scrim && !sending) close(); });
        scrim.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-rv]'); if (!b || sending) return;
            if (b.dataset.rv === 'close') return close();
            if (b.dataset.rv === 'runs') { close(); P.run.poll(); return P.shell.go('runs'); }
            sending = true; b.disabled = true; b.textContent = 'Starting…';
            const bad = [];
            for (const r of rows) {
                const li = scrim.querySelector('[data-rv-key="' + CSS.escape(r.key) + '"] .rv-st');
                try { await send(r.flat, r); if (li) { li.className = 'rv-st ok'; li.textContent = 'Queued'; } }
                catch (err) { bad.push(r); if (li) { li.className = 'rv-st bad'; li.textContent = err.message; li.title = err.message; } }
            }
            sending = false;
            if (!bad.length) { close(); P.run.poll(); return P.shell.go('runs'); }
            const okN = rows.length - bad.length;
            scrim.querySelector('#rv-hint').textContent = bad.length + (bad.length === 1 ? ' client was' : ' clients were') + ' not started. ' + (okN ? okN + ' started and ' + (okN === 1 ? 'is' : 'are') + ' on the Runs page.' : 'Nothing was started.');
            scrim.querySelector('.dialog-foot').innerHTML = '<span class="grow"></span><button type="button" class="btn" data-rv="close">Close</button>' + (okN ? '<button type="button" class="btn btn-primary" data-rv="runs">Open Runs</button>' : '');
            const f = scrim.querySelector('.dialog-foot .btn-primary') || scrim.querySelector('.dialog-foot .btn'); if (f) f.focus();
        });
        const go = scrim.querySelector('[data-rv="go"]'); if (go) go.focus();
    }
    /** "Options": hanya folder tujuan (keputusan pemilik 2026-11-14). Terbuka/tertutup diingat. */
    function optionsHtml() {
        const open = !!P.store.get('optsOpen', false);
        return '<section class="card opts"><div class="card-head"><h2>Options</h2></div><div class="card-body">'
            + '<button type="button" class="disc" data-opts aria-expanded="' + open + '">' + P.icon('right', 14) + '<span>Destination folder</span><span class="disc-val mono">' + esc(destText()) + '</span></button>'
            + '<div class="coll' + (open ? ' open' : '') + '"><div><div class="ci">' + P.folderField() + '</div></div></div></div></section>';
    }
    /** Banner login manual: menuntun pengguna untuk login sendiri di jendela Coretax. Hanya
     *  untuk sesi Coretax POLOS (project 'manual') - entitas lokal berkredensial (tab Saya)
     *  login otomatis persis seperti Taxio Hub, tidak pernah lewat sini. */
    function manualBanner(ent) {
        if (!ent || !L.isManualLike(ent)) return '';
        const m = P.state.manual;
        const who = 'The currently open Coretax session is used as is.';
        if (m.loggedIn) {
            return '<div class="banner ok"><span class="ico">' + P.icon('check', 20, '', 2.4) + '</span><div class="body"><b>Coretax session detected</b><span>' + esc(m.identity || 'Signed in to Coretax.') + ' Make sure this is the right account before starting.</span></div></div>';
        }
        const steps = [['1', 'Open Coretax'], ['2', 'Log in'], ['3', 'Check session']];
        return '<div class="banner ' + (m.open ? 'warn' : 'info') + '"><span class="ico">' + P.icon('globe', 22) + '</span><div class="body"><b>' + (m.open ? 'Waiting for manual login in the Coretax window' : 'Coretax opens in a separate window') + '</b><span>' + who + ' The agent waits, and continues as soon as the session is detected.</span>'
            + '<div class="row" style="gap:8px;margin-top:8px"><button type="button" class="btn btn-sm btn-primary" data-act="open-coretax">' + P.icon('globe', 15) + (m.open ? 'Show window' : 'Open Coretax') + '</button><button type="button" class="btn btn-sm" data-act="check-session">' + P.icon('shield', 15) + 'Check session</button></div></div>'
            + '<div class="banner-steps">' + steps.map(([n, t]) => '<span><i>' + n + '</i>' + t + '</span>').join('') + '</div></div>';
    }
    /** Belum ada entitas: formulir tetap tampil (bisa disiapkan dulu), hanya diberi banner untuk memilih
     *  entitas; tombol Mulai di ringkasan tetap terkunci sampai entitas dipilih. */
    function entityGuard() {
        return '<div class="banner info"><span class="ico">' + P.icon('search', 20) + '</span><div class="body"><b>No entity selected</b>'
            + '<span>You can prepare the form first. Select an entity from Taxio Hub, or add a new client, before starting.</span>'
            + '<div class="row" style="gap:8px;margin-top:8px"><button type="button" class="btn btn-sm btn-primary" data-act="open-palette">' + P.icon('search', 15) + 'Search entity</button></div></div></div>';
    }
    const kodeHint = (n, unit) => n + ' ' + unit;

    // ---------- Kerangka halaman ----------
    function createPage(def) {
        const st = {};
        let root = null;
        let busy = false;
        let override = null; // klien yang sedang dikirim saat banyak klien
        let bcur = null; // { id, label, total, i }: batch yang sedang dikirim
        const api = { st, entity: () => override || E.current(), sel: () => E.selected, redraw, updateRail, def,
            inBatch: () => !!bcur, nextBatch: () => (bcur ? { id: bcur.id, label: bcur.label, total: bcur.total, index: bcur.i++ } : undefined),
            /** Perorangan / sesi manual saja yang boleh dipakai jenis tertentu: berlaku bila SEMUA klien terpilih begitu. */
            allIndividual: () => { const rows = def.batch ? P.multi.rows() : []; const cur = api.entity(); return !!cur && (rows.length ? rows.map((r) => r.entity) : [cur]).every((e) => e.project === 'manual' || e.individual); } };
        Object.assign(st, def.init(api));

        function railHtml() {
            const ent = api.entity();
            if (def.needsEntity !== false && !ent) return actionBar({ parts: ['<span class="muted">No entity selected</span>'], ready: { ok: false, reason: 'Select an entity first' }, cta: def.cta || 'Start', icon: def.ctaIcon });
            return def.rail(st, api);
        }
        function html() {
            const ent = api.entity();
            if (def.normalize) def.normalize(st, api);
            const need = def.needsEntity !== false;
            const main = (need ? (ent ? manualBanner(ent) : entityGuard()) : '') + (def.batch && ent ? forRowHtml() : '') + def.main(st, api) + (def.folder ? optionsHtml() : '');
            return P.run.summaryHtml() + '<div class="col-main">' + main + '</div><div class="abar" id="abar">' + railHtml() + '</div>';
        }
        function afterDraw() {
            P.bindFolderField(root);
            if (def.afterDraw) def.afterDraw(st, api, root);
        }
        function redraw() {
            if (!root) return;
            const scroller = root.closest('.content');
            const top = scroller ? scroller.scrollTop : 0;
            const activeId = document.activeElement && document.activeElement.id;
            root.innerHTML = html();
            afterDraw();
            if (scroller) scroller.scrollTop = top;
            if (activeId) { const el = document.getElementById(activeId); if (el && el.focus) el.focus(); }
        }
        function updateRail() {
            const bar = root && root.querySelector('#abar');
            if (!bar) return;
            bar.innerHTML = railHtml();
            const dv = root.querySelector('.disc-val'); if (dv) dv.textContent = destText();
        }
        async function onClick(e) {
            const dismiss = e.target.closest('[data-dismiss-run]');
            if (dismiss) { P.run.dismissed = P.run.finished && P.run.finished.at; redraw(); return; }
            const opts = e.target.closest('[data-opts]');
            if (opts) {
                const open = opts.getAttribute('aria-expanded') !== 'true';
                opts.setAttribute('aria-expanded', String(open)); P.store.set('optsOpen', open);
                const c = opts.nextElementSibling; if (c) c.classList.toggle('open', open);
                return;
            }
            const t = e.target.closest('[data-act]');
            if (!t || !root.contains(t) || t.closest('.pp')) return;
            const act = t.dataset.act;
            if (act === 'open-palette') return E.openPalette();
            if (act === 'multi-add') return E.openPalette({ multi: true });
            if (act === 'multi-rm') {
                const chip = t.closest('.cchip'); if (chip) chip.classList.add('leaving');
                setTimeout(() => P.multi.remove(t.dataset.key), chip ? 160 : 0);
                return;
            }
            if (act === 'open-coretax') return P.manual.open();
            if (act === 'check-session') return P.manual.check(true);
            if (act === 'start') {
                if (busy) return;
                if (def.batch && P.multi.count() > 1) return startMany();
                busy = true; t.disabled = true;
                try { await def.start(st, api); P.run.poll(); }
                catch (err) { P.toast('Failed to start: ' + err.message); }
                busy = false;
                updateRail();
                return;
            }
            if (def.act && def.act(act, t.dataset, st, api) !== false) redraw();
        }
        /** Banyak klien: tinjau, lalu kirim satu permintaan aksi biasa per klien (batch yang sama); antrean server mengatur batas paralel. */
        function startMany() {
            const rows = P.multi.rows(); if (rows.some((r) => r.pending)) return;
            const units = def.units ? def.units(st) : 1, total = rows.length * units;
            const label = (def.batchLabel(st) + ' for ' + rows.length + ' clients').slice(0, 120);
            const id = batchId(); let n = 0;
            return reviewDialog(rows, total, label, async (flat) => {
                override = flat; bcur = { id, label, total, i: n * units }; n++;
                try { await def.start(st, api); } finally { override = null; bcur = null; }
            });
        }
        function onInput(e) {
            if (e.target.dataset && e.target.dataset.multiPic !== undefined) { if (e.type === 'change') P.multi.setPic(e.target.dataset.multiPic, e.target.value || null); return; }
            if (e.target.id === 'save-root-input' && e.type === 'input') { P.store.set('saveRoot', e.target.value.trim()); updateRail(); return; }
            const key = e.target.dataset && e.target.dataset.bind;
            if (!key) return;
            // Kolom teks bereaksi pada 'input' saja. Jika 'change' (saat kehilangan fokus) ikut menggambar
            // ulang ringkasan, tombol di bawah kursor diganti di antara tekan dan lepas mouse, dan klik
            // pertama pada tombol itu hilang. Hanya <select> yang perlu 'change'.
            const isSelect = e.target.tagName === 'SELECT';
            if (isSelect ? e.type !== 'change' : e.type === 'change') return;
            let v = e.target.value;
            if (e.target.dataset.money !== undefined) { v = L.rupiah(v); e.target.value = v; }
            st[key] = v;
            if (e.target.tagName === 'SELECT') redraw(); else updateRail();
        }
        return {
            id: def.id, def, st, api,
            mount(el) {
                root = el;
                root.innerHTML = html();
                if (!root.__pilotBound) { root.addEventListener('click', onClick); root.addEventListener('input', onInput); root.addEventListener('change', onInput); root.__pilotBound = true; }
                afterDraw();
            },
            refresh() { redraw(); },
            updateRail
        };
    }

    // ---------- Aturan yang dipakai beberapa halaman ----------
    const restricted = () => P.isRestricted();
    // "Baris per halaman" dulu ada di sini (Otomatis/100/50/25/10), dihapus dari form - sejak
    // e-Bupot/Bukti Potong Saya pindah ke pengambilan API langsung, angka ini cuma jadi ukuran
    // batch per panggilan API, bukan lagi menyamai tampilan Coretax. Selalu mulai dari 100
    // (state.pageSize tetap 'auto' -> automation/*.js jatuh ke default 100). Kontrol yang
    // benar-benar berguna (ubah ukuran batch DI TENGAH proses kalau lemot/gagal) tetap ada di
    // layar "Sedang Berjalan" (lihat P.run - tombol 10/25/50/100 di run-controls).

    // =========================================================
    // SPT
    // =========================================================
    const SPT_MONTHLY = [['pph21', '21/26', 'PPh 21/26'], ['unifikasi', 'UNI', 'PPh Unifikasi'], ['ppn', 'PPN', 'PPN']];
    const SPT_ANNUAL = [['badan', '1771', 'PPh Badan'], ['spt_op', '1770', 'PPh Orang Pribadi']];
    const ANNUAL_KEYS = ['badan', 'spt_op'];
    const spt = createPage({
        id: 'spt', batch: true, folder: true, cta: 'Start download', ctaIcon: 'download',
        init(api) {
            return { jenis: new Set([restricted() ? 'unifikasi' : 'pph21']), bpe: true, induk: true, lampiran: false, fmt: 'pdf', isi: 'print', sus: 'combined',
                ppM: P.period.create({ mode: 'masa', onChange: () => api.updateRail() }), ppY: P.period.create({ mode: 'tahun', onChange: () => api.updateRail() }) };
        },
        normalize(st, api) {
            const opAllowed = api.allIndividual();
            if (!opAllowed) st.jenis.delete('spt_op');
            if (restricted()) st.jenis.delete('pph21');
            const onlyPph21 = st.jenis.size === 1 && st.jenis.has('pph21');
            if (st.isi === 'confidential' && !onlyPph21) st.isi = 'print';
        },
        afterDraw(st) { (isAnnual(st) ? st.ppY : st.ppM).bind(); },
        main(st, api) {
            const opAllowed = api.allIndividual();
            const annual = isAnnual(st);
            const onlyPph21 = st.jenis.size === 1 && st.jenis.has('pph21');
            const tiles = (list, cols) => '<div class="tiles ' + cols + '">' + list.map(([k, code, title]) => {
                const dis = (k === 'pph21' && restricted()) || (k === 'spt_op' && !opAllowed);
                const sub = k === 'spt_op' && !opAllowed ? 'Individual entities only' : (ANNUAL_KEYS.includes(k) ? 'SPT Tahunan' : 'SPT Masa');
                return P.tile('jenis', k, st.jenis.has(k), code, title, sub, { disabled: dis, title: dis && k === 'pph21' ? 'SPT PPh 21 is not available for Restricted users.' : '' });
            }).join('') + '</div>';
            const pp = annual ? st.ppY : st.ppM;
            // Lampiran ditonjolkan (keputusan pemilik 2026-11-14): format dan versi langsung di formulir saat dipilih.
            // Tata letak PDF tidak lagi dipilih: selalu digabung (outputLayout 'combined').
            const lamp = st.lampiran
                ? '<div class="subpanel"><div class="field"><span class="label">Lampiran format</span>' + P.seg('fmt', [{ value: 'pdf', label: 'PDF' }, { value: 'excel', label: 'Excel' }, { value: 'both', label: 'PDF + Excel' }], st.fmt) + '</div>'
                    + (st.fmt !== 'excel' ? '<div class="field"><span class="label">Version</span>' + P.seg('isi', [{ value: 'print', label: 'Compact' }, { value: 'full', label: 'Full' }, { value: 'confidential', label: 'Confidential', disabled: !onlyPph21, title: 'PPh 21/26 only' }], st.isi) + '</div>' : '')
                    + '<div class="full hint">' + (st.fmt === 'excel' ? 'Excel always holds all rows, one sheet per Lampiran.' : ({ print: 'Compact: first 50 rows of each table. Totals cover all data.', full: 'Full: every row, up to 1,000 per table; larger tables are complete in the Lampiran Excel.', confidential: 'Confidential: without recipient details. PPh 21/26 only.' }[st.isi])) + '</div></div>' : '';
            return P.card(1, 'Jenis Pajak', '<span>Annual: one at a time</span>',
                '<div class="stack"><div class="eyebrow">SPT Masa</div>' + tiles(SPT_MONTHLY, 'c3') + '</div><div class="stack"><div class="eyebrow">SPT Tahunan</div>' + tiles(SPT_ANNUAL, 'c2') + '</div>')
                + P.card(2, annual ? 'Tahun Pajak' : 'Masa Pajak', annual ? 'Full year, Jan–Dec' : '', pp.html())
                + P.card(3, 'Documents', '',
                    '<div class="stack">' + P.docRow('bpe', st.bpe, 'fileCheck', 'BPE', 'Bukti Penerimaan Elektronik')
                    + P.docRow('induk', st.induk, 'file', 'Induk', 'Main SPT form')
                    + P.docRow('lampiran', st.lampiran, 'sheet', 'Lampiran', 'All Lampiran, also those without an official PDF') + lamp + '</div>');
        },
        act(act, d, st, api) {
            if (act === 'jenis') {
                const k = d.val;
                if (ANNUAL_KEYS.includes(k)) { const had = st.jenis.has(k); st.jenis.clear(); if (!had) st.jenis.add(k); }
                else { ANNUAL_KEYS.forEach((a) => st.jenis.delete(a)); if (st.jenis.has(k)) st.jenis.delete(k); else st.jenis.add(k); }
            } else if (act === 'bpe' || act === 'induk' || act === 'lampiran') st[act] = !st[act];
            else if (act === 'fmt' || act === 'isi') st[act] = d.val;
            else return false;
            api.updateRail();
        },
        rail(st, api) {
            const ent = api.entity(); const annual = isAnnual(st); const pp = annual ? st.ppY : st.ppM;
            const combos = st.jenis.size * pp.count();
            const docs = [st.bpe && 'BPE', st.induk && 'Induk', st.lampiran && 'Lampiran ' + ({ pdf: 'PDF', excel: 'Excel', both: 'PDF + Excel' }[st.fmt])].filter(Boolean);
            const names = Array.from(st.jenis).map((k) => (SPT_MONTHLY.concat(SPT_ANNUAL).find((x) => x[0] === k) || [])[2]).filter(Boolean);
            let blocked = '';
            if (!st.jenis.size) blocked = 'Select a Jenis Pajak'; else if (!pp.count()) blocked = annual ? 'Select a Tahun Pajak' : 'Select a Masa Pajak'; else if (!docs.length) blocked = 'Select at least one document';
            return actionBar(withClients({ count: combos, unit: combos === 1 ? 'download' : 'downloads', parts: [esc(names.join(', ')), pp.count() ? esc(pp.unit() + ' ' + pp.code()) : '', esc(docs.join(', '))],
                dest: true, sub: loginSub(ent), ready: readiness(ent), blocked, cta: 'Start download', icon: 'download' }, ent));
        },
        async start(st, api) {
            const annual = isAnnual(st); const pp = annual ? st.ppY : st.ppM;
            const jenisPajakKeys = Array.from(st.jenis);
            if (restricted() && jenisPajakKeys.includes('pph21')) throw new Error('SPT PPh 21 is not available for Restricted users.');
            if (!st.bpe && !st.induk && !st.lampiran) throw new Error('Select at least one document to download.');
            const lampiranMode = st.fmt === 'excel' ? 'full' : st.isi;
            await P.post('/api/actions/download-spt', { entity: api.entity(), jenisPajakKeys, masaInput: pp.code(), saveRoot: P.saveRoot() || undefined, checkPph25: false,
                includeLampiran: st.lampiran, includeBpe: st.bpe, includeInduk: st.induk, lampiranMode, lampiranFormat: st.fmt, outputLayout: 'combined', layoutStyle: 'coretax', batch: api.nextBatch() });
        },
        batchLabel(st) { const pp = isAnnual(st) ? st.ppY : st.ppM; return 'SPT · ' + pp.unit() + ' ' + pp.code(); }
    });
    function isAnnual(st) { return Array.from(st.jenis).some((k) => ANNUAL_KEYS.includes(k)); }

    // =========================================================
    // e-Bupot
    // =========================================================
    const EBUPOT_TYPES = [['bp21', 'BP21', 'PPh 21 Bukti Potong'], ['bppu', 'BPPU', 'Unifikasi withholding'], ['bpa1', 'BPA1', 'A1 Bukti Potong'], ['bpmp', 'BPMP', 'Monthly, permanent employees']];
    const KODE_TYPES = ['bp21', 'bppu'];
    const ebupot = createPage({
        id: 'ebupot', batch: true, folder: true, cta: 'Start download', ctaIcon: 'download',
        init(api) {
            // Awalnya TIDAK ada jenis terpilih. Dulu BP21 sudah tercentang sejak awal, sehingga mengklik BPPU
            // menghasilkan BP21 + BPPU dan antrean mengunduh BP21 lebih dulu (dilaporkan live 2026-10-05).
            return { jenis: new Set(), status: 'issued', pdf: true, pageSize: 'auto', kode: '', pp: P.period.create({ mode: 'masa', onChange: () => api.updateRail() }) }; },
        normalize(st) { if (restricted()) { st.jenis.delete('bpmp'); st.jenis.delete('bpa1'); } },
        afterDraw(st) { st.pp.bind(); },
        main(st) {
            const forceExcel = st.status === 'not_issued' || (st.jenis.size === 1 && st.jenis.has('bpmp'));
            const showKode = Array.from(st.jenis).some((k) => KODE_TYPES.includes(k));
            return P.card(1, 'e-Bupot Type', '<span>Select at least one</span>', '<div class="tiles c2">' + EBUPOT_TYPES.map(([k, t, sub]) => {
                const dis = restricted() && (k === 'bpmp' || k === 'bpa1');
                return P.tile('jenis', k, st.jenis.has(k), t, t, sub, { disabled: dis, title: dis ? 'Not allowed for Restricted Editor.' : '' });
            }).join('') + '</div>')
                + P.card(2, 'Status and Format', '', '<div class="stack-lg"><div class="field"><span class="label">Document status</span>' + P.seg('status', [{ value: 'issued', label: 'Telah Terbit' }, { value: 'not_issued', label: 'Belum Terbit' }], st.status)
                    + '<span class="hint">Belum Terbit documents have no official PDF yet and are saved as an Excel summary only.</span></div>'
                    + '<div class="stack">' + P.docRow('excel', true, 'sheet', 'Excel', 'Summary of all data (always created)', true) + P.docRow('pdf', forceExcel ? false : st.pdf, 'file', 'PDF', forceExcel ? 'Not available for this selection' : 'Official PDF for each document', forceExcel) + '</div></div>')
                + P.card(3, 'Masa Pajak', '', st.pp.html() + (showKode ? '<div class="field"><label for="eb-kode">Kode Objek Pajak (optional)</label><input class="input mono" id="eb-kode" data-bind="kode" value="' + esc(st.kode) + '" placeholder="blank = all codes · e.g. 21-100-35;21-100-20"></div>' : ''));
        },
        act(act, d, st, api) {
            if (act === 'jenis') { if (st.jenis.has(d.val)) st.jenis.delete(d.val); else st.jenis.add(d.val); }
            else if (act === 'status') st.status = d.val;
            else if (act === 'pdf') st.pdf = !st.pdf;
            else return false;
            api.updateRail();
        },
        rail(st, api) {
            const ent = api.entity(); const n = st.jenis.size * st.pp.count();
            const forceExcel = st.status === 'not_issued' || (st.jenis.size === 1 && st.jenis.has('bpmp'));
            let blocked = ''; if (!st.jenis.size) blocked = 'Select an e-Bupot type'; else if (!st.pp.count()) blocked = 'Select a Masa Pajak';
            return actionBar(withClients({ count: n, unit: n === 1 ? 'download' : 'downloads', parts: [esc(Array.from(st.jenis).map((k) => k.toUpperCase()).join(', ')), st.status === 'not_issued' ? 'Belum Terbit' : 'Telah Terbit', st.pp.count() ? esc('Masa Pajak ' + st.pp.code()) : '', forceExcel || !st.pdf ? 'Excel' : 'Excel + PDF'],
                dest: true, sub: loginSub(ent) + (st.jenis.size > 1 ? ' · types run one after another' : ''), ready: readiness(ent), blocked, cta: 'Start download', icon: 'download' }, ent));
        },
        async start(st, api) {
            const types = Array.from(st.jenis);
            const items = types.map((bupotType) => ({
                entity: api.entity(), bupotType, documentStatus: st.status, masaInput: st.pp.code(), kodeInput: KODE_TYPES.includes(bupotType) ? st.kode.trim() : '', saveRoot: P.saveRoot() || undefined, pageSize: st.pageSize,
                outputMode: st.status === 'not_issued' || bupotType === 'bpmp' ? 'excel_only' : (st.pdf ? 'pdf_excel' : 'excel_only')
            }));
            // Banyak klien: tiap jenis langsung dikirim (antrean server yang mengatur); satu klien: berantai di latar seperti biasa.
            if (api.inBatch()) { for (const it of items) await P.post('/api/actions/download-ebupot', Object.assign(it, { batch: api.nextBatch() })); return; }
            P.run.runQueue(items); // berantai di latar; halaman berpindah ke tampilan proses lewat polling
        },
        units: (st) => st.jenis.size,
        batchLabel: (st) => 'e-Bupot · Masa Pajak ' + st.pp.code()
    });

    // =========================================================
    // Bukti Potong Saya (yang diterima)
    // =========================================================
    const MYBUPOT = [['bppu', 'BPPU', 'BPPU', false], ['bpnr', 'BPNR', 'BPNR', false], ['bp26', 'BP26', 'BP26', false], ['bpatc', 'DOK', 'Dokumen yang Dipersamakan', false],
        ['bpmp', 'BPMP', 'BPMP', true], ['bp21', 'BP21', 'BP21', true], ['bpa1', 'A1', 'BPA1', true], ['bpa2', 'A2', 'BPA2', true]];
    const bpsaya = createPage({
        id: 'bpsaya', batch: true, folder: true, cta: 'Start download', ctaIcon: 'download',
        init(api) { return { jenis: new Set(['bppu']), pdf: true, pageSize: 'auto', pp: P.period.create({ mode: 'masa', onChange: () => api.updateRail() }) }; },
        normalize(st, api) {
            const personalOk = api.allIndividual();
            MYBUPOT.forEach(([k, , , personal]) => { if ((personal && !personalOk) || (restricted() && (k === 'bpmp' || k === 'bpa1'))) st.jenis.delete(k); });
        },
        afterDraw(st) { st.pp.bind(); },
        main(st, api) {
            const personalOk = api.allIndividual();
            const group = (title, personal) => '<div class="stack"><div class="eyebrow">' + title + '</div><div class="tiles c2">' + MYBUPOT.filter((m) => m[3] === personal).map(([k, code, title]) => {
                const dis = (personal && !personalOk) || (restricted() && (k === 'bpmp' || k === 'bpa1'));
                const why = restricted() && (k === 'bpmp' || k === 'bpa1') ? 'Not allowed for Restricted Editor.' : (personal && !personalOk ? 'Individual (PIC) accounts only.' : '');
                return P.tile('jenis', k, st.jenis.has(k), code, title, personal ? 'In the PIC\'s own name' : 'Owned by the entity', { disabled: dis, title: why });
            }).join('') + '</div></div>';
            return P.card(1, 'Bukti Potong Type', '<span>Bukti Potong received</span>', group('Owned by the entity', false) + group('Owned by the PIC personally', true)
                + (!personalOk ? '<div class="hint">PIC-owned types are only available when using an individual account.</div>' : ''))
                + P.card(2, 'Format', '', '<div class="stack">' + P.docRow('excel', true, 'sheet', 'Excel', 'Summary of all data (always created)', true) + P.docRow('pdf', st.pdf, 'file', 'PDF', 'Official PDF for each Bukti Potong') + '</div>')
                + P.card(3, 'Masa Pajak', '', st.pp.html());
        },
        act(act, d, st, api) {
            if (act === 'jenis') { if (st.jenis.has(d.val)) st.jenis.delete(d.val); else st.jenis.add(d.val); }
            else if (act === 'pdf') st.pdf = !st.pdf;
            else return false;
            api.updateRail();
        },
        rail(st, api) {
            const ent = api.entity(); let blocked = ''; if (!st.jenis.size) blocked = 'Select a Bukti Potong type'; else if (!st.pp.count()) blocked = 'Select a Masa Pajak';
            const n = st.jenis.size * st.pp.count();
            return actionBar(withClients({ count: n, unit: n === 1 ? 'download' : 'downloads', parts: [esc(Array.from(st.jenis).map((k) => (MYBUPOT.find((m) => m[0] === k) || [])[2] || k).join(', ')), st.pp.count() ? esc('Masa Pajak ' + st.pp.code()) : '', st.pdf ? 'Excel + PDF' : 'Excel'],
                dest: true, sub: loginSub(ent), ready: readiness(ent), blocked, cta: 'Start download', icon: 'download' }, ent));
        },
        async start(st, api) {
            await P.post('/api/actions/download-mybupot', { entity: api.entity(), buktiTypeKeys: Array.from(st.jenis), masaInput: st.pp.code(), saveRoot: P.saveRoot() || undefined, pageSize: st.pageSize, outputMode: st.pdf ? 'pdf_excel' : 'excel_only', batch: api.nextBatch() });
        },
        batchLabel: (st) => 'Bukti Potong Saya · Masa Pajak ' + st.pp.code()
    });

    // =========================================================
    // Unduh Faktur Masukan
    // =========================================================
    const EFAKTUR_TYPES = [
        ['input', 'Pajak Masukan'], ['output', 'Pajak Keluaran'],
        ['inputReturn', 'Retur Pajak Masukan'], ['outputReturn', 'Retur Pajak Keluaran'],
        ['sdInput', 'Dokumen Lain Masukan'], ['sdOutput', 'Dokumen Lain Keluaran'],
        ['sdInputReturn', 'Retur Dokumen Lain Masukan'], ['sdOutputReturn', 'Retur Dokumen Lain Keluaran']
    ];
    const faktur = createPage({
        id: 'faktur', batch: true, folder: true, cta: 'Start download', ctaIcon: 'download',
        init(api) { return { pp: P.period.create({ mode: 'masa', onChange: () => api.updateRail() }), types: ['input'], excel: true, csv: false }; },
        afterDraw(st) { st.pp.bind(); },
        main(st) {
            const chips = EFAKTUR_TYPES.map(([key, label]) => '<button type="button" class="chip" data-act="etype" data-val="' + key + '" aria-pressed="' + st.types.includes(key) + '">' + esc(label) + '</button>').join('');
            return P.card(1, 'Document Type', '<span><button type="button" class="link" data-act="eall">Select all</button> · <button type="button" class="link" data-act="enone">Clear</button></span>', '<div class="chips c2 wide" id="efaktur-types">' + chips + '</div>')
                + P.card(2, 'Masa Pajak', '', st.pp.html())
                + P.card(3, 'Format', '<span>Both allowed</span>', '<div class="chips c2 wide"><button type="button" class="chip" data-act="efmt" data-val="excel" aria-pressed="' + st.excel + '">Excel<span class="hint">One file, one sheet per type · fast</span></button>'
                    + '<button type="button" class="chip" data-act="efmt" data-val="csv" aria-pressed="' + st.csv + '">Official Coretax CSV<span class="hint">Zip built by the Coretax server · may take a few minutes</span></button></div>');
        },
        act(act, d, st) {
            if (act === 'etype') { st.types = st.types.includes(d.val) ? st.types.filter((k) => k !== d.val) : st.types.concat(d.val); return true; }
            if (act === 'eall') { st.types = EFAKTUR_TYPES.map((t) => t[0]); return true; }
            if (act === 'enone') { st.types = []; return true; }
            if (act === 'efmt') { st[d.val] = !st[d.val]; return true; }
            return false;
        },
        rail(st, api) {
            const ent = api.entity();
            const fmt = [st.excel ? 'Excel' : '', st.csv ? 'Official CSV' : ''].filter(Boolean).join(' + ') || '-';
            let blocked = '';
            if (!st.types.length) blocked = 'Select a document type'; else if (!st.pp.count()) blocked = 'Select a Masa Pajak'; else if (!st.excel && !st.csv) blocked = 'Select a format';
            return actionBar(withClients({ count: st.types.length, unit: st.types.length === 1 ? 'document type' : 'document types', parts: [st.pp.count() ? esc('Masa Pajak ' + st.pp.code()) : '', esc(fmt)],
                dest: true, sub: loginSub(ent), ready: readiness(ent), blocked, cta: 'Start download', icon: 'download' }, ent));
        },
        async start(st, api) { await P.post('/api/actions/download-efaktur', { entity: api.entity(), masaInput: st.pp.code(), types: st.types, excel: st.excel, csv: st.csv, saveRoot: P.saveRoot() || undefined, batch: api.nextBatch() }); },
        batchLabel: (st) => 'e-Faktur · Masa Pajak ' + st.pp.code()
    });

    // =========================================================
    // Mode A1 (SPT PPh 21 setahun)
    // =========================================================
    /** Status per masa dari hasil sebelumnya (folder "Simpan ke", atau folder / Excel Mode A1 lama yang dipilih). */
    async function a1Inspect(st, api) {
        const ent = api.entity();
        if (!ent) { st.inspect = { error: 'Select an entity first.' }; api.redraw(); return; }
        st.inspect = { loading: true }; api.redraw();
        try { st.inspect = await P.post('/api/a1/inspect', { entity: ent, year: String(st.year), source: st.source || undefined, saveRoot: P.saveRoot() || undefined }); }
        catch (e) { st.inspect = { error: e.message }; }
        api.redraw();
    }
    function a1SourceHtml(st) {
        const btn = (act, icon, label) => '<button type="button" class="btn btn-sm" data-act="' + act + '">' + P.icon(icon, 15) + label + '</button>';
        // Satu pilihan saja: Excel rekap lama (foldernya ikut diperiksa untuk cache & PDF). Tanpa memilih,
        // folder "Simpan ke" yang diperiksa.
        const buttons = '<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">' + btn('a1src-excel', 'sheet', 'Select old recap Excel…')
            + btn('a1src-check', 'search', 'Check') + (st.source ? btn('a1src-clear', 'x', 'Back to the "Save to" folder') : '') + '</div>';
        const i = st.inspect;
        if (!i) return buttons + '<div class="hint" style="margin-top:8px">Without selecting a file, previous results are looked up in the "Save to" folder. Click Check to see which periods already exist.</div>';
        if (i.loading) return buttons + '<div class="hint" style="margin-top:8px">Checking…</div>';
        if (i.error) return buttons + '<div class="hint warn" style="margin-top:8px">' + esc(i.error) + '</div>';
        const data = (r) => r.cache ? 'Cache · Pembetulan ' + r.cache.revision : r.excel && /^Lengkap/.test(r.excel.data) ? 'Old Excel · Pembetulan ' + r.excel.revision : r.excel ? esc(r.excel.data) : '—';
        const plan = (r) => (r.cache || (r.excel && /^Lengkap/.test(r.excel.data))) && r.pdf ? '<b>Reuse</b>*' : r.excel && /Belum ada SPT/.test(r.excel.data) ? 'Re-check' : 'Download';
        const rows = i.rows.map((r) => '<tr><td>' + r.masa + '</td><td>' + data(r) + '</td><td style="text-align:center">' + (r.pdf ? '✓' : '—') + '</td><td>' + plan(r) + '</td></tr>').join('');
        return buttons + (i.a1Dir ? '<div class="hint" style="margin-top:10px">Recap saved to: <b>' + esc(i.a1Dir) + '</b>' + (i.taxServer ? ' (Tax Server folder)' : '') + '</div>' : '') + '<div class="hint" style="margin-top:10px">' + (i.excel ? 'Excel: ' + esc(i.excel) : 'No old recap Excel (… ' + st.year + ' - Rekap SPT PPh 21 Setahun (A1).xlsx) in this source.') + (i.excelError ? ' <span class="warn">(' + esc(i.excelError) + ')</span>' : '') + '</div>'
            + '<table class="mini-table" style="width:100%;margin-top:6px;font-size:12.5px;border-collapse:collapse"><thead><tr><th style="text-align:left">Masa</th><th style="text-align:left">Previous data</th><th>PDF</th><th style="text-align:left">Plan</th></tr></thead><tbody>' + rows + '</tbody></table>'
            + '<div class="hint" style="margin-top:6px">* Reused if the SPT version (Pembetulan) in Coretax is unchanged; if there is a new Pembetulan, that Masa Pajak is downloaded. Details appear in the log while the process runs.</div>';
    }

    // Halaman Mode A1 = Unduh setahun + Pembetulan NIK BPMP (nikForm) + XML BPA1 dari Draft SPT Desember (bpa1Form), dipilih di atas.
    let a1View = 'unduh';
    const a1 = createPage({
        id: 'a1', folder: true, cta: 'Start',
        init() {
            const y = P.today().getFullYear(), years = Array.from({ length: y - 2025 + 1 }, (_, i) => 2025 + i);
            return { view: a1View, year: y, years, fresh: false, nik: { file: null, submit: false, year: y, years }, bpa1: { file: null, year: y, years, result: null, error: '', outDir: '' } };
        },
        main(st, api) {
            const tabs = '<div style="margin-bottom:4px">' + P.seg('a1view', [{ value: 'unduh', label: 'Full-year download' }, { value: 'nik', label: 'BPMP NIK Pembetulan' }, { value: 'bpa1', label: 'December BPA1 XML' }], st.view) + '</div>';
            if (st.view === 'nik') return tabs + nikForm.main(st.nik, api);
            if (st.view === 'bpa1') return tabs + bpa1Form.main(st.bpa1, api);
            const out = (icon, t, s) => '<div class="doc-row" style="align-items:flex-start"><span class="ico">' + P.icon(icon, 18) + '</span><div class="t"><b>' + t + '</b><span>' + s + '</span></div></div>';
            return tabs + P.card(1, 'Tahun Pajak', '<span>From 2025 · all periods Jan–Dec at once</span>', '<div class="chips c6 tall">' + st.years.map((y) => '<button type="button" class="chip" data-act="year" data-val="' + y + '" aria-pressed="' + (st.year === y) + '">' + y + '</button>').join('') + '</div>')
                + P.card(2, 'Output', '<span>Settings locked for the most complete output</span>', '<div class="stack">'
                    + out('file', 'Full PDF', 'Induk, BPE, and Lampiran with all rows, for every SPT version.') + out('lock', 'Confidential PDF', 'Lampiran without recipient details, for every SPT version.')
                    + out('sheet', 'Annual Excel', 'Latest version of each period: sheets Ringkasan, NIK, Pembetulan, Draft SPT Desember, then one sheet per Lampiran (Masa column, totals on top that follow the filter).')
                    + out('warn', 'Ringkasan sheet', 'Periods without an SPT or that could not be read are listed here, with the number of Bukti Potong that still have problems. Failed data is not replaced with an older version.') + '</div>')
                + P.card(3, 'Previous Results', '<span>' + (st.source ? 'Source: ' + esc(st.source) : '"Save to" folder') + '</span>', '<div class="chips c2 wide">'
                    + '<button type="button" class="chip" data-act="a1fresh" data-val="0" aria-pressed="' + !st.fresh + '">Continue<span class="hint">Complete periods are reused. Only new periods and new Pembetulan are downloaded.</span></button>'
                    + '<button type="button" class="chip" data-act="a1fresh" data-val="1" aria-pressed="' + st.fresh + '">Start over<span class="hint">All periods are re-downloaded from Coretax.</span></button></div>'
                    + (st.fresh ? '' : a1SourceHtml(st)));
        },
        act(act, d, st, api) {
            if (act === 'a1view') { st.view = a1View = d.val; return true; }
            if (st.view === 'nik') return nikForm.act(act, d, st.nik, api);
            if (st.view === 'bpa1') return bpa1Form.act(act, d, st.bpa1, api);
            if (act === 'a1src-excel') { P.pickFile('Select the previous recap Excel').then((f) => { if (f && f.filePath) { st.source = f.filePath; a1Inspect(st, api); } else if (f) P.toast('Could not read the file path - select it through the Windows dialog.'); }); return false; }
            if (act === 'a1src-clear') { st.source = null; a1Inspect(st, api); return false; }
            if (act === 'a1src-check') { a1Inspect(st, api); return false; }
            if (act === 'year') { st.year = Number(d.val); st.inspect = null; } else if (act === 'a1fresh') st.fresh = d.val === '1'; else return false;
        },
        rail(st, api) {
            if (st.view === 'nik') return nikForm.rail(st.nik, api);
            if (st.view === 'bpa1') return bpa1Form.rail(st.bpa1, api);
            const ent = api.entity();
            return actionBar({ count: 12, unit: 'Masa Pajak', parts: ['PPh 21/26 ' + st.year, st.fresh ? 'Start over' : 'Continue', esc(whoText(ent))], dest: true, sub: loginSub(ent),
                ready: readiness(ent), blocked: restricted() ? 'Not available for Restricted users' : '', cta: 'Start download', icon: 'download' });
        },
        async start(st, api) {
            if (st.view === 'nik') return nikForm.start(st.nik, api);
            if (st.view === 'bpa1') return bpa1Form.start(st.bpa1, api);
            if (restricted()) throw new Error('Annual PPh 21 Recap is not available for Restricted users.');
            await P.post('/api/actions/download-spt', { entity: api.entity(), a1Year: String(st.year), a1Fresh: st.fresh, a1Source: !st.fresh && st.source ? st.source : undefined, saveRoot: P.saveRoot() || undefined });
        }
    });

    // =========================================================
    // XML BPA1 Desember (bagian dari halaman Mode A1): XML impor BPA1 dari sheet Draft SPT Desember rekap (lib/a1-desember.js).
    // Tidak membuka Coretax - XML diimpor sendiri di e-Bupot BPA1 (masuk Belum Terbit).
    // =========================================================
    const bpa1Form = {
        main(st) {
            const r = st.result;
            return P.card(1, 'Recap Excel', '<span>Filled-in Draft SPT Desember sheet</span>', '<div class="hint" style="font-size:13.5px">Fill in the green columns of the <b>Draft SPT Desember</b> sheet (PTKP status, income from KK), save, then select the recap here. Employees without income are skipped.</div>'
                    + '<div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-sm btn-primary" data-act="bpa1-latest">' + P.icon('sheet', 15) + 'Use latest recap (' + st.year + ')</button></div>'
                    + '<div class="dropzone' + (st.file ? ' filled' : '') + '">' + P.icon(st.file ? 'check' : 'upload', 26) + (st.file ? '<span class="file-name">' + esc(st.file.fileName) + '</span>' + (st.file.filePath ? '<span class="hint">' + esc(st.file.filePath) + '</span>' : '') : '<span>…or select another recap Excel</span>') + '<button type="button" class="link" data-act="bpa1-pick">' + (st.file ? 'change file…' : 'select file…') + '</button></div>')
                + P.card(2, 'Save XML to', '<span>' + (st.outDir ? esc(st.outDir) : 'Same folder as the recap Excel') + '</span>', '<div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-sm" data-act="bpa1-outdir">' + P.icon('folder', 15) + 'Select folder…</button>' + (st.outDir ? '<button type="button" class="btn btn-sm" data-act="bpa1-outdir-clear">Same as recap</button>' : '') + '</div>')
                + P.card(3, 'Tahun Pajak', '', '<div class="chips c6 tall">' + st.years.map((y) => '<button type="button" class="chip" data-act="bpa1-year" data-val="' + y + '" aria-pressed="' + (st.year === y) + '">' + y + '</button>').join('') + '</div>')
                + (st.error ? P.card(4, 'Cannot Create Yet', '', '<div class="hint warn" style="white-space:pre-line">' + esc(st.error) + '</div>') : '')
                + (r ? P.card(4, 'XML Ready to Import', '', '<div class="stack"><div class="doc-row"><span class="ico">' + P.icon('check', 18) + '</span><div class="t"><b>' + r.count + ' BPA1</b><span>' + esc(r.file) + '</span></div></div>'
                    + '<div class="hint">Annual PPh 21 (draft calculation): Rp ' + esc(r.totalTax) + ' · December PPh: Rp ' + esc(r.totalDes) + (r.skipped ? ' · ' + r.skipped + ' row(s) without income skipped' : '') + '. Import in Coretax: e-Bupot › BPA1 › Impor Data; the result goes to Belum Terbit.</div></div>') : '');
        },
        async act(act, d, st, api) {
            if (act === 'bpa1-year') { st.year = Number(d.val); return true; }
            if (act === 'bpa1-outdir') { try { const r = await P.post('/api/actions/pick-folder', { title: 'Select a folder to save the BPA1 XML' }); if (r && r.folderPath) { st.outDir = r.folderPath; api.redraw(); } } catch (e) { P.toast(e.message); } return false; }
            if (act === 'bpa1-outdir-clear') { st.outDir = ''; return true; }
            if (act === 'bpa1-pick') { const f = await P.pickFile('Select the Annual PPh 21 recap Excel (A1)'); if (f) { st.file = f; st.result = null; st.error = ''; const m = /(20\d{2})/.exec(f.fileName); if (m && st.years.includes(Number(m[1]))) st.year = Number(m[1]); api.redraw(); } return false; }
            if (act === 'bpa1-latest') {
                const ent = api.entity(); if (!ent) { st.error = 'Select an entity first.'; api.redraw(); return false; }
                try { const r = await P.post('/api/a1/inspect', { entity: ent, year: String(st.year), saveRoot: P.saveRoot() || undefined }); if (r && r.excel) { st.file = { fileName: r.excel.split(/[\\/]/).pop(), filePath: r.excel }; st.error = ''; } else st.error = 'No ' + st.year + ' recap Excel for this entity yet - run Full-year download first, or select the file.'; }
                catch (e) { st.error = e.message; }
                st.result = null; api.redraw(); return false;
            }
            return false;
        },
        rail(st, api) {
            const ent = api.entity();
            return actionBar({ parts: ['<b>BPA1 XML ' + st.year + '</b>', st.file ? esc(st.file.fileName) : '<span class="muted">No recap Excel yet</span>', esc(ent && ent.project !== 'manual' ? ent.entity_name : '')],
                sub: 'Creates an XML file on this PC; nothing is sent to Coretax.',
                ready: { ok: true }, blocked: !st.file ? 'Select a recap Excel first' : !st.file.filePath ? 'Select via the Windows dialog (path required)' : '', cta: 'Create BPA1 XML', icon: 'file' });
        },
        async start(st, api) {
            st.error = ''; st.result = null;
            try { st.result = await P.post('/api/a1/bpa1-xml', { filePath: st.file.filePath, year: String(st.year), outDir: st.outDir || undefined }); }
            catch (e) { st.error = e.message; }
            api.redraw();
        }
    };

    // =========================================================
    // Pembetulan NIK BPMP (bagian dari halaman Mode A1) - NIK Baru / Nama Baru dari Excel Mode A1 dibetulkan
    // langsung di e-Bupot (automation/bpmp-amend.js): cek dulu tanpa simpan, lalu kirim + pemeriksaan ulang.
    // =========================================================
    const nikForm = {
        init(year, years) { return { file: null, submit: false, allowSimilar: false, year, years, latestError: '' }; },
        main(st) {
            const step = (n, t, s) => '<div class="doc-row" style="align-items:flex-start"><span class="ico">' + n + '</span><div class="t"><b>' + t + '</b><span>' + s + '</span></div></div>';
            // Tidak ada template terpisah: sumbernya Excel hasil tab "Unduh setahun" (<kode> <tahun> - Rekap SPT PPh 21 Setahun (A1).xlsx).
            return P.card(1, 'Recap Excel', '<span>Output of the "Full-year download" tab</span>', '<div class="hint" style="font-size:13.5px">No template needed: use the Excel from the <b>Full-year download</b> tab (<b>… ' + st.year + ' - Rekap SPT PPh 21 Setahun (A1).xlsx</b>). In the <b>NIK</b> sheet, wrong NIKs are highlighted yellow (filter the <b>Kategori</b> column) and the green <b>NIK Baru</b> / <b>Nama Baru</b> columns are pre-filled with suggestions where available - check them against the KTP, fill in the blanks, save, then select the file here. Rows with empty green columns are left untouched.</div>'
                    + '<div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-sm btn-primary" data-act="nik-latest">' + P.icon('sheet', 15) + 'Use latest recap (' + st.year + ')</button><button type="button" class="btn btn-sm" data-act="nik-refresh"' + (st.file && st.file.filePath && !st.refreshing ? '' : ' disabled') + ' title="Rebuild this recap from the file itself (no Coretax): sheet NIK and Draft SPT Desember follow the latest Pembetulan inputs, e.g. a NIK salah gets its own row. Close the file in Excel first.">' + P.icon('retry', 15) + (st.refreshing ? 'Updating… (about 1 min)' : 'Update recap') + '</button></div>'
                    + (st.latestError ? '<div class="hint warn">' + esc(st.latestError) + '</div>' : '')
                    + '<div class="dropzone' + (st.file ? ' filled' : '') + '">' + P.icon(st.file ? 'check' : 'upload', 26) + (st.file ? '<span class="file-name">' + esc(st.file.fileName) + '</span>' + (st.file.filePath ? '<span class="hint">' + esc(st.file.filePath) + '</span>' : '') : '<span>…or select another recap Excel</span>') + '<button type="button" class="link" data-act="pick-file">' + (st.file ? 'change file…' : 'select file…') + '</button></div>')
                + P.card(2, 'Tahun Pajak', '<span>Looks up this year\'s Telah Terbit BPMP Bukti Potong</span>', '<div class="chips c6 tall">' + st.years.map((y) => '<button type="button" class="chip" data-act="year" data-val="' + y + '" aria-pressed="' + (st.year === y) + '">' + y + '</button>').join('') + '</div>')
                + P.card(3, 'What Happens in Coretax', '', '<div class="stack">'
                    + step('1', 'NIK Baru is checked first, per Bukti Potong', 'Coretax validates the NIK Baru and returns its official name. Only those whose official name matches Nama Baru are submitted; unregistered NIKs or different names are skipped and logged.')
                    + step('2', 'Bukti Potong is corrected, not cancelled', 'The Bukti Potong number stays the same; its status becomes Pembetulan and the old version moves to Tidak Valid. The withholding date becomes the correction date (standard Coretax behavior). Data is backed up first and re-checked column by column afterwards.')
                    + step('3', 'Full-year re-sweep', 'After submitting, all Telah Terbit BPMP for January-December are checked directly in Coretax. The log reports either that no problem NIKs remain, or the list of NIKs still left (including those not in the Excel).')
                    + step('4', 'SPT Masa needs Pembetulan too', 'Periods whose Bukti Potong were corrected need an SPT Masa PPh 21 Pembetulan; the list appears in the log. Then run the Full-year download tab with "Continue" - only changed periods are downloaded.') + '</div>'
                    + '<div style="margin-top:12px">' + P.checkRow('nik-similar', st.allowSimilar, 'Also submit similar names (different spelling, e.g. BUDI SANTOSO / SANTOSA) - the official Coretax name is used. Check the KTP first.') + '</div>'
                    + '<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn btn-sm" data-act="nik-sweep">' + P.icon('shield', 15) + 'Check problem NIKs for ' + st.year + ' (no changes)</button></div>');
        },
        async act(act, d, st, api) {
            if (act === 'pick-file') { const f = await P.pickFile('Select the Annual PPh 21 recap Excel (latest format)'); if (f) { st.file = f; st.latestError = ''; const m = /(20\d{2})/.exec(f.fileName); if (m && st.years.includes(Number(m[1]))) st.year = Number(m[1]); api.redraw(); } return false; }
            if (act === 'nik-latest') {
                const ent = api.entity();
                if (!ent) { st.latestError = 'Select an entity first.'; api.redraw(); return false; }
                try {
                    const r = await P.post('/api/a1/inspect', { entity: ent, year: String(st.year), saveRoot: P.saveRoot() || undefined });
                    if (r && r.excel) { st.file = { fileName: r.excel.split(/[\\/]/).pop(), filePath: r.excel }; st.latestError = ''; }
                    else st.latestError = 'No ' + st.year + ' recap Excel for this entity in the "Save to" folder yet - run the Full-year download tab first, or select the file.';
                } catch (e) { st.latestError = e.message; }
                api.redraw(); return false;
            }
            if (act === 'nik-refresh') {
                if (!st.file || !st.file.filePath) { P.toast('Use the latest recap or pick the file from its folder first.'); return false; }
                if (st.refreshing) return false;
                try {
                    const r = await P.post('/api/actions/a1-refresh', { filePath: st.file.filePath, entity: api.entity() }); P.run.poll();
                    // Tombol "Memperbarui…" sampai prosesnya selesai (sekitar 1 menit) - klik berulang tidak memulai proses kedua.
                    st.refreshing = true; api.redraw();
                    const key = r && r.session;
                    const wait = setInterval(async () => {
                        try { const s = await P.api('/api/run/status' + (key ? '?session=' + encodeURIComponent(key) : '')); if (s && s.active) return; } catch (e) { /* coba lagi */ }
                        clearInterval(wait); st.refreshing = false; api.redraw();
                    }, 2000);
                } catch (e) { P.toast(e.message); }
                return false;
            }
            if (act === 'year') { st.year = Number(d.val); return true; }
            if (act === 'nik-similar') { st.allowSimilar = !st.allowSimilar; return true; }
            if (act === 'nik-sweep') {
                if (restricted()) { P.toast('Not available for Restricted users.'); return false; }
                const ent = api.entity();
                if (!ent) { P.toast('Select an entity first.'); return false; }
                try { await P.post('/api/actions/bpmp-amend', { entity: ent, year: String(st.year), sweepOnly: true, saveRoot: P.saveRoot() || undefined }); }
                catch (e) { P.toast(e.message); }
                return false;
            }
            return false;
        },
        rail(st, api) {
            const ent = api.entity();
            const blocked = restricted() ? 'Not available for Restricted users' : !st.file ? 'Select a recap Excel first' : '';
            return actionBar({ parts: ['<b>BPMP NIK Pembetulan ' + st.year + '</b>', st.file ? esc(st.file.fileName) : '<span class="muted">No recap Excel yet</span>', esc(whoText(ent))],
                sub: loginSub(ent) + ' · only where the official name matches Nama Baru', ready: readiness(ent), blocked, cta: 'Correct in Coretax', icon: 'upload' });
        },
        async start(st, api) {
            if (restricted()) throw new Error('BPMP NIK Pembetulan is not available for Restricted users.');
            let pv = null;
            try { pv = await P.post('/api/bpmp-amend/preview', { fileBase64: st.file.fileBase64 || undefined, filePath: st.file.filePath || undefined }); } catch (e) { throw new Error(e.message); }
            const name = api.entity().entity_name || 'this entity', fixes = pv.byNik + pv.perSlip;
            if (fixes && !await P.confirmDialog({ title: 'Correct NIKs in Coretax', body: 'Each NIK Baru is checked first; only Bukti Potong whose official name matches Nama Baru' + (st.allowSimilar ? ' or is similar (using the official Coretax name)' : '') + ' are corrected. Results are written to the Pembetulan and Ringkasan sheets in this Excel.',
                details: [['Entity', name], ['From sheet NIK', String(pv.byNik) + ' NIK'], ['From sheet Pembetulan', String(pv.perSlip) + ' Bukti Potong']], requireTick: true, tickLabel: 'I have checked the list above', confirmLabel: 'Submit Pembetulan' })) return;
            // Tindakan = Batalkan: daftar bukti potong ditampilkan dan harus dikonfirmasi terpisah (pembatalan tidak bisa dikembalikan).
            let confirmCancel = [];
            if (pv.cancels.length) {
                if (await P.confirmDialog({ title: 'Batalkan Bukti Potong', body: 'These Bukti Potong are cancelled in Coretax (Tindakan = Batalkan). Cancelling cannot be undone. If a slip was already reported, its SPT Masa needs a Pembetulan.',
                    details: [['Entity', name], ['Bukti Potong', String(pv.cancels.length)]], list: pv.cancels.slice(0, 25).map((c) => c.number + ' · ' + c.masa + ' · ' + c.nik + ' ' + c.name + (c.gross !== null && c.gross !== undefined && c.gross !== '' ? ' · bruto ' + Number(c.gross).toLocaleString('id-ID') : '')).concat(pv.cancels.length > 25 ? ['… and ' + (pv.cancels.length - 25) + ' more'] : []),
                    requireTick: true, tickLabel: 'I have checked the list above', danger: true, confirmLabel: 'Batalkan' })) confirmCancel = pv.cancels.map((c) => c.number);
                else if (!fixes) return;
            }
            if (!fixes && !confirmCancel.length) return;
            // filePath ikut dikirim bila ada, supaya laporan ditulis kembali ke Excel yang sama.
            await P.post('/api/actions/bpmp-amend', { entity: api.entity(), fileBase64: st.file.fileBase64 || undefined, filePath: st.file.filePath || undefined, fileName: st.file.fileName, year: String(st.year), submit: true, allowSimilar: !!st.allowSimilar, confirmCancel, saveRoot: P.saveRoot() || undefined });
        }
    };

    // =========================================================
    // Impor Dividen (AS.39-01) - entitas berkredensial login otomatis seperti fitur lain; tanpa
    // entitas (atau sesi manual) lewat jendela Coretax yang Anda login sendiri.
    // =========================================================
    const dividen = createPage({
        id: 'dividen', cta: 'Import to Coretax', ctaIcon: 'upload',
        init() { return { file: null, busy: '' }; },
        main(st, api) {
            return P.card(1, 'Create New Case', '', '<div class="hint" style="font-size:13.5px">Logs in to Coretax as this entity and opens a new e-Reporting case (AS.39-01). Skip this if the case is already open in this entity\'s Coretax window.</div><button type="button" class="btn btn-sm btn-primary" data-act="create-case" style="margin-top:8px">' + P.icon('plus', 15) + 'Create new case</button>')
                + P.card(2, 'Excel Template File', '', '<div class="dropzone' + (st.file ? ' filled' : '') + '">' + P.icon(st.file ? 'check' : 'upload', 26) + (st.file ? '<span class="file-name">' + esc(st.file.fileName) + '</span>' : '<span>Select the filled-in .xlsx template file</span>') + '<button type="button" class="link" data-act="pick-file">' + (st.file ? 'change file…' : 'select file…') + '</button></div>');
        },
        async act(act, d, st, api) {
            if (act === 'pick-file') { const f = await P.pickFile('Select the Dividen template file (.xlsx)'); if (f) { st.file = f; api.redraw(); } return false; }
            const entity = api.entity();
            if (act === 'create-case') {
                if (!await P.confirmDialog({ title: 'Create New Case', body: 'This opens a new e-Reporting case (AS.39-01) in Coretax.', details: [['Entity', entity && entity.entity_name]], confirmLabel: 'Create case' })) return false;
                try { await P.post('/api/actions/create-dividen-case', { entity }); P.run.poll(); } catch (e) { P.toast('Failed to create case: ' + e.message); } return false;
            }
            if (act === 'import' || act === 'check') {
                if (!st.file) { P.toast('Select a .xlsx template file first.'); return false; }
                if (act === 'import' && !await P.confirmDialog({ title: 'Import Dividen', body: 'This imports the file into the open e-Reporting case in Coretax.', details: [['Entity', entity && entity.entity_name], ['File', st.file.fileName]], requireTick: true, tickLabel: 'I have checked the file above', confirmLabel: 'Import to Coretax' })) return false;
                try { await P.post(act === 'import' ? '/api/actions/import-dividen' : '/api/actions/check-dividen', { entity, fileBase64: st.file.fileBase64 || undefined, filePath: st.file.fileBase64 ? undefined : st.file.filePath, fileName: st.file.fileName }); P.run.poll(); }
                catch (e) { P.toast('Failed to start: ' + e.message); }
                return false;
            }
            return false;
        },
        rail(st, api) {
            const ent = api.entity(), ready = readiness(ent);
            const why = !ready.ok ? ready.reason : (!st.file ? 'Select a template file first' : '');
            return actionBar({ parts: ['<b>Dividen import</b>', st.file ? esc(st.file.fileName) : '<span class="muted">No file yet</span>', esc(whoText(ent))],
                sub: loginSub(ent) + ' · goes into a draft; you sign it yourself', ready: { ok: !why, reason: why }, act: 'import', cta: 'Import to Coretax', icon: 'upload',
                extra: '<button type="button" class="btn" data-act="check"' + (why ? ' disabled' : '') + ' title="Read the table currently shown in Coretax and compare it with this file">' + P.icon('search', 16) + 'Check results</button>' });
        },
        start() {}
    });
    // Tombol di rail dividen memakai data-act biasa (bukan "start"): dialihkan ke act().

    // =========================================================
    // Kreditkan Faktur Masukan (per baris Excel)
    // =========================================================
    const kredit = createPage({
        id: 'kredit', cta: 'Import to Coretax', ctaIcon: 'upload',
        init(api) { return { file: null, mode: 'excel', pp: P.period.create({ mode: 'masa1', onChange: () => api.updateRail() }) }; },
        afterDraw(st) { if (st.mode === 'fixed') st.pp.bind(); },
        main(st) {
            return P.card(1, 'Excel Template', '', '<div class="doc-row"><span class="ico">' + P.icon('sheet', 18) + '</span><div class="t"><b>Faktur Masukan crediting template</b><span>Fill in columns A–J: each row is looked up by No Faktur. The PENGKREDITAN PPN column now also has a "TIDAK DIKREDITKAN" option.</span></div><a class="btn btn-sm" href="/assets/template-pajak-masukan.xlsx" download>' + P.icon('download', 15) + 'Download</a></div>')
                + P.card(2, 'Filled-in Excel File', '', '<div class="dropzone' + (st.file ? ' filled' : '') + '">' + P.icon(st.file ? 'check' : 'upload', 26) + (st.file ? '<span class="file-name">' + esc(st.file.fileName) + '</span>' : '<span>Select the filled-in .xlsx file</span>') + '<button type="button" class="link" data-act="pick-file">' + (st.file ? 'change file…' : 'select file…') + '</button></div>')
                + P.card(3, 'Masa Pengkreditan', '', '<div class="stack-lg">' + P.seg('kmode', [{ value: 'excel', label: 'Follow the Excel column' }, { value: 'fixed', label: 'Set one Masa Pengkreditan' }], st.mode)
                    + (st.mode === 'fixed' ? st.pp.html() : '') + '<div class="hint">Rows with PENGKREDITAN PPN "TIDAK DIKREDITKAN" are still set to Tidak Dikreditkan even if a Masa Pengkreditan is set here. Faktur already reported in an SPT, cancelled, amended, or past the 3-month limit are not changed. They are skipped automatically, with the reason noted in the KETERANGAN column.</div></div>');
        },
        async act(act, d, st, api) {
            if (act === 'kmode') { st.mode = d.val; return true; }
            if (act === 'pick-file') { const f = await P.pickFile('Select the Faktur Masukan Excel file (.xlsx)'); if (f) { st.file = f; api.redraw(); } return false; }
            return false;
        },
        rail(st, api) {
            const ent = api.entity(); let blocked = ''; if (!st.file) blocked = 'Select an Excel file first'; else if (st.mode === 'fixed' && !st.pp.count()) blocked = 'Select a Masa Pengkreditan';
            return actionBar({ parts: ['<b>Credit Faktur Masukan</b>', st.file ? esc(st.file.fileName) : '<span class="muted">No file yet</span>', 'Masa Pengkreditan ' + (st.mode === 'fixed' && st.pp.count() ? esc(L.masaLabel(st.pp.single())) : 'from the Excel'), esc(whoText(ent))],
                sub: loginSub(ent) + ' · results are written back to the Excel', ready: readiness(ent), blocked, cta: 'Import to Coretax', icon: 'upload' });
        },
        async start(st, api) {
            if (!await P.confirmDialog({ title: 'Credit Faktur Masukan', body: 'This credits the Faktur Masukan listed in the file in Coretax. Credited invoices cannot be undone from this tool.', details: [['Entity', api.entity().entity_name], ['File', st.file.fileName], ['Masa Pajak', st.mode === 'fixed' && st.pp.single() ? L.masaLabel(st.pp.single()) : 'From each row']], requireTick: true, tickLabel: 'I have checked the file above', confirmLabel: 'Credit Faktur Masukan' })) return;
            await P.post('/api/actions/import-pajak-masukan', { entity: api.entity(), fileBase64: st.file.fileBase64 || undefined, filePath: st.file.fileBase64 ? undefined : st.file.filePath, targetMasaInput: st.mode === 'fixed' && st.pp.single() ? st.pp.single() : undefined });
        }
    });

    // =========================================================
    // Kode Billing PPh 25
    // =========================================================
    const billing = createPage({
        id: 'billing', folder: true, cta: 'Create Kode Billing', ctaIcon: 'bank',
        init(api) { return { nominal: '', pp: P.period.create({ mode: 'masa1', onChange: () => api.updateRail() }) }; },
        afterDraw(st) { st.pp.bind(); },
        main(st) {
            return P.card(1, 'Masa Pajak', '<span>PPh 25 · self-payment</span>', st.pp.html())
                + P.card(2, 'Payment Amount', '', '<div class="field"><div class="input-group money"><span class="money-rp">Rp</span><input class="input mono money-in" id="bl-nominal" data-bind="nominal" data-money inputmode="numeric" placeholder="0" value="' + esc(st.nominal) + '" aria-label="PPh 25 amount"></div><span class="hint">Enter the PPh 25 installment that must be paid.</span></div>')
                + P.callout('shield', 'Checked automatically before creating the code', 'The agent makes sure the Masa Pajak is not yet paid and has no active Kode Billing. If one exists, the existing code is downloaded instead of creating a duplicate.');
        },
        rail(st, api) {
            const ent = api.entity(); const masa = st.pp.single(); const digits = String(st.nominal).replace(/\D/g, '');
            let blocked = ''; if (!masa) blocked = 'Select a Masa Pajak'; else if (!digits || Number(digits) <= 0) blocked = 'Enter the payment amount';
            return actionBar({ parts: ['<b>Kode Billing PPh 25</b>', masa ? esc('Masa Pajak ' + L.masaLabel(masa)) : '', digits ? '<b class="mono">Rp ' + L.rupiah(digits) + '</b>' : '', esc(whoText(ent)) + ' (' + (ent.individual ? 'Individual' : 'Corporate') + ')'],
                dest: true, sub: loginSub(ent) + ' · you still make the payment yourself', ready: readiness(ent), blocked, cta: 'Create Kode Billing', icon: 'bank' });
        },
        async start(st, api) {
            const digits = String(st.nominal).replace(/\D/g, '');
            if (!await P.confirmDialog({ title: 'Create Kode Billing', body: 'This creates a PPh 25 Kode Billing in Coretax. You still make the payment yourself.', details: [['Entity', api.entity().entity_name], ['Masa Pajak', st.pp.single() ? L.masaLabel(st.pp.single()) : ''], ['Amount', 'Rp ' + L.rupiah(digits)]], confirmLabel: 'Create Kode Billing' })) return;
            await P.post('/api/actions/billing-pph25', { entity: api.entity(), masaInput: st.pp.single(), nominal: String(st.nominal).replace(/\D/g, ''), saveRoot: P.saveRoot() || undefined });
        }
    });

    // =========================================================
    // Upload Impor Coretax (BPMP, BP21, BPA1, BPPU ke Belum Terbit) + Buat Konsep SPT - lib/coretax-import.js
    // =========================================================
    let imporView = 'upload';
    const impor = createPage({
        id: 'impor', cta: 'Start', ctaIcon: 'upload',
        init(api) {
            return { view: imporView, file: null, info: null, infoError: '', konsepType: 'ICT_WIT', konsepAction: 'create', pp: P.period.create({ mode: 'masa1', onChange: () => api.updateRail() }),
                issueType: 'mp', ipp: P.period.create({ mode: 'masa1', onChange: () => api.updateRail() }), preview: null, previewError: '', previewing: false };
        },
        afterDraw(st) { if (st.view === 'konsep') st.pp.bind(); if (st.view === 'issue') st.ipp.bind(); },
        main(st) {
            const tabs = '<div style="margin-bottom:4px">' + P.seg('iview', [{ value: 'upload', label: 'Upload e-Bupot' }, { value: 'issue', label: 'Issue & sign' }, { value: 'konsep', label: 'Konsep SPT' }], st.view) + '</div>';
            if (st.view === 'konsep') return tabs
                + P.card(1, 'SPT Type', '', '<div class="chips c2">' + [['ICT_WIT', 'PPh 21/26'], ['ICT_WT', 'PPh Unifikasi']].map(([v, l]) => '<button type="button" class="chip" data-act="ktype" data-val="' + v + '" aria-pressed="' + (st.konsepType === v) + '">' + l + '</button>').join('') + '</div>')
                + P.card(2, 'Masa Pajak', '<span>Normal or Pembetulan is chosen automatically to match Coretax</span>', st.pp.html())
                + P.card(3, 'Action', '', '<div class="chips c3">' + [['create', 'Create Konsep SPT', 'Open a new Konsep SPT for the Masa Pajak'], ['post', 'Posting SPT & download', 'Fill the Konsep SPT from Telah Terbit slips, then download it'], ['download', 'Download only', 'Download the Konsep SPT as it is now']]
                    .map(([v, l, h]) => '<button type="button" class="chip" data-act="kaction" data-val="' + v + '" aria-pressed="' + (st.konsepAction === v) + '">' + l + '<span class="hint">' + h + '</span></button>').join('') + '</div>'
                    + '<div class="hint" style="margin-top:8px">Download = Lampiran from the SPT download tool (PDF + Excel) plus an Induk recreated from the Konsep SPT data, in one PDF marked KONSEP.</div>');
            if (st.view === 'issue') {
                const pv = st.preview, rp = (n) => Number(n || 0).toLocaleString('id-ID');
                const result = st.previewing ? '<div class="hint" style="margin-top:8px">Reading Belum Terbit from Coretax…</div>'
                    : st.previewError ? '<div class="hint warn" style="margin-top:8px">' + esc(st.previewError) + '</div>'
                    : pv ? '<div class="hint" style="margin-top:8px"><b>' + pv.count + ' ' + esc(pv.label) + '</b> in Belum Terbit · Masa Pajak ' + esc(pv.period) + ' · bruto ' + rp(pv.totalGross) + ' · PPh ' + rp(pv.totalTax) + ' · ' + (pv.needsSign ? 'signed with the PIC passphrase' : 'no signature needed') + (pv.skipped.length ? ' · ' + pv.skipped.length + ' skipped' : '') + '</div>'
                        + (pv.count ? '<table class="mini-table" style="width:100%;margin-top:6px;font-size:12.5px;border-collapse:collapse"><thead><tr><th style="text-align:left">NIK / NPWP</th><th style="text-align:left">Name</th><th style="text-align:right">Bruto</th><th style="text-align:right">PPh</th></tr></thead><tbody>'
                            + pv.slips.slice(0, 25).map((x) => '<tr><td class="mono">' + esc(x.nik) + '</td><td>' + esc(x.name || '') + '</td><td style="text-align:right">' + rp(x.gross) + '</td><td style="text-align:right">' + rp(x.tax) + '</td></tr>').join('')
                            + '</tbody></table>' + (pv.slips.length > 25 ? '<div class="hint">… and ' + (pv.slips.length - 25) + ' more</div>' : '') : '') : '';
                return tabs
                    + P.card(1, 'Bukti Potong Type', '', '<div class="chips c4">' + [['mp', 'BPMP'], ['bp21', 'BP21'], ['bpa1', 'BPA1'], ['bpu', 'BPPU']].map(([v, l]) => '<button type="button" class="chip" data-act="itype" data-val="' + v + '" aria-pressed="' + (st.issueType === v) + '">' + l + '</button>').join('') + '</div>')
                    + P.card(2, 'Masa Pajak', '<span>BPA1: the last Masa Pajak of the slip</span>', st.ipp.html())
                    + P.card(3, 'Preview', '', '<div class="row" style="gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-sm btn-primary" data-act="ipreview"' + (st.previewing ? ' disabled' : '') + '>' + P.icon('search', 15) + 'Preview Belum Terbit</button></div>' + result)
                    + P.callout('shield', 'Issues exactly what the preview shows', 'BPMP is issued without a signature; BP21 / BPA1 / BPPU are signed with the PIC passphrase stored in Taxio Pilot (checked with Coretax first). If Belum Terbit changes after the preview, nothing is issued. Filing the SPT stays manual.');
            }
            const i = st.info;
            const summary = st.infoError ? '<div class="hint warn" style="margin-top:8px">' + esc(st.infoError) + '</div>'
                : i ? '<div class="hint" style="margin-top:8px"><b>' + esc(i.label) + '</b> · ' + i.count + ' Bukti Potong · Masa Pajak ' + esc((i.periods || []).join(', ') || '-') + ' · withholder NPWP ' + esc(i.tin || '-') + (i.source === 'excel' ? ' · sheet ' + esc(i.sheet || '') : ' · XML file') + '</div>'
                    + ((i.problems || []).length ? '<div class="hint warn">' + i.problems.slice(0, 5).map(esc).join('<br>') + '</div>' : '') : '';
            return tabs
                + P.card(1, 'Import File', '', '<div class="dropzone' + (st.file ? ' filled' : '') + '">' + P.icon(st.file ? 'check' : 'upload', 26) + (st.file ? '<span class="file-name">' + esc(st.file.fileName) + '</span>' : '<span>DJP import template Excel (.xlsx) or XML</span>') + '<button type="button" class="link" data-act="pick-file">' + (st.file ? 'change file…' : 'select file…') + '</button></div>' + summary)
                + P.callout('shield', 'Belum Terbit only', 'The type is detected automatically (BPMP, BP21, BPA1, BPPU). Coretax validates the file, then creates the Bukti Potong in Belum Terbit; if any row is wrong, nothing is created and the errors appear in the log. You still issue / sign them yourself.');
        },
        async act(act, d, st, api) {
            if (act === 'iview') { st.view = imporView = d.val; return true; }
            if (act === 'ktype') { st.konsepType = d.val; return true; }
            if (act === 'kaction') { st.konsepAction = d.val; return true; }
            if (act === 'itype') { st.issueType = d.val; st.preview = null; st.previewError = ''; return true; }
            if (act === 'ipreview') {
                const masa = st.ipp.single(); if (!masa) { P.toast('Select a Masa Pajak first.'); return false; }
                st.previewing = true; st.preview = null; st.previewError = ''; api.redraw();
                try { st.preview = { ...(await P.post('/api/ebupot/issue-preview', { entity: api.entity(), type: st.issueType, period: masa })), forType: st.issueType, forPeriod: masa }; }
                catch (e) { st.previewError = e.message; }
                st.previewing = false; api.redraw(); return false;
            }
            if (act === 'pick-file') {
                // Dialog dibuka di folder file impor terakhir (lokal), pertama kali di Downloads.
                let dir = 'downloads'; try { dir = localStorage.getItem('taxio.imporDir') || 'downloads'; } catch (e) {}
                const f = await P.pickFile('Select the e-Bupot import file (.xlsx / .xml)', 'Import files (*.xlsx;*.xml)|*.xlsx;*.xml|All Files (*.*)|*.*', dir); if (!f) return false;
                if (f.filePath) try { localStorage.setItem('taxio.imporDir', f.filePath.replace(/[\\/][^\\/]*$/, '')); } catch (e) {}
                st.file = f; st.info = null; st.infoError = ''; api.redraw();
                try { st.info = await P.post('/api/import/inspect', { entity: api.entity(), fileBase64: f.fileBase64, filePath: f.filePath, fileName: f.fileName }); }
                catch (e) { st.infoError = e.message; }
                api.redraw(); return false;
            }
            return false;
        },
        rail(st, api) {
            const ent = api.entity(), name = ent.project === 'manual' ? 'Manual session' : ent.entity_name;
            if (st.view === 'issue') {
                const pv = st.preview, masa = st.ipp.single(), fresh = !!(pv && pv.forType === st.issueType && pv.forPeriod === masa);
                const blocked = !masa ? 'Select a Masa Pajak' : !fresh ? 'Run the preview first' : !pv.count ? 'Nothing to issue in Belum Terbit' : '';
                const tname = { mp: 'BPMP', bp21: 'BP21', bpa1: 'BPA1', bpu: 'BPPU' }[st.issueType];
                return actionBar({ parts: ['<b>' + (fresh ? pv.count + ' ' : '') + tname + '</b>', masa ? esc('Masa Pajak ' + L.masaLabel(masa)) : '', fresh ? (pv.needsSign ? 'signed with the PIC passphrase' : 'no signature needed') : '', esc(name)],
                    sub: 'Asks for confirmation, then issues only the previewed list' + (fresh && pv.token ? ' (code ' + esc(pv.token) + ')' : ''), ready: readiness(ent), blocked,
                    cta: fresh && pv.count ? (pv.needsSign ? 'Issue & sign ' : 'Issue ') + pv.count + ' Bukti Potong' : 'Issue & sign', icon: 'check' });
            }
            if (st.view === 'konsep') {
                const masa = st.pp.single();
                return actionBar({ parts: ['<b>Konsep SPT ' + (st.konsepType === 'ICT_WIT' ? 'PPh 21/26' : 'PPh Unifikasi') + '</b>', masa ? esc('Masa Pajak ' + L.masaLabel(masa)) : '', esc(name)],
                    sub: st.konsepAction === 'create' ? 'Signing and filing stay in Coretax.' : 'Never signs or files the SPT.', ready: readiness(ent), blocked: masa ? '' : 'Select a Masa Pajak',
                    cta: { create: 'Create Konsep SPT', post: 'Posting SPT & download', download: 'Download Konsep SPT' }[st.konsepAction], icon: st.konsepAction === 'create' ? 'file' : 'download' });
            }
            const i = st.info;
            const blocked = !st.file ? 'Select an import file first' : st.infoError ? 'File cannot be used' : !i ? 'Checking file…' : (i.problems || []).length ? 'Fix the data problems in the file' : '';
            return actionBar({ parts: [i ? '<b>' + i.count + ' ' + esc(i.label) + '</b>' : '<b>Upload to Belum Terbit</b>', st.file ? esc(st.file.fileName) : '<span class="muted">No file yet</span>', esc(name)],
                sub: 'Does not issue or sign.', ready: readiness(ent), blocked, cta: 'Upload to Belum Terbit', icon: 'upload' });
        },
        async start(st, api) {
            if (st.view === 'issue') {
                const pv = st.preview, rp = (n) => Number(n || 0).toLocaleString('id-ID');
                const ok = await P.confirmDialog({ title: pv.needsSign ? 'Issue & Sign Bukti Potong' : 'Issue Bukti Potong', body: pv.needsSign ? 'This issues and signs the list from the preview in Coretax. It cannot be undone easily.' : 'This issues the list from the preview in Coretax. It cannot be undone easily.',
                    details: [['Entity', api.entity().entity_name], ['Masa Pajak', pv.period], ['Type', pv.label], ['Bukti Potong', String(pv.count)], ['Total bruto', 'Rp ' + rp(pv.totalGross)], ['Total PPh', 'Rp ' + rp(pv.totalTax)], ['Signature', pv.needsSign ? 'Signed with the PIC passphrase' : 'None (not signed)']],
                    requireTick: true, tickLabel: 'I have checked the list above', confirmLabel: pv.needsSign ? 'Issue & sign' : 'Issue' });
                if (!ok) return;
                await P.post('/api/actions/issue-ebupot', { entity: api.entity(), type: pv.forType, period: pv.forPeriod, token: pv.token });
                st.preview = null; return;
            }
            if (st.view === 'konsep') {
                const ent = api.entity(), masa = st.pp.single(), taxLabel = String(st.konsepType || '').toUpperCase();
                if (st.konsepAction === 'create') {
                    if (!await P.confirmDialog({ title: 'Create Konsep SPT', body: 'This creates a draft Konsep SPT in Coretax. You can delete it there if needed.', details: [['Entity', ent.entity_name], ['SPT', taxLabel], ['Masa Pajak', masa ? L.masaLabel(masa) : '']], confirmLabel: 'Create Konsep SPT' })) return;
                    return P.post('/api/actions/create-konsep', { entity: ent, taxType: st.konsepType, period: masa });
                }
                if (st.konsepAction === 'post' && !await P.confirmDialog({ title: 'Posting SPT', body: 'This posts the SPT in Coretax. Posting cannot be undone from this tool.', details: [['Entity', ent.entity_name], ['SPT', taxLabel], ['Masa Pajak', masa ? L.masaLabel(masa) : '']], requireTick: true, tickLabel: 'I have checked the details above', confirmLabel: 'Posting SPT' })) return;
                return P.post('/api/actions/konsep-download', { entity: api.entity(), taxType: st.konsepType, period: st.pp.single(), post: st.konsepAction === 'post' });
            }
            if (!await P.confirmDialog({ title: 'Upload to Belum Terbit', body: 'This uploads the file to Belum Terbit in Coretax. Nothing is issued or signed.', details: [['Entity', api.entity().entity_name], ['File', st.file.fileName]], confirmLabel: 'Upload to Belum Terbit' })) return;
            await P.post('/api/actions/import-coretax', { entity: api.entity(), fileBase64: st.file.fileBase64, filePath: st.file.filePath, fileName: st.file.fileName });
        }
    });

    const REGISTRY = { spt, ebupot, bpsaya, faktur, a1, dividen, kredit, billing, impor };
    P.pages = { NAV, get: (id) => REGISTRY[id], all: REGISTRY };
    P.pages.meta = (id) => { for (const g of NAV) for (const it of g.items) if (it.id === id) return it; return null; };
})();
