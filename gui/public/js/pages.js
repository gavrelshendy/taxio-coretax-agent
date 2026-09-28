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
    const NAV = [
        { title: 'UNDUH', items: [
            { id: 'spt', label: 'SPT', icon: 'file', crumb: 'Unduh' },
            { id: 'ebupot', label: 'e-Bupot', icon: 'fileCheck', crumb: 'Unduh' },
            { id: 'bpsaya', label: 'Bukti Potong Saya', icon: 'inbox', crumb: 'Unduh' },
            { id: 'faktur', label: 'Unduh Faktur Masukan', icon: 'receipt', crumb: 'Unduh' },
            { id: 'a1', label: 'SPT PPh 21 Setahun', icon: 'cal', crumb: 'Unduh', hideForRestricted: true }
        ] },
        { title: 'OTOMASI', items: [
            { id: 'dividen', label: 'Impor Dividen', icon: 'coins', crumb: 'Otomasi' },
            { id: 'kredit', label: 'Kreditkan Faktur Masukan', icon: 'badge', crumb: 'Otomasi' },
            { id: 'billing', label: 'Kode Billing PPh 25', icon: 'bank', crumb: 'Otomasi', badge: 'BARU' }
        ] }
    ];

    // ---------- Potongan bersama ----------
    function loginText(ent) {
        if (!ent) return '-';
        if (ent.project === 'manual') return 'Manual · sesi yang terbuka';
        // Lokal (kredensial tersimpan) login otomatis persis seperti Taxio Hub - ent sudah
        // diratakan (flattenSelection) jadi pic_name-nya sudah PIC yang benar-benar terpilih.
        return 'Otomatis' + (ent.pic_name ? ' · PIC ' + ent.pic_name : '');
    }
    function readiness(ent) {
        if (!ent) return { ok: false, reason: 'Pilih entitas dulu' };
        if (L.isManualLike(ent) && !P.state.manual.loggedIn) return { ok: false, reason: 'Menunggu login manual' };
        return { ok: true };
    }
    function railCard(o) {
        const ready = o.ready || { ok: true };
        const why = !ready.ok ? ready.reason : o.blocked;
        return '<div class="card"><div class="eyebrow">' + (o.title || 'Ringkasan') + '</div>'
            + (o.big !== undefined ? '<div class="big-num"><b>' + o.big + '</b><span>' + (o.unit || '') + '</span></div>' : '')
            + (o.sub ? '<div style="font-size:13px;color:var(--text)">' + o.sub + '</div>' : '')
            + '<div class="divider"></div>' + P.kv(o.rows || [])
            + (o.folder === false ? '' : P.folderField())
            + '<button type="button" class="btn btn-primary btn-lg btn-block" data-act="start"' + (why ? ' disabled' : '') + '>' + P.icon(o.icon || 'play', 18, '', 2) + (o.cta || 'Mulai Otomasi') + '</button>'
            + (why ? '<div class="hint" style="text-align:center;margin-top:-8px">' + esc(why) + '</div>' : '')
            + (o.notes || []).map((n) => P.note(n[0], n[1], n[2])).join('') + '</div>';
    }
    /** Banner login manual: menuntun pengguna untuk login sendiri di jendela Coretax. Hanya
     *  untuk sesi Coretax POLOS (project 'manual') - entitas lokal berkredensial (tab Saya)
     *  login otomatis persis seperti Taxio Hub, tidak pernah lewat sini. */
    function manualBanner(ent) {
        if (!ent || !L.isManualLike(ent)) return '';
        const m = P.state.manual;
        const who = 'Sesi Coretax yang sedang terbuka dipakai apa adanya.';
        if (m.loggedIn) {
            return '<div class="banner ok"><span class="ico">' + P.icon('check', 20, '', 2.4) + '</span><div class="body"><b>Sesi Coretax terdeteksi</b><span>' + esc(m.identity || 'Sudah masuk ke Coretax.') + ' Pastikan ini akun yang benar sebelum memulai.</span></div></div>';
        }
        const steps = [['1', 'Buka Coretax'], ['2', 'Login'], ['3', 'Periksa sesi']];
        return '<div class="banner ' + (m.open ? 'warn' : 'info') + '"><span class="ico">' + P.icon('globe', 22) + '</span><div class="body"><b>' + (m.open ? 'Menunggu login manual di jendela Coretax' : 'Coretax dibuka di jendela terpisah') + '</b><span>' + who + ' Agen menunggu, dan lanjut begitu sesi terdeteksi.</span>'
            + '<div class="row" style="gap:8px;margin-top:8px"><button type="button" class="btn btn-sm btn-primary" data-act="open-coretax" style="box-shadow:none">' + P.icon('globe', 15) + (m.open ? 'Tampilkan jendela' : 'Buka Coretax') + '</button><button type="button" class="btn btn-sm" data-act="check-session">' + P.icon('shield', 15) + 'Periksa sesi</button></div></div>'
            + '<div class="banner-steps">' + steps.map(([n, t]) => '<span><i>' + n + '</i>' + t + '</span>').join('') + '</div></div>';
    }
    function entityGuard() {
        return '<section class="card" style="align-items:flex-start"><div class="card-head"><span class="step">' + P.icon('search', 14, '', 2.4) + '</span><h2>Pilih entitas dulu</h2></div>'
            + '<p class="hint" style="font-size:13.5px">Fitur ini berjalan per entitas. Pilih dari Taxio Hub, atau tambahkan klien baru di tab Saya.</p>'
            + '<button type="button" class="btn btn-primary" data-act="open-palette">' + P.icon('search', 16) + 'Cari entitas</button></section>';
    }
    const kodeHint = (n, unit) => n + ' ' + unit;

    // ---------- Kerangka halaman ----------
    function createPage(def) {
        const st = {};
        let root = null;
        let busy = false;
        const api = { st, entity: () => E.current(), sel: () => E.selected, redraw, updateRail, def };
        Object.assign(st, def.init(api));

        function railHtml() {
            const ent = api.entity();
            if (def.needsEntity !== false && !ent) return railCard({ rows: [['Entitas', '<span class="muted">Belum dipilih</span>']], ready: { ok: false, reason: 'Pilih entitas dulu' }, folder: false });
            return def.rail(st, api);
        }
        function html() {
            const ent = api.entity();
            if (def.normalize) def.normalize(st, api);
            const need = def.needsEntity !== false;
            const main = need && !ent ? entityGuard() : (need ? manualBanner(ent) : '') + def.main(st, api);
            return P.run.summaryHtml() + '<div class="cols"><div class="col-main">' + main + '</div><aside class="rail" id="rail">' + railHtml() + '</aside></div>';
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
            const rail = root && root.querySelector('#rail');
            if (!rail) return;
            rail.innerHTML = railHtml();
            P.bindFolderField(rail);
        }
        async function onClick(e) {
            const dismiss = e.target.closest('[data-dismiss-run]');
            if (dismiss) { P.run.dismissed = P.run.finished && P.run.finished.at; redraw(); return; }
            const t = e.target.closest('[data-act]');
            if (!t || !root.contains(t) || t.closest('.pp')) return;
            const act = t.dataset.act;
            if (act === 'open-palette') return E.openPalette();
            if (act === 'open-coretax') return P.manual.open();
            if (act === 'check-session') return P.manual.check(true);
            if (act === 'start') {
                if (busy) return;
                busy = true; t.disabled = true;
                try { await def.start(st, api); P.run.poll(); } catch (err) { alert('Gagal memulai: ' + err.message); }
                busy = false;
                updateRail();
                return;
            }
            if (def.act && def.act(act, t.dataset, st, api) !== false) redraw();
        }
        function onInput(e) {
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
    const perHalaman = (id, val) => '<div class="field"><label for="' + id + '">Baris per halaman</label><select class="input sm" id="' + id + '" data-bind="pageSize">' + ['auto', '100', '50', '25', '10'].map((v) => '<option value="' + v + '"' + (String(val) === v ? ' selected' : '') + '>' + (v === 'auto' ? 'Otomatis' : v + ' baris') + '</option>').join('') + '</select></div>';

    // =========================================================
    // SPT
    // =========================================================
    const SPT_MONTHLY = [['pph21', '21/26', 'PPh Pasal 21/26'], ['unifikasi', 'UNI', 'PPh Unifikasi'], ['ppn', 'PPN', 'PPN']];
    const SPT_ANNUAL = [['badan', '1771', 'PPh Badan'], ['spt_op', '1770', 'PPh Orang Pribadi']];
    const ANNUAL_KEYS = ['badan', 'spt_op'];
    const spt = createPage({
        id: 'spt',
        init(api) {
            return { jenis: new Set([restricted() ? 'unifikasi' : 'pph21']), bpe: true, induk: true, lampiran: false, fmt: 'pdf', isi: 'print', sus: 'combined',
                ppM: P.period.create({ mode: 'masa', onChange: () => api.updateRail() }), ppY: P.period.create({ mode: 'tahun', onChange: () => api.updateRail() }) };
        },
        normalize(st, api) {
            const ent = api.entity();
            const opAllowed = ent && (ent.project === 'manual' || ent.individual);
            if (!opAllowed) st.jenis.delete('spt_op');
            if (restricted()) st.jenis.delete('pph21');
            const onlyPph21 = st.jenis.size === 1 && st.jenis.has('pph21');
            if (st.isi === 'confidential' && !onlyPph21) st.isi = 'print';
        },
        afterDraw(st) { (isAnnual(st) ? st.ppY : st.ppM).bind(); },
        main(st, api) {
            const ent = api.entity();
            const opAllowed = ent && (ent.project === 'manual' || ent.individual);
            const annual = isAnnual(st);
            const onlyPph21 = st.jenis.size === 1 && st.jenis.has('pph21');
            const tiles = (list, cols) => '<div class="tiles ' + cols + '">' + list.map(([k, code, title]) => {
                const dis = (k === 'pph21' && restricted()) || (k === 'spt_op' && !opAllowed);
                const sub = k === 'spt_op' && !opAllowed ? 'Khusus entitas orang pribadi' : (ANNUAL_KEYS.includes(k) ? 'SPT Tahunan' : 'SPT Masa');
                return P.tile('jenis', k, st.jenis.has(k), code, title, sub, { disabled: dis, title: dis && k === 'pph21' ? 'SPT PPh 21 tidak tersedia untuk pengguna Restricted.' : '' });
            }).join('') + '</div>';
            const pp = annual ? st.ppY : st.ppM;
            const lamp = st.lampiran
                ? '<div class="subpanel"><div class="field"><span class="label">Format</span>' + P.seg('fmt', [{ value: 'pdf', label: 'PDF' }, { value: 'excel', label: 'Excel' }, { value: 'both', label: 'Keduanya' }], st.fmt) + '</div>'
                    + (st.fmt !== 'excel' ? '<div class="field"><span class="label">Isi PDF</span>' + P.seg('isi', [{ value: 'print', label: 'Ringkas' }, { value: 'full', label: 'Lengkap' }, { value: 'confidential', label: 'Rahasia', disabled: !onlyPph21, title: 'Hanya untuk PPh 21/26 saja' }], st.isi) + '</div>'
                        + '<div class="field"><span class="label">Susunan PDF</span>' + P.seg('sus', [{ value: 'combined', label: 'Gabung' }, { value: 'separate', label: 'Pisah' }], st.sus) + '</div>' : '')
                    + '<div class="full hint">' + (st.fmt === 'excel' ? 'Excel berisi seluruh data. Satu sheet per lampiran, dapat berisi beberapa tabel.' : ({ print: 'PDF ringkas menampilkan maks. 50 baris per tabel dan menunjukkan jumlah baris yang tidak tampil. Total selalu mencakup seluruh data; Excel tetap memuat rincian lengkap.', full: 'PDF lengkap memuat seluruh baris setiap tabel.', confidential: 'Mode rahasia menghapus rincian penerima. Hanya tersedia bila yang dipilih PPh 21/26 saja.' }[st.isi])) + '</div></div>' : '';
            return P.card(1, 'Jenis pajak', '<span>Masa boleh lebih dari satu · tahunan pilih satu</span>',
                '<div class="stack"><div class="eyebrow">SPT Masa</div>' + tiles(SPT_MONTHLY, 'c3') + '</div><div class="stack"><div class="eyebrow">SPT Tahunan</div>' + tiles(SPT_ANNUAL, 'c2') + '</div>')
                + P.card(2, annual ? 'Tahun pajak' : 'Masa pajak', annual ? 'Satu tahun = satu unduhan penuh (Jan–Des)' : '', pp.html())
                + P.card(3, 'Dokumen yang diunduh', '<span>BPE dan Induk = PDF asli Coretax</span>',
                    '<div class="stack">' + P.docRow('bpe', st.bpe, 'fileCheck', 'BPE', 'Bukti Penerimaan Elektronik')
                    + P.docRow('induk', st.induk, 'file', 'Induk', 'Formulir induk SPT')
                    + P.docRow('lampiran', st.lampiran, 'sheet', 'Lampiran', 'Dicetak dari tampilan Coretax, termasuk yang tidak punya PDF resmi') + lamp + '</div>');
        },
        act(act, d, st, api) {
            if (act === 'jenis') {
                const k = d.val;
                if (ANNUAL_KEYS.includes(k)) { const had = st.jenis.has(k); st.jenis.clear(); if (!had) st.jenis.add(k); }
                else { ANNUAL_KEYS.forEach((a) => st.jenis.delete(a)); if (st.jenis.has(k)) st.jenis.delete(k); else st.jenis.add(k); }
            } else if (act === 'bpe' || act === 'induk' || act === 'lampiran') st[act] = !st[act];
            else if (act === 'fmt' || act === 'isi' || act === 'sus') st[act] = d.val;
            else return false;
            api.updateRail();
        },
        rail(st, api) {
            const ent = api.entity(); const annual = isAnnual(st); const pp = annual ? st.ppY : st.ppM;
            const combos = st.jenis.size * pp.count();
            const docs = [st.bpe && 'BPE', st.induk && 'Induk', st.lampiran && 'Lampiran (' + ({ pdf: 'PDF', excel: 'Excel', both: 'PDF + Excel' }[st.fmt]) + ')'].filter(Boolean);
            let blocked = '';
            if (!st.jenis.size) blocked = 'Pilih jenis pajak'; else if (!pp.count()) blocked = annual ? 'Pilih tahun pajak' : 'Pilih masa pajak'; else if (!docs.length) blocked = 'Pilih minimal satu dokumen';
            return railCard({ big: combos, unit: 'kombinasi unduhan', sub: st.jenis.size + ' jenis pajak × ' + pp.count() + ' ' + pp.unit(),
                rows: [['Entitas', esc(ent.project === 'manual' ? 'Sesi manual' : ent.entity_name)], ['Login', esc(loginText(ent))], ['Dokumen', docs.length ? esc(docs.join(' · ')) : '<span class="muted">Belum dipilih</span>', docs.length ? '' : 'dim']],
                ready: readiness(ent), blocked, notes: [['shield', 'var(--green)', 'Hanya mengunduh dari Coretax. Tidak ada SPT yang dikirim ke DJP.']] });
        },
        async start(st, api) {
            const annual = isAnnual(st); const pp = annual ? st.ppY : st.ppM;
            const jenisPajakKeys = Array.from(st.jenis);
            if (restricted() && jenisPajakKeys.includes('pph21')) throw new Error('SPT PPh 21 tidak tersedia untuk pengguna Restricted.');
            if (!st.bpe && !st.induk && !st.lampiran) throw new Error('Pilih minimal satu dokumen untuk diunduh.');
            const lampiranMode = st.fmt === 'excel' ? 'full' : st.isi;
            await P.post('/api/actions/download-spt', { entity: api.entity(), jenisPajakKeys, masaInput: pp.code(), saveRoot: P.saveRoot() || undefined, checkPph25: false,
                includeLampiran: st.lampiran, includeBpe: st.bpe, includeInduk: st.induk, lampiranMode, lampiranFormat: st.fmt, outputLayout: st.sus, layoutStyle: 'coretax' });
        }
    });
    function isAnnual(st) { return Array.from(st.jenis).some((k) => ANNUAL_KEYS.includes(k)); }

    // =========================================================
    // e-Bupot
    // =========================================================
    const EBUPOT_TYPES = [['bp21', 'BP21', 'Bukti pemotongan PPh 21'], ['bppu', 'BPPU', 'Pemotongan unifikasi'], ['bpa1', 'BPA1', 'Bukti pemotongan A1'], ['bpmp', 'BPMP', 'Masa pegawai tetap']];
    const KODE_TYPES = ['bp21', 'bppu'];
    const ebupot = createPage({
        id: 'ebupot',
        init(api) { return { jenis: new Set(['bp21']), status: 'issued', pdf: true, pageSize: 'auto', kode: '', pp: P.period.create({ mode: 'masa', onChange: () => api.updateRail() }) }; },
        normalize(st) { if (restricted()) { st.jenis.delete('bpmp'); st.jenis.delete('bpa1'); } },
        afterDraw(st) { st.pp.bind(); },
        main(st) {
            const forceExcel = st.status === 'not_issued' || (st.jenis.size === 1 && st.jenis.has('bpmp'));
            const showKode = Array.from(st.jenis).some((k) => KODE_TYPES.includes(k));
            return P.card(1, 'Jenis bupot', '<span>Pilih minimal satu</span>', '<div class="tiles c2">' + EBUPOT_TYPES.map(([k, t, sub]) => {
                const dis = restricted() && (k === 'bpmp' || k === 'bpa1');
                return P.tile('jenis', k, st.jenis.has(k), t, t, sub, { disabled: dis, title: dis ? 'Tidak diizinkan untuk Restricted Editor.' : '' });
            }).join('') + '</div>')
                + P.card(2, 'Status dan format', '', '<div class="stack-lg"><div class="field"><span class="label">Status dokumen</span>' + P.seg('status', [{ value: 'issued', label: 'Telah terbit' }, { value: 'not_issued', label: 'Belum terbit' }], st.status)
                    + '<span class="hint">Dokumen Belum Terbit belum punya PDF resmi dan disimpan sebagai ringkasan Excel saja.</span></div>'
                    + '<div class="stack">' + P.docRow('excel', true, 'sheet', 'Excel', 'Ringkasan seluruh data (selalu dibuat)', true) + P.docRow('pdf', forceExcel ? false : st.pdf, 'file', 'PDF', forceExcel ? 'Tidak tersedia untuk pilihan ini' : 'PDF resmi tiap dokumen', forceExcel) + '</div>' + perHalaman('eb-page', st.pageSize) + '</div>')
                + P.card(3, 'Masa pajak', '', st.pp.html() + (showKode ? '<div class="field"><label for="eb-kode">Kode objek pajak (opsional)</label><input class="input mono" id="eb-kode" data-bind="kode" value="' + esc(st.kode) + '" placeholder="kosongkan = semua kode · mis. 21-100-35;21-100-20"></div>' : ''));
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
            let blocked = ''; if (!st.jenis.size) blocked = 'Pilih jenis bupot'; else if (!st.pp.count()) blocked = 'Pilih masa pajak';
            return railCard({ big: n, unit: 'unduhan', sub: st.jenis.size + ' jenis × ' + st.pp.count() + ' masa', rows: [['Entitas', esc(ent.project === 'manual' ? 'Sesi manual' : ent.entity_name)], ['Login', esc(loginText(ent))], ['Format', forceExcel || !st.pdf ? 'Excel' : 'Excel + PDF']], ready: readiness(ent), blocked,
                notes: [['info', 'var(--accent)', 'Beberapa jenis dijalankan berurutan, satu per satu.']] });
        },
        async start(st, api) {
            const types = Array.from(st.jenis);
            const items = types.map((bupotType) => ({
                entity: api.entity(), bupotType, documentStatus: st.status, masaInput: st.pp.code(), kodeInput: KODE_TYPES.includes(bupotType) ? st.kode.trim() : '', saveRoot: P.saveRoot() || undefined, pageSize: st.pageSize,
                outputMode: st.status === 'not_issued' || bupotType === 'bpmp' ? 'excel_only' : (st.pdf ? 'pdf_excel' : 'excel_only')
            }));
            P.run.runQueue(items); // berantai di latar; halaman berpindah ke tampilan proses lewat polling
        }
    });

    // =========================================================
    // Bukti Potong Saya (yang diterima)
    // =========================================================
    const MYBUPOT = [['bppu', 'BPPU', 'BPPU', false], ['bpnr', 'BPNR', 'BPNR', false], ['bp26', 'BP26', 'BP 26', false], ['bpatc', 'DOK', 'Dokumen yang Dipersamakan', false],
        ['bpmp', 'BPMP', 'BPMP', true], ['bp21', 'BP21', 'BP 21', true], ['bpa1', 'A1', 'BP A1', true], ['bpa2', 'A2', 'BP A2', true]];
    const bpsaya = createPage({
        id: 'bpsaya',
        init(api) { return { jenis: new Set(['bppu']), pdf: true, pageSize: 'auto', pp: P.period.create({ mode: 'masa', onChange: () => api.updateRail() }) }; },
        normalize(st, api) {
            const ent = api.entity();
            const personalOk = ent && (ent.project === 'manual' || ent.individual);
            MYBUPOT.forEach(([k, , , personal]) => { if ((personal && !personalOk) || (restricted() && (k === 'bpmp' || k === 'bpa1'))) st.jenis.delete(k); });
        },
        afterDraw(st) { st.pp.bind(); },
        main(st, api) {
            const ent = api.entity(); const personalOk = ent && (ent.project === 'manual' || ent.individual);
            const group = (title, personal) => '<div class="stack"><div class="eyebrow">' + title + '</div><div class="tiles c2">' + MYBUPOT.filter((m) => m[3] === personal).map(([k, code, title]) => {
                const dis = (personal && !personalOk) || (restricted() && (k === 'bpmp' || k === 'bpa1'));
                const why = restricted() && (k === 'bpmp' || k === 'bpa1') ? 'Tidak diizinkan untuk Restricted Editor.' : (personal && !personalOk ? 'Hanya untuk akun orang pribadi (PIC).' : '');
                return P.tile('jenis', k, st.jenis.has(k), code, title, personal ? 'Atas nama pribadi PIC' : 'Milik entitas', { disabled: dis, title: why });
            }).join('') + '</div></div>';
            return P.card(1, 'Jenis bukti potong', '<span>Bukti potong yang diterima</span>', group('Milik entitas', false) + group('Milik PIC pribadi', true)
                + (!personalOk ? '<div class="hint">Jenis milik PIC pribadi hanya tersedia saat memakai akun orang pribadi.</div>' : ''))
                + P.card(2, 'Format', '', '<div class="stack">' + P.docRow('excel', true, 'sheet', 'Excel', 'Ringkasan seluruh data (selalu dibuat)', true) + P.docRow('pdf', st.pdf, 'file', 'PDF', 'PDF resmi tiap bukti potong') + '</div>' + perHalaman('bp-page', st.pageSize))
                + P.card(3, 'Masa pajak', '', st.pp.html());
        },
        act(act, d, st, api) {
            if (act === 'jenis') { if (st.jenis.has(d.val)) st.jenis.delete(d.val); else st.jenis.add(d.val); }
            else if (act === 'pdf') st.pdf = !st.pdf;
            else return false;
            api.updateRail();
        },
        rail(st, api) {
            const ent = api.entity(); let blocked = ''; if (!st.jenis.size) blocked = 'Pilih jenis bukti potong'; else if (!st.pp.count()) blocked = 'Pilih masa pajak';
            return railCard({ big: st.jenis.size * st.pp.count(), unit: 'unduhan', sub: st.jenis.size + ' jenis × ' + st.pp.count() + ' masa', rows: [['Entitas', esc(ent.project === 'manual' ? 'Sesi manual' : ent.entity_name)], ['Login', esc(loginText(ent))], ['Format', st.pdf ? 'Excel + PDF' : 'Excel']], ready: readiness(ent), blocked });
        },
        async start(st, api) {
            await P.post('/api/actions/download-mybupot', { entity: api.entity(), buktiTypeKeys: Array.from(st.jenis), masaInput: st.pp.code(), saveRoot: P.saveRoot() || undefined, pageSize: st.pageSize, outputMode: st.pdf ? 'pdf_excel' : 'excel_only' });
        }
    });

    // =========================================================
    // Unduh Faktur Masukan
    // =========================================================
    const faktur = createPage({
        id: 'faktur',
        init(api) { return { pp: P.period.create({ mode: 'masa', onChange: () => api.updateRail() }) }; },
        afterDraw(st) { st.pp.bind(); },
        main(st) {
            return '<div class="banner info"><span class="ico">' + P.icon('receipt', 22) + '</span><div class="body"><b>Unduh data pajak masukan</b><span>Ekspor seluruh faktur pajak masukan pada masa yang dipilih ke Excel. Diambil langsung dari Coretax, tidak dibatasi paginasi tampilan. PDF per faktur belum tersedia di menu ini.</span></div></div>'
                + P.card(1, 'Masa pajak', '', st.pp.html());
        },
        rail(st, api) {
            const ent = api.entity();
            return railCard({ big: st.pp.count(), unit: 'masa', rows: [['Entitas', esc(ent.project === 'manual' ? 'Sesi manual' : ent.entity_name)], ['Login', esc(loginText(ent))], ['Format', 'Excel']], ready: readiness(ent), blocked: st.pp.count() ? '' : 'Pilih masa pajak' });
        },
        async start(st, api) { await P.post('/api/actions/download-pajak-masukan', { entity: api.entity(), masaInput: st.pp.code(), saveRoot: P.saveRoot() || undefined }); }
    });

    // =========================================================
    // Mode A1 (SPT PPh 21 setahun)
    // =========================================================
    const a1 = createPage({
        id: 'a1',
        init() { const y = P.today().getFullYear(); return { year: y, years: Array.from({ length: y - 2025 + 1 }, (_, i) => 2025 + i) }; },
        main(st) {
            const out = (icon, t, s) => '<div class="doc-row" style="align-items:flex-start"><span class="ico">' + P.icon(icon, 18) + '</span><div class="t"><b>' + t + '</b><span>' + s + '</span></div></div>';
            return P.card(1, 'Tahun pajak', '<span>Mulai 2025 · seluruh masa Jan–Des sekaligus</span>', '<div class="chips c6 tall">' + st.years.map((y) => '<button type="button" class="chip" data-act="year" data-val="' + y + '" aria-pressed="' + (st.year === y) + '">' + y + '</button>').join('') + '</div>')
                + P.card(2, 'Yang dihasilkan', '<span>Pengaturan dikunci untuk hasil terlengkap</span>', '<div class="stack">'
                    + out('file', 'PDF lengkap', 'Induk, BPE, dan Lampiran seluruh baris, untuk semua versi SPT.') + out('lock', 'PDF rahasia', 'Lampiran tanpa rincian penerima, untuk semua versi SPT.')
                    + out('sheet', 'Excel tahunan', 'Memakai versi terakhir tiap masa. Satu sheet per lampiran, dengan kolom Masa, total per masa, dan total setahun.')
                    + out('warn', 'Sheet Kontrol', 'Masa tanpa SPT atau yang gagal dibaca dicatat di sini. Data yang gagal tidak diganti dengan versi lama.') + '</div>');
        },
        act(act, d, st) { if (act === 'year') st.year = Number(d.val); else return false; },
        rail(st, api) {
            const ent = api.entity();
            return railCard({ big: 12, unit: 'masa · PPh 21/26 · ' + st.year, rows: [['Entitas', esc(ent.project === 'manual' ? 'Sesi manual' : ent.entity_name)], ['Login', esc(loginText(ent))]], ready: readiness(ent), blocked: restricted() ? 'Tidak tersedia untuk pengguna Restricted' : '', notes: [['lock', 'var(--muted)', 'Tidak tersedia untuk pengguna Restricted.']] });
        },
        async start(st, api) {
            if (restricted()) throw new Error('Mode A1 tidak tersedia untuk pengguna Restricted.');
            await P.post('/api/actions/download-spt', { entity: api.entity(), a1Year: String(st.year), saveRoot: P.saveRoot() || undefined });
        }
    });

    // =========================================================
    // Impor Dividen (AS.39-01) - selalu lewat sesi Coretax manual
    // =========================================================
    const dividen = createPage({
        id: 'dividen', needsEntity: false,
        init() { return { file: null, busy: '' }; },
        main(st) {
            const m = P.state.manual;
            const banner = m.loggedIn
                ? '<div class="banner ok"><span class="ico">' + P.icon('check', 20, '', 2.4) + '</span><div class="body"><b>Sesi Coretax terdeteksi</b><span>' + esc(m.identity || 'Sudah masuk ke Coretax.') + '</span></div></div>'
                : '<div class="banner ' + (m.open ? 'warn' : 'info') + '"><span class="ico">' + P.icon('globe', 22) + '</span><div class="body"><b>' + (m.open ? 'Menunggu login manual' : 'Fitur ini berjalan di sesi Coretax yang Anda login sendiri') + '</b><span>Buka Coretax, login sebagai wajib pajak yang akan diisi, lalu buka menu e-Reporting Realisasi Investasi.</span>'
                    + '<div class="row" style="gap:8px;margin-top:8px"><button type="button" class="btn btn-sm btn-primary" data-act="open-coretax" style="box-shadow:none">' + P.icon('globe', 15) + 'Buka Coretax</button><button type="button" class="btn btn-sm" data-act="check-session">' + P.icon('shield', 15) + 'Periksa sesi</button></div></div></div>';
            return banner
                + P.card(1, 'Buat kasus baru', '', '<div class="hint" style="font-size:13.5px">Membuka kasus e-Reporting baru (AS.39-01) di Coretax. Lewati bila kasusnya sudah Anda buka sendiri.</div><button type="button" class="btn" data-act="create-case"' + (m.loggedIn ? '' : ' disabled') + '>' + P.icon('plus', 16) + 'Buat Kasus Baru (AS.39-01)</button>')
                + P.card(2, 'File template Excel', '', '<div class="dropzone' + (st.file ? ' filled' : '') + '">' + P.icon(st.file ? 'check' : 'upload', 26) + (st.file ? '<span class="file-name">' + esc(st.file.fileName) + '</span>' : '<span>Pilih file template .xlsx yang sudah terisi</span>') + '<button type="button" class="link" data-act="pick-file">' + (st.file ? 'ganti file…' : 'pilih file…') + '</button></div>');
        },
        async act(act, d, st, api) {
            if (act === 'pick-file') { const f = await P.pickFile('Pilih file template Dividen (.xlsx)'); if (f) { st.file = f; api.redraw(); } return false; }
            if (act === 'create-case') { try { await P.post('/api/actions/create-dividen-case'); P.run.poll(); } catch (e) { alert('Gagal membuat kasus: ' + e.message); } return false; }
            if (act === 'import' || act === 'check') {
                if (!st.file) { alert('Pilih file template .xlsx dulu.'); return false; }
                try { await P.post(act === 'import' ? '/api/actions/import-dividen' : '/api/actions/check-dividen', { fileBase64: st.file.fileBase64, fileName: st.file.fileName }); P.run.poll(); }
                catch (e) { alert('Gagal memulai: ' + e.message); }
                return false;
            }
            return false;
        },
        rail(st) {
            const m = P.state.manual; const why = !m.loggedIn ? 'Menunggu login manual' : (!st.file ? 'Pilih file template dulu' : '');
            return '<div class="card"><div class="eyebrow">Ringkasan</div>' + P.kv([['Login', m.loggedIn ? esc(m.identity || 'Manual aktif') : '<span class="warn">Belum login</span>', m.loggedIn ? '' : 'warn'], ['File', st.file ? esc(st.file.fileName) : '<span class="muted">Belum dipilih</span>']])
                + '<button type="button" class="btn btn-primary btn-lg btn-block" data-act="import"' + (why ? ' disabled' : '') + '>' + P.icon('upload', 18, '', 2) + 'Impor ke Coretax</button>'
                + '<button type="button" class="btn btn-block" data-act="check"' + (why ? ' disabled' : '') + ' title="Baca tabel yang sedang tampil di Coretax dan bandingkan dengan file ini">' + P.icon('search', 16) + 'Cek hasil (bandingkan tabel)</button>'
                + (why ? '<div class="hint" style="text-align:center">' + esc(why) + '</div>' : '') + P.note('shield', 'var(--green)', 'Data masuk ke draft, tidak dikirim ke DJP sampai Anda menandatangani sendiri.') + '</div>';
        },
        start() {}
    });
    // Tombol di rail dividen memakai data-act biasa (bukan "start"): dialihkan ke act().

    // =========================================================
    // Kreditkan Faktur Masukan (per baris Excel)
    // =========================================================
    const kredit = createPage({
        id: 'kredit',
        init(api) { return { file: null, mode: 'excel', pp: P.period.create({ mode: 'masa1', onChange: () => api.updateRail() }) }; },
        afterDraw(st) { if (st.mode === 'fixed') st.pp.bind(); },
        main(st) {
            return P.card(1, 'Template Excel', '', '<div class="doc-row"><span class="ico">' + P.icon('sheet', 18) + '</span><div class="t"><b>Template pengkreditan faktur masukan</b><span>Isi kolom A–J: tiap baris dicari lewat No Faktur.</span></div><a class="btn btn-sm" href="/assets/template-pajak-masukan.xlsx" download>' + P.icon('download', 15) + 'Unduh</a></div>')
                + P.card(2, 'File Excel terisi', '', '<div class="dropzone' + (st.file ? ' filled' : '') + '">' + P.icon(st.file ? 'check' : 'upload', 26) + (st.file ? '<span class="file-name">' + esc(st.file.fileName) + '</span>' : '<span>Pilih file .xlsx yang sudah terisi</span>') + '<button type="button" class="link" data-act="pick-file">' + (st.file ? 'ganti file…' : 'pilih file…') + '</button></div>')
                + P.card(3, 'Masa pengkreditan', '', '<div class="stack-lg">' + P.seg('kmode', [{ value: 'excel', label: 'Ikuti kolom di Excel' }, { value: 'fixed', label: 'Tetapkan satu masa' }], st.mode)
                    + (st.mode === 'fixed' ? st.pp.html() : '') + '<div class="hint">Faktur yang sudah dilaporkan di SPT, dibatalkan, dibetulkan, atau melebihi batas 3 bulan tidak diubah. Otomatis dilewati, alasannya dicatat di kolom KETERANGAN.</div></div>');
        },
        async act(act, d, st, api) {
            if (act === 'kmode') { st.mode = d.val; return true; }
            if (act === 'pick-file') { const f = await P.pickFile('Pilih file Excel Pajak Masukan (.xlsx)'); if (f) { st.file = f; api.redraw(); } return false; }
            return false;
        },
        rail(st, api) {
            const ent = api.entity(); let blocked = ''; if (!st.file) blocked = 'Pilih file Excel dulu'; else if (st.mode === 'fixed' && !st.pp.count()) blocked = 'Pilih masa pengkreditan';
            return railCard({ title: 'Ringkasan', rows: [['Entitas', esc(ent.project === 'manual' ? 'Sesi manual' : ent.entity_name)], ['Login', esc(loginText(ent))], ['File', st.file ? esc(st.file.fileName) : '<span class="muted">Belum dipilih</span>'], ['Masa', st.mode === 'fixed' && st.pp.count() ? esc(L.masaLabel(st.pp.single())) : 'Mengikuti Excel']],
                folder: false, ready: readiness(ent), blocked, cta: 'Impor ke Coretax', icon: 'upload', notes: [['shield', 'var(--green)', 'Hasil per baris (SUKSES, GAGAL, DILEWATI) ditulis balik ke file Excel Anda dan disimpan di folder Downloads.']] });
        },
        async start(st, api) {
            await P.post('/api/actions/import-pajak-masukan', { entity: api.entity(), fileBase64: st.file.fileBase64, targetMasaInput: st.mode === 'fixed' && st.pp.single() ? st.pp.single() : undefined });
        }
    });

    // =========================================================
    // Kode Billing PPh 25
    // =========================================================
    const billing = createPage({
        id: 'billing',
        init(api) { return { nominal: '', pp: P.period.create({ mode: 'masa1', onChange: () => api.updateRail() }) }; },
        afterDraw(st) { st.pp.bind(); },
        main(st) {
            return P.card(1, 'Masa pajak', '<span>PPh Pasal 25 · setoran sendiri</span>', st.pp.html())
                + P.card(2, 'Nominal setoran', '', '<div class="field"><div class="input-group" style="align-items:center"><span style="font:700 20px var(--font-head);color:var(--muted);padding-left:4px">Rp</span><input class="input mono" style="height:56px;font-size:22px;font-weight:600" id="bl-nominal" data-bind="nominal" data-money inputmode="numeric" placeholder="0" value="' + esc(st.nominal) + '" aria-label="Nominal PPh 25"></div><span class="hint">Isi sesuai angsuran PPh 25 yang harus dibayar.</span></div>')
                + '<section class="card" style="border-style:dashed;box-shadow:none"><div class="row">' + P.icon('shield', 22) + '<div><b style="color:var(--ink)">Dicek otomatis sebelum membuat kode</b><div class="hint">Agen memastikan masa itu belum dibayar dan belum ada kode billing aktif. Bila sudah ada, kode yang ada diunduh, bukan dibuat ganda.</div></div></div></section>';
        },
        rail(st, api) {
            const ent = api.entity(); const masa = st.pp.single(); const digits = String(st.nominal).replace(/\D/g, '');
            let blocked = ''; if (!masa) blocked = 'Pilih masa pajak'; else if (!digits || Number(digits) <= 0) blocked = 'Isi nominal setoran';
            return railCard({ big: digits ? '<span style="font-size:36px">Rp ' + L.rupiah(digits) + '</span>' : '—', unit: '', sub: masa ? 'PPh Pasal 25 · masa ' + esc(L.masaLabel(masa)) : 'Pilih masa pajak',
                rows: [['Entitas', esc(ent.project === 'manual' ? 'Sesi manual' : ent.entity_name)], ['Login', esc(loginText(ent))], ['Jenis', ent.individual ? 'Orang Pribadi' : 'Badan']], ready: readiness(ent), blocked, cta: 'Buat Kode Billing', icon: 'bank',
                notes: [['info', 'var(--accent)', 'Kode dibuat lewat wizard resmi Coretax dan PDF-nya disimpan ke folder. Pembayaran tetap Anda lakukan sendiri.']] });
        },
        async start(st, api) {
            await P.post('/api/actions/billing-pph25', { entity: api.entity(), masaInput: st.pp.single(), nominal: String(st.nominal).replace(/\D/g, ''), saveRoot: P.saveRoot() || undefined });
        }
    });

    const REGISTRY = { spt, ebupot, bpsaya, faktur, a1, dividen, kredit, billing };
    P.pages = { NAV, get: (id) => REGISTRY[id], all: REGISTRY };
    P.pages.meta = (id) => { for (const g of NAV) for (const it of g.items) if (it.id === id) return it; return null; };
})();
