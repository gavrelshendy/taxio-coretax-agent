# Taxio Pilot

*Autopilot untuk Coretax.* Sebelumnya bernama "Coretax Agent" (nama paket npm dan repositori belum
diubah). Sejak Tahap 2 aplikasi desktopnya Electron, dipasang per pengguna lewat installer NSIS ke
`%LOCALAPPDATA%\Programs\taxio-pilot\taxio-pilot.exe` (tanpa admin, tanpa tanda tangan kode).

## Lokasi data, port dan token

Semua lokasi ditentukan `lib/paths.js`, di bawah satu akar `%LOCALAPPDATA%\TaxioPilot\`
(`TAXIO_PILOT_DATA_DIR` menggantinya - termasuk userData Electron dan kunci satu-instance):

| Folder / berkas | Isi | Dulu |
|---|---|---|
| `data\` | session.json, local-entities.json, pending-signup.json | `~/.coretax-agent` (disalin sekali, yang lama dibiarkan) |
| `logs\coretax-agent.log` | log (+ `.1`/`.2` rotasi) | di samping exe (tidak dipindah) |
| `profiles\terpasang\`, `profiles\bawaan\` | profil Chrome per PIC | `~/.coretax-agent-profile`, `~/.taxio-pilot-profile` (dipindah; yang gagal dipindah tetap dipakai dari lokasi lama) |
| `chrome\`, `unduhan-sementara\` | Chrome bawaan, transit unduhan otomatis | sama |
| `runtime.json` | `{ port, pid, token, version, startedAt }` instance yang berjalan | - |
| `electron\` | userData Electron: cookie dashboard, cache, kunci satu-instance | - |

Hasil unduhan untuk pengguna tetap di `~/Downloads/CoretaxAgent/...`.

**Rahasia di disk** (`lib/secrets.js`): `data\session.json` (token Supabase) terenkripsi utuh dan kata
sandi / passphrase di `data\local-entities.json` terenkripsi per kolom, lewat Electron `safeStorage`
(DPAPI Windows - hanya akun Windows ini di PC ini yang bisa membukanya). Berkas plaintext versi lama
dibaca lalu ditulis ulang terenkripsi saat start. Berkas yang tidak bisa dibuka (disalin dari PC/akun
lain) disisihkan ke `*.tidak-terbaca`, aplikasi mulai kosong, dan log meminta pengguna masuk / mengisi
ulang. Salinan plaintext lama di `~/.coretax-agent` (sumber migrasi Tahap 1) sengaja dibiarkan untuk
rollback - hapus manual bila tidak diperlukan. Mode tanpa jendela (`node main.js`, tes) tidak punya
enkripsi dan menulis plaintext.

Dashboard lokal memakai port 51733 bila bebas, selain itu port bebas lain. Semua `/api/*` dan `/events`
butuh token acak per peluncuran: `Authorization: Bearer <token>` (alat lokal membaca port + token dari
`runtime.json`; server MCP melakukannya sendiri) atau cookie yang dipasang saat jendela dibuka di
`/?t=<token>`. Pengaturan > Pemeriksaan sistem (`GET /api/health`) dan Ekspor diagnostik
(`POST /api/diagnostics/export`, zip ke Downloads) membantu mendiagnosis PC pengguna. Semua HTTP keluar
aplikasi desktop (Taxio Hub, update, Chrome bawaan) lewat `net.fetch` Electron, jadi proxy/PAC Windows
diikuti.

## Menjalankan

```
npm install
npm start                 # aplikasi desktop (electron .) - data asli, satu instance dengan yang terpasang
npm test                  # semua tes offline (node biasa, tanpa Electron)
```

`npm start` di mode pengembangan tidak mendaftarkan protokol, tidak memeriksa update, dan tidak menjalankan
serah-terima. Uji terisolasi (tidak pernah menyentuh data, registry atau pintasan PC ini):

```
# PowerShell. Jendela + tray tetap muncul; protokol/update/serah-terima mati.
$env:TAXIO_PILOT_DATA_DIR="$env:TEMP\tp-uji"; $env:TAXIO_PILOT_PORT='52555'; npm start
#   + TAXIO_PILOT_DEBUG_WINDOW=1      log did-finish-load + judul, tangkapan jendela ke <akar>\jendela-dashboard.png
#   + TAXIO_PILOT_SELFTEST_BROWSER=1  Playwright meluncurkan Chrome otomasi di about:blank -> baris "UJI-DIRI browser" di log
#   + TAXIO_PILOT_CHROME_DIR=<cache Chrome bawaan>  supaya tidak mengunduh ±185 MB ke folder sementara
# Tanpa jendela sama sekali, di node biasa:
$env:TAXIO_PILOT_DATA_DIR="$env:TEMP\tp-smoke"; $env:TAXIO_PILOT_SMOKE='1'; $env:TAXIO_PILOT_PORT='0'; node main.js
```

Hentikan instance uji dengan `POST /api/quit` (Bearer token dari `runtime.json` di folder ujinya). Jangan
pernah memakai port 51733 untuk uji. Catatan: lingkungan yang mengisi `ELECTRON_RUN_AS_NODE=1` (mis.
terminal di dalam aplikasi Electron lain) membuat `electron.exe` berjalan sebagai node - hapus dulu.

## Build

```
npm run build             # electron-builder -> dist-electron\ (tidak pernah menulis ke dist\, dist-fix\, dist-next\)
```

Hasil: `dist-electron\taxio-pilot-setup-<versi>.exe` (installer NSIS oneClick per pengguna),
`taxio-pilot-setup-<versi>.exe.blockmap`, `latest.yml`, dan `win-unpacked\` (aplikasi tanpa installer,
untuk uji terisolasi). Paket berisi hanya `package.json`, `electron/`, `lib/`, `gui/`, `automation/`,
`config/` + dependensi produksi (daftar `build.files` di package.json; `*.xlsx` dikecualikan kecuali
`gui/public/assets/template-pajak-masukan.xlsx`, jadi spreadsheet klien di root repo tidak pernah ikut).
`playwright` dan `playwright-core` di-unpack dari asar (`app.asar.unpacked`). Tanpa tanda tangan kode:
Windows SmartScreen bisa memperingatkan installer yang diunduh lewat browser.

## Rilis dan update otomatis

Update otomatis = `electron-updater` terhadap GitHub Releases repo publik `gavrelshendy/taxio-coretax-agent`
(cek 4 detik setelah start lalu tiap 15 menit; tidak pernah memasang saat ada otomasi berjalan; unduhan
gagal dicoba lagi 1 -> 2 -> 5 menit lalu 15; selama versi lebih baru terkonfirmasi, aksi baru ditolak
HTTP 426; begitu menganggur aplikasi keluar lewat jalur "Keluar" biasa - menutup jendela Chrome otomasi -
lalu installer dijalankan diam-diam dan aplikasi terbuka lagi). Lihat `lib/updater.js`.

Prosedur rilis:

1. Naikkan `version` di package.json di atas rilis terbaru yang sudah terbit (tag `v<versi>`) DAN di atas
   versi exe pkg mana pun yang masih dipakai (termasuk build lokal) - updater hanya pindah ke versi yang
   lebih tinggi.
2. `npm test`, lalu `npm run build`.
3. Buat rilis GitHub bertag `v<versi>` (rilis biasa, bukan draft/prerelease, ditandai "latest") dengan
   TEPAT tiga aset dari `dist-electron\`, namanya tidak diubah:
   `taxio-pilot-setup-<versi>.exe`, `taxio-pilot-setup-<versi>.exe.blockmap`, `latest.yml`.
   Installer harus satu-satunya aset `.exe` (updater exe lama mengambil `.exe` pertama). Server MCP
   (`mcp/taxio-pilot-mcp.js`) tetap boleh dilampirkan sebagai aset terpisah seperti biasa.
   Contoh: `gh release create v3.1.0 dist-electron/taxio-pilot-setup-3.1.0.exe dist-electron/taxio-pilot-setup-3.1.0.exe.blockmap dist-electron/latest.yml`
4. Rilis cermin Chrome (`chrome-<versi>`) tidak boleh menjadi "latest".

**Peralihan dari exe pkg lama (`coretax-agent.exe` 3.0.x).** Updater lama mengunduh aset `.exe` pertama
rilis terbaru (kini installer; diverifikasi SHA-256 dari GitHub), menjalankannya sebagai
`<installer> --finish-update <pid> <exe lama>` lalu menutup dirinya. Installer NSIS mengabaikan argumen
itu (electron-builder hanya mengenali `--updated`, `--force-run`, `/S`, `/D=` dsb.), memasang aplikasi,
membuat pintasan "Taxio Pilot" di Desktop dan Start Menu, lalu menjalankannya. Pada start pertama
aplikasi baru (`lib/legacy-handover.js`): bila protokol `taxio-coretax` di HKCU masih menunjuk ke
`coretax-agent*.exe` di luar folder instalasi, pintasan `.lnk` Desktop/Start Menu yang menunjuk exe lama
itu diarahkan ke exe baru; exe lama TIDAK dihapus. Sesudah itu protokol didaftarkan ke aplikasi baru.
Data lama sudah disalin oleh migrasi Tahap 1 (`lib/paths.js`).

Aplikasi desktop mandiri untuk otomasi Coretax. Terpisah dari, dan tidak menyentuh, `Taxio/coretax-helper`
(`TaxioCoretaxHelper.exe`), yang tetap bekerja seperti biasa lewat deep link `taxio-coretax://` dari web
app. Aplikasi ini dibuka langsung: masuk dengan akun Taxio Hub (atau mendaftar dari dalam aplikasi),
lalu jalankan Coretax lewat dashboard lokal.

## Alur akun

Aplikasi tidak bisa dipakai tanpa akun Taxio Hub yang sudah aktif di sebuah grup. Pendaftaran meniru web
Taxio Hub (lib/registration.js): Inisial (maks. 8 huruf) + email + kata sandi, konfirmasi email, lalu
antrean onboarding (`request_membership` -> `membership_requests`, Fase 42) sampai super-admin menempatkan
akun ke grup. Selama menunggu, sesi tetap tersimpan tapi akun belum dianggap terhubung
(lib/connection.js); tombol "Periksa status" tidak meminta kata sandi lagi.

## Entitas dan login

- **Otomatis (Taxio Hub)**: entitas dari Taxio Hub. Entitas dengan 2 PIC tampil satu baris dan PIC
  dipilih di dalam baris; entitas tanpa PIC tertaut tidak masuk daftar awal, tapi muncul saat dicari
  dengan keterangan.
- **Otomatis (lokal, tab Saya)**: klien yang belum ada di Taxio Hub bisa ditambahkan sendiri di komputer
  ini, dengan kredensial Coretax ASLI tersimpan lokal (lib/local-entities.js,
  `%LOCALAPPDATA%\TaxioPilot\data\local-entities.json` - plaintext dengan izin berkas 0600, sama seperti token sesi
  session-store.js). Orang Pribadi login dengan NPWP+kata sandi miliknya sendiri; Badan wajib menautkan
  >= 1 PIC (masing-masing dengan kredensial sendiri), karena Coretax membuka akun badan lewat akun
  PIC-nya (impersonate) - boleh lebih dari satu PIC. Login berjalan OTOMATIS lewat jalur yang identik
  dengan PIC Taxio Hub (lib/local-auth-client.js menyamar sebagai klien Supabase di depan
  lib/entities.js), jadi semua fitur (termasuk Dividen dan Kreditkan Faktur Masukan) berjalan tanpa
  campur tangan manual. Tidak menulis apa pun ke Taxio Hub. Restricted Editor tidak boleh memakainya.
- **Manual (sesi Coretax polos)**: tombol "Buka Coretax" tetap ada terpisah dari entitas lokal di atas -
  jendela Chrome dibuka dan pengguna login sendiri tanpa kredensial tersimpan apa pun. Semua fitur bisa
  dijalankan di sesi ini juga. Restricted Editor tidak boleh memakainya.
- **Pintasan**: Ctrl+K atau Alt+K membuka pencarian entitas dari mana saja; memilih entitas (dan PIC-nya
  bila lebih dari satu) langsung memicu login otomatis, tanpa langkah tambahan klik "Masuk Coretax".

## What's here

- `electron/main.js` - the desktop app (Electron main process): single instance (+ forwarding
  `taxio-coretax://` URLs from second launches to `lib/deeplink.js`), BrowserWindow showing the local
  dashboard (contextIsolation + sandbox, own session partition, only its own origin; closing hides to
  the tray), tray menu (Buka Dashboard / Keluar), protocol registration, legacy hand-over, electron-updater
  engine, Electron `net.fetch` for all outbound HTTP, and the real implementation of the platform seam.
  Header comment lists the env switches.
- `main.js` - the same core without any window, under plain `node` (smoke runs, tests, development).
- `lib/app.js` - core startup order shared by both: data migration -> session restore (+ encrypting
  legacy plaintext secrets) -> dashboard server + `runtime.json` -> background health check.
- `lib/shell.js` - the platform seam: show/close dashboard, pick file/folder, native error box, bring the
  automation Chrome to the front, encrypt/decrypt secrets, isPackaged/exePath, exit. Headless defaults
  (no-ops / plaintext) unless `electron/main.js` registers the Electron implementation. The core never
  `require('electron')`s.
- `lib/updater.js` - update policy (schedule, retries, 426 gate, never during a run) over an injected
  electron-updater engine; `lib/legacy-handover.js` - pkg exe -> installed app hand-over planner;
  `lib/secrets.js` - secrets at rest.
- `lib/` (rest) - logging (+ SSE subscribers), paths/runtime/net, the Supabase project registry, session
  persistence, Chrome/Playwright login+impersonation helpers (ported from coretax-helper's proven logic),
  bundled Chrome for Testing (`lib/browser.js`), entity/PIC listing, masa (tax period) parsing, lampiran
  rendering, system checks (`lib/doctor.js`) and diagnostics export.
- `gui/` - the local HTTP server (`node:http`, no framework; route table in `gui/server.js`, access policy
  in `gui/guards.js`) and dashboard (`public/`: plain HTML/CSS/JS, no build step). The MCP server uses the
  same API.
- `automation/` - the Coretax automations (e-Bupot, SPT, e-Faktur, Dividen, Pajak Masukan, billing, ...).
  `page.evaluate` calls there are string literals (needed by the old pkg bytecode build; kept as is).
- `mcp/taxio-pilot-mcp.js` - standalone MCP server (one file, plain node), shipped as a separate release
  asset; finds the running app through `runtime.json`.

## First live test checklist

The e-Bupot flow's Coretax-side selectors (`setMasaPajakFilter`, `setBpa1RangeFilter`,
`setKodeObjekFilter`, `getDownloadButton`, `extractRowFields`'s header-name matching) are the
one part of this codebase that couldn't be verified against the real site while building it.
Run one small download (a single entity, a single masa, a handful of expected rows) first and
check `coretax-agent.log` (`%LOCALAPPDATA%\TaxioPilot\logs\`) for anything logged as "tidak ditemukan" (not found) - that pinpoints
exactly which selector needs adjusting.

## Tes

Semua tes berjalan tanpa jaringan dan tanpa akun asli (Supabase dan Chrome-Coretax diganti data palsu,
data lokal ke folder sementara), di node biasa (`npm test` = `scripts/run-tests.js`, menemukan semua
`scripts/test-*.js`). Beberapa contoh:

```
node scripts/test-shell.js              # seam platform: default headless, dialog, server lewat seam
node scripts/test-secrets.js            # enkripsi session.json / local-entities.json, berkas tak terbaca
node scripts/test-legacy-handover.js    # serah-terima dari exe pkg lama (registry/pintasan tiruan)
node scripts/test-updater.js            # kebijakan update dengan mesin electron-updater tiruan
node scripts/test-registration.js       # alur pendaftaran
node scripts/test-local-entities.js     # entitas lokal, kredensial, dan aturan PIC
node scripts/test-local-auth-client.js  # entitas lokal login OTOMATIS lewat jalur yang sama dengan Taxio Hub
node scripts/test-entity-grouping.js    # satu baris per entitas
node scripts/test-gui-logic.js        # parser masa, aturan daftar, status login
node scripts/test-gui-api.js          # API dashboard, jalur login manual, Restricted
node scripts/test-gui-ui.js           # UI di Chrome headless (Playwright); PILOT_SHOTS=<folder> untuk tangkapan layar
node scripts/test-lampiran-export.js  # gerbang regresi jalur lampiran (wajib hijau bila menyentuh lampiran)
```
