# QRIS Dinamis Telegram

Fondasi aplikasi QRIS dinamis untuk alur deposit yang diverifikasi manual melalui Telegram.

## Fitur tahap dasar

- Membaca QRIS statis dari gambar
- Menerima payload QRIS melalui teks
- Validasi CRC16
- Menambahkan nominal pembayaran
- Membuat dan mengunduh QRIS dinamis
- Berjalan sepenuhnya di browser

## Menjalankan secara lokal

```bash
npm install
npm run dev
```

## Deploy ke Vercel

Import repository ini di Vercel. Framework akan terdeteksi sebagai Vite.

- Build command: `npm run build`
- Output directory: `dist`

## Tahap berikutnya

- Nominal unik dan Order ID
- Form pengajuan deposit
- Notifikasi bot Telegram kepada admin
- Tombol Setujui/Tolak
- Penyimpanan saldo dan riwayat transaksi

> Gunakan hanya QRIS merchant milik sendiri. Pembayaran tetap harus diperiksa pada mutasi aplikasi merchant; aplikasi ini tidak mendeteksi pembayaran secara otomatis.

Proyek ini dikembangkan berdasarkan konsep QRIS EMVCo dan terinspirasi oleh [verssache/qris-dinamis](https://github.com/verssache/qris-dinamis), yang berlisensi MIT.
