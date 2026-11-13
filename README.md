# Taxio Pilot

*Autopilot untuk Coretax.* Sebelumnya bernama "Coretax Agent" (nama paket npm dan repositori belum
diubah). Sejak Tahap 2 aplikasi desktopnya Electron, dipasang per pengguna lewat installer NSIS ke
`%LOCALAPPDATA%\Programs\taxio-pilot\taxio-pilot.exe` (tanpa admin, tanpa tanda tangan kode).

## Lokasi data, port dan token

Semua lokasi ditentukan `lib/paths.js`, di bawah satu akar `%LOCALAPPDATA%\TaxioPilot\`
(`TAXIO_PILOT_DATA_DIR` menggantinya - termasuk userData Electron dan kunci satu-instance):

| Folder / berkas | Isi | Dulu |
|---|---|---|
| `data\` | session.json, local-entities.json, pending-signup.json | `~/.coretax-agent` (disalin sekali, yang lama dibiarkan; session.json tidak disalin: masuk Taxio Hub sekali di v4, sesi v3 tetap utuh) |
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

Uji updater tanpa memasang (hanya build terpaket `dist-electron\win-unpacked\taxio-pilot.exe`):

```
# feed lokal (latest.yml + installer) di http://127.0.0.1:<p>/feed/ ; updater cek + unduh + verifikasi sha512,
# mencatat "UJI-UPDATE: ..." dan TIDAK keluar / memasang. Cache unduhan di <akar uji>\update-cache.
$env:TAXIO_PILOT_DATA_DIR="$env:TEMP\tp-upd"; $env:TAXIO_PILOT_PORT='52577'
$env:TAXIO_PILOT_UPDATE_FEED='http://127.0.0.1:52611/feed/'; $env:TAXIO_PILOT_UPDATE_VERIFY_ONLY='1'
.\dist-electron\win-unpacked\taxio-pilot.exe
```

`TAXIO_PILOT_UPDATE_FEED` hanya dihormati bersama `TAXIO_PILOT_DATA_DIR`, dan mode terisolasi SELALU
verifikasi-saja. `TAXIO_PILOT_UPDATE_VERIFY_ONLY=1` juga berlaku untuk aplikasi terpasang (tidak pernah
memasang).

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

**Jangan build dari worktree yang `node_modules`-nya junction** ke checkout lain: pengumpul dependensi
electron-builder 26.18 lalu melaporkan `cannot find path for dependency` dan paket JADI tanpa sebagian
besar dependensi transitif (terukur 2026-11-12: 15 modul di `app.asar` alih-alih 124 - tanpa
`playwright-core`, `builder-util-runtime`, `@supabase/auth-js`, `pg-pool`, ...; aplikasi gagal saat
memuat modul itu). Build dari folder dengan `node_modules` sungguhan. Periksa sesudah build:
`node -e "console.log(require('@electron/asar').listPackage('dist-electron/win-unpacked/resources/app.asar').filter(f=>/node_modules[\\\/]builder-util-runtime[\\\/]package.json/.test(f)))"`
harus mencetak satu path.

## Rilis dan update otomatis

Arsitektur Electron = **versi 4** (mulai 4.0.0). Pengguna lama memakai exe pkg `coretax-agent.exe`
3.0.x (terakhir v3.0.50) yang updater-nya sendiri memeriksa `/releases/latest` repo publik
`gavrelshendy/taxio-coretax-agent`, mengambil aset `.exe` pertama rilis itu, menjalankannya, dan selama
versi lebih baru diketahui menolak semua aksi (HTTP 426). Jadi **rilis yang bertanda "latest" dipasang
paksa ke semua pengguna versi 3.** Karena itu versi 4 memakai kanal update SENDIRI:

- `electron-updater` dengan provider **generic** ke
  `https://github.com/gavrelshendy/taxio-coretax-agent/releases/download/pilot-v4/`
  (`build.publish` di package.json = `lib/updater.js` `FEED_URL`), yaitu aset SATU rilis bertag tetap
  `pilot-v4` - **pre-release, tidak pernah "latest"** - berisi `latest.yml`,
  `taxio-pilot-setup-<versi>.exe` dan `.blockmap`, yang diganti setiap rilis versi 4.
- Akibatnya: exe 3.0.x tidak pernah melihat versi 4 kecuali pemilik SENGAJA menerbitkan installer versi 4
  dalam rilis bertanda latest (= saklar "migrasikan semua"); menandai v3.0.50 sebagai latest lagi = saklar
  "berhenti memigrasikan"; rilis pemeliharaan 3.0.x (tanpa `latest.yml`) tidak lagi merusak cek update
  versi 4.
