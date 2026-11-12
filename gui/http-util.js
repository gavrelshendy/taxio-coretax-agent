/* Pembantu HTTP kecil untuk gui/server.js: balasan JSON, pembaca body JSON, dan berkas statis
   dashboard. Tanpa Express (lihat header gui/server.js). */
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

const BODY_LIMIT = 1e6;
const LARGE_BODY_LIMIT = 20 * 1024 * 1024;

/** Membaca body JSON permintaan. Batas dihitung dalam BYTE (bukan panjang string), dan potongan
 *  digabung sebagai Buffer sebelum didekode supaya karakter UTF-8 yang terbelah di antara dua
 *  potongan tidak rusak. Melewati batas: promise DITOLAK (`tooLarge`) - dulu permintaannya
 *  di-destroy dan promise tidak pernah selesai, sehingga handler menggantung selamanya. Sisa body
 *  dibuang (tidak disimpan) supaya balasan 400 dari handler tetap sampai ke pemanggil. */
function readBody(req, cap, tooLargeMsg) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0, settled = false;
        const fail = (e) => { if (!settled) { settled = true; reject(e); } };
        req.on('data', (c) => {
            if (settled) return;
            const buf = typeof c === 'string' ? Buffer.from(c) : c;
            bytes += buf.length;
            if (bytes > cap) {
                chunks.length = 0;
                const e = new Error(tooLargeMsg); e.tooLarge = true;
                fail(e);
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            const data = Buffer.concat(chunks).toString('utf8');
            try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
        });
        req.on('error', fail);
        req.on('aborted', () => fail(new Error('Permintaan dibatalkan.')));
    });
}
function readJsonBody(req) { return readBody(req, BODY_LIMIT, 'Body terlalu besar.'); }
/** Batas lebih besar dari readJsonBody (1MB) - impor Dividen / Pajak Masukan / rekap mengirim
 *  seluruh .xlsx sebagai base64, bisa beberapa ratus KB; 20MB tetap menahan unggahan yang kebablasan. */
function readLargeJsonBody(req, maxBytes) { return readBody(req, maxBytes || LARGE_BODY_LIMIT, 'File terlalu besar.'); }

function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, buf) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(buf);
    });
}

module.exports = { sendJson, readJsonBody, readLargeJsonBody, serveStatic, PUBLIC_DIR };
