/* Coretax Agent - automation Pajak Masukan (pengkreditan faktur masukan).

   Arsitektur: HYBRID IN-PAGE. Browser yang memegang & memperbarui sesi (token Coretax hanya
   hidup 30 menit dan TIDAK punya refresh_token - lihat TEMUAN-INVESTIGASI-PM.md bagian D), sementara
   seluruh operasi dijalankan lewat API Coretax sendiri via fetch() same-origin dari dalam
   halaman. Token dibaca segar dari sessionStorage pada SETIAP panggilan, bukan di-cache, supaya
   silent-renew OIDC milik browser selalu terpakai.

   Semua endpoint/payload di bawah ini diverifikasi live 2026-08-18 (lihat TEMUAN-INVESTIGASI-PM.md).

   CATATAN PENTING - page.evaluate() SELALU memakai STRING, bukan function reference: pkg
   mengompilasi file ini jadi bytecode di exe, yang merusak Function.toString() yang diandalkan
   Playwright untuk menserialisasi fungsi. Pola yang sama dipakai di lib/chrome.js.
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { log } = require('../lib/log');

const API = '/einvoiceportal/api';
const TOKEN_KEY = 'cats-portal-angular-clientuser:https://coretaxdjp.pajak.go.id/identityproviderportal:cats-portal-angular-client';
const INPUT_TAX_URL = 'https://coretaxdjp.pajak.go.id/e-invoice-portal/id-ID/input-tax';

/* Kode masa pajak Coretax. TD.007 + bulan 2 digit - dikonfirmasi live untuk 02-08 dari data
   produksi (tanggal faktur cocok dengan kodenya); 01 dan 09-12 mengikuti pola yang sama. */
const PERIOD_CODE = {};
const PERIOD_MONTH = {};
for (let m = 1; m <= 12; m++) {
    const code = 'TD.007' + String(m).padStart(2, '0');
    PERIOD_CODE[m] = code;
    PERIOD_MONTH[code] = m;
}
const MONTH_ID = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** Status pengkreditan hidup di TaxInvoiceStatus (BUKAN InputInvoiceStatus - itu siklus
 *  dokumen). Diverifikasi live: faktur yang sudah dikreditkan tetap InputInvoiceStatus=APPROVED. */
const STATUS = { APPROVED: 'APPROVED', CREDITED: 'CREDITED', UNCREDITED: 'UNCREDITED' };

/** Buang titik/strip/spasi dari nomor faktur. Coretax menyimpannya sebagai 17 digit polos,
 *  sementara user sering menyalin format lama (010.000-26.12345678), jadi kedua bentuk
 *  dinormalkan ke digit saja sebelum dibandingkan. */
function normalizeFakturNo(v) {
    return String(v == null ? '' : v).replace(/[^0-9]/g, '');
}
function normalizeNpwp(v) {
    return String(v == null ? '' : v).replace(/[^0-9]/g, '');
}
function periodLabel(code, year) {
    const m = PERIOD_MONTH[code];
    return (m ? MONTH_ID[m] : String(code || '-')) + ' ' + (year || '');
}
/** Parse MMYY directly, without routing through a JavaScript Date. This avoids an early-month
 *  value crossing into the previous month when Excel/ExcelJS applies a timezone conversion. */
function parseTargetMasaInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const match = raw.match(/^(0[1-9]|1[0-2])(\d{2})$/);
    if (!match) throw new Error('Masa Pengkreditan harus berformat MMYY, misalnya 0726.');
    const month = Number(match[1]);
    const year = Number('20' + match[2]);
    return { raw: raw, month: month, year: year, code: PERIOD_CODE[month] };
}
/** Jarak bulan dari masa faktur ke masa pengkreditan. */
function monthDistance(fromCode, fromYear, toCode, toYear) {
    const a = PERIOD_MONTH[fromCode], b = PERIOD_MONTH[toCode];
    if (!a || !b) return null;
    return (Number(toYear) * 12 + b) - (Number(fromYear) * 12 + a);
}

/* ------------------------------------------------------------------ *
 *  Jembatan ke API Coretax (dijalankan DI DALAM halaman)
 * ------------------------------------------------------------------ */

/** Membangun string evaluate yang menjalankan satu fetch ke API Coretax.
 *  Token dibaca ulang dari sessionStorage tiap panggilan - jangan pernah di-cache. */
function buildFetchScript(path, bodyObj, timeoutMs) {
    return '(async function(){' +
        'var raw=sessionStorage.getItem(' + JSON.stringify(TOKEN_KEY) + ');' +
        'if(!raw) return {__err:"SESSION_HILANG"};' +
        'var o=JSON.parse(raw);' +
        'if(!o.access_token) return {__err:"TOKEN_KOSONG"};' +
        'if(o.expires_at && (o.expires_at - Date.now()/1000) < 5) return {__err:"TOKEN_KEDALUWARSA"};' +
        'var ctl=new AbortController();' +
        'var timer=setTimeout(function(){ctl.abort();},' + (timeoutMs || 30000) + ');' +
        'try{' +
        '  var r=await fetch(' + JSON.stringify(API + path) + ',{method:"POST",signal:ctl.signal,' +
        '    headers:{"content-type":"application/json",authorization:"Bearer "+o.access_token},' +
        '    body:JSON.stringify(' + JSON.stringify(bodyObj) + ')});' +
        '  var txt=await r.text(); clearTimeout(timer);' +
        '  var j=null; try{ j=JSON.parse(txt); }catch(e){}' +
        '  return {__http:r.status, __json:j, __raw:(j?null:txt.slice(0,400))};' +
        '}catch(e){ clearTimeout(timer); return {__err:e.name+": "+e.message}; }' +
        '})()';
}

/** Ambil identitas WP aktif dari halaman (dipakai sebagai TaxpayerAggregateIdentifier).
 *  Dibaca dari hasil list pertama, karena aggregate id tidak tersedia utuh di storage. */
const CONTEXT_SCRIPT = '(function(){' +
    'var raw=sessionStorage.getItem(' + JSON.stringify(TOKEN_KEY) + ');' +
    'if(!raw) return {err:"SESSION_HILANG"};' +
    'var o=JSON.parse(raw); var sub=null;' +
    'try{ sub=JSON.parse(atob(o.access_token.split(".")[1])).sub; }catch(e){}' +
    'return {vatStatus:sessionStorage.getItem("vatStatus"), npwp:sub,' +
    ' expiresInSec: o.expires_at? Math.round(o.expires_at-Date.now()/1000):null,' +
    ' url:location.href};' +
    '})()';

