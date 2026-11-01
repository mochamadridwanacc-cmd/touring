/**
 * TouringMate - Application Core Logic
 * PWA & Chrome-optimized touring navigator & plate scanner
 */

// Application State
const state = {
  myProfile: null,
  roomCode: 'TOURING-1',
  mqttClient: null,
  activeCloudRiders: {},
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
  tesseractWorker: null,
  micMode: 'PTT', // 'PTT' | 'ALWAYS_ON' | 'VOX'
  voxThreshold: -35, // dB
  isMutedByHost: false
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
  initCloudMqtt();
  syncWithServer();
  setInterval(syncWithServer, 2000);
});

/* ==========================================================================
   CLOUD REAL-TIME SYNC VIA SECURE WEBSOCKET MQTT (ZERO SERVER / STATIC WEB)
   ========================================================================== */
function initCloudMqtt() {
  if (typeof mqtt === 'undefined') {
    console.warn('MQTT client library not loaded, using fallback HTTP sync');
    return;
  }

  // Check URL query param for room e.g. ?room=BROMO
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('room')) {
    state.roomCode = urlParams.get('room').toUpperCase();
    localStorage.setItem('touring_room', state.roomCode);
  } else {
    const savedRoom = localStorage.getItem('touring_room');
    if (savedRoom) state.roomCode = savedRoom.toUpperCase();
  }

  const cleanRoom = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
  const topicLocation = `touringmate/rooms/${cleanRoom}/loc`;
  const topicControl = `touringmate/rooms/${cleanRoom}/ctl`;
  const topicVoice = `touringmate/rooms/${cleanRoom}/voice`;

  try {
    const clientId = 'tm-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
    state.mqttClient = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
      clientId,
      clean: true,
      connectTimeout: 7000,
      reconnectPeriod: 2500,
      keepalive: 30
    });

    state.mqttClient.on('connect', () => {
      console.log('Connected to Cloud Realtime MQTT!');
      state.mqttClient.subscribe([topicLocation, topicControl, topicVoice], () => {
        const syncInd = document.getElementById('serverSyncIndicator');
        if (syncInd) {
          syncInd.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Cloud Live (${state.roomCode})`;
        }
        // Send initial heartbeat immediately upon connect
        syncWithServer('update');
      });
    });

    state.mqttClient.on('message', (topic, payload) => {
      try {
        const msg = JSON.parse(payload.toString());
        const myId = state.myProfile ? state.myProfile.id : null;

        if (topic.endsWith('/loc')) {
          // Received live location update from another rider
          if (msg && msg.id && msg.id !== myId) {
            msg.lastSeen = Date.now();
            state.activeCloudRiders[msg.id] = msg;
            refreshCloudConvoy();
          }
        } else if (topic.endsWith('/voice')) {
          // Received live walkie-talkie audio from another rider
          if (msg && msg.audio && msg.senderId !== myId) {
            playIncomingVoice(msg.senderName, msg.audio);
          }
        } else if (topic.endsWith('/ctl')) {
          // Received control command from Master
          if (msg.action === 'delete') {
            delete state.activeCloudRiders[msg.targetId];
            state.riders = state.riders.filter(r => r.id !== msg.targetId);
            updateMapMarkers();
            renderRoster();
          } else if (msg.action === 'clear') {
            state.activeCloudRiders = {};
            state.riders = [];
            updateMapMarkers();
            renderRoster();
          } else if (msg.action === 'mute_rider') {
            if (msg.targetId === myId) {
              applyHostMute(!!msg.muted);
            }
            if (state.activeCloudRiders[msg.targetId]) {
              state.activeCloudRiders[msg.targetId].isMutedByHost = !!msg.muted;
              refreshCloudConvoy();
            }
          } else if (msg.action === 'mute_all') {
            if (!state.myProfile?.isMaster) {
              applyHostMute(!!msg.muted);
            }
          }
        }
      } catch (e) {
        console.warn('MQTT parse error:', e);
      }
    });
  } catch (err) {
    console.warn('MQTT connection notice:', err);
  }
}

function switchCloudRoom(newRoomCode) {
  if (!state.mqttClient || !state.mqttClient.connected) {
    state.roomCode = newRoomCode;
    return;
  }
  const cleanOld = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
  const cleanNew = (newRoomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');

  state.mqttClient.unsubscribe([`touringmate/rooms/${cleanOld}/loc`, `touringmate/rooms/${cleanOld}/ctl`, `touringmate/rooms/${cleanOld}/voice`]);
  state.roomCode = cleanNew;
  state.activeCloudRiders = {};
  state.riders = [];
  updateMapMarkers();
  renderRoster();

  state.mqttClient.subscribe([`touringmate/rooms/${cleanNew}/loc`, `touringmate/rooms/${cleanNew}/ctl`, `touringmate/rooms/${cleanNew}/voice`], () => {
    const syncInd = document.getElementById('serverSyncIndicator');
    if (syncInd) {
      syncInd.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Cloud Live (${state.roomCode})`;
    }
    syncWithServer('update');
  });
}

function refreshCloudConvoy() {
  const now = Date.now();
  // Filter out riders inactive for > 90 seconds (unless marked isDummy)
  const validRiders = [];
  Object.keys(state.activeCloudRiders).forEach(id => {
    const r = state.activeCloudRiders[id];
    if (r.isDummy || (now - (r.lastSeen || now)) < 90000) {
      validRiders.push(r);
    } else {
      delete state.activeCloudRiders[id];
    }
  });

  const myId = state.myProfile ? state.myProfile.id : null;
  state.riders = validRiders.filter(r => r.id !== myId);
  updateMapMarkers();
  renderRoster();

  const syncInd = document.getElementById('serverSyncIndicator');
  if (syncInd) {
    const count = state.riders.length + 1;
    syncInd.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Cloud Live (${count} Rider)`;
  }
}

/* ==========================================================================
   1. USER PROFILE, DEVICE ROLE (MASTER / PESERTA) & REALTIME SYNC
   ========================================================================== */
function loadProfile() {
  // 1. Auto-detect and populate Room Code from URL query parameter e.g. ?room=3431
  const urlParams = new URLSearchParams(window.location.search);
  const queryRoom = urlParams.get('room');
  if (queryRoom) {
    state.roomCode = queryRoom.trim().toUpperCase();
    localStorage.setItem('touring_room', state.roomCode);
  } else {
    const savedRoom = localStorage.getItem('touring_room');
    if (savedRoom) state.roomCode = savedRoom.toUpperCase();
  }

  // Pre-fill input in modal
  const roomInput = document.getElementById('inputRoomCode');
  if (roomInput) {
    roomInput.value = state.roomCode || 'TOURING-1';
  }

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

  // Host Mute All controls in drawer
  const hostMicCtrl = document.getElementById('hostMicControls');
  if (hostMicCtrl) {
    if (state.myProfile && state.myProfile.isMaster) {
      hostMicCtrl.classList.remove('hidden');
    } else {
      hostMicCtrl.classList.add('hidden');
    }
  }
}

// Real-time synchronization loop with server & Cloud MQTT
async function syncWithServer(customAction = 'update', extraData = {}) {
  const cleanRoom = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
  const topicLocation = `touringmate/rooms/${cleanRoom}/loc`;
  const topicControl = `touringmate/rooms/${cleanRoom}/ctl`;

  // 1. Broadcast over Cloud MQTT (Works 100% on Static Sites like GitHub Pages!)
  if (state.mqttClient && state.mqttClient.connected) {
    if (customAction === 'update' && state.myProfile) {
      const myData = {
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
      };
      state.mqttClient.publish(topicLocation, JSON.stringify(myData));
    } else if (customAction !== 'update') {
      // Broadcast control command (Master delete, clear, or set dummy)
      state.mqttClient.publish(topicControl, JSON.stringify({
        action: customAction,
        targetId: extraData.targetId || null,
        convoyList: extraData.convoyList || null
      }));
    }
  }

  // 2. Also sync with local Python server if running on localhost / custom backend
  if (location.hostname.endsWith('github.io')) {
    return; // Static GitHub Pages purely uses Cloud MQTT
  }

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
    const riderLat = (rider.lat !== undefined && rider.lat !== null) ? rider.lat : (state.myCoords.lat + (rider.latOffset || 0));
    const riderLng = (rider.lng !== undefined && rider.lng !== null) ? rider.lng : (state.myCoords.lng + (rider.lngOffset || 0));
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
    const rLat = (rider.lat !== undefined && rider.lat !== null) ? rider.lat : (state.myCoords.lat + (rider.latOffset || 0));
    const rLng = (rider.lng !== undefined && rider.lng !== null) ? rider.lng : (state.myCoords.lng + (rider.lngOffset || 0));
    const dist = calculateDistanceMeters(state.myCoords.lat, state.myCoords.lng, rLat, rLng);
    const isAhead = (rider.lat !== undefined && rider.lat !== null) ? (rider.lat >= state.myCoords.lat) : ((rider.latOffset || 0) >= 0);
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
        <div class="flex items-center gap-1.5 flex-shrink-0">
          <div class="text-right">
            <div class="text-base font-black font-mono text-slate-100">${formatDistance(rider.distance)}</div>
            <div>${directionIcon}</div>
          </div>
          ${state.myProfile?.isMaster ? `
            <button class="btn-mute-rider p-1.5 rounded-lg ${rider.isMutedByHost ? 'text-rose-400 bg-rose-500/25 border border-rose-500/40' : 'text-slate-400 hover:text-rose-400 hover:bg-rose-500/10'} transition" data-id="${rider.id}" data-muted="${rider.isMutedByHost ? '1' : '0'}" title="${rider.isMutedByHost ? 'Buka Mic' : 'Matikan Mic Rider'}">
              <i data-lucide="${rider.isMutedByHost ? 'mic-off' : 'mic'}" class="w-4 h-4 pointer-events-none"></i>
            </button>
          ` : ''}
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

let sharedAudioContext = null;

function getSharedAudioContext() {
  if (!sharedAudioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      sharedAudioContext = new AudioContextClass();
    }
  }
  return sharedAudioContext;
}

function unlockGlobalAudio() {
  const ctx = getSharedAudioContext();
  if (ctx) {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    try {
      const silentBuf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = silentBuf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) {}
  }
  if ('speechSynthesis' in window) {
    try {
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    } catch (e) {}
  }
}

function initAudioContextUnlock() {
  ['touchstart', 'touchend', 'click', 'keydown'].forEach(evt => {
    window.addEventListener(evt, unlockGlobalAudio, { passive: true });
  });
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
      if (document.getElementById('inputRoomCode')) {
        document.getElementById('inputRoomCode').value = state.roomCode || 'TOURING-1';
      }
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
    const roomInput = document.getElementById('inputRoomCode');
    const newRoom = roomInput ? roomInput.value.trim().toUpperCase() : 'TOURING-1';
    if (newRoom && newRoom !== state.roomCode) {
      localStorage.setItem('touring_room', newRoom);
      switchCloudRoom(newRoom);
    } else {
      localStorage.setItem('touring_room', state.roomCode);
    }
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
    // Current URL with Room parameter (e.g. https://domain.com/?room=TOURING-1)
    const base = window.location.origin + window.location.pathname;
    const joinUrl = `${base}?room=${encodeURIComponent(state.roomCode || 'TOURING-1')}`;
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

  // ==========================================================================
  // ADVANCED VOICE INTERCOM (UNIVERSAL 16kHz WAV + iOS AUTOPLAY UNLOCK)
  // ==========================================================================
  let isRecordingPtt = false;
  let persistentMicStream = null;
  let pttSource = null;
  let pttProcessor = null;
  let recordedPcmBuffers = [];

  let voxAudioContext = null;
  let voxAnalyser = null;
  let voxSource = null;
  let voxStream = null;
  let voxAnimFrame = null;
  let isVoxTransmitting = false;
  let voxSilenceTimer = null;
  let alwaysOnInterval = null;

  // Restore saved mic settings
  const savedMicMode = localStorage.getItem('touring_mic_mode');
  if (savedMicMode) state.micMode = savedMicMode;
  const savedVoxDb = localStorage.getItem('touring_vox_db');
  if (savedVoxDb) state.voxThreshold = parseInt(savedVoxDb);

  // Update VOX slider and text
  const voxSlider = document.getElementById('voxThresholdSlider');
  const voxDbText = document.getElementById('voxDbValueText');
  const voxThreshLine = document.getElementById('voxThresholdLine');
  if (voxSlider) {
    voxSlider.value = state.voxThreshold;
    if (voxDbText) voxDbText.textContent = `${state.voxThreshold} dB`;
    if (voxThreshLine) {
      const pct = Math.round(((state.voxThreshold + 60) / 45) * 100);
      voxThreshLine.style.left = `${Math.max(5, Math.min(95, pct))}%`;
    }
  }

  // Set radio choice in modal
  if (document.getElementById('micMode' + (state.micMode === 'ALWAYS_ON' ? 'AlwaysOn' : (state.micMode === 'VOX' ? 'Vox' : 'Ptt')))) {
    document.getElementById('micMode' + (state.micMode === 'ALWAYS_ON' ? 'AlwaysOn' : (state.micMode === 'VOX' ? 'Vox' : 'Ptt'))).checked = true;
  }

  updatePttButtonUI();

  // Modal open/close
  const micModal = document.getElementById('micSettingsModal');
  document.getElementById('btnOpenMicModal').addEventListener('click', () => {
    micModal.classList.remove('hidden');
    startVoxEngine(); // Start audio context for live meter preview
  });
  document.getElementById('btnCloseMicModal').addEventListener('click', () => {
    micModal.classList.add('hidden');
  });

  // Slider change
  if (voxSlider) {
    voxSlider.addEventListener('input', (e) => {
      state.voxThreshold = parseInt(e.target.value);
      if (voxDbText) voxDbText.textContent = `${state.voxThreshold} dB`;
      localStorage.setItem('touring_vox_db', state.voxThreshold);
      if (voxThreshLine) {
        const pct = Math.round(((state.voxThreshold + 60) / 45) * 100);
        voxThreshLine.style.left = `${Math.max(5, Math.min(95, pct))}%`;
      }
    });
  }

  // Save Mic Settings button
  document.getElementById('btnSaveMicSettings').addEventListener('click', () => {
    const selectedMode = document.querySelector('input[name="micModeRadio"]:checked')?.value || 'PTT';
    setMicMode(selectedMode);
    micModal.classList.add('hidden');
  });

  function setMicMode(newMode) {
    state.micMode = newMode;
    localStorage.setItem('touring_mic_mode', newMode);

    // Stop previous modes
    clearInterval(alwaysOnInterval);
    if (isRecordingPtt) stopPttRecording();

    if (state.micMode === 'ALWAYS_ON') {
      startAlwaysOnMode();
    } else if (state.micMode === 'VOX') {
      startVoxEngine();
    }

    updatePttButtonUI();
  }

  function updatePttButtonUI() {
    const pttBtn = document.getElementById('btnPtt');
    const pttLabel = document.getElementById('pttLabel');
    if (!pttBtn || !pttLabel) return;

    if (state.isMutedByHost) {
      pttBtn.className = 'w-16 h-16 rounded-full bg-rose-950/80 border-2 border-rose-500 text-rose-400 shadow-2xl flex flex-col items-center justify-center transition-all opacity-80 cursor-not-allowed select-none';
      pttLabel.textContent = 'MUTED';
      return;
    }

    if (isRecordingPtt) {
      pttBtn.className = 'w-16 h-16 rounded-full bg-rose-600 border-4 border-rose-300 text-white shadow-2xl flex flex-col items-center justify-center transition-all transform scale-110 select-none animate-pulse';
      pttLabel.textContent = 'REC...';
    } else if (state.micMode === 'ALWAYS_ON') {
      pttBtn.className = 'w-16 h-16 rounded-full bg-emerald-600 border-2 border-emerald-300 text-white shadow-2xl flex flex-col items-center justify-center transition-all select-none animate-pulse';
      pttLabel.textContent = 'OPEN MIC';
    } else if (state.micMode === 'VOX') {
      pttBtn.className = 'w-16 h-16 rounded-full bg-cyan-950/90 border-2 border-cyan-400 text-cyan-300 shadow-2xl flex flex-col items-center justify-center transition-all select-none';
      pttLabel.textContent = 'VOX AUTO';
    } else {
      // PTT Default
      pttBtn.className = 'w-16 h-16 rounded-full bg-slate-900/95 hover:bg-slate-800 border-2 border-emerald-500/80 text-emerald-400 shadow-2xl flex flex-col items-center justify-center transition-all transform active:scale-95 group focus:outline-none select-none';
      pttLabel.textContent = 'PTT';
    }
  }

  function showPttToast(text, duration = 1500) {
    const ind = document.getElementById('pttStatusIndicator');
    const txt = document.getElementById('pttStatusText');
    if (!ind || !txt) return;
    txt.textContent = text;
    ind.classList.remove('hidden');
    if (duration > 0) {
      setTimeout(() => {
        if (!isRecordingPtt) ind.classList.add('hidden');
      }, duration);
    }
  }

  // --- AUDIO UTILITIES: 16-BIT 16kHz MONO WAV ENCODER ---
  function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate || inputSampleRate < outputSampleRate) {
      return buffer;
    }
    const ratio = inputSampleRate / outputSampleRate;
    const newLen = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLen);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? (accum / count) : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  function encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 1, true); // Mono channel
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // 16-bit
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  function base64ToArrayBuffer(base64) {
    const commaIdx = base64.indexOf(',');
    const cleanBase64 = commaIdx >= 0 ? base64.substring(commaIdx + 1) : base64;
    const binaryString = window.atob(cleanBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function playRadioChirp(ctx) {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.06);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.07);
    } catch (e) {}
  }

  // --- PERSISTENT MICROPHONE ACQUISITION ---
  async function getMicStream() {
    if (persistentMicStream && persistentMicStream.active) {
      return persistentMicStream;
    }
    try {
      persistentMicStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      return persistentMicStream;
    } catch (e) {
      // Fallback for strict mobile devices
      persistentMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return persistentMicStream;
    }
  }

  // VOX Engine: decibel detection and auto-transmission
  async function startVoxEngine() {
    if (voxStream) return;
    try {
      voxStream = await getMicStream();
      voxAudioContext = getSharedAudioContext();
      if (voxAudioContext && voxAudioContext.state === 'suspended') {
        try { await voxAudioContext.resume(); } catch (e) {}
      }
      voxSource = voxAudioContext.createMediaStreamSource(voxStream);
      voxAnalyser = voxAudioContext.createAnalyser();
      voxAnalyser.fftSize = 512;
      voxAnalyser.smoothingTimeConstant = 0.3;
      voxSource.connect(voxAnalyser);

      const dataArray = new Uint8Array(voxAnalyser.frequencyBinCount);

      function checkAudioLevel() {
        if (!voxAnalyser) return;
        voxAnalyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const db = rms > 0 ? Math.round(20 * Math.log10(rms / 255)) : -90;

        // Update live meter bar in settings modal
        const liveBar = document.getElementById('voxLiveBar');
        const statusEl = document.getElementById('voxMeterStatus');
        if (liveBar) {
          const barPct = Math.round(((Math.max(-60, Math.min(0, db)) + 60) / 60) * 100);
          liveBar.style.width = `${barPct}%`;
          if (db >= state.voxThreshold) {
            liveBar.className = 'bg-rose-500 h-2 transition-all duration-75';
            if (statusEl) {
              statusEl.textContent = 'Bicara (Aktif)';
              statusEl.className = 'font-bold text-rose-400';
            }
          } else {
            liveBar.className = 'bg-emerald-500 h-2 transition-all duration-75';
            if (statusEl) {
              statusEl.textContent = 'Hening';
              statusEl.className = 'font-bold text-slate-500';
            }
          }
        }

        // Trigger VOX Auto transmit
        if (state.micMode === 'VOX' && !state.isMutedByHost) {
          if (db >= state.voxThreshold) {
            clearTimeout(voxSilenceTimer);
            if (!isVoxTransmitting) {
              isVoxTransmitting = true;
              startPttRecording(voxStream);
            }
          } else if (isVoxTransmitting) {
            // Keep sending for 850ms hangover time
            if (!voxSilenceTimer) {
              voxSilenceTimer = setTimeout(() => {
                isVoxTransmitting = false;
                stopPttRecording();
                voxSilenceTimer = null;
              }, 850);
            }
          }
        }

        voxAnimFrame = requestAnimationFrame(checkAudioLevel);
      }

      checkAudioLevel();
    } catch (err) {
      console.warn('Microphone access for VOX denied:', err);
    }
  }

  // Always On Mode: continuous streaming chunks of 2.5 seconds
  function startAlwaysOnMode() {
    if (state.isMutedByHost) return;
    startPttRecording();
    clearInterval(alwaysOnInterval);
    alwaysOnInterval = setInterval(() => {
      if (state.micMode === 'ALWAYS_ON' && !state.isMutedByHost && isRecordingPtt) {
        flushPcmChunksAndBroadcast();
      }
    }, 2500);
  }

  // Core Audio Recording using Web Audio ScriptProcessorNode (Cross-browser compatible iOS + Android + Desktop)
  async function startPttRecording(existingStream = null) {
    if (isRecordingPtt || state.isMutedByHost) return;
    isRecordingPtt = true;
    updatePttButtonUI();
    showPttToast('🔴 MEREKAM...', 0);

    const ctx = getSharedAudioContext();
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) {}
    }

    try {
      const stream = existingStream || await getMicStream();
      if (!isRecordingPtt) {
        // User already released button
        return;
      }

      if (pttSource) {
        try { pttSource.disconnect(); } catch (e) {}
      }
      if (pttProcessor) {
        try { pttProcessor.disconnect(); } catch (e) {}
      }

      pttSource = ctx.createMediaStreamSource(stream);
      pttProcessor = ctx.createScriptProcessor(4096, 1, 1);
      recordedPcmBuffers = [];

      pttProcessor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const outputData = e.outputBuffer.getChannelData(0);
        outputData.fill(0); // Mute playback to prevent local speaker feedback

        if (isRecordingPtt) {
          recordedPcmBuffers.push(new Float32Array(inputData));
        }
      };

      pttSource.connect(pttProcessor);
      pttProcessor.connect(ctx.destination);

    } catch (err) {
      console.warn('Microphone access denied:', err);
      isRecordingPtt = false;
      updatePttButtonUI();
      showPttToast('⚠️ Mic Ditolak');
      alert('Izin mikrofon diperlukan untuk interkom suara.\nKlik "Izinkan / Allow" mikrofon di browser.');
    }
  }

  function flushPcmChunksAndBroadcast(onSuccessCallback = null) {
    if (!recordedPcmBuffers || recordedPcmBuffers.length === 0) return;
    const chunksToProcess = recordedPcmBuffers;
    recordedPcmBuffers = [];

    const ctx = getSharedAudioContext();
    const inputSampleRate = (ctx && ctx.sampleRate) ? ctx.sampleRate : 44100;
    const targetSampleRate = 16000;

    let totalLength = 0;
    for (let i = 0; i < chunksToProcess.length; i++) totalLength += chunksToProcess[i].length;
    // Discard tiny noise clicks (<100ms)
    if (totalLength < inputSampleRate * 0.1) return;

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (let i = 0; i < chunksToProcess.length; i++) {
      merged.set(chunksToProcess[i], offset);
      offset += chunksToProcess[i].length;
    }

    const downsampled = downsampleBuffer(merged, inputSampleRate, targetSampleRate);
    const wavBlob = encodeWAV(downsampled, targetSampleRate);

    const reader = new FileReader();
    reader.onloadend = () => {
      broadcastVoice(reader.result);
      if (onSuccessCallback) onSuccessCallback(reader.result);
    };
    reader.readAsDataURL(wavBlob);
  }

  function stopPttRecording() {
    if (!isRecordingPtt) return;
    isRecordingPtt = false;
    updatePttButtonUI();
    showPttToast('📤 Mengirim Suara...', 1200);

    setTimeout(() => {
      flushPcmChunksAndBroadcast(() => {
        showPttToast('✅ Terkirim!', 1500);
      });

      if (pttProcessor) {
        try {
          pttProcessor.disconnect();
          if (pttSource) pttSource.disconnect();
        } catch (e) {}
        pttProcessor = null;
        pttSource = null;
      }
    }, 80);
  }

  function broadcastVoice(audioDataUrl) {
    if (!state.mqttClient || !state.mqttClient.connected || state.isMutedByHost) return;
    const cleanRoom = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
    const topicVoice = `touringmate/rooms/${cleanRoom}/voice`;

    const payload = {
      senderId: state.myProfile ? state.myProfile.id : 'unknown',
      senderName: state.myProfile ? state.myProfile.name : 'Rider',
      audio: audioDataUrl,
      timestamp: Date.now()
    };

    state.mqttClient.publish(topicVoice, JSON.stringify(payload));
  }

  // --- INCOMING VOICE QUEUE & UNIVERSAL PLAYBACK ---
  const incomingVoiceQueue = [];
  let isVoicePlaying = false;

  function playIncomingVoice(speakerName, audioDataUrl) {
    incomingVoiceQueue.push({ speakerName, audioDataUrl });
    if (!isVoicePlaying) {
      processIncomingVoiceQueue();
    }
  }

  async function processIncomingVoiceQueue() {
    if (incomingVoiceQueue.length === 0) {
      isVoicePlaying = false;
      const toast = document.getElementById('incomingVoiceToast');
      if (toast) toast.classList.add('hidden');
      return;
    }

    isVoicePlaying = true;
    const item = incomingVoiceQueue.shift();
    const ctx = getSharedAudioContext();

    try {
      if (ctx && ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (e) {}
      }

      if (ctx) playRadioChirp(ctx);

      const arrayBuffer = base64ToArrayBuffer(item.audioDataUrl);

      ctx.decodeAudioData(arrayBuffer, (audioBuffer) => {
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        const toast = document.getElementById('incomingVoiceToast');
        const speakerEl = document.getElementById('incomingVoiceSpeaker');
        if (speakerEl) speakerEl.textContent = `${item.speakerName} bicara...`;
        if (toast) toast.classList.remove('hidden');

        source.onended = () => {
          setTimeout(processIncomingVoiceQueue, 100);
        };

        source.start(0);
      }, (err) => {
        console.warn('decodeAudioData error, attempting fallback:', err);
        const fallbackAudio = new Audio(item.audioDataUrl);
        fallbackAudio.onended = () => setTimeout(processIncomingVoiceQueue, 100);
        fallbackAudio.onerror = () => setTimeout(processIncomingVoiceQueue, 100);
        fallbackAudio.play().catch(() => setTimeout(processIncomingVoiceQueue, 100));
      });

    } catch (err) {
      console.warn('Voice play queue error:', err);
      setTimeout(processIncomingVoiceQueue, 100);
    }
  }

  // Loopback Self-Test (Rekam & Putar Suara Sendiri 3 Detik)
  const btnLoopback = document.getElementById('btnTestMicLoopback');
  const txtLoopback = document.getElementById('testMicLoopbackText');
  let isLoopbackRunning = false;
  if (btnLoopback) {
    btnLoopback.addEventListener('click', async () => {
      if (isLoopbackRunning) return;
      isLoopbackRunning = true;
      unlockGlobalAudio();

      try {
        txtLoopback.textContent = 'Merekam... Bicara sekarang! (3)';
        btnLoopback.className = 'w-full py-2 bg-rose-600 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 transition animate-pulse';

        await startPttRecording();

        let count = 3;
        const countdownTimer = setInterval(() => {
          count--;
          if (count > 0) {
            txtLoopback.textContent = `Merekam... Bicara sekarang! (${count})`;
          } else {
            clearInterval(countdownTimer);
            txtLoopback.textContent = 'Memutar suara rekaman Anda...';
            btnLoopback.className = 'w-full py-2 bg-emerald-600 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 transition';

            // Collect buffers
            isRecordingPtt = false;
            updatePttButtonUI();

            setTimeout(() => {
              if (recordedPcmBuffers.length > 0) {
                const chunks = recordedPcmBuffers;
                recordedPcmBuffers = [];
                const ctx = getSharedAudioContext();
                const inputSampleRate = ctx ? ctx.sampleRate : 44100;
                let totalLength = 0;
                for (let i = 0; i < chunks.length; i++) totalLength += chunks[i].length;
                const merged = new Float32Array(totalLength);
                let offset = 0;
                for (let i = 0; i < chunks.length; i++) {
                  merged.set(chunks[i], offset);
                  offset += chunks[i].length;
                }
                const downsampled = downsampleBuffer(merged, inputSampleRate, 16000);
                const wavBlob = encodeWAV(downsampled, 16000);
                const reader = new FileReader();
                reader.onloadend = () => {
                  playIncomingVoice('Tes Suara Anda Sendiri', reader.result);
                  setTimeout(() => {
                    isLoopbackRunning = false;
                    txtLoopback.textContent = 'Tes Rekam & Putar Suara Saya (3 dtk)';
                    btnLoopback.className = 'w-full py-2 bg-slate-800 hover:bg-slate-700 text-cyan-400 font-semibold border border-cyan-500/30 rounded-xl text-xs flex items-center justify-center gap-1.5 transition';
                  }, 3500);
                };
                reader.readAsDataURL(wavBlob);
              } else {
                alert('Tidak ada suara terdeteksi. Pastikan mikrofon diizinkan!');
                isLoopbackRunning = false;
                txtLoopback.textContent = 'Tes Rekam & Putar Suara Saya (3 dtk)';
                btnLoopback.className = 'w-full py-2 bg-slate-800 hover:bg-slate-700 text-cyan-400 font-semibold border border-cyan-500/30 rounded-xl text-xs flex items-center justify-center gap-1.5 transition';
              }
            }, 100);
          }
        }, 1000);

      } catch (err) {
        alert('Gagal tes mic: ' + err.message);
        isLoopbackRunning = false;
        txtLoopback.textContent = 'Tes Rekam & Putar Suara Saya (3 dtk)';
        btnLoopback.className = 'w-full py-2 bg-slate-800 hover:bg-slate-700 text-cyan-400 font-semibold border border-cyan-500/30 rounded-xl text-xs flex items-center justify-center gap-1.5 transition';
      }
    });
  }

  // Host Mute application
  function applyHostMute(isMuted) {
    state.isMutedByHost = isMuted;
    if (isMuted) {
      clearInterval(alwaysOnInterval);
      stopPttRecording();
      alert('Mikrofon Anda dimatikan oleh Road Captain / Host.');
    } else {
      alert('Mikrofon Anda telah diaktifkan kembali oleh Road Captain / Host.');
      if (state.micMode === 'ALWAYS_ON') startAlwaysOnMode();
    }
    updatePttButtonUI();
  }

  // PTT Button Event Listeners: Supports both Tap to toggle & Hold to talk
  const pttButton = document.getElementById('btnPtt');
  let holdTimeout = null;
  let isHoldActive = false;

  if (pttButton) {
    // Touch (Mobile iOS & Android)
    pttButton.addEventListener('touchstart', (e) => {
      e.preventDefault();
      unlockGlobalAudio();
      if (state.isMutedByHost) return;
      if (state.micMode === 'ALWAYS_ON') {
        if (isRecordingPtt) stopPttRecording(); else startPttRecording();
        return;
      }
      isHoldActive = false;
      holdTimeout = setTimeout(() => {
        isHoldActive = true;
        startPttRecording();
      }, 250);
    }, { passive: false });

    pttButton.addEventListener('touchend', (e) => {
      e.preventDefault();
      clearTimeout(holdTimeout);
      if (state.isMutedByHost || state.micMode === 'ALWAYS_ON') return;
      if (isHoldActive) {
        stopPttRecording();
      } else {
        // Single tap toggle
        if (isRecordingPtt) stopPttRecording(); else startPttRecording();
      }
      isHoldActive = false;
    }, { passive: false });

    // Click/Mouse (Desktop)
    pttButton.addEventListener('mousedown', (e) => {
      e.preventDefault();
      unlockGlobalAudio();
      if (state.isMutedByHost) return;
      if (state.micMode === 'ALWAYS_ON') {
        if (isRecordingPtt) stopPttRecording(); else startPttRecording();
        return;
      }
      isHoldActive = false;
      holdTimeout = setTimeout(() => {
        isHoldActive = true;
        startPttRecording();
      }, 250);
    });

    pttButton.addEventListener('mouseup', (e) => {
      e.preventDefault();
      clearTimeout(holdTimeout);
      if (state.isMutedByHost || state.micMode === 'ALWAYS_ON') return;
      if (isHoldActive) {
        stopPttRecording();
      } else {
        if (isRecordingPtt) stopPttRecording(); else startPttRecording();
      }
      isHoldActive = false;
    });

    pttButton.addEventListener('mouseleave', () => {
      clearTimeout(holdTimeout);
      if (isHoldActive) stopPttRecording();
      isHoldActive = false;
    });
  }

  // Host Mute Roster Events
  document.getElementById('riderListContainer').addEventListener('click', (e) => {
    const muteBtn = e.target.closest('.btn-mute-rider');
    if (muteBtn) {
      const riderId = muteBtn.dataset.id;
      const currentMuted = muteBtn.dataset.muted === '1';
      const targetRider = state.riders.find(r => r.id === riderId);
      const name = targetRider ? targetRider.name : 'Rider';

      const newMuted = !currentMuted;
      if (state.mqttClient && state.mqttClient.connected) {
        const cleanRoom = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
        state.mqttClient.publish(`touringmate/rooms/${cleanRoom}/ctl`, JSON.stringify({
          action: 'mute_rider',
          targetId: riderId,
          muted: newMuted
        }));
      }
      if (targetRider) targetRider.isMutedByHost = newMuted;
      renderRoster();
      alert(`Berhasil ${newMuted ? 'mematikan' : 'mengaktifkan'} mic untuk ${name}!`);
    }
  });

  // Host Mute All Button
  const muteAllBtn = document.getElementById('btnHostToggleMuteAll');
  let isAllMuted = false;
  if (muteAllBtn) {
    muteAllBtn.addEventListener('click', () => {
      isAllMuted = !isAllMuted;
      if (state.mqttClient && state.mqttClient.connected) {
        const cleanRoom = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
        state.mqttClient.publish(`touringmate/rooms/${cleanRoom}/ctl`, JSON.stringify({
          action: 'mute_all',
          muted: isAllMuted
        }));
      }
      muteAllBtn.innerHTML = isAllMuted 
        ? '<i data-lucide="mic" class="w-3.5 h-3.5"></i> Buka Mic Semua Peserta (Unmute All)'
        : '<i data-lucide="mic-off" class="w-3.5 h-3.5"></i> Matikan Semua Mic Peserta (Mute All)';
      if (window.lucide) lucide.createIcons();
      alert(`Semua mic peserta telah ${isAllMuted ? 'dimatikan' : 'diaktifkan kembali'}!`);
    });
  }

  // Auto-start VOX engine if saved
  if (state.micMode === 'VOX') startVoxEngine();
  else if (state.micMode === 'ALWAYS_ON') startAlwaysOnMode();

  // Auto-start camera in background if supported
  startCamera();
}
