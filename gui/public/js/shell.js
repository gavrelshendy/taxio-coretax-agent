/* Taxio Pilot - kerangka aplikasi: sidebar, topbar, pergantian antara layar masuk / halaman fitur /
   tampilan proses, pengaturan, login manual, dan proses boot. */
(function () {
    'use strict';
    const P = window.Pilot;
    const L = P.L;
    const E = P.ent;
    const esc = P.esc;
    const S = P.shell = {};
    let view = '';          // 'auth' | 'app'
    let mode = '';          // 'run' | 'page:<id>'
    let sessionSig = '';

    // ---------- Login manual ----------
    P.manual = {
        async open() {
            try { await P.post('/api/actions/open-coretax'); P.manual.poll(); }
            catch (e) { alert('Gagal membuka Coretax: ' + e.message); }
        },
        async check(announce) {
            await P.manual.poll();
            if (!announce) return;
            const m = P.state.manual;
            if (!m.loggedIn) P.info('Belum terdeteksi login. Pastikan sudah masuk ke Coretax di jendela yang terbuka, lalu periksa lagi.');
            else P.info('Sedang login di Coretax sebagai: ' + (m.identity || '(tidak terbaca)'));
        },
        async poll() {
            if (!P.isConnected() || P.isRestricted()) return;
            let st; try { st = await P.api('/api/manual/status'); } catch (e) { return; }
            const a = P.state.manual;
            if (a.open !== st.open || a.loggedIn !== st.loggedIn || a.identity !== st.identity) { P.state.manual = st; P.emit('manual'); }
        }
    };
    async function pollLogin() {
        try { const st = await P.api('/api/login/status'); if (st && st.at && (!P.state.lastLogin || P.state.lastLogin.at !== st.at)) { P.state.lastLogin = st; P.emit('login'); } } catch (e) { /* diabaikan */ }
    }

    // ---------- Segarkan status sesi (tombol di sebelah pill topbar) ----------
    // Beda dari lib/login-status.js (histori "terakhir dikonfirmasi login sebagai X" yang
    // ditulis server setiap aksi) - ini membaca ULANG jendela Chrome yang sedang terbuka SEKARANG
    // lewat /api/session/status, supaya pengguna bisa mengecek kapan saja siapa yang aktif tanpa
    // menunggu unduhan berikutnya. Sesi manual (POLOS) sudah punya jalur sendiri (P.manual.check).
    P.session = {
        async refresh() {
            const ent = E.current();
            if (!ent) return;
            if (L.isManualLike(ent)) return P.manual.check(true);
            if (!ent.pic_id || ent.pic_id === 'unlinked') return P.info('Entitas ini belum tertaut PIC Coretax.');
            try {
                const st = await P.post('/api/session/status', { picId: ent.pic_id });
                if (!st.open) P.info('Belum ada jendela Coretax terbuka untuk entitas ini. Klik "Masuk Coretax" dulu.');
                else if (!st.loggedIn) P.info('Jendela Coretax terbuka tapi belum login (masih di halaman masuk).');
                else P.info('Sedang login di Coretax sebagai: ' + (st.identity || '(tidak terbaca)'));
            } catch (e) { P.info('Gagal memeriksa sesi: ' + e.message); }
        }
    };

    // ---------- Kerangka ----------
    function roleLabel() {
        const h = P.hub(); const r = String(h.role || '').toLowerCase();
        if (r.includes('restricted')) return 'Restricted Editor';
        return r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Anggota';
    }
    function sidebarHtml() {
        const cur = P.state.page;
        const groups = P.pages.NAV.map((g) => '<div class="nav-group"><div class="nav-title">' + g.title + '</div>' + g.items.filter((it) => !(it.hideForRestricted && P.isRestricted())).map((it) =>
            '<button type="button" class="nav-item" data-nav="' + it.id + '"' + (it.id === cur ? ' aria-current="page"' : '') + '>' + P.icon(it.icon, 18) + '<span class="grow">' + esc(it.label) + '</span>' + (it.badge ? '<span class="nav-badge">' + it.badge + '</span>' : '') + '</button>').join('') + '</div>').join('');
        const email = P.hub().email || '';
        return '<aside class="sidebar"><div class="brand"><div class="brand-logo"><img src="/assets/taxio-pilot-logo.png" alt="Taxio Pilot"></div><div class="brand-name"><b>Taxio Pilot</b><span id="ver-badge">' + esc(P.state.version ? 'v' + P.state.version.version : '') + '</span></div></div>'
            + groups + '<div class="spacer"></div><div class="stack" style="gap:6px"><button type="button" class="nav-item" id="open-settings">' + P.icon('gear', 18) + '<span class="grow">Pengaturan</span></button>'
            + '<div class="userbox"><span class="avatar">' + esc((email[0] || 'T').toUpperCase() + ((email.split('@')[0] || '')[1] || '').toUpperCase()) + '</span><div class="who"><b title="' + esc(email) + '">' + esc(email || 'Taxio Hub') + '</b><span><i class="dot"></i>Terhubung · ' + esc(roleLabel()) + '</span></div></div></div></aside>';
    }
    function topbarHtml() {
        const meta = P.pages.meta(P.state.page) || { label: '', crumb: '' };
        const ent = E.current();
        const pill = L.loginPill({ runActive: P.state.run.active, entity: ent, manual: P.state.manual, last: P.state.lastLogin });
        const busy = P.state.run.active;
        let buttons = '';
        if (ent && L.isManualLike(ent)) {
            buttons = '<button type="button" class="btn" id="btn-open-coretax"' + (busy ? ' disabled' : '') + '>' + P.icon('globe', 17) + 'Buka Coretax</button><button type="button" class="btn" id="btn-check-session" style="background:var(--surface-2)">' + P.icon('shield', 17) + 'Periksa sesi</button>';
        } else if (ent) {
            buttons = '<button type="button" class="icon-btn" id="btn-refresh-session" title="Cek ulang siapa yang sedang login di Coretax sekarang" aria-label="Segarkan status sesi">' + P.icon('retry', 16) + '</button>'
                + (P.isRestricted() ? '' : '<button type="button" class="icon-btn" id="btn-manual-for-entity" title="Login manual untuk entitas ini - Anda ketik sandi Coretax sendiri, tanpa memakai kredensial tersimpan" aria-label="Login manual untuk entitas ini"' + (busy ? ' disabled' : '') + '>' + P.icon('user', 16) + '</button>')
                + '<button type="button" class="btn" id="btn-login"' + (busy ? ' disabled' : '') + ' title="Login dan impersonate entitas ini, tanpa mengisi form">' + P.icon('globe', 17) + 'Masuk Coretax</button>';
        } else if (!P.isRestricted()) {
            buttons = '<button type="button" class="btn" id="btn-open-coretax"' + (busy ? ' disabled' : '') + '>' + P.icon('globe', 17) + 'Buka Coretax</button>';
        }
        return '<header class="topbar"><div class="title"><span class="crumb">' + esc(meta.crumb) + '</span><h1>' + esc(meta.label) + '</h1></div><span class="status-pill ' + pill.kind + '"><i></i>' + esc(pill.text) + '</span>' + E.chipHtml() + buttons + '</header>';
    }
    function appHtml() {
        return sidebarHtml() + '<div class="main"><div class="outdated" id="outdated" hidden><span id="outdated-text"></span> <button type="button" class="btn btn-sm" id="outdated-check">Periksa Pembaruan</button></div><div id="topbar-slot">' + topbarHtml() + '</div><div class="content" id="content"></div>' + P.dock.html() + '</div>';
    }

    S.renderTopbar = function () { const s = P.$('topbar-slot'); if (s) s.innerHTML = topbarHtml(); };
    function renderSidebar() { const app = P.$('app'); const old = app && app.querySelector('.sidebar'); if (old) { const tmp = document.createElement('div'); tmp.innerHTML = sidebarHtml(); old.replaceWith(tmp.firstElementChild); } }

    /** Isi area konten: tampilan proses bila ada proses berjalan, kalau tidak halaman fitur. */
    S.renderContent = function (force) {
        const content = P.$('content'); if (!content) return;
        const run = P.state.run;
        const want = run.active ? 'run' : 'page:' + P.state.page;
        const fresh = document.createElement('div');
        if (run.active) {
            const top = content.scrollTop;
            fresh.innerHTML = P.run.viewHtml(run);
            content.replaceChildren(fresh);
            P.run.bindView(fresh);
            content.scrollTop = want === mode ? top : 0;
        } else if (force || want !== mode) {
            content.replaceChildren(fresh);
            P.pages.get(P.state.page).mount(fresh);
            content.scrollTop = 0;
        } else {
            P.pages.get(P.state.page).refresh();
        }
        mode = want;
    };
    S.go = function (id) {
        if (!P.pages.get(id)) return;
        if (id === 'a1' && P.isRestricted()) return;
        P.state.page = id; P.store.set('page', id);
        renderSidebar(); S.renderTopbar(); S.renderContent(true);
    };

    // ---------- Pengaturan ----------
    function openSettings() {
        const h = P.hub(); const v = P.state.version || {};
        const scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.id = 'settings';
        scrim.innerHTML = '<div class="dialog narrow" role="dialog" aria-label="Pengaturan"><div class="dialog-head"><h2>Pengaturan</h2><button type="button" class="icon-btn" aria-label="Tutup" data-x="close">' + P.icon('x', 18) + '</button></div>'
            + '<div class="dialog-body"><div class="stack"><div class="eyebrow">Akun</div><div class="doc-row"><span class="ico">' + P.icon('user', 18) + '</span><div class="t"><b>' + esc(h.email || '') + '</b><span>Taxio Hub · ' + esc(roleLabel()) + '</span></div><button type="button" class="btn btn-sm" data-x="disconnect">Putuskan</button></div></div>'
            + '<div class="stack"><div class="eyebrow">Versi aplikasi</div><div class="row" style="justify-content:space-between"><div><b style="color:var(--ink)">Taxio Pilot ' + esc(v.version ? 'v' + v.version : '') + '</b><div class="hint" id="upd-text"></div></div><button type="button" class="btn btn-sm" id="upd-check" data-x="update">Periksa pembaruan</button></div></div></div>'
            + '<div class="dialog-foot"><button type="button" class="btn btn-danger" data-x="quit">' + P.icon('power', 16) + 'Tutup aplikasi</button><span class="grow"></span><button type="button" class="btn" data-x="close">Selesai</button></div></div>';
        document.body.appendChild(scrim);
        const onKey = (e) => { if (e.key === 'Escape') closeIt(); };
        const closeIt = () => { document.removeEventListener('keydown', onKey); scrim.remove(); };
        document.addEventListener('keydown', onKey);
        scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeIt(); });
        scrim.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-x]'); if (!b) return;
            const x = b.dataset.x;
            if (x === 'close') closeIt();
            else if (x === 'disconnect') { closeIt(); P.state.session = await P.post('/api/disconnect', { project: 'taxio_hub' }); E.clear(); P.auth.screen = 'masuk'; P.emit('session'); }
            else if (x === 'quit') { if (confirm('Tutup Taxio Pilot sepenuhnya?')) await P.post('/api/quit'); }
            else if (x === 'update') {
                const t = P.$('upd-text'); b.disabled = true; t.textContent = 'Mengecek pembaruan…';
                try {
                    const info = await P.post('/api/check-update');
                    t.textContent = info.available ? 'Pembaruan v' + info.version + ' ditemukan. Mengunduh dan memasang; aplikasi akan tertutup dan terbuka ulang otomatis…' : 'Sudah versi terbaru.';
                    if (!info.available) b.disabled = false;
                } catch (err) { t.textContent = 'Gagal cek pembaruan: ' + err.message; b.disabled = false; }
            }
        });
    }

    // Sesi Coretax aktif kini digabung ke dalam palet entitas (Ctrl+K/Alt+K) sendiri, bukan
    // dropdown/dialog terpisah - lihat entities.js (bodyHtml/sessionRowHtml/refreshSessions).

    // ---------- Tampilan tingkat atas ----------
    function showAuth() {
        view = 'auth'; mode = '';
        const root = P.$('root');
        root.innerHTML = '<div id="auth"></div>';
        const a = P.$('auth'); a.innerHTML = P.auth.html(); P.auth.bind(a);
    }
    function showApp() {
        view = 'app'; mode = '';
        const root = P.$('root');
        root.innerHTML = '<div id="app">' + appHtml() + '</div>';
        P.dock.bind(); P.dock.restore();
        bindApp();
        updateOutdated();
        S.renderContent(true);
    }
    function bindApp() {
        const app = P.$('app');
        app.addEventListener('click', (e) => {
            const nav = e.target.closest('[data-nav]'); if (nav) return S.go(nav.dataset.nav);
            if (e.target.closest('#entity-chip')) return E.openPalette();
            if (e.target.closest('#open-settings')) return openSettings();
            if (e.target.closest('#btn-open-coretax')) return P.manual.open();
            if (e.target.closest('#btn-check-session')) return P.manual.check(true);
            if (e.target.closest('#btn-refresh-session')) return P.session.refresh();
            if (e.target.closest('#btn-manual-for-entity')) { const cur = E.current(); return cur && E.useManualFor(cur); }
            if (e.target.closest('#btn-login')) return loginEntity(e.target.closest('#btn-login'));
            if (e.target.closest('#outdated-check')) return checkUpdateFromBanner();
        });
    }
    async function loginEntity(btn) {
        const ent = E.current(); if (!ent) return;
        btn.disabled = true;
        try { await P.post('/api/actions/login-entity', { entity: ent }); P.run.poll(); }
        catch (e) { alert('Gagal memulai login: ' + e.message); btn.disabled = false; }
    }
    async function checkUpdateFromBanner() {
        const t = P.$('outdated-text'); const b = P.$('outdated-check'); b.disabled = true; t.textContent = 'Mengecek pembaruan…';
        try { const info = await P.post('/api/check-update'); t.textContent = info.available ? 'Pembaruan v' + info.version + ' ditemukan. Mengunduh dan memasang; aplikasi akan tertutup dan terbuka ulang otomatis…' : 'Sudah versi terbaru. Coba lagi sebentar lagi.'; }
        catch (e) { t.textContent = 'Gagal cek pembaruan: ' + e.message; }
        b.disabled = false;
    }
    function updateOutdated() {
        const v = P.state.version; const el = P.$('outdated'); if (!el) return;
        if (v && v.outdated) { el.hidden = false; P.$('outdated-text').textContent = 'Versi ini (v' + v.version + ') sudah usang. v' + v.latestVersion + ' tersedia. Aksi baru diblokir sampai diperbarui.'; }
    }

    /** Menentukan layar dari status sesi, dan memuat entitas saat baru saja terhubung. */
    async function onSession() {
        const connected = P.isConnected();
        const sig = JSON.stringify([connected, P.hub().email, P.hub().role, P.hub().pending]);
        if (sig === sessionSig && view) return;
        const wasConnected = view === 'app';
        sessionSig = sig;
        P.auth.sync();
        if (!connected) { E.clear && (E.selected = null); E.group = []; E.personal = []; showAuth(); return; }
        if (!wasConnected) { P.state.page = P.store.get('page', 'spt'); if (P.state.page === 'a1' && P.isRestricted()) P.state.page = 'spt'; showApp(); }
        else { renderSidebar(); S.renderTopbar(); }
        await E.load();
        P.manual.poll();
    }
    P.on('session', onSession);
    P.on('entities', () => { if (view === 'app') { S.renderTopbar(); S.renderContent(false); } });
    P.on('entity', () => { if (view === 'app') { S.renderTopbar(); S.renderContent(false); } });
    P.on('login', () => { if (view === 'app') S.renderTopbar(); });
    P.on('manual', () => { if (view === 'app') { S.renderTopbar(); if (!P.state.run.active) S.renderContent(false); } });
    P.on('run', (st) => {
        if (view !== 'app') return;
        S.renderTopbar();
        const running = !!st.active;
        // Saat proses baru berjalan atau baru selesai, ganti isi konten; selama berjalan cukup segarkan tampilannya.
        S.renderContent(!running && mode === 'run');
    });

    // ---------- Boot ----------
    S.boot = async function () {
        P.run.connectEvents();
        try { P.state.version = await P.api('/api/version'); } catch (e) { /* offline */ }
        try { P.state.session = await P.api('/api/session'); } catch (e) { /* biarkan bawaan */ }
        await onSession();
        if (!view) showAuth();
        P.run.startPolling();
        setInterval(P.manual.poll, 2000);
        setInterval(pollLogin, 3000);
        pollLogin();
    };
    document.addEventListener('DOMContentLoaded', S.boot);
})();
