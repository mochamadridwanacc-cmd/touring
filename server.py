#!/usr/bin/env python3
"""
TouringMate Local HTTPS Server with Real-time Multi-Device Sync
Menghubungkan MacBook (Master) dan iPhone (Peserta) secara langsung.
"""

import http.server
import socketserver
import socket
import ssl
import json
import time
import os
import sys

# Cloud Port Support (Render, Railway, Heroku, Cloud Run, VPS)
PORT = int(os.environ.get("PORT", 1214))
if len(sys.argv) > 1 and sys.argv[1].isdigit():
    PORT = int(sys.argv[1])

# In-memory Convoy State shared across all devices (MacBook, iPhone, Android)
CONVOY_STATE = {
    "riders": {},      # id -> dict of rider data
    "masterId": None
}

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

class TouringSyncHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Permissions-Policy', 'camera=*, geolocation=*')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        # API endpoint to fetch convoy state
        if self.path == '/api/convoy':
            self.clean_expired_riders()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response_data = {
                "riders": list(CONVOY_STATE["riders"].values()),
                "masterId": CONVOY_STATE["masterId"]
            }
            self.wfile.write(json.dumps(response_data).encode('utf-8'))
            return

        super().do_GET()

    def do_POST(self):
        # API endpoint to sync device GPS & convoy actions
        if self.path == '/api/sync':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            try:
                data = json.loads(body)
            except Exception:
                data = {}

            action = data.get('action', 'update')
            rider = data.get('rider')

            # 1. Update this device's position
            if rider and 'id' in rider:
                rider_id = rider['id']
                rider['lastSeen'] = time.time()
                CONVOY_STATE["riders"][rider_id] = rider

                if rider.get('isMaster'):
                    CONVOY_STATE["masterId"] = rider_id

            # 2. Handle Master convoy actions
            if action == 'delete':
                target_id = data.get('targetId')
                if target_id in CONVOY_STATE["riders"]:
                    del CONVOY_STATE["riders"][target_id]

            elif action == 'clear':
                # Remove all dummy/offline riders, keep active devices
                active_real_riders = {}
                for rid, r in CONVOY_STATE["riders"].items():
                    if not r.get('isDummy'):
                        active_real_riders[rid] = r
                CONVOY_STATE["riders"] = active_real_riders

            elif action == 'set_convoy':
                # Master sends batch dummy riders
                new_list = data.get('convoyList', [])
                for r in new_list:
                    r['lastSeen'] = time.time()
                    CONVOY_STATE["riders"][r['id']] = r

            self.clean_expired_riders()

            # Return latest convoy list
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response_data = {
                "status": "ok",
                "riders": list(CONVOY_STATE["riders"].values()),
                "masterId": CONVOY_STATE["masterId"]
            }
            self.wfile.write(json.dumps(response_data).encode('utf-8'))
            return

        self.send_response(404)
        self.end_headers()

    def clean_expired_riders(self):
        # Devices that haven't sent heartbeat in > 120 seconds are removed (unless marked isDummy)
        now = time.time()
        to_del = []
        for rid, r in CONVOY_STATE["riders"].items():
            if not r.get('isDummy') and (now - r.get('lastSeen', now)) > 120:
                to_del.append(rid)
        for rid in to_del:
            del CONVOY_STATE["riders"][rid]
            if CONVOY_STATE["masterId"] == rid:
                CONVOY_STATE["masterId"] = None

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(base_dir)
    local_ip = get_local_ip()

    cert_file = os.path.join(base_dir, "cert.pem")
    key_file = os.path.join(base_dir, "key.pem")
    
    # In cloud environments (Render, Railway, VPS behind Nginx), SSL is terminated at edge
    is_cloud_env = "RENDER" in os.environ or "RAILWAY_STATIC_URL" in os.environ or "PORT" in os.environ and os.environ.get("PORT") != "1214"
    use_https = (os.path.exists(cert_file) and os.path.exists(key_file)) and not is_cloud_env

    protocol = "https" if use_https else "http"

    print("=" * 64)
    print(" 🏍️  TOURINGMATE - REAL-TIME MULTI-DEVICE SYNC")
    print("=" * 64)
    print(f" Status: {'🔒 HTTPS AKTIF' if use_https else 'HTTP'}")
    print(f" Port: {PORT}")
    print(f" 👉 Master (MacBook/Laptop) : {protocol}://localhost:{PORT}")
    print(f" 👉 Peserta (iPhone/HP)    : {protocol}://{local_ip}:{PORT}")
    print("=" * 64)
    print(" Sinkronisasi real-time antar perangkat aktif.")
    print(" Tekan Ctrl+C untuk mematikan server.")
    print("=" * 64)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), TouringSyncHandler) as httpd:
        if use_https:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certfile=cert_file, keyfile=key_file)
            httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer dihentikan.")
            sys.exit(0)

if __name__ == "__main__":
    main()
