#!/usr/bin/env node
/* Taxio Pilot MCP server - lets Claude Desktop (or any MCP client) use Taxio Pilot's local API directly instead of
 * operating the screen. Stdio transport, JSON-RPC 2.0, one message per line; no dependencies.
 *
 * Talks only to Taxio Pilot on this PC (Pilot must be running and connected to Taxio Hub).
 * Coretax logins, passphrases and sessions stay inside Pilot; nothing here stores or prints them.
 *
 * Finding Pilot (Pilot after v3.0.44 / "Tahap 1"): Pilot picks its port at start (51733 when free, otherwise a free
 * port) and protects its API with a random per-launch token. Both are in runtime.json in Pilot's data root -
 * %LOCALAPPDATA%\TaxioPilot\runtime.json (or <TAXIO_PILOT_DATA_DIR>\runtime.json) - which this file reads ITSELF
 * on every call (it is distributed standalone: one file, no dependencies, plain `node`), so a Pilot restart with
 * a new port/token is picked up without restarting the MCP client. The token is sent as `Authorization: Bearer`
 * and never printed.
 *
 * Claude Desktop config (claude_desktop_config.json):
 *   { "mcpServers": { "taxio-pilot": { "command": "node", "args": ["<path>\\mcp\\taxio-pilot-mcp.js"] } } }
 * Optional env: TAXIO_PILOT_URL (fixed address, e.g. http://127.0.0.1:51733 for a Pilot up to v3.0.44, which has
 * no runtime.json; the token then comes from TAXIO_PILOT_TOKEN, or from runtime.json when its port matches),
 * TAXIO_PILOT_LOG (path of coretax-agent.log). */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.7.0';
const NOT_RUNNING = 'Taxio Pilot tidak berjalan - buka Taxio Pilot dulu (lalu coba lagi).';

/** Akar data Pilot - sama dengan lib/paths.js root() (disalin di sini karena file ini berdiri sendiri). */
function pilotRoot() {
    if (process.env.TAXIO_PILOT_DATA_DIR) return path.resolve(process.env.TAXIO_PILOT_DATA_DIR);
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TaxioPilot');
}
function readRuntime() {
    try {
        const r = JSON.parse(fs.readFileSync(path.join(pilotRoot(), 'runtime.json'), 'utf8'));
        return r && Number.isInteger(r.port) && typeof r.token === 'string' ? r : null;
    } catch (e) { return null; }
}
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/** { host, port, token } untuk panggilan berikutnya, atau melempar NOT_RUNNING. */
function target() {
    const rt = readRuntime();
    if (process.env.TAXIO_PILOT_URL) {
        const u = new URL(process.env.TAXIO_PILOT_URL);
        const port = Number(u.port || 80);
        const token = process.env.TAXIO_PILOT_TOKEN || (rt && rt.port === port ? rt.token : '');
        return { host: u.hostname, port, token };
    }
    if (!rt) throw new Error(NOT_RUNNING + ' (runtime.json tidak ada di ' + pilotRoot() + ')');
    if (Number.isInteger(rt.pid) && !pidAlive(rt.pid)) throw new Error(NOT_RUNNING + ' (runtime.json usang: proses ' + rt.pid + ' sudah tidak ada)');
    return { host: '127.0.0.1', port: rt.port, token: rt.token };
}

// Log Pilot yang sedang berjalan: TAXIO_PILOT_LOG, atau ditanyakan ke Pilot (/api/log-file, v3.0.42+), atau tebakan:
// %LOCALAPPDATA%\TaxioPilot\logs (Pilot sesudah v3.0.44), lalu log di samping exe versi lama (dist, dist-fix, dist-next).
// Dulu selalu dist\ - bila Pilot dijalankan dari folder lain, read_log membaca log lama dan run yang sudah SELESAI
// tampak tidak berjalan.
const LOG_GUESSES = [path.join(pilotRoot(), 'logs', 'coretax-agent.log')]
    .concat(['dist', 'dist-fix', 'dist-next'].map((d) => path.join(__dirname, '..', d, 'coretax-agent.log')));
async function logFile() {
    if (process.env.TAXIO_PILOT_LOG) return process.env.TAXIO_PILOT_LOG;
    try { const r = await call('GET', '/api/log-file'); if (r && r.path && fs.existsSync(r.path)) return r.path; } catch (e) { /* Pilot lama / tidak berjalan */ }
    const found = LOG_GUESSES.filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return found[0] || LOG_GUESSES[0];
}

