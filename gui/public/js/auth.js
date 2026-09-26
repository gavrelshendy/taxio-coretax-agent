/* Taxio Pilot - layar sebelum masuk: masuk, daftar, dan status pendaftaran. Alurnya meniru
   Taxio Hub: daftar dengan Inisial + email + kata sandi, konfirmasi email, lalu menunggu admin
   menempatkan akun ke grup (satu tahap: menyetujui sekaligus mengaktifkan). */
(function () {
    'use strict';
    const P = window.Pilot;
    const esc = P.esc;
    const A = P.auth = { screen: 'masuk', email: '', error: '', busy: false };

    /** Layar yang harus tampil menurut status akun di server (akun yang menunggu selalu menang). */
    A.sync = function () {
        const pending = P.hub().pending;
        if (pending) {
            A.email = pending.email || A.email;
            if (pending.status === 'need-initial') A.screen = 'inisial';
            else A.screen = 'status';
        } else if (A.screen === 'status' || A.screen === 'inisial') A.screen = 'masuk';
    };

    const feat = (icon, t, s) => '<div class="hero-feat"><span class="ico">' + P.icon(icon, 20) + '</span><div><b>' + t + '</b><span>' + s + '</span></div></div>';
    const field = (id, label, type, ph, val, extra) => '<div class="field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" type="' + type + '" placeholder="' + esc(ph) + '" value="' + esc(val || '') + '" autocomplete="' + ((extra && extra.auto) || 'off') + '"' + ((extra && extra.attr) || '') + '></div>';

    function hero(version) {
        return '<section class="auth-hero"><div class="brand"><div class="brand-logo"><img src="/assets/taxio-pilot-logo.png" alt="Taxio Pilot"></div><div class="brand-name"><b>Taxio Pilot</b><span>Autopilot untuk Coretax</span></div></div>'
            + '<div class="hero-body"><h1>Coretax berjalan sendiri.</h1>'
            + '<p>Pilih entitas dan masa, lalu agen yang mengerjakan sisanya: login, membuka halaman, mengunduh, sampai mengisi data. Anda tinggal mengawasi dan bisa menjeda kapan saja.</p>'
            + '<div class="hero-run"><div class="top"><i class="dot"></i>Agen sedang bekerja<span class="n">7 / 15</span></div><div class="bar"><span class="ok"></span></div><div class="sub">PPh Unifikasi · masa 0226 — mengunduh Induk, BPE, dan Lampiran</div></div>'
            + '<div class="hero-feats">' + feat('download', 'Unduh massal', 'SPT beserta lampiran, e-Bupot, dan Bukti Potong Saya untuk banyak masa sekaligus.')
            + feat('upload', 'Isi dan impor dari Excel', 'Dividen dan pengkreditan faktur masukan masuk ke Coretax per baris; hasilnya ditulis balik ke file.')
            + feat('bank', 'Buat Kode Billing PPh 25', 'Dicek dulu apakah sudah dibayar, lalu kode dibuat lewat wizard resmi Coretax.') + '</div></div>'
            + '<div class="hero-ver">' + esc(version ? 'v' + version : '') + '</div></section>';
    }

    function steps(cur) {
        const list = [['Akun dibuat', 'Email dan kata sandi Anda tersimpan di Taxio Hub.'], ['Konfirmasi email', 'Klik tautan di email Anda, lalu masuk di sini.'], ['Menunggu admin', 'Admin Taxio Hub menempatkan Anda ke grup. Setelah itu entitas Anda muncul otomatis.']];
        return '<div class="progress-steps">' + list.map(([t, s], i) => {
            const n = i + 1; const cls = n < cur ? 'done' : n === cur ? 'now' : '';
            const dot = n < cur ? P.icon('check', 15, '', 3) : n === cur ? P.icon('loader', 14, 'spin', 2.6) : n;
            return '<div class="pstep ' + cls + '"><div class="rail-col"><span class="dotc">' + dot + '</span>' + (i < 2 ? '<span class="ln"></span>' : '') + '</div><div class="tx"><b>' + t + '</b><span>' + s + '</span></div></div>';
        }).join('') + '</div>';
    }

    function panel() {
        const pending = P.hub().pending || {};
        const err = '<div class="form-error" id="au-error" role="alert">' + esc(A.error) + '</div>';
        const busy = A.busy ? ' disabled' : '';
        if (A.screen === 'daftar') {
            return '<div class="auth-form"><div><h2>Buat akun</h2><p class="lead">Daftar akun baru. Akses memerlukan persetujuan admin.</p></div>'
                + '<div class="field"><label for="au-initial">Inisial (mis. SGA)</label><input class="input" id="au-initial" maxlength="8" placeholder="SGA" style="text-transform:uppercase" autocomplete="off"><span class="hint">Maks. 8 huruf. Admin memakainya untuk mencocokkan akun Anda dengan anggota tim.</span></div>'
                + field('au-email', 'Email', 'email', 'nama@email.com', A.email, { auto: 'username' }) + field('au-pass', 'Kata sandi', 'password', 'Min. 6 karakter', '', { auto: 'new-password' })
                + err + '<button type="button" class="btn btn-primary btn-lg btn-block" data-au="signup"' + busy + '>' + (A.busy ? 'Mendaftar…' : 'Mendaftar') + '</button>'
                + '<div class="callout">' + P.icon('info', 16, '', 1.8) + '<span>Akun ini sama dengan akun Taxio Hub. Setelah disetujui, Anda bisa memakainya di keduanya.</span></div>'
                + '<div class="auth-foot">Sudah punya akun? <button type="button" class="link" data-au="to-masuk">Masuk</button></div></div>';
        }
        if (A.screen === 'status') {
            const st = pending.status;
            const cfg = st === 'confirm-email'
                ? { cur: 2, title: 'Cek email Anda', msg: 'Akun berhasil dibuat. Silakan cek email Anda dan klik link konfirmasi, lalu kembali ke sini untuk masuk.', btn: 'Saya sudah konfirmasi — masuk', act: 'to-masuk' }
                : { cur: 3, title: 'Menunggu admin', msg: st === 'waiting-approval' ? 'Pendaftaran Anda sedang menunggu persetujuan admin.' : 'Pendaftaran Anda sedang menunggu assignment grup oleh admin.' + (pending.initial ? ' Inisial yang diajukan: ' + pending.initial + '.' : ''), btn: 'Periksa status', act: 'check' };
            return '<div class="auth-form"><div><h2>' + cfg.title + '</h2><p class="lead">' + esc(cfg.msg) + '</p></div>' + steps(cfg.cur) + err
                + '<button type="button" class="btn btn-primary btn-lg btn-block" data-au="' + cfg.act + '"' + busy + '>' + P.icon('retry', 17, A.busy ? 'spin' : '', 2) + (A.busy ? 'Memeriksa…' : cfg.btn) + '</button>'
                + '<div class="row" style="justify-content:space-between"><span class="hint">' + esc(pending.email || '') + '</span><button type="button" class="link" data-au="logout">Keluar</button></div></div>';
        }
        if (A.screen === 'inisial') {
            return '<div class="auth-form"><div><h2>Satu langkah lagi</h2><p class="lead">Akun terhubung, tapi inisial Anda belum tercatat di sini (mis. konfirmasi email dibuka di perangkat lain). Ketik ulang inisial yang Anda pakai saat daftar:</p></div>'
                + '<div class="input-group"><input class="input" id="au-initial" maxlength="8" placeholder="SGA" style="text-transform:uppercase" autocomplete="off"><button type="button" class="btn btn-primary" style="height:46px" data-au="initial"' + busy + '>Ajukan</button></div>' + err
                + '<div class="row" style="justify-content:space-between"><span class="hint">' + esc(pending.email || '') + '</span><button type="button" class="link" data-au="logout">Keluar</button></div></div>';
        }
        return '<div class="auth-form"><div><h2>Masuk</h2><p class="lead">Masuk dengan akun Taxio Hub Anda untuk mengakses workspace tim.</p></div>'
            + field('au-email', 'Email', 'email', 'nama@email.com', A.email, { auto: 'username' }) + field('au-pass', 'Kata sandi', 'password', '••••••••', '', { auto: 'current-password' })
            + err + '<button type="button" class="btn btn-primary btn-lg btn-block" data-au="login"' + busy + '>' + (A.busy ? 'Masuk…' : 'Masuk') + '</button>'
            + '<div class="auth-foot">Belum punya akun? <button type="button" class="link" data-au="to-daftar">Daftar</button></div></div>';
    }

    A.html = () => hero(P.state.version && P.state.version.version) + '<section class="auth-panel" id="au-panel">' + panel() + '</section>';

    function paint(focusId) {
        const el = P.$('au-panel'); if (!el) return;
        el.innerHTML = panel();
        const f = focusId && P.$(focusId); if (f) f.focus();
    }
    const val = (id) => { const e = P.$(id); return e ? e.value : ''; };
    const setError = (m) => { A.error = m || ''; const e = P.$('au-error'); if (e) e.textContent = A.error; };
    async function run(fn) {
        A.busy = true; A.error = ''; paint();
        try { await fn(); } catch (e) { A.error = e.message; }
        A.busy = false; A.sync(); P.emit('session'); paint();
    }
    A.bind = function (root) {
        root.addEventListener('click', (e) => {
            const b = e.target.closest('[data-au]'); if (!b || A.busy) return;
            const act = b.dataset.au;
            if (act === 'to-daftar') { A.email = val('au-email') || A.email; A.screen = 'daftar'; A.error = ''; paint('au-initial'); }
            else if (act === 'to-masuk') { A.email = val('au-email') || A.email; A.screen = 'masuk'; A.error = ''; if (P.hub().pending && P.hub().pending.status === 'confirm-email') P.state.session.taxio_hub.pending = undefined; paint(A.email ? 'au-pass' : 'au-email'); }
            else if (act === 'login') {
                const email = val('au-email').trim(); const password = val('au-pass'); A.email = email;
                if (!email || !password) return setError('Email & kata sandi wajib diisi.');
                run(async () => { P.state.session = await P.post('/api/connect', { project: 'taxio_hub', email, password }); });
            } else if (act === 'signup') {
                const initial = val('au-initial').trim().toUpperCase(); const email = val('au-email').trim(); const password = val('au-pass'); A.email = email;
                if (!initial) return setError('Inisial wajib diisi.');
                if (!email || !password) return setError('Email & kata sandi wajib diisi.');
                if (password.length < 6) return setError('Kata sandi minimal 6 karakter.');
                run(async () => { P.state.session = await P.post('/api/signup', { project: 'taxio_hub', initial, email, password }); });
            } else if (act === 'check') run(async () => { P.state.session = await P.post('/api/registration/check', { project: 'taxio_hub' }); if (P.hub().pending) P.info('Belum ada perubahan. Admin belum menempatkan akun Anda ke grup.'); });
            else if (act === 'initial') {
                const initial = val('au-initial').trim().toUpperCase();
                if (!initial) return setError('Inisial wajib diisi.');
                run(async () => { P.state.session = await P.post('/api/registration/initial', { project: 'taxio_hub', initial }); });
            } else if (act === 'logout') run(async () => { P.state.session = await P.post('/api/disconnect', { project: 'taxio_hub' }); A.screen = 'masuk'; });
        });
        root.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !e.target.matches('input')) return;
            const map = { masuk: 'login', daftar: 'signup', inisial: 'initial' };
            const b = root.querySelector('[data-au="' + map[A.screen] + '"]'); if (b) b.click();
        });
        root.addEventListener('input', (e) => { if (e.target.id === 'au-initial') e.target.value = e.target.value.toUpperCase(); });
    };
})();
