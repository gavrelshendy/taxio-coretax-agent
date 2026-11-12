# Taxio Pilot

*Autopilot untuk Coretax.* Sebelumnya bernama "Coretax Agent". Nama file program (`coretax-agent.exe`)
dan repositori belum diubah.

## Lokasi data, port dan token (Tahap 1)

Semua lokasi ditentukan `lib/paths.js`, di bawah satu akar `%LOCALAPPDATA%\TaxioPilot\`:

| Folder / berkas | Isi | Dulu |
|---|---|---|
| `data\` | session.json, local-entities.json, pending-signup.json | `~/.coretax-agent` (disalin sekali, yang lama dibiarkan) |
| `logs\coretax-agent.log` | log (+ `.1`/`.2` rotasi) | di samping exe (tidak dipindah) |
| `profiles\terpasang\`, `profiles\bawaan\` | profil Chrome per PIC | `~/.coretax-agent-profile`, `~/.taxio-pilot-profile` (dipindah; yang gagal dipindah tetap dipakai dari lokasi lama) |
| `chrome\`, `unduhan-sementara\` | Chrome bawaan, transit unduhan otomatis | sama |
| `runtime.json` | `{ port, pid, token, version, startedAt }` instance yang berjalan | - |

Hasil unduhan untuk pengguna tetap di `~/Downloads/CoretaxAgent/...`.

Dashboard lokal memakai port 51733 bila bebas, selain itu port bebas lain. Semua `/api/*` dan `/events`
butuh token acak per peluncuran: `Authorization: Bearer <token>` (alat lokal membaca port + token dari
`runtime.json`; server MCP melakukannya sendiri) atau cookie yang dipasang saat jendela dibuka di
`/?t=<token>`. Pengaturan > Pemeriksaan sistem (`GET /api/health`) dan Ekspor diagnostik
(`POST /api/diagnostics/export`, zip ke Downloads) membantu mendiagnosis PC pengguna.

Uji jalan terisolasi (tanpa jendela/tray/update/unduhan Chrome; tidak pernah menyentuh data asli):
`TAXIO_PILOT_DATA_DIR=<folder sementara> TAXIO_PILOT_SMOKE=1 TAXIO_PILOT_PORT=0 node main.js`.

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

## Run in development

```
npm install
npm run start
```

No build step needed to iterate - edit any file under `lib/`, `gui/`, or `automation/` and
restart `node main.js`. The dashboard itself (`gui/public/*`) can be refreshed in the window
without even restarting the Node process.

## Build the distributable exe

```
npm run build
```

Produces `dist/coretax-agent.exe` via `@yao-pkg/pkg` (same toolchain as coretax-helper - plain
`@vercel/pkg` is known not to work with Playwright's crypto usage on Node 22).

## What's here

- `main.js` - entry point: the Playwright-driver-subprocess guard (must run first, see comment
  in the file), starts the local GUI server, tries to restore a previously-connected session,
  opens the dashboard as an app-mode Chrome window.
- `lib/` - shared primitives: logging (+ SSE-friendly subscriber list), the Supabase project
  registry, file-backed session persistence, Chrome/Playwright login+impersonation helpers
  (ported from coretax-helper's proven logic), entity/PIC listing, and masa (tax period) parsing.
- `gui/` - the local HTTP server (`node:http`, no framework) and dashboard (`public/`: plain
  HTML/CSS/JS, no build step, no framework).
- `automation/ebupot.js` - automation feature #1: e-Bupot (BPPU/BP21/BPA1) PDF downloads. See
  the file's own header comment for the design rationale and an explicit note on which parts
  (DOM selectors for Coretax's filter/pagination controls) are least certain and most likely to
  need adjustment after a first live run - it was written from a spec document, not against a
  live session.

## First live test checklist

The e-Bupot flow's Coretax-side selectors (`setMasaPajakFilter`, `setBpa1RangeFilter`,
`setKodeObjekFilter`, `getDownloadButton`, `extractRowFields`'s header-name matching) are the
one part of this codebase that couldn't be verified against the real site while building it.
Run one small download (a single entity, a single masa, a handful of expected rows) first and
check `coretax-agent.log` (`%LOCALAPPDATA%\TaxioPilot\logs\`) for anything logged as "tidak ditemukan" (not found) - that pinpoints
exactly which selector needs adjusting.

## Tes

Semua tes berjalan tanpa jaringan dan tanpa akun asli (Supabase dan Chrome-Coretax diganti data palsu,
data lokal ke folder sementara):

```
node scripts/test-registration.js       # alur pendaftaran
node scripts/test-local-entities.js     # entitas lokal, kredensial, dan aturan PIC
node scripts/test-local-auth-client.js  # entitas lokal login OTOMATIS lewat jalur yang sama dengan Taxio Hub
node scripts/test-entity-grouping.js    # satu baris per entitas
node scripts/test-gui-logic.js        # parser masa, aturan daftar, status login
node scripts/test-gui-api.js          # API dashboard, jalur login manual, Restricted
node scripts/test-gui-ui.js           # UI di Chrome headless (Playwright); PILOT_SHOTS=<folder> untuk tangkapan layar
node scripts/test-lampiran-export.js  # gerbang regresi jalur lampiran (wajib hijau bila menyentuh lampiran)
```
