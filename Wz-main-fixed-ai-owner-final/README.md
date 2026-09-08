# WZ MANAGE PRO — FULL ONLINE

WZ MANAGE PRO menggunakan server/Neon PostgreSQL sebagai sumber data bisnis. Browser tidak lagi menyimpan data aplikasi secara persisten; data bisnis dikelola oleh server.

## Arsitektur online
- Login/logout memakai session HttpOnly dari server.
- Transaksi, VOID transaksi, dan laporan tutup shift disimpan di Neon.
- Dashboard Owner/Manager membaca ulang data server sehingga laporan yang dibuat di Device A dapat tampil di Device B.
- Master karyawan dan akun login dikelola melalui API server.
- Pengaturan, pelanggan, layanan, produk, cabang, profil, pengeluaran, dan data UI Owner/Manager dipersistenkan sebagai state aplikasi server melalui endpoint `app-state`.
- `save()` hanya memperbarui state di memori dan menjadwalkan penyimpanan server; tidak ada browser storage.
- Tidak ada fallback offline untuk transaksi/laporan. Bila server gagal, data tidak dianggap tersimpan.

## Environment variable
Salin `.env.example` sebagai acuan. Jangan commit file `.env` atau nilai rahasia ke Git.

### Wajib
- `WZDATABASE` — connection string PostgreSQL/Neon. API juga menerima `DATABASE_URL`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, atau `NEON_DATABASE_URL`.

Tanpa connection string, API tidak dapat membuat tabel, login, atau menyimpan data.

### Wajib: Web Push
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

Ketiga variabel harus diisi bersama-sama. Deployment dianggap belum siap dan `/api/ready` mengembalikan `503` jika salah satu belum ada.
Generate key dengan:
```bash
npx web-push generate-vapid-keys
```

### Wajib: WZ AI Analyst
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default kode: `gpt-4o-mini`)

`OPENAI_API_KEY` wajib diisi. Jika belum ada, endpoint WZ AI Analyst mengembalikan `503` dan deployment dianggap belum siap.

### Deployment
- `NODE_ENV=production` disarankan di Vercel agar pesan error internal tidak dikirim ke pengguna dan cookie session memakai `Secure`.

## Web Push
Environment yang diperlukan:
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

## Akun seed
- owner / owner123
- manager / manager123
- rizky / rizky123
- alvin / alvin123
- kyong / kyong123
- iwan / iwan123
- dika / dika123

## Catatan
PWA cache hanya untuk shell/static assets. `/api/*` tidak pernah dicache oleh service worker.

## QA
Sebelum deploy, jalankan:
```bash
node --check api/[...path].js
node --check tools/patch-online.js
node --check tools/online-bridge.js
```
Kemudian pastikan pencarian terhadap API penyimpanan browser tidak menghasilkan referensi pada source runtime.