function callOnce(method, p, body, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        let t;
        try { t = target(); } catch (e) { return reject(e); }
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
        if (t.token) headers.Authorization = 'Bearer ' + t.token;
        const req = http.request({ host: t.host, port: t.port, path: p, method, timeout: timeoutMs, headers }, (res) => {
            let s = ''; res.setEncoding('utf8'); res.on('data', (d) => { s += d; });
            res.on('end', () => {
                let j = null; try { j = JSON.parse(s); } catch (e) {}
                if (res.statusCode === 401) { const e = new Error('Taxio Pilot menolak token (Pilot baru dibuka ulang?). ' + ((j && j.error) || '')); e.unauthorized = true; return reject(e); }
                if (res.statusCode >= 400) reject(new Error((j && j.error) || ('HTTP ' + res.statusCode))); else resolve(j ?? s);
            });
        });
        req.on('timeout', () => req.destroy(new Error('Taxio Pilot tidak menjawab (timeout).')));
        req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? NOT_RUNNING + ' (tidak ada yang menjawab di port ' + t.port + ')' : e.message)));
        if (data) req.write(data); req.end();
    });
}
/** Satu kali coba ulang bila token ditolak: Pilot bisa baru saja dibuka ulang dan menulis runtime.json baru. */
async function call(method, p, body, timeoutMs) {
    try { return await callOnce(method, p, body, timeoutMs); }
    catch (e) {
        if (!e.unauthorized) throw e;
        await new Promise((r) => setTimeout(r, 500));
        return callOnce(method, p, body, timeoutMs);
    }
}

/** Entity from Pilot's list (Taxio Hub), with its primary Coretax PIC filled in (what the Pilot GUI sends). */
/** Entitas dicari di mode group lalu personal (entitas pribadi / mode Me), cocok kode, NPWP, atau nama. */
async function entityOf(code) {
    const want = String(code || '').trim().toUpperCase(), digits = want.replace(/\D/g, '');
    let e = null;
    for (const mode of ['group', 'personal']) {
        const list = (await call('GET', '/api/entities?mode=' + mode)).entities || [];
        e = list.find((x) => String(x.entity_id).toUpperCase() === want) || (digits.length >= 15 && list.find((x) => String(x.npwp || '').replace(/\D/g, '').endsWith(digits.slice(-15))))
            || list.find((x) => String(x.entity_name || '').toUpperCase().includes(want));
        if (e) break;
    }
    if (!e) throw new Error('Entitas "' + code + '" tidak ditemukan di Taxio Pilot (mode group maupun personal). Pakai list_entities untuk melihat kodenya.');
    const pic = (e.pics || []).find((p) => p.is_primary) || (e.pics || [])[0];
    if (!pic) throw new Error('Entitas ' + e.entity_id + ' belum punya PIC Coretax tertaut.');
    return { ...e, pic_id: pic.pic_id, pic_name: pic.pic_name };
}
/** Kunci proses + antrean dari balasan aksi latar Pilot (sejak 4.x: beberapa proses per entitas / per PIC bisa berjalan
 *  bersamaan; yang belum mendapat jendela Coretax ANTRE dan mulai sendiri). */
const runRef = (r) => (r && r.run ? { key: 'run:' + r.run, ...(r.queued ? { queued: true, position: r.position, queueNote: 'Antre: mulai sendiri begitu jendela Coretax bebas (stop_run dengan key ini membatalkannya).' } : {}) } : {});
const year4 = (y) => { const s = String(y || new Date().getFullYear()); if (!/^20\d{2}$/.test(s)) throw new Error('Tahun tidak valid: ' + y); return s; };