/** Gangguan jaringan sesaat ("Failed to fetch") pernah terjadi live di tengah batch besar -
 *  bukan penolakan Coretax, jadi aman dicoba ulang. TOKEN_KEDALUWARSA/SESSION_HILANG TIDAK
 *  diulang - itu butuh perhatian user (mis. window Chrome tertutup), bukan sekadar hiccup. */
async function apiPost(page, path, body, timeoutMs, retries) {
    const maxTry = (retries == null ? 2 : retries) + 1;
    let lastErr;
    for (let attempt = 1; attempt <= maxTry; attempt++) {
        const res = await page.evaluate(buildFetchScript(path, body, timeoutMs));
        if (!res || !res.__err) return res;
        lastErr = res.__err;
        if (/TOKEN_KEDALUWARSA|SESSION_HILANG|TOKEN_KOSONG/.test(lastErr)) break;
        if (attempt < maxTry) await page.waitForTimeout(1500 * attempt);
    }
    throw new Error('Panggilan API gagal (' + path + '): ' + lastErr);
}

/** Pastikan halaman berada di modul Pajak Masukan - fetch same-origin butuh origin Coretax,
 *  dan sessionStorage token bersifat per-tab. */
async function ensureOnInputTaxPage(page) {
    // SELALU navigasi ulang, bukan hanya kalau URL belum di input-tax - ditemukan live: kalau
    // context Chrome ini sebelumnya sudah pernah membuka input-tax untuk ENTITAS LAIN (masih
    // dalam PIC/profil yang sama), URL-nya tetap sama setelah impersonate berpindah, jadi
    // pengecekan URL lama SALAH mengira halaman sudah "siap" padahal sessionStorage (termasuk
    // vatStatus) masih basi milik entitas sebelumnya. Reload penuh di sini murah (dipanggil
    // sekali per run) dan menghapus seluruh kelas bug ini.
    log('Membuka halaman Pajak Masukan...');
    await page.goto(INPUT_TAX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // vatStatus diisi ASYNC oleh bootstrap Coretax sendiri (panggilan ke
    // returnsheetstaxtype/vatstatus) setelah halaman dimuat - poll dengan timeout longgar,
    // bukan sleep tetap 4 detik, supaya tidak race pada koneksi lambat atau tepat setelah
    // pergantian entitas. Mengecek KEY-nya ADA (!== null), BUKAN nilainya truthy - diverifikasi
    // live: WP yang responsnya Payload:[] menyimpan vatStatus sebagai STRING KOSONG yang sah
    // (bukan belum ter-set), jadi cek truthy akan salah menunggu penuh 20 detik setiap kali.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const has = await page.evaluate('sessionStorage.getItem("vatStatus") !== null').catch(() => false);
        if (has) return;
        await page.waitForTimeout(500);
    }
}

async function getContext(page) {
    await ensureOnInputTaxPage(page);
    const ctx = await page.evaluate(CONTEXT_SCRIPT);
    if (!ctx || ctx.err) throw new Error('Sesi Coretax tidak terbaca - pastikan sudah login.');
    // vatStatus BOLEH kosong di sini - dicek nanti di setCreditStatus() (satu-satunya tempat
    // yang benar-benar memakainya), bukan di sini yang dipakai bersama oleh alur baca (Download,
    // pencarian/cross-check Import) yang sama sekali tidak membutuhkannya.
    // aggregate identifier diambil dari respons list (satu panggilan murah, read-only)
    const probe = await apiPost(page, '/inputinvoice/list', {
        First: 0, Rows: 1, SortField: '', SortOrder: 1, LanguageId: 'id-ID', Filters: []
    }, 30000);
    const row = probe && probe.__json && probe.__json.Payload && probe.__json.Payload.Data && probe.__json.Payload.Data[0];
    if (!row || !row.BuyerTaxpayerAggregateIdentifier) {
        throw new Error('Tidak bisa menentukan identitas WP (BuyerTaxpayerAggregateIdentifier) - WP ini mungkin belum punya faktur masukan sama sekali.');
    }
    return {
        agg: row.BuyerTaxpayerAggregateIdentifier,
        npwp: row.BuyerTIN || ctx.npwp,
        nama: row.BuyerTaxpayerNameClear || null,
        vatStatus: ctx.vatStatus,
        tokenExpiresInSec: ctx.expiresInSec
    };
}

/* ------------------------------------------------------------------ *
 *  Operasi baca
 * ------------------------------------------------------------------ */

function listBody(ctx, filters, first, rows) {
    return {
        BuyerTaxpayerAggregateIdentifier: ctx.agg,
        TaxpayerAggregateIdentifier: ctx.agg,
        First: first || 0, Rows: rows || 100,
        SortField: '', SortOrder: 1, LanguageId: 'id-ID',
        Filters: filters || []
    };
}

/** Cari SATU faktur berdasarkan nomornya.
 *  WAJIB MatchMode "equals" + AsString true: dengan "contains" server menggantung sampai
 *  timeout (diverifikasi berulang kali). Lewat API filter masa TIDAK diperlukan - itu batasan UI. */
async function findByNumber(page, ctx, noFaktur) {
    const no = normalizeFakturNo(noFaktur);
    if (!no) return null;
    const res = await apiPost(page, '/inputinvoice/list', listBody(ctx, [
        { PropertyName: 'TaxInvoiceNumber', Value: no, MatchMode: 'equals', CaseSensitive: true, AsString: true }
    ], 0, 10), 30000);
    const j = res && res.__json;
    if (!j || !j.IsSuccessful) return null;
    const data = (j.Payload && j.Payload.Data) || [];
    // equals bersifat eksak (nomor sepotong -> 0 hasil), jadi >1 hasil tidak diharapkan;
    // kalau toh terjadi, cocokkan persis daripada asal ambil yang pertama.
    return data.find((x) => normalizeFakturNo(x.TaxInvoiceNumber) === no) || null;
}

/** Ambil SEMUA faktur pada satu masa, dengan paging.
 *  TotalRecords TIDAK BOLEH dipakai sebagai jumlah - nilainya mengikuti pola Rows+1
 *  (diverifikasi: Rows=5 -> 6, Rows=50 -> 51, Rows=200 -> 201). Paging berhenti saat jumlah
 *  baris yang kembali lebih sedikit dari yang diminta. */
