# Coretax: upload XML e-Bupot & buat Konsep SPT (hasil investigasi live, 2026-11-07)

Diuji live pada satu entitas Badan (impersonate PIC) dengan bukti potong dummy (NIK sementara `9990000000999000`,
nilai kecil, masa yang belum dilaporkan), lalu dihapus dari Belum Terbit. Tidak ada yang diterbitkan. Kode
halaman Coretax dibaca dari bundle publik (`withholding-slips-portal/id-ID/main.*.js`,
`returnsheets-portal/id-ID/main.*.js`).

## Sesi & header

- Base e-Bupot: `https://coretaxdjp.pajak.go.id/withholdingslipsportal/api`
- Base SPT: `https://coretaxdjp.pajak.go.id/returnsheetportal/api`
- Header: `Authorization` (Bearer, ditangkap dari request halaman) + `x-dgt-code`; fetch dari dalam halaman
  Coretax (`credentials: 'include'`).
- `TaxpayerAggregateIdentifier` = claim `taxpayer_id` di JWT (entitas yang di-impersonate).
- Impersonate disimpan per tab: tab baru ke portal SPT jatuh ke `/401` - pakai tab yang sudah login, navigasikan.

## Upload XML e-Bupot (bulk, satu langkah)

`POST {e-Bupot}/uploadcreateebupot{fcode}/validate-upload-xml` - multipart: `file` (XML), `TaxpayerAggregateIdentifier`.

- `fcode`: `mp` (BPMP), `bp21`, `bpa1`, `bpu` (BPPU), juga `bp26`, `bpa2`, `bpnr`, `sp`, `cy`.
- Jawaban langsung `{IsSuccessful: true, Payload: null}`: file **diantrikan**; validasi dan pembuatan berjalan
  di latar. Bila valid, bukti potong langsung dibuat di **Belum Terbit** (status `SUBMITTED`, nomor belum ada).
  Tidak ada langkah "simpan" terpisah (`uploadEbupot`/`CommandList` di kode lama tidak terpakai).
- Satu XML = banyak bukti potong (`ListOf...`) - unggah per file.
- Hasil: `POST {e-Bupot}/withholdingslipsxmlmonitoring/xml-monitoring` `{TaxpayerAggregateIdentifier, EbupotType: "EBUPOTMP"|...}`
  -> per file: `FileName`, `Status` (`VALIDATING DATA` -> `SUBMITTING EBUPOT FINISHED` / `VALIDATING FAILED`),
  `ErrorMessage` (sukses: "N EBUPOTMP successfully created."; gagal: JSON `[{Line, Message, FieldName}]` - file
  yang gagal tidak membuat apa pun). Proses beberapa detik (BPA1 lebih lama).
- Belum Terbit: `POST {e-Bupot}/getebupot{fcode}notissued` (filter `TaxPeriodCode` `MMMMYYYY`; BPA1 `IncomePeriodCodeEnd`).
- Hapus Belum Terbit / batalkan Telah Terbit: `POST {e-Bupot}/cancelebupot{fcode}` `{EBUPOTIdentifiers: [{RecordIdentifier: RecordId,
  WithholdingslipsAggregateIdentifier, WithholdingSlipsStatus, UnderAuditValue, ...}]}` (status SUBMITTED = dihapus).
  Tanpa tanda tangan untuk BPMP; BP21/BP26/BPA1/BPA2/BPU/BPNR yang sudah terbit memakai form e-sign.
- Terbitkan (`/issueebupot{fcode}`) butuh tanda tangan (passphrase) untuk BP21/BPA1/BPU dkk. - **tetap manual**.
- Template resmi: `POST {e-Bupot}/DownloadWithholdingSlips/download-template` `{EbupotType: "EBUPOTMP"}` -> XML.

### Struktur XML (template resmi)

- BPMP `MmPayrollBulk > TIN, ListOfMmPayroll > MmPayroll`: TaxPeriodMonth, TaxPeriodYear, CounterpartOpt
  (Resident/Foreign), CounterpartPassport, CounterpartTin, StatusTaxExemption (TK/0..), Position, TaxCertificate
  (N/A|DTP..), TaxObjectCode (21-100-01..), Gross, Rate, IDPlaceOfBusinessActivity (TKU pemotong 22 digit), WithholdingDate.
- BP21 `Bp21Bulk > TIN, ListOfBp21 > Bp21`: TaxPeriodMonth, TaxPeriodYear, CounterpartTin,
  IDPlaceOfBusinessActivityOfIncomeRecipient (**TKU penerima, 22 digit = NIK + 000000**; `000000` ditolak),
  StatusTaxExemption, TaxCertificate, TaxObjectCode, Gross, Deemed (mis. 21-100-14 harus 100), Rate, Document,
  DocumentNumber, DocumentDate, IDPlaceOfBusinessActivity, WithholdingDate.
- BPPU `BpuBulk > TIN, ListOfBpu > Bpu`: TaxPeriodMonth, TaxPeriodYear, CounterpartTin,
  IDPlaceOfBusinessActivityOfIncomeRecipient, TaxCertificate, TaxObjectCode (24-104-..), TaxBase, Rate, Document
  (mis. StatementLetter), DocumentNumber, DocumentDate, IDPlaceOfBusinessActivity, GovTreasurerOpt, SP2DNumber, WithholdingDate.
