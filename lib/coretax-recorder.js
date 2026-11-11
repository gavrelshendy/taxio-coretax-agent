/* Rekam permintaan API Coretax (POST/PUT/DELETE) di jendela PIC selama pengguna mengerjakan sesuatu secara manual -
 * mis. sekali "Ubah" atau "Batal" BP21 / BPA1 / BPPU - supaya otomasinya bisa dibuat dari format kiriman yang ASLI,
 * bukan tebakan. Disimpan lokal saja (folder entitas), tanpa header (token sesi) dan dengan isian rahasia
 * (passphrase / kata sandi / sertifikat / tanda tangan) disamarkan. */
const fs = require('fs');
const path = require('path');

const SECRET = /pass|phrase|password|pwd|pin$|otp|secret|token|signature|certificate|privatekey|p12|pfx/i;
function redact(v, depth = 0) {
    if (depth > 12 || v == null) return v;
    if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
    if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = SECRET.test(k) ? '[disamarkan]' : redact(x, depth + 1); return o; }
    if (typeof v === 'string' && v.length > 2000) return v.slice(0, 200) + '...[' + v.length + ' karakter]';
    return v;
}
const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return String(s).length > 2000 ? String(s).slice(0, 200) + '...' : String(s); } };

/** Mulai merekam di `context`. Mengembalikan {stop(): Promise<{file, count}>}. */
function start(context, file, emit = () => {}) {
    const entries = [];
    const onResponse = async (res) => {
        const req = res.request(), url = req.url(), method = req.method();
        if (!/coretaxdjp\.pajak\.go\.id\/[a-z]+portal\/api\//i.test(url) || method === 'GET' || method === 'OPTIONS') return;
        if (/\/(get[a-z0-9]*|lookup|search|list[a-z]*)$/i.test(url.split('?')[0]) && !/amend|cancel|delete|issue|sign|submit|save|create|update/i.test(url)) return; // daftar / baca: tidak perlu
        let body = null; try { body = await res.json(); } catch (e) { /* bukan JSON */ }
        entries.push({ at: new Date().toISOString(), method, url: url.split('?')[0], request: redact(parse(req.postData())), status: res.status(), response: redact(body) });
        emit('  terekam: ' + method + ' ' + url.split('?')[0].replace(/^https:\/\/coretaxdjp\.pajak\.go\.id/, '') + ' -> HTTP ' + res.status());
    };
    context.on('response', onResponse);
    return {
        count: () => entries.length,
        stop: async () => {
            context.off('response', onResponse);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(entries, null, 1));
            return { file, count: entries.length };
        }
    };
}

module.exports = { start, redact };
