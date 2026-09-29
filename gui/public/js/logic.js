/* Taxio Pilot - logika murni dashboard (tanpa DOM), supaya bisa diuji di Node
   (scripts/test-gui-logic.js). Dimuat di browser sebagai window.PilotLogic. */
(function (root) {
    'use strict';

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    const MONTHS_LONG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

    // ---------- Masa pajak (mengikuti lib/masa.js di sisi server) ----------
    const isValidMasa = (s) => /^(0[1-9]|1[0-2])\d{2}$/.test(s);
    const isValidYear = (s) => /^(19|20)\d{2}$/.test(s);
    const toIndex = (mmYY) => (2000 + parseInt(mmYY.slice(2), 10)) * 12 + (parseInt(mmYY.slice(0, 2), 10) - 1);
    const fromIndex = (idx) => String((idx % 12) + 1).padStart(2, '0') + String(Math.floor(idx / 12) % 100).padStart(2, '0');
    const mmYY = (month1to12, year) => String(month1to12).padStart(2, '0') + String(year % 100).padStart(2, '0');

    /** Kumpulan MMYY -> kode ringkas yang dimengerti server: "0126-0526;0826". Bulan berurutan
     *  (juga lintas tahun) digabung jadi rentang. */
    function masaToCode(values) {
        const idx = Array.from(new Set(values || [])).filter(isValidMasa).map(toIndex).sort((a, b) => a - b);
        const runs = [];
        for (const i of idx) {
            const last = runs[runs.length - 1];
            if (last && last[1] === i - 1) last[1] = i; else runs.push([i, i]);
        }
        return runs.map(([a, b]) => (a === b ? fromIndex(a) : fromIndex(a) + '-' + fromIndex(b))).join(';');
    }

    /** Teks "0126;0226", "0126-0526", atau "2025" (setahun) -> { set, error }. Teks kosong = himpunan kosong. */
    function parseMasa(text) {
        const set = new Set();
        const segs = String(text || '').split(';').map((s) => s.trim()).filter(Boolean);
        for (const seg of segs) {
            const range = seg.match(/^(\d{4})\s*-\s*(\d{4})$/);
            if (range) {
                if (!isValidMasa(range[1]) || !isValidMasa(range[2])) return { set: new Set(), error: 'Masa tidak valid: "' + seg + '"' };
                let a = toIndex(range[1]); let b = toIndex(range[2]);
                if (a > b) [a, b] = [b, a];
                for (let i = a; i <= b; i++) set.add(fromIndex(i));
                continue;
            }
            // "20xx" = setahun penuh; "20" bukan bulan yang valid, jadi tidak pernah bentrok dengan MMYY.
            if (/^20\d{2}$/.test(seg)) {
                for (let m = 1; m <= 12; m++) set.add(mmYY(m, parseInt(seg, 10)));
                continue;
            }
            if (!isValidMasa(seg)) return { set: new Set(), error: 'Masa tidak valid: "' + seg + '"' };
            set.add(seg);
        }
        return { set, error: null };
    }

    /** Tahun pajak (SPT tahunan): [2024, 2025] -> "2024-2025"; [2021, 2024] -> "2021;2024". */
    function yearsToCode(values) {
        const ys = Array.from(new Set((values || []).map(Number))).filter((y) => isValidYear(String(y))).sort((a, b) => a - b);
        const runs = [];
        for (const y of ys) {
            const last = runs[runs.length - 1];
            if (last && last[1] === y - 1) last[1] = y; else runs.push([y, y]);
        }
        return runs.map(([a, b]) => (a === b ? String(a) : a + '-' + b)).join(';');
    }
    function parseYears(text) {
        const set = new Set();
        const segs = String(text || '').split(';').map((s) => s.trim()).filter(Boolean);
        for (const seg of segs) {
            const range = seg.match(/^(\d{4})\s*-\s*(\d{4})$/);
            if (range) {
                if (!isValidYear(range[1]) || !isValidYear(range[2])) return { set: new Set(), error: 'Tahun tidak valid: "' + seg + '"' };
                let a = parseInt(range[1], 10); let b = parseInt(range[2], 10);
                if (a > b) [a, b] = [b, a];
                for (let y = a; y <= b; y++) set.add(y);
                continue;
            }
            if (!isValidYear(seg)) return { set: new Set(), error: 'Tahun tidak valid: "' + seg + '"' };
            set.add(parseInt(seg, 10));
        }
        return { set, error: null };
    }

    function masaLabel(code) { return MONTHS_LONG[parseInt(code.slice(0, 2), 10) - 1] + ' 20' + code.slice(2); }

    // ---------- Entitas ----------
    const LEGAL = /^(PT|CV|TBK|PERSERO|FIRMA|FA|UD|KOPERASI|KOP|YAYASAN|PERKUMPULAN|BUT|PERUM|PERSEROAN|TERBATAS|THE|DAN|&)$/i;

    /** Dua huruf untuk avatar: kata pertama dan kedua tanpa bentuk badan hukum. */
    function initials(name) {
        const words = String(name || '').replace(/[.,()]/g, ' ').split(/\s+/).filter((w) => w && !LEGAL.test(w));
        if (!words.length) return 'E';
        // Biasanya 3 huruf (satu per kata) supaya lebih mudah dibedakan antar entitas yang mirip -
        // 2 kata cukup 2 huruf, 1 kata pakai 3 huruf pertama kata itu sendiri.
        if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
        if (words.length === 2) return (words[0][0] + words[1][0]).toUpperCase();
        return (words[0][0] + words[1][0] + words[2][0]).toUpperCase();
    }

    const digits = (s) => String(s || '').replace(/\D/g, '');
    function entityMatches(e, query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return true;
        const qd = digits(q);
        const hay = [e.entity_name, e.entity_id, e.project_label].concat((e.pics || []).map((p) => p.pic_name)).join(' ').toLowerCase();
        return hay.indexOf(q) !== -1 || (qd.length >= 3 && digits(e.npwp).indexOf(qd) !== -1);
    }

    /** Aturan daftar Grup: tanpa pencarian hanya entitas yang PIC-nya tertaut (bisa dipakai);
     *  saat mencari, semua yang cocok muncul, yang belum tertaut ditandai oleh pemanggil. */
    function visibleEntities(list, query) {
        const q = String(query || '').trim();
        if (!q) return (list || []).filter((e) => e.linked !== false);
        return (list || []).filter((e) => entityMatches(e, q));
    }
    function hiddenUnlinkedCount(list) { return (list || []).filter((e) => e.linked === false).length; }

    /** Pilihan PIC untuk sebuah entitas Taxio Hub: yang diminta bila ada, jika tidak PIC utama. */
    function pickPic(entity, wantedPicId) {
        const pics = entity.pics || [];
        const mine = (p) => p.pic_is_mine !== false;
        // PIC bawaan: yang dipilih user -> utama milik Anda -> PIC lain milik Anda -> utama -> pertama.
        // PIC milik orang lain ditolak Taxio Hub ("Tidak berwenang"), jadi jangan jadi bawaan bila ada yang milik Anda.
        return pics.find((p) => p.pic_id === wantedPicId) || pics.find((p) => p.is_primary && mine(p)) || pics.find(mine) || pics.find((p) => p.is_primary) || pics[0] || null;
    }

    /** Bentuk entitas datar yang diterima API aksi (sama dengan baris lama entitas x PIC).
     *  'manual' (sesi Coretax polos, tanpa PIC) dikirim apa adanya. Entitas lain (Taxio Hub
     *  ATAU lokal berkredensial - keduanya login otomatis) memakai pics[] untuk memilih PIC bila
     *  ada; yang pics-nya kosong (Orang Pribadi, baik Hub maupun lokal) mempertahankan pic_id
     *  bawaannya sendiri, KECUALI entitas Hub yang memang belum tertaut PIC sama sekali
     *  (linked===false), yang secara eksplisit ditandai 'unlinked' supaya server memberi pesan
     *  yang tepat ("tautkan dulu ..."), bukan sekadar "PIC belum dipilih". */
    function flattenSelection(entity, picId) {
        if (!entity) return null;
        if (entity.project === 'manual') return entity;
        const flat = Object.assign({}, entity);
        delete flat.pics; delete flat.linked;
        if (entity.pics && entity.pics.length) {
            const pic = pickPic(entity, picId);
            Object.assign(flat, pic ? { pic_id: pic.pic_id, pic_name: pic.pic_name, pic_is_mine: pic.pic_is_mine, is_primary: pic.is_primary } : { pic_id: 'unlinked', pic_name: '' });
        } else if (entity.linked === false) {
            flat.pic_id = 'unlinked'; flat.pic_name = '';
        }
        return flat;
    }
    /** Sesi Coretax polos yang dibuka lewat "Buka Coretax" dan di-login sendiri - BUKAN entitas
     *  lokal (yang sejak kredensial disimpan, login otomatis persis seperti entitas Taxio Hub). */
    const isManualLike = (e) => !!e && e.project === 'manual';
    const entityKey = (e) => (e ? (e.project || '') + '|' + e.entity_id : '');

    /** NPWP resmi sejak integrasi NIK (2024): 16 digit, TANPA titik atau strip (dikonfirmasi
     *  dari Taxio Hub sendiri). Ditampilkan dikelompokkan per 4 digit dengan spasi supaya mudah
     *  dibaca - spasi bukan tanda baca, beda dari format lama yang salah (titik+strip, 15
     *  digit) yang tidak lagi dipakai di mana pun. */
    function formatNpwp(v) {
        const d = digits(v);
        return d.length === 16 ? d.replace(/(\d{4})(?=\d)/g, '$1 ') : d;
    }
    function rupiah(n) {
        const d = digits(n);
        return d ? d.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.') : '';
    }

    // ---------- Status login di topbar ----------
    const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    /** { kind, text }: kind salah satu 'run' | 'ok' | 'manual' | 'wait' | 'off'. */
    function loginPill(ctx) {
        const { runActive, entity, manual, last } = ctx;
        if (runActive) return { kind: 'run', text: 'Sedang berjalan' };
        const m = manual || {};
        if (!entity) return m.loggedIn ? { kind: 'manual', text: 'Login manual aktif' } : { kind: 'off', text: 'Pilih entitas' };
        if (isManualLike(entity)) {
            if (m.loggedIn) return { kind: 'manual', text: 'Login manual aktif' };
            if (m.open) return { kind: 'wait', text: 'Menunggu login manual' };
            return { kind: 'off', text: 'Belum membuka Coretax' };
        }
        if (last && last.at && sameName(last.name, entity.entity_name)) return { kind: 'ok', text: 'Sesi Coretax aktif' };
        return { kind: 'off', text: 'Belum masuk Coretax' };
    }

    // ---------- Progres proses ----------
    /** Dari plan runcontrol ({items, states, index}) -> hitungan untuk bar dan ringkasan. */
    function planProgress(plan) {
        if (!plan || !plan.states || !plan.states.length) return null;
        const c = { ok: 0, skip: 0, hold: 0, run: 0, wait: 0 };
        for (const s of plan.states) c[s] = (c[s] || 0) + 1;
        const total = plan.states.length;
        const finished = c.ok + c.skip;
        return { total, ok: c.ok, skip: c.skip, hold: c.hold, run: c.run, wait: c.wait, finished, pct: Math.round((finished / total) * 100), holdPct: Math.round((c.hold / total) * 100) };
    }

    // ---------- Log ----------
    /** Baris log dari server: "[2026-09-25T20:34:58.033Z] pesan" -> { time, msg }. */
    function parseLogLine(line) {
        const m = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s?(.*)$/s.exec(String(line || ''));
        if (!m) return { time: '', msg: String(line || '') };
        const d = new Date(m[1]);
        const pad = (n) => String(n).padStart(2, '0');
        return { time: isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()), msg: m[2] };
    }
    function logLevel(msg) {
        const s = String(msg || '');
        if (/gagal|galat|error|ditolak|tidak bisa|\bGAGAL\b/i.test(s)) return 'error';
        if (/peringatan|dijeda|⏸|dilewati|perhatian|tidak ditemukan/i.test(s)) return 'warn';
        if (/berhasil|selesai|tersimpan|dibuat|dipulihkan|terhubung|▶|✓/i.test(s)) return 'ok';
        return 'info';
    }

    const api = {
        MONTHS, MONTHS_LONG, isValidMasa, isValidYear, mmYY, masaToCode, parseMasa, yearsToCode, parseYears, masaLabel,
        initials, entityMatches, visibleEntities, hiddenUnlinkedCount, pickPic, flattenSelection, isManualLike, entityKey,
        formatNpwp, rupiah, loginPill, planProgress, parseLogLine, logLevel
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PilotLogic = api;
})(typeof window !== 'undefined' ? window : this);