async function listByPeriod(page, ctx, periodCodes, year, emit) {
    const PAGE = 200;
    const out = [];
    const seen = new Set();
    for (let first = 0; first < 20000; first += PAGE) {
        const res = await apiPost(page, '/inputinvoice/list', listBody(ctx, [
            { PropertyName: 'TaxInvoicePeriod', Value: periodCodes, MatchMode: 'contains', CaseSensitive: true, AsString: false },
            { PropertyName: 'TaxInvoiceYear', Value: String(year), MatchMode: 'equals', CaseSensitive: true, AsString: false }
        ], first, PAGE), 60000);
        const j = res && res.__json;
        if (!j || !j.IsSuccessful) throw new Error('Gagal mengambil daftar faktur: ' + ((j && j.Message) || res.__http));
        const data = (j.Payload && j.Payload.Data) || [];
        data.forEach((x) => { if (!seen.has(x.RecordId)) { seen.add(x.RecordId); out.push(x); } });
        if (emit) emit('Terambil ' + out.length + ' faktur...');
        if (data.length < PAGE) break;
    }
    // Filter masa diterapkan ulang di sisi kita: pada pengujian, filter masa milik server tidak
    // terbukti membatasi hasil, jadi jangan bergantung padanya untuk ketepatan.
    const wanted = {};
    (periodCodes || []).forEach((c) => { wanted[c] = true; });
    return out.filter((x) => wanted[x.TaxInvoicePeriod] && String(x.TaxInvoiceYear) === String(year));
}

/* ------------------------------------------------------------------ *
 *  Aturan kelayakan - pagar pengaman
 * ------------------------------------------------------------------ */

/** Menentukan boleh/tidaknya SATU faktur diubah masa pengkreditannya.
 *
 *  Aturan "sudah dilaporkan" WAJIB ditegakkan di sini: Coretax hanya menegakkannya di UI
 *  (field masa dinonaktifkan), dan lapisan API sama sekali tidak memblokirnya - probe live
 *  ke faktur ber-ReportedByBuyer=true dijawab HTTP 200. Karena automation ini memakai API,
 *  ia melewati pagar UI tersebut, jadi pagar itu harus digantikan di sini.
 */
function checkEligibility(inv, targetCode, targetYear) {
    if (!inv) return { ok: false, code: 'TIDAK_DITEMUKAN', reason: 'Faktur tidak ditemukan di Coretax' };

    if (inv.ReportedByBuyer === true) {
        return { ok: false, code: 'SUDAH_DILAPORKAN',
            reason: 'Faktur sudah dilaporkan di SPT (Dilaporkan = YES) - tidak diubah' };
    }
    // Coretax normalnya hanya memproses faktur berstatus APPROVED - CANCELED/AMENDED bukan
    // kegagalan automation, itu memang di luar cakupan yang bisa diproses sama sekali.
    if (inv.InputInvoiceStatus === 'CANCELED' || inv.TaxInvoiceStatus === 'CANCELED') {
        return { ok: false, code: 'DIBATALKAN', skip: true, reason: 'Faktur berstatus CANCELED - dilewati, bukan gagal' };
    }
    if (inv.InputInvoiceStatus === 'AMENDED' || inv.TaxInvoiceStatus === 'AMENDED') {
        return { ok: false, code: 'DIBETULKAN', skip: true, reason: 'Faktur berstatus AMENDED - dilewati, bukan gagal' };
    }
    if (inv.Valid === false) {
        return { ok: false, code: 'TIDAK_VALID', skip: true, reason: 'Faktur ditandai TIDAK VALID di Coretax - dilewati, bukan gagal' };
    }

    const dist = monthDistance(inv.TaxInvoicePeriod, inv.TaxInvoiceYear, targetCode, targetYear);
    if (dist === null) {
        return { ok: false, code: 'MASA_TIDAK_DIKENAL',
            reason: 'Kode masa tidak dikenal (' + inv.TaxInvoicePeriod + ' / ' + targetCode + ')' };
    }
    // Aturan Coretax, diverifikasi live: masa faktur <= masa kredit <= masa faktur + 3 bulan.
    if (dist < 0) {
        return { ok: false, code: 'MASA_LEBIH_AWAL',
            reason: 'Masa pengkreditan (' + periodLabel(targetCode, targetYear) + ') lebih awal dari masa faktur (' +
                periodLabel(inv.TaxInvoicePeriod, inv.TaxInvoiceYear) + ')' };
    }
    if (dist > 3) {
        return { ok: false, code: 'LEWAT_3_BULAN',
            reason: 'Melebihi batas 3 bulan: masa faktur ' + periodLabel(inv.TaxInvoicePeriod, inv.TaxInvoiceYear) +
                ' -> masa pengkreditan ' + periodLabel(targetCode, targetYear) + ' (selisih ' + dist + ' bulan)' };
    }

    const sudahPas = inv.TaxInvoiceStatus === STATUS.CREDITED &&
        inv.PeriodCredit === targetCode && String(inv.YearCredit) === String(targetYear);
    if (sudahPas) {
        return { ok: false, code: 'SUDAH_SESUAI', skip: true,
            reason: 'Sudah dikreditkan di masa yang sama dengan yang diminta - tidak perlu diubah' };
    }

    // Faktur yang sudah CREDITED/UNCREDITED perlu dikembalikan ke APPROVED dulu sebelum
    // masa pengkreditannya bisa diubah (field masa dinonaktifkan pada status tersebut).
    const perluReset = inv.TaxInvoiceStatus === STATUS.CREDITED || inv.TaxInvoiceStatus === STATUS.UNCREDITED;
    return { ok: true, perluReset: perluReset, jarakBulan: dist };
}

/** Cross-check data Excel vs data Coretax. Mismatch = JANGAN update. */
function crossCheck(row, inv) {
    const beda = [];
    if (row.npwp) {
        const a = normalizeNpwp(row.npwp), b = normalizeNpwp(inv.SellerTIN);
        if (a && b && a !== b) beda.push('NPWP (Excel ' + a + ' vs Coretax ' + b + ')');
    }
    if (row.ppn != null && row.ppn !== '') {
        const a = Math.round(Number(row.ppn)), b = Math.round(Number(inv.VAT));
        if (isFinite(a) && isFinite(b) && a !== b) beda.push('PPN (Excel ' + a + ' vs Coretax ' + b + ')');
    }
    if (row.dpp != null && row.dpp !== '') {
        // Coretax punya DUA kolom DPP (SellingPrice = Harga Jual, OtherTaxBase = DPP Nilai Lain).
        // Sesuai keputusan user: cocokkan ke salah satu, laporkan mana yang cocok.
        const a = Math.round(Number(row.dpp));
        const s = Math.round(Number(inv.SellingPrice)), o = Math.round(Number(inv.OtherTaxBase));
        if (isFinite(a) && a !== s && a !== o) {
            beda.push('DPP (Excel ' + a + ' vs Coretax ' + s + ' / ' + o + ')');
        }
    }
    if (row.tanggal instanceof Date && inv.TaxInvoiceDate) {
        const a = row.tanggal, b = new Date(inv.TaxInvoiceDate);
        if (a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate()) {
            beda.push('Tanggal Faktur (Excel ' + a.toISOString().slice(0, 10) + ' vs Coretax ' + inv.TaxInvoiceDate.slice(0, 10) + ')');
        }
    }
    return beda;
}