- Fakta provider generic (electron-updater 6.8.11, dibaca dari sumbernya): `latest.yml` diambil dari
  `new URL('latest.yml', FEED_URL)` dengan `?noCache=<waktu>` (tanpa header Authorization); installer dari
  `new URL(<path di latest.yml>, FEED_URL)` tanpa cache-buster (namanya memuat versi); redirect diikuti
  sendiri (maks. 10). GitHub menjawab `releases/download/<tag>/<nama>` dengan **302 `Cache-Control:
  no-cache`** ke `release-assets.githubusercontent.com/...<id aset>?...` (ditandatangani, berlaku ±1 jam,
  cache CDN per id aset) - mengganti aset = id baru, jadi tidak ada `latest.yml` basi dari CDN. sha512 dari
  `latest.yml` diverifikasi; unduhan diferensial dimatikan (blockmap versi lama tidak ada lagi di kanal).

Perilaku (lihat `lib/updater.js`, `lib/update-guard.js`): cek 4 detik setelah start lalu tiap 15 menit;
tidak pernah memasang saat ada otomasi berjalan; unduhan dicatat tiap 20% di log dashboard; unduhan gagal
dicoba lagi 1 -> 2 -> 5 menit lalu 15. Selama versi lebih baru terkonfirmasi aksi baru ditolak HTTP 426,
KECUALI: cek yang gagal (offline, 404) tidak pernah menggerbang; bila tangga 1/2/5 menit habis tanpa
unduhan berhasil, gerbang dibuka (`reason: 'download-failed'`, satu pemberitahuan) sampai unduhan
berikutnya berhasil; dan bila installer gagal dipasang 2x untuk versi yang sama (antivirus/SmartScreen -
tercatat di `<akar>\update-install.json` sebelum keluar untuk memasang, diperiksa saat start), versi itu
tidak dipasang otomatis lagi dan tidak menggerbang (`reason: 'install-failed'`); pemberitahuan di aplikasi
memberi tautan unduhan langsung; "Check for updates" manual tetap mencoba (sekali per klik). Begitu
menganggur aplikasi keluar lewat jalur "Keluar" biasa - menutup jendela Chrome otomasi - lalu installer
dijalankan diam-diam dan aplikasi terbuka lagi.

### Prosedur rilis versi 4 (perintah `gh` - dokumentasi, dijalankan pemilik)

1. Naikkan `version` di package.json (dan root package-lock.json) di atas versi 4 yang sudah terbit.
2. `npm test`, lalu `npm run build` dari folder dengan `node_modules` SUNGGUHAN (bukan junction - lihat
   "Build").
3. Kanal `pilot-v4` (sekali saja, bila belum ada):
   `gh release create pilot-v4 --prerelease --latest=false --title "Taxio Pilot v4 (kanal update)" --notes "Kanal update otomatis Taxio Pilot versi 4. Bukan rilis 'latest'."`
4. Unggah installer + blockmap DULU, `latest.yml` TERAKHIR (supaya klien tidak pernah membaca `latest.yml`
   yang menunjuk installer yang belum ada):
   `gh release upload pilot-v4 dist-electron/taxio-pilot-setup-<versi>.exe dist-electron/taxio-pilot-setup-<versi>.exe.blockmap --clobber`
   `gh release upload pilot-v4 dist-electron/latest.yml --clobber`
   lalu pastikan tetap pre-release dan bukan latest: `gh release edit pilot-v4 --prerelease --latest=false`.
   Installer versi lama di kanal boleh dihapus sesudahnya:
   `gh release delete-asset pilot-v4 taxio-pilot-setup-<versi-lama>.exe -y` (dan `.blockmap`-nya).
5. Rilis cermin Chrome (`chrome-<versi>`) dan rilis apa pun selain `v3.0.x` tidak boleh menjadi "latest".

