# TouringMate - Aplikasi Touring & Auto Plate Scanner (Chrome PWA)

Aplikasi touring rombongan motor/mobil yang dirancang khusus untuk berjalan di browser **Google Chrome** (HP maupun Laptop). Dilengkapi dengan peta interaktif, pemantau jarak antar pengendara, dan **kamera auto-capture 10 detik** untuk mengenali plat nomor kawan di depan via OCR & Voice notification.

---

## 🌟 Fitur Utama

1. **Peta Touring Interaktif (Leaflet & OpenStreetMap)**:
   - Tampilan tema gelap (*tactical dark HUD*) berdaya kontras tinggi yang nyaman dilihat saat siang maupun malam.
   - Marker khusus untuk setiap peran:
     - **RC (Road Captain / Leader)**: Marker Biru.
     - **ME (Pengendara Sendiri)**: Marker Amber dengan efek radar pulse.
     - **SW (Sweeper)**: Marker Merah penutup barisan.
     - **R (Member)**: Marker Hijau.
2. **Kalkulator Jarak Real-Time (Haversine Formula)**:
   - Menghitung jarak Anda ke setiap anggota rombongan secara akurat (dalam meter atau km).
   - Menampilkan status posisi: `▲ Di Depan` atau `▼ Di Belakang`.
3. **Auto Camera Capture per 10 Detik & OCR Plat Nomor**:
   - Membuka kamera belakang HP menghadap ke jalan.
   - Mengambil frame secara otomatis per 10 detik dengan *countdown progress bar*.
   - Filter kontras & crop cerdas untuk membaca plat nomor Indonesia menggunakan **Tesseract.js**.
   - Otomatis mencocokkan plat dengan database rombongan.
4. **Voice Notification (Audio Interkom)**:
   - Menggunakan **Web Speech API** bahasa Indonesia.
   - Saat plat nomor teman terdeteksi di depan: suara otomatis berbunyi ke headset / interkom bluetooth di helm:  
     *"Di depan Anda: Dimas Prasetyo, Kawasaki Versys 650."*
5. **Screen Wake Lock API**:
   - Mencegah layar HP mati/terkunci saat dipasang pada *phone holder* stang motor.
6. **Mode Simulasi & Tes Demo**:
   - Tombol **"Simulasi Konvoi"** untuk melihat rombongan bergerak di peta meski Anda sedang berada di dalam ruangan.
   - Tombol **"Tes Demo Plat"** untuk langsung menguji respon audio & visual deteksi plat tanpa harus menyalakan kamera di jalan.

---

## 🚀 Cara Menjalankan

Masuk ke direktori proyek dan jalankan server lokal bawaan Python:

```bash
cd /Users/ridwan/.gemini/antigravity/scratch/touring-app
python3 server.py
```

Buka Google Chrome dan akses:
- **Di Laptop/Mac**: [http://localhost:1214](http://localhost:1214)
- **Di HP (Dalam satu jaringan WiFi)**: Buka alamat IP yang tertera di terminal (contoh: `http://192.168.1.x:1214`).

---

## 📱 Tips Penggunaan di HP Saat Touring

1. **Izin Kamera & Lokasi**:
   - Saat pertama kali membuka di Chrome, klik **"Allow"** / **"Izinkan"** untuk akses Lokasi (GPS) dan Kamera.
2. **Install sebagai PWA (Fullscreen tanpa address bar)**:
   - Di Chrome Android / iOS: klik menu titik tiga (⋮) -> pilih **"Add to Home Screen"** (*Tambahkan ke Layar Utama*).
3. **Akses Kamera di IP Lokal (Bila pakai WiFi tanpa HTTPS)**:
   - Jika Chrome di HP memblokir kamera di jaringan lokal HTTP, buka tab baru di Chrome HP:
     `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
   - Masukkan alamat IP komputer Anda (misal `http://192.168.1.15:1214`), ubah jadi **Enabled**, lalu klik **Relaunch**.