/* ------------------------------------------------------------------ *
 *  Operasi tulis
 * ------------------------------------------------------------------ */

/** Ubah status/masa pengkreditan SATU faktur.
 *  TaxpayerAggregateIdentifier WAJIB ada di body - tanpa itu server menjawab 401 meski token
 *  valid (field ini tidak muncul di definisi fungsi pada bundle; ditambahkan oleh interceptor). */
async function setCreditStatus(page, ctx, recordId, buyerStatus, periodCode, year) {
    // vatStatus WAJIB di sini (dikirim sebagai EinvoiceVATStatus) - tapi TIDAK di getContext(),
    // karena alur baca (Download, dan pencarian/cross-check di Import) tidak pernah memakainya
    // sama sekali (/inputinvoice/list tidak menyertakan field ini). Ditemukan live: Coretax
    // sendiri mengembalikan Payload:[] (vatStatus kosong) untuk sebagian WP yang tetap punya
    // data Pajak Masukan biasa - taruh syaratnya di sini, tepat di titik yang benar-benar butuh,
    // supaya alur baca tidak ikut diblokir oleh WP yang kebetulan vatStatus-nya kosong.
    if (!ctx.vatStatus) {
        throw new Error('WP ini tidak memiliki vatStatus terdaftar di Coretax (kemungkinan bukan PKP aktif) - operasi pengkreditan tidak bisa dilakukan.');
    }
    const single = !!(periodCode && year);
    const path = single ? '/inputinvoice/credit-uncredit' : '/inputinvoice/credit-uncredit-list';
    const body = single
        ? { RecordId: recordId, BuyerStatus: buyerStatus, Year: String(year), Period: periodCode,
            EinvoiceVATStatus: ctx.vatStatus, TaxpayerAggregateIdentifier: ctx.agg }
        : { RecordIds: [recordId], BuyerStatus: buyerStatus,
            EinvoiceVATStatus: ctx.vatStatus, TaxpayerAggregateIdentifier: ctx.agg };
    const res = await apiPost(page, path, body, 45000);
    const j = res && res.__json;
    if (!j) return { ok: false, message: 'Respons tidak terbaca (HTTP ' + res.__http + '): ' + (res.__raw || '') };
    if (!j.IsSuccessful) return { ok: false, message: j.Message || ('HTTP ' + res.__http), errorType: j.ErrorType };
    return { ok: true };
}

/** Kreditkan satu faktur ke masa tertentu, lalu VERIFIKASI dengan membaca ulang dari Coretax.
 *  HTTP 200 saja tidak pernah dianggap bukti berhasil. */
async function creditOne(page, ctx, inv, targetCode, targetYear, opts) {
    opts = opts || {};
    const el = checkEligibility(inv, targetCode, targetYear);
    if (!el.ok) return { hasil: el.skip ? 'DILEWATI' : 'GAGAL', code: el.code, keterangan: el.reason, inv: inv };

    if (opts.dryRun) {
        return { hasil: 'DRY-RUN', code: 'AKAN_DIPROSES', inv: inv,
            keterangan: 'Akan dikreditkan ke ' + periodLabel(targetCode, targetYear) +
                (el.perluReset ? ' (perlu reset ke APPROVED dulu)' : '') };
    }

    if (el.perluReset) {
        const r = await setCreditStatus(page, ctx, inv.RecordId, STATUS.APPROVED, null, null);
        if (!r.ok) return { hasil: 'GAGAL', code: 'GAGAL_RESET', keterangan: 'Gagal mengembalikan ke APPROVED: ' + r.message, inv: inv };
        await page.waitForTimeout(600);
    }

    const w = await setCreditStatus(page, ctx, inv.RecordId, STATUS.CREDITED, targetCode, targetYear);
    if (!w.ok) {
        const isTigaBulan = /3 bulan|ditambah 3/i.test(w.message || '');
        return { hasil: 'GAGAL', code: isTigaBulan ? 'LEWAT_3_BULAN' : 'DITOLAK_CORETAX',
            keterangan: 'Ditolak Coretax: ' + w.message, inv: inv };
    }

    // Verifikasi wajib: baca ulang kondisi sebenarnya dari Coretax.
    await page.waitForTimeout(opts.verifyDelayMs || 1500);
    const after = await findByNumber(page, ctx, inv.TaxInvoiceNumber);
    if (!after) {
        return { hasil: 'GAGAL', code: 'VERIFIKASI_GAGAL',
            keterangan: 'Update terkirim tapi faktur tidak terbaca ulang untuk verifikasi', inv: inv };
    }
    const cocok = after.TaxInvoiceStatus === STATUS.CREDITED &&
        after.PeriodCredit === targetCode && String(after.YearCredit) === String(targetYear);
    if (!cocok) {
        return { hasil: 'GAGAL', code: 'VERIFIKASI_TIDAK_COCOK', inv: after,
            keterangan: 'Setelah update, Coretax menunjukkan status ' + after.TaxInvoiceStatus +
                ' masa ' + periodLabel(after.PeriodCredit, after.YearCredit) +
                ' - tidak sesuai permintaan ' + periodLabel(targetCode, targetYear) };
    }
    return { hasil: 'SUKSES', code: 'OK', inv: after,
        keterangan: 'Dikreditkan di ' + periodLabel(targetCode, targetYear) };
}

/** Kelayakan untuk aksi "Tidak Kreditkan" (BuyerStatus UNCREDITED). Tidak melibatkan Period/Year
 *  atau aturan 3 bulan (itu khusus penentuan MASA pengkreditan) - tapi pagar "sudah dilaporkan"
 *  tetap wajib, dengan alasan yang sama seperti checkEligibility: Coretax hanya menegakkannya
 *  di UI, lapisan API tidak memblokirnya sama sekali (diverifikasi live). */
function checkUncreditEligibility(inv) {
    if (!inv) return { ok: false, code: 'TIDAK_DITEMUKAN', reason: 'Faktur tidak ditemukan di Coretax' };
    if (inv.ReportedByBuyer === true) {
        return { ok: false, code: 'SUDAH_DILAPORKAN',
            reason: 'Faktur sudah dilaporkan di SPT (Dilaporkan = YES) - tidak diubah' };
    }
    if (inv.TaxInvoiceStatus === 'CANCELED') {
        return { ok: false, code: 'DIBATALKAN', skip: true, reason: 'Faktur berstatus CANCELED - dilewati, bukan gagal' };
    }
    if (inv.TaxInvoiceStatus === 'AMENDED') {
        return { ok: false, code: 'DIBETULKAN', skip: true, reason: 'Faktur berstatus AMENDED - dilewati, bukan gagal' };
    }
    if (inv.TaxInvoiceStatus === STATUS.UNCREDITED) {
        return { ok: false, code: 'SUDAH_SESUAI', skip: true, reason: 'Sudah berstatus Tidak Dikreditkan' };
    }
    return { ok: true };
}

