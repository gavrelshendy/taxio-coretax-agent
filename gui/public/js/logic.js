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
        if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
        return (words[0][0] + words[1][0]).toUpperCase();
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
        return pics.find((p) => p.pic_id === wantedPicId) || pics.find((p) => p.is_primary) || pics[0] || null;
    }

    /** Bentuk entitas datar yang diterima API aksi (sama dengan baris lama entitas x PIC). */
    function flattenSelection(entity, picId) {
        if (!entity) return null;
        if (entity.project === 'local' || entity.project === 'manual') return entity;
        const pic = pickPic(entity, picId);
        const flat = Object.assign({}, entity);
        delete flat.pics; delete flat.linked;
        return Object.assign(flat, pic ? { pic_id: pic.pic_id, pic_name: pic.pic_name, pic_is_mine: pic.pic_is_mine, is_primary: pic.is_primary } : { pic_id: 'unlinked', pic_name: '' });
    }
    const isManualLike = (e) => !!e && (e.project === 'manual' || e.project === 'local');
    const entityKey = (e) => (e ? (e.project || '') + '|' + e.entity_id : '');

    function formatNpwp(v) {
        const d = digits(v);
        if (d.length === 15) return d.slice(0, 2) + '.' + d.slice(2, 5) + '.' + d.slice(5, 8) + '.' + d.slice(8, 9) + '-' + d.slice(9, 12) + '.' + d.slice(12);
        if (d.length === 16) return d.replace(/(\d{4})(?=\d)/g, '$1 ');
        return d;
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
