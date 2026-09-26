/* Taxio Pilot - inti dashboard: namespace, helper DOM/API, ikon, penyimpanan preferensi,
   toast, dan state bersama. Semua modul lain menempel di window.Pilot. */
(function () {
    'use strict';
    const P = window.Pilot = window.Pilot || {};
    P.L = window.PilotLogic;

    P.$ = (id) => document.getElementById(id);
    P.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    P.api = async function api(path, opts) {
        const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
        let body = null;
        try { body = await res.json(); } catch (e) { /* bukan JSON */ }
        if (!res.ok) {
            const err = new Error((body && body.error) || ('Request gagal (' + res.status + ')'));
            err.status = res.status; err.body = body;
            throw err;
        }
        return body;
    };
    P.post = (path, body) => P.api(path, { method: 'POST', body: JSON.stringify(body === undefined ? {} : body) });

    // ---------- Preferensi lokal (localStorage boleh tidak tersedia) ----------
    P.store = {
        get(key, fallback) { try { const v = localStorage.getItem('pilot.' + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
        set(key, value) { try { localStorage.setItem('pilot.' + key, JSON.stringify(value)); } catch (e) { /* diabaikan */ } }
    };

    // ---------- Bus kejadian sederhana ----------
    const handlers = {};
    P.on = (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); };
    P.emit = (name, payload) => { (handlers[name] || []).slice().forEach((fn) => { try { fn(payload); } catch (e) { console.error(name, e); } }); };

    // ---------- State bersama ----------
    P.state = {
        session: { taxio_hub: { connected: false, label: 'Taxio Hub' } },
        version: null,
        manual: { open: false, loggedIn: false, identity: '' },
        run: { active: false },
        lastLogin: null,
        page: 'spt'
    };
    P.hub = () => P.state.session.taxio_hub || {};
    P.isConnected = () => !!P.hub().connected;
    P.isRestricted = () => String(P.hub().role || '').toLowerCase().includes('restricted');

    // ---------- Ikon (garis, gaya lucide) ----------
    const ICONS = {
        file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
        fileCheck: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/>',
        sheet: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
        inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
        receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
        cal: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><path d="M17 14h-6"/><path d="M13 18H7"/>',
        coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
        badge: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
        bank: '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
        gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
        down: '<path d="m6 9 6 6 6-6"/>', up: '<path d="m18 15-6-6-6 6"/>', left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
        check: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
        play: '<polygon points="6 3 20 12 6 21 6 3"/>',
        pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
        skipF: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
        skipB: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',
        retry: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
        stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
        term: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
        lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
        globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
        warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
        loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
        info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
        user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
        arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
        plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
        pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
        trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
        power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>'
    };
    P.icon = (name, size, extraClass, stroke) => '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (stroke || 1.8) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extraClass ? ' class="' + extraClass + '"' : '') + '>' + (ICONS[name] || '') + '</svg>';

    // ---------- Toast ----------
    const shownNotices = new Set();
    P.notice = function (n) {
        if (!n || shownNotices.has(n.id)) return;
        shownNotices.add(n.id);
        let stack = P.$('notice-stack');
        if (!stack) { stack = document.createElement('div'); stack.id = 'notice-stack'; document.body.appendChild(stack); }
        const card = document.createElement('div');
        card.className = 'notice ' + (n.level || 'info');
        const title = document.createElement('b');
        title.textContent = n.level === 'error' ? 'Galat' : n.level === 'warning' ? 'Perhatian' : 'Info';
        const body = document.createElement('div');
        body.textContent = n.msg;
        const close = document.createElement('button');
        close.textContent = '×'; close.title = 'Tutup'; close.setAttribute('aria-label', 'Tutup');
        const dismiss = () => { card.remove(); if (!n.local) fetch('/api/notices/ack?id=' + encodeURIComponent(n.id), { method: 'POST' }).catch(() => {}); };
        close.onclick = dismiss;
        card.append(close, title, body);
        stack.appendChild(card);
        if ((n.level || 'info') === 'info') setTimeout(dismiss, 8000);
    };
    // Peringatan dari jendela sendiri memakai kartu yang sama, bukan dialog alert() browser yang memblokir.
    let localSeq = 0;
    window.alert = (msg) => P.notice({ id: 'local-' + (++localSeq), local: true, level: /^Gagal/i.test(String(msg)) ? 'error' : 'warning', msg: String(msg) });
    P.info = (msg) => P.notice({ id: 'local-' + (++localSeq), local: true, level: 'info', msg: String(msg) });

    // ---------- Potongan HTML bersama ----------
    P.card = (step, title, aside, body) => '<section class="card"><div class="card-head">' + (step ? '<span class="step">' + step + '</span>' : '') + '<h2>' + title + '</h2>' + (aside ? '<span class="aside">' + aside + '</span>' : '') + '</div>' + body + '</section>';
    P.seg = (name, options, value) => '<div class="seg" role="group">' + options.map((o) =>
        '<button type="button" data-act="' + name + '" data-val="' + P.esc(o.value) + '" aria-pressed="' + (o.value === value) + '"' + (o.disabled ? ' disabled' : '') + (o.title ? ' title="' + P.esc(o.title) + '"' : '') + '>' + P.esc(o.label) + '</button>').join('') + '</div>';
    P.switchBtn = (act, on, label, disabled) => '<button type="button" class="switch" role="switch" aria-checked="' + !!on + '" aria-label="' + P.esc(label) + '" data-act="' + act + '"' + (disabled ? ' disabled' : '') + '></button>';
    P.checkRow = (act, on, text, disabled) => '<button type="button" class="check-row" role="checkbox" aria-checked="' + !!on + '" data-act="' + act + '"' + (disabled ? ' disabled' : '') + '><span class="check" aria-checked="' + !!on + '">' + P.icon('check', 13, '', 3) + '</span>' + text + '</button>';
    P.docRow = (act, on, icon, title, sub, disabled) => '<div class="doc-row"><span class="ico">' + P.icon(icon, 18) + '</span><div class="t"><b>' + title + '</b><span>' + sub + '</span></div>' + P.switchBtn(act, on, title, disabled) + '</div>';
    P.tile = (act, val, on, code, title, sub, opt) => {
        opt = opt || {};
        return '<button type="button" class="tile" data-act="' + act + '" data-val="' + P.esc(val) + '" aria-pressed="' + !!on + '"' + (opt.disabled ? ' disabled' : '') + (opt.title ? ' title="' + P.esc(opt.title) + '"' : '') + '>'
            + '<span class="code">' + code + '</span><span class="t"><b>' + title + '</b><span>' + sub + '</span></span>'
            + (opt.disabled ? '<span class="lock">' + P.icon('lock', 14) + '</span>' : '<span class="tick">' + P.icon('check', 12, '', 3).replace('currentColor', '#fff') + '</span>') + '</button>';
    };
    P.kv = (rows) => '<dl class="kv">' + rows.map(([k, v, cls]) => '<div><dt>' + k + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</dd></div>').join('') + '</dl>';
    P.note = (icon, color, text) => '<div class="note"><span style="color:' + color + '">' + P.icon(icon, 16) + '</span><span>' + text + '</span></div>';

    // Folder simpan dipakai bersama semua halaman (satu pilihan, seperti sebelumnya).
    P.saveRoot = () => P.store.get('saveRoot', '');
    P.folderField = () => '<div class="stack" style="gap:8px"><div class="eyebrow">Simpan ke</div><div class="input-group">'
        + '<input type="text" class="input sm mono" id="save-root-input" placeholder="Downloads\\CoretaxAgent" value="' + P.esc(P.saveRoot()) + '" aria-label="Folder simpan">'
        + '<button type="button" class="btn btn-sm" id="pick-folder-btn" style="height:40px">Cari</button></div></div>';
    P.bindFolderField = (root) => {
        const input = root.querySelector('#save-root-input');
        const btn = root.querySelector('#pick-folder-btn');
        if (input) input.addEventListener('input', () => P.store.set('saveRoot', input.value.trim()));
        if (btn) btn.addEventListener('click', async () => {
            try {
                const data = await P.post('/api/actions/pick-folder', { title: 'Pilih folder tempat menyimpan hasil unduhan' });
                if (data && !data.canceled && data.folderPath) { input.value = data.folderPath; P.store.set('saveRoot', data.folderPath); }
            } catch (e) { /* dibatalkan */ }
        });
    };
    P.readFileAsBase64 = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const bytes = new Uint8Array(reader.result);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            resolve(btoa(binary));
        };
        reader.onerror = () => reject(reader.error || new Error('Gagal membaca file.'));
        reader.readAsArrayBuffer(file);
    });
    // Pilih file lewat dialog Windows (server), dengan cadangan <input type=file> bila tidak tersedia.
    P.pickFile = async (title, filter) => {
        try {
            const data = await P.post('/api/actions/pick-file', { title, filter: filter || 'File Excel (*.xlsx)|*.xlsx|Semua File (*.*)|*.*' });
            if (data && !data.canceled && data.fileBase64) return { fileName: data.fileName, fileBase64: data.fileBase64 };
            if (data && data.canceled) return null;
        } catch (e) { /* jatuh ke input file */ }
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.xlsx';
            input.onchange = async () => {
                const f = input.files && input.files[0];
                if (!f) return resolve(null);
                try { resolve({ fileName: f.name, fileBase64: await P.readFileAsBase64(f) }); } catch (err) { alert('Gagal membaca file: ' + err.message); resolve(null); }
            };
            input.click();
        });
    };
    P.today = () => new Date();
})();