/** Ubah SATU faktur menjadi "Tidak Dikreditkan" (BuyerStatus UNCREDITED), lalu VERIFIKASI
 *  dengan membaca ulang dari Coretax. HTTP 200 saja tidak pernah dianggap bukti berhasil. */
async function uncreditOne(page, ctx, inv, opts) {
    opts = opts || {};
    const el = checkUncreditEligibility(inv);
    if (!el.ok) return { hasil: el.skip ? 'DILEWATI' : 'GAGAL', code: el.code, keterangan: el.reason, inv: inv };

    if (opts.dryRun) {
        return { hasil: 'DRY-RUN', code: 'AKAN_DIPROSES', inv: inv, keterangan: 'Akan diubah menjadi Tidak Dikreditkan' };
    }

    const w = await setCreditStatus(page, ctx, inv.RecordId, STATUS.UNCREDITED, null, null);
    if (!w.ok) {
        return { hasil: 'GAGAL', code: 'DITOLAK_CORETAX', keterangan: 'Ditolak Coretax: ' + w.message, inv: inv };
    }

    await page.waitForTimeout(opts.verifyDelayMs || 1500);
    const after = await findByNumber(page, ctx, inv.TaxInvoiceNumber);
    if (!after) {
        return { hasil: 'GAGAL', code: 'VERIFIKASI_GAGAL',
            keterangan: 'Update terkirim tapi faktur tidak terbaca ulang untuk verifikasi', inv: inv };
    }
    if (after.TaxInvoiceStatus !== STATUS.UNCREDITED) {
        return { hasil: 'GAGAL', code: 'VERIFIKASI_TIDAK_COCOK', inv: after,
            keterangan: 'Setelah update, Coretax menunjukkan status ' + after.TaxInvoiceStatus + ' - tidak sesuai permintaan Tidak Dikreditkan' };
    }
    return { hasil: 'SUKSES', code: 'OK', inv: after, keterangan: 'Diubah menjadi Tidak Dikreditkan' };
}

/* ------------------------------------------------------------------ *
 *  Alur: kreditkan seluruh faktur pada satu masa ke masa lain
 * ------------------------------------------------------------------ */

/** @param {object} o { page, fromMonth, fromYear, toMonth, toYear, dryRun, emit, limit } */
async function runCreditByPeriod(o) {
    const emit = o.emit || function (m) { log(m); };
    const page = o.page;
    const fromCode = PERIOD_CODE[Number(o.fromMonth)];
    const toCode = PERIOD_CODE[Number(o.toMonth)];
    if (!fromCode) throw new Error('Masa asal tidak valid: ' + o.fromMonth);
    if (!toCode) throw new Error('Masa tujuan tidak valid: ' + o.toMonth);

    const ctx = await getContext(page);
    emit('WP aktif: ' + (ctx.nama || '-') + ' (' + ctx.npwp + '), sesi tersisa ~' + ctx.tokenExpiresInSec + ' detik.');
    emit('Mengambil faktur masa ' + periodLabel(fromCode, o.fromYear) + '...');

    let all = await listByPeriod(page, ctx, [fromCode], o.fromYear, emit);
    emit('Ditemukan ' + all.length + ' faktur pada masa tersebut.');
    if (o.limit) all = all.slice(0, o.limit);

    const hasil = [];
    for (let i = 0; i < all.length; i++) {
        const inv = all[i];
        let r;
        try {
            r = await creditOne(page, ctx, inv, toCode, o.toYear, { dryRun: o.dryRun });
        } catch (e) {
            // Satu faktur gagal (mis. gangguan jaringan sesaat yang lolos dari retry di apiPost)
            // tidak boleh menghentikan seluruh batch - catat dan lanjutkan. Desain sudah
            // idempoten (checkEligibility melewati yang sudah sesuai), jadi menjalankan ulang
            // command yang sama nanti aman untuk baris yang gagal di sini.
            emit('Faktur ' + inv.TaxInvoiceNumber + ' gagal diproses: ' + e.message + ' - lanjut ke berikutnya.');
            r = { hasil: 'GAGAL', code: 'ERROR_TAK_TERDUGA', keterangan: e.message, inv: null };
        }
        hasil.push({
            no: inv.TaxInvoiceNumber, penjual: inv.SellerTaxpayerName, npwp: inv.SellerTIN,
            tanggal: String(inv.TaxInvoiceDate || '').slice(0, 10),
            masaPM: periodLabel(inv.TaxInvoicePeriod, inv.TaxInvoiceYear),
            dpp: inv.SellingPrice, dppLain: inv.OtherTaxBase, ppn: inv.VAT,
            statusAwal: inv.TaxInvoiceStatus, dilaporkan: inv.ReportedByBuyer,
            hasil: r.hasil, code: r.code, keterangan: r.keterangan,
            statusAkhir: r.inv ? r.inv.TaxInvoiceStatus : null,
            masaKreditAkhir: r.inv && r.inv.PeriodCredit ? periodLabel(r.inv.PeriodCredit, r.inv.YearCredit) : null
        });
        if ((i + 1) % 10 === 0 || i === all.length - 1) {
            emit('Progres ' + (i + 1) + '/' + all.length + ' - ' + ringkasan(hasil));
        }
    }
    emit('Selesai. ' + ringkasan(hasil));
    return { ctx: ctx, target: periodLabel(toCode, o.toYear), rows: hasil, ringkasan: tally(hasil) };
}

/* ------------------------------------------------------------------ *
 *  Alur: ubah seluruh faktur pada satu masa menjadi "Tidak Dikreditkan"
 * ------------------------------------------------------------------ */

