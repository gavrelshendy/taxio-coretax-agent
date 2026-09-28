/* Taxio Pilot - entitas: memuat daftar (Taxio Hub + entitas lokal), pilihan entitas/PIC yang aktif,
   palet pencarian, dan dialog tambah/ubah entitas lokal.

   Tiga jenis baris di sini:
   - Taxio Hub (project 'taxio_hub'): PIC tertaut, login OTOMATIS lewat kredensial Taxio Hub.
   - Lokal (project 'local', tab Saya): kredensial Coretax ASLI disimpan di komputer ini, login
     OTOMATIS lewat jalur yang identik (lib/local-auth-client.js di sisi server) - dari sudut
     pandang tampilan ini, entitas lokal diperlakukan SAMA seperti Taxio Hub (bisa 1 atau banyak
     PIC, tag OTOMATIS yang sama), hanya beda sumber kredensialnya.
   - Manual (project 'manual'): sesi Coretax POLOS yang dibuka lewat "Buka Coretax" dan di-login
     sendiri oleh pengguna, tanpa kredensial tersimpan apa pun - ini yang satu-satunya memakai
     tag MANUAL dan tidak pernah mengenal PIC. */
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
    // Preferensi PIC diingat untuk entitas apa pun yang punya lebih dari satu PIC (Taxio Hub
    // ATAU Badan lokal) - keduanya login otomatis, jadi keduanya berhak mengingat pilihan.
    const picPrefs = () => P.store.get('picPref', {});
    E.pickFor = (entity) => L.pickPic(entity, picPrefs()[L.entityKey(entity)]);
    E.current = () => (E.selected ? L.flattenSelection(E.selected.entity, E.selected.picId) : null);
    E.select = function (entity, picId) {
        if (entity.project !== 'manual' && picId) { const p = picPrefs(); p[L.entityKey(entity)] = picId; P.store.set('picPref', p); }
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
                // entitas manual bernama ("Pakai login manual") dibiarkan; hanya sesi terdeteksi mengikuti jendela Coretax
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

    /** Login otomatis segera setelah entitas (dan PIC-nya, bila ada) selesai dipilih di palet -
     *  menghindari langkah tambahan "Masuk Coretax" terpisah. Tidak berlaku untuk sesi manual
     *  (tidak ada yang bisa di-login-kan) atau entitas Hub yang belum tertaut PIC. Diam-diam
     *  gagal (tombol "Masuk Coretax" di topbar tetap ada sebagai cadangan) - kegagalan login
     *  sudah punya jalur pelaporannya sendiri lewat log aktivitas. */
    function autoLoginAfterSelect() {
        const flat = E.current();
        if (!flat || flat.project === 'manual' || flat.pic_id === 'unlinked') return;
        if (P.state.run && P.state.run.active) return;
        P.post('/api/actions/login-entity', { entity: flat }).then(() => P.run.poll()).catch(() => { /* tombol Masuk Coretax di topbar tetap tersedia */ });
    }

    // ---------- Potongan tampilan bersama ----------
    E.typeLabel = (e) => (e.individual ? 'Orang Pribadi' : 'Badan');
    E.chipHtml = function () {
        const cur = E.selected ? E.selected.entity : null;
        if (!cur) return '<button type="button" class="entity-chip empty" id="entity-chip" aria-haspopup="dialog"><span class="av">' + P.icon('search', 16) + '</span><span class="tx"><b>Pilih entitas</b><span>Cari nama atau NPWP · Ctrl K / Alt K</span></span>' + P.icon('down', 16) + '</button>';
        const flat = E.current();
        const tag = cur.project === 'manual' ? '<span class="tag manual">MANUAL</span>' : '<span class="tag auto">OTOMATIS</span>';
        const bits = [];
        if (cur.session) bits.push('Sesi Coretax yang sedang terbuka');
        else {
            // ID internal (mis. local:le_...) tidak untuk ditampilkan; kode entitas hanya bermakna untuk Taxio Hub
            bits.push(cur.npwp ? L.formatNpwp(cur.npwp) : (cur.project === 'taxio_hub' ? cur.entity_id : 'NPWP belum diisi'));
            bits.push(E.typeLabel(cur));
            const pic = (cur.project === 'local' || cur.project === 'taxio_hub') ? (flat && flat.pic_name) : '';
            if (pic && !cur.individual) bits.push('PIC ' + pic);
        }
        const name = cur.session ? (P.state.manual.identity || 'Sesi manual') : cur.entity_name;
        return '<button type="button" class="entity-chip" id="entity-chip" aria-haspopup="dialog"><span class="av">' + P.esc(cur.session ? 'SM' : L.initials(cur.entity_name)) + '</span>'
            + '<span class="tx"><b>' + P.esc(name) + tag + '</b><span>' + P.esc(bits.join(' · ')) + '</span></span>' + P.icon('down', 16) + '</button>';
    };

    // ---------- Palet ----------
    // picCursor: PIC yang sedang di-highlight (bukan berarti sudah dipilih/login) saat pic-panel
    // suatu entitas sedang terbuka - digerakkan panah/Enter tanpa menyentuh mouse sama sekali.
    const pal = { open: false, tab: 'group', q: '', hover: 0, expanded: null, picCursor: null };
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
        // Punya PIC lebih dari satu berlaku sama untuk Taxio Hub maupun Badan lokal - keduanya
        // login otomatis, jadi keduanya butuh pemilih PIC yang sama.
        const multi = !unlinked && (e.pics || []).length > 1;
        const open = multi && pal.expanded === key;
        const chosen = multi ? E.pickFor(e) : null;
        const isLocal = e.project === 'local';
        const isManualRow = e.project === 'manual';
        // Tag OTOMATIS/MANUAL/BELUM ADA PIC SELALU tampil, di posisi yang sama - sebelumnya
        // entitas dengan >1 PIC kehilangan tag ini (digantikan pemilih PIC), membuatnya terlihat
        // beda kelas padahal sama-sama otomatis. Pemilih PIC sekarang tampil BERDAMPINGAN.
        let tag;
        if (unlinked) tag = '<span class="tag warn lg">BELUM ADA PIC</span>';
        else if (isManualRow) tag = '<span class="tag lg manual" style="margin-left:0">TERDETEKSI</span>';
        else tag = '<span class="tag lg auto" style="margin-left:0">OTOMATIS</span>';
        const picChip = multi ? '<span class="pic-chip">' + P.esc((chosen ? chosen.pic_name : '').split(' ')[0]) + P.icon(open ? 'up' : 'down', 15) + '</span>' : '';
        const actions = isLocal ? '<span class="ent-actions"><button type="button" aria-label="Ubah entitas" data-act="edit" data-key="' + P.esc(key) + '">' + P.icon('pencil', 15) + '</button><button type="button" aria-label="Hapus entitas" data-act="del" data-key="' + P.esc(key) + '" style="color:var(--red)">' + P.icon('trash', 15) + '</button></span>' : '';
        const right = '<span class="row-right">' + actions + picChip + tag + '</span>';
        const av = isManualRow ? 'SM' : L.initials(e.entity_name);
        let html = '<div class="ent' + (cur ? ' current' : '') + (idx === pal.hover && !unlinked ? ' hover' : '') + (unlinked ? ' unlinked' : '') + '" data-idx="' + idx + '">'
            + '<button type="button" class="ent-main" data-act="ent" data-key="' + P.esc(key) + '"' + (unlinked ? ' aria-disabled="true"' : '') + '>'
            + '<span class="ent-av">' + P.esc(av) + '</span><span class="ent-tx"><b>' + P.esc(isManualRow ? (P.state.manual.identity || 'Sesi manual') : e.entity_name) + '</b><span>' + metaFor(e) + '</span></span>' + right
            + (cur ? P.icon('check', 18, '', 2.6).replace('<svg ', '<svg style="color:var(--accent)" ') : '') + '</button>';
        if (open) {
            // Baris yang di-highlight: picCursor (digerakkan panah ↑↓, dikonfirmasi Enter) kalau
            // ada, kalau tidak jatuh ke PIC yang sudah pernah dipilih/utama - SAMA sekali tidak
            // menyentuh mouse, supaya Enter dua kali (pilih entitas, lalu pilih PIC) benar-benar
            // bisa dipakai dari keyboard, bukan cuma klik.
            const cursorId = pal.picCursor || (chosen && chosen.pic_id);
            html += '<div class="pic-panel"><div class="cap">Login memakai PIC</div>' + e.pics.map((p) =>
                '<button type="button" class="radio-row" role="radio" aria-checked="' + (cursorId === p.pic_id) + '" data-act="pic" data-key="' + P.esc(key) + '" data-pic="' + P.esc(p.pic_id) + '"><span class="rd"></span><span class="grow">' + P.esc(p.pic_name) + '</span>' + (p.is_primary ? '<span class="tag auto" style="margin-left:0">UTAMA</span>' : '') + '</button>').join('')
                + '<div class="hint" style="padding:4px 2px 0">↑↓ pilih PIC, Enter konfirmasi &amp; login. Jika SPT ditandatangani PIC lain, unduhan SPT otomatis dicoba dengan PIC tersebut.</div></div>';
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
                html += '<div class="pal-sec">DITAMBAHKAN DI SINI</div>' + (locals.length ? locals.map((e) => rowHtml(e, push(e))).join('') : '<div class="pal-empty" style="padding:12px">' + (q ? 'Tidak ada yang cocok.' : 'Belum ada. Tambahkan klien yang belum ada di Taxio Hub.') + '</div>')
                    // Ditata seperti baris entitas biasa (ikon + teks rata kiri), bukan sebagai
                    // tombol besar terpisah di ujung bawah - supaya menyatu dengan daftar.
                    + '<button type="button" class="pal-add" data-act="add"><span class="ent-av" style="background:var(--accent-soft);color:var(--accent)">' + P.icon('plus', 18, '', 2.2) + '</span><span>Tambah entitas baru</span></button>';
            } else if (!hubs.length && !me) html = '<div class="pal-empty">Belum ada entitas pribadi.</div>';
        }
        if (pal.hover >= palNav.length) pal.hover = Math.max(0, palNav.length - 1);
        return html;
    }

    function paintPalette() {
        const body = P.$('pal-body'); if (body) body.innerHTML = bodyHtml();
        const foot = P.$('pal-foot');
        if (foot) foot.innerHTML = '<span style="display:flex;gap:6px;align-items:center"><kbd>↑</kbd><kbd>↓</kbd> pilih</span><span style="display:flex;gap:6px;align-items:center"><kbd>Enter</kbd> gunakan &amp; login</span><span class="grow"></span>'
            + (pal.tab === 'group' ? '<span><b style="color:var(--accent-ink)">OTOMATIS</b> login dari Taxio Hub</span>' : '<span><b style="color:var(--accent-ink)">OTOMATIS</b> Taxio Hub &amp; lokal · <b style="color:var(--text)">MANUAL</b> Anda login sendiri</span>');
        document.querySelectorAll('#pal-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === pal.tab)));
    }

    E.openPalette = function (tab) {
        if (pal.open) return;
        pal.open = true; pal.q = ''; pal.hover = 0; pal.expanded = null; pal.picCursor = null;
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
        input.addEventListener('input', () => { pal.q = input.value; pal.hover = 0; pal.expanded = null; pal.picCursor = null; paintPalette(); });
        scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) E.closePalette(); });
        scrim.addEventListener('mouseover', (e) => { const row = e.target.closest('.ent'); if (row && row.dataset.idx !== undefined && Number(row.dataset.idx) >= 0 && Number(row.dataset.idx) !== pal.hover) { pal.hover = Number(row.dataset.idx); scrim.querySelectorAll('.ent.hover').forEach((n) => n.classList.remove('hover')); if (!row.classList.contains('unlinked')) row.classList.add('hover'); } });
        scrim.addEventListener('click', (e) => {
            const tabBtn = e.target.closest('#pal-tabs button');
            if (tabBtn) { pal.tab = tabBtn.dataset.tab; pal.hover = 0; pal.expanded = null; pal.picCursor = null; paintPalette(); setHint(); return; }
            const t = e.target.closest('[data-act]');
            if (!t) return;
            const act = t.dataset.act;
            const ent = t.dataset.key ? (findByKey(t.dataset.key) || (E.manualEntity() && L.entityKey(E.manualEntity()) === t.dataset.key ? E.manualEntity() : null)) : null;
            if (act === 'ent' && ent) activate(ent);
            else if (act === 'pic' && ent) { E.select(ent, t.dataset.pic); E.closePalette(); autoLoginAfterSelect(); }
            else if (act === 'use-manual' && ent) { useManualFor(ent); E.closePalette(); }
            else if (act === 'add') { E.closePalette(); E.openDialog(null); }
            else if (act === 'edit' && ent) { E.closePalette(); E.openDialog(ent); }
            else if (act === 'del' && ent) deleteLocal(ent);
        });
        // Di level dokumen, bukan pada scrim: setelah baris diklik isi palet digambar ulang dan fokus
        // jatuh ke body, sehingga Esc/Enter tidak lagi sampai ke elemen di dalam palet.
        // Dua cara pakai keyboard, DUA-DUANYA harus tetap jalan:
        // (1) ketik di kotak cari, lalu ↑↓/Enter - jalan pintas ala command palette di bawah ini.
        //     Saat pic-panel sebuah entitas terbuka (pal.expanded), ↑↓/Enter pindah menguasai
        //     pilihan PIC di panel itu, BUKAN lagi baris entitas - supaya "pilih entitas (Enter)
        //     lalu pilih PIC (↑↓, Enter)" selesai tanpa mouse sama sekali.
        // (2) Tab murni ke tombol APA PUN (baris entitas, radio PIC, tab Grup/Saya, edit/hapus,
        //     dst.) lalu Enter/Space - itu perilaku NATIF <button> HTML biasa (memicu 'click',
        //     ditangkap listener klik yang sama di bawah). Jalan pintas di atas HANYA aktif saat
        //     fokus asli ada di kotak cari - begitu fokus pindah ke tombol lewat Tab, method ini
        //     tidak boleh ikut campur sama sekali, supaya navigasi Tab standar (screen reader,
        //     atau siapa pun yang tidak mengetik) tetap 100% berfungsi, bukan cuma jalur pintas ini.
        palKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); E.closePalette(); return; }
            if (document.activeElement !== input) return;
            if (pal.expanded) {
                const ent = findByKey(pal.expanded);
                const pics = (ent && ent.pics) || [];
                if (!pics.length) return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    let idx = pics.findIndex((p) => p.pic_id === pal.picCursor);
                    if (idx < 0) idx = 0;
                    idx = e.key === 'ArrowDown' ? Math.min(pics.length - 1, idx + 1) : Math.max(0, idx - 1);
                    pal.picCursor = pics[idx].pic_id;
                    paintPalette();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const pic = pics.find((p) => p.pic_id === pal.picCursor) || pics[0];
                    E.select(ent, pic.pic_id);
                    E.closePalette();
                    autoLoginAfterSelect();
                }
                return;
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); pal.hover = Math.min(palNav.length - 1, pal.hover + 1); paintPalette(); scrollHover(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); pal.hover = Math.max(0, pal.hover - 1); paintPalette(); scrollHover(); }
            else if (e.key === 'Enter') { e.preventDefault(); if (palNav[pal.hover]) activate(palNav[pal.hover]); }
        };
        document.addEventListener('keydown', palKey);
    };
    function scrollHover() { const el = document.querySelector('#pal-body .ent.hover'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); }
    E.closePalette = function () { pal.open = false; if (palKey) { document.removeEventListener('keydown', palKey); palKey = null; } const s = P.$('palette'); if (s) s.remove(); };

    /** Baris ber-PIC banyak (Hub atau Badan lokal) SELALU membuka pilihan PIC dulu - lewat klik
     *  MAUPUN Enter - sama seperti mekanisme Taxio Hub sendiri (coretax.js loginToCoretax: >=2
     *  PIC selalu lewat pemilih, cuma 1 PIC yang login langsung). Sebelumnya Enter diam-diam
     *  memakai PIC utama dan langsung login tanpa kesempatan memilih PIC lain - dilaporkan
     *  pengguna sebagai bug, bukan jalan pintas yang diinginkan. Baris ber-PIC tunggal/tanpa PIC
     *  tetap langsung memakai PIC bawaan dan LOGIN OTOMATIS, menghindari langkah tambahan klik
     *  "Masuk Coretax" terpisah. */
    function activate(e) {
        if (e.project === 'taxio_hub' && e.linked === false) return;
        const multi = (e.pics || []).length > 1;
        if (multi) {
            const key = L.entityKey(e);
            if (pal.expanded === key) { pal.expanded = null; pal.picCursor = null; }
            else { pal.expanded = key; const c = E.pickFor(e); pal.picCursor = c ? c.pic_id : ((e.pics[0] || {}).pic_id || null); }
            paintPalette();
            return;
        }
        const pic = (e.pics || []).length ? E.pickFor(e) : null;
        E.select(e, pic ? pic.pic_id : null);
        E.closePalette();
        autoLoginAfterSelect();
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
    // Kredensial Coretax ASLI: Orang Pribadi login dengan NPWP+kata sandi miliknya sendiri;
    // Badan tidak pernah login langsung - PIC-nya (>=1) yang punya kredensial, lalu impersonate
    // ke entitas ini. Kata sandi/passphrase yang lama TIDAK PERNAH dikirim balik ke sini (server
    // tidak pernah membocorkannya) - field-nya selalu kosong saat mengubah entitas, dan
    // dikosongkan berarti "jangan diganti" (lib/local-entities.js yang menegakkan aturan ini).
    const blankPic = () => ({ id: null, name: '', npwp: '', password: '', passphrase: '' });
    const dlg = { id: null, name: '', npwp: '', type: 'badan', password: '', passphrase: '', pics: [blankPic()], error: '', busy: false };
    E.openDialog = function (existing) {
        Object.assign(dlg, {
            id: existing ? existing.local_id : null,
            name: existing ? existing.entity_name : '',
            npwp: existing ? existing.npwp || '' : '',
            type: existing ? (existing.individual ? 'op' : 'badan') : 'badan',
            password: '', passphrase: '',
            pics: existing && !existing.individual && existing.pics && existing.pics.length
                ? existing.pics.map((p) => ({ id: p.pic_id, name: p.pic_name, npwp: p.pic_npwp || '', password: '', passphrase: '' }))
                : [blankPic()],
            error: '', busy: false
        });
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
        const n = P.$('led-name'); if (n) n.focus();
    };
    function closeDialog() { if (dlgKey) { document.removeEventListener('keydown', dlgKey); dlgKey = null; } const s = P.$('entity-dialog'); if (s) s.remove(); }

    function picRowHtml(p, i) {
        const passHint = p.id ? 'Kosongkan agar tidak berubah' : 'Wajib diisi';
        const passphraseHint = p.id ? 'Kosongkan agar tidak berubah' : 'Opsional';
        return '<div class="pic-form-row" style="border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px">'
            + '<div class="row" style="justify-content:space-between"><b style="font-size:13px;color:var(--ink)">PIC ' + (i + 1) + (i === 0 ? '<span class="tag auto" style="margin-left:8px">UTAMA</span>' : '') + '</b>'
            + (dlg.pics.length > 1 ? '<button type="button" class="icon-btn" data-act="pic-remove" data-idx="' + i + '" aria-label="Hapus PIC ini">' + P.icon('trash', 15) + '</button>' : '<span></span>') + '</div>'
            + '<div class="field"><label>Nama PIC</label><input class="input sm" data-pic-field="name" data-idx="' + i + '" value="' + P.esc(p.name) + '" placeholder="mis. Ani Sample Wijaya"></div>'
            + '<div class="field"><label>NPWP PIC</label><input class="input sm mono" data-pic-field="npwp" data-idx="' + i + '" value="' + P.esc(p.npwp) + '" placeholder="16 digit, tanpa titik/strip" maxlength="20" inputmode="numeric"></div>'
            + '<div class="field"><label>Kata sandi Coretax</label><input class="input sm" type="password" data-pic-field="password" data-idx="' + i + '" value="' + P.esc(p.password) + '" placeholder="' + passHint + '" autocomplete="new-password"></div>'
            + '<div class="field"><label>Passphrase tanda tangan <span class="hint" style="font-weight:400">(opsional)</span></label><input class="input sm" type="password" data-pic-field="passphrase" data-idx="' + i + '" value="' + P.esc(p.passphrase) + '" placeholder="' + passphraseHint + '" autocomplete="new-password"></div>'
            + '</div>';
    }
    function paintDialog() {
        const box = document.querySelector('#entity-dialog .dialog'); if (!box) return;
        const keep = document.activeElement && document.activeElement.id;
        const keepPicField = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.picField : null;
        const keepPicIdx = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.idx : null;
        const isBadan = dlg.type === 'badan';
        const passHint = dlg.id ? 'Kosongkan agar tidak berubah' : 'Wajib diisi';
        const passphraseHint = dlg.id ? 'Kosongkan agar tidak berubah' : 'Opsional';
        const opFields = '<div class="field"><label for="led-pass">Kata sandi Coretax</label><input id="led-pass" class="input" type="password" value="' + P.esc(dlg.password) + '" placeholder="' + passHint + '" autocomplete="new-password"></div>'
            + '<div class="field"><label for="led-passphrase">Passphrase tanda tangan <span class="hint" style="font-weight:400">(opsional)</span></label><input id="led-passphrase" class="input" type="password" value="' + P.esc(dlg.passphrase) + '" placeholder="' + passphraseHint + '" autocomplete="new-password"></div>';
        const badanFields = '<div class="field" style="gap:10px"><span class="label">PIC (akun Orang Pribadi)<span class="req">WAJIB, BOLEH LEBIH DARI SATU</span></span>'
            + '<span class="hint">Coretax membuka akun Badan lewat akun Orang Pribadi penanggung jawabnya. Saat otomasi berjalan, agen login sebagai PIC ini, lalu memilih entitas ini.</span>'
            + '<div class="stack-lg">' + dlg.pics.map(picRowHtml).join('') + '</div>'
            + '<button type="button" class="pic-add" data-act="pic-add">' + P.icon('plus', 17, '', 2.2) + 'Tambah PIC</button></div>';
        box.innerHTML = '<div class="dialog-head"><h2>' + (dlg.id ? 'Ubah entitas' : 'Tambah entitas') + '</h2><button type="button" class="icon-btn" aria-label="Tutup" data-act="close">' + P.icon('x', 18) + '</button></div>'
            + '<div class="dialog-body"><p class="hint" style="font-size:13.5px">Kredensial Coretax disimpan di komputer ini saja, dan dipakai untuk login otomatis - sama seperti entitas Taxio Hub.</p>'
            + '<div class="field"><span class="label">Jenis wajib pajak</span>' + P.seg('led-type', [{ value: 'badan', label: 'Badan' }, { value: 'op', label: 'Orang Pribadi' }], dlg.type)
            + '<span class="hint">' + (isBadan ? 'Login lewat akun PIC, lalu impersonate ke entitas ini.' : 'Login langsung dengan NPWP dan kata sandi entitas ini sendiri.') + '</span></div>'
            + '<div class="field"><label for="led-name">Nama entitas</label><input id="led-name" class="input" value="' + P.esc(dlg.name) + '" placeholder="' + (isBadan ? 'mis. CV Contoh Makmur' : 'mis. Budi Santoso') + '" maxlength="100"></div>'
            + '<div class="field"><label for="led-npwp">NPWP' + (isBadan ? ' entitas' : '') + '</label><input id="led-npwp" class="input mono" value="' + P.esc(dlg.npwp) + '" placeholder="16 digit, tanpa titik/strip" maxlength="20" inputmode="numeric"></div>'
            + (isBadan ? badanFields : opFields)
            + '<div class="form-error" id="led-error">' + P.esc(dlg.error) + '</div></div>'
            + '<div class="dialog-foot"><span class="grow"></span><button type="button" class="btn" data-act="close">Batal</button><button type="button" class="btn btn-primary" data-act="save"' + (dlg.busy ? ' disabled' : '') + '>' + (dlg.busy ? 'Menyimpan…' : 'Simpan entitas') + '</button></div>';
        if (keepPicField) {
            const el = document.querySelector('[data-pic-field="' + keepPicField + '"][data-idx="' + keepPicIdx + '"]');
            if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* bukan input teks */ } }
        } else if (keep) {
            const el = P.$(keep);
            if (el) { el.focus(); if (el.setSelectionRange && el.value !== undefined) { const n = el.value.length; try { el.setSelectionRange(n, n); } catch (e) { /* bukan input teks */ } } }
        }
    }
    function onDialogInput(e) {
        const id = e.target.id;
        if (id === 'led-name') dlg.name = e.target.value;
        else if (id === 'led-npwp') dlg.npwp = e.target.value;
        else if (id === 'led-pass') dlg.password = e.target.value;
        else if (id === 'led-passphrase') dlg.passphrase = e.target.value;
        else if (e.target.dataset && e.target.dataset.picField) {
            const i = Number(e.target.dataset.idx);
            if (dlg.pics[i]) dlg.pics[i][e.target.dataset.picField] = e.target.value;
        }
    }
    async function onDialogClick(e) {
        const t = e.target.closest('[data-act]'); if (!t) return;
        const act = t.dataset.act;
        if (act === 'close') return closeDialog();
        if (act === 'led-type') { dlg.type = t.dataset.val; dlg.error = ''; return paintDialog(); }
        if (act === 'pic-add') {
            dlg.pics.push(blankPic()); dlg.error = ''; paintDialog();
            const last = document.querySelector('[data-pic-field="name"][data-idx="' + (dlg.pics.length - 1) + '"]'); if (last) last.focus();
            return;
        }
        if (act === 'pic-remove') { dlg.pics.splice(Number(t.dataset.idx), 1); dlg.error = ''; return paintDialog(); }
        if (act === 'save') {
            if (!dlg.name.trim()) { dlg.error = 'Nama entitas wajib diisi.'; return paintDialog(); }
            const body = { id: dlg.id || undefined, name: dlg.name, npwp: dlg.npwp, type: dlg.type };
            if (dlg.type === 'op') { body.password = dlg.password; body.passphrase = dlg.passphrase; }
            else { body.pics = dlg.pics.map((p) => ({ id: p.id || undefined, name: p.name, npwp: p.npwp, password: p.password, passphrase: p.passphrase })); }
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

    // Ctrl+K atau Alt+K membuka palet dari mana saja di dalam aplikasi.
    document.addEventListener('keydown', (e) => {
        const combo = ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) || (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'k' || e.key === 'K'));
        if (combo && P.isConnected() && !P.$('palette')) { e.preventDefault(); E.openPalette(); }
    });
})();
