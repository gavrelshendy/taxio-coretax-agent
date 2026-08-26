/* Coretax - Unduh Lampiran SPT (service worker).

   Tiga hal yang tidak bisa dikerjakan content script, jadi dikerjakan di sini:
     1. MENCETAK PDF lewat chrome.debugger -> `Page.printToPDF` (CDP), sama persis dengan yang
        dipakai aplikasi desktop. Konsekuensinya Chrome menampilkan bilah "sedang men-debug
        browser ini"; tidak bisa disembunyikan, makanya debugger di-attach SEKALI di awal dan
        dilepas begitu semua tab selesai.
     2. MENYIMPAN FILE lewat chrome.downloads.
     3. MENGGABUNGKAN PDF - didelegasikan lagi ke offscreen.js (SW MV3 tidak punya DOM).

   preferCSSPageSize:true WAJIB - Coretax mendeklarasikan `@page { size: a3 }` miliknya sendiri
   dan Chrome memprioritaskan CSS @page di atas parameter cetak. content.js meng-inject @page
   landscape sebagai stylesheet terakhir; opsi ini yang membuat Chrome memakainya. Karena ukuran
   & margin datang dari CSS, JANGAN kirim paperWidth/paperHeight/landscape di sini. */

const PRINT_SCALE = 0.9;
const attached = new Set();
// Halaman terkumpul per sesi, untuk dua berkas GABUNGAN di akhir.
const bucket = new Map(); // tabId -> { entity, year, formCode } (halaman PDF disimpan di content script, bukan di sini)

function cdp(target, method, params) {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(target, method, params || {}, (r) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(r);
        });
    });
}
function attach(target) {
    return new Promise((resolve, reject) => {
        chrome.debugger.attach(target, '1.3', () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });
}
function detach(target) {
    return new Promise((resolve) => chrome.debugger.detach(target, () => { void chrome.runtime.lastError; resolve(); }));
}
function download(options) {
    return new Promise((resolve, reject) => {
        chrome.downloads.download(options, (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(id);
        });
    });
}

async function ensureOffscreen() {
    const has = await chrome.offscreen.hasDocument().catch(() => false);
    if (has) return;
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Membuat blob URL dan menggabungkan PDF lampiran SPT.'
    });
}
async function offscreen(msg) {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
    if (!res || !res.ok) throw new Error((res && res.error) || 'Offscreen gagal.');
    return res;
}

/** Menyimpan PDF (base64) dengan nama file yang diminta. Lewat blob URL, BUKAN data URL - lihat
 *  penjelasan di offscreen.js soal nama file yang jadi "download(1)" dan batas ukuran. */
async function saveBase64(base64, filename) {
    const { url } = await offscreen({ type: 'blobUrl', base64 });
    try {
        await download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    } finally {
        // Jangan langsung revoke - Chrome masih membaca blob saat unduhan berjalan.
        setTimeout(() => { offscreen({ type: 'revoke', url }).catch(() => {}); }, 60000);
    }
}

async function printTab(tabId) {
    const res = await cdp({ tabId }, 'Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
        scale: PRINT_SCALE
    });
    if (!res || !res.data) throw new Error('Coretax tidak mengembalikan data PDF.');
    return res.data; // base64
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.target === 'offscreen') return; // bukan untuk kita
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ ok: false, error: 'Tab tidak dikenali.' }); return; }

    (async () => {
        try {
            if (msg.type === 'beginPrintSession') {
                if (!attached.has(tabId)) { await attach({ tabId }); attached.add(tabId); await cdp({ tabId }, 'Page.enable'); }
                bucket.set(tabId, { pages: [], entity: msg.entity, year: msg.year, formCode: msg.formCode, mergeName: msg.mergeName || 'GABUNGAN' });
                return { ok: true };
            }

            if (msg.type === 'printTab') {
                const b64 = await printTab(tabId);
                await saveBase64(b64, msg.filename);
                // base64 DIKEMBALIKAN ke content script - content yang menyimpannya untuk
                // digabung di akhir. Sebelumnya dikumpulkan di Map milik service worker, dan
                // itu TERBUKTI hilang sebelum sesi ditutup (service worker MV3 tidak menjamin
                // state bertahan antar pesan), sehingga berkas gabungan tidak pernah terbuat.
                return { ok: true, b64 };
            }

            if (msg.type === 'captureTab') {
                return { ok: true, b64: await printTab(tabId) };
            }

            if (msg.type === 'saveBase64') {
                await saveBase64(msg.base64, msg.filename);
                return { ok: true };
            }

            if (msg.type === 'endPrintSession') {
                bucket.delete(tabId);
                if (attached.has(tabId)) { attached.delete(tabId); await detach({ tabId }); }
                return { ok: true };
            }

            if (msg.type === 'mergeAndSave') {
                if (msg.returnBase64) {
                    const merged = await offscreen({ type: 'mergeToBase64', list: msg.list });
                    await saveBase64(merged.base64, msg.filename);
                    return { ok: true, b64: merged.base64 };
                }
                const { url } = await offscreen({ type: 'mergeToBlobUrl', list: msg.list });
                await download({ url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' });
                setTimeout(() => { offscreen({ type: 'revoke', url }).catch(() => {}); }, 60000);
                return { ok: true };
            }

            return { ok: false, error: 'Perintah tidak dikenal: ' + msg.type };
        } catch (e) {
            if (msg.type !== 'printTab') {
                if (attached.has(tabId)) { attached.delete(tabId); await detach({ tabId }).catch(() => {}); }
                bucket.delete(tabId);
            }
            return { ok: false, error: e && e.message ? e.message : String(e) };
        }
    })().then(sendResponse);

    return true; // jawaban asinkron
});

chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); bucket.delete(tabId); });
chrome.debugger.onDetach.addListener((s) => { if (s.tabId) attached.delete(s.tabId); });