const TOOLS = [
    { name: 'pilot_status', description: 'Status Taxio Pilot di PC ini: versi, apakah perlu update, dan akun Taxio Hub yang terhubung. Panggil dulu bila tool lain gagal.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({ version: await call('GET', '/api/version'), session: await call('GET', '/api/session') }) },
    { name: 'list_entities', description: 'Daftar entitas (klien) yang bisa diotomasi Taxio Pilot beserta kode entitas, NPWP, PIC Coretax, dan Folder Tax Server. Kode entitas (mis. GMF) dipakai tool lain.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Saring nama / kode / NPWP (opsional).' }, mode: { type: 'string', enum: ['all', 'group', 'personal'], description: 'all (default) = grup dan pribadi; group = entitas grup; personal = entitas pribadi (mode Me).' } } },
        run: async ({ query, mode }) => {
            const modes = mode === 'personal' || mode === 'group' ? [mode] : ['group', 'personal'];
            const list = [];
            for (const m of modes) for (const e of (await call('GET', '/api/entities?mode=' + m)).entities || []) if (!list.some((x) => x.entity_id === e.entity_id)) list.push({ ...e, _mode: m });
            const q = String(query || '').toLowerCase();
            return list.filter((e) => !q || [e.entity_id, e.entity_name, e.npwp].join(' ').toLowerCase().includes(q))
                .map((e) => ({ code: e.entity_id, name: e.entity_name, mode: e._mode, npwp: e.npwp, taxserver_folder: e.taxserver_folder || '', pics: (e.pics || []).map((p) => p.pic_name + (p.is_primary ? ' (utama)' : '')) }));
        } },
    { name: 'a1_status', description: 'Status Rekap PPh 21 Setahun (Mode A1) satu entitas: folder tujuan (A1 preparation), Excel rekap yang ada, dan per masa apakah data & PDF SPT sudah ada (dipakai ulang) atau akan diunduh. Hanya membaca; tidak membuka Coretax.',
        inputSchema: { type: 'object', required: ['entity'], properties: { entity: { type: 'string', description: 'Kode entitas, mis. GMF.' }, year: { type: 'integer', description: 'Tahun pajak, default tahun ini.' } } },
        run: async ({ entity, year }) => {
            const e = await entityOf(entity), y = year4(year);
            const r = await call('POST', '/api/a1/inspect', { entity: e, year: y });
            return { entity: e.entity_id + ' - ' + e.entity_name, year: y, folder: r.a1Dir, taxServerFolder: r.taxServer, excel: r.excel, excelError: r.excelError || null,
                months: (r.rows || []).map((x) => ({ masa: x.masa, data: x.cache ? 'cache, pembetulan ' + x.cache.revision : x.excel ? x.excel.data + (x.excel.revision != null ? ' (pembetulan ' + x.excel.revision + ')' : '') : '-', pdf: !!x.pdf })) };
        } },
    { name: 'run_mode_a1', description: 'Jalankan Rekap PPh 21 Setahun (Mode A1) di Taxio Pilot untuk satu entitas: login Coretax dengan PIC utama, unduh SPT PPh 21 yang belum ada / ada pembetulan baru, susun Excel rekap di folder A1 preparation, cek e-Bupot vs SPT. PERHATIAN: dapat MEMBATALKAN BPMP bernilai 0 di ujung masa kerja di e-Bupot Coretax (tercatat di sheet Pembetulan). Minta konfirmasi pengguna dulu. Berjalan di latar - pantau dengan read_log.',
        inputSchema: { type: 'object', required: ['entity'], properties: { entity: { type: 'string', description: 'Kode entitas, mis. GMF.' }, year: { type: 'integer', description: 'Tahun pajak (>= 2025), default tahun ini.' }, fresh: { type: 'boolean', description: 'true = unduh ulang semua masa; default false (lanjutkan).' } } },
        run: async ({ entity, year, fresh }) => {
            const e = await entityOf(entity), y = year4(year);
            const r = await call('POST', '/api/actions/download-spt', { entity: e, a1Year: y, a1Fresh: !!fresh });
            return { started: !!(r && r.started), ...runRef(r), entity: e.entity_id + ' - ' + e.entity_name, year: y, pic: e.pic_name, note: 'Berjalan di Taxio Pilot. Pantau dengan read_log (entity ' + e.entity_id + ') sampai muncul "Mode A1: ... selesai" atau "SELESAI".' };
        } },
    { name: 'make_bpa1_xml', description: 'Buat file XML impor BPA1 Desember dari sheet Draft SPT Desember rekap Mode A1 terakhir entitas (Status PTKP dan Gaji wajib terisi). Hanya membuat file; tidak mengirim apa pun ke Coretax.',
        inputSchema: { type: 'object', required: ['entity'], properties: { entity: { type: 'string' }, year: { type: 'integer' }, outDir: { type: 'string', description: 'Folder simpan XML (opsional, default di samping Excel rekap).' } } },
        run: async ({ entity, year, outDir }) => {
            const e = await entityOf(entity), y = year4(year);
            const i = await call('POST', '/api/a1/inspect', { entity: e, year: y });
            if (!i.excel) throw new Error('Belum ada Excel rekap ' + y + ' untuk ' + e.entity_id + ' - jalankan run_mode_a1 dulu.');
            return await call('POST', '/api/a1/bpa1-xml', { filePath: i.excel, year: y, outDir: outDir || undefined });
        } },
    { name: 'inspect_import_file', description: 'Periksa file impor e-Bupot (Excel template impor DJP dengan XML map, atau XML) tanpa membuka Coretax: jenis (BPMP/BP21/BPA1/BPPU), jumlah bukti potong, masa, NPWP pemotong, dan masalah data. Panggil sebelum upload_ebupot.',
        inputSchema: { type: 'object', required: ['filePath'], properties: { filePath: { type: 'string', description: 'Path lengkap file .xlsx / .xml di PC ini.' }, entity: { type: 'string', description: 'Kode entitas (opsional) - untuk mencocokkan NPWP pemotong.' } } },
        run: async ({ filePath, entity }) => call('POST', '/api/import/inspect', { filePath, entity: entity ? await entityOf(entity) : undefined }) },
    { name: 'upload_ebupot', description: 'Unggah file impor e-Bupot (BPMP, BP21, BPA1, BPPU; Excel template DJP atau XML) ke Belum Terbit Coretax untuk satu entitas, lalu tunggu hasil XML monitoring. TIDAK menerbitkan / menandatangani. PERHATIAN: membuat data nyata di Coretax - tampilkan hasil inspect_import_file dan minta konfirmasi pengguna dulu. Berjalan di latar - pantau dengan read_log.',
        inputSchema: { type: 'object', required: ['entity', 'filePath'], properties: { entity: { type: 'string', description: 'Kode entitas, mis. GMF.' }, filePath: { type: 'string', description: 'Path lengkap file .xlsx / .xml.' }, proceed: { type: 'boolean', description: 'Default false: Pilot mengecek NIK/NPWP penerima ke Coretax dulu (maks 30 nomor). Bila ada yang tidak dikenal Coretax (akan diganti NIK sementara 9990000000999000), upload BELUM dijalankan - tunjukkan daftarnya dan TANYAKAN pengguna lanjut atau tidak. Panggil lagi dengan proceed=true hanya bila pengguna memilih lanjut.' } } },
        run: async ({ entity, filePath, proceed }) => {
            const e = await entityOf(entity);
            if (!proceed) {
                const c = await call('POST', '/api/import/check-nik', { entity: e, filePath }, 420000);
                if (c && c.unknown && c.unknown.length) return { uploaded: false, needsConfirmation: true, entity: e.entity_id + ' - ' + e.entity_name, unknown: c.unknown.map((x) => ({ id: x.id, coretax: x.error })), note: c.unknown.length + ' NIK/NPWP tidak dikenal Coretax: bila di-upload, bukti potongnya memakai NIK sementara 9990000000999000 (nama "PENERIMA PENGHASILAN#NIK") dan perlu dibetulkan kemudian. Tanyakan pengguna: lanjut upload (panggil lagi dengan proceed=true) atau perbaiki NIK di file dulu. Untuk upload PENGGANTI (sesudah batal / ganti identitas), sebaiknya JANGAN lanjut sebelum NIK benar.' };
                if (c && c.checked === false && c.note) var nikNote = c.note;
            }
            const r = await call('POST', '/api/actions/import-coretax', { entity: e, filePath, skipNikCheck: true });
            return { started: !!(r && r.started), ...runRef(r), entity: e.entity_id + ' - ' + e.entity_name, type: r && r.type, count: r && r.count, ...(typeof nikNote !== 'undefined' && nikNote ? { nikCheck: nikNote } : {}), note: 'Pantau dengan read_log (entity ' + e.entity_id + ') sampai "SELESAI:" atau "GAGAL:".' };
        } },
    { name: 'preview_issue_ebupot', description: 'Pratinjau terbitkan: daftar bukti potong Belum Terbit satu jenis & masa untuk satu entitas (penerima, bruto, PPh, total) dan KODE KONFIRMASI. Hanya membaca. Tampilkan ringkasan + totalnya ke pengguna dan minta persetujuan eksplisit sebelum issue_ebupot.',
        inputSchema: { type: 'object', required: ['entity', 'type', 'period'], properties: { entity: { type: 'string' }, type: { type: 'string', enum: ['mp', 'bp21', 'bpa1', 'bpu'], description: 'mp = BPMP, bp21 = BP21, bpa1 = BPA1, bpu = BPPU.' }, period: { type: 'string', description: 'Masa, mis. 1026 (MMYY). BPA1: masa akhir.' } } },
        run: async ({ entity, type, period }) => {
            const e = await entityOf(entity);
            const p = await call('POST', '/api/ebupot/issue-preview', { entity: e, type, period });
            return { entity: e.entity_id + ' - ' + e.entity_name, ...p, slips: (p.slips || []).slice(0, 60), slipsShown: Math.min(60, (p.slips || []).length) };
        } },
    { name: 'issue_ebupot', description: 'TERBITKAN bukti potong Belum Terbit (BPMP tanpa tanda tangan; BP21/BPA1/BPPU ditandatangani dengan passphrase PIC tersimpan di Pilot). TIDAK BISA DIBATALKAN dengan mudah. Panggil HANYA sesudah preview_issue_ebupot ditunjukkan ke pengguna DAN pengguna menyetujui secara eksplisit di percakapan ini; pakai kode konfirmasi dari pratinjau itu (ditolak bila daftar berubah). Lapor SPT tidak termasuk. Pantau dengan read_log.',
        inputSchema: { type: 'object', required: ['entity', 'type', 'period', 'token'], properties: { entity: { type: 'string' }, type: { type: 'string', enum: ['mp', 'bp21', 'bpa1', 'bpu'] }, period: { type: 'string' }, token: { type: 'string', description: 'Kode konfirmasi dari preview_issue_ebupot.' } } },
        run: async ({ entity, type, period, token }) => {
            const e = await entityOf(entity);
            const r = await call('POST', '/api/actions/issue-ebupot', { entity: e, type, period, token });
            return { started: !!(r && r.started), ...runRef(r), entity: e.entity_id + ' - ' + e.entity_name, type, period, note: 'Pantau dengan read_log (entity ' + e.entity_id + ') sampai "SELESAI:" atau "GAGAL terbitkan".' };
        } },
    { name: 'create_konsep_spt', description: 'Buat Konsep SPT Masa di Coretax (PPh 21/26 atau PPh Unifikasi) untuk satu entitas dan masa; Normal atau Pembetulan dipilih otomatis sesuai Coretax. Tidak melapor / menandatangani. PERHATIAN: membuat konsep nyata - minta konfirmasi pengguna dulu. Pantau dengan read_log.',
        inputSchema: { type: 'object', required: ['entity', 'type', 'period'], properties: { entity: { type: 'string' }, type: { type: 'string', enum: ['pph21', 'unifikasi'] }, period: { type: 'string', description: 'Masa pajak, mis. 1026 (MMYY) atau 102026.' } } },
        run: async ({ entity, type, period }) => {
            const e = await entityOf(entity);
            const r = await call('POST', '/api/actions/create-konsep', { entity: e, taxType: type === 'unifikasi' ? 'ICT_WT' : 'ICT_WIT', period });
            return { started: !!(r && r.started), ...runRef(r), entity: e.entity_id + ' - ' + e.entity_name, type, period, note: 'Pantau dengan read_log (entity ' + e.entity_id + ').' };
        } },
    { name: 'konsep_spt_download', description: 'Unduh Konsep SPT Masa (PPh 21/26 atau Unifikasi) untuk diperiksa: lampiran lewat alat unduh SPT Pilot (PDF + Excel) dan Induk dibuat ulang dari data konsep, digabung jadi satu PDF bertanda KONSEP. post=true menjalankan Posting SPT dulu (mengisi konsep dari bukti potong Telah Terbit; mengubah draft, minta konfirmasi pengguna). Tidak menandatangani / melapor. Pantau dengan read_log.',
        inputSchema: { type: 'object', required: ['entity', 'type', 'period'], properties: { entity: { type: 'string' }, type: { type: 'string', enum: ['pph21', 'unifikasi'] }, period: { type: 'string', description: 'Masa, mis. 1026.' }, post: { type: 'boolean', description: 'Posting dulu (default false).' } } },
        run: async ({ entity, type, period, post }) => {
            const e = await entityOf(entity);
            const r = await call('POST', '/api/actions/konsep-download', { entity: e, taxType: type === 'unifikasi' ? 'ICT_WT' : 'ICT_WIT', period, post: !!post });
            return { started: !!(r && r.started), ...runRef(r), entity: e.entity_id + ' - ' + e.entity_name, type, period, post: !!post, note: 'Pantau dengan read_log (entity ' + e.entity_id + ') sampai "SELESAI:" (berisi path PDF & Excel) atau "GAGAL:".' };
        } },
    { name: 'find_ebupot', description: 'Cari bukti potong satu jenis & masa di Coretax (BPMP, BP21, BP26, BPA1, BPA2, BPPU, BPNR, SP, CY; Telah Terbit atau Belum Terbit): nomor, NIK, nama, PTKP, kode objek, bruto/DPP, tarif, PPh, dokumen, status, sudah dilaporkan di SPT. Saring NIK / nama / nomor. Hanya membaca. Pakai sebelum mengubah atau membatalkan.',
        inputSchema: { type: 'object', required: ['entity', 'period'], properties: { entity: { type: 'string' }, type: { type: 'string', enum: ['mp', 'bp21', 'bp26', 'bpa1', 'bpa2', 'bpu', 'bpnr', 'sp', 'cy'], description: 'mp = BPMP (default), bp21, bp26, bpa1, bpa2, bpu = BPPU, bpnr, sp, cy.' }, period: { type: 'string', description: 'Masa, mis. 1026 (MMYY). BPA1/BPA2: masa akhir.' }, issued: { type: 'boolean', description: 'true = Telah Terbit (default), false = Belum Terbit.' }, nik: { type: 'string' }, name: { type: 'string', description: 'Sebagian nama.' }, numbers: { type: 'array', items: { type: 'string' }, description: 'Nomor bukti potong.' }, detail: { type: 'boolean', description: 'Buka detail tiap bukti potong (PTKP, posisi, dll.) walau hasilnya banyak.' } } },
        run: async ({ entity, ...q }) => { const e = await entityOf(entity); return { entity: e.entity_id + ' - ' + e.entity_name, ...(await call('POST', '/api/ebupot/find', { entity: e, ...q })) }; } },
    { name: 'preview_amend_ebupot', description: 'Pratinjau PEMBETULAN bukti potong Telah Terbit, SEMUA jenis (nomor tetap, status jadi Pembetulan). `changes` per nomor: {number, period, fields:{isian Coretax: nilai}} - mis. BPMP {TaxExemptionStatus:"K1", TaxRate:0.5}; BP21 {TaxBase, TaxRate, IncomeTax, DocumentNumber}; BPPU {TaxBase, TaxRate, DocumentNumber, DocumentDate}; BPA1 {GrossIncomeSalary, ..., Article21TaxWithheld}. Alias: ptkp, gross (bruto/DPP jenis itu), rate, tax (PPh jenis itu), position, document, documentDate. Lihat isian yang ada dengan find_ebupot detail=true. BPMP juga bisa `filePath` file revisi (XML / Excel template impor; cocok per NIK + kode objek). PPh dihitung otomatis untuk BPMP (TER), BPPU, CY (bulat dasar x tarif / 100); jenis lain: sebutkan PPh-nya (BPA1/BPA2 beserta isian turunannya). Identitas, masa, kode objek tidak bisa diubah di sini. Jenis bertanda tangan (BP21, BP26, BPA1, BPA2, BPPU, BPNR) diuji ke pemeriksaan Coretax (/validate, tidak disimpan) per bukti potong. Hasil: sebelum -> sesudah, total PPh, yang dilewati/ditolak, KODE KONFIRMASI. Hanya membaca. Pemakaian pertama per jenis: sarankan SATU bukti potong dulu, cek di Coretax, baru sisanya.',
        inputSchema: { type: 'object', required: ['entity'], properties: { entity: { type: 'string' }, type: { type: 'string', enum: ['mp', 'bp21', 'bp26', 'bpa1', 'bpa2', 'bpu', 'bpnr', 'sp', 'cy'], description: 'mp = BPMP (default), bp21, bp26, bpa1, bpa2, bpu = BPPU, bpnr, sp, cy.' }, filePath: { type: 'string', description: 'BPMP: file revisi .xml / .xlsx.' }, changes: { type: 'array', items: { type: 'object', required: ['number', 'period'], properties: { number: { type: 'string' }, period: { type: 'string', description: 'MMYY (BPA1/BPA2: masa akhir)' }, fields: { type: 'object', description: 'Isian Coretax yang diubah.' }, ptkp: { type: 'string' }, gross: { type: 'number' }, rate: { type: 'number' }, tax: { type: 'number' }, position: { type: 'string' } } } } } },
        run: async ({ entity, type, filePath, changes }) => { const e = await entityOf(entity); return { entity: e.entity_id + ' - ' + e.entity_name, ...(await call('POST', '/api/ebupot/amend-preview', { entity: e, type, filePath, changes })) }; } },
    { name: 'amend_ebupot', description: 'KIRIM pembetulan sesuai preview_amend_ebupot (jenis bertanda tangan ditandatangani dengan passphrase PIC tersimpan di Pilot). Panggil HANYA sesudah pratinjau ditunjukkan ke pengguna DAN pengguna menyetujui secara eksplisit. Cukup entity + token (kode konfirmasi): jenis dan perubahan diambil dari pratinjau itu di Pilot (ditolak bila Coretax berubah atau jenis yang disebut berbeda). Tiap bukti potong dicadangkan, diperiksa sesudah kirim, berhenti di kegagalan pertama. Pantau dengan read_log sampai "SELESAI:" / "GAGAL:".',
        inputSchema: { type: 'object', required: ['entity', 'token'], properties: { entity: { type: 'string' }, type: { type: 'string', enum: ['mp', 'bp21', 'bp26', 'bpa1', 'bpa2', 'bpu', 'bpnr', 'sp', 'cy'] }, token: { type: 'string' }, filePath: { type: 'string' }, changes: { type: 'array', items: { type: 'object' } } } },
        run: async ({ entity, type, token, filePath, changes }) => { const e = await entityOf(entity); const r = await call('POST', '/api/actions/ebupot-amend', { entity: e, type, token, filePath, changes }); return { started: !!(r && r.started), ...runRef(r), entity: e.entity_id + ' - ' + e.entity_name, note: 'Pantau dengan read_log (entity ' + e.entity_id + ').' }; } },
    { name: 'preview_cancel_ebupot', description: 'Pratinjau PEMBATALAN bukti potong Telah Terbit (semua jenis) satu masa per nomor: daftar, total PPh, yang sudah dilaporkan di SPT, perlu tanda tangan atau tidak, dan KODE KONFIRMASI. Hanya membaca. Untuk koreksi nilai lebih baik preview_amend_ebupot (nomor tetap, tanpa upload ulang).',
        inputSchema: { type: 'object', required: ['entity', 'period', 'numbers'], properties: { entity: { type: 'string' }, type: { type: 'string', enum: ['mp', 'bp21', 'bp26', 'bpa1', 'bpa2', 'bpu', 'bpnr', 'sp', 'cy'], description: 'mp = BPMP (default), bp21, bp26, bpa1, bpa2, bpu = BPPU, bpnr, sp, cy.' }, period: { type: 'string' }, numbers: { type: 'array', items: { type: 'string' } } } },
        run: async ({ entity, type, period, numbers }) => { const e = await entityOf(entity); return { entity: e.entity_id + ' - ' + e.entity_name, ...(await call('POST', '/api/ebupot/cancel-preview', { entity: e, type, period, numbers })) }; } },
    { name: 'cancel_ebupot', description: 'BATALKAN bukti potong Telah Terbit sesuai preview_cancel_ebupot (tidak bisa dikembalikan - harus dibuat ulang; jenis bertanda tangan memakai passphrase PIC). Panggil HANYA sesudah pratinjau ditunjukkan DAN pengguna menyetujui eksplisit. Cukup entity + token: jenis, masa dan nomor diambil dari pratinjau itu. Jenis bertanda tangan bisa diproses Coretax beberapa menit: status DIPROSES = cek lagi dengan find_ebupot sebelum menerbitkan pengganti. Urutan aman ganti identitas/masa: check_nik NIK baru -> upload pengganti -> pratinjau terbit -> batalkan yang lama -> terbitkan. Pantau dengan read_log.',
        inputSchema: { type: 'object', required: ['entity', 'token'], properties: { entity: { type: 'string' }, type: { type: 'string', enum: ['mp', 'bp21', 'bp26', 'bpa1', 'bpa2', 'bpu', 'bpnr', 'sp', 'cy'] }, period: { type: 'string' }, numbers: { type: 'array', items: { type: 'string' } }, token: { type: 'string' } } },
        run: async ({ entity, type, period, numbers, token }) => { const e = await entityOf(entity); const r = await call('POST', '/api/actions/ebupot-cancel', { entity: e, type, period, numbers, token }); return { started: !!(r && r.started), ...runRef(r), entity: e.entity_id + ' - ' + e.entity_name, note: 'Pantau dengan read_log (entity ' + e.entity_id + ').' }; } },
    { name: 'check_nik', description: 'Cek NIK / NPWP di Coretax (sama dengan formulir Coretax): terdaftar + nama resmi, atau tidak ditemukan. Hanya membaca. WAJIB sebelum membuat bukti potong pengganti dengan NIK baru: NIK yang tidak dikenal Coretax akan diganti NIK sementara 9990000000999000 (nama "PENERIMA PENGHASILAN#NIK").',
        inputSchema: { type: 'object', required: ['entity', 'ids'], properties: { entity: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, description: 'NIK / NPWP 16 digit (maks 300).' } } },
        run: async ({ entity, ids }) => { const e = await entityOf(entity); return { entity: e.entity_id + ' - ' + e.entity_name, ...(await call('POST', '/api/ebupot/check-nik', { entity: e, ids })) }; } },
    { name: 'record_coretax', description: 'Rekam permintaan API Coretax di jendela PIC selama pengguna mengerjakan satu aksi secara MANUAL (fitur Coretax yang belum ada di Pilot, atau bila pembetulan / batal suatu jenis ditolak dan perlu dicek format aslinya). Token sesi dan passphrase tidak disimpan. Hasilnya (file JSON lokal) dipakai pengembang Pilot untuk membuat otomasinya. Selesai otomatis setelah `minutes` atau saat stop_run.',
        inputSchema: { type: 'object', required: ['entity'], properties: { entity: { type: 'string' }, minutes: { type: 'integer', description: '1-30, default 10.' }, note: { type: 'string', description: 'Label file, mis. "ubah BP21".' } } },
        run: async ({ entity, minutes, note }) => { const e = await entityOf(entity); const r = await call('POST', '/api/actions/coretax-record', { entity: e, minutes, note }); return { started: !!(r && r.started), ...runRef(r), file: r && r.file, note: 'Minta pengguna mengerjakan aksinya di jendela Coretax entitas ini sekarang; pantau read_log.' }; } },
    { name: 'run_status', description: 'Proses di Taxio Pilot: yang berjalan, yang ANTRE menunggu jendela Coretax bebas (posisi), dan yang terakhir selesai. Satu entitas / satu PIC bisa punya beberapa proses sekaligus (jendela berbeda) - tiap proses punya key (run:<id>) untuk stop_run / read_log.',
        inputSchema: { type: 'object', properties: { entity: { type: 'string', description: 'Saring ke kode entitas (opsional).' } } },
        run: async ({ entity } = {}) => {
            const s = await call('GET', '/api/run/status'), want = String(entity || '').toUpperCase();
            return ((s && s.runs) || []).filter((r) => !want || String(r.tag || '').toUpperCase() === want).map((r) => ({
                key: r.id ? 'run:' + r.id : r.key, entity: r.tag, label: r.label || r.lastLabel, feature: r.feature || '', active: !!r.active, queued: !!r.queued,
                ...(r.queued ? { position: r.position } : {}), window: r.window || null, paused: !!r.paused, hold: r.holdReason || (r.held ? 'ditahan - butuh keputusan' : ''),
                // Kontrol yang benar-benar dikerjakan fitur proses ini (Pilot 4.x; lib/run-controls.js) + permintaan yang belum
                // sampai di titik aman (berhenti / jeda setelah langkah saat ini selesai).
                ...(r.controls ? { controls: r.controls, stopping: !!r.stopRequested, pausing: !!r.pauseRequested } : {})
            }));
        } },
    { name: 'stop_run', description: 'Hentikan proses Pilot (berhenti setelah langkah saat ini selesai) atau batalkan proses yang masih antre. Sebut entity; bila entitas itu punya lebih dari satu proses aktif, sebut juga key dari run_status (ditolak dengan daftarnya bila ambigu).',
        inputSchema: { type: 'object', properties: { entity: { type: 'string', description: 'Kode entitas (tag di log).' }, key: { type: 'string', description: 'Key proses dari run_status (run:<id>) - wajib bila entitas punya beberapa proses aktif.' } } },
        run: async ({ entity, key }) => {
            const s = await call('GET', '/api/run/status'), want = String(entity || '').toUpperCase();
            const active = ((s && s.runs) || []).filter((r) => r.active);
            const keyOf = (r) => (r.id ? 'run:' + r.id : r.key);
            let run;
            if (key) {
                run = active.find((r) => keyOf(r) === key || r.key === key);
                if (!run) throw new Error('Tidak ada proses aktif dengan key ' + key + '.');
                if (want && String(run.tag || '').toUpperCase() !== want) throw new Error('Proses ' + key + ' milik ' + run.tag + ', bukan ' + entity + '.');
            } else {
                if (!want) throw new Error('Sebut entity (atau key dari run_status).');
                const mine = active.filter((r) => String(r.tag || '').toUpperCase() === want);
                if (!mine.length) throw new Error('Tidak ada proses aktif untuk ' + entity + '.');
                if (mine.length > 1) throw new Error(entity + ' punya ' + mine.length + ' proses aktif - sebut key yang mau dihentikan: ' + mine.map((r) => keyOf(r) + ' = "' + r.label + '"' + (r.queued ? ' (antre)' : '')).join('; ') + '.');
                run = mine[0];
            }
            await call('POST', '/api/run/stop?session=' + encodeURIComponent(keyOf(run)), {});
            return { stopping: !run.queued, cancelled: !!run.queued, key: keyOf(run), entity: run.tag, label: run.label };
        } },
    { name: 'read_log', description: 'Baris terakhir log aktivitas Taxio Pilot (progres dan hasil otomasi), bisa disaring per kode entitas, atau per proses dengan key dari run_status / balasan aksi (perlu bila satu entitas menjalankan beberapa proses sekaligus - baris mereka berlabel kode entitas yang sama).',
        inputSchema: { type: 'object', properties: { entity: { type: 'string', description: 'Kode entitas untuk disaring (opsional).' }, key: { type: 'string', description: 'Key proses (run:<id>) - hanya baris proses itu (Pilot 4.x yang sedang berjalan).' }, lines: { type: 'integer', description: 'Jumlah baris (default 40, maks 300).' } } },
        run: async ({ entity, key, lines }) => {
            if (key) {
                const r = await call('GET', '/api/run/log?session=' + encodeURIComponent(key) + '&lines=' + Math.min(300, Math.max(1, lines || 40)));
                return [r.label + (r.active ? ' (aktif)' : ' (selesai)') + ' - ' + r.key].concat(r.lines || []).join('\n');
            }
            const LOG = await logFile();
            if (!fs.existsSync(LOG)) throw new Error('Log Taxio Pilot tidak ditemukan di ' + LOG + ' (atur TAXIO_PILOT_LOG).');
            const size = fs.statSync(LOG).size, fd = fs.openSync(LOG, 'r'), len = Math.min(size, 400000), buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
            let rows = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
            if (entity) rows = rows.filter((l) => l.includes('[' + String(entity).toUpperCase() + ']'));
            return rows.slice(-Math.min(300, Math.max(1, lines || 40))).join('\n');
        } }
];

