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
        return { session: true, project: 'manual', project_label: 'Manual', entity_id: 'MANUAL', entity_name: m.identity ? 'Manual session · ' + m.identity : 'Manual session', npwp: '', individual: false, pic_id: 'manual', pic_name: 'Manual login', pic_is_mine: true, pics: [], linked: true };
    };
    const all = () => E.group.concat(E.personal);
    const findByKey = (key) => all().find((e) => L.entityKey(e) === key) || null;

    // ---------- Pilihan aktif ----------
    // Entitas ber-PIC banyak (Hub ATAU Badan lokal) TIDAK punya PIC bawaan di palet: setiap pilihan baru
    // dari palet selalu menanyakan PIC (keputusan pemilik - tidak pernah diam-diam memakai PIC utama
    // maupun PIC terakhir). PIC yang sudah dipilih tetap melekat di E.selected (chip topbar) selama
    // entitasnya masih terpilih; memilih entitas lain lalu kembali = ditanya lagi.
    E.current = () => (E.selected ? L.flattenSelection(E.selected.entity, E.selected.picId) : null);
    E.select = function (entity, picId) {
        if (P.multi) P.multi._drop(entity);
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
            E.selected = fresh ? { entity: fresh, picId: E.selected.picId, restored: E.selected.restored } : null;
            return;
        }
        if (saved && saved.key) {
            const found = findByKey(saved.key);
            // restored: pilihan ini cuma diingat dari pemakaian sebelumnya, bukan dipilih sekarang. Kalau
            // saat dicek ternyata tidak ada jendela Coretax-nya (mis. aplikasi baru dibuka) pilihannya
            // dilepas oleh releaseIfSessionGone (shell.js) - supaya pil tidak "nyangkut" di entitas
            // lama dengan status "Belum masuk Coretax".
            if (found && (found.linked !== false || found.project === 'local')) E.selected = { entity: found, picId: saved.picId, restored: true };
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
     *  (tidak ada yang bisa di-login-kan) atau entitas Hub yang belum tertaut PIC.
     *  Sesi berbeda boleh berjalan bersamaan, jadi proses di sesi LAIN tidak menghalangi (dulu
     *  setiap proses yang sedang jalan membuat login "Sesi baru" dilewati diam-diam - dilaporkan
     *  2026-10-07). Bila sesi entitas ini sendiri sedang sibuk, atau server menolak, beri tahu. */
    function autoLoginAfterSelect() {
        const flat = E.current();
        if (!flat || flat.project === 'manual' || flat.pic_id === 'unlinked') return;
        // Satu PIC bisa menjalankan beberapa jendela sekaligus: hanya proses ENTITAS INI yang menahan login otomatis
        // (entitas lain milik PIC yang sama mendapat jendela lain).
        const r = P.run.entityRun(flat);
        if (r) {
            P.info('This PIC session is running "' + ((r && r.label) || 'another process') + '". Log in to ' + flat.entity_name + ' after that process finishes, or pick another PIC.');
            return;
        }
        P.post('/api/actions/login-entity', { entity: flat }).then(() => P.run.poll()).catch((e) => P.info('Login to ' + flat.entity_name + ' not started: ' + e.message));
    }

    // ---------- Potongan tampilan bersama ----------
    E.typeLabel = (e) => (e.individual ? 'Individual' : 'Corporate');
    E.chipHtml = function () {
        const cur = E.selected ? E.selected.entity : null;
        if (!cur) return '<button type="button" class="entity-chip empty" id="entity-chip" aria-haspopup="dialog"><span class="av">' + P.icon('search', 16) + '</span><span class="tx"><b>Select entity</b><span>Search name or NPWP · Ctrl K / Alt K</span></span>' + P.icon('down', 16) + '</button>';
        const flat = E.current();
        const tag = cur.project === 'manual' ? '<span class="tag manual">MANUAL</span>' : '<span class="tag auto">AUTO</span>';
        const bits = [];
        if (cur.session) bits.push('Currently open Coretax session');
        else {
            // ID internal (mis. local:le_...) tidak untuk ditampilkan; kode entitas hanya bermakna untuk Taxio Hub
            bits.push(cur.npwp ? L.formatNpwp(cur.npwp) : (cur.project === 'taxio_hub' ? cur.entity_id : 'NPWP not filled in'));
            bits.push(E.typeLabel(cur));
            const pic = (cur.project === 'local' || cur.project === 'taxio_hub') ? (flat && flat.pic_name) : '';
            if (pic && !cur.individual) bits.push('PIC ' + pic);
        }
        const name = cur.session ? (P.state.manual.identity || 'Manual session') : cur.entity_name;
        return '<button type="button" class="entity-chip" id="entity-chip" aria-haspopup="dialog"><span class="av">' + P.esc(cur.session ? 'SM' : L.initials(cur.entity_name)) + '</span>'
            + '<span class="tx"><b>' + P.esc(name) + tag + '</b><span>' + P.esc(bits.join(' · ')) + '</span></span>' + P.icon('down', 16) + '</button>';
    };

    // ---------- Sesi Coretax di topbar + antrean banyak entitas ----------
    // Satu sesi = satu jendela Chrome yang login sebagai satu PIC. Dari jendela itu entitas lain milik
    // PIC yang sama dibuka dengan impersonate ulang, TANPA jendela baru. Tab sesi selalu tampil di
    // topbar; tab aktif (yang sorotannya menyala) = sesi yang dipakai untuk unduhan. Panah di tab
    // membuka daftar entitas sesi itu: klik nama = pindah entitas di jendela yang sama.
    const digits = (s) => String(s || '').replace(/\D/g, '');
    function sameNpwp(a, b) { const x = digits(a); const y = digits(b); return x.length >= 15 && y.length >= 15 && (x === y || x.endsWith(y) || y.endsWith(x)); }
    E.sessions = () => (P.state.sessions || []).filter((s) => s.open !== false);
    E.sessionEntities = function (picId) {
        const seen = new Set(); const out = [];
        all().forEach((e) => {
            if (e.project === 'manual' || e.linked === false) return;
            if (!(e.pics || []).some((p) => p.pic_id === picId)) return;
            if (P.isRestricted() && e.individual) return; // perorangan diblokir untuk akun Restricted
            const k = L.entityKey(e); if (seen.has(k)) return; seen.add(k); out.push(e);
        });
        return out.sort((a, b) => String(a.entity_name || '').localeCompare(String(b.entity_name || '')));
    };
    function picNameOf(picId) {
        for (const e of all()) { const p = (e.pics || []).find((x) => x.pic_id === picId); if (p && p.pic_name) return p.pic_name; }
        return '';
    }
    // Entitas yang SEDANG diimpersonate di jendela sesi (dibaca dari identitas jendelanya: NPWP/nama).
    /** PIC (pool) sebuah tab sesi: tab = satu jendela ("<pic>", "<pic>~2", ...), beberapa jendela bisa milik satu PIC. */
    const poolOf = (s) => (s && s.pool) || (s && s.picId) || '';
    const poolOfKey = (key) => poolOf(E.sessions().find((x) => x.picId === key)) || key;
    E.sessionEntity = function (s) {
        const list = E.sessionEntities(poolOf(s));
        const id = String(s.identity || '');
        const byNpwp = list.find((e) => e.npwp && sameNpwp(e.npwp, id));
        if (byNpwp) return byNpwp;
        const name = id.split('·').slice(1).join('·').trim().toUpperCase();
        return (name && list.find((e) => String(e.entity_name || '').trim().toUpperCase() === name)) || null;
    };
    E.selectSession = function (picId) {
        const s = E.sessions().find((x) => x.picId === picId); if (!s) return;
        if (s.kind === 'manual') { const me = E.manualEntity(); if (me) E.select(me, null); return; }
        const ent = E.sessionEntity(s);
        if (!ent) { P.info('The entity open in this session cannot be recognized yet. Select it using the arrow on the session tab.'); return; }
        E.select(ent, poolOf(s));
    };
    /** "Login ulang" di tab sesi yang sudah tidak login: sesi manual membuka/menampilkan lagi jendela
     *  login manualnya; sesi PIC menjalankan login otomatis yang sama dengan memilih entitas
     *  (/api/actions/login-entity memakai ulang jendela PIC itu). Entitasnya: pilihan sekarang bila
     *  milik PIC ini, entitas terakhir di jendela itu, satu-satunya entitas PIC, atau dipilih dulu. */
    E.reloginSession = function (picId, anchor) {
        const s = E.sessions().find((x) => x.picId === picId); if (!s) return;
        if (s.kind === 'manual') return P.manual.open();
        const cur = E.current();
        const pool = poolOf(s);
        const list = E.sessionEntities(pool);
        const ent = (cur && cur.pic_id === pool) ? null : (E.sessionEntity(s) || (list.length === 1 ? list[0] : null));
        if (!(cur && cur.pic_id === pool) && !ent) {
            if (!list.length) { P.info('No entity is linked to this session\'s PIC yet. Select an entity via New session.'); return; }
            P.info('Select an entity to log this session in again.');
            return E.openSessionPopover(picId, anchor);
        }
        if (ent) E.select(ent, pool);
        autoLoginAfterSelect();
    };
    E.sessionStripHtml = function () {
        const sess = E.sessions();
        if (!sess.length) return '<div class="sess-strip" role="group" aria-label="Active Coretax sessions"><span class="sw-empty">No Coretax window is open. One opens by itself when you sign in or start a run.</span><button type="button" class="sess-new" id="sess-new">' + P.icon('plus', 14, '', 2.4) + 'New session</button></div>';
        const cur = E.current();
        // Jendela per PIC: PIC dengan lebih dari satu jendela diberi nomor jendela ("Andi #2"); tab yang menyala =
        // jendela entitas terpilih (bila PIC-nya punya beberapa jendela: yang terakhir login sebagai entitas itu).
        const perPool = {};
        sess.forEach((s) => { const k = poolOf(s); perPool[k] = (perPool[k] || 0) + 1; });
        const tabs = sess.map((s, i) => {
            const manual = s.kind === 'manual';
            const pool = poolOf(s);
            const multi = !manual && perPool[pool] > 1;
            const active = !!(cur && cur.pic_id === pool && (!multi || !s.entityId || s.entityId === cur.entity_id));
            const idRest = String(s.identity || '').split('·').slice(1).join('·').trim();
            const idText = s.identity ? (idRest || s.identity) : (s.loggedIn ? 'Identity not read yet' : 'Not logged in');
            const who = manual ? 'Manual' : (picNameOf(pool) || 'PIC').split(' ')[0] + (multi ? ' #' + (s.windowNo || 1) : '');
            const n = manual ? 0 : E.sessionEntities(pool).length;
            const id = P.esc(s.picId);
            // Sesi yang sedang menjalankan proses (bisa beberapa sekaligus) diberi penanda berputar.
            const run = P.run.busy(s.picId) ? P.run.runOf(s.picId) : null;
            const num = run ? P.icon('loader', 12, 'spin', 2.6) : String(i + 1);
            const tip = run ? 'Running: ' + run.label + (run.paused ? ' (paused)' : '') : 'Use this session for downloads';
            // Jendela masih terbuka tapi Coretax tidak lagi login (sesi kedaluwarsa): login ulang di jendela itu.
            const relogin = !run && !s.loggedIn && !s.identity;
            return '<div class="sess-tab' + (active ? ' active' : '') + (run ? ' busy' : '') + '">'
                + '<button type="button" class="sess-main" data-sess="' + id + '" title="' + P.esc(tip) + '" aria-pressed="' + active + '"><span class="n">' + num + '</span><span class="t"><b>' + P.esc(who) + '</b><span>' + P.esc(run ? (run.paused ? 'Paused' : 'Running') : idText) + '</span></span></button>'
                + (relogin ? '<button type="button" class="sess-relogin" data-sess-relogin="' + id + '" title="This Coretax session is no longer logged in - log in again in the same window">' + P.icon('retry', 13, '', 2.2) + 'Log in again</button>' : '')
                + (manual ? '' : '<button type="button" class="sess-drop" data-sess-drop="' + id + '" aria-label="Select entity in this session" title="Switch entity in this window · ' + n + (n === 1 ? ' entity' : ' entities') + '">' + P.icon('down', 14) + '</button>')
                + '<button type="button" class="sess-x" data-sess-close="' + id + '" aria-label="Close this session" title="Close this window">' + P.icon('x', 13) + '</button></div>';
        }).join('');
        return '<div class="sess-strip" role="group" aria-label="Active Coretax sessions">' + tabs + '<button type="button" class="sess-new" id="sess-new">' + P.icon('plus', 14, '', 2.4) + 'New session</button></div>';
    };
    /** Proses yang menunggu jendela bebas (batas sesi paralel, atau perintah yang sama untuk entitasnya masih berjalan): pil di topbar. */
    E.queuePillHtml = function () {
        const queued = (P.state.runs || []).filter((r) => r.queued);
        return queued.length ? '<span class="sess-queue" title="' + P.esc('Waiting for a free Coretax window:\n' + queued.map((r) => '#' + r.position + ' ' + r.label).join('\n')) + '">' + P.icon('loader', 12, '', 2.4) + queued.length + ' queued</span>' : '';
    };

    // ---------- Beberapa klien sekaligus (halaman Download) ----------
    // Himpunan klien = entitas terpilih di topbar (selalu yang pertama) + `extra`. PIC klien tambahan dengan
    // lebih dari satu PIC TIDAK pernah diisi otomatis: picId null = belum dipilih, tombol Start terkunci.
    // Pindah entitas lewat topbar mengganti klien pertama saja; tambahan tetap. Halaman yang mengubah data
    // di Coretax tidak memakai ini sama sekali. Tiap klien dikirim sebagai satu permintaan aksi biasa dengan
    // `batch` yang sama; antrean server yang mengatur batas paralel (tidak ada lagi antrean berurutan di browser).
    const keyOf = (e) => L.entityKey(e);
    const multi = { extra: [] };
    const defaultPic = (e) => ((e.pics || []).length === 1 ? e.pics[0].pic_id : null);
    P.multi = {
        /** Klien terpilih: [{ key, entity, picId, flat, pending, primary }]; kosong bila belum ada entitas. */
        rows() {
            const cur = E.selected; if (!cur) return [];
            const out = [{ key: keyOf(cur.entity), entity: cur.entity, picId: cur.picId, pending: false, primary: true, flat: E.current() }];
            if (cur.entity.project === 'manual') return out;
            multi.extra.forEach((x) => out.push({ key: keyOf(x.entity), entity: x.entity, picId: x.picId, pending: (x.entity.pics || []).length > 1 && !x.picId, primary: false, flat: L.flattenSelection(x.entity, x.picId) }));
            return out;
        },
        count() { return P.multi.rows().length; },
        pending() { return P.multi.rows().filter((r) => r.pending); },
        has: (key) => multi.extra.some((x) => keyOf(x.entity) === key),
        /** Daftar centang palet -> himpunan tambahan (PIC yang sudah dipilih dipertahankan). */
        setExtras(entities) {
            const old = new Map(multi.extra.map((x) => [keyOf(x.entity), x.picId]));
            const cur = E.selected && keyOf(E.selected.entity);
            multi.extra = entities.filter((e) => keyOf(e) !== cur).map((e) => ({ entity: e, picId: old.has(keyOf(e)) ? old.get(keyOf(e)) : defaultPic(e) }));
            P.emit('multi');
        },
        setPic(key, picId) {
            const cur = E.selected;
            if (cur && keyOf(cur.entity) === key) { E.select(cur.entity, picId); return; }
            const x = multi.extra.find((y) => keyOf(y.entity) === key); if (x) { x.picId = picId || null; P.emit('multi'); }
        },
        /** Hapus klien dari himpunan; klien pertama digantikan klien tambahan pertama yang PIC-nya sudah jelas. */
        canRemove(key) {
            const cur = E.selected;
            if (!cur || keyOf(cur.entity) !== key) return true;
            return multi.extra.some((x) => (x.entity.pics || []).length <= 1 || x.picId);
        },
        remove(key) {
            const cur = E.selected;
            if (cur && keyOf(cur.entity) === key) {
                const nx = multi.extra.find((x) => (x.entity.pics || []).length <= 1 || x.picId); if (!nx) return;
                E.select(nx.entity, nx.picId);
                return;
            }
            multi.extra = multi.extra.filter((x) => keyOf(x.entity) !== key); P.emit('multi');
        },
        clear() { if (multi.extra.length) { multi.extra = []; P.emit('multi'); } },
        _drop(entity) { multi.extra = multi.extra.filter((x) => keyOf(x.entity) !== keyOf(entity)); if (entity.project === 'manual') multi.extra = []; }
    };

    // ---------- Daftar entitas sesi (popover dari panah di tab) ----------
    let popEl = null;
    let popPic = null;
    function closePop() {
        if (!popEl) return;
        popEl.remove(); popEl = null; popPic = null;
        document.removeEventListener('mousedown', popOutside, true);
        document.removeEventListener('keydown', popKey, true);
    }
    E.closeSessionPopover = closePop;
    function popOutside(ev) { if (popEl && !popEl.contains(ev.target) && !ev.target.closest('[data-sess-drop]')) closePop(); }
    function popKey(ev) { if (ev.key === 'Escape') closePop(); }
    function popList(q) {
        return E.sessionEntities(poolOfKey(popPic)).filter((e) => !q || L.entityMatches(e, q));
    }
    function paintPopList() {
        if (!popEl) return;
        const q = (popEl.querySelector('.sp-q') || {}).value || '';
        const cur = E.current();
        const list = popList(q);
        popEl.querySelector('.sp-list').innerHTML = list.map((e) => {
            const k = P.esc(keyOf(e));
            const isCur = !!(cur && keyOf(cur) === keyOf(e) && cur.pic_id === poolOfKey(popPic));
            const meta = (e.project === 'taxio_hub' ? P.esc(e.entity_id) : '') + (e.npwp ? (e.project === 'taxio_hub' ? ' · ' : '') + P.esc(L.formatNpwp(e.npwp)) : '');
            return '<div class="sp-row' + (isCur ? ' cur' : '') + '">'
                + '<button type="button" class="sp-pick" data-sp-pick="' + k + '"><b>' + P.esc(e.entity_name) + '</b><span>' + meta + '</span></button>'
                + (isCur ? '<span class="sp-now" title="Entity currently being processed">' + P.icon('check', 15, '', 2.6) + '</span>' : '') + '</div>';
        }).join('') || '<div class="sp-empty">No matching entities.</div>';
    }
    E.openSessionPopover = function (picId, anchor) {
        if (popEl && popPic === picId) { closePop(); return; }
        closePop();
        const sess = E.sessions(); const idx = sess.findIndex((s) => s.picId === picId); if (idx < 0) return;
        popPic = picId;
        popEl = document.createElement('div'); popEl.className = 'sess-pop'; popEl.setAttribute('role', 'dialog'); popEl.setAttribute('aria-label', 'Session ' + (idx + 1) + ' entities');
        const n = E.sessionEntities(poolOfKey(picId)).length;
        popEl.innerHTML = '<div class="sp-head"><div><b>Session ' + (idx + 1) + ' · ' + P.esc(picNameOf(poolOfKey(picId)) || 'PIC') + '</b><span>' + n + (n === 1 ? ' entity' : ' entities') + ' can be opened in this window without a new window</span></div>'
            + '<button type="button" class="icon-btn" data-sp-front aria-label="Show this session window" title="Show the Chrome window of this session">' + P.icon('globe', 15) + '</button></div>'
            + '<input type="text" class="sp-q" placeholder="Search entities in this session…" aria-label="Search entities in this session">'
            + '<div class="sp-list"></div>'
            + '<div class="sp-hint">Click a name to switch entity in this window.</div>';
        document.body.appendChild(popEl);
        const r = anchor.getBoundingClientRect();
        const w = Math.min(380, window.innerWidth - 16);
        popEl.style.width = w + 'px';
        popEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
        popEl.style.top = (r.bottom + 6) + 'px';
        popEl.style.maxHeight = Math.max(240, window.innerHeight - r.bottom - 20) + 'px';
        paintPopList();
        popEl.querySelector('.sp-q').addEventListener('input', paintPopList);
        popEl.addEventListener('click', async (ev) => {
            const pick = ev.target.closest('[data-sp-pick]');
            if (pick) {
                const e = E.sessionEntities(poolOfKey(popPic)).find((x) => keyOf(x) === pick.dataset.spPick);
                if (e) { E.select(e, poolOfKey(popPic)); closePop(); autoLoginAfterSelect(); }
                return;
            }
            if (ev.target.closest('[data-sp-front]')) { try { await P.post('/api/sessions/front', { picId: popPic }); } catch (e) { /* jendela mungkin sudah tertutup */ } }
        });
        document.addEventListener('mousedown', popOutside, true);
        document.addEventListener('keydown', popKey, true);
        popEl.querySelector('.sp-q').focus();
    };
    // Sesi hilang (jendela ditutup): bersihkan popover/antrean yang menunjuk ke sana.
    P.on('sessions', () => { if (popPic && !E.sessions().some((s) => s.picId === popPic)) closePop(); });

    // ---------- Palet ----------
    // picCursor: PIC yang sedang di-highlight (bukan berarti sudah dipilih/login) saat pic-panel
    // suatu entitas sedang terbuka - digerakkan panah/Enter tanpa menyentuh mouse sama sekali.
    const pal = { open: false, q: '', hover: 0, expanded: null, picCursor: null, multi: false, checked: new Map() };
    let palKey = null;
    let dlgKey = null;
    let palNav = []; // urutan baris yang bisa dipilih (untuk keyboard)

    function metaFor(e) {
        if (e.project === 'manual') return P.esc(P.state.manual.identity || 'Currently open Coretax session');
        if (e.project === 'local') {
            const pics = (e.pics || []).map((p) => p.pic_name);
            return '<span class="mono" style="font-size:12px">' + P.esc(e.npwp ? L.formatNpwp(e.npwp) : 'NPWP not filled in') + '</span> · ' + E.typeLabel(e) + (pics.length ? ' · PIC ' + P.esc(pics.join(', ')) : '');
        }
        const code = '<span class="mono" style="font-size:12px">' + P.esc(e.entity_id) + '</span>';
        if (e.linked === false) return code;
        const n = (e.pics || []).length;
        return code + ' · ' + (n > 1 ? n + ' Coretax PICs' : 'Coretax PIC: ' + P.esc(e.pics[0] ? e.pics[0].pic_name : '-'));
    }

    function rowHtml(e, idx) {
        const key = L.entityKey(e);
        const cur = E.selected && L.entityKey(E.selected.entity) === key;
        const unlinked = e.project === 'taxio_hub' && e.linked === false;
        // Punya PIC lebih dari satu berlaku sama untuk Taxio Hub maupun Badan lokal - keduanya
        // login otomatis, jadi keduanya butuh pemilih PIC yang sama.
        const multi = !unlinked && (e.pics || []).length > 1;
        const open = multi && pal.expanded === key;
        // PIC yang tampil di chip hanya milik entitas yang SEDANG terpilih (info); baris lain: "Choose PIC".
        const chosen = multi && cur && E.selected.picId ? e.pics.find((p) => p.pic_id === E.selected.picId) || null : null;
        const isLocal = e.project === 'local';
        const isManualRow = e.project === 'manual';
        // Label OTOMATIS dihapus dari sini - hampir semua baris di palet ini otomatis (Hub
        // maupun lokal berkredensial), jadi menandainya di tiap baris cuma jadi noise berulang.
        // BELUM ADA PIC dan TERDETEKSI tetap tampil - itu PENGECUALIAN yang justru penting untuk
        // langsung terlihat (entitas ini TIDAK bisa dipakai otomatis / ini sesi yang Anda login
        // sendiri, bukan status "sama seperti yang lain").
        let tag = '';
        if (unlinked) tag = '<span class="tag warn lg">NO PIC YET</span>';
        else if (isManualRow) tag = '<span class="tag lg manual" style="margin-left:0">DETECTED</span>';
        const mm = pal.multi;
        const isPrimary = mm && E.selected && keyOf(E.selected.entity) === key;
        const isChecked = mm && (isPrimary || pal.checked.has(key));
        const picChip = multi && !mm ? '<span class="pic-chip' + (chosen ? '' : ' need') + '">' + P.esc(chosen ? chosen.pic_name.split(' ')[0] : 'Choose PIC') + P.icon(open ? 'up' : 'down', 15) + '</span>' : '';
        const actions = isLocal && !mm ? '<span class="ent-actions"><button type="button" aria-label="Edit entity" data-act="edit" data-key="' + P.esc(key) + '">' + P.icon('pencil', 15) + '</button><button type="button" aria-label="Delete entity" data-act="del" data-key="' + P.esc(key) + '" class="danger-ic">' + P.icon('trash', 15) + '</button></span>' : '';
        const right = '<span class="row-right">' + picChip + tag + '</span>';
        const av = isManualRow ? 'SM' : L.initials(e.entity_name);
        let html = '<div class="ent' + (cur && !mm ? ' current' : '') + (mm && isChecked ? ' ticked' : '') + (idx === pal.hover && !unlinked ? ' hover' : '') + (unlinked ? ' unlinked' : '') + '" data-idx="' + idx + '">'
            + '<div class="ent-line"><button type="button" class="ent-main" data-act="ent" data-key="' + P.esc(key) + '"' + (unlinked ? ' aria-disabled="true"' : '') + (mm ? ' role="checkbox" aria-checked="' + !!isChecked + '"' + (isPrimary ? ' aria-disabled="true" title="Already selected in the top bar"' : '') : '') + '>'
            + '<span class="ent-av">' + P.esc(av) + '</span><span class="ent-tx"><b>' + P.esc(isManualRow ? (P.state.manual.identity || 'Manual session') : e.entity_name) + '</b><span>' + metaFor(e) + '</span></span>' + right
            + (mm ? '<span class="ent-cb' + (isChecked ? ' on' : '') + '" aria-hidden="true">' + (isChecked ? P.icon('check', 13, '', 3) : '') + '</span>' : (cur ? P.icon('check', 18, 'ent-tick', 2.6) : '')) + '</button>'
            // Tombol ubah/hapus JANGAN di dalam .ent-main: <button> di dalam <button> membuat browser
            // menutup .ent-main lebih awal dan merusak tata letak baris. Jadi saudaranya, bukan anaknya.
            + actions + '</div>';
        if (open && !mm) {
            // Baris yang di-highlight: picCursor (digerakkan panah ↑↓, dikonfirmasi Enter). Awalnya
            // KOSONG - tidak ada PIC yang terpilih sebelum pengguna memilihnya sendiri.
            const cursorId = pal.picCursor;
            html += '<div class="pic-panel"><div class="cap">Choose PIC to log in with</div>' + e.pics.map((p) =>
                '<button type="button" class="radio-row" role="radio" aria-checked="' + (cursorId === p.pic_id) + '" data-act="pic" data-key="' + P.esc(key) + '" data-pic="' + P.esc(p.pic_id) + '"><span class="rd"></span><span class="grow">' + P.esc(p.pic_name) + '</span>' + (p.is_primary ? '<span class="tag auto" style="margin-left:0">PRIMARY</span>' : '') + '</button>').join('')
                + '<div class="hint" style="padding:4px 2px 0">If an SPT was signed by another PIC, the SPT download is automatically retried with that PIC.</div></div>';
        }
        if (unlinked) {
            html += '<div class="unlinked-note">No linked PIC yet. Link one via <b>Manage Coretax PIC</b> in Taxio Hub to use it automatically.'
                + (P.isRestricted() ? '' : ' <button type="button" class="link" data-act="use-manual" data-key="' + P.esc(key) + '">Use manual login</button>') + '</div>';
        }
        return html + '</div>';
    }

    // Satu pencarian gabung Grup+Saya (bukan tab terpisah lagi) - mengetik menyaring KEDUANYA
    // sekaligus, tidak perlu pindah tab dulu untuk menemukan entitas pribadi/lokal. Entitas yang
    // muncul di kedua sumber (mis. entitas pribadi seorang PIC yang juga anggota grup) dedupe by
    // key supaya tidak dobel - grup menang, "DARI TAXIO HUB" cuma untuk sisa yang benar-benar
    // tidak tercakup oleh daftar grup.
    function bodyHtml() {
        palNav = [];
        const q = pal.q.trim();
        const push = (e) => { palNav.push(e); return palNav.length - 1; };
        let html = '';
        // "Add entity" ada di footer palet (paintFoot), bukan lagi baris pertama daftar.
        const seen = new Set();
        // Galat pemuatan (mis. sesi Taxio Hub kedaluwarsa) dulu hanya terlihat sebagai "Belum ada entitas."
        (E.errors || []).forEach((m) => { html += '<div class="pal-note err">' + P.icon('warn', 15) + '<span>' + P.esc(m) + '</span></div>'; });

        const me = pal.multi ? null : E.manualEntity();
        if (me) { html += '<div class="pal-sec">CURRENTLY OPEN SESSION</div>' + rowHtml(me, push(me)); }

        const groupList = L.visibleEntities(E.group, q);
        groupList.forEach((e) => seen.add(L.entityKey(e)));
        if (groupList.length) {
            html += (q ? '<div class="pal-sec">' + groupList.length + (groupList.length === 1 ? ' RESULT' : ' RESULTS') + '</div>' : '<div class="pal-sec">ENTITIES</div>')
                + groupList.map((e) => rowHtml(e, e.linked === false ? -1 : push(e))).join('');
        }
        const hidden = L.hiddenUnlinkedCount(E.group);
        if (!q && hidden > 0) html += '<div class="pal-note">' + P.icon('info', 15) + '<span>Entities without a linked PIC are hidden. Type a name to search for them.</span></div>';

        const hubExtra = L.visibleEntities(E.personal.filter((e) => e.project === 'taxio_hub'), q).filter((e) => !seen.has(L.entityKey(e)));
        if (hubExtra.length) html += '<div class="pal-sec">FROM TAXIO HUB</div>' + hubExtra.map((e) => rowHtml(e, push(e))).join('');

        if (!P.isRestricted()) {
            const locals = E.personal.filter((e) => e.project === 'local' && L.entityMatches(e, q));
            if (locals.length || !q) {
                html += '<div class="pal-sec">ADDED HERE</div>' + (locals.length ? locals.map((e) => rowHtml(e, push(e))).join('') : '<div class="pal-empty sm">None yet. Add clients that are not in Taxio Hub.</div>');
            }
        }

        const hadListContent = palNav.length > 0 || !!me;
        if (!hadListContent) html += '<div class="pal-empty">' + (q ? 'No entities match "' + P.esc(q) + '".' : (E.loaded ? 'No entities yet.' : 'Loading entities…')) + '</div>';
        if (pal.hover >= palNav.length) pal.hover = Math.max(0, palNav.length - 1);
        return html;
    }

    function multiSeed() { return multiExtras().map((e) => [keyOf(e), e]); }
    function multiExtras() { return P.multi.rows().filter((r) => !r.primary).map((r) => r.entity); }
    function paintPalette() {
        const body = P.$('pal-body'); const top = body ? body.scrollTop : 0;
        if (body) { body.innerHTML = bodyHtml(); body.scrollTop = top; }
        paintFoot();
    }
    /** Petunjuk Enter mengikuti apa yang SEBENARNYA dilakukan Enter pada baris/keadaan saat ini. */
    function enterHint() {
        if (pal.expanded) return pal.picCursor ? 'use & log in' : '';
        const e = palNav[pal.hover];
        if (!e) return '';
        if (e.project === 'manual') return 'use';
        return (e.pics || []).length > 1 ? 'choose PIC' : 'use & log in';
    }
    function paintFoot() {
        const foot = P.$('pal-foot');
        if (!foot) return;
        if (pal.multi) {
            const n = newCount();
            foot.innerHTML = '<span class="pal-keys"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Shift</kbd>+<kbd>Enter</kbd> tick</span><span><kbd>Enter</kbd> ' + (n ? 'add' : 'tick') + '</span></span><button type="button" class="btn btn-primary btn-sm" data-act="multi-ok">' + (n ? 'Add ' + n + (n === 1 ? ' client' : ' clients') : 'Done') + '</button>';
            return;
        }
        const h = enterHint();
        foot.innerHTML = '<span class="pal-keys"><span><kbd>↑</kbd><kbd>↓</kbd> ' + (pal.expanded ? 'choose PIC' : 'select') + '</span>' + (h ? '<span><kbd>Enter</kbd> ' + P.esc(h) + '</span>' : '') + '</span>'
            + (P.isRestricted() ? '' : '<button type="button" class="pal-add" data-act="add">' + P.icon('plus', 14, '', 2.4) + 'Add entity</button>');
    }

    // Dipoll ringan selama palet terbuka - kalau jendelanya ditutup langsung (bukan lewat ikon X
    // di sini), baris "Sesi Aktif" ikut hilang tanpa perlu menutup-buka ulang palet.
    /** Jumlah klien BARU yang akan ditambahkan palet mode banyak klien (di luar yang sudah ada). */
    function newCount() { let n = 0; pal.checked.forEach((e, k) => { if (!P.multi.has(k)) n++; }); return n; }
    function toggleChecked(e) {
        if (e.project === 'manual' || (e.project === 'taxio_hub' && e.linked === false)) return;
        const k = keyOf(e);
        if (E.selected && keyOf(E.selected.entity) === k) return;
        if (pal.checked.has(k)) pal.checked.delete(k); else pal.checked.set(k, e);
        paintPalette();
    }
    function commitMulti() { P.multi.setExtras(Array.from(pal.checked.values())); E.closePalette(); }
    /** opts.multi: pilih beberapa klien (kotak centang per baris) untuk halaman Download; tanpa itu = memilih satu entitas. */
    E.openPalette = function (opts) {
        if (pal.open) return;
        pal.multi = !!(opts && opts.multi);
        pal.checked = new Map(pal.multi ? multiSeed() : []);
        pal.open = true; pal.q = ''; pal.hover = 0; pal.expanded = null; pal.picCursor = null;
        const scrim = document.createElement('div');
        scrim.className = 'scrim'; scrim.id = 'palette';
        scrim.innerHTML = '<div class="dialog' + (pal.multi ? ' pal-multi' : '') + '" role="dialog" aria-label="' + (pal.multi ? 'Add clients' : 'Select entity') + '">'
            + '<div class="pal-search">' + P.icon('search', 18, 'acc', 2.2) + '<input id="pal-q" type="text" placeholder="Search entity or NPWP…" autocomplete="off" aria-label="Search entity"><kbd>Esc</kbd></div>'
            + '<div class="pal-list" id="pal-body"></div><div class="pal-foot" id="pal-foot"></div></div>';
        document.body.appendChild(scrim);
        const input = P.$('pal-q');
        paintPalette(); input.focus();
        input.addEventListener('input', () => { pal.q = input.value; pal.hover = 0; pal.expanded = null; pal.picCursor = null; paintPalette(); });
        scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) E.closePalette(); });
        scrim.addEventListener('mouseover', (e) => { const row = e.target.closest('.ent'); if (row && row.dataset.idx !== undefined && Number(row.dataset.idx) >= 0 && Number(row.dataset.idx) !== pal.hover) { pal.hover = Number(row.dataset.idx); scrim.querySelectorAll('.ent.hover').forEach((n) => n.classList.remove('hover')); if (!row.classList.contains('unlinked')) row.classList.add('hover'); paintFoot(); } });
        scrim.addEventListener('click', async (e) => {
            const t = e.target.closest('[data-act]');
            if (!t) return;
            const act = t.dataset.act;
            const ent = t.dataset.key ? (findByKey(t.dataset.key) || (E.manualEntity() && L.entityKey(E.manualEntity()) === t.dataset.key ? E.manualEntity() : null)) : null;
            if (act === 'ent' && ent) { if (pal.multi) toggleChecked(ent); else activate(ent); }
            else if (act === 'multi-ok') commitMulti();
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
                    const at = pics.findIndex((p) => p.pic_id === pal.picCursor);
                    const idx = at < 0 ? (e.key === 'ArrowDown' ? 0 : pics.length - 1) : (e.key === 'ArrowDown' ? Math.min(pics.length - 1, at + 1) : Math.max(0, at - 1));
                    pal.picCursor = pics[idx].pic_id;
                    paintPalette();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const pic = pics.find((p) => p.pic_id === pal.picCursor);
                    if (!pic) return; // belum ada PIC yang dipilih: Enter tidak login
                    E.select(ent, pic.pic_id);
                    E.closePalette();
                    autoLoginAfterSelect();
                }
                return;
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); pal.hover = Math.min(palNav.length - 1, pal.hover + 1); paintPalette(); scrollHover(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); pal.hover = Math.max(0, pal.hover - 1); paintPalette(); scrollHover(); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (pal.multi) { if (!e.shiftKey && newCount()) commitMulti(); else if (palNav[pal.hover]) toggleChecked(palNav[pal.hover]); }
                else if (palNav[pal.hover]) activate(palNav[pal.hover]);
            }
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
            else { pal.expanded = key; pal.picCursor = null; }
            paintPalette();
            return;
        }
        E.select(e, (e.pics || []).length ? e.pics[0].pic_id : null);
        E.closePalette();
        autoLoginAfterSelect();
    }
    function useManualFor(e) {
        E.select({ project: 'manual', project_label: 'Manual', entity_id: 'MANUAL', entity_name: e.entity_name, npwp: e.npwp || '', individual: !!e.individual, pic_id: 'manual', pic_name: 'Manual login', pic_is_mine: true, pics: [], linked: true }, null);
    }
    // Dipakai tombol 👤 di topbar (sebelah tombol segarkan status) - beralih entitas yang SEDANG
    // dipilih ke sesi manual, membawa nama/NPWP-nya untuk konteks, tanpa kredensial tersimpan.
    E.useManualFor = useManualFor;
    async function deleteLocal(e) {
        if (!await P.confirmDialog({ title: 'Delete Entity', body: 'This removes the entity and its saved login from this computer only. Nothing changes in Coretax.', details: [['Entity', e.entity_name]], confirmLabel: 'Delete entity', danger: true })) return;
        try {
            await P.post('/api/local-entities/delete', { id: e.local_id });
            if (E.selected && L.entityKey(E.selected.entity) === L.entityKey(e)) E.clear();
            await E.load();
            paintPalette();
        } catch (err) { P.toast('Failed to delete: ' + err.message); }
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
        scrim.innerHTML = '<div class="dialog narrow" role="dialog" aria-label="' + (existing ? 'Edit entity' : 'Add entity') + '"></div>';
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
        const passHint = p.id ? 'Leave blank to keep unchanged' : 'Required';
        const passphraseHint = p.id ? 'Leave blank to keep unchanged' : 'Optional';
        return '<div class="pic-form-row">'
            + '<div class="row" style="justify-content:space-between"><b>PIC ' + (i + 1) + (i === 0 ? '<span class="tag auto" style="margin-left:8px">PRIMARY</span>' : '') + '</b>'
            + (dlg.pics.length > 1 ? '<button type="button" class="icon-btn" data-act="pic-remove" data-idx="' + i + '" aria-label="Remove this PIC">' + P.icon('trash', 15) + '</button>' : '<span></span>') + '</div>'
            + '<div class="field"><label>PIC name</label><input class="input sm" data-pic-field="name" data-idx="' + i + '" value="' + P.esc(p.name) + '" placeholder="e.g. Ani Sample Wijaya"></div>'
            + '<div class="field"><label>NPWP PIC</label><input class="input sm mono" data-pic-field="npwp" data-idx="' + i + '" value="' + P.esc(p.npwp) + '" placeholder="16 digits, no dots/dashes" maxlength="20" inputmode="numeric"></div>'
            + '<div class="field"><label>Coretax password</label><input class="input sm" type="password" data-pic-field="password" data-idx="' + i + '" value="' + P.esc(p.password) + '" placeholder="' + passHint + '" autocomplete="new-password"></div>'
            + '<div class="field"><label>Passphrase <span class="hint" style="font-weight:400">(optional)</span></label><input class="input sm" type="password" data-pic-field="passphrase" data-idx="' + i + '" value="' + P.esc(p.passphrase) + '" placeholder="' + passphraseHint + '" autocomplete="new-password"></div>'
            + '</div>';
    }
    function paintDialog() {
        const box = document.querySelector('#entity-dialog .dialog'); if (!box) return;
        const keep = document.activeElement && document.activeElement.id;
        const keepPicField = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.picField : null;
        const keepPicIdx = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.idx : null;
        const isBadan = dlg.type === 'badan';
        const passHint = dlg.id ? 'Leave blank to keep unchanged' : 'Required';
        const passphraseHint = dlg.id ? 'Leave blank to keep unchanged' : 'Optional';
        const opFields = '<div class="field"><label for="led-pass">Coretax password</label><input id="led-pass" class="input" type="password" value="' + P.esc(dlg.password) + '" placeholder="' + passHint + '" autocomplete="new-password"></div>'
            + '<div class="field"><label for="led-passphrase">Passphrase <span class="hint" style="font-weight:400">(optional)</span></label><input id="led-passphrase" class="input" type="password" value="' + P.esc(dlg.passphrase) + '" placeholder="' + passphraseHint + '" autocomplete="new-password"></div>';
        const badanFields = '<div class="field" style="gap:10px"><span class="label">PIC (individual account)<span class="req">REQUIRED, MORE THAN ONE ALLOWED</span></span>'
            + '<span class="hint">Coretax opens a corporate account through the individual account of the person in charge. When automation runs, the agent logs in as this PIC, then selects this entity.</span>'
            + '<div class="stack-lg">' + dlg.pics.map(picRowHtml).join('') + '</div>'
            + '<button type="button" class="pic-add" data-act="pic-add">' + P.icon('plus', 17, '', 2.2) + 'Add PIC</button></div>';
        box.innerHTML = '<div class="dialog-head"><h2>' + (dlg.id ? 'Edit entity' : 'Add entity') + '</h2><button type="button" class="icon-btn" aria-label="Close" data-act="close">' + P.icon('x', 18) + '</button></div>'
            + '<div class="dialog-body"><p class="hint" style="font-size:13.5px">Coretax credentials are stored on this computer only, and used for automatic login - just like Taxio Hub entities.</p>'
            + '<div class="field"><span class="label">Taxpayer type</span>' + P.seg('led-type', [{ value: 'badan', label: 'Corporate' }, { value: 'op', label: 'Individual' }], dlg.type)
            + '<span class="hint">' + (isBadan ? 'Logs in via the PIC account, then impersonates this entity.' : 'Logs in directly with this entity\'s own NPWP and password.') + '</span></div>'
            + '<div class="field"><label for="led-name">Entity name</label><input id="led-name" class="input" value="' + P.esc(dlg.name) + '" placeholder="' + (isBadan ? 'e.g. CV Contoh Makmur' : 'e.g. Budi Santoso') + '" maxlength="100"></div>'
            + '<div class="field"><label for="led-npwp">' + (isBadan ? 'Entity NPWP' : 'NPWP') + '</label><input id="led-npwp" class="input mono" value="' + P.esc(dlg.npwp) + '" placeholder="16 digits, no dots/dashes" maxlength="20" inputmode="numeric"></div>'
            + (isBadan ? badanFields : opFields)
            + '<div class="form-error" id="led-error">' + P.esc(dlg.error) + '</div></div>'
            + '<div class="dialog-foot"><span class="grow"></span><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn btn-primary" data-act="save"' + (dlg.busy ? ' disabled' : '') + '>' + (dlg.busy ? 'Saving…' : 'Save entity') + '</button></div>';
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
            if (!dlg.name.trim()) { dlg.error = 'Entity name is required.'; return paintDialog(); }
            const body = { id: dlg.id || undefined, name: dlg.name, npwp: dlg.npwp, type: dlg.type };
            if (dlg.type === 'op') { body.password = dlg.password; body.passphrase = dlg.passphrase; }
            else { body.pics = dlg.pics.map((p) => ({ id: p.id || undefined, name: p.name, npwp: p.npwp, password: p.password, passphrase: p.passphrase })); }
            dlg.busy = true; dlg.error = ''; paintDialog();
            try {
                const r = await P.post('/api/local-entities/save', body);
                closeDialog();
                await E.load();
                const saved = E.personal.find((x) => x.local_id === r.entity.local_id);
                if (saved) {
                    E.select(saved, null);
                    // Satu PIC = tidak ada yang perlu dipilih, langsung login otomatis seperti memilih dari palet.
                    // 2+ PIC: biarkan terpilih dulu; PIC dipilih lewat palet sebelum login.
                    if ((saved.pics || []).length <= 1) autoLoginAfterSelect();
                }
                P.info('Entity "' + r.entity.entity_name + '" saved.');
            } catch (err) { dlg.busy = false; dlg.error = err.message; paintDialog(); }
        }
    }

    // Ctrl+K atau Alt+K membuka palet dari mana saja di dalam aplikasi.
    document.addEventListener('keydown', (e) => {
        const combo = ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) || (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'k' || e.key === 'K'));
        if (combo && P.isConnected() && !P.$('palette')) { e.preventDefault(); E.openPalette(); }
    });
})();
