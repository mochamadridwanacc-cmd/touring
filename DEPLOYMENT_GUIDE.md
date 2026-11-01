# Panduan Deploy Cloud Mandiri (24/7 Tanpa MacBook)

Aplikasi TouringMate sekarang sudah **100% Cloud-Ready**. Anda bisa menjalankannya 24 jam nonstop di internet tanpa perlu MacBook menyala.

Pilih salah satu dari 2 cara di bawah sesuai kebutuhan Anda:

---

## OPSI 1: Deploy Gratis di Render.com (Paling Praktis — Rekomendasi ⭐)

Render menyediakan hosting gratis yang aktif 24 jam, langsung memberikan domain publik dan sertifikat SSL/HTTPS resmi sehingga **kamera dan GPS di iPhone langsung bekerja 100% tanpa warning**.

### Langkah-langkah (5 Menit):

1. **Upload folder proyek ke GitHub**:
   - Buat repository baru di [github.com](https://github.com) (misal: `touring-app`).
   - Push folder `/Users/ridwan/.gemini/antigravity/scratch/touring-app` ke repository tersebut:
     ```bash
     cd /Users/ridwan/.gemini/antigravity/scratch/touring-app
     git init
     git add .
     git commit -m "Initial commit TouringMate"
     git branch -M main
     git remote add origin https://github.com/USERNAME-ANDA/touring-app.git
     git push -u origin main
     ```

2. **Hubungkan ke Render.com**:
   - Buka [render.com](https://render.com) dan login (bisa pakai akun GitHub).
   - Klik tombol **New +** ➔ Pilih **Web Service**.
   - Pilih repository `touring-app` yang baru Anda buat.
   - Isi form konfigurasi:
     - **Name**: `touringmate` (atau nama klub touring Anda).
     - **Environment**: `Python 3`.
     - **Build Command**: *(kosongkan)*.
     - **Start Command**: `python3 server.py`.
     - **Plan**: Pilih **Free**.
   - Klik **Deploy Web Service**.

3. **Selesai!**
   - Dalam 1-2 menit, Render akan memberikan URL publik HTTPS Anda, misalnya:  
     👉 `https://touringmate.onrender.com`
   - Semua rider di jalan raya tinggal membuka link tersebut dari HP masing-masing menggunakan kuota internet 4G/5G!

---

## OPSI 2: Deploy di VPS Mandiri Milik Sendiri (Ubuntu / Debian)

Jika Anda menyewa VPS mandiri (seperti di Google Cloud Compute Engine, DigitalOcean, IDCloudHost, atau Biznet Gio) dan memiliki domain sendiri (misal: `touring.clubmotor.id`):

1. **Copy folder ke VPS**:
   ```bash
   scp -r /Users/ridwan/.gemini/antigravity/scratch/touring-app root@IP-VPS-ANDA:/opt/touring-app
   ```

2. **Jalankan script auto-setup di VPS**:
   ```bash
   ssh root@IP-VPS-ANDA
   cd /opt/touring-app
   sudo bash setup-vps.sh
   ```
   Script ini otomatis:
   - Memasang Nginx & Python.
   - Menjadikan TouringMate sebagai *System Service* yang hidup otomatis saat VPS restart.

3. **Aktifkan HTTPS Gratis dengan Let's Encrypt**:
   ```bash
   certbot --nginx -d touring.domainanda.com
   ```

Setelah itu, sistem touring klub Anda sudah aktif mandiri di cloud dengan domain Anda sendiri!
