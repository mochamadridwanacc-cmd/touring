#!/bin/bash
# ==============================================================
# Script Instalasi Otomatis TouringMate di VPS Ubuntu / Debian
# Jalankan dengan: sudo bash setup-vps.sh
# ==============================================================

set -e

echo "🚀 Memulai Setup TouringMate di Cloud VPS..."

# 1. Update sistem & install dependensi
apt-get update
apt-get install -y python3 git nginx certbot python3-certbot-nginx

# 2. Buat direktori app jika belum ada
APP_DIR="/opt/touring-app"
mkdir -p $APP_DIR
cp -r * $APP_DIR/ || true
cd $APP_DIR

# 3. Setup systemd service agar aplikasi jalan 24 jam & auto restart
cat << 'EOF' > /etc/systemd/system/touringmate.service
[Unit]
Description=TouringMate Realtime Convoy Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/touring-app
ExecStart=/usr/bin/python3 /opt/touring-app/server.py 8080
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable touringmate
systemctl restart touringmate

echo "✅ Service TouringMate aktif di port 8080!"
echo "👉 Untuk memasang domain & HTTPS gratis dari Let's Encrypt:"
echo "   certbot --nginx -d domainanda.com"