**Migrasikan semua pengguna versi 3 (saklar, disengaja).** Buat rilis biasa bertanda latest yang aset
`.exe`-nya HANYA installer versi 4 (updater 3.0.x mengambil `.exe` pertama dan membandingkan tag dengan
versinya):
`gh release create v4.0.0 dist-electron/taxio-pilot-setup-4.0.0.exe --latest --title "Taxio Pilot 4.0.0" --notes "..."`
(server MCP boleh ikut sebagai aset `.js`). Updater lama mengunduhnya (diverifikasi SHA-256 dari GitHub),
menjalankannya sebagai `<installer> --finish-update <pid> <exe lama>` lalu menutup dirinya. Installer NSIS
mengabaikan argumen itu (electron-builder hanya mengenali `--updated`, `--force-run`, `/S`, `/D=` dsb.),
memasang aplikasi, membuat pintasan "Taxio Pilot" di Desktop dan Start Menu, lalu menjalankannya. Pada
start pertama aplikasi baru (`lib/legacy-handover.js`): bila protokol `taxio-coretax` di HKCU masih
menunjuk ke `coretax-agent*.exe` di luar folder instalasi, pintasan `.lnk` Desktop/Start Menu yang
menunjuk exe lama itu diarahkan ke exe baru dan path exe lama dicatat (`<akar>\legacy-v3.json`); exe lama
TIDAK dihapus atau diubah. Sesudah itu protokol didaftarkan ke aplikasi baru. Data lama sudah disalin oleh
migrasi Tahap 1 (`lib/paths.js`).

**Berhenti memigrasikan.** `gh release edit v3.0.50 --latest` (atau rilis 3.0.x yang lebih baru). Pengguna
yang sudah pindah tetap di versi 4 (kanalnya `pilot-v4`); yang belum, tetap di versi 3. Selama rilis
versi 4 bertanda latest, pengguna yang kembali ke versi 3 akan langsung diperbarui lagi ke versi 4 oleh
updater lama - "Kembali ke versi 3" hanya bertahan bila latest = 3.0.x.

**Rilis pemeliharaan 3.0.x** (pengembang lain) tetap seperti biasa: rilis `v3.0.<n>` bertanda latest dengan
`coretax-agent.exe`. Tidak memengaruhi pengguna versi 4.

## Kembali ke versi 3

Tidak ada downgrade otomatis. Pengguna bisa kembali ke v3.0.50 kapan saja (Settings -> "Back to version 3"
menampilkan langkah yang sama dan path exe lama bila tercatat saat serah-terima):

1. **Tutup Taxio Pilot versi 4** (Settings -> Quit app, atau "Keluar" di ikon tray). Jangan jalankan dua
   versi bersamaan.
2. Buka `coretax-agent.exe` lama (versi 4 tidak pernah menghapus/mengubahnya; installer NSIS hanya menulis
   ke `%LOCALAPPDATA%\Programs\taxio-pilot` dan pintasannya), atau unduh lagi dari
   https://github.com/gavrelshendy/taxio-coretax-agent/releases/tag/v3.0.50.

Yang terjadi:
- **Data**: berkas di `~/.coretax-agent` DISALIN (bukan dipindah) ke `%LOCALAPPDATA%\TaxioPilot\data`, jadi
  versi 3 masih menemukan datanya - dalam keadaan saat migrasi (perubahan entitas lokal di versi 4 tidak
  ikut). Token sesi Taxio Hub di salinan lama kemungkinan sudah kedaluwarsa/terpakai: masuk lagi bila diminta.
- **Profil Chrome** per PIC DIPINDAH ke `%LOCALAPPDATA%\TaxioPilot\profiles`, jadi di versi 3 setiap PIC
  login Coretax sekali lagi (profil baru di `~/.coretax-agent-profile`). Saat kembali ke versi 4, profil
  versi 4 yang dipakai (yang dibuat versi 3 dibiarkan).
- **Protokol `taxio-coretax://`** dimiliki aplikasi yang terakhir DIMULAI (keduanya mendaftarkan diri saat
  start). Pintasan Desktop/Start Menu tetap menunjuk versi 4; membuka Taxio Pilot dari pintasan = kembali
  ke versi 4 (serah-terima berjalan lagi dan mengambil alih protokol).
- **Versi 3 dibuka saat versi 4 berjalan** (`gui/guards.js` `legacyProbeKind`). Exe 3.0.50 memeriksa
  "sudah berjalan?" dengan `GET http://127.0.0.1:51733/api/session` tanpa token. Sebelum 4.0.0 versi 4
  menjawab 401, sehingga versi 3 menganggap tidak ada yang berjalan: memulihkan sesi dari salinan lama
  (token refresh usang), gagal bind port 51733, lalu menampilkan popup "Taxio Pilot gagal membuka dashboard
  lokal (port 51733 mungkin dipakai aplikasi lain)" dan keluar. Kini versi 4 menjawab probe yang PERSIS
  berbentuk probe versi 3 (tanpa Authorization/Cookie/Origin/User-Agent/header probe versi 4) dengan 200
  tanpa data; versi 3 lalu mengirim `POST /api/tray/open`, versi 4 membawa jendelanya ke depan dan
  menampilkan pemberitahuan cara kembali ke versi 3, dan versi 3 keluar diam-diam (`exit 0`). Deep link
  dari versi 3 (`POST /api/deeplink`) dijawab 409 dan TIDAK dijalankan. Semua route lain tetap wajib token.
  Batas: hanya bila versi 4 memegang port 51733.
