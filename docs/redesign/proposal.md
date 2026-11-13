# Taxio Pilot v4 — Usulan Desain Ulang Dashboard ("Graphite")

Untuk: pemilik (keputusan). Pelaksana: engineer. Status: usulan, belum ada kode yang diubah.
Dasar: repo `audit/arch-hardening` @ 161f9e4, 91 tangkapan layar UI sekarang (`current\`), dan mockup klik `mockup.html`
(tangkapan layarnya di `mockup-shots\`, tema gelap dan terang, 1280×860 dan 1000×700).

Aturan bahasa tetap: teks alat dalam bahasa Inggris alami (judul Title Case, tombol/tab/petunjuk sentence case);
istilah Coretax tetap persis (Bukti Potong Saya, Belum Terbit, Telah Terbit, Masa Pajak, Jenis Pajak, Konsep SPT,
Lampiran, Pembetulan, Batalkan, Kode Billing, Dokumen yang Dipersamakan, PIC, …).

**Keputusan pemilik yang sudah final dan dipakai di sini:** gaya visual "Graphite" (gelap netral, satu aksen
periwinkle); tema **terang dan gelap** bisa dipilih (System / Light / Dark); sidebar bisa diciutkan; minimalis dengan
animasi halus yang bermakna; kontrol proses hanya **Stop** dan **Pause/Resume** selama berjalan.

---

## 1. Ringkasan dalam 10 kalimat

1. Halaman utama baru adalah **Runs**: satu daftar semua proses dari PC ini, dikelompokkan menurut status — *Needs
   your decision*, *Running*, *Queued*, *Failed or Stopped*, *Finished today* — dengan progres per proses, alasan
   ditahan, dan folder hasil.
2. Klien bukan lagi "status global" di topbar; klien adalah **isian "For" di setiap formulir** (satu atau banyak klien,
   plus grup tersimpan). Tab sesi, chip entitas, tombol "Sign in to Coretax" dan "New session" hilang dari topbar.
3. Jendela Chrome per PIC (`ANDI #1`, `#2`, …) tampil di tab **Coretax windows** di halaman Runs dan sebagai meter
   kecil "5/6" di topbar; login terjadi otomatis saat proses mulai.
4. Sidebar dikelompokkan menurut **akibatnya**: *Download* (hanya membaca), *Change in Coretax* (mengubah data),
   *Year-End*; setiap halaman memberi label "Read-only" atau "Changes data in Coretax".
5. Panel ringkasan kanan diganti **satu bilah aksi lengket** di bawah formulir: satu kalimat ("3 downloads · PPh 21/26 ·
   Masa Pajak 10/2026 · PT … → D:\…\SPT") dan satu tombol utama; folder tujuan dan opsi jarang dipakai ada di balik
   "Options".
6. Banyak klien sekaligus: pilih di "For" atau pakai grup → dialog **Review 12 runs** yang menjelaskan per klien
   "Starts now / Queued #4 / Skipped: identical run in progress" → masuk antrean server yang sudah ada.
7. Aksi yang mengubah Coretax memakai **tiga tingkat konfirmasi**: baca-saja tanpa konfirmasi; membuat draf/record
   satu dialog; tidak bisa dibatalkan (issue & sign, Pembetulan, Batalkan, kredit Faktur Masukan, NIK Pembetulan)
   wajib pratinjau + centang pernyataan, dan Batalkan juga mengetik kode klien.
8. Log tidak pernah menutupi formulir: log ada **per proses** di panel detail, ditambah **strip satu baris** di bawah
   yang mendorong konten ke atas (bisa dibuka 150 px) dan hanya menampilkan baris terakhir proses yang dipilih, bukan
   kebisingan global.
9. Kontrol proses dapat dipercaya: selama bekerja hanya **Stop** dan **Pause/Resume**, dengan umpan balik langsung
   ("Stopping after the current file…"); *Try again* / *Skip Masa Pajak 0726* / *Stop* muncul hanya saat proses
   ditahan, dan sesudah Stop proses menyebut apa yang sudah dan belum dikerjakan ("14 of 40 Faktur Masukan credited;
   26 not processed") dengan tautan ke folder/laporan.
10. Tetap vanilla JS + CSS tanpa build; semua warna lewat token CSS (gelap/terang), animasi 120–240 ms dengan satu
    kurva, hanya transform/opacity, dan `prefers-reduced-motion` dihormati.

---

## 2. Apa yang sebenarnya ingin dikerjakan pengguna (jobs)

| Job | Frekuensi | Fitur sekarang | Yang dibutuhkan |
|---|---|---|---|
| **Kepatuhan bulanan banyak klien**: tarik SPT/BPE/Lampiran, e-Bupot, e-Faktur, Bukti Potong Saya per Masa Pajak | tiap bulan, 10–50 klien | SPT, e-Bupot, Bukti Potong Saya, e-Faktur | jalankan untuk 12 klien sekali klik, tahu mana yang macet, temukan file |
| **Menerbitkan Bukti Potong**: unggah Excel ke Belum Terbit, lalu issue & sign | tiap bulan | e-Bupot Upload & Issue | pratinjau persis yang akan terbit, konfirmasi jelas, tidak salah klien |
| **Memperbaiki Bukti Potong yang salah**: cari, Pembetulan, Batalkan | insidental, berisiko | NIK Pembetulan (A1), API find/amend/cancel (hanya MCP) | cari cepat, lihat sebelum/sesudah, konfirmasi berlapis |
| **Akhir tahun A1**: rekap PPh 21 setahun, NIK Pembetulan, BPA1 XML | tahunan, padat | Annual PPh 21 Recap | tiga langkah jelas mana baca, mana ubah, mana file lokal |
| **Tugas lain di Coretax**: Kode Billing PPh 25, kredit Faktur Masukan, e-Reporting Dividen, Konsep SPT | bulanan | halaman masing-masing | formulir pendek, konfirmasi, hasil tercatat |
| **Mengeluarkan dokumen dari Coretax** untuk klien/arsip | terus-menerus | semua unduhan | folder hasil yang jelas per proses |
| **Mengawasi banyak proses paralel** | setiap hari sejak v4 | tab sesi + pil "N queued" | satu tempat melihat semua dan memutuskan |

---

## 3. Masalah UX terpenting (berurutan menurut prioritas)

Tiga teratas **dilaporkan pemilik** dari pemakaian v4 hari ini (prioritas tertinggi).

| # | Masalah | Terlihat di | Mengapa mahal |
|---|---|---|---|
| **1** | **Log menutupi menu utama** (laporan pemilik). Activity log adalah laci bawah yang *menimpa* halaman: saat dibuka, separuh formulir (tile e-Bupot Type, Masa Pajak) tertutup. Baris di header log saat tertutup adalah baris *global* terakhir (mis. error updater merah), bukan proses yang sedang dilihat. | `current\45-run-with-activity-log-open@1280.png` | Pengguna harus menutup log untuk bekerja dan membukanya lagi untuk memeriksa; baris merah yang tak berhubungan menimbulkan panik / salah tafsir. |
| **2** | **Rail ringkasan kanan** (laporan pemilik): angka besar "1 download combinations", baris Entity/Login (duplikat topbar), kolom SAVE TO + Browse, tombol "Start automation" raksasa. Di 1000 px rail memeras formulir sampai tile terpotong ("PPh 21/26" pecah dua baris). | `current\10-spt@1280.png`, `14-e-faktur@1280.png`, `71-start-another-command-back-banner@1000.png` | Separuh lebar layar untuk informasi yang sudah ada; tombol utama jauh dari isian terakhir; folder tujuan (jarang diubah) mengambil tempat utama. |
| **3** | **Kontrol proses tidak dipercaya** (laporan pemilik: "nggak kepake, nggak tahu it works atau enggak"). Setiap proses menampilkan Pause/Back/Retry/Skip/Stop + Rows per page, padahal menurut kode hanya SPT, unduh e-Bupot dan Bukti Potong Saya memanggil `runcontrol.checkpoint()` dan menangani skip/retry/back; Kode Billing dan e-Faktur hanya pause/stop; find/amend/cancel e-Bupot hanya stop; Pajak Masukan (unduh & kredit), Dividen, BPMP NIK amend, issue & sign, upload dan Konsep SPT tidak memeriksa kontrol sama sekali. Tidak ada umpan balik setelah tombol ditekan. | `current\41-run-in-progress@1280.png`, `42-run-on-hold-needs-decision@1280.png`, `44-run-without-plan@1280.png` (Upload e-Bupot dengan tombol Back/Retry/Skip/Rows per page) | Tombol yang tidak berbuat apa-apa merusak kepercayaan pada tombol yang penting (Stop). Saat darurat pengguna tidak tahu apakah proses benar-benar berhenti. |
| 4 | **Tidak ada tempat melihat semua proses.** Proses di sesi lain hanya terlihat sebagai spinner kecil di tab; antrean hanya pil "2 queued" dengan tooltip; tampilan proses hanya untuk entitas yang sedang dipilih. Untuk memeriksa 6 proses paralel harus klik 6 tab. | `current\40-other-session-running-in-background@1280.png`, `70-parallel-tabs-queued-run-view@1280.png`, `72-n-queued-pill@1280.png` | Proses yang *ditahan menunggu keputusan* di sesi lain tidak terlihat → jendela Coretax diam berjam-jam. |
| 5 | **Tampilan proses menggantikan halaman fitur dan judulnya salah.** Topbar bertuliskan "e-Faktur" sementara isinya proses "Upload e-Bupot · PT Contoh…"; banner selesai upload muncul di halaman e-Faktur. "Start another command" diperlukan hanya untuk kembali ke formulir. | `current\45-…`, `46-run-finished-summary@1280.png`, `71-…@1280.png` | Membingungkan proses mana yang sedang dilihat; satu klik ekstra tiap kali mau memulai perintah lain. |
| 6 | **Topbar terlalu padat dan membungkus.** Judul, pil status, chip entitas, ikon refresh, ikon login manual, "Sign in to Coretax", tab sesi, "New session" — tinggi 156–194 px (catatan `current\_layout-notes.txt`), 3 baris di 1000 px. | `current\10-spt@1280.png`, `32-multi-entity-queue-bar@1000.png`, `16-annual-pph21-nik-pembetulan@1280.png` | ±25 % tinggi layar habis untuk kontrol yang jarang dipakai; ikon tanpa label (refresh, orang) tidak jelas artinya. |
| 7 | **Baca-saja vs mengubah Coretax tidak dibedakan.** Grup "Automation" mencampur unduhan (Full-year download), perubahan (NIK Pembetulan) dan file lokal (BPA1 XML); tombol biru yang sama untuk "Start automation" dan "Issue & sign 3 Bukti Potong". Konfirmasi tindakan tak bisa dibatalkan memakai `window.confirm()` bawaan browser (`pages.js` baris 575, 580 untuk **Batalkan BPMP**, 765 untuk issue & sign). | `current\15-…`, `16-…`, `17-annual-pph21-bpa1-xml@1280.png`, `22b-ebupot-issue-sign-preview@1280.png` | Risiko salah klik pada tindakan permanen di DJP; dialog browser mudah di-Enter tanpa dibaca. |
| 8 | **Hasil sulit ditemukan.** Ringkasan selesai berkata "Detailed results are in the activity log" — tanpa folder, tanpa daftar file. Server hanya menyimpan proses selesai *terakhir per jendela* (`lib/runcontrol.js` `runSummaries`) dan tidak mencatat folder keluaran per proses. | `current\46-run-finished-summary@1280.png` | Pengguna membuka Explorer dan menebak folder; setelah proses berikutnya di jendela yang sama, ringkasan lama hilang. |
| 9 | **Banyak klien sekaligus tersembunyi dan rapuh.** Pilihan banyak entitas ada di popover tab sesi (hanya entitas di sesi PIC itu); dijalankan berurutan oleh loop di browser (`entities.js` 240–270) yang mati bila dashboard dimuat ulang, dan tidak memakai antrean paralel server. | `current\31-session-popover-queue@1280.png`, `32-multi-entity-queue-bar@1280.png` | Tugas bulanan 12 klien = 12× pilih-mulai-tunggu; atau batch yang lambat karena serial. |
| 10 | **Fix Bukti Potong tidak punya halaman.** API cari/ubah/batalkan (`/api/ebupot/find`, `amend-preview`, `cancel-preview`, `actions/ebupot-amend`, `actions/ebupot-cancel`) hanya dipakai server MCP. | (tidak ada layar) | Pekerjaan paling berisiko dikerjakan manual di Coretax. |
| 11 | **Pemotongan teks dan campuran bahasa.** Judul "e-Bupot Upload, Iss…" terpotong; label internal "SPT pph21"; teks sistem berbahasa Indonesia di UI berbahasa Inggris ("Folder data dapat ditulis"). Bug kecil: `var(--danger, #dc2626)` di `entities.js` — token `--danger` tidak ada, jadi selalu jatuh ke merah cadangan. | `current\21-ebupot-upload@1280.png`, `70-…`, `50-settings@1280.png` | Terlihat belum selesai; mengurangi kepercayaan. |
| 12 | **Memilih entitas langsung memicu login** (README "Pintasan"): memilih = efek samping membuka jendela Chrome. Ditambah ikon login manual tanpa label di topbar. | `current\04-entity-palette@1280.png` ("Enter use & log in"), `10-spt@1280.png` | Menelusuri klien untuk melihat saja sudah membuka jendela; jendela per PIC terpakai tanpa perlu. |

---

## 4. Arsitektur informasi yang direkomendasikan

### 4.1 Navigasi

```
Runs                          ← beranda; badge kuning = perlu keputusan, abu = aktif
Download                      (Read-only)
  SPT · e-Bupot · Bukti Potong Saya · e-Faktur
Change in Coretax             (Changes data in Coretax)
  e-Bupot Upload & Issue · Fix Bukti Potong · Konsep SPT
  Credit Faktur Masukan · PPh 25 Kode Billing · e-Reporting
Year-End
  Annual PPh 21 Recap         (tab: Full-year download / BPMP NIK Pembetulan / December BPA1 XML,
                               masing-masing berlabel Read-only / Changes / Local file only)
───
Light/Dark theme (ikon) · Settings · akun
```

- Semua label muat tanpa terpotong di 224 px (diperiksa otomatis di tangkapan layar).
- **Sidebar bisa diciutkan** ke rel ikon 56 px: tombol di samping logo (dan logo itu sendiri saat diciutkan),
  pintasan **Ctrl+B**, tooltip per ikon, badge Runs tetap terlihat (angka kuning + titik biru bila ada yang
  berjalan). Status diingat. Di bawah 1100 px lebar jendela otomatis menjadi rel; membukanya di lebar sempit
  menampilkan sidebar *di atas* konten (tanpa menggeser) dengan scrim. Lihat `mockup-shots\40-sidebar-toggled-*`.
- Topbar tinggal satu baris 56 px: judul halaman + grup + label efek (Read-only / Changes data in Coretax), kotak
  **Search (Ctrl K)**, dan meter jendela Coretax "5/6" (klik → tab Coretax windows).

### 4.2 Pemilihan klien/PIC saat banyak proses berjalan

- Klien adalah **parameter proses**, bukan status aplikasi. Setiap formulir punya baris **For** di atas: chip klien
  (kode, nama, PIC; klien dengan 2 PIC punya PIC yang bisa diganti dengan klik), "Add clients" (Ctrl K) dan
  **Saved groups** ("Monthly SPT clients 12").
- Halaman *Download* menerima banyak klien; halaman *Change in Coretax* satu klien per proses (pratinjau per klien).
- Memilih klien **tidak** membuka Chrome. Jendela dibuka/dipakai oleh mesin antrean saat proses mulai (aturan sekarang:
  jendela bebas yang sudah impersonate entitas → jendela bebas lain → jendela baru sampai batas).
- Tab **Coretax windows** (di Runs): per PIC, jendela #1…#3 dengan status (sibuk/ditahan/idle/tidak terbuka), tombol
  *Show*, *Close*, *Sign in now*, dan **Manual session** (pengganti tombol "Open Coretax"; disembunyikan untuk
  Restricted Editor). Lihat `mockup-shots\11-coretax-windows-dark@1280.png`.

### 4.3 Run centre dan model antrean

- Bagian berurutan: **Needs Your Decision** (selalu paling atas, latar kuning lembut, pilihan berlabel langsung di
  baris), **Running** (termasuk baris batch yang bisa dibuka: "e-Bupot for 6 clients · 2 finished · 2 running ·
  2 queued"), **Queued** (posisi + alasan dalam bahasa biasa: "All 6 automation windows are in use" / "Waits for the
  running SPT run of this client"), **Failed or Stopped**, **Finished Today** (ikon folder → buka folder).
- Filter chip: All · Needs decision · Running · Queued · Failed · Finished.
- Klik baris → **panel detail** dari kanan: status, kotak keputusan/hasil, progres per Masa Pajak (pil), folder &
  file, fakta (klien + NPWP, PIC + jendela, efek, waktu, folder), **log proses ini** (`GET /api/run/log?session=run:<id>`),
  dan di kaki hanya **Pause/Resume** dan **Stop this run**.
- Meter topbar dan badge sidebar memberi tahu dari halaman mana pun; toast "PT … needs your decision" saat proses
  berpindah ke ditahan.
- Aturan antrean server tidak berubah dan ditampilkan apa adanya: perintah identik ditolak ("Not started: an identical
  … run is already queued or running"), fitur sama untuk klien sama antre di belakangnya, fitur berbeda paralel.

### 4.4 Pola kontrol proses (keputusan pemilik)

| Keadaan | Yang terlihat | Umpan balik |
|---|---|---|
| Working | ikon spinner, "6 of 12 · 0726", ikon **Pause** dan **Stop** di baris; tombol yang sama di kaki panel detail | — |
| Pausing → Paused | pil "Pausing…" lalu "Paused"; tombol berubah jadi **Resume** | log proses: "Paused. Nothing happens in Coretax until you resume." |
| Needs decision | satu kalimat masalah + pilihan berlabel **Try again** · **Skip Masa Pajak 0426** · **Stop**, masing-masing dengan penjelasan satu baris; tautan "Show the Coretax window to fix it yourself first" | baris pindah ke bagian Running dengan animasi |
| Stopping | pil merah "Stopping…", kotak "Stopping after the current file… The run ends as soon as Masa Pajak 0726 is finished safely." | tombol Stop non-aktif |
| Stopped | "Stopped by you · 14 of 40 Faktur Masukan credited; 26 not processed. What was done in Coretax stays done." + **Open report / Open folder** + **Run the rest again** | log merah satu baris |

- *Back* dan *Rows per page* dihapus dari UI. *Try again*/*Skip* hanya untuk fitur yang melaporkannya
  (API `run.controls`, sedang dikerjakan engineer lain); fitur tanpa langkah ganda hanya punya *Try again* / *Stop*.
- Mockup: `mockup-shots\01-runs-*`, `02-run-needs-decision-*`, `06-run-paused-*`, `08-run-stopping-feedback-*`,
  `08b-run-stopped-after-*`, `07-run-stopped-summary-*`.

### 4.5 Log yang tidak menutupi pekerjaan (keputusan untuk laporan pemilik #1)

- Log utama = **log per proses** di panel detail.
- **Strip satu baris** di bawah area konten, bagian dari tata letak (konten menyusut, tidak ditimpa): ikon status,
  klien, fitur, baris log terakhir *proses terpilih* (default: yang perlu keputusan, lalu yang terakhir aktif), tombol
  *Details*. Klik → panel 150 px terbuka dengan pemilih proses ("Log of CSA · SPT | STI · e-Bupot | …").
  `mockup-shots\13-log-strip-open-*`.
- Pesan global (updater, koneksi Taxio Hub) tidak masuk strip: ke toast/banner dan Settings › System check (log
  aplikasi lengkap tetap bisa dibuka lewat `GET /api/log-file`).

### 4.6 Formulir: bilah aksi menggantikan rail kanan (laporan pemilik #2)

Sebelum: `current\10-spt@1280.png` (rail 360 px: angka besar, Entity/Login, SAVE TO, tombol raksasa).
Sesudah: `mockup-shots\12-spt-one-client-*` dan `17-spt-many-clients-dark@1280.png`.

- Formulir satu kolom: label di kiri (150 px), kontrol di kanan, garis tipis antar baris, tanpa kartu.
- **Bilah aksi lengket** di bawah: kalimat ringkas "**36 downloads** · PPh 21/26 · Masa Pajak 07–09/2026 · 12 clients
  → D:\Contoh\CoretaxAgent\<client>\SPT", baris kedua "Read-only: nothing is submitted or changed in Coretax.", satu
  tombol utama (`Start download` / `Review 12 runs` / `Preview Belum Terbit` / `Issue & sign 3 Bukti Potong…`).
  **Ctrl+Enter** menekan tombol utama.
- Folder tujuan, dokumen (BPE/Induk/Lampiran), format, layout PDF → disclosure **Options** (tertutup).
- Formulir tetap terbuka setelah mulai; toast "12 SPT runs added · View runs".

### 4.7 Banyak klien (batch "jalankan untuk 12 klien")

1. For: Add clients (multi-pilih di palet, Space untuk centang) atau Saved groups.
2. Tombol menjadi **Review 12 runs** → dialog per klien: PIC, "Starts now" / "Queued #5" / "Queued #4: after the
   running SPT run of this client" / "Skipped: an identical run is already in progress".
3. **Start 12 runs** → klien mengirim 12 permintaan aksi sekaligus dengan label batch; antrean server yang menjadwalkan
   (tidak ada lagi loop serial di browser).
4. Di Runs: satu baris batch dengan progres "5 of 12 clients", bisa dibuka; anak yang ditahan juga muncul di
   *Needs Your Decision*. Stop batch = konfirmasi satu kali; yang antre dibatalkan, yang selesai tetap.

Batch hanya untuk halaman *Download* pada fase awal (lihat pertanyaan terbuka).

### 4.8 Konfirmasi: baca-saja vs mengubah Coretax

| Tingkat | Contoh | Pola |
|---|---|---|
| 0 Read-only | semua Download, Full-year download, Check the Excel, Download Konsep SPT, Find | tanpa konfirmasi; label "Read-only" di topbar dan bilah aksi |
| 1 Membuat draf / record | Upload to Belum Terbit, Create Konsep SPT, Posting, Create Kode Billing, e-Reporting import / create case | dialog satu langkah dengan fakta (klien + NPWP, apa yang dibuat), tombol berlabel kerja ("Upload") |
| 2 Tidak bisa dibatalkan dari Taxio Pilot | Issue & sign, Amend (Pembetulan), Credit Faktur Masukan, BPMP NIK Pembetulan | **pratinjau wajib** (langkah 1 of 2, baca-saja) → dialog: fakta, akibat dalam kotak kuning, **centang pernyataan** mengaktifkan tombol |
| 2+ Batalkan | Cancel Bukti Potong | seperti 2, kotak merah, tombol merah, **ketik kode klien** ("Type CSA to confirm") |

Semua `window.confirm()` diganti dialog ini. Token pratinjau server yang sudah ada (mis. kode konfirmasi issue) tetap
dipakai: bila Belum Terbit berubah sebelum konfirmasi, proses berhenti dan meminta pratinjau ulang.
Mockup: `21-issue-step1` → `22-issue-skeleton` → `23-issue-preview` → `24/25-issue-confirm` → `26-issue-added-to-runs`;
`27/28-upload-*`; `29-fix-results`, `30-fix-cancel-typed`.

### 4.9 Restricted Editor

- Halaman yang tidak boleh dipakai **tidak tampil** (Annual PPh 21 Recap, e-Bupot Upload & Issue, Fix Bukti Potong,
  Konsep SPT), klien lokal dan Manual session tidak ada; opsi terkunci tetap terlihat dengan gembok dan satu kalimat
  alasan ("SPT PPh 21/26 is not available for Restricted Editor"). Akun di kaki sidebar menulis "Restricted Editor".
  `mockup-shots\41-restricted-spt-dark@1280.png`, `42-restricted-picker-*`.

### 4.10 Keadaan kosong / pertama kali

Runs kosong: tiga langkah (Pick clients · Choose what to do · Follow it here) dan satu tombol **Start your first
download** yang membuka SPT dengan palet klien. Strip log: "No runs yet." `mockup-shots\50-first-run-*`.

### 4.11 Keyboard

Ctrl+K / Alt+K palet (klien, NPWP dengan/ tanpa spasi, Saved groups, halaman, proses yang perlu keputusan, perintah:
ciutkan sidebar, ganti tema, tambah klien di PC ini) · Ctrl+B sidebar · Ctrl+Enter tombol utama · Esc menutup lapisan
teratas · ↑/↓/Enter di palet · Space mencentang di mode multi-pilih · Enter/Space membuka baris proses.

### 4.12 Alternatif yang ditolak

- **Mempertahankan tab sesi + popover "All runs"**: klien tetap status global; tab meluap di 6+ jendela; keputusan di
  tab lain tetap tersembunyi.
- **Daftar proses di setiap halaman fitur**: tidak ada gambaran lintas fitur; proses yang ditahan di fitur lain
  terlewat.
- **Papan kanban per status**: kolom kosong hampir selalu, tidak muat di 1000 px.
- **Log sebagai panel kanan permanen**: memakan lebar yang sama dengan rail yang tidak disukai pemilik.
- **Framework (React/Svelte) + build step**: keuntungan (komponen, state) tidak sebanding dengan biaya (toolchain,
  build di installer, migrasi semua halaman, risiko regresi Electron). Dua helper kecil (FLIP list, dialog) cukup.

---

## 5. Peta sebelum → sesudah (tidak ada yang hilang)

| Sekarang | Sesudah |
|---|---|
| Sign in, Sign up, pemulihan sesi (`auth.js`) | sama, memakai token tema |
| Sidebar *Download*: SPT, e-Bupot, Bukti Potong Saya, e-Faktur | *Download*: nama sama; formulir satu kolom + bilah aksi |
| SPT › Lampiran options, format, Save to + Browse | SPT › Options (disclosure) |
| *Automation* › Annual PPh 21 Recap (3 tab) | *Year-End* › Annual PPh 21 Recap (3 tab berlabel efek) |
| *Automation* › e-Reporting (Dividen: cek, impor, buat case) | *Change in Coretax* › e-Reporting (langkah Check / Import / Create case) |
| *Automation* › Credit Faktur Masukan | *Change in Coretax* › Credit Faktur Masukan (tingkat 2) |
| *Automation* › PPh 25 Kode Billing | *Change in Coretax* › PPh 25 Kode Billing (tingkat 1) |
| *Automation* › e-Bupot Upload & Issue › Upload, Issue & sign | *Change in Coretax* › e-Bupot Upload & Issue (2 tab) |
| e-Bupot Upload & Issue › Konsep SPT | *Change in Coretax* › Konsep SPT (halaman sendiri) |
| API find / amend / cancel Bukti Potong (hanya MCP) | **baru**: *Change in Coretax* › Fix Bukti Potong |
| Chip entitas + palet Ctrl+K, PIC per entitas | baris **For** + palet Ctrl+K (multi-pilih, grup) |
| Add new entity (lokal) | palet › "Add a client on this PC" |
| "Open Coretax" / ikon login manual per entitas | Runs › Coretax windows › Manual session |
| "Sign in to Coretax", ikon refresh status sesi, pil status login | otomatis saat proses mulai; Coretax windows › Sign in now / status per jendela |
| Tab sesi bernomor ("ANDI #2"), New session, popover sesi | Runs › Coretax windows; jendela tercantum di baris proses ("PIC ANDI #2") |
| Popover sesi › centang banyak entitas › bilah antrean | For multi-pilih + Saved groups + Review N runs |
| Pil "N queued" | badge sidebar + filter Queued |
| Tampilan proses (pil Masa Pajak, progres, kontrol) | panel detail proses |
| Tampilan antre + "Cancel queued process" | baris Queued (×) dan panel detail "Cancel queued run" |
| "Start another command" | tidak perlu (formulir tidak pernah diganti tampilan proses) |
| Banner ringkasan selesai | bagian Finished Today + panel detail dengan folder dan file |
| Activity log dock (All sessions / This entity, Clear) | log per proses + strip log; log aplikasi di Settings |
| Rows per page, Back | dihapus (keputusan pemilik) |
| Settings: akun, versi & update, back to v3, system check, export diagnostics, Chrome profiles, parallel sessions, quit | halaman Settings: Theme (baru), Parallel sessions, Account, App version, System check / Chrome profiles / Back to version 3 (disclosure), Quit app |
| Banner versi usang (gate 426), pemberitahuan (`P.notice`) | banner tipis di atas konten; toast |
| Restricted Editor | sama, lihat 4.9 |

---

## 6. Prinsip visual & gerak

**Minimalis**: sedikit kotak (garis 1 px, bukan kartu bersayap bayangan), ruang lega, satu aksen dipakai hemat (tombol
utama, pilihan aktif, progres), skala huruf terbatas, tidak ada dekorasi, opsi lanjutan tertutup, satu tombol utama
per layar. Bayangan hanya untuk lapisan melayang (palet, dialog, panel detail, toast).

### 6.1 Token warna (diperiksa WCAG; semua teks isi dan pil status ≥ 4.5:1)

| Token | Graphite dark | Graphite light | Catatan / kontras |
|---|---|---|---|
| `--bg` | #101114 | #F7F8FA | latar aplikasi |
| `--sidebar` | #0B0C0E | #EEEFF2 | |
| `--surface` / `-2` / `-3` | #17191D / #1C1F24 / #252830 | #FFFFFF / #F2F3F6 / #E6E8ED | permukaan, hover, terpilih |
| `--line` / `--line-2` | #22252B / #30343C | #E4E6EB / #D3D6DD | garis tipis |
| `--text-1` | #F2F3F5 | #15171B | 17.0 / 16.9 pada bg |
| `--text-2` (isi) | #B9BDC7 | #3D424C | 10.0 / 9.5 pada bg; 9.4 / 10.1 pada surface |
| `--text-3` (redup) | #8E939F | #626874 | ≥ 4.8 / ≥ 4.6 pada semua permukaan |
| `--accent` | #8EA2FF | #4A5FD9 | teks di atasnya #0B0C0E 8.2 / #FFFFFF 5.3 |
| `--accent-soft` / `--accent-text` | #1E2440 / #AEBBFF | #ECEFFD / #3346B8 | 8.2 / 6.8 |
| warning (pil, teks) | #F2C063 di #33290F | #7A5200 di #FBF1D8 | 8.5 / 6.2 |
| success | #5FD3A3 di #10291F | #0B6B46 di #E1F4EB | 8.3 / 5.7 |
| danger | #FF9D98 di #3A1618 (solid #FF8F8A) | #A82630 di #FCE9EA (solid #C8323C) | 8.1 / 6.0 |

### 6.2 Skala, bentuk, huruf

| Token | Nilai |
|---|---|
| Spasi | 4 · 8 · 12 · 16 · 24 · 32 · 48 px |
| Radius | 6 (pil kecil) · 8 (tombol, input) · 10 (kotak) · 12 (dialog) · 999 (chip) |
| Bayangan | hanya lapisan melayang: dark `0 18px 48px rgba(0,0,0,.55)`, light `0 18px 48px rgba(20,22,30,.16)` |
| Huruf | 11.5 (label kecil) · 12.5 (sekunder) · 13.5 (isi) · 15 (judul topbar) · 19 (judul halaman) |
| Font | **Geist** + **Geist Mono** (OFL), disarankan **dibundel** sebagai woff2 di `gui/public/assets/fonts` (±150 KB, bekerja offline). Google Fonts juga diizinkan jendela Electron (`FONT_HOSTS` di `electron/main.js`), tetapi bundel menghapus ketergantungan jaringan dan kedipan font. Onest/Bricolage/JetBrains Mono dihapus. |

### 6.3 Gerak

| Token | Nilai | Dipakai untuk |
|---|---|---|
| `--d1` | 120 ms | hover, tekan (scale .97), tooltip |
| `--d2` | 180 ms | dialog/palet (fade + scale .98→1), chip masuk/keluar, label sidebar |
| `--d3` | 240 ms | ganti halaman (fade + geser 6 px), panel detail (geser dari kanan), sidebar, panel buka-tutup, perpindahan baris proses |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | satu kurva untuk semuanya |
| progres | 600 ms, kurva sama | bilah progres (`transform: scaleX`) |

- Hanya `transform` dan `opacity`. Pengecualian yang disengaja: panel buka-tutup memakai `grid-template-rows 0fr→1fr`
  (satu-satunya cara tinggi sesungguhnya beranimasi) hanya untuk panel kecil; isinya sendiri fade + geser.
- Baris proses berpindah antar bagian (queued → running → finished) dengan teknik **FLIP** (ukur posisi lama, render,
  geser balik, lepas); baris baru fade-in, baris dibatalkan fade-out.
- Sidebar: latar diskala (`scaleX`), garis tepi digeser, label fade; konten digeser dengan FLIP sehingga tidak melompat.
- Skeleton (kilau bergeser) menggantikan spinner saat memuat pratinjau, hasil cari, system check.
- `prefers-reduced-motion: reduce` → semua durasi 0, perubahan instan (mockup punya tombol "Reduced motion" untuk
  mencoba).
- **View Transitions API**: tersedia (Electron 45 → Chromium modern, same-document). **Rekomendasi: transisi CSS biasa +
  helper FLIP kecil untuk daftar dan sidebar; View Transitions hanya untuk cross-fade ganti tema.** Alasannya: daftar
  proses dirender ulang tiap 1,5 detik oleh polling; View Transitions mengambil snapshot seluruh halaman dan menahan
  input selama animasi, sehingga bertabrakan dengan pembaruan yang sering dan sulit diinterupsi. Untuk ganti tema
  (sekali-sekali, seluruh layar) justru ideal.

### 6.4 Tema terang dan gelap (keputusan pemilik)

- Pilihan **System / Light / Dark** di Settings › Theme, plus tombol cepat di kaki sidebar (ikon di rel). Disimpan.
- Diterapkan **sebelum paint pertama** oleh skrip kecil sinkron di `<head>` (mis. `/js/theme-boot.js`) yang membaca
  pilihan dan `prefers-color-scheme`, lalu mengisi `data-theme` di `<html>` — tanpa kedipan. Mode System mengikuti
  perubahan Windows secara langsung.
- Pergantian: cross-fade 240 ms lewat View Transitions; instan bila reduced motion.
- Mockup: setiap layar utama ada versi `-dark` dan `-light`.

---

## 7. Rencana implementasi bertahap (setiap fase bisa dirilis sendiri; terkecil dulu)

Tetap **vanilla JS + CSS, tanpa build step**.

| Fase | Isi | File | Server/API | Ukuran |
|---|---|---|---|---|
| **1. Tiga keluhan pemilik** | (a) Dock log menjadi baris layout yang mendorong konten (bukan `position` di atas konten), strip menampilkan baris terakhir proses terpilih (baris log sudah membawa `session`/`pool`/`entity`); (b) rail kanan → bilah aksi lengket satu kalimat, Save to ke Options (`railCard` di `pages.js` → `actionBar`); (c) kontrol: hanya Stop + Pause/Resume selama berjalan, Try again/Skip hanya saat ditahan, Back dan Rows per page dihapus, label umpan balik "Stopping…/Paused", ringkasan setelah Stop | `run.js`, `pages.js`, `styles.css` | membaca `run.controls` dan ringkasan stop dari engineer lain; selain itu tidak ada | **S–M** |
| **2. Token, tema terang/gelap, font, gerak** | Semua warna lewat token; `data-theme`; Settings › Theme + tombol cepat; skrip pra-paint; Geist dibundel; token gerak + reduced motion. **Biaya**: `styles.css` punya ±100 literal warna di luar `:root` (45× `#fff`, rgba bayangan/overlay, warna navy sidebar/log) dan JS punya ±94 atribut `style="…"` inline (paling banyak `pages.js` 40, `entities.js` 19, `run.js` 13), sebagian berisi warna (`var(--ink)`, `var(--green)` dsb. — harus dipetakan ke token baru) dan satu bug `var(--danger, #dc2626)`. Skrip yang disuntikkan ke halaman Coretax (watchdog, lampiran-*: gaya inline sendiri untuk PDF/Lampiran) **tidak berbagi** `styles.css` → di luar cakupan. | `styles.css`, `index.html`, `shell.js`, `core.js`, + rapikan inline style di `pages.js`, `entities.js`, `run.js` | tidak ada (pilihan tema di `localStorage`; opsional `data\ui-settings.json`) | **M** |
| **3. Sidebar baru + topbar satu baris** | grup Download / Change in Coretax / Year-End, label efek, rel yang bisa diciutkan (Ctrl+B, auto <1100 px), topbar 56 px dengan Search + meter jendela | `shell.js`, `pages.js` (NAV), `styles.css` | tidak ada | **S** |
| **4. Run centre** | halaman Runs (bagian, filter, batch rows, panel detail, log per proses, toast keputusan, badge), FLIP helper di `core.js`; tampilan proses lama di halaman fitur dihapus | `run.js` (dipecah: `runs.js`), `shell.js`, `core.js` | **perlu**: simpan proses selesai hari ini (bukan hanya terakhir per jendela) di `runcontrol.runSummaries`; tambah `outputDir`, `files[]`, `kind` (read/write), `controls`, ringkasan stop per proses; opsional `GET /api/run/list` | **M** |
| **5. Klien sebagai "For" + Coretax windows** | baris For di semua formulir, palet multi-pilih; memilih tidak lagi login; tab sesi/chip/tombol login dipindah ke Runs › Coretax windows | `entities.js`, `pages.js`, `shell.js` | tidak ada (aksi sudah menerima `entity`; `/api/sessions/list`, `/sessions/front`, `/sessions/close`, `login-entity` sudah ada) | **M** |
| **6. Batch banyak klien** | Saved groups, dialog Review N runs, kirim N aksi langsung (antrean server), baris batch; hapus loop serial `P.batch.run` | `entities.js`, `pages.js`, `runs.js` | kecil: label `batch` diterima dan dikembalikan di ringkasan proses; simpan grup di `data\client-groups.json` (GET/POST) | **M** |
| **7. Konfirmasi bertingkat + Konsep SPT terpisah** | dialog tingkat 1/2/2+ menggantikan `window.confirm`, pratinjau wajib, label efek | `pages.js`, `core.js` (dialog) | tidak ada (token pratinjau sudah ada) | **M** |
| **8. Fix Bukti Potong** | halaman cari → hasil → Amend (sebelum/sesudah) / Cancel (ketik kode) | `pages.js` | tidak ada (API sudah ada, dipakai MCP) | **M** |
| **9. Polesan gerak** | skeleton, transisi halaman, View Transitions untuk tema, uji reduced motion | `styles.css`, `core.js` | tidak ada | **S** |

Fase 1 bisa dirilis besok tanpa mengubah struktur; fase 2–3 memberi tampilan baru; fase 4–6 menyelesaikan masalah
paralel; 7–8 mengamankan tindakan permanen. Setiap fase perlu `node scripts/test-gui-ui.js` diperbarui (selektor
berubah) — sudah termasuk dalam ukuran.

---

## 8. Pertanyaan terbuka (jawab singkat)

1. **Riwayat proses**: simpan hanya *hari ini* (memori, hilang saat aplikasi ditutup) atau tetap ada setelah restart
   (berkas kecil `runs-history.json`, 7 hari)? → *hari ini / 7 hari*
2. **Saved groups klien**: per PC saja, atau disinkronkan ke Taxio Hub untuk seluruh grup? → *per PC / Taxio Hub*
3. **Batch untuk aksi yang mengubah Coretax** (mis. Kode Billing untuk 12 klien): boleh dengan pratinjau per klien di
   satu dialog, atau hanya Download dulu? → *hanya Download / boleh*
4. **Batalkan**: cukup centang pernyataan, atau tetap wajib mengetik kode klien? → *centang / ketik kode*
5. **Klien dengan 2 PIC**: selalu pakai PIC terakhir dipakai, atau tanya setiap kali? → *ingat / tanya*
6. **Tema bawaan untuk pengguna baru**: System atau Dark? → *System / Dark*

---

## Lampiran: berkas

- `mockup.html` — buka langsung di browser (tanpa jaringan). Bilah "Mockup" di bawah: Editor / Restricted Editor,
  Busy day / First run, **Simulate runs** (proses berjalan, berpindah bagian, ditahan, gagal, mulai dari antrean),
  Step, Reset, Reduced motion. `?theme=light` atau tombol tema di sidebar.
- `mockup-shots\` — semua tampilan, kedua tema, kedua ukuran; `_checks.txt` = pemeriksaan otomatis (scroll
  horizontal, elemen keluar jendela, label terpotong, sidebar terpotong): 0 masalah, 0 error, 0 permintaan eksternal.
- `current\` — UI sekarang; `capture-current.js`, `capture-parallel.js` (keadaan paralel: `70`–`73`),
  `shoot-mockup.js`.

---

## Keputusan pemilik atas pertanyaan terbuka (2026-11-13)

| # | Pertanyaan | Keputusan |
|---|---|---|
| 1 | Riwayat proses | belum dijawab - sementara mengikuti rekomendasi: 7 hari |
| 2 | Saved groups klien | disinkronkan ke Taxio Hub |
| 3 | Batch untuk aksi yang mengubah Coretax | menunggu jawaban (pertanyaan dijelaskan ulang) |
| 4 | Konfirmasi Batalkan | cukup centang (tanpa mengetik kode klien) |
| 5 | Klien dengan 2 PIC | selalu tanya PIC setiap kali |
| 6 | Tema bawaan pengguna baru | Dark |
