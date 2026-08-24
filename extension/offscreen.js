/* Offscreen document - satu-satunya tempat di extension MV3 yang punya DOM, jadi di sinilah
   blob URL bisa dibuat dan PDF bisa digabung.

   Kenapa perlu (bukan sekadar kerumitan tambahan):
     1. NAMA FILE. Sebelumnya PDF dikirim ke chrome.downloads sebagai `data:` URL, dan hasilnya
        Chrome MENGABAIKAN nama file yang diminta - berkas tersimpan sebagai "download(1)",
        "download(2)", dst (dilaporkan langsung oleh user). Dengan blob URL, parameter `filename`
        dihormati sebagaimana mestinya.
     2. UKURAN. `data:` URL membengkak ~33% (base64) dan mentok di batas ukuran Chrome. Berkas
        GABUNGAN bisa 4-5 MB, yang berarti ~6 MB sebagai data URL - besar kemungkinan gagal.
   Service worker MV3 tidak punya URL.createObjectURL sama sekali, makanya harus lewat sini. */

function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function mergePdfs(base64List) {
    const { PDFDocument } = PDFLib;
    const merged = await PDFDocument.create();
    for (const b64 of base64List) {
        const doc = await PDFDocument.load(base64ToBytes(b64));
        const pages = await merged.copyPages(doc, doc.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
    }
    return merged.save(); // Uint8Array
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;
    (async () => {
        try {
            if (msg.type === 'blobUrl') {
                const url = URL.createObjectURL(new Blob([base64ToBytes(msg.base64)], { type: 'application/pdf' }));
                return { ok: true, url };
            }
            if (msg.type === 'mergeToBlobUrl') {
                const bytes = await mergePdfs(msg.list);
                const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
                return { ok: true, url, size: bytes.length };
            }
            if (msg.type === 'revoke') {
                try { URL.revokeObjectURL(msg.url); } catch (e) {}
                return { ok: true };
            }
            return { ok: false, error: 'Perintah offscreen tidak dikenal: ' + msg.type };
        } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
        }
    })().then(sendResponse);
    return true;
});
