# QRIS Dinamis Telegram

Fondasi aplikasi QRIS dinamis untuk alur deposit yang diverifikasi manual melalui Telegram.

## Fitur tahap dasar

- Membaca QRIS statis dari gambar
- Menerima payload QRIS melalui teks
- Validasi CRC16
- Menambahkan nominal pembayaran
- Membuat dan mengunduh QRIS dinamis
- Berjalan sepenuhnya di browser
- API privat untuk mengirim QRIS statis dan membuat QRIS dinamis di bot Telegram

## API QRIS untuk bot Telegram

Tambahkan dua Worker Secret berikut sebelum deploy:

```bash
npx wrangler secret put QRIS_API_KEY
npx wrangler secret put QRIS_STATIC_PAYLOAD
```

`QRIS_API_KEY` harus berupa key acak yang panjang dan hanya disimpan pada Worker bot.
`QRIS_STATIC_PAYLOAD` adalah teks EMVCo yang dibaca dari QRIS merchant milik sendiri.

Mengambil QRIS statis:

```http
GET /api/qris/static
Authorization: Bearer <QRIS_API_KEY>
```

Membuat QRIS dinamis:

```http
POST /api/qris/dynamic
Authorization: Bearer <QRIS_API_KEY>
Content-Type: application/json

{"amount":10000}
```

Kedua endpoint mengembalikan gambar `image/png`. Nominal dinamis yang diterima adalah
Rp1.000 sampai Rp1.000.000. API ini hanya membuat QRIS; pemeriksaan pembayaran dan
penambahan saldo tetap dilakukan admin secara manual.

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