- **Versi 3 sudah berjalan saat versi 4 dibuka**: versi 4 terpaksa memakai port lain, lalu memeriksa
  51733 (GET tanpa token) dan menampilkan peringatan "versi 3 masih berjalan - tutup lewat menu Keluar di
  ikon tray-nya".

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
node scripts/test-session-restore.js  # sesi Taxio Hub dipulihkan di latar ("Memulihkan sesi…", offline = coba lagi)
node scripts/test-hub-session.js      # token Taxio Hub selalu segar, batas waktu 30 dtk, sesi hilang = pesan jelas
node scripts/test-run-wrappers.js     # batas waktu / Stop: sesi tetap sibuk sampai langkah Coretax benar-benar selesai
node scripts/test-run-controls.js     # Stop / Jeda di titik aman setiap fitur (Coretax tiruan) + kontrol per fitur (lib/run-controls.js)
node scripts/test-chrome-front.js     # jendela Chrome otomasi ke depan lewat pid; cache status jendela; kabar /events
node scripts/test-profile-housekeeping.js # pemilihan & penghapusan profil Chrome PIC yang lama
```

## Sesi paralel (beberapa jendela per PIC)

Setiap perintah otomasi bisa berjalan bersamaan (`lib/runcontrol.js`). Satu PIC boleh punya beberapa jendela Chrome
(Coretax mengizinkan akun yang sama login dari beberapa browser): jendela pertama tetap memakai kunci dan folder
profil lama (`<pic>`), berikutnya `<pic>~2`, `<pic>~3` (folder profil sendiri, dikenali perawatan profil). Proses baru
memakai jendela bebas yang sudah mengimpersonate entitasnya, lalu jendela bebas lain, lalu jendela baru - sampai batas
Pengaturan > "Parallel sessions" (`data\parallel-sessions.json`: bawaan 3 jendela per PIC, 6 jendela berjalan
bersamaan; jendela yang diam tidak dihitung; sesi manual tetap satu jendela). Yang tidak mendapat jendela ANTRE (202
`queued: true, position`, kunci `run:<id>`; Stop membatalkannya), bukan 409. Route yang menjawab langsung (cari /
pratinjau / cek NIK) menunggu antrean maks. 30 detik lalu 409 dengan pesan lama. Keamanan keluaran (`gui/server.js`
`withRules`): perintah IDENTIK yang masih antre/berjalan ditolak 409, fitur yang sama untuk entitas yang sama antre di
belakangnya, fitur lain paralel; penulis Excel bersama dikunci per berkas (`lib/file-lock.js`). Deep link memakai
antrean yang sama. Tes: `node scripts/test-parallel-runs.js`, `node scripts/test-runcontrol-sessions.js`.

## Halaman Runs: kontrak API (server)

Riwayat proses sesi aplikasi ini disimpan di memori (`lib/runcontrol.js`, maks. 300 proses selesai, yang tertua dibuang
dulu; proses antre/berjalan tidak pernah dibuang; hilang saat aplikasi ditutup). Semua route lewat token/Host/Origin biasa.

- `GET /api/runs` -> `{ needsYou: [], inProgress: [], done: [], limits: { perPic, total, running } }`. `needsYou` = ditahan
  menunggu keputusan; `inProgress` = berjalan/dijeda/berhenti dulu, lalu yang antre (urut posisi); `done` = selesai, gagal,
  dihentikan HARI INI, terbaru dulu.
- `GET /api/runs/<key>` (atau `/api/runs/detail?key=`) -> satu proses + `lines` (baris log terakhir, `&lines=N`); 404 bila tidak ada.
  `GET /api/run/log?session=run:<id>` dan semua route lama (`/api/run/status`, kontrol, `?session=`) tidak berubah.
- `POST /api/runs/open-folder` `{ key }` -> membuka `outputDir` yang DICATAT server untuk proses itu di Explorer
  (`lib/shell.js` `openPath`; Electron: `shell.openPath`). Path dari body tidak pernah dipakai; kunci tak dikenal / belum ada
  folder -> 404. `POST /api/runs/clear-done` -> `{ ok, cleared }` membuang proses selesai dari riwayat.
- **Batch ("unduh untuk banyak klien")**: setiap aksi latar (route yang memakai `runInBackground`) menerima `batch` opsional di body:
  `{ id, label, index, total }` - `id` dibuat klien (1-64 karakter `[A-Za-z0-9_-]`), `label` teks maks. 120 karakter, `index` 0..total-1,
  `total` 1..10000. Dashboard mengirim satu permintaan aksi biasa per klien dengan `id` yang sama; antrean / batas paralel tidak berubah
  dan aturan perintah identik (`withRules`) tetap berlaku per klien (409 untuk klien yang sama + parameter yang sama). `batch` yang tidak
  valid -> 400. Batch HANYA untuk fitur hanya-baca: bila `changesCoretax` fitur itu true (termasuk kasus bersyarat: BPMP `submit`,
  Konsep SPT `post`) -> 400 "Batch hanya boleh untuk unduhan yang hanya membaca ..." dan tidak ada proses dibuat. Setiap proses di
  `GET /api/runs` dan `GET /api/runs/<key>` membawa `batch` (objek di atas) atau `null`.
- `GET /api/runs` juga mengembalikan `batches: [{ id, label, feature, total, counts: { queued, running, hold, done, failed, stopped },
  startedAt, endedAt }]`, dihitung dari proses yang membawa id itu. `running` = berjalan + dijeda + berhenti dulu; `total` = nilai
  terbesar yang dilaporkan proses-prosesnya; `startedAt` = waktu antre paling awal; `endedAt` = null selagi masih ada yang antre /
  berjalan / ditahan, selain itu waktu selesai terakhir. Sebuah batch tetap terdaftar selama salah satu prosesnya ada di riwayat hari ini.
- `POST /api/runs/stop-batch` `{ id }` -> `{ ok, stopped }`: Stop untuk setiap proses batch itu yang masih aktif (berhenti di titik aman)
  atau antre (dibatalkan); proses yang sudah selesai tidak dihitung (`stopped: 0` bila semuanya sudah selesai). Id tidak valid -> 400;
  id yang tidak punya proses sama sekali -> 404. Tes: `node scripts/test-runs-batch.js`.
- Kabar SSE di `/events`: `data: {"event":"runs"}` setiap daftar berubah (mulai, antre maju, ditahan, lanjut, langkah
  kemajuan, selesai), maks. 4 per detik; klien lalu memuat ulang `GET /api/runs`. (`"run"` lama tetap dikirim.)

Satu proses: `key` (selalu `run:<id>`), `id`, `state`, `section`, `feature`, `label`, `entity {id,name,npwp,tag}`, `pic`
(kunci PIC), `window`/`windowNo`, `queue` (hanya saat antre: `position` = urutan antre keseluruhan, `poolPosition`,
`reason` `lock|busy|total`, `reasonText`, `waitingFor {key,label}`), `queuedAt`, `startedAt`, `endedAt`,
`progress {total, done, hold, current {index,label,short}, items [{label,short,state: wait|run|ok|skip|hold}]}` atau null,
`hold {reason, item, choices [{id: retry|skip|stop, label, action}]}` (hanya saat `hold`; Skip hanya bila fitur mendukung),
`controls` (stop/pause/skip/retry/back/pageSize), `stopRequested`, `pauseRequested`, `changesCoretax` (boolean per fitur,
`lib/run-controls.js`), `outcome {kind, text, custom}` (hanya selesai: baris "SELESAI:/GAGAL:/Dihentikan:" yang dicatat dari
log; `custom:false` = teks bawaan karena fitur tidak mencatat baris penutup), `outputDir` atau null.

`state`: `queued` | `running` | `paused` | `hold` | `stopping` | `done` | `failed` | `stopped`. `choices[].action` = nilai untuk
route kontrol lama (`/api/run/retry|skip|stop|resume?session=run:<id>`); fitur tanpa Ulang memakai `resume`.
`outputDir` dicatat lewat `runcontrol.setOutput(dir)` di tempat setiap fitur menentukan folder hasilnya (SPT/A1, e-Bupot, Bukti Potong
Saya, Kode Billing, e-Faktur, Pajak Masukan unduh/kredit, Dividen, Konsep SPT, laporan e-Bupot upload/issue, pembetulan e-Bupot,
pembetulan NIK BPMP + penyisiran, rekam API, refresh rekap). Tidak tercakup karena tidak menulis berkas (outputDir = null): login, cari / pratinjau / cek NIK, Create Konsep, Create Dividen case, Upload e-Bupot tanpa laporan. Tes: `node scripts/test-runs-api.js`.
