/* Taxio Pilot - entitas: memuat daftar (Taxio Hub + entitas lokal), pilihan entitas/PIC yang aktif,
   palet pencarian, dan dialog tambah/ubah entitas lokal. */
(function () {
    'use strict';
    const P = window.Pilot;
    const L = P.L;
    const E = P.ent = { group: [], personal: [], errors: [], loaded: false, selected: null };

    // ---------- Pemuatan ----------
    E.load = async function () {
        if (!P.isConnected()) { E.group = []; E.personal = []; E.loaded = false; P.emit('entities'); return; }
        const results = await Promise.all(['group', 'personal'].map((mode) => P.api('/api/entities?mode=' + mode).then((r) => ({ mode, r })).catch((e) => ({ mode, error: e.message }))));
        E.errors = [];
        for (const x of results) {
            if (x.error) { E.errors.push(x.error); continue; }
            E[x.mode] = x.r.entities || [];
            (x.r.errors || []).forEach((m) => E.errors.push(m));
        }
        E.loaded = true;
        restoreSelection();
        P.emit('entities');
    };

    E.manualEntity = function () {
        const m = P.state.manual;
        if (!m.loggedIn || P.isRestricted()) return null;
        return { session: true, project: 'manual', project_label: 'Manual', entity_id: 'MANUAL', entity_name: m.identity ? 'Sesi Manual · ' + m.identity : 'Sesi Manual', npwp: '', individual: false, pic_id: 'manual', pic_name: 'Login manual', pic_is_mine: true, pics: [], linked: true };
    };
    const all = () => E.group.concat(E.personal);
    const findByKey = (key) => all().find((e) => L.entityKey(e) === key) || null;

    // ---------- Pilihan aktif ----------
    const picPrefs = () => P.store.get('picPref', {});
    E.pickFor = (entity) => L.pickPic(entity, picPrefs()[L.entityKey(entity)]);
    E.current = () => (E.selected ? L.flattenSelection(E.selected.entity, E.selected.picId) : null);
    E.select = function (entity, picId) {
        if (entity.project === 'taxio_hub' && picId) { const p = picPrefs(); p[L.entityKey(entity)] = picId; P.store.set('picPref', p); }
        E.selected = { entity, picId: picId || null };
        P.store.set('sel', { key: L.entityKey(entity), picId: picId || null, name: entity.entity_name });
        P.emit('entity');
    };
    E.clear = function () { E.selected = null; P.store.set('sel', null); P.emit('entity'); };
    function restoreSelection() {
        const saved = P.store.get('sel', null);
        if (E.selected) {
            // tetap pada pilihan sekarang bila masih ada (data segar), kalau tidak lepas
            const sel = E.selected.entity;
            if (sel.project === 'manual') {
                // entitas manual bernama ("Pakai login manual") dibiarkan; hanya sesi terdeteksi yang mengikuti jendela Coretax
                if (sel.session) { const s = E.manualEntity(); E.selected = s ? { entity: s, picId: null } : null; }
                return;
            }
            const fresh = findByKey(L.entityKey(sel));
            E.selected = fresh ? { entity: fresh, picId: E.selected.picId } : null;
            return;
        }
        if (saved && saved.key) {
            const found = findByKey(saved.key);
            if (found && (found.linked !== false || found.project === 'local')) E.selected = { entity: found, picId: saved.picId };
        }
    }
    // Sesi manual terdeteksi dan belum ada pilihan lain: pilih otomatis, seperti perilaku lama.
    P.on('manual', () => {
        const me = E.manualEntity();
        const onSession = E.selected && E.selected.entity.session;
        if (me && (!E.selected || onSession)) { E.selected = { entity: me, picId: null }; P.emit('entity'); }
        else if (!me && onSession) { E.selected = null; P.emit('entity'); }
    });

    // ---------- Potongan tampilan bersama ----------
    E.typeLabel = (e) => (e.individual ? 'Orang Pribadi' : 'Badan');
    E.chipHtml = function () {
        const cur = E.selected ? E.selected.entity : null;
        if (!cur) return '<button type="button" class="entity-chip empty" id="entity-chip" aria-haspopup="dialog"><span class="av">' + P.icon('search', 16) + '</span><span class="tx"><b>Pilih entitas</b><span>Cari nama atau NPWP · Ctrl K</span></span>' + P.icon('down', 16) + '</button>';
        const flat = E.current();
        const tag = cur.project === 'taxio_hub' ? '<span class="tag auto">OTOMATIS</span>' : '<span class="tag manual">MANUAL</span>';
        const bits = [];
        if (cur.session) bits.push('Sesi Coretax yang sedang terbuka');
        else {
            // ID internal (mis. local:le_...) tidak untuk ditampilkan; kode entitas hanya bermakna untuk Taxio Hub
            bits.push(cur.npwp ? L.formatNpwp(cur.npwp) : (cur.project === 'taxio_hub' ? cur.entity_id : 'NPWP belum diisi'));
            bits.push(E.typeLabel(cur));
            const pic = cur.project === 'local' ? (cur.pics && cur.pics.length ? cur.pics.map((p) => p.pic_name).join(', ') : '') : (cur.project === 'taxio_hub' ? (flat && flat.pic_name) : '');
            if (pic && !cur.individual) bits.push('PIC ' + pic);
        }
        const name = cur.session ? (P.state.manual.identity || 'Sesi manual') : cur.entity_name;
        return '<button type="button" class="entity-chip" id="entity-chip" aria-haspopup="dialog"><span class="av">' + P.esc(cur.session ? 'SM' : L.initials(cur.entity_name)) + '</span>'
            + '<span class="tx"><b>' + P.esc(name) + tag + '</b><span>' + P.esc(bits.join(' · ')) + '</span></span>' + P.icon('down', 16) + '</button>';
    };

    // ---------- Palet ----------
    const pal = { open: false, tab: 'group', q: '', hover: 0, expanded: null };
    let palKey = null;
    let dlgKey = null;
    let palNav = []; // urutan baris yang bisa dipilih (untuk keyboard)

    function metaFor(e) {
        if (e.project === 'manual') return P.esc(P.state.manual.identity || 'Sesi Coretax yang sedang terbuka');
        if (e.project === 'local') {
            const pics = (e.pics || []).map((p) => p.pic_name);
            return '<span class="mono" style="font-size:12px">' + P.esc(e.npwp ? L.formatNpwp(e.npwp) : 'NPWP belum diisi') + '</span> · ' + E.typeLabel(e) + (pics.length ? ' · PIC ' + P.esc(pics.join(', ')) : '');
        }
        const code = '<span class="mono" style="font-size:12px">' + P.esc(e.entity_id) + '</span>';
        if (e.linked === false) return code;
        const n = (e.pics || []).length;
        return code + ' · ' + (n > 1 ? n + ' PIC Coretax' : 'PIC Coretax: ' + P.esc(e.pics[0] ? e.pics[0].pic_name : '-'));
    }

    function rowHtml(e, idx) {
        const key = L.entityKey(e);
        const cur = E.selected && L.entityKey(E.selected.entity) === key;
        const unlinked = e.project === 'taxio_hub' && e.linked === false;
        const multi = e.project === 'taxio_hub' && (e.pics || []).length > 1;
        const open = multi && pal.expanded === key;
        const chosen = multi ? E.pickFor(e) : null;
        let right = '';
        if (unlinked) right = '<span class="tag warn lg">BELUM ADA PIC</span>';
        else if (multi) right = '<span class="pic-chip">' + P.esc((chosen ? chosen.pic_name : '').split(' ')[0]) + P.icon(open ? 'up' : 'down', 15) + '</span>';
        else if (e.project === 'local') right = '<span class="ent-actions"><button type="button" aria-label="Ubah entitas" data-act="edit" data-key="' + P.esc(key) + '">' + P.icon('pencil', 15) + '</button><button type="button" aria-label="Hapus entitas" data-act="del" data-key="' + P.esc(key) + '" style="color:var(--red)">' + P.icon('trash', 15) + '</button></span><span class="tag lg manual" style="margin-left:0">MANUAL</span>';
        else if (e.project === 'manual') right = '<span class="tag lg manual" style="margin-left:0">TERDETEKSI</span>';
        else right = '<span class="tag lg auto" style="margin-left:0">OTOMATIS</span>';
        const av = e.project === 'manual' ? 'SM' : L.initials(e.entity_name);
        let html = '<div class="ent' + (cur ? ' current' : '') + (idx === pal.hover && !unlinked ? ' hover' : '') + (unlinked ? ' unlinked' : '') + '" data-idx="' + idx + '">'
            + '<button type="button" class="ent-main" data-act="ent" data-key="' + P.esc(key) + '"' + (unlinked ? ' aria-disabled="true"' : '') + '>'
            + '<span class="ent-av">' + P.esc(av) + '</span><span class="ent-tx"><b>' + P.esc(e.project === 'manual' ? (P.state.manual.identity || 'Sesi manual') : e.entity_name) + '</b><span>' + metaFor(e) + '</span></span>' + right
            + (cur ? P.icon('check', 18, '', 2.6).replace('<svg ', '<svg style="color:var(--accent)" ') : '') + '</button>';
        if (open) {
            html += '<div class="pic-panel"><div class="cap">Login memakai PIC</div>' + e.pics.map((p) =>
                '<button type="button" class="radio-row" role="radio" aria-checked="' + (chosen && chosen.pic_id === p.pic_id) + '" data-act="pic" data-key="' + P.esc(key) + '" data-pic="' + P.esc(p.pic_id) + '"><span class="rd"></span><span class="grow">' + P.esc(p.pic_name) + '</span>' + (p.is_primary ? '<span class="tag auto" style="margin-left:0">UTAMA</span>' : '') + '</button>').join('')
                + '<div class="hint" style="padding:4px 2px 0">Jika SPT ditandatangani PIC lain, unduhan SPT otomatis dicoba dengan PIC tersebut.</div></div>';
        }
        if (unlinked) {
            html += '<div class="unlinked-note">Belum ada PIC tertaut. Tautkan lewat <b style="color:var(--text)">Manage Coretax PIC</b> di Taxio Hub agar bisa dipakai otomatis.'
                + (P.isRestricted() ? '' : ' <button type="button" class="link" data-act="use-manual" data-key="' + P.esc(key) + '">Pakai login manual</button>') + '</div>';
        }
        return html + '</div>';
    }

    function bodyHtml() {
        palNav = [];
        const q = pal.q.trim();
        const push = (e) => { palNav.push(e); return palNav.length - 1; };
        let html = '';
        if (pal.tab === 'group') {
            const list = L.visibleEntities(E.group, q);
            if (!list.length) html = '<div class="pal-empty">' + (q ? 'Tidak ada entitas yang cocok dengan "' + P.esc(q) + '".' : (E.loaded ? 'Belum ada entitas dengan PIC tertaut.' : 'Memuat entitas…')) + '</div>';
            else html = (q ? '<div class="pal-sec">' + list.length + ' HASIL</div>' : '') + list.map((e) => rowHtml(e, e.linked === false ? -1 : push(e))).join('');
            const hidden = L.hiddenUnlinkedCount(E.group);
            if (!q && hidden > 0) html += '<div class="pal-note">' + P.icon('info', 15) + '<span>Entitas yang belum punya PIC tertaut disembunyikan. Ketik nama untuk mencarinya.</span></div>';
        } else {
            const me = E.manualEntity();
            const hubs = L.visibleEntities(E.personal.filter((e) => e.project === 'taxio_hub'), q);
            const locals = E.personal.filter((e) => e.project === 'local' && L.entityMatches(e, q));
            if (me) html += '<div class="pal-sec">SESI YANG SEDANG TERBUKA</div>' + rowHtml(me, push(me));
            if (hubs.length) html += '<div class="pal-sec">DARI TAXIO HUB</div>' + hubs.map((e) => rowHtml(e, push(e))).join('');
            if (!P.isRestricted()) {
                html += '<div class="pal-sec">DITAMBAHKAN DI SINI</div>' + (locals.length ? locals.map((e) => rowHtml(e, push(e))).join('') : '<div class="pal-empty" style="padding:12px">' + (q ? 'Tidak ada yang cocok.' : 'Belum ada. Tambahkan klien yang belum ada di Taxio Hub.') + '</div>');
                html += '<button type="button" class="pal-add" data-act="add">' + P.icon('plus', 18, '', 2.2) + 'Tambah entitas baru</button>';
            } else if (!hubs.length && !me) html = '<div class="pal-empty">Belum ada entitas pribadi.</div>';
        }
        if (pal.hover >= palNav.length) pal.hover = Math.max(0, palNav.length - 1);
        return html;
    }

    function paintPalette() {
        const body = P.$('pal-body'); if (body) body.innerHTML = bodyHtml();
        const foot = P.$('pal-foot');
        if (foot) foot.innerHTML = '<span style="display:flex;gap:6px;align-items:center"><kbd>↑</kbd><kbd>↓</kbd> pilih</span><span style="display:flex;gap:6px;align-items:center"><kbd>Enter</kbd> gunakan</span><span class="grow"></span>'
            + (pal.tab === 'group' ? '<span><b style="color:var(--accent-ink)">OTOMATIS</b> login dari Taxio Hub</span>' : '<span><b style="color:var(--accent-ink)">OTOMATIS</b> Taxio Hub · <b style="color:var(--text)">MANUAL</b> Anda login sendiri</span>');
        document.querySelectorAll('#pal-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === pal.tab)));
    }

    E.openPalette = function (tab) {
        if (pal.open) return;
        pal.open = true; pal.q = ''; pal.hover = 0; pal.expanded = null;
        pal.tab = tab || (E.selected && E.selected.entity.project !== 'taxio_hub' ? 'personal' : (E.selected && E.selected.entity.individual && E.personal.some((e) => L.entityKey(e) === L.entityKey(E.selected.entity)) ? 'personal' : 'group'));
        const scrim = document.createElement('div');
        scrim.className = 'scrim'; scrim.id = 'palette';
        scrim.innerHTML = '<div class="dialog" role="dialog" aria-label="Pilih entitas">'
            + '<div class="pal-search">' + P.icon('search', 20, '', 2.2).replace('<svg ', '<svg style="color:var(--accent)" ') + '<input id="pal-q" type="text" placeholder="Cari entitas atau NPWP…" autocomplete="off" aria-label="Cari entitas"><kbd>Esc</kbd></div>'
            + '<div class="pal-bar"><div class="seg" id="pal-tabs"><button type="button" data-tab="group" aria-pressed="false">' + P.icon('users', 15) + 'Grup</button><button type="button" data-tab="personal" aria-pressed="false">' + P.icon('user', 15) + 'Saya</button></div><span class="hint" id="pal-hint"></span></div>'
            + '<div class="pal-list" id="pal-body"></div><div class="pal-foot" id="pal-foot"></div></div>';
        document.body.appendChild(scrim);
        const input = P.$('pal-q');
        const setHint = () => { const h = P.$('pal-hint'); if (h) h.textContent = pal.tab === 'group' ? 'Satu baris per entitas' : 'Entitas pribadi dan yang Anda tambah sendiri'; };
        paintPalette(); setHint(); input.focus();
        input.addEventListener('input', () => { pal.q = input.value; pal.hover = 0; pal.expanded = null; paintPalette(); });
        scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) E.closePalette(); });
        scrim.addEventListener('mouseover', (e) => { const row = e.target.closest('.ent'); if (row && row.dataset.idx !== undefined && Number(row.dataset.idx) >= 0 && Number(row.dataset.idx) !== pal.hover) { pal.hover = Number(row.dataset.idx); scrim.querySelectorAll('.ent.hover').forEach((n) => n.classList.remove('hover')); if (!row.classList.contains('unlinked')) row.classList.add('hover'); } });
        scrim.addEventListener('click', (e) => {
            const tabBtn = e.target.closest('#pal-tabs button');
            if (tabBtn) { pal.tab = tabBtn.dataset.tab; pal.hover = 0; pal.expanded = null; paintPalette(); setHint(); return; }
            const t = e.target.closest('[data-act]');
            if (!t) return;
            const act = t.dataset.act;
            const ent = t.dataset.key ? (findByKey(t.dataset.key) || (E.manualEntity() && L.entityKey(E.manualEntity()) === t.dataset.key ? E.manualEntity() : null)) : null;
            if (act === 'ent' && ent) activate(ent, true);
            else if (act === 'pic' && ent) { E.select(ent, t.dataset.pic); E.closePalette(); }
            else if (act === 'use-manual' && ent) { useManualFor(ent); E.closePalette(); }
            else if (act === 'add') { E.closePalette(); E.openDialog(null); }
            else if (act === 'edit' && ent) { E.closePalette(); E.openDialog(ent); }
            else if (act === 'del' && ent) deleteLocal(ent);
        });
        // Di level dokumen, bukan pada scrim: setelah baris diklik isi palet digambar ulang dan fokus
        // jatuh ke body, sehingga Esc/Enter tidak lagi sampai ke elemen di dalam palet.
        palKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); E.closePalette(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); pal.hover = Math.min(palNav.length - 1, pal.hover + 1); paintPalette(); scrollHover(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); pal.hover = Math.max(0, pal.hover - 1); paintPalette(); scrollHover(); }
            else if (e.key === 'Enter') { e.preventDefault(); if (palNav[pal.hover]) activate(palNav[pal.hover], false); }
        };
        document.addEventListener('keydown', palKey);
    };
    function scrollHover() { const el = document.querySelector('#pal-body .ent.hover'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); }
    E.closePalette = function () { pal.open = false; if (palKey) { document.removeEventListener('keydown', palKey); palKey = null; } const s = P.$('palette'); if (s) s.remove(); };

    /** Klik: entitas dengan lebih dari satu PIC membuka pilihan PIC; Enter langsung memakai PIC bawaan. */
    function activate(e, fromClick) {
        if (e.project === 'taxio_hub' && e.linked === false) return;
        const multi = e.project === 'taxio_hub' && (e.pics || []).length > 1;
        if (multi && fromClick) { const key = L.entityKey(e); pal.expanded = pal.expanded === key ? null : key; paintPalette(); return; }
        const pic = e.project === 'taxio_hub' ? E.pickFor(e) : null;
        E.select(e, pic ? pic.pic_id : null);
        E.closePalette();
    }
    function useManualFor(e) {
        E.select({ project: 'manual', project_label: 'Manual', entity_id: 'MANUAL', entity_name: e.entity_name, npwp: e.npwp || '', individual: !!e.individual, pic_id: 'manual', pic_name: 'Login manual', pic_is_mine: true, pics: [], linked: true }, null);
    }
    async function deleteLocal(e) {
        if (!confirm('Hapus entitas "' + e.entity_name + '" dari komputer ini?')) return;
        try {
            await P.post('/api/local-entities/delete', { id: e.local_id });
            if (E.selected && L.entityKey(E.selected.entity) === L.entityKey(e)) E.clear();
            await E.load();
            paintPalette();
        } catch (err) { alert('Gagal menghapus: ' + err.message); }
    }

    // ---------- Dialog tambah / ubah entitas lokal ----------
    const dlg = { id: null, name: '', npwp: '', type: 'badan', picKeys: new Set(), cands: [], newOpen: false, newName: '', newNpwp: '', error: '', busy: false };
    E.openDialog = async function (existing) {
        Object.assign(dlg, { id: existing ? existing.local_id : null, name: existing ? existing.entity_name : '', npwp: existing ? existing.npwp || '' : '', type: existing ? existing.type : 'badan', picKeys: new Set(existing && existing.pics ? existing.pics.map((p) => p.source + ':' + p.pic_id.split(':').slice(1).join(':')) : []), cands: [], newOpen: false, newName: '', newNpwp: '', error: '', busy: false });
        const scrim = document.createElement('div');
        scrim.className = 'scrim'; scrim.id = 'entity-dialog';
        scrim.innerHTML = '<div class="dialog narrow" role="dialog" aria-label="' + (existing ? 'Ubah entitas' : 'Tambah entitas') + '"></div>';
        document.body.appendChild(scrim);
        scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeDialog(); });
        dlgKey = (e) => { if (e.key === 'Escape') closeDialog(); };
        document.addEventListener('keydown', dlgKey);
        scrim.addEventListener('click', onDialogClick);
        scrim.addEventListener('input', onDialogInput);
        paintDialog();
        loadCandidates();
        const n = P.$('led-name'); if (n) n.focus();
    };
    function closeDialog() { if (dlgKey) { document.removeEventListener('keydown', dlgKey); dlgKey = null; } const s = P.$('entity-dialog'); if (s) s.remove(); }
    async function loadCandidates() {
        try { dlg.cands = (await P.api('/api/local-entities/pic-candidates' + (dlg.id ? '?exclude=' + encodeURIComponent(dlg.id) : ''))).candidates || []; }
        catch (e) { dlg.error = e.message; }
        paintDialog();
    }
    function paintDialog() {
        const box = document.querySelector('#entity-dialog .dialog'); if (!box) return;
        const keep = document.activeElement && document.activeElement.id;
        const isBadan = dlg.type === 'badan';
        const cand = (c) => {
            const key = c.source + ':' + c.id; const on = dlg.picKeys.has(key);
            return '<button type="button" class="pic-cand" role="checkbox" aria-checked="' + on + '" data-act="pic-toggle" data-key="' + P.esc(key) + '"><span class="check" aria-checked="' + on + '">' + P.icon('check', 13, '', 3) + '</span>'
                + '<span class="t"><b>' + P.esc(c.name) + '</b><span>Orang Pribadi · ' + (c.source === 'hub' ? 'dari Taxio Hub' : 'ditambahkan di sini') + '</span></span>'
                + '<span class="tag lg ' + (c.source === 'hub' ? 'auto' : 'manual') + '" style="margin-left:0">' + (c.source === 'hub' ? 'OTOMATIS' : 'MANUAL') + '</span></button>';
        };
        const newForm = dlg.newOpen
            ? '<div class="pic-newform"><div class="field"><label for="led-newname">Nama PIC (orang pribadi)</label><input id="led-newname" class="input sm" value="' + P.esc(dlg.newName) + '" placeholder="mis. Ani Sample Wijaya"></div><div class="field"><label for="led-newnpwp">NPWP PIC (opsional)</label><input id="led-newnpwp" class="input sm mono" value="' + P.esc(dlg.newNpwp) + '" placeholder="00.000.000.0-000.000"></div><div class="row"><button type="button" class="btn btn-sm btn-primary" data-act="pic-new-save"' + (dlg.busy ? ' disabled' : '') + '>Simpan PIC</button><button type="button" class="btn btn-sm" data-act="pic-new-cancel">Batal</button></div></div>'
            : '<button type="button" class="pic-add" data-act="pic-new">' + P.icon('plus', 17, '', 2.2) + 'Tambah PIC baru (orang pribadi)</button>';
        box.innerHTML = '<div class="dialog-head"><h2>' + (dlg.id ? 'Ubah entitas' : 'Tambah entitas') + '</h2><button type="button" class="icon-btn" aria-label="Tutup" data-act="close">' + P.icon('x', 18) + '</button></div>'
            + '<div class="dialog-body"><p class="hint" style="font-size:13.5px">Untuk klien yang belum ada di Taxio Hub. Disimpan di komputer ini saja dan tidak mengubah data Taxio Hub.</p>'
            + '<div class="field"><span class="label">Jenis wajib pajak</span>' + P.seg('led-type', [{ value: 'badan', label: 'Badan' }, { value: 'op', label: 'Orang Pribadi' }], dlg.type)
            + '<span class="hint">' + (isBadan ? 'Badan dibuka lewat akun orang pribadi penanggung jawabnya (PIC).' : 'Orang Pribadi login dengan akunnya sendiri, tanpa PIC. Bisa membuka SPT Tahunan PPh OP dan Bukti Potong Saya.') + '</span></div>'
            + '<div class="field"><label for="led-name">Nama entitas</label><input id="led-name" class="input" value="' + P.esc(dlg.name) + '" placeholder="' + (isBadan ? 'mis. CV Contoh Makmur' : 'mis. Budi Santoso') + '" maxlength="100"></div>'
            + '<div class="field"><label for="led-npwp">NPWP (opsional)</label><input id="led-npwp" class="input mono" value="' + P.esc(dlg.npwp) + '" placeholder="00.000.000.0-000.000"><span class="hint">Dipakai agen untuk mencocokkan sesi Coretax yang Anda buka.</span></div>'
            + (isBadan ? '<div class="field" style="gap:8px"><span class="label">Akun PIC untuk impersonate<span class="req">WAJIB UNTUK BADAN</span></span><span class="hint">Coretax membuka akun badan lewat akun orang pribadi penanggung jawabnya (PIC). Saat otomasi berjalan, agen meminta Anda login sebagai PIC ini, lalu memilih entitas ini. Boleh lebih dari satu PIC.</span>'
                + '<div class="pic-list">' + (dlg.cands.length ? dlg.cands.map(cand).join('') : '<div class="pal-empty" style="padding:14px">Belum ada orang pribadi. Tambahkan PIC di bawah.</div>') + newForm + '</div></div>' : '')
            + '<div class="form-error" id="led-error">' + P.esc(dlg.error) + '</div></div>'
            + '<div class="dialog-foot"><span class="grow">' + (isBadan ? dlg.picKeys.size + ' PIC dipilih' : '') + '</span><button type="button" class="btn" data-act="close">Batal</button><button type="button" class="btn btn-primary" data-act="save"' + (dlg.busy ? ' disabled' : '') + '>' + (dlg.busy ? 'Menyimpan…' : 'Simpan entitas') + '</button></div>';
        if (keep) { const el = P.$(keep); if (el) { el.focus(); if (el.setSelectionRange && el.value !== undefined) { const n = el.value.length; try { el.setSelectionRange(n, n); } catch (e) { /* bukan input teks */ } } } }
    }
    function onDialogInput(e) {
        const id = e.target.id;
        if (id === 'led-name') dlg.name = e.target.value; else if (id === 'led-npwp') dlg.npwp = e.target.value;
        else if (id === 'led-newname') dlg.newName = e.target.value; else if (id === 'led-newnpwp') dlg.newNpwp = e.target.value;
    }
    async function onDialogClick(e) {
        const t = e.target.closest('[data-act]'); if (!t) return;
        const act = t.dataset.act;
        if (act === 'close') return closeDialog();
        if (act === 'led-type') { dlg.type = t.dataset.val; dlg.error = ''; return paintDialog(); }
        if (act === 'pic-toggle') { const k = t.dataset.key; if (dlg.picKeys.has(k)) dlg.picKeys.delete(k); else dlg.picKeys.add(k); dlg.error = ''; return paintDialog(); }
        if (act === 'pic-new') { dlg.newOpen = true; paintDialog(); const n = P.$('led-newname'); if (n) n.focus(); return; }
        if (act === 'pic-new-cancel') { dlg.newOpen = false; dlg.newName = ''; dlg.newNpwp = ''; return paintDialog(); }
        if (act === 'pic-new-save') {
            if (!dlg.newName.trim()) { dlg.error = 'Nama PIC wajib diisi.'; return paintDialog(); }
            dlg.busy = true; dlg.error = ''; paintDialog();
            try {
                const r = await P.post('/api/local-entities/save', { name: dlg.newName, npwp: dlg.newNpwp, type: 'op' });
                dlg.picKeys.add('local:' + r.entity.local_id);
                dlg.newOpen = false; dlg.newName = ''; dlg.newNpwp = '';
                await loadCandidates();
                E.load();
            } catch (err) { dlg.error = err.message; }
            dlg.busy = false; return paintDialog();
        }
        if (act === 'save') {
            if (!dlg.name.trim()) { dlg.error = 'Nama entitas wajib diisi.'; return paintDialog(); }
            const body = { id: dlg.id || undefined, name: dlg.name, npwp: dlg.npwp, type: dlg.type, pics: [] };
            if (dlg.type === 'badan') {
                if (!dlg.picKeys.size) { dlg.error = 'Pilih minimal satu PIC (akun orang pribadi) untuk impersonate.'; return paintDialog(); }
                body.pics = Array.from(dlg.picKeys).map((k) => { const i = k.indexOf(':'); const c = dlg.cands.find((x) => x.source + ':' + x.id === k); return { source: k.slice(0, i), id: k.slice(i + 1), name: c ? c.name : '' }; });
            }
            dlg.busy = true; dlg.error = ''; paintDialog();
            try {
                const r = await P.post('/api/local-entities/save', body);
                closeDialog();
                await E.load();
                const saved = E.personal.find((x) => x.local_id === r.entity.local_id);
                if (saved) E.select(saved, null);
                P.info('Entitas "' + r.entity.entity_name + '" disimpan.');
            } catch (err) { dlg.busy = false; dlg.error = err.message; paintDialog(); }
        }
    }

    // Ctrl+K membuka palet dari mana saja di dalam aplikasi.
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K') && P.isConnected() && !P.$('palette')) { e.preventDefault(); E.openPalette(); }
    });
})();
