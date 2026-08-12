# D1 Payment Orders Setup

Tahap ini menambahkan penyimpanan order QRIS milik Worker sendiri tanpa melepas GatePay.
GatePay masih membuat checkout dan mendeteksi pembayaran. D1 menjadi sumber riwayat transaksi internal.

## 1. Buat database D1

Buat database D1 baru, contoh nama: `qris-payment-orders`.

## 2. Tambahkan binding

Tambahkan binding D1 dengan nama variabel `DB` ke Worker `qris-dinamis-telegram`.
Jika binding dikelola lewat `wrangler.jsonc`, tambahkan blok `d1_databases` menggunakan `database_id` asli dari Cloudflare.
Jangan memasukkan ID contoh/palsu karena akan membuat deploy gagal.

## 3. Jalankan migration

Jalankan file `migrations/0001_payment_orders.sql` pada database tersebut sebelum mengandalkan penyimpanan transaksi.

## 4. Verifikasi

Endpoint internal berikut tersedia setelah deploy:

`GET /internal/payment-db/health`

Header wajib:

`x-internal-secret: <QRIS_INTERNAL_SECRET>`

Respons sehat:

`{"ok":true,"configured":true,"payment_orders":0}`

Jika D1 belum di-bind, Worker tetap memproses pembayaran seperti sebelumnya dan endpoint health mengembalikan `d1_not_bound`.

## Perilaku kompatibilitas

- `/internal/orders` tetap memakai GatePay.
- `/webhook/gatepay` tetap memverifikasi signature GatePay.
- Kegagalan menulis D1 tidak menggagalkan pembuatan order atau webhook GatePay.
- Order sukses disalin ke `payment_orders`.
- Webhook `order.paid` mengubah status lokal menjadi `paid`.
- `settlement_status=delivered` berarti callback ke website/bot berhasil.
- `settlement_status=retry_needed` berarti pembayaran sudah diterima tetapi callback downstream gagal dan perlu ditindaklanjuti.
