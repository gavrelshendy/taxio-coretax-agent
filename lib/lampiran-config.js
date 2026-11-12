/* Lampiran printing: shared constants - per-SPT-type config (TAXTYPE_CONFIG), Coretax returnsheet
 * API base, print scales, and which grid API endpoints feed which lampiran tab. Split out of
 * automation/lampiran.js (still the public entry point). */

const RETURNSHEET_API = 'https://coretaxdjp.pajak.go.id/returnsheetportal/api';
const ZERO_DOCUMENT_ID = '00000000-0000-0000-0000-000000000000';

const TAXTYPE_CONFIG = {
    ICT_RCIT: {
        formCode: 'SPT Tahunan PPh Badan', annual: true, pathKind: 'corporate-income-tax-return',
        rootSelector: 'rshshr-corporate-income-tax-return',
        title: 'SPT TAHUNAN PAJAK PENGHASILAN (PPh) WAJIB PAJAK BADAN'
    },
    ICT_PIT: {
        formCode: 'SPT Tahunan PPh Orang Pribadi', annual: true, pathKind: 'personal-income-tax-return',
        rootSelector: 'rshshr-personal-income-tax-return',
        title: 'SPT TAHUNAN PAJAK PENGHASILAN (PPh) WAJIB PAJAK ORANG PRIBADI'
    },
    ICT_WIT: {
        formCode: 'SPT MASA PPH 21-26', pathKind: 'article-21-26-tax-return',
        rootSelector: 'rshshr-article-twentyone-twentysix-tax-return',
        title: 'SPT MASA PAJAK PENGHASILAN (PPh) PASAL 21 DAN/ATAU PASAL 26',
        sourceTitle: 'PEMOTONGAN PPH PASAL 21 DAN/ATAU PASAL 26', repeatHeader: true
    },
    ICT_WT: {
        formCode: 'SPT MASA PPH UNIFIKASI', pathKind: 'withholding-tax-return',
        rootSelector: 'rshshr-withholding-return', title: 'SPT MASA PPH UNIFIKASI', repeatHeader: true
    },
    VAT_VAT: {
        formCode: 'SPT MASA PPN', pathKind: 'value-added-tax-return',
        rootSelector: 'rshshr-normal-value-add-tax-return',
        title: 'SURAT PEMBERITAHUAN MASA PAJAK PERTAMBAHAN NILAI (SPT MASA PPN)', repeatHeader: true
    }
};
const TAB_TITLE_SEL = '.p-tabview-title';
const TWO_VERSION_TABS = new Set(['L3', 'L4', 'L9']);
const TAB_ROW_CAP = { L9: 10 };
const COMPACT_ROWS = 50;
const PRINT_SCALE = 0.9;
const MONTHLY_PAGINATOR_SCALE = { 'ICT_WIT:L-III': 0.75, 'ICT_WT:DAFTAR-I': 0.75 };
const ANNUAL_PRINT_SCALE = {
    'ICT_PIT:Induk': 0.84, 'ICT_PIT:L-2': 0.88,
    'ICT_RCIT:Induk': 0.84, 'ICT_RCIT:L9': 0.8, 'ICT_RCIT:L11-B': 0.8
};
const PPH21_API_GRIDS = {
    'L-IA': ['/loadarticle2126/l1a-grid'],
    'L-IB': ['/loadarticle2126/l1b-bpa1-grid', '/loadarticle2126/l1b-bpa2-grid'],
    'L-II': ['/loadarticle2126/l2-bpa1-grid', '/loadarticle2126/l2-bpa2-grid'],
    'L-III': ['/loadarticle2126/l3-bp21-grid', '/loadarticle2126/l3-bp26-grid']
};
const UNIFIKASI_API_GRIDS = {
    'DAFTAR-I': ['/loadwtr/list-i-bpu-grid', '/loadwtr/list-i-bpnr-grid'],
    'DAFTAR-II': ['/loadwtr/list-ii-sp-grid', '/loadwtr/list-ii-cy-grid'],
    'LAMPIRAN-I': ['/loadwtr/attachment-i-grid']
};
const PPN_API_GRIDS = {
    'A-1': ['/loadndvat/la1-grid'],
    'A-2': ['/loadndvat/la2-grid'],
    'B-1': ['/loadndvat/lb1-grid'],
    'B-2': ['/loadndvat/lb2-grid'],
    'B-3': ['/loadndvat/lb3-grid'],
    'C': ['/loadndvat/lc-grid']
};
const ANNUAL_API_GRIDS = {
    ICT_RCIT: {
        'L3': [
            { suffix: '/loadcit/l3-table-b-grid', signature: 'NAMA PEMOTONG/PEMUNGUT.*NPWP.*JENIS PAJAK' }
        ],
        'L4': [
            { suffix: '/loadcit/l4-table-a-grid', signature: 'NPWP PEMOTONG/PEMUNGUT.*KODE OBJEK PAJAK' }
        ],
        'L9': [
            { suffix: '/loadcit/l9-table-1-grid', signature: 'KODE HARTA.*KELOMPOK/JENIS HARTA', allVariants: true, tableIndexOffset: 0 },
            { suffix: '/loadcit/l9-table-2-grid', signature: 'KODE HARTA.*KELOMPOK/JENIS HARTA', allVariants: true, tableIndexOffset: 5 },
            { suffix: '/loadcit/l9-table-3-grid', signature: 'KODE HARTA.*KELOMPOK/JENIS HARTA', allVariants: true, tableIndexOffset: 7 }
        ]
    },
    ICT_PIT: {
        'L-1': [
            { suffix: '/loadpit/l1-table-a1-grid', signature: 'NOMOR AKUN.*ATAS NAMA' },
            { suffix: '/loadpit/l1-table-a2-grid', signature: 'LOKASI PENERIMA PINJAMAN' },
            { suffix: '/loadpit/l1-table-a3-grid', signature: 'NPWP BANK/INSTITUSI/PENERIMA INVESTASI' },
            { suffix: '/loadpit/l1-table-a4-grid', signature: 'MERK/MODEL' },
            { suffix: '/loadpit/l1-table-a5-grid', signature: 'UKURAN PROPERTI - TANAH' },
            { suffix: '/loadpit/l1-table-a6-grid', signature: 'BUKTI KEPEMILIKAN' },
            { suffix: '/loadpit/l1-table-d-grid', signature: 'NAMA PEMBERI KERJA' },
            { suffix: '/loadpit/l1-table-e-grid', signature: 'NAMA PEMOTONG/PEMUNGUT PPh' }
        ],
        'L-2': [
            { suffix: '/loadpit/l2-table-a-grid', signature: 'KODE OBJEK PAJAK.*DASAR PENGENAAN PAJAK' }
        ]
    }
};
const PPH21_LAMPIRAN_TITLES = {
    'L-IA': 'Daftar Pemotongan Bulanan Pajak Penghasilan Pasal 21 bagi Pegawai Tetap dan Pensiunan yang Menerima Uang Terkait Pensiun secara Berkala serta bagi PNS, Anggota TNI, Anggota Polri, Pejabat Negara, dan Pensiunannya',
    'L-IB': 'Daftar Pemotongan Pajak Penghasilan Pasal 21 bagi Pegawai Tetap dan Pensiunan yang Menerima Uang Terkait Pensiun secara Berkala serta bagi PNS, Anggota TNI, Anggota Polri, Pejabat Negara, dan Pensiunannya untuk Masa Pajak Terakhir',
    'L-II': 'Daftar Pemotongan Satu Tahun Pajak atau Bagian Tahun Pajak PPh Pasal 21 bagi Pegawai Tetap dan Pensiunan yang Menerima Uang Terkait Pensiun secara Berkala serta bagi PNS, Anggota TNI, Anggota Polri, Pejabat Negara, dan Pensiunannya',
    'L-III': 'Daftar Pemotongan Pajak Penghasilan Pasal 21 dan/atau Pasal 26 selain Pegawai Tetap atau Pensiunan yang Menerima Uang Terkait Pensiun secara Berkala'
};
const PRINT_STYLE_ID = '__ca_print_style';

module.exports = { RETURNSHEET_API, ZERO_DOCUMENT_ID, TAXTYPE_CONFIG, TAB_TITLE_SEL, TAB_ROW_CAP, COMPACT_ROWS, PRINT_SCALE, PPH21_API_GRIDS, UNIFIKASI_API_GRIDS, PPN_API_GRIDS, ANNUAL_API_GRIDS, PPH21_LAMPIRAN_TITLES, PRINT_STYLE_ID };
