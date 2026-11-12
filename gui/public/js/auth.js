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
        // Sesi tersimpan masih dipulihkan di latar (server baru dibuka / Taxio Hub belum terjangkau):
        // tampilkan "Memulihkan sesi…", bukan form masuk yang lalu melompat ke aplikasi.
        if (P.hub().restore && !pending) { A.screen = 'pulih'; return; }
        if (pending) {
            A.email = pending.email || A.email;
            if (pending.status === 'need-initial') A.screen = 'inisial';
            else A.screen = 'status';
        } else if (A.screen === 'status' || A.screen === 'inisial' || A.screen === 'pulih') A.screen = 'masuk';
    };

    const feat = (icon, t, s) => '<div class="hero-feat"><span class="ico">' + P.icon(icon, 20) + '</span><div><b>' + t + '</b><span>' + s + '</span></div></div>';
    const field = (id, label, type, ph, val, extra) => '<div class="field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" type="' + type + '" placeholder="' + esc(ph) + '" value="' + esc(val || '') + '" autocomplete="' + ((extra && extra.auto) || 'off') + '"' + ((extra && extra.attr) || '') + '></div>';

    function hero(version) {
        return '<section class="auth-hero"><div class="brand"><div class="brand-logo"><img src="/assets/taxio-pilot-logo.png" alt="Taxio Pilot"></div><div class="brand-name"><b>Taxio Pilot</b><span>Autopilot for Coretax</span></div></div>'
            + '<div class="hero-body"><h1>Coretax runs itself.</h1>'
            + '<p>Pick an entity and a period, and the agent does the rest: logging in, opening pages, downloading, even filling in data. You just watch, and can pause at any time.</p>'
            + '<div class="hero-run"><div class="top"><i class="dot"></i>Agent at work<span class="n">7 / 15</span></div><div class="bar"><span class="ok"></span></div><div class="sub">PPh Unifikasi · period 0226 — downloading Induk, BPE, and Lampiran</div></div>'
            + '<div class="hero-feats">' + feat('download', 'Bulk download', 'SPT with Lampiran, e-Bupot, and My Bukti Potong for many periods at once.')
            + feat('upload', 'Fill and import from Excel', 'Dividends and Faktur Masukan crediting go into Coretax row by row; results are written back to the file.')
            + feat('bank', 'Create PPh 25 Kode Billing', 'Checks first whether it is already paid, then creates the code through the official Coretax wizard.') + '</div></div>'
            + '<div class="hero-ver">' + esc(version ? 'v' + version : '') + '</div></section>';
    }

    function steps(cur) {
        const list = [['Account created', 'Your email and password are saved in Taxio Hub.'], ['Confirm email', 'Click the link in your email, then sign in here.'], ['Waiting for admin', 'A Taxio Hub admin assigns you to a group. Your entities then appear automatically.']];
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
        if (A.screen === 'pulih') {
            const r = P.hub().restore || {};
            const who = r.email ? esc(r.email) : 'akun Taxio Hub Anda';
            if (r.phase === 'retrying') {
                const secs = r.nextRetryAt ? Math.max(0, Math.round((r.nextRetryAt - Date.now()) / 1000)) : 0;
                return '<div class="auth-form" data-restore="retrying"><div><h2>Taxio Hub belum bisa dihubungi</h2><p class="lead">Sesi ' + who + ' tetap tersimpan, jadi Anda tidak perlu masuk lagi. Pilot mencoba lagi otomatis' + (secs ? ' dalam ±' + secs + ' detik' : '') + '. Periksa koneksi internet Anda.</p></div>'
                    + (r.error ? '<div class="callout">' + P.icon('info', 16, '', 1.8) + '<span>' + esc(r.error) + '</span></div>' : '') + err
                    + '<button type="button" class="btn btn-primary btn-lg btn-block" data-au="retry"' + busy + '>' + P.icon('retry', 17, A.busy ? 'spin' : '', 2) + (A.busy ? 'Mencoba…' : 'Coba lagi') + '</button>'
                    + '<div class="row" style="justify-content:space-between"><span class="hint">' + esc(r.email || '') + '</span><button type="button" class="link" data-au="logout">Masuk dengan akun lain</button></div></div>';
            }
            return '<div class="auth-form" data-restore="restoring"><div><h2>Memulihkan sesi…</h2><p class="lead">Menyambungkan kembali ' + who + ' ke Taxio Hub. Mohon tunggu sebentar.</p></div>'
                + '<div class="row" style="gap:10px">' + P.icon('loader', 18, 'spin', 2.4) + '<span class="hint">Memulihkan sesi…</span></div></div>';
        }
        if (A.screen === 'daftar') {
            return '<div class="auth-form"><div><h2>Create account</h2><p class="lead">Sign up for a new account. Access requires admin approval.</p></div>'
                + '<div class="field"><label for="au-initial">Initials (e.g. SGA)</label><input class="input" id="au-initial" maxlength="8" placeholder="SGA" style="text-transform:uppercase" autocomplete="off"><span class="hint">Max. 8 letters. The admin uses them to match your account with a team member.</span></div>'
                + field('au-email', 'Email', 'email', 'name@email.com', A.email, { auto: 'username' }) + field('au-pass', 'Password', 'password', 'Min. 6 characters', '', { auto: 'new-password' })
                + err + '<button type="button" class="btn btn-primary btn-lg btn-block" data-au="signup"' + busy + '>' + (A.busy ? 'Signing up…' : 'Sign up') + '</button>'
                + '<div class="callout">' + P.icon('info', 16, '', 1.8) + '<span>This is the same account as your Taxio Hub account. Once approved, you can use it in both.</span></div>'
                + '<div class="auth-foot">Already have an account? <button type="button" class="link" data-au="to-masuk">Sign in</button></div></div>';
        }
        if (A.screen === 'status') {
            const st = pending.status;
            const cfg = st === 'confirm-email'
                ? { cur: 2, title: 'Check your email', msg: 'Your account has been created. Check your email and click the confirmation link, then come back here to sign in.', btn: 'I have confirmed — sign in', act: 'to-masuk' }
                : { cur: 3, title: 'Waiting for admin', msg: st === 'waiting-approval' ? 'Your registration is waiting for admin approval.' : 'Your registration is waiting for an admin to assign you to a group.' + (pending.initial ? ' Submitted initials: ' + pending.initial + '.' : ''), btn: 'Check status', act: 'check' };
            return '<div class="auth-form"><div><h2>' + cfg.title + '</h2><p class="lead">' + esc(cfg.msg) + '</p></div>' + steps(cfg.cur) + err
                + '<button type="button" class="btn btn-primary btn-lg btn-block" data-au="' + cfg.act + '"' + busy + '>' + P.icon('retry', 17, A.busy ? 'spin' : '', 2) + (A.busy ? 'Checking…' : cfg.btn) + '</button>'
                + '<div class="row" style="justify-content:space-between"><span class="hint">' + esc(pending.email || '') + '</span><button type="button" class="link" data-au="logout">Sign out</button></div></div>';
        }
        if (A.screen === 'inisial') {
            return '<div class="auth-form"><div><h2>One more step</h2><p class="lead">Your account is connected, but your initials are not recorded here yet (e.g. the confirmation email was opened on another device). Re-enter the initials you used when signing up:</p></div>'
                + '<div class="input-group"><input class="input" id="au-initial" maxlength="8" placeholder="SGA" style="text-transform:uppercase" autocomplete="off"><button type="button" class="btn btn-primary" style="height:46px" data-au="initial"' + busy + '>Submit</button></div>' + err
                + '<div class="row" style="justify-content:space-between"><span class="hint">' + esc(pending.email || '') + '</span><button type="button" class="link" data-au="logout">Sign out</button></div></div>';
        }
        return '<div class="auth-form"><div><h2>Sign in</h2><p class="lead">Sign in with your Taxio Hub account to access your team workspace.</p></div>'
            + field('au-email', 'Email', 'email', 'name@email.com', A.email, { auto: 'username' }) + field('au-pass', 'Password', 'password', '••••••••', '', { auto: 'current-password' })
            + err + '<button type="button" class="btn btn-primary btn-lg btn-block" data-au="login"' + busy + '>' + (A.busy ? 'Signing in…' : 'Sign in') + '</button>'
            + '<div class="auth-foot">Don\'t have an account? <button type="button" class="link" data-au="to-daftar">Sign up</button></div></div>';
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
                if (!email || !password) return setError('Email and password are required.');
                run(async () => { P.state.session = await P.post('/api/connect', { project: 'taxio_hub', email, password }); });
            } else if (act === 'signup') {
                const initial = val('au-initial').trim().toUpperCase(); const email = val('au-email').trim(); const password = val('au-pass'); A.email = email;
                if (!initial) return setError('Initials are required.');
                if (!email || !password) return setError('Email and password are required.');
                if (password.length < 6) return setError('Password must be at least 6 characters.');
                run(async () => { P.state.session = await P.post('/api/signup', { project: 'taxio_hub', initial, email, password }); });
            } else if (act === 'check') run(async () => { P.state.session = await P.post('/api/registration/check', { project: 'taxio_hub' }); if (P.hub().pending) P.info('No change yet. The admin has not assigned your account to a group.'); });
            else if (act === 'initial') {
                const initial = val('au-initial').trim().toUpperCase();
                if (!initial) return setError('Initials are required.');
                run(async () => { P.state.session = await P.post('/api/registration/initial', { project: 'taxio_hub', initial }); });
            } else if (act === 'retry') run(async () => { P.state.session = await P.post('/api/session/retry', { project: 'taxio_hub' }); });
            else if (act === 'logout') run(async () => { P.state.session = await P.post('/api/disconnect', { project: 'taxio_hub' }); A.screen = 'masuk'; });
        });
        root.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !e.target.matches('input')) return;
            const map = { masuk: 'login', daftar: 'signup', inisial: 'initial' };
            const b = root.querySelector('[data-au="' + map[A.screen] + '"]'); if (b) b.click();
        });
        root.addEventListener('input', (e) => { if (e.target.id === 'au-initial') e.target.value = e.target.value.toUpperCase(); });
    };
})();
