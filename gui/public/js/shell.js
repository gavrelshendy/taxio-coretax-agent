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
            catch (e) { alert('Failed to open Coretax: ' + e.message); }
        },
        async check(announce) {
            await P.manual.poll();
            if (!announce) return;
            const m = P.state.manual;
            if (!m.loggedIn) P.info('No login detected yet. Make sure you have signed in to Coretax in the open window, then check again.');
            else P.info('Signed in to Coretax as: ' + (m.identity || '(unreadable)'));
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

    // ---------- Sesi Coretax aktif (badge "+N sesi lain" di topbar) ----------
    // Daftar lengkapnya sendiri dirender di dalam palet entitas (entities.js) saat dibuka - ini
    // hanya polling ambient supaya topbar bisa menunjukkan ADA sesi lain terbuka tanpa harus
    // membuka palet dulu (kekhawatiran: entity chip cuma menonjolkan satu nama, seolah cuma itu
    // satu-satunya sesi yang aktif padahal bisa ada beberapa jendela Chrome PIC lain terbuka).
    // Pilihan entitas dilepas otomatis begitu jendela sesinya HILANG (ditutup) - tapi hanya setelah
    // sesi itu pernah terlihat, supaya jeda antara memilih entitas dan jendela login-nya muncul
    // tidak dianggap "sesi hilang".
    let seenSel = { key: '', seen: false };
    function releaseIfSessionGone(list) {
        const cur = E.current();
        if (!cur || !cur.pic_id) { seenSel = { key: '', seen: false }; return; }
        // Pilihan hasil pemulihan (aplikasi baru dibuka): pertahankan hanya bila jendela sesinya masih
        // terbuka; kalau tidak, lepas sekarang. Sesudah itu diperlakukan seperti pilihan biasa.
        if (E.selected && E.selected.restored) {
            if (list.some((s) => s.picId === cur.pic_id)) { E.selected.restored = false; }
            else if (!P.state.run.active) { seenSel = { key: '', seen: false }; E.clear(); return; }
        }
        const key = cur.project + '|' + cur.entity_id + '|' + cur.pic_id;
        if (seenSel.key !== key) seenSel = { key, seen: false };
        if (list.some((s) => s.picId === cur.pic_id)) seenSel.seen = true;
        else if (seenSel.seen && !P.state.run.active) { seenSel = { key: '', seen: false }; E.clear(); }
    }
    async function pollSessions() {
        let list;
        try { list = ((await P.api('/api/sessions/list')) || {}).sessions || []; } catch (e) { return; }
        if (JSON.stringify(list) !== JSON.stringify(P.state.sessions)) { P.state.sessions = list; P.emit('sessions'); }
        releaseIfSessionGone(list);
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
            if (!ent.pic_id || ent.pic_id === 'unlinked') return P.info('This entity is not linked to a Coretax PIC yet.');
            try {
                const st = await P.post('/api/session/status', { picId: ent.pic_id });
                if (!st.open) P.info('No Coretax window is open for this entity yet. Click "Sign in to Coretax" first.');
                else if (!st.loggedIn) P.info('The Coretax window is open but not signed in (still on the login page).');
                else P.info('Signed in to Coretax as: ' + (st.identity || '(unreadable)'));
            } catch (e) { P.info('Failed to check session: ' + e.message); }
        }
    };

    // ---------- Kerangka ----------
    function roleLabel() {
        const h = P.hub(); const r = String(h.role || '').toLowerCase();
        if (r.includes('restricted')) return 'Restricted Editor';
        return r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Member';
    }
    function sidebarHtml() {
        const cur = P.state.page;
        const groups = P.pages.NAV.map((g) => '<div class="nav-group"><div class="nav-title">' + g.title + '</div>' + g.items.filter((it) => !(it.hideForRestricted && P.isRestricted())).map((it) =>
            '<button type="button" class="nav-item" data-nav="' + it.id + '" title="' + esc(it.full || it.label) + '"' + (it.id === cur ? ' aria-current="page"' : '') + '>' + P.icon(it.icon, 18) + '<span class="grow">' + esc(it.label) + '</span>' + (it.badge ? '<span class="nav-badge">' + it.badge + '</span>' : '') + '</button>').join('') + '</div>').join('');
        const email = P.hub().email || '';
        return '<aside class="sidebar"><div class="brand"><div class="brand-logo"><img src="/assets/taxio-pilot-logo.png" alt="Taxio Pilot"></div><div class="brand-name"><b>Taxio Pilot</b><span id="ver-badge">' + esc(P.state.version ? 'v' + P.state.version.version : '') + '</span></div></div>'
            + groups + '<div class="spacer"></div><div class="stack" style="gap:6px"><button type="button" class="nav-item" id="open-settings">' + P.icon('gear', 18) + '<span class="grow">Settings</span></button>'
            + '<div class="userbox"><span class="avatar">' + esc((email[0] || 'T').toUpperCase() + ((email.split('@')[0] || '')[1] || '').toUpperCase()) + '</span><div class="who"><b title="' + esc(email) + '">' + esc(email || 'Taxio Hub') + '</b><span><i class="dot"></i>Connected · ' + esc(roleLabel()) + '</span></div></div></div></aside>';
    }
    function topbarHtml() {
        const meta = P.pages.meta(P.state.page) || { label: '', crumb: '' };
        const ent = E.current();
        const pill = L.loginPill({ runActive: P.state.run.active, entity: ent, manual: P.state.manual, last: P.state.lastLogin });
        const busy = P.state.run.active;
        let buttons = '';
        if (ent && L.isManualLike(ent)) {
            buttons = '<button type="button" class="btn" id="btn-open-coretax"' + (busy ? ' disabled' : '') + '>' + P.icon('globe', 17) + 'Open Coretax</button><button type="button" class="btn" id="btn-check-session" style="background:var(--surface-2)">' + P.icon('shield', 17) + 'Check session</button>';
        } else if (ent) {
            buttons = '<button type="button" class="icon-btn" id="btn-refresh-session" title="Re-check who is signed in to Coretax right now" aria-label="Refresh session status">' + P.icon('retry', 16) + '</button>'
                + (P.isRestricted() ? '' : '<button type="button" class="icon-btn" id="btn-manual-for-entity" title="Manual login for this entity - you type the Coretax password yourself, without using saved credentials" aria-label="Manual login for this entity"' + (busy ? ' disabled' : '') + '>' + P.icon('user', 16) + '</button>')
                + '<button type="button" class="btn" id="btn-login"' + (busy ? ' disabled' : '') + ' title="Log in and impersonate this entity, without filling any form">' + P.icon('globe', 17) + 'Sign in to Coretax</button>';
        } else if (!P.isRestricted()) {
            buttons = '<button type="button" class="btn" id="btn-open-coretax"' + (busy ? ' disabled' : '') + '>' + P.icon('globe', 17) + 'Open Coretax</button>';
        }
        return '<header class="topbar"><div class="title"><span class="crumb">' + esc(meta.crumb) + '</span><h1>' + esc(meta.full || meta.label) + '</h1></div><span class="status-pill ' + pill.kind + '"><i></i>' + esc(pill.text) + '</span>' + E.chipHtml() + buttons + E.sessionStripHtml() + '</header>';
    }
    function appHtml() {
        return sidebarHtml() + '<div class="main"><div class="outdated" id="outdated" hidden><span id="outdated-text"></span> <button type="button" class="btn btn-sm" id="outdated-check">Check for updates</button></div><div id="topbar-slot">' + topbarHtml() + '</div><div class="content" id="content"></div>' + P.dock.html() + '</div>';
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
        scrim.innerHTML = '<div class="dialog narrow" role="dialog" aria-label="Settings"><div class="dialog-head"><h2>Settings</h2><button type="button" class="icon-btn" aria-label="Close" data-x="close">' + P.icon('x', 18) + '</button></div>'
            + '<div class="dialog-body"><div class="stack"><div class="eyebrow">Account</div><div class="doc-row"><span class="ico">' + P.icon('user', 18) + '</span><div class="t"><b>' + esc(h.email || '') + '</b><span>Taxio Hub · ' + esc(roleLabel()) + '</span></div><button type="button" class="btn btn-sm" data-x="disconnect">Disconnect</button></div></div>'
            + '<div class="stack"><div class="eyebrow">App version</div><div class="row" style="justify-content:space-between"><div><b style="color:var(--ink)">Taxio Pilot ' + esc(v.version ? 'v' + v.version : '') + '</b><div class="hint" id="upd-text"></div></div><button type="button" class="btn btn-sm" id="upd-check" data-x="update">Check for updates</button></div></div>'
            + rollbackHtml(v) + healthSectionHtml() + profilesSectionHtml() + '</div>'
            + '<div class="dialog-foot"><button type="button" class="btn btn-danger" data-x="quit">' + P.icon('power', 16) + 'Quit app</button><span class="grow"></span><button type="button" class="btn" data-x="close">Done</button></div></div>';
        document.body.appendChild(scrim);
        loadHealth(false);
        const onKey = (e) => { if (e.key === 'Escape') closeIt(); };
        const closeIt = () => { document.removeEventListener('keydown', onKey); scrim.remove(); };
        document.addEventListener('keydown', onKey);
        scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeIt(); });
        scrim.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-x]'); if (!b) return;
            const x = b.dataset.x;
            if (x === 'close') closeIt();
            else if (x === 'disconnect') { closeIt(); P.state.session = await P.post('/api/disconnect', { project: 'taxio_hub' }); E.clear(); P.auth.screen = 'masuk'; P.emit('session'); }
            else if (x === 'quit') { if (confirm('Quit Taxio Pilot completely?')) await P.post('/api/quit'); }
            else if (x === 'update') {
                const t = P.$('upd-text'); b.disabled = true; t.textContent = 'Checking for updates…';
                try {
                    const info = await P.post('/api/check-update');
                    t.textContent = info.available ? 'Update v' + info.version + ' found. Downloading and installing; the app will close and reopen automatically…' : 'You are on the latest version.';
                    if (!info.available) b.disabled = false;
                } catch (err) { t.textContent = 'Failed to check for updates: ' + err.message; b.disabled = false; }
            }
            else if (x === 'health') { b.disabled = true; await loadHealth(true); b.disabled = false; }
            else if (x === 'prof-list') { b.disabled = true; await loadStaleProfiles(); b.disabled = false; }
            else if (x === 'prof-delete') { b.disabled = true; await deleteStaleProfiles(); b.disabled = false; }
            else if (x === 'diag') {
                const t = P.$('diag-text'); b.disabled = true; t.textContent = 'Preparing the diagnostics file…';
                try {
                    const r = await P.post('/api/diagnostics/export');
                    t.textContent = 'Saved: ' + r.file + ' — check its contents first; the log may contain entity names and NPWPs. Send it only to people you trust.';
                } catch (err) { t.textContent = 'Failed to export diagnostics: ' + err.message; }
                b.disabled = false;
            }
        });
    }

    // ---------- Kembali ke versi 3 (README "Kembali ke versi 3") ----------
    // Hanya petunjuk - tidak ada downgrade otomatis. Path exe lama dicatat saat serah-terima
    // (lib/legacy-handover.js); selain itu tautan ke rilis v3 terakhir.
    function rollbackHtml(v) {
        const rb = v.rollback; if (!rb || !rb.v3Version) return '';
        const where = rb.legacyExe && rb.legacyExeExists
            ? 'open the old <b>coretax-agent.exe</b> at <code class="mono" id="rollback-exe">' + esc(rb.legacyExe) + '</code>'
            : 'open your old <b>coretax-agent.exe</b>' + (rb.legacyExe ? ' (it used to be at <code class="mono">' + esc(rb.legacyExe) + '</code>)' : '') + ', or download it again from <a href="' + esc(rb.v3ReleaseUrl) + '" target="_blank" rel="noopener">the v' + esc(rb.v3Version) + ' release</a>';
        return '<div class="stack" id="rollback"><div class="eyebrow">Back to version 3</div><div class="hint">To go back to v' + esc(rb.v3Version) + ': click <b>Quit app</b> below first (never run both at once), then ' + where
            + '. Version 3 keeps its own data; each PIC logs in to Coretax once more there, and you may have to sign in to Taxio Hub again. Opening Taxio Pilot later brings you back to this version.</div></div>';
    }

    // ---------- Pemeriksaan sistem (GET /api/health, lib/doctor.js) ----------
    const HEALTH_LABEL = { ok: 'OK', warn: 'Warning', fail: 'Failed' };
    function healthSectionHtml() {
        return '<div class="stack"><div class="row" style="justify-content:space-between;flex-wrap:wrap"><div class="eyebrow">System check</div>'
            + '<div class="row" style="gap:8px"><button type="button" class="btn btn-sm" data-x="health">Check again</button><button type="button" class="btn btn-sm" data-x="diag">' + P.icon('download', 15) + 'Export diagnostics</button></div></div>'
            + '<div class="health-list" id="health-list" aria-live="polite"><div class="health-empty">Checking…</div></div>'
            + '<div class="hint" id="diag-text">Export diagnostics saves a zip file in your Downloads folder: the check results, version, folder locations and recent log, without login sessions, passwords, passphrases or tokens. The log may contain entity names and NPWPs, so decide yourself who the file is sent to.</div></div>';
    }
    function healthRowsHtml(rep) {
        return (rep.checks || []).map((c) => '<div class="health-row ' + esc(c.status) + '"><span class="health-dot" aria-hidden="true"></span>'
            + '<div class="t"><b>' + esc(c.label) + '</b><span>' + esc(c.detail) + '</span>' + (c.fix && c.status !== 'ok' ? '<span class="fix">' + esc(c.fix) + '</span>' : '') + '</div>'
            + '<span class="health-st">' + esc(HEALTH_LABEL[c.status] || c.status) + '</span></div>').join('');
    }
    async function loadHealth(fresh) {
        const box = P.$('health-list'); if (!box) return;
        if (fresh) box.innerHTML = '<div class="health-empty">Checking…</div>';
        try {
            const rep = await P.api('/api/health' + (fresh ? '?fresh=1' : ''));
            const el = P.$('health-list'); if (el) el.innerHTML = healthRowsHtml(rep);
        } catch (e) {
            const el = P.$('health-list'); if (el) el.innerHTML = '<div class="health-empty">System check failed: ' + esc(e.message) + '</div>';
        }
    }

    // ---------- Bersihkan profil Chrome yang lama (POST /api/profiles/stale|delete, lib/profile-housekeeping.js) ----------
    const fmtBytes = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round((b || 0) / 1048576) + ' MB');
    function profilesSectionHtml() {
        return '<div class="stack" id="prof-section"><div class="row" style="justify-content:space-between;flex-wrap:wrap"><div class="eyebrow">Chrome Profiles</div>'
            + '<div class="row" style="gap:8px"><label class="hint" for="prof-days">Unused for</label><input class="input sm" id="prof-days" type="number" min="1" value="60" style="width:72px"><span class="hint">days</span>'
            + '<button type="button" class="btn btn-sm" data-x="prof-list">Clean up old Chrome profiles</button></div></div>'
            + '<div class="health-list" id="prof-list" aria-live="polite"></div>'
            + '<div class="hint" id="prof-text">Each PIC has its own Chrome profile. Deleting the profile of a PIC you have not used for a while only means that PIC signs in again automatically the next time it is used. Profiles whose window is currently open are never deleted.</div></div>';
    }
    let staleDays = 60;
    async function loadStaleProfiles() {
        const box = P.$('prof-list'); if (!box) return;
        staleDays = Math.max(1, Number((P.$('prof-days') || {}).value) || 60);
        box.innerHTML = '<div class="health-empty">Counting profiles…</div>';
        try {
            const r = await P.post('/api/profiles/stale', { days: staleDays });
            const rows = r.profiles.map((p) => '<label class="health-row ' + (p.inUse ? 'warn' : 'ok') + '"><input type="checkbox" data-prof="' + esc(p.dir) + '"' + (p.inUse ? ' disabled' : ' checked') + '>'
                + '<div class="t"><b>' + esc(p.name) + '</b><span>' + esc(p.kind) + ' · last used ' + p.ageDays + ' days ago · ' + fmtBytes(p.bytes) + (p.partial ? '+' : '') + (p.inUse ? ' · currently open, cannot be deleted' : '') + '</span></div></label>').join('');
            box.innerHTML = (rows || '<div class="health-empty">No profiles unused for ' + staleDays + ' days or more.</div>')
                + '<div class="hint">' + r.count + (r.count === 1 ? ' profile, total ' : ' profiles, total ') + fmtBytes(r.totalBytes) + (r.partial ? '+' : '') + '.</div>'
                + (rows ? '<button type="button" class="btn btn-sm btn-danger" data-x="prof-delete">Delete selected profiles</button>' : '');
        } catch (e) { box.innerHTML = '<div class="health-empty">Could not read profiles: ' + esc(e.message) + '</div>'; }
    }
    async function deleteStaleProfiles() {
        const dirs = Array.from(document.querySelectorAll('#prof-list input[data-prof]:checked')).map((i) => i.dataset.prof);
        if (!dirs.length) return P.info('Select at least one profile.');
        if (!confirm('Delete ' + dirs.length + ' Chrome profile' + (dirs.length === 1 ? '' : 's') + '? The PICs will sign in automatically again the next time they are used.')) return;
        try {
            const r = await P.post('/api/profiles/delete', { days: staleDays, dirs });
            P.info(r.deleted.length + ' profile' + (r.deleted.length === 1 ? '' : 's') + ' deleted (' + fmtBytes(r.freedBytes) + ' freed)' + (r.skipped.length ? ', ' + r.skipped.length + ' skipped.' : '.'));
        } catch (e) { alert('Could not delete profiles: ' + e.message); }
        await loadStaleProfiles();
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
            const sr = e.target.closest('[data-sess-relogin]'); if (sr) return E.reloginSession(sr.dataset.sessRelogin, sr);
            const sm = e.target.closest('[data-sess]'); if (sm) return E.selectSession(sm.dataset.sess);
            const sd = e.target.closest('[data-sess-drop]'); if (sd) return E.openSessionPopover(sd.dataset.sessDrop, sd);
            const sc = e.target.closest('[data-sess-close]'); if (sc) return closeSession(sc.dataset.sessClose, sc);
            if (e.target.closest('#sess-new')) return E.openPalette();
            if (e.target.closest('#open-settings')) return openSettings();
            if (e.target.closest('#btn-open-coretax')) return P.manual.open();
            if (e.target.closest('#btn-check-session')) return P.manual.check(true);
            if (e.target.closest('#btn-refresh-session')) return P.session.refresh();
            if (e.target.closest('#btn-manual-for-entity')) { const cur = E.current(); return cur && E.useManualFor(cur); }
            if (e.target.closest('#btn-login')) return loginEntity(e.target.closest('#btn-login'));
            if (e.target.closest('#outdated-check')) return checkUpdateFromBanner();
        });
    }
    async function closeSession(picId, btn) {
        btn.disabled = true;
        try { await P.post('/api/sessions/close', { picId }); } catch (e) { /* jendela mungkin sudah tertutup */ }
        pollSessions();
    }
    async function loginEntity(btn) {
        const ent = E.current(); if (!ent) return;
        btn.disabled = true;
        try { await P.post('/api/actions/login-entity', { entity: ent }); P.run.poll(); }
        catch (e) { alert('Failed to start login: ' + e.message); btn.disabled = false; }
    }
    async function checkUpdateFromBanner() {
        const t = P.$('outdated-text'); const b = P.$('outdated-check'); b.disabled = true; t.textContent = 'Checking for updates…';
        try { const info = await P.post('/api/check-update'); t.textContent = info.available ? 'Update v' + info.version + ' found. Downloading and installing; the app will close and reopen automatically…' : 'You are on the latest version. Try again shortly.'; }
        catch (e) { t.textContent = 'Failed to check for updates: ' + e.message; }
        b.disabled = false;
    }
    function updateOutdated() {
        const v = P.state.version; const el = P.$('outdated'); if (!el) return;
        if (v && v.outdated) { el.hidden = false; P.$('outdated-text').textContent = 'This version (v' + v.version + ') is outdated. v' + v.latestVersion + ' is available. New actions are blocked until you update.'; }
    }

    /** Menentukan layar dari status sesi, dan memuat entitas saat baru saja terhubung. */
    async function onSession() {
        const connected = P.isConnected();
        const rs = P.hub().restore;
        const sig = JSON.stringify([connected, P.hub().email, P.hub().role, P.hub().pending, rs ? [rs.phase, rs.attempt, rs.nextRetryAt, rs.error] : null]);
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
    // Status proses mengikuti sesi entitas terpilih: muat ulang segera saat pilihan berubah.
    P.on('entity', () => { if (view === 'app') { S.renderTopbar(); S.renderContent(false); P.run.poll(); } });
    P.on('login', () => { if (view === 'app') S.renderTopbar(); });
    P.on('manual', () => { if (view === 'app') { S.renderTopbar(); if (!P.state.run.active) S.renderContent(false); } });
    P.on('sessions', () => { if (view === 'app') S.renderTopbar(); });
    P.on('batch', () => { if (view === 'app') { S.renderTopbar(); S.renderContent(false); } });
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
        // Semua polling berhenti selama dashboard tersembunyi (P.every, core.js) dan mengejar saat terlihat lagi.
        P.run.startPolling();
        P.every(P.manual.poll, 2000);
        P.every(pollLogin, 3000);
        pollLogin();
        P.every(pollSessions, 4000);
        pollSessions();
        // Selama sesi tersimpan masih dipulihkan: segarkan layar "Memulihkan sesi…" (hitung mundur, hasil).
        P.every(() => { if (P.hub().restore) refreshSession(); }, 2000);
    };
    async function refreshSession() {
        try { P.state.session = await P.api('/api/session'); } catch (e) { return; }
        P.emit('session');
    }
    // Kabar dari server lewat /events (lib/ui-events.js): muat ulang bagian yang berubah segera.
    P.on('server-event', (ev) => {
        if (ev === 'run') P.run.poll();
        else if (ev === 'login') pollLogin();
        else if (ev === 'sessions') { pollSessions(); P.manual.poll(); }
        else if (ev === 'session') refreshSession();
    });
    document.addEventListener('DOMContentLoaded', S.boot);
})();