- BPA1 `A1Bulk > TIN, ListOfA1 > A1`: 27 elemen (lihat `lib/a1-desember.js` buildXml). NIK harus terdaftar:
  NIK sementara ditolak ("Gender tidak boleh null").

## Bulk Process (menu Bulk Process / Monitoring di halaman e-Bupot)

Pekerjaan per masa yang diantrikan; hasilnya di Monitoring.
- `POST {e-Bupot}/withholdingslipsbulkprocess/issuedall` `{TaxpayerAggregateIdentifier, RepresentativeAggregateIdentifier
  (RepresentativeId bila impersonate), EbupotType, Period: "MMMMYYYY"}` = **Diterbitkan Masa Pajak** (`BP001`): menerbitkan
  SEMUA Belum Terbit masa itu. BPMP tanpa tanda tangan; BP21/BPA1/BPU dkk. lewat form e-sign. **Tidak diuji** (menerbitkan = manual).
- `POST {e-Bupot}/EbupotExport/export` `{TaxpayerAggregateIdentifier, TaxpayerAggregateIdentifierRepresentative: null,
  TaxpayerAggregateIdentifierCorporate: null, PeriodCode, BulkProcessType: "BP002", EbupotType}` = Download CSV by Period;
  `Message` = RecordId pekerjaan. Diuji live: Pending -> Done ~70 detik, hasil ZIP `<NPWP>_EBUPOTMP_<masa>.zip`.
- `BP003` Download PDF by Period: `POST /downloadwithholdingslips/download-all-by-period-pdf` `{TaxpayerAggregateIdentifier, EbupotType, PeriodCode}`.
- Monitoring: `POST {e-Bupot}/withholdingslipsbulkprocess/bulk-process-monitoring` (grid: First, Rows, Filters,
  TaxpayerAggregateIdentifier, BulkProcessType, EbupotType) -> `Status` Pending/Done, `ErrorMessage`;
  detail: `.../bulk-process-monitoring-detail` `{RecordId, ...}` -> `FileName`, `Url` file hasil.

Perbandingan waktu (live): upload XML membuat bukti potong dalam ~1-2 detik sesudah diunggah (file 6 bukti potong:
selesai dalam detik yang sama); Bulk Process adalah antrian (ekspor CSV ~70 detik). Upload XML = membuat Belum Terbit;
Bulk Process = menerbitkan / mengekspor yang sudah ada - keduanya bukan pengganti satu sama lain.

## Buat Konsep SPT

`POST {SPT}/createreturnsheet` `{TaxpayerAggregateIdentifier, TaxPeriodCode: "MMMMYYYY", TaxTypeCode, ReturnSheetTypeCode,
ReturnSheetModelCode, TaxObjectNumber: "", isEffFlag: true, ReturnSheetPeriodType: null}`. Diuji live 2026-11-07:
- Berhasil (Unifikasi, masa yang belum ada SPT-nya): `IsSuccessful: true`; konsep muncul di `/returnsheetsnotsubmitted`
  dengan `ReturnSheetStatusCode: "CREATED"`.
- Ditolak bila jenis SPT yang sama masih punya konsep berstatus Draft (masa mana pun): "Pembuatan SPT Masa PPh Pasal 21/26
  tidak dapat dilakukan karena masih terdapat SPT dengan status Draft..." - selesaikan / hapus draft itu dulu.
- Daftar konsep: `POST {SPT}/returnsheetsnotsubmitted` (grid: First, Rows, Filters, TaxpayerAggregateIdentifier) ->
  RecordId, TaxTypeCode, TaxPeriodCode, ReturnSheetModel (NORMAL/AMENDMENT), ReturnSheetStatusCode (CREATED/DRAFT).
- Implementasi: `lib/coretax-import.js` createKonsep; Pilot `/api/actions/create-konsep`; MCP `create_konsep_spt`.

Isian dari dropdown (read-only, diuji live):
- `/createreturnsheettaxtypes` `{TaxpayerAggregateIdentifier, LanguageCode: "id-ID"}` -> `Payload.Details`:
  `ICT_WIT` PPh Pasal 21/26, `ICT_WT` PPh Unifikasi, `ICT_RCIT` PPh Badan, `VAT_VAT` PPN, ...
- `/createreturnsheetreturnsheettypes` `{TaxTypeCode}` -> `ICT_WITR` (SPT Masa PPh 21/26), `ICT_WTR` (SPT Masa Unifikasi).
- `/createreturnsheettaxperiods` `{TaxpayerAggregateIdentifier, TaxTypeCode, ReturnSheetPeriodTypeCode: null, TaxObjectNumber: null}` -> kode masa.
- `/createreturnsheetreturnsheetmodels` `{TaxpayerAggregateIdentifier, TaxTypeCode, PeriodCode, ReturnSheetTypeCode, TaxObjectNumber: ""}`
  -> `NORMAL`, atau `AMENDMENT` (Pembetulan) bila masa itu sudah punya SPT.
- Jawaban gagal karena "kriteria" -> halaman mengulang dengan `isEffFlag: false`.

Sesudah konsep dibuat, lampiran SPT diisi dari bukti potong Telah Terbit ("Posting"); alur posting di form
SPT PPh 21 belum dipetakan (kodenya chunk terpisah yang dimuat saat SPT dibuka).