/** @param {object} o { page, fromMonth, fromYear, dryRun, emit, limit } */
async function runUncreditByPeriod(o) {
    const emit = o.emit || function (m) { log(m); };
    const page = o.page;
    const fromCode = PERIOD_CODE[Number(o.fromMonth)];
    if (!fromCode) throw new Error('Masa tidak valid: ' + o.fromMonth);

    const ctx = await getContext(page);
    emit('WP aktif: ' + (ctx.nama || '-') + ' (' + ctx.npwp + '), sesi tersisa ~' + ctx.tokenExpiresInSec + ' detik.');
    emit('Mengambil faktur masa ' + periodLabel(fromCode, o.fromYear) + '...');

    let all = await listByPeriod(page, ctx, [fromCode], o.fromYear, emit);
    emit('Ditemukan ' + all.length + ' faktur pada masa tersebut.');
    if (o.limit) all = all.slice(0, o.limit);

    const hasil = [];
    for (let i = 0; i < all.length; i++) {
        const inv = all[i];
        let r;
        try {
            r = await uncreditOne(page, ctx, inv, { dryRun: o.dryRun });
        } catch (e) {
            emit('Faktur ' + inv.TaxInvoiceNumber + ' gagal diproses: ' + e.message + ' - lanjut ke berikutnya.');
            r = { hasil: 'GAGAL', code: 'ERROR_TAK_TERDUGA', keterangan: e.message, inv: null };
        }
        hasil.push({
            no: inv.TaxInvoiceNumber, penjual: inv.SellerTaxpayerName, npwp: inv.SellerTIN,
            tanggal: String(inv.TaxInvoiceDate || '').slice(0, 10),
            masaPM: periodLabel(inv.TaxInvoicePeriod, inv.TaxInvoiceYear),
            dpp: inv.SellingPrice, dppLain: inv.OtherTaxBase, ppn: inv.VAT,
            statusAwal: inv.TaxInvoiceStatus, dilaporkan: inv.ReportedByBuyer,
            hasil: r.hasil, code: r.code, keterangan: r.keterangan,
            statusAkhir: r.inv ? r.inv.TaxInvoiceStatus : null,
            masaKreditAkhir: r.inv && r.inv.PeriodCredit ? periodLabel(r.inv.PeriodCredit, r.inv.YearCredit) : null
        });
        if ((i + 1) % 10 === 0 || i === all.length - 1) {
            emit('Progres ' + (i + 1) + '/' + all.length + ' - ' + ringkasan(hasil));
        }
    }
    emit('Selesai. ' + ringkasan(hasil));
    return { ctx: ctx, target: 'Tidak Dikreditkan', rows: hasil, ringkasan: tally(hasil) };
}

function tally(rows) {
    const t = {};
    rows.forEach((r) => { t[r.hasil] = (t[r.hasil] || 0) + 1; });
    return t;
}
function ringkasan(rows) {
    const t = tally(rows);
    return Object.keys(t).map((k) => k + ': ' + t[k]).join(', ');
}

/* ------------------------------------------------------------------ *
 *  Alur: impor dari Template Excel (per baris, No Faktur sebagai kunci)
 *  Ini implementasi Fase 5 dari brief awal - berbeda dari runCreditByPeriod di atas
 *  (yang memproses SELURUH faktur dalam satu masa ke satu masa tujuan yang sama);
 *  di sini setiap baris punya No Faktur dan masa tujuannya SENDIRI-SENDIRI, dibaca dari Excel.
 * ------------------------------------------------------------------ */

/* Token pencarian header, dicocokkan case-insensitive/substring terhadap header row template
 * (lihat dev-make-template-pm.js). Tetap toleran bila header sedikit berubah kata-katanya. */
const EXCEL_HEADERS = {
    noFaktur: ['no faktur'],
    npwp: ['npwp'],
    nama: ['lawan transaksi'],
    tanggal: ['tanggal faktur'],
    dpp: ['dpp'],
    ppn: ['ppn'],
    jenis: ['pengkreditan ppn'],
    masaKredit: ['masa pengkreditan'],
    hasil: ['hasil'],
    statusCoretax: ['status coretax'],
    masaAktual: ['masa kredit aktual'],
    keterangan: ['keterangan']
};

function normHeader(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

/** Cari baris header (berisi kolom "No Faktur") di antara beberapa baris pertama - toleran
 *  terhadap baris banner/judul di atasnya, tidak berasumsi header selalu di baris 1. */
function findHeaderRow(sheet) {
    for (let r = 1; r <= 6; r++) {
        const row = sheet.getRow(r);
        const map = {};
        row.eachCell({ includeEmpty: true }, (cell, col) => {
            const h = normHeader(cell.value);
            if (!h) return;
            Object.keys(EXCEL_HEADERS).forEach((key) => {
                if (!map[key] && EXCEL_HEADERS[key].some((tok) => h.indexOf(tok) !== -1)) map[key] = col;
            });
        });
        if (map.noFaktur) return { rowNum: r, colMap: map };
    }
    return null;
}

function cellDate(cell) {
    const v = cell.value;
    if (v instanceof Date) return v;
    if (v && typeof v === 'object' && v.result instanceof Date) return v.result; // formula cell
    return null;
}
function cellNumber(cell) {
    const v = cell.value;
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && typeof v.result === 'number') return v.result;
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
}
function cellText(cell) {
    const v = cell.value;
    if (v == null) return '';
    if (typeof v === 'object' && 'text' in v) return String(v.text);
    if (typeof v === 'object' && 'result' in v) return String(v.result == null ? '' : v.result);
    return String(v).trim();
}

/** Proses SATU baris Excel: validasi kelengkapan+konsistensi, cari faktur, cross-check,
 *  lalu (bila semua lolos) panggil creditOne dengan masa tujuan dari kolom MASA PENGKREDITAN.
 *  Reuse penuh dari mesin yang sudah teruji live (findByNumber/crossCheck/creditOne/checkEligibility) -
 *  tidak ada jalur update baru yang ditulis khusus untuk Excel. */
