# Coretax - Unduh Lampiran SPT (Chrome Extension)

Menambahkan satu tombol di halaman SPT Coretax untuk mengunduh **seluruh lampiran** sebagai PDF -
termasuk lampiran yang tidak pernah disediakan Coretax dalam bentuk PDF (selama ini harus
di-screenshot satu per satu).

Versi ringan dari fitur yang sama di aplikasi Coretax Agent. Bedanya: **tidak ada otomasi login
dan tidak ada impersonate** - Anda login sendiri seperti biasa, extension hanya bekerja setelah
halaman SPT-nya Anda buka.

## Cara pasang

1. Buka `chrome://extensions`
2. Nyalakan **Developer mode** (kanan atas)
3. Klik **Load unpacked**, pilih folder ini (`extension`)

## Cara pakai

1. Login ke Coretax seperti biasa
2. Buka SPT-nya: **SPT Dilaporkan** → ikon 👁 (mata), atau **Konsep SPT** → ikon ✏️ (pensil)
3. Tombol **📄 Unduh Lampiran Lengkap** muncul di pojok kiri bawah - klik
4. File tersimpan di `Downloads/CoretaxLampiran/<Nama WP>/<Tahun>/`

Tombol hanya muncul di halaman formulir SPT. Di halaman daftar SPT, tombol memang tidak ada.

## Yang didukung

| Jenis SPT | Formulir | Status |
|---|---|---|
| PPh Badan | 1771 | ✅ diverifikasi live |
| PPh Orang Pribadi | 1770 | ✅ diverifikasi live |
| PPh Pasal 21/26 | SPT Masa PPh 21/26 | ✅ struktur tab diverifikasi live |
| PPh Unifikasi | SPT Masa PPh Unifikasi | ✅ struktur tab diverifikasi live |
| PPN | SPT Masa PPN | ✅ struktur tab dan paginator diverifikasi live |

Berlaku untuk SPT yang **sudah dilaporkan** maupun yang masih **konsep/draft**.

## Perilaku cetak

- **A3 landscape** - supaya tabel lebar (neraca, daftar 12 bulan, kolom DPP/PPh) tidak terpotong.
  Coretax sendiri mendeklarasikan `@page { size: a3 }`, jadi ukuran ini memang sesuai desain
  formulirnya.
- Pilih **Versi Print** untuk halaman pertama setiap tabel: cepat dan ringkas.
- Pilih **Versi Lengkap** untuk menelusuri seluruh paginator Coretax sampai halaman terakhir.
  Jika 120 baris ditampilkan 10 per halaman, extension mengambil 12 batch lalu menggabungkannya.
- Keduanya menghasilkan PDF per lampiran dan satu PDF `GABUNGAN`, dengan suffix `(Print)` atau
  `(Lengkap)` agar berkas tidak saling menimpa.
- Menu samping dan footer DJP tidak ikut tercetak.

## Catatan penting

Saat proses berjalan, Chrome menampilkan bilah **"... sedang men-debug browser ini"**. Itu wajar:
extension memakai `chrome.debugger` untuk memanggil `Page.printToPDF` - satu-satunya cara sebuah
extension bisa menghasilkan PDF utuh (bukan sekadar screenshot layar). Bilah itu hilang sendiri
begitu proses selesai. Jangan tutup tab selama proses berlangsung.

## Batasan

- Tidak menyalin hasil ke folder compliance seperti aplikasi desktop - extension hanya bisa
  menulis ke dalam folder Downloads.
