/**
 * TouringMate - Application Core Logic
 * PWA & Chrome-optimized touring navigator & plate scanner
 */

// Application State
const state = {
  myProfile: null,
  myCoords: { lat: -6.200000, lng: 106.816666, speed: 0, heading: 0 },
  riders: [],
  map: null,
  mapMarkers: {},
  wakeLock: null,
  isVoiceActive: true,
  isCameraActive: false,
  autoScanEnabled: true,
  scanIntervalSeconds: 10,
  scanCountdown: 10,
  timerInterval: null,
  isOcrBusy: false,
  isSimulationActive: false,
  simInterval: null,
  tesseractWorker: null
};

// Preset Convoy Members (Dummies initialized by Master if needed)
const DEFAULT_CONVOY = [
  {
    id: 'dummy-1',
    name: 'Dimas (Road Captain)',
    plate: 'B 4567 XYZ',
    vehicle: 'Kawasaki Versys 650',
    role: 'LEADER',
    latOffset: 0.00035,
    lngOffset: 0.00015,
    isDummy: true,
    lastSeen: 'Live'
  },
  {
    id: 'dummy-2',
    name: 'Andi Kusuma',
    plate: 'D 1289 BDG',
    vehicle: 'Honda CB500X',
    role: 'MEMBER',
    latOffset: 0.00012,
    lngOffset: 0.00005,
    isDummy: true,
    lastSeen: 'Live'
  },
  {
    id: 'dummy-3',
    name: 'Faisal (Sweeper)',
    plate: 'B 8899 SWE',
    vehicle: 'Yamaha XMAX 250',
    role: 'SWEEPER',
    latOffset: -0.00085,
    lngOffset: -0.00020,
    isDummy: true,
    lastSeen: 'Live'
  }
];

// Initialize application on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) {
    lucide.createIcons();
  }

  loadProfile();
  initMap();
  initGeolocation();
  initWakeLock();
  initEventListeners();
  initAudioContextUnlock();

  // Check for HTTPS on mobile devices
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    const banner = document.getElementById('httpsWarningBanner');
    if (banner) banner.classList.remove('hidden');
  }

  // Start Realtime Background Sync with Server (MacBook <-> iPhone)
  syncWithServer();
  setInterval(syncWithServer, 2000);
});

/* ==========================================================================
   1. USER PROFILE, DEVICE ROLE (MASTER / PESERTA) & REALTIME SYNC
   ========================================================================== */