async function processExcelRow(page, ctx, row, colMap, opts) {
    opts = opts || {};
    const noFakturRaw = cellText(row.getCell(colMap.noFaktur));
    if (!noFakturRaw.trim()) return { hasil: 'GAGAL', keterangan: 'No Faktur kosong' };

    const npwp = colMap.npwp ? cellText(row.getCell(colMap.npwp)) : '';
    const dpp = colMap.dpp ? cellNumber(row.getCell(colMap.dpp)) : null;
    const ppn = colMap.ppn ? cellNumber(row.getCell(colMap.ppn)) : null;
    const tanggal = colMap.tanggal ? cellDate(row.getCell(colMap.tanggal)) : null;
    const targetOverride = opts.targetPeriod || null;
    const jenis = (colMap.jenis ? cellText(row.getCell(colMap.jenis)) : '').toUpperCase().trim();
    const masaKreditDate = !targetOverride && colMap.masaKredit ? cellDate(row.getCell(colMap.masaKredit)) : null;

    if (!tanggal) return { hasil: 'GAGAL', keterangan: 'Tanggal Faktur kosong atau bukan tanggal yang valid' };
    if (!targetOverride && jenis !== 'MASA SAMA' && jenis !== 'MASA TIDAK SAMA') {
        return { hasil: 'GAGAL', keterangan: 'PENGKREDITAN PPN harus diisi "MASA SAMA" atau "MASA TIDAK SAMA" (isi Excel: "' + jenis + '")' };
    }
    if (!targetOverride && !masaKreditDate) return { hasil: 'GAGAL', keterangan: 'MASA PENGKREDITAN kosong atau bukan tanggal yang valid' };

    // Validasi konsistensi Excel (brief: Masa PM dibandingkan Masa Pengkreditan menentukan
    // MASA SAMA/TIDAK SAMA). Masa PM dihitung langsung dari Tanggal Faktur, bukan dari kolom F
    // template (formula) - menghindari ketergantungan pada nilai cache formula yang belum tentu
    // ter-hitung ulang oleh Excel.
    const pmMonth = tanggal.getMonth() + 1, pmYear = tanggal.getFullYear();
    const targetMonth = targetOverride ? targetOverride.month : masaKreditDate.getMonth() + 1;
    const targetYear = targetOverride ? targetOverride.year : masaKreditDate.getFullYear();
    const expected = (pmMonth === targetMonth && pmYear === targetYear) ? 'MASA SAMA' : 'MASA TIDAK SAMA';
    if (!targetOverride && jenis !== expected) {
        return { hasil: 'GAGAL',
            keterangan: 'PENGKREDITAN PPN tidak konsisten dengan tanggal: Masa PM ' + MONTH_ID[pmMonth] + ' ' + pmYear +
                ' vs Masa Pengkreditan ' + MONTH_ID[targetMonth] + ' ' + targetYear + ' seharusnya "' + expected +
                '", Excel menulis "' + jenis + '" - baris TIDAK diproses' };
    }
    const targetCode = targetOverride ? targetOverride.code : PERIOD_CODE[targetMonth];
    if (!targetCode) return { hasil: 'GAGAL', keterangan: 'Bulan pada MASA PENGKREDITAN tidak valid: ' + targetMonth };

    const inv = await findByNumber(page, ctx, noFakturRaw);
    if (!inv) return { hasil: 'GAGAL', keterangan: 'Faktur tidak ditemukan di Coretax (No Faktur: ' + normalizeFakturNo(noFakturRaw) + ')' };

    const beda = crossCheck({ npwp: npwp, ppn: ppn, dpp: dpp, tanggal: tanggal }, inv);
    if (beda.length) {
        return { hasil: 'GAGAL', statusCoretax: inv.TaxInvoiceStatus,
            keterangan: 'DATA MISMATCH - tidak diupdate: ' + beda.join('; ') };
    }

    const r = await creditOne(page, ctx, inv, targetCode, targetYear, { dryRun: opts.dryRun });
    return {
        hasil: r.hasil,
        statusCoretax: r.inv ? r.inv.TaxInvoiceStatus : (inv.TaxInvoiceStatus || ''),
        masaAktual: (r.inv && r.inv.PeriodCredit) ? periodLabel(r.inv.PeriodCredit, r.inv.YearCredit) : '',
        keterangan: r.keterangan
    };
}

/** @param {object} o { page, fileBuffer, dryRun, emit, limit } */
async function runImportFromExcel(o) {
    const emit = o.emit || function (m) { log(m); };
    const page = o.page;

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(o.fileBuffer);
    const sheet = wb.worksheets.find((s) => /import/i.test(s.name)) || wb.worksheets[0];
    if (!sheet) throw new Error('Sheet data tidak ditemukan di file Excel.');

    const found = findHeaderRow(sheet);
    if (!found) throw new Error('Kolom "No Faktur" tidak ditemukan - pastikan memakai Template Impor Pajak Masukan.');
    const { rowNum: headerRowNum, colMap } = found;
    const wajib = ['npwp', 'tanggal', 'dpp', 'ppn', 'jenis', 'masaKredit'];
    const kurang = wajib.filter((k) => !colMap[k]);
    if (kurang.length) throw new Error('Kolom wajib tidak ditemukan di template: ' + kurang.join(', '));
    const hasilCols = ['hasil', 'statusCoretax', 'masaAktual', 'keterangan'];
    if (hasilCols.some((k) => !colMap[k])) {
        throw new Error('Kolom hasil (HASIL/STATUS CORETAX/MASA KREDIT AKTUAL/KETERANGAN) tidak ditemukan - pastikan memakai Template Impor Pajak Masukan.');
    }

    const targetPeriod = parseTargetMasaInput(o.targetMasaInput);
    const ctx = await getContext(page);
    emit('WP aktif: ' + (ctx.nama || '-') + ' (' + ctx.npwp + '), sesi tersisa ~' + ctx.tokenExpiresInSec + ' detik.');
    if (targetPeriod) {
        emit('Masa Pengkreditan dari aplikasi: ' + MONTH_ID[targetPeriod.month] + ' ' + targetPeriod.year
            + ' (' + targetPeriod.raw + ') - berlaku untuk semua baris dan mengesampingkan kolom masa di Excel.');
    }

    const dataRows = [];
    const lastRow = sheet.lastRow ? sheet.lastRow.number : headerRowNum;
    for (let r = headerRowNum + 1; r <= lastRow; r++) {
        const row = sheet.getRow(r);
        if (cellText(row.getCell(colMap.noFaktur)).trim()) dataRows.push(row);
    }
    emit('Ditemukan ' + dataRows.length + ' baris berisi No Faktur.');
    const toProcess = o.limit ? dataRows.slice(0, o.limit) : dataRows;

    const results = [];
    for (let i = 0; i < toProcess.length; i++) {
        const row = toProcess[i];
        let out;
        try {
            out = await processExcelRow(page, ctx, row, colMap, { dryRun: o.dryRun, targetPeriod: targetPeriod });
        } catch (e) {
            emit('Baris ' + row.number + ' gagal diproses: ' + e.message + ' - lanjut ke baris berikutnya.');
            out = { hasil: 'GAGAL', keterangan: 'Error tak terduga: ' + e.message };
        }
        row.getCell(colMap.hasil).value = out.hasil;
        row.getCell(colMap.statusCoretax).value = out.statusCoretax || '';
        row.getCell(colMap.masaAktual).value = out.masaAktual || '';
        row.getCell(colMap.keterangan).value = out.keterangan || '';
        results.push({ rowNum: row.number, noFaktur: cellText(row.getCell(colMap.noFaktur)), hasil: out.hasil, keterangan: out.keterangan });
        if ((i + 1) % 10 === 0 || i === toProcess.length - 1) {
            emit('Progres ' + (i + 1) + '/' + toProcess.length + ' - ' + ringkasan(results));
        }
    }

    const outDir = path.join(os.homedir(), 'Downloads', 'CoretaxAgent', 'PajakMasukan');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'Hasil Impor Pajak Masukan - ' + Date.now() + '.xlsx');
    await wb.xlsx.writeFile(outFile);
    emit('Selesai. ' + ringkasan(results) + '. Hasil tersimpan di: ' + outFile);

    return { ctx: ctx, outFile: outFile, rows: results, ringkasan: tally(results) };
}

