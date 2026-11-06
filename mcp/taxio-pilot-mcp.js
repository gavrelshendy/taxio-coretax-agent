#!/usr/bin/env node
/* Taxio Pilot MCP server - lets Claude Desktop (or any MCP client) use Taxio Pilot's local API directly instead of
 * operating the screen. Stdio transport, JSON-RPC 2.0, one message per line; no dependencies.
 *
 * Talks only to Taxio Pilot on this PC (http://127.0.0.1:51733 - Pilot must be running and connected to Taxio Hub).
 * Coretax logins, passphrases and sessions stay inside Pilot; nothing here stores or prints them.
 *
 * Claude Desktop config (claude_desktop_config.json):
 *   { "mcpServers": { "taxio-pilot": { "command": "node", "args": ["<path>\\mcp\\taxio-pilot-mcp.js"] } } }
 * Optional env: TAXIO_PILOT_URL (default http://127.0.0.1:51733), TAXIO_PILOT_LOG (path of coretax-agent.log). */
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = new URL(process.env.TAXIO_PILOT_URL || 'http://127.0.0.1:51733');
const LOG = process.env.TAXIO_PILOT_LOG || path.join(__dirname, '..', 'dist', 'coretax-agent.log');
const VERSION = '1.0.0';

function call(method, p, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({ host: BASE.hostname, port: BASE.port, path: p, method, timeout: 120000,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
            let s = ''; res.setEncoding('utf8'); res.on('data', (d) => { s += d; });
            res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} if (res.statusCode >= 400) reject(new Error((j && j.error) || ('HTTP ' + res.statusCode))); else resolve(j ?? s); });
        });
        req.on('timeout', () => req.destroy(new Error('Taxio Pilot tidak menjawab (timeout).')));
        req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'Taxio Pilot tidak berjalan di ' + BASE.origin + ' - buka Taxio Pilot dulu.' : e.message)));
        if (data) req.write(data); req.end();
    });
}

/** Entity from Pilot's list (Taxio Hub), with its primary Coretax PIC filled in (what the Pilot GUI sends). */
async function entityOf(code, mode = 'group') {
    const list = (await call('GET', '/api/entities?mode=' + encodeURIComponent(mode))).entities || [];
    const want = String(code || '').trim().toUpperCase();
    const e = list.find((x) => String(x.entity_id).toUpperCase() === want) || list.find((x) => String(x.entity_name || '').toUpperCase().includes(want));
    if (!e) throw new Error('Entitas "' + code + '" tidak ditemukan di Taxio Pilot (mode ' + mode + '). Pakai list_entities untuk melihat kodenya.');
    const pic = (e.pics || []).find((p) => p.is_primary) || (e.pics || [])[0];
    if (!pic) throw new Error('Entitas ' + e.entity_id + ' belum punya PIC Coretax tertaut.');
    return { ...e, pic_id: pic.pic_id, pic_name: pic.pic_name };
}
const year4 = (y) => { const s = String(y || new Date().getFullYear()); if (!/^20\d{2}$/.test(s)) throw new Error('Tahun tidak valid: ' + y); return s; };

const TOOLS = [
    { name: 'pilot_status', description: 'Status Taxio Pilot di PC ini: versi, apakah perlu update, dan akun Taxio Hub yang terhubung. Panggil dulu bila tool lain gagal.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({ version: await call('GET', '/api/version'), session: await call('GET', '/api/session') }) },
    { name: 'list_entities', description: 'Daftar entitas (klien) yang bisa diotomasi Taxio Pilot beserta kode entitas, NPWP, PIC Coretax, dan Folder Tax Server. Kode entitas (mis. GMF) dipakai tool lain.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Saring nama / kode / NPWP (opsional).' }, mode: { type: 'string', enum: ['group', 'personal'], description: 'group (default) = entitas grup; personal = entitas pribadi (mode Me).' } } },
        run: async ({ query, mode }) => {
            const list = (await call('GET', '/api/entities?mode=' + (mode === 'personal' ? 'personal' : 'group'))).entities || [];
            const q = String(query || '').toLowerCase();
            return list.filter((e) => !q || [e.entity_id, e.entity_name, e.npwp].join(' ').toLowerCase().includes(q))
                .map((e) => ({ code: e.entity_id, name: e.entity_name, npwp: e.npwp, taxserver_folder: e.taxserver_folder || '', pics: (e.pics || []).map((p) => p.pic_name + (p.is_primary ? ' (utama)' : '')) }));
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
            return { started: !!(r && r.started), entity: e.entity_id + ' - ' + e.entity_name, year: y, pic: e.pic_name, note: 'Berjalan di Taxio Pilot. Pantau dengan read_log (entity ' + e.entity_id + ') sampai muncul "Mode A1: ... selesai" atau "SELESAI".' };
        } },
    { name: 'make_bpa1_xml', description: 'Buat file XML impor BPA1 Desember dari sheet Draft SPT Desember rekap Mode A1 terakhir entitas (Status PTKP dan Gaji wajib terisi). Hanya membuat file; tidak mengirim apa pun ke Coretax.',
        inputSchema: { type: 'object', required: ['entity'], properties: { entity: { type: 'string' }, year: { type: 'integer' }, outDir: { type: 'string', description: 'Folder simpan XML (opsional, default di samping Excel rekap).' } } },
        run: async ({ entity, year, outDir }) => {
            const e = await entityOf(entity), y = year4(year);
            const i = await call('POST', '/api/a1/inspect', { entity: e, year: y });
            if (!i.excel) throw new Error('Belum ada Excel rekap ' + y + ' untuk ' + e.entity_id + ' - jalankan run_mode_a1 dulu.');
            return await call('POST', '/api/a1/bpa1-xml', { filePath: i.excel, year: y, outDir: outDir || undefined });
        } },
    { name: 'read_log', description: 'Baris terakhir log aktivitas Taxio Pilot (progres dan hasil otomasi), bisa disaring per kode entitas.',
        inputSchema: { type: 'object', properties: { entity: { type: 'string', description: 'Kode entitas untuk disaring (opsional).' }, lines: { type: 'integer', description: 'Jumlah baris (default 40, maks 300).' } } },
        run: async ({ entity, lines }) => {
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
            instructions: 'Taxio Pilot otomatisasi Coretax DJP di PC pengguna. Mulai dengan pilot_status / list_entities. run_mode_a1 berjalan di latar dan bisa membatalkan BPMP bernilai 0 di Coretax - minta konfirmasi dulu, lalu pantau dengan read_log.' } });
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