// ---- JSON-RPC over stdio ----
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
async function handle(msg) {
    const { id, method, params } = msg;
    if (id === undefined) return; // notification (initialized, cancelled, ...)
    try {
        if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'taxio-pilot', version: VERSION },
            instructions: 'Taxio Pilot otomatisasi Coretax DJP di PC pengguna. Mulai dengan pilot_status / list_entities. run_mode_a1, upload_ebupot, issue_ebupot dan create_konsep_spt mengubah data di Coretax (berjalan di latar) - minta konfirmasi dulu, lalu pantau dengan read_log. Upload: inspect_import_file dulu. Terbitkan: preview_issue_ebupot, tunjukkan, tunggu persetujuan, lalu issue_ebupot dengan kodenya. Lapor SPT selalu manual.' } });
        if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
        if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
        if (method === 'tools/call') {
            const t = TOOLS.find((x) => x.name === (params && params.name));
            if (!t) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool tidak dikenal: ' + (params && params.name) } });
            try {
                const out = await t.run((params && params.arguments) || {});
                return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] } });
            } catch (e) { return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } }); }
        }
        if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } });
        if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
}
let buf = '';
const pending = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let msg; try { msg = JSON.parse(line); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; } const p = handle(msg); pending.add(p); p.finally(() => pending.delete(p)); } });
// Klien menutup stdin: selesaikan panggilan yang masih berjalan dulu.
process.stdin.on('end', () => Promise.allSettled([...pending]).then(() => process.exit(0)));