/* ------------------------------------------------------------------ *
 *  Alur: unduh data Pajak Masukan sebagai Excel
 *  Bukan tiruan tombol "Ekspor ke Excel" milik Coretax sendiri - tombol itu TERBUKTI murni
 *  client-side (diverifikasi live: nol network request saat diklik, exceljs generate dari baris
 *  yang KEBETULAN sedang termuat/terpaginasi di grid). Kita generate sendiri dari /inputinvoice/list
 *  (sumber data yang sama, tapi mengambil SEMUA baris lewat paging listByPeriod, bukan hanya
 *  yang sedang tampil), memakai header yang sama seperti kolom grid aslinya.
 * ------------------------------------------------------------------ */

const DOWNLOAD_COLUMNS = [
    { header: 'NPWP Penjual', key: 'npwp', width: 20 },
    { header: 'Nama Penjual', key: 'nama', width: 30 },
    { header: 'Nomor Faktur Pajak', key: 'noFaktur', width: 22 },
    { header: 'Tanggal Faktur Pajak', key: 'tanggal', width: 14 },
    { header: 'Masa Pajak', key: 'masaPajak', width: 14 },
    { header: 'Tahun', key: 'tahun', width: 9 },
    { header: 'Masa Pajak Pengkreditkan', key: 'masaKredit', width: 18 },
    { header: 'Tahun Pajak Pengkreditan', key: 'tahunKredit', width: 10 },
    { header: 'Status Faktur', key: 'status', width: 14 },
    { header: 'Harga Jual/Penggantian/DPP', key: 'dpp', width: 18 },
    { header: 'DPP Nilai Lain/DPP', key: 'dppLain', width: 18 },
    { header: 'PPN', key: 'ppn', width: 15 },
    { header: 'PPnBM', key: 'ppnbm', width: 12 },
    { header: 'Perekam', key: 'perekam', width: 24 },
    { header: 'Referensi', key: 'referensi', width: 20 },
    { header: 'Valid', key: 'valid', width: 8 },
    { header: 'Dilaporkan', key: 'dilaporkan', width: 11 },
    { header: 'Dilaporkan oleh Penjual', key: 'dilaporkanPenjual', width: 11 }
];

function invoiceToRow(x) {
    return {
        npwp: x.SellerTIN || '', nama: x.SellerTaxpayerName || '', noFaktur: x.TaxInvoiceNumber || '',
        tanggal: x.TaxInvoiceDate ? String(x.TaxInvoiceDate).slice(0, 10) : '',
        masaPajak: MONTH_ID[PERIOD_MONTH[x.TaxInvoicePeriod]] || x.TaxInvoicePeriod || '', tahun: x.TaxInvoiceYear || '',
        masaKredit: x.PeriodCredit ? (MONTH_ID[PERIOD_MONTH[x.PeriodCredit]] || x.PeriodCredit) : '',
        tahunKredit: x.YearCredit || '', status: x.TaxInvoiceStatus || '',
        dpp: x.SellingPrice, dppLain: x.OtherTaxBase, ppn: x.VAT, ppnbm: x.STLG,
        perekam: x.Signer || '', referensi: x.Reference || '',
        valid: x.Valid ? 'YA' : 'TIDAK', dilaporkan: x.ReportedByBuyer ? 'YA' : 'TIDAK',
        dilaporkanPenjual: x.ReportedBySeller ? 'YA' : 'TIDAK'
    };
}

/** @param {object} o { page, masaList (array "MMYY"), saveRoot, entityFolder, emit } */
async function runDownloadExcel(o) {
    const emit = o.emit || function (m) { log(m); };
    const page = o.page;
    if (!o.masaList || !o.masaList.length) throw new Error('Masa wajib diisi.');

    const ctx = await getContext(page);
    emit('WP aktif: ' + (ctx.nama || '-') + ' (' + ctx.npwp + '), sesi tersisa ~' + ctx.tokenExpiresInSec + ' detik.');

    const allRows = [];
    for (const mmYY of o.masaList) {
        const month = parseInt(mmYY.slice(0, 2), 10);
        const year = '20' + mmYY.slice(2);
        const code = PERIOD_CODE[month];
        if (!code) { emit('Masa tidak valid dilewati: ' + mmYY); continue; }
        const rows = await listByPeriod(page, ctx, [code], year, null);
        emit(periodLabel(code, year) + ': ' + rows.length + ' faktur.');
        rows.forEach((x) => allRows.push(invoiceToRow(x)));
    }
    emit('Total ' + allRows.length + ' faktur dari ' + o.masaList.length + ' masa.');

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pajak Masukan');
    ws.columns = DOWNLOAD_COLUMNS;
    ws.getRow(1).font = { bold: true };
    allRows.forEach((r) => ws.addRow(r));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: DOWNLOAD_COLUMNS.length } };

    const saveRoot = o.saveRoot || path.join(os.homedir(), 'Downloads', 'CoretaxAgent');
    const dir = path.join(saveRoot, o.entityFolder || 'PajakMasukan', 'PajakMasukan');
    fs.mkdirSync(dir, { recursive: true });
    const label = o.masaList.length === 1 ? o.masaList[0] : (o.masaList[0] + '-' + o.masaList[o.masaList.length - 1]);
    const outFile = path.join(dir, 'Pajak Masukan - ' + label + ' - ' + Date.now() + '.xlsx');
    await wb.xlsx.writeFile(outFile);
    emit('Selesai. Tersimpan di: ' + outFile);

    return { ctx: ctx, outFile: outFile, totalRows: allRows.length };
}

module.exports = {
    runCreditByPeriod, creditOne, runUncreditByPeriod, uncreditOne, runImportFromExcel, runDownloadExcel, findByNumber, listByPeriod, getContext,
    checkEligibility, checkUncreditEligibility, crossCheck, normalizeFakturNo, normalizeNpwp, parseTargetMasaInput,
    monthDistance, periodLabel, PERIOD_CODE, PERIOD_MONTH, MONTH_ID, STATUS,
    __test: { buildFetchScript, tally, findHeaderRow, processExcelRow }
};