function loadProfile() {
  const saved = localStorage.getItem('touring_profile');
  if (saved) {
    state.myProfile = JSON.parse(saved);
    if (!state.myProfile.id) {
      state.myProfile.id = 'rider-' + Math.random().toString(36).substring(2, 9);
      saveProfile(state.myProfile);
    }
    updateProfileUI();
  } else {
    // Default smart role: Localhost/MacBook = Master, iPhone/Mobile = Peserta
    const isLocalhost = (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
    if (document.getElementById('modeMaster')) {
      document.getElementById('modeMaster').checked = isLocalhost;
      document.getElementById('modePeserta').checked = !isLocalhost;
    }
    document.getElementById('profileModal').classList.remove('hidden');
  }
}

function saveProfile(profile) {
  state.myProfile = profile;
  localStorage.setItem('touring_profile', JSON.stringify(profile));
  updateProfileUI();
  syncWithServer('update');
}

function updateProfileUI() {
  if (!state.myProfile) return;
  document.getElementById('myProfileName').textContent = state.myProfile.name;
  document.getElementById('myProfilePlate').textContent = state.myProfile.plate;
  document.getElementById('myProfileVehicle').textContent = state.myProfile.vehicle;
  document.getElementById('myProfileSummary').textContent = `${state.myProfile.name} • ${state.myProfile.plate}`;
  
  const roleCode = state.myProfile.role === 'LEADER' ? 'RC' : (state.myProfile.role === 'SWEEPER' ? 'SW' : 'MB');
  document.getElementById('myRoleBadgeIcon').textContent = roleCode;

  // Master badge update
  const devBadge = document.getElementById('deviceRoleBadge');
  if (devBadge) {
    if (state.myProfile.isMaster) {
      devBadge.className = 'px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-400 font-bold border border-amber-500/40';
      devBadge.textContent = '👑 MASTER';
    } else {
      devBadge.className = 'px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-400 font-bold border border-emerald-500/40';
      devBadge.textContent = '🏍️ PESERTA';
    }
  }
}

// Real-time synchronization loop with server (Shared across MacBook & iPhone)
async function syncWithServer(customAction = 'update', extraData = {}) {
  const payload = {
    action: customAction,
    targetId: extraData.targetId || null,
    convoyList: extraData.convoyList || null,
    rider: state.myProfile ? {
      id: state.myProfile.id,
      name: state.myProfile.name,
      plate: state.myProfile.plate,
      vehicle: state.myProfile.vehicle,
      role: state.myProfile.role,
      isMaster: !!state.myProfile.isMaster,
      lat: state.myCoords.lat,
      lng: state.myCoords.lng,
      speed: state.myCoords.speed,
      heading: state.myCoords.heading,
      isDummy: false
    } : null
  };

  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      if (data.riders) {
        const myId = state.myProfile ? state.myProfile.id : null;
        // Keep all riders from server except myself
        state.riders = data.riders.filter(r => r.id !== myId);
        updateMapMarkers();
        renderRoster();

        const syncInd = document.getElementById('serverSyncIndicator');
        if (syncInd) {
          syncInd.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Terhubung (${data.riders.length} Device)`;
        }
      }
    }
  } catch (err) {
    // Network or server busy
    console.debug('Sync status:', err.message);
  }
}

/* ==========================================================================
   2. SCREEN WAKE LOCK (Mencegah Layar HP Mati di Stang Motor)
   ========================================================================== */
async function initWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      const badge = document.getElementById('wakeLockBadge');
      if (badge) badge.classList.remove('hidden');
      
      state.wakeLock.addEventListener('release', () => {
        if (badge) badge.classList.add('hidden');
      });
    } catch (err) {
      console.warn('Wake Lock request failed:', err);
    }
  }
}

/* ==========================================================================
   3. LEAFLET MAP & RIDER MARKERS
   ========================================================================== */
function initMap() {
  // Default coordinate (Jakarta Center or fallback)
  const defaultPos = [state.myCoords.lat, state.myCoords.lng];

  state.map = L.map('map', {
    zoomControl: false,
    attributionControl: false
  }).setView(defaultPos, 17);

  // High contrast / OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
  }).addTo(state.map);

  // Add zoom control at bottom right
  L.control.zoom({ position: 'bottomright' }).addTo(state.map);
}

function updateMapMarkers() {
  if (!state.map) return;

  // 1. My Marker
  const myLatLng = [state.myCoords.lat, state.myCoords.lng];
  const myLabel = state.myProfile ? `${state.myProfile.name} (Saya)` : 'Saya';
  const myPlate = state.myProfile ? state.myProfile.plate : 'MY-GPS';

  if (!state.mapMarkers['self']) {
    const selfIcon = L.divIcon({
      className: 'custom-rider-marker marker-self',
      html: `
        <div class="pulse-circle"></div>
        <div class="marker-pin"><span class="marker-pin-inner">ME</span></div>
        <div class="marker-label">${myPlate}</div>
      `,
      iconSize: [40, 50],
      iconAnchor: [20, 50]
    });
    state.mapMarkers['self'] = L.marker(myLatLng, { icon: selfIcon }).addTo(state.map);
  } else {
    state.mapMarkers['self'].setLatLng(myLatLng);
  }

  // 2. Convoy Markers
  state.riders.forEach(rider => {
    const riderLat = state.myCoords.lat + (rider.latOffset || 0);
    const riderLng = state.myCoords.lng + (rider.lngOffset || 0);
    const riderPos = [riderLat, riderLng];

    const roleClass = rider.role === 'LEADER' ? 'marker-leader' : (rider.role === 'SWEEPER' ? 'marker-sweeper' : 'marker-member');
    const roleTag = rider.role === 'LEADER' ? 'RC' : (rider.role === 'SWEEPER' ? 'SW' : 'R');

    if (!state.mapMarkers[rider.id]) {
      const riderIcon = L.divIcon({
        className: `custom-rider-marker ${roleClass}`,
        html: `
          <div class="marker-pin"><span class="marker-pin-inner">${roleTag}</span></div>
          <div class="marker-label">${rider.plate}</div>
        `,
        iconSize: [40, 50],
        iconAnchor: [20, 50]
      });
      state.mapMarkers[rider.id] = L.marker(riderPos, { icon: riderIcon })
        .bindPopup(`<b>${rider.name}</b><br>${rider.vehicle}<br>Plat: ${rider.plate}`)
        .addTo(state.map);
    } else {
      state.mapMarkers[rider.id].setLatLng(riderPos);
    }
  });

  // Remove stale markers that were deleted
  const activeIds = new Set(['self', ...state.riders.map(r => r.id)]);
  Object.keys(state.mapMarkers).forEach(id => {
    if (!activeIds.has(id)) {
      state.map.removeLayer(state.mapMarkers[id]);
      delete state.mapMarkers[id];
    }
  });
}

/* ==========================================================================
   4. GEOLOCATION & REALTIME DISTANCE (HAVERSINE)
   ========================================================================== */
function initGeolocation() {
  if (!navigator.geolocation) {
    document.getElementById('gpsStatusText').innerHTML = '<span class="text-rose-400">GPS Tidak Didukung</span>';
    return;
  }

  const handlePosition = (position) => {
    const { latitude, longitude, speed } = position.coords;
    state.myCoords.lat = latitude;
    state.myCoords.lng = longitude;
    state.myCoords.speed = speed ? Math.round(speed * 3.6) : 0; // m/s to km/h

    document.getElementById('hudSpeed').textContent = state.myCoords.speed;
    document.getElementById('gpsStatusText').innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> GPS Akurat';

    updateMapMarkers();
    renderRoster();
  };

  const handleError = (err) => {
    console.warn('Geolocation notice:', err.code, err.message);
    let msg = 'GPS Mode Sim';
    if (err.code === 1) {
      msg = 'Izin GPS Ditolak';
    } else if (err.code === 2) {
      msg = 'Sinyal GPS Lemah';
    } else if (err.code === 3) {
      msg = 'GPS Timeout';
    }
    document.getElementById('gpsStatusText').innerHTML = `<span class="text-amber-400">${msg}</span>`;
  };

  const geoOptions = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };

  // Fast initial lock for iOS
  navigator.geolocation.getCurrentPosition(handlePosition, handleError, geoOptions);
  // Continuous watching
  navigator.geolocation.watchPosition(handlePosition, handleError, geoOptions);
}

// Haversine distance formula in meters
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const radLat1 = (lat1 * Math.PI) / 180;
  const radLat2 = (lat2 * Math.PI) / 180;
  const deltaLat = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLon = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
            Math.cos(radLat1) * Math.cos(radLat2) *
            Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function formatDistance(meters) {
  if (meters < 1000) return `${meters} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function renderRoster() {
  const container = document.getElementById('riderListContainer');
  if (!container) return;

  // Calculate distance for each rider relative to me
  const processedRiders = state.riders.map(rider => {
    const rLat = state.myCoords.lat + (rider.latOffset || 0);
    const rLng = state.myCoords.lng + (rider.lngOffset || 0);
    const dist = calculateDistanceMeters(state.myCoords.lat, state.myCoords.lng, rLat, rLng);
    const isAhead = (rider.latOffset || 0) >= 0;
    return { ...rider, distance: dist, isAhead };
  });

  // Sort: Riders in front first (closest to furthest), then riders behind
  processedRiders.sort((a, b) => a.distance - b.distance);

  container.innerHTML = '';
  let maxDist = 0;

  if (processedRiders.length === 0) {
    container.innerHTML = `
      <div class="py-12 px-4 text-center text-slate-500 text-xs">
        <i data-lucide="users-2" class="w-10 h-10 mx-auto mb-3 text-slate-600"></i>
        <p class="font-semibold text-slate-300 mb-1">Rombongan Kosong</p>
        <p class="text-slate-500">Klik tombol <strong>+5 Dummy</strong> atau <strong>Tambah Pengendara</strong> di bawah untuk menambah rider.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
  } else {
    processedRiders.forEach(rider => {
      if (rider.distance > maxDist) maxDist = rider.distance;

      const roleBadge = rider.role === 'LEADER'
        ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/20 text-blue-400 border border-blue-500/30 font-bold">ROAD CAPTAIN</span>'
        : (rider.role === 'SWEEPER'
          ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/20 text-rose-400 border border-rose-500/30 font-bold">SWEEPER</span>'
          : (rider.role === 'MEDIC'
            ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 border border-red-500/30 font-bold">MEDIS</span>'
            : '<span class="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">MEMBER</span>'));

      const directionIcon = rider.isAhead 
        ? '<span class="text-emerald-400 text-xs flex items-center gap-0.5 font-semibold">▲ Di Depan</span>'
        : '<span class="text-amber-400 text-xs flex items-center gap-0.5 font-semibold">▼ Di Belakang</span>';

      const card = document.createElement('div');
      card.className = 'bg-slate-950/70 border border-slate-800 rounded-xl p-3 hover:border-slate-700 transition flex items-center justify-between group';
      card.innerHTML = `
        <div class="flex-1 min-w-0 pr-2">
          <div class="flex items-center gap-1.5 mb-1">
            <span class="text-sm font-bold text-slate-100 truncate">${rider.name}</span>
            ${roleBadge}
          </div>
          <div class="text-xs text-slate-400 flex items-center gap-2">
            <span class="truncate max-w-[110px]">${rider.vehicle}</span>
            <span>•</span>
            <span class="font-mono text-amber-300 font-bold">${rider.plate}</span>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <div class="text-right">
            <div class="text-base font-black font-mono text-slate-100">${formatDistance(rider.distance)}</div>
            <div>${directionIcon}</div>
          </div>
          <button class="btn-delete-rider p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition" data-id="${rider.id}" title="Hapus ${rider.name}">
            <i data-lucide="trash-2" class="w-4 h-4 pointer-events-none"></i>
          </button>
        </div>
      `;
      container.appendChild(card);
    });

    if (window.lucide) lucide.createIcons();
  }

  document.getElementById('rosterCountBadge').textContent = `${state.riders.length + 1} Rider`;
  document.getElementById('totalConnectedCount').textContent = `${state.riders.length + 1} Pengendara`;
  document.getElementById('convoySpread').textContent = formatDistance(maxDist);
}

/* ==========================================================================
   5. CAMERA ACCESS & AUTO-CAPTURE PER 10 DETIK (iOS & Android Compatible)
   ========================================================================== */
async function startCamera() {
  const video = document.getElementById('cameraFeed');
  if (!video) return;

  // iOS Safari/Chrome requirements
  video.setAttribute('autoplay', '');
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.muted = true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('MediaDevices not supported or blocked by HTTP on iOS');
    const warning = document.getElementById('httpsWarningBanner');
    if (warning) warning.classList.remove('hidden');
    alert('Kamera diblokir oleh iOS karena tidak menggunakan HTTPS!\nSilakan buka lewat alamat https:// (bukan http://).');
    return;
  }

  let stream = null;

  // Progressive fallback constraints for mobile iOS/Android
  const constraintsList = [
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false }
  ];

  for (const constraint of constraintsList) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraint);
      if (stream) break;
    } catch (e) {
      console.warn('Retrying camera constraint:', e.message);
    }
  }

  if (stream) {
    video.srcObject = stream;
    try {
      await video.play();
    } catch (e) {
      console.warn('Video play triggered:', e);
    }
    state.isCameraActive = true;
    startAutoScanTimer();
  } else {
    alert('Tidak dapat mengaktifkan kamera.\nJika Anda menggunakan iPhone:\n1. Buka melalui HTTPS: https://\n2. Klik Izinkan (Allow) saat Safari/Chrome meminta izin Kamera.');
  }
}

function stopCamera() {
  const video = document.getElementById('cameraFeed');
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
  state.isCameraActive = false;
  clearInterval(state.timerInterval);
}

function startAutoScanTimer() {
  clearInterval(state.timerInterval);
  state.scanCountdown = state.scanIntervalSeconds;
  updateTimerUI();

  state.timerInterval = setInterval(() => {
    if (!state.autoScanEnabled || state.isOcrBusy) return;

    state.scanCountdown -= 0.2;
    if (state.scanCountdown <= 0) {
      state.scanCountdown = state.scanIntervalSeconds;
      captureAndRecognizePlate();
    }
    updateTimerUI();
  }, 200);
}

function updateTimerUI() {
  const badge = document.getElementById('captureTimerBadge');
  const bar = document.getElementById('captureProgressBar');
  if (badge) badge.textContent = `${Math.ceil(state.scanCountdown)}s`;
  if (bar) {
    const percent = (state.scanCountdown / state.scanIntervalSeconds) * 100;
    bar.style.width = `${percent}%`;
  }
}

/* ==========================================================================
   6. CAPTURE FRAME, OCR PROCESSING & MATCHING
   ========================================================================== */
async function captureAndRecognizePlate() {
  const video = document.getElementById('cameraFeed');
  const canvas = document.getElementById('captureCanvas');
  const overlay = document.getElementById('ocrStatusOverlay');
  const laser = document.getElementById('scanLaser');

  if (!video || !video.videoWidth || state.isOcrBusy) return;

  state.isOcrBusy = true;
  if (overlay) overlay.classList.remove('hidden');
  if (laser) laser.classList.remove('hidden');

  try {
    // 1. Capture only the center targeting box (saves ~80% OCR time & boosts accuracy)
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cropWidth = Math.round(vw * 0.7);
    const cropHeight = Math.round(vh * 0.35);
    const cropX = Math.round((vw - cropWidth) / 2);
    const cropY = Math.round((vh - cropHeight) / 2);

    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    // 2. Preprocess image: Grayscale & Contrast boost for license plates
    const imgData = ctx.getImageData(0, 0, cropWidth, cropHeight);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const avg = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      // High contrast binarization curve
      const val = avg > 115 ? 255 : 0;
      d[i] = val;
      d[i + 1] = val;
      d[i + 2] = val;
    }
    ctx.putImageData(imgData, 0, 0);

    // 3. Perform OCR with Tesseract
    const result = await Tesseract.recognize(canvas, 'eng', {
      logger: m => console.log('Tesseract:', m.status, m.progress)
    });

    const rawText = result.data.text;
    console.log('OCR Output Text:', rawText);

    // 4. Match with Indonesian License Plate patterns
    processDetectedText(rawText);

  } catch (err) {
    console.error('Error during OCR processing:', err);
  } finally {
    state.isOcrBusy = false;
    if (overlay) overlay.classList.add('hidden');
    if (laser) laser.classList.add('hidden');
  }
}

function processDetectedText(text) {
  if (!text) return;

  // Clean string: uppercase, remove symbols except letters and numbers
  const cleaned = text.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ');
  console.log('Cleaned OCR Plate Text:', cleaned);

  // Look for plate matches among registered riders
  let matchedRider = null;

  for (const rider of state.riders) {
    const rawRiderPlate = rider.plate.toUpperCase().replace(/\s+/g, '');
    const searchTarget = cleaned.replace(/\s+/g, '');

    // Check if rider's plate is inside detected text
    if (searchTarget.includes(rawRiderPlate)) {
      matchedRider = rider;
      break;
    }

    // Secondary check: match numbers & suffix (e.g. "4567 XYZ")
    const parts = rider.plate.split(' ');
    if (parts.length >= 2) {
      const numberPart = parts[1];
      if (numberPart && searchTarget.includes(numberPart)) {
        matchedRider = rider;
        break;
      }
    }
  }

  if (matchedRider) {
    triggerRiderIdentifiedAlert(matchedRider);
  }
}

/* ==========================================================================
   7. VOICE & HUD ALERTS (Pemberitahuan Suara ke Interkom)
   ========================================================================== */
function triggerRiderIdentifiedAlert(rider) {
  // Play chime sound
  const audio = document.getElementById('alertAudio');
  if (audio) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }

  // Show visual HUD Card
  const card = document.getElementById('detectedRiderCard');
  if (card) {
    document.getElementById('detectedRiderName').textContent = rider.name;
    document.getElementById('detectedVehicle').textContent = rider.vehicle;
    document.getElementById('detectedPlate').textContent = rider.plate;
    document.getElementById('detectedTime').textContent = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    card.classList.remove('hidden');

    // Auto hide after 8 seconds
    setTimeout(() => {
      card.classList.add('hidden');
    }, 8000);
  }

  // Web Speech API: Announce to rider's bluetooth helmet intercom
  if (state.isVoiceActive && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel(); // Stop previous voice
    const voiceMsg = `Di depan Anda: ${rider.name}, ${rider.vehicle}.`;
    const utterance = new SpeechSynthesisUtterance(voiceMsg);
    utterance.lang = 'id-ID';
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }
}

function initAudioContextUnlock() {
  // Web browsers require user interaction once to allow sound
  const unlock = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    }
    window.removeEventListener('click', unlock);
  };
  window.addEventListener('click', unlock);
}

/* ==========================================================================
   8. CONVOY SIMULATION (Untuk Testing Tanpa Turun ke Jalan)
   ========================================================================== */
function toggleSimulation() {
  state.isSimulationActive = !state.isSimulationActive;
  const btn = document.getElementById('btnSimulationToggle');

  if (state.isSimulationActive) {
    btn.innerHTML = '<i data-lucide="pause-circle" class="w-5 h-5 text-amber-400"></i>';
    if (window.lucide) lucide.createIcons();

    // Start simulated movement
    let angle = 0;
    state.simInterval = setInterval(() => {
      angle += 0.05;
      // Make simulated riders oscillate forward and backward
      state.riders[0].latOffset = 0.00035 + Math.sin(angle) * 0.00008;
      state.riders[1].latOffset = 0.00015 + Math.cos(angle) * 0.00004;
      state.riders[2].latOffset = -0.00075 + Math.sin(angle * 0.7) * 0.00010;

      // Simulated speed
      state.myCoords.speed = Math.round(55 + Math.sin(angle) * 10);
      document.getElementById('hudSpeed').textContent = state.myCoords.speed;

      updateMapMarkers();
      renderRoster();
    }, 1500);

    alert('Mode Simulasi Aktif! Pengendara rombongan sekarang bergerak otomatis di peta untuk uji coba jarak.');
  } else {
    btn.innerHTML = '<i data-lucide="play-circle" class="w-5 h-5 text-cyan-400"></i>';
    if (window.lucide) lucide.createIcons();
    clearInterval(state.simInterval);
  }
}

/* ==========================================================================
   9. EVENT LISTENERS & UI WIRING
   ========================================================================== */
function initEventListeners() {
  // Recenter map button
  document.getElementById('btnRecenter').addEventListener('click', () => {
    if (state.map) {
      state.map.setView([state.myCoords.lat, state.myCoords.lng], 17, { animate: true });
    }
  });

  // Drawer toggles
  const drawer = document.getElementById('rosterDrawer');
  document.getElementById('btnToggleRoster').addEventListener('click', () => {
    drawer.classList.remove('translate-x-full');
  });
  document.getElementById('btnCloseRoster').addEventListener('click', () => {
    drawer.classList.add('translate-x-full');
  });

  // Camera HUD toggles
  const camHud = document.getElementById('cameraHud');
  document.getElementById('btnToggleCam').addEventListener('click', () => {
    if (camHud.classList.contains('hidden')) {
      camHud.classList.remove('hidden');
      startCamera();
    } else {
      camHud.classList.add('hidden');
      stopCamera();
    }
  });
  document.getElementById('btnCloseCam').addEventListener('click', () => {
    camHud.classList.add('hidden');
    stopCamera();
  });

  // Auto scan checkbox
  document.getElementById('toggleAutoScan').addEventListener('change', (e) => {
    state.autoScanEnabled = e.target.checked;
  });

  // Manual Scan button
  document.getElementById('btnManualCapture').addEventListener('click', () => {
    captureAndRecognizePlate();
  });

  // Test Demo Scan (Instant simulation button)
  document.getElementById('btnSimulateScan').addEventListener('click', () => {
    // Pick random rider from convoy
    const rider = state.riders[Math.floor(Math.random() * state.riders.length)];
    triggerRiderIdentifiedAlert(rider);
  });

  // Voice mute/unmute
  const voiceBtn = document.getElementById('btnVoiceToggle');
  voiceBtn.addEventListener('click', () => {
    state.isVoiceActive = !state.isVoiceActive;
    voiceBtn.innerHTML = state.isVoiceActive
      ? '<i data-lucide="volume-2" class="w-4 h-4 text-emerald-400"></i>'
      : '<i data-lucide="volume-x" class="w-4 h-4 text-slate-500"></i>';
    if (window.lucide) lucide.createIcons();
  });

  // Simulation Button
  document.getElementById('btnSimulationToggle').addEventListener('click', toggleSimulation);

  // Profile Modal & Form
  const modal = document.getElementById('profileModal');
  const openModal = () => {
    if (state.myProfile) {
      document.getElementById('inputName').value = state.myProfile.name;
      document.getElementById('inputPlate').value = state.myProfile.plate;
      document.getElementById('inputVehicle').value = state.myProfile.vehicle;
      document.getElementById('inputRole').value = state.myProfile.role;
      if (document.getElementById('modeMaster')) {
        document.getElementById('modeMaster').checked = !!state.myProfile.isMaster;
        document.getElementById('modePeserta').checked = !state.myProfile.isMaster;
      }
    }
    modal.classList.remove('hidden');
  };
  document.getElementById('btnOpenEditProfile').addEventListener('click', openModal);
  document.getElementById('btnCloseModal').addEventListener('click', () => modal.classList.add('hidden'));

  document.getElementById('profileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const isMasterSelected = document.getElementById('modeMaster') ? document.getElementById('modeMaster').checked : false;
    const profile = {
      id: state.myProfile?.id || ('rider-' + Math.random().toString(36).substring(2, 9)),
      name: document.getElementById('inputName').value.trim(),
      plate: document.getElementById('inputPlate').value.trim().toUpperCase(),
      vehicle: document.getElementById('inputVehicle').value.trim(),
      role: document.getElementById('inputRole').value,
      isMaster: isMasterSelected
    };
    saveProfile(profile);
    modal.classList.add('hidden');
    document.getElementById('btnCloseModal').classList.remove('hidden');
    updateMapMarkers();
    renderRoster();
  });

  // Add custom rider button
  document.getElementById('btnAddNewRider').addEventListener('click', () => {
    const name = prompt('Nama Rider:');
    if (!name) return;
    const plate = prompt('Nomor Plat (Contoh: B 1234 ABC):');
    if (!plate) return;
    const vehicle = prompt('Kendaraan (Contoh: Honda PCX):') || 'Motor';

    const newRider = {
      id: `rider-${Date.now()}`,
      name,
      plate: plate.toUpperCase(),
      vehicle,
      role: 'MEMBER',
      latOffset: 0.00020,
      lngOffset: 0.00010,
      isDummy: true,
      lastSeen: 'Live'
    };

    syncWithServer('set_convoy', { convoyList: [newRider] });
    alert(`Berhasil menambahkan ${name} ke rombongan!`);
  });

  // Generate 5 Dummy Riders
  const DUMMY_POOL = [
    { name: 'Bayu Nugroho', plate: 'B 3012 RDW', vehicle: 'BMW R1250GS', role: 'MEMBER', offsetDist: 35 },
    { name: 'Eko Prasetya', plate: 'D 4455 BDG', vehicle: 'Yamaha MT-09', role: 'MEMBER', offsetDist: -45 },
    { name: 'Gilang Ramadhan', plate: 'AD 5566 SLO', vehicle: 'Honda ADV 160', role: 'MEMBER', offsetDist: 70 },
    { name: 'Hendra Saputra', plate: 'B 7788 TNG', vehicle: 'Vespa GTS 300', role: 'MEMBER', offsetDist: -90 },
    { name: 'Dokter Arya (Medis)', plate: 'B 1199 MED', vehicle: 'Toyota Hilux Rescue', role: 'MEDIC', offsetDist: -150 }
  ];

  document.getElementById('btnGenerateDummy').addEventListener('click', () => {
    const newDummies = [];
    DUMMY_POOL.forEach((item, idx) => {
      const latOffset = (item.offsetDist / 111000);
      const lngOffset = ((idx % 2 === 0 ? 1 : -1) * 15) / 111000;

      newDummies.push({
        id: `dummy-${item.plate.replace(/\s+/g, '')}`,
        name: item.name,
        plate: item.plate,
        vehicle: item.vehicle,
        role: item.role,
        latOffset,
        lngOffset,
        isDummy: true,
        lastSeen: 'Live'
      });
    });

    syncWithServer('set_convoy', { convoyList: newDummies });
    alert(`Berhasil menambahkan 5 peserta touring dummy ke rombongan bersama!`);
  });

  // Reset Convoy to default
  document.getElementById('btnResetConvoy').addEventListener('click', () => {
    syncWithServer('set_convoy', { convoyList: DEFAULT_CONVOY });
    alert('Rombongan telah di-reset ke rombongan standar.');
  });

  // Clear all dummy riders (Kosongkan Rombongan)
  document.getElementById('btnClearAllRiders').addEventListener('click', () => {
    if (confirm('Yakin ingin membersihkan semua peserta dummy? Hanya HP/Laptop asli yang akan tersisa.')) {
      syncWithServer('clear');
    }
  });

  // Delete Individual Rider
  document.getElementById('riderListContainer').addEventListener('click', (e) => {
    const delBtn = e.target.closest('.btn-delete-rider');
    if (delBtn) {
      const riderId = delBtn.dataset.id;
      const targetRider = state.riders.find(r => r.id === riderId);
      const name = targetRider ? targetRider.name : 'peserta ini';
      
      if (confirm(`Hapus ${name} dari rombongan?`)) {
        syncWithServer('delete', { targetId: riderId });
      }
    }
  });

  // QR Code Join Modal & Generation
  let qrcodeInstance = null;
  const qrModal = document.getElementById('qrModal');
  const qrContainer = document.getElementById('qrcodeCanvas');
  const shareInput = document.getElementById('shareUrlInput');

  function openQrModal() {
    // Current URL (e.g. https://192.168.110.17:1214)
    const joinUrl = window.location.origin + window.location.pathname;
    shareInput.value = joinUrl;

    // Clear previous QR
    qrContainer.innerHTML = '';

    // Generate new QR Code
    if (window.QRCode) {
      qrcodeInstance = new QRCode(qrContainer, {
        text: joinUrl,
        width: 190,
        height: 190,
        colorDark: '#020617',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    }

    qrModal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
  }

  document.getElementById('btnOpenQrModal').addEventListener('click', openQrModal);
  document.getElementById('btnCloseQrModal').addEventListener('click', () => {
    qrModal.classList.add('hidden');
  });

  // Copy Link button
  document.getElementById('btnCopyShareUrl').addEventListener('click', () => {
    navigator.clipboard.writeText(shareInput.value).then(() => {
      const btn = document.getElementById('btnCopyShareUrl');
      const originalHTML = btn.innerHTML;
      btn.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5 text-emerald-400"></i> Tersalin!';
      if (window.lucide) lucide.createIcons();
      setTimeout(() => {
        btn.innerHTML = originalHTML;
        if (window.lucide) lucide.createIcons();
      }, 2000);
    }).catch(() => {
      shareInput.select();
      document.execCommand('copy');
      alert('Link berhasil disalin ke clipboard!');
    });
  });

  // Auto-start camera in background if supported
  startCamera();
}
