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
  isSimulationActive: false,
  simInterval: null,
  micMode: 'PTT', // 'PTT' | 'ALWAYS_ON' | 'VOX'
  voxThreshold: -35, // dB
  isMutedByHost: false,
  chatHistory: [],
  unreadChatCount: 0,
  mqttClientId: 'tm-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9),
  mqttBrokerName: '',
  hasFirstGpsLock: false,
  isAutoFollowMap: true,
  lastPingRtt: null,
  isAlertNotificationMuted: localStorage.getItem('touring_alert_muted') !== 'false' // Default true (Senyap)
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

  try { loadProfile(); } catch (e) { console.error('Error in loadProfile:', e); }
  try { initMap(); } catch (e) { console.error('Error in initMap:', e); }
  try { updateMapMarkers(); } catch (e) { console.error('Error in updateMapMarkers:', e); }
  try { renderRoster(); } catch (e) { console.error('Error in renderRoster:', e); }
  try { initGeolocation(); } catch (e) { console.error('Error in initGeolocation:', e); }
  try { initWakeLock(); } catch (e) { console.error('Error in initWakeLock:', e); }
  try { initEventListeners(); } catch (e) { console.error('Error in initEventListeners:', e); }
  try { initAudioContextUnlock(); } catch (e) { console.error('Error in initAudioContextUnlock:', e); }

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
   CLOUD REAL-TIME SYNC VIA SECURE WEBSOCKET MQTT (MULTI-BROKER FAILOVER)
   ========================================================================== */
const CLOUD_BROKERS = [
  { name: 'EMQX Public', url: 'wss://broker.emqx.io:8084/mqtt', opts: {} },
  { name: 'HiveMQ Public', url: 'wss://broker.hivemq.com:8884/mqtt', opts: {} },
  { name: 'Shiftr SSL (Port 443)', url: 'wss://public.cloud.shiftr.io:443/mqtt', opts: { username: 'public', password: 'public' } }
];
let currentBrokerIdx = 0;
let mqttConnectTimeoutTimer = null;

function updateMqttStatusUI(status, detail) {
  const statusEl = document.getElementById('chatMqttStatusText');
  const syncInd = document.getElementById('serverSyncIndicator');
  const modalBadge = document.getElementById('chatRoomBadge');

  if (modalBadge) {
    modalBadge.textContent = `Room: ${state.roomCode || 'TOURING-1'}`;
  }

  if (status === 'connected') {
    const pingStr = state.lastPingRtt !== null ? ` • ${state.lastPingRtt}ms` : '';
    if (statusEl) {
      statusEl.className = 'text-[10px] text-emerald-400 flex items-center gap-1 font-mono';
      statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Cloud Terhubung (${detail || (state.mqttBrokerName + pingStr) || 'Live'})`;
    }
    if (syncInd) {
      const pingBadge = state.lastPingRtt !== null ? `${state.lastPingRtt}ms` : state.roomCode;
      syncInd.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Cloud Live (${pingBadge})`;
    }
  } else if (status === 'connecting') {
    if (statusEl) {
      statusEl.className = 'text-[10px] text-amber-400 flex items-center gap-1 font-mono';
      statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span> Menghubungkan ke ${detail || 'Cloud Broker'}...`;
    }
    if (syncInd) {
      syncInd.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span> Menghubungkan...`;
    }
  } else {
    if (statusEl) {
      statusEl.className = 'text-[10px] text-rose-400 flex items-center gap-1 font-mono';
      statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Terputus (${detail || 'Offline'})`;
    }
    if (syncInd) {
      syncInd.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Offline`;
    }
  }
}

function initCloudMqtt() {
  if (typeof mqtt === 'undefined') {
    console.warn('MQTT library not yet loaded, waiting...');
    updateMqttStatusUI('connecting', 'Memuat Library');
    let retries = 0;
    const checkTimer = setInterval(() => {
      retries++;
      if (typeof mqtt !== 'undefined') {
        clearInterval(checkTimer);
        initCloudMqtt();
      } else if (retries >= 15) {
        clearInterval(checkTimer);
        updateMqttStatusUI('offline', 'Library Gagal Dimuat');
        console.error('MQTT.js failed to load after retries');
      }
    }, 400);
    return;
  }

  // Check URL query param for room e.g. ?room=3431
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('room')) {
    state.roomCode = urlParams.get('room').toUpperCase();
    localStorage.setItem('touring_room', state.roomCode);
  } else {
    const savedRoom = localStorage.getItem('touring_room');
    if (savedRoom) state.roomCode = savedRoom.toUpperCase();
  }

  if (!state.mqttClientId) {
    state.mqttClientId = 'tm-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
  }

  const broker = CLOUD_BROKERS[currentBrokerIdx];
  state.mqttBrokerName = broker.name;
  console.log(`[MQTT] Connecting to ${broker.name} (${broker.url}) as ${state.mqttClientId}...`);
  updateMqttStatusUI('connecting', broker.name);

  if (state.mqttClient) {
    try { state.mqttClient.end(true); } catch (e) {}
    state.mqttClient = null;
  }

  const cleanRoom = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
  const topicLocation = `touringmate/rooms/${cleanRoom}/loc`;
  const topicControl = `touringmate/rooms/${cleanRoom}/ctl`;
  const topicVoice = `touringmate/rooms/${cleanRoom}/voice`;
  const topicChat = `touringmate/rooms/${cleanRoom}/chat`;
  const topicPing = `touringmate/rooms/${cleanRoom}/ping`;

  try {
    const client = mqtt.connect(broker.url, {
      clientId: state.mqttClientId,
      clean: true,
      connectTimeout: 7000,
      reconnectPeriod: 3000,
      keepalive: 30,
      ...broker.opts
    });
    state.mqttClient = client;

    // Timeout fallback if connection hangs
    if (mqttConnectTimeoutTimer) clearTimeout(mqttConnectTimeoutTimer);
    mqttConnectTimeoutTimer = setTimeout(() => {
      if (state.mqttClient === client && !client.connected) {
        console.warn(`[MQTT] Timeout connecting to ${broker.name}, trying fallback...`);
        tryNextBroker();
      }
    }, 8000);

    client.on('connect', () => {
      if (mqttConnectTimeoutTimer) clearTimeout(mqttConnectTimeoutTimer);
      console.log(`[MQTT] Connected successfully to ${broker.name}!`);
      updateMqttStatusUI('connected', broker.name);

      client.subscribe([topicLocation, topicControl, topicVoice, topicChat, topicPing], (err) => {
        if (err) {
          console.error('[MQTT] Subscription error:', err);
        } else {
          console.log('[MQTT] Subscribed to room topics for:', cleanRoom);
          syncWithServer('update');
          // Auto ping cloud langsung saat aplikasi dibuka (maksimal 5x, lalu tunggu 30 detik)
          setTimeout(() => {
            startAutoPingCycle();
          }, 350);
        }
      });
    });

    client.on('reconnect', () => {
      console.log(`[MQTT] Reconnecting to ${broker.name}...`);
      updateMqttStatusUI('connecting', broker.name);
    });

    client.on('offline', () => {
      console.warn(`[MQTT] Client went offline`);
      updateMqttStatusUI('offline', 'Offline');
    });

    client.on('error', (err) => {
      console.warn(`[MQTT] Error on ${broker.name}:`, err.message || err);
      if (!client.connected) {
        tryNextBroker();
      }
    });

    client.on('message', (topic, payload) => {
      try {
        let textPayload = '';
        if (typeof payload === 'string') {
          textPayload = payload;
        } else if (window.TextDecoder) {
          textPayload = new TextDecoder('utf-8').decode(payload);
        } else {
          textPayload = payload.toString();
        }

        const msg = JSON.parse(textPayload);
        const myId = state.myProfile ? state.myProfile.id : null;

        // Ignore self-broadcasts using guaranteed unique clientId or profile id
        const isSelf = (msg.senderClientId && msg.senderClientId === state.mqttClientId) ||
                       (msg.senderId && myId && msg.senderId === myId) ||
                       (msg.id && myId && msg.id === myId);

        const appendChatFn = window.appendChatMessage || (typeof appendChatMessage === 'function' ? appendChatMessage : null);
        const showToastFn = window.showIncomingTextToast || (typeof showIncomingTextToast === 'function' ? showIncomingTextToast : null);
        const playVoiceFn = window.playIncomingVoice || (typeof playIncomingVoice === 'function' ? playIncomingVoice : null);
        const applyMuteFn = window.applyHostMute || (typeof applyHostMute === 'function' ? applyHostMute : null);

        if (topic.endsWith('/loc')) {
          if (msg && msg.id && !isSelf) {
            msg.lastSeen = Date.now();
            state.activeCloudRiders[msg.id] = msg;
            refreshCloudConvoy();
          }
        } else if (topic.endsWith('/chat')) {
          console.log('[MQTT Chat] Inbound text message:', msg, 'isSelf:', isSelf);
          if (msg && msg.text && !isSelf) {
            if (appendChatFn) {
              appendChatFn({
                id: 'chat-' + Date.now(),
                type: 'chat_in',
                senderName: msg.senderName || 'Rider',
                text: msg.text,
                time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              });
            }
            if (showToastFn) {
              showToastFn(msg.senderName || 'Rider', msg.text);
            }
          }
        } else if (topic.endsWith('/voice')) {
          console.log('[MQTT Voice] Inbound audio message from:', msg.senderName, 'isSelf:', isSelf);
          if (msg && msg.audio && !isSelf) {
            const sizeKB = Math.round(msg.audio.length * 0.75 / 1024);
            if (appendChatFn) {
              appendChatFn({
                id: 'voice-' + Date.now(),
                type: 'voice_in',
                senderName: msg.senderName || 'Rider',
                sizeKB,
                audio: msg.audio,
                time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              });
            }
            if (playVoiceFn) {
              playVoiceFn(msg.senderName || 'Rider', msg.audio);
            }
          }
        } else if (topic.endsWith('/ping')) {
          console.log('[MQTT Ping] Inbound ping:', msg);
          if (msg && msg.pingNonce) {
            if (msg.senderClientId === state.mqttClientId && state.pendingPing && state.pendingPing.nonce === msg.pingNonce) {
              const rtt = Date.now() - state.pendingPing.startTime;
              const wasAuto = state.pendingPing.isAuto;
              state.pendingPing = null;
              state.lastPingRtt = rtt;

              updateMqttStatusUI('connected', `${rtt}ms • ${state.mqttBrokerName}`);

              if (!wasAuto) {
                alert(`⚡ Ping Berhasil!\nBroker: ${state.mqttBrokerName}\nLatency respon: ~${rtt} ms\nRoom: ${state.roomCode}`);
              } else {
                console.log(`[MQTT Auto-Ping] Latency: ${rtt} ms`);
              }
            } else if (msg.senderClientId !== state.mqttClientId) {
              if (showToastFn) {
                showToastFn(msg.senderName || 'Rider', `⚡ Mengirim Ping Koneksi (${msg.senderName})!`);
              }
            }
          }
        } else if (topic.endsWith('/ctl')) {
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
            if (msg.targetId === myId && applyMuteFn) {
              applyMuteFn(!!msg.muted);
            }
            if (state.activeCloudRiders[msg.targetId]) {
              state.activeCloudRiders[msg.targetId].isMutedByHost = !!msg.muted;
              refreshCloudConvoy();
            }
          } else if (msg.action === 'mute_all') {
            if (!state.myProfile?.isMaster && applyMuteFn) {
              applyMuteFn(!!msg.muted);
            }
          }
        }
      } catch (e) {
        console.error('[MQTT Message Handler Error]:', e);
      }
    });
  } catch (err) {
    console.warn('MQTT connection notice:', err);
    tryNextBroker();
  }
}

function tryNextBroker() {
  currentBrokerIdx = (currentBrokerIdx + 1) % CLOUD_BROKERS.length;
  console.log(`[MQTT] Switching to broker index ${currentBrokerIdx}: ${CLOUD_BROKERS[currentBrokerIdx].name}`);
  setTimeout(() => {
    initCloudMqtt();
  }, 1000);
}

function switchCloudRoom(newRoomCode) {
  const cleanOld = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
  const cleanNew = (newRoomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');

  state.roomCode = cleanNew;
  updateBrowserUrlWithRoom(cleanNew);
  state.activeCloudRiders = {};
  state.riders = [];
  updateMapMarkers();
  renderRoster();

  if (!state.mqttClient || !state.mqttClient.connected) {
    initCloudMqtt();
    return;
  }

  state.mqttClient.unsubscribe([
    `touringmate/rooms/${cleanOld}/loc`,
    `touringmate/rooms/${cleanOld}/ctl`,
    `touringmate/rooms/${cleanOld}/voice`,
    `touringmate/rooms/${cleanOld}/chat`,
    `touringmate/rooms/${cleanOld}/ping`
  ]);

  state.mqttClient.subscribe([
    `touringmate/rooms/${cleanNew}/loc`,
    `touringmate/rooms/${cleanNew}/ctl`,
    `touringmate/rooms/${cleanNew}/voice`,
    `touringmate/rooms/${cleanNew}/chat`,
    `touringmate/rooms/${cleanNew}/ping`
  ], (err) => {
    if (!err) {
      updateMqttStatusUI('connected', state.mqttBrokerName);
      syncWithServer('update');
      startAutoPingCycle();
    }
  });
}

function refreshCloudConvoy() {
  const now = Date.now();
  const validRiders = [];

  // Hitung status detak jantung (Smart Presence 3 Warna)
  Object.keys(state.activeCloudRiders).forEach(id => {
    const r = state.activeCloudRiders[id];
    const diff = now - (r.lastSeen || now);

    // Pertahankan rider di memori hingga 10 menit (600.000 ms) agar titik terakhir tetap tersimpan di peta
    if (r.isDummy || diff < 600000) {
      if (diff > 30000) {
        r.presenceStatus = 'OFFLINE'; // > 30 detik: Merah
      } else if (diff > 10000) {
        r.presenceStatus = 'WEAK';    // 10 - 30 detik: Kuning
      } else {
        r.presenceStatus = 'ONLINE';  // < 10 detik: Hijau Live
      }
      r.lastSeenDiffSec = Math.round(diff / 1000);
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
    const pingText = state.lastPingRtt !== null ? ` • ${state.lastPingRtt}ms` : '';
    syncInd.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Live (${count} Rider${pingText})`;
  }
}

// Timer otomatis untuk memperbarui status dot online/kuning/merah tiap 3 detik
setInterval(() => {
  if (Object.keys(state.activeCloudRiders).length > 0) {
    refreshCloudConvoy();
  }
}, 3000);

// Routing & URL Management: https://.../touring/3431/
function updateBrowserUrlWithRoom(roomCode) {
  if (!roomCode) return;
  const clean = roomCode.trim().toUpperCase();
  const isTouringRepo = window.location.pathname.indexOf('/touring') !== -1;
  const targetPath = (isTouringRepo ? '/touring/' : '/') + clean + '/';

  // Perbarui address bar browser secara mulus tanpa reload halaman
  if (window.location.pathname !== targetPath) {
    try {
      window.history.replaceState({ room: clean }, '', targetPath);
      console.log('[Router] Browser URL updated to:', targetPath);
    } catch (e) {
      console.warn('[Router] Failed to update browser URL:', e);
    }
  }
}

// Auto-ping cloud: Maksimal 5x ping, lalu tunggu/jeda 30 detik
let pingBurstCount = 0;
const MAX_BURST_PINGS = 5;
const PING_INTERVAL_MS = 5000;
const PING_COOLDOWN_MS = 30000;
let pingCooldownTimer = null;
let pingStepTimer = null;
let isPingInCooldown = false;

function startAutoPingCycle() {
  if (pingCooldownTimer) clearTimeout(pingCooldownTimer);
  if (pingStepTimer) clearTimeout(pingStepTimer);
  pingBurstCount = 0;
  isPingInCooldown = false;
  runAutoPingStep();
}

function runAutoPingStep() {
  if (isPingInCooldown) return;

  if (pingBurstCount >= MAX_BURST_PINGS) {
    // Sudah 5x ping, istirahat 30 detik
    isPingInCooldown = true;
    console.log(`[MQTT Ping] Telah mencapai batas ${MAX_BURST_PINGS}x ping. Menunggu jeda ${PING_COOLDOWN_MS / 1000} detik...`);
    pingCooldownTimer = setTimeout(() => {
      pingBurstCount = 0;
      isPingInCooldown = false;
      console.log('[MQTT Ping] Jeda 30 detik selesai. Memulai siklus 5x ping baru.');
      runAutoPingStep();
    }, PING_COOLDOWN_MS);
    return;
  }

  // Kirim auto-ping jika mqtt terhubung
  if (state.mqttClient && state.mqttClient.connected) {
    pingBurstCount++;
    console.log(`[MQTT Ping] Auto ping dikirim: ${pingBurstCount}/${MAX_BURST_PINGS}`);
    sendPingTest(true);
  }

  // Jadwalkan ping berikutnya dalam 5 detik
  pingStepTimer = setTimeout(runAutoPingStep, PING_INTERVAL_MS);
}

function sendPingTest(isAuto = false) {
  if (!state.mqttClient || !state.mqttClient.connected) {
    if (!isAuto) {
      alert('⚠️ Belum terhubung ke Cloud MQTT. Menghubungkan ulang...');
    }
    initCloudMqtt();
    return;
  }
  const cleanRoom = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
  const topicPing = `touringmate/rooms/${cleanRoom}/ping`;
  const t0 = Date.now();
  const pingNonce = 'ping-' + t0 + '-' + Math.random().toString(36).substring(2, 6);
  state.pendingPing = { nonce: pingNonce, startTime: t0, isAuto: !!isAuto };

  const myName = state.myProfile ? state.myProfile.name : 'Saya';

  const payload = {
    senderClientId: state.mqttClientId,
    senderName: myName,
    pingNonce,
    timestamp: t0
  };

  console.log('[MQTT Ping] Sending ping with nonce:', pingNonce, 'isAuto:', isAuto);
  state.mqttClient.publish(topicPing, JSON.stringify(payload), { qos: 0 }, (err) => {
    if (err) {
      if (!isAuto) alert('Gagal mengirim ping: ' + err.message);
      state.pendingPing = null;
    }
  });

  setTimeout(() => {
    if (state.pendingPing && state.pendingPing.nonce === pingNonce) {
      state.pendingPing = null;
      if (!isAuto) {
        alert(`⚠️ Ping timeout (4 detik). Broker ${state.mqttBrokerName} belum merespon. Menghubungkan ulang...`);
      }
      tryNextBroker();
    }
  }, 4000);
}

/* ==========================================================================
   1. USER PROFILE, DEVICE ROLE (MASTER / PESERTA) & REALTIME SYNC
   ========================================================================== */
function loadProfile() {
  // 1. Auto-detect Room Code from URL query param (?room=3431) or path (/touring/3431/ or /3431/)
  const urlParams = new URLSearchParams(window.location.search);
  let queryRoom = urlParams.get('room');

  if (!queryRoom) {
    const isTouringRepo = window.location.pathname.indexOf('/touring') !== -1;
    const subPath = isTouringRepo ? window.location.pathname.replace(/^\/touring\/?/, '') : window.location.pathname.replace(/^\//, '');
    const segments = subPath.split('/').filter(Boolean);
    if (segments.length > 0 && segments[0].indexOf('.') === -1 && segments[0].toLowerCase() !== 'touring') {
      queryRoom = segments[0];
    }
  }

  if (queryRoom) {
    state.roomCode = queryRoom.trim().toUpperCase();
    localStorage.setItem('touring_room', state.roomCode);
  } else {
    const savedRoom = localStorage.getItem('touring_room');
    if (savedRoom) state.roomCode = savedRoom.toUpperCase();
  }

  // Sinkronkan URL browser address bar menjadi: https://.../touring/3431/
  updateBrowserUrlWithRoom(state.roomCode);

  // Pre-fill input in modal
  const roomInput = document.getElementById('inputRoomCode');
  if (roomInput) {
    roomInput.value = state.roomCode || 'TOURING-1';
  }

  const saved = localStorage.getItem('touring_profile');
  if (saved) {
    try {
      state.myProfile = JSON.parse(saved);
      if (!state.myProfile.id) {
        state.myProfile.id = 'rider-' + Math.random().toString(36).substring(2, 9);
      }
      saveProfile(state.myProfile);
    } catch (e) {
      state.myProfile = null;
    }
  }

  // Auto-masuk & simpan data peserta: jika belum ada, buatkan profil default langsung tersimpan
  if (!state.myProfile) {
    const randomNum = Math.floor(100 + Math.random() * 900);
    const randomPlate = Math.floor(1000 + Math.random() * 9000);
    const isLocalhost = (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

    state.myProfile = {
      id: 'rider-' + Math.random().toString(36).substring(2, 9),
      name: 'Rider ' + randomNum,
      plate: 'B ' + randomPlate + ' TRG',
      vehicle: 'Motor',
      role: isLocalhost ? 'LEADER' : 'MEMBER',
      isMaster: isLocalhost
    };
    saveProfile(state.myProfile);
  }

  // Load koordinat terakhir tersimpan agar peta langsung terbuka di lokasi pengendara
  const savedCoords = localStorage.getItem('touring_last_coords');
  if (savedCoords) {
    try {
      const parsed = JSON.parse(savedCoords);
      if (parsed.lat && parsed.lng) {
        state.myCoords.lat = parsed.lat;
        state.myCoords.lng = parsed.lng;
      }
    } catch (e) {}
  }

  updateProfileUI();

  // Auto-masuk langsung ke peta tanpa memblokir layar dengan modal registrasi
  const modal = document.getElementById('profileModal');
  if (modal) modal.classList.add('hidden');
  document.getElementById('btnCloseModal')?.classList.remove('hidden');
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
        senderClientId: state.mqttClientId,
        senderId: state.myProfile.id,
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
  // Load saved last known location from localStorage for instant map centering on startup
  const savedCoords = localStorage.getItem('touring_last_coords');
  if (savedCoords) {
    try {
      const parsed = JSON.parse(savedCoords);
      if (parsed.lat && parsed.lng) {
        state.myCoords.lat = parsed.lat;
        state.myCoords.lng = parsed.lng;
      }
    } catch (e) {}
  }

  // Coordinate for initial map view
  const defaultPos = [state.myCoords.lat, state.myCoords.lng];

  state.map = L.map('map', {
    zoomControl: false,
    attributionControl: false
  }).setView(defaultPos, 17);

  // High contrast / OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
  }).addTo(state.map);

  // When user manually drags/pans map, stop auto-follow so it doesn't fight the user's manual pan
  state.map.on('dragstart', () => {
    state.isAutoFollowMap = false;
  });
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

    const isOffline = rider.presenceStatus === 'OFFLINE';
    const popupText = isOffline
      ? `<b>${rider.name} (OFFLINE)</b><br>Titik Terakhir Terpantau<br>Plat: ${rider.plate}`
      : `<b>${rider.name} (LIVE)</b><br>${rider.vehicle}<br>Plat: ${rider.plate}`;

    if (!state.mapMarkers[rider.id]) {
      const riderIcon = L.divIcon({
        className: `custom-rider-marker ${roleClass} ${isOffline ? 'opacity-60' : ''}`,
        html: `
          <div class="marker-pin"><span class="marker-pin-inner">${roleTag}</span></div>
          <div class="marker-label">${rider.plate}</div>
        `,
        iconSize: [40, 50],
        iconAnchor: [20, 50]
      });
      state.mapMarkers[rider.id] = L.marker(riderPos, { icon: riderIcon, opacity: isOffline ? 0.65 : 1.0 })
        .bindPopup(popupText)
        .addTo(state.map);
    } else {
      state.mapMarkers[rider.id].setLatLng(riderPos);
      state.mapMarkers[rider.id].setOpacity(isOffline ? 0.65 : 1.0);
      state.mapMarkers[rider.id].setPopupContent(popupText);
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
let gpsWatchId = null;
let isGpsActive = true;

function updateGpsStatusUI(isActive, message) {
  const statusEl = document.getElementById('gpsStatusText');
  const btnGps = document.getElementById('btnToggleGps');
  if (statusEl) {
    if (isActive) {
      statusEl.className = 'text-[11px] font-semibold text-emerald-400 flex items-center gap-1 leading-none mt-0.5 cursor-pointer';
      statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> ${message || 'GPS Aktif'}`;
    } else {
      statusEl.className = 'text-[11px] font-semibold text-slate-400 flex items-center gap-1 leading-none mt-0.5 cursor-pointer';
      statusEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span> ${message || 'GPS Nonaktif'}`;
    }
  }
  if (btnGps) {
    if (isActive) {
      btnGps.className = 'w-7 h-7 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 flex items-center justify-center transition active:scale-90';
      btnGps.title = 'GPS Aktif (Klik untuk Matikan GPS)';
    } else {
      btnGps.className = 'w-7 h-7 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 border border-rose-500/30 flex items-center justify-center transition active:scale-90';
      btnGps.title = 'GPS Nonaktif (Klik untuk Nyalakan GPS)';
    }
    btnGps.innerHTML = '<i data-lucide="power" class="w-3.5 h-3.5"></i>';
    if (window.lucide) lucide.createIcons();
  }
}

function handleGpsPosition(position) {
  if (!isGpsActive) return;
  const { latitude, longitude, speed } = position.coords;
  state.myCoords.lat = latitude;
  state.myCoords.lng = longitude;
  state.myCoords.speed = speed ? Math.round(speed * 3.6) : 0; // m/s to km/h

  // Simpan koordinat akurat terakhir ke localStorage
  try {
    localStorage.setItem('touring_last_coords', JSON.stringify({ lat: latitude, lng: longitude }));
  } catch (e) {}

  const hudSpeed = document.getElementById('hudSpeed');
  if (hudSpeed) hudSpeed.textContent = state.myCoords.speed;
  updateGpsStatusUI(true, 'GPS Akurat');

  // Auto-fokus & auto-center langsung ke lokasi GPS sekarang tanpa perlu pencet tombol apapun!
  if (state.map && (!state.hasFirstGpsLock || state.isAutoFollowMap)) {
    state.map.setView([latitude, longitude], 17, { animate: !state.hasFirstGpsLock ? false : true });
    state.hasFirstGpsLock = true;
  }

  updateMapMarkers();
  renderRoster();
}

function handleGpsError(err) {
  if (!isGpsActive) return;
  console.warn('Geolocation notice:', err.code, err.message);
  let msg = 'GPS Mode Sim';
  if (err.code === 1) {
    msg = 'Izin Ditolak';
  } else if (err.code === 2) {
    msg = 'Sinyal Lemah';
  } else if (err.code === 3) {
    msg = 'GPS Timeout';
  }
  updateGpsStatusUI(true, msg);
}

function startGeolocation() {
  if (!navigator.geolocation) {
    updateGpsStatusUI(false, 'GPS Tidak Didukung');
    return;
  }
  isGpsActive = true;
  updateGpsStatusUI(true, 'GPS Aktif');

  // 1. Kunci posisi instan cepat (<200ms) dari cell tower/wifi cache
  navigator.geolocation.getCurrentPosition(handleGpsPosition, () => {}, { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 });

  // 2. Kunci posisi akurasi tinggi GPS Satelit
  navigator.geolocation.getCurrentPosition(handleGpsPosition, handleGpsError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });

  // 3. Pantau terus-menerus posisi motor/kendaraan
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
  }
  gpsWatchId = navigator.geolocation.watchPosition(handleGpsPosition, handleGpsError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

function stopGeolocation() {
  isGpsActive = false;
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  state.myCoords.speed = 0;
  const hudSpeed = document.getElementById('hudSpeed');
  if (hudSpeed) hudSpeed.textContent = '0';
  updateGpsStatusUI(false, 'GPS Nonaktif');
}

function toggleGeolocation() {
  if (isGpsActive) {
    stopGeolocation();
  } else {
    startGeolocation();
  }
}

function initGeolocation() {
  startGeolocation();
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

  // Calculate distance for each rider relative to me
  const processedRiders = state.riders.map(rider => {
    const rLat = (rider.lat !== undefined && rider.lat !== null) ? rider.lat : (state.myCoords.lat + (rider.latOffset || 0));
    const rLng = (rider.lng !== undefined && rider.lng !== null) ? rider.lng : (state.myCoords.lng + (rider.lngOffset || 0));
    const dist = calculateDistanceMeters(state.myCoords.lat, state.myCoords.lng, rLat, rLng);
    const isAhead = (rider.lat !== undefined && rider.lat !== null) ? (rider.lat >= state.myCoords.lat) : ((rider.latOffset || 0) >= 0);
    return { ...rider, lat: rLat, lng: rLng, distance: dist, isAhead };
  });

  // Sort: Riders in front first (closest to furthest), then riders behind
  processedRiders.sort((a, b) => a.distance - b.distance);

  // Render left transparent participants HUD list ("nge jajar sebelah kiri")
  renderLeftHUD(processedRiders);

  if (!container) return;

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
   5. TRANSPARENT PARTICIPANTS HUD (NGEJAJAR SEBELAH KIRI)
   ========================================================================== */
function renderLeftHUD(processedRiders) {
  const leftContainer = document.getElementById('leftParticipantsList');
  const countBadge = document.getElementById('leftRiderCount');
  if (countBadge) {
    countBadge.textContent = `${state.riders.length + 1}`;
  }
  if (!leftContainer) return;

  leftContainer.innerHTML = '';

  // 1. Baris Pengguna Sendiri (Saya) di Paling Atas (Transparan & Rapi)
  const myName = state.myProfile?.name || 'Saya';
  const myPlate = state.myProfile?.plate || 'MY-GPS';
  const myRole = state.myProfile?.role || 'MEMBER';
  const myRoleTag = myRole === 'LEADER' ? 'RC' : (myRole === 'SWEEPER' ? 'SW' : (myRole === 'MEDIC' ? 'MED' : 'MBR'));
  const myRoleColor = myRole === 'LEADER' 
    ? 'bg-blue-500/25 text-blue-300 border border-blue-500/40' 
    : (myRole === 'SWEEPER' 
      ? 'bg-rose-500/25 text-rose-300 border border-rose-500/40' 
      : (myRole === 'MEDIC' 
        ? 'bg-red-500/25 text-red-300 border border-red-500/40' 
        : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'));

  const selfEl = document.createElement('div');
  selfEl.className = 'cursor-pointer flex items-center justify-between px-2 py-1 rounded-lg bg-black/20 hover:bg-black/40 backdrop-blur-[2px] text-slate-100 transition active:scale-[0.98] group [text-shadow:_0_1px_3px_rgb(0_0_0_/_90%)]';
  selfEl.title = 'Klik untuk pusatkan peta ke posisi Saya';
  selfEl.innerHTML = `
    <div class="flex items-center gap-1.5 min-w-0 pr-1">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"></span>
      <span class="px-1 py-0.2 rounded text-[9px] font-bold ${myRoleColor}">${myRoleTag}</span>
      <span class="font-bold text-xs truncate text-white/95 group-hover:text-amber-300 transition">${myName} <span class="text-[10px] text-emerald-400/90 font-normal">(Saya)</span></span>
    </div>
    <span class="font-mono text-[10px] text-slate-300/85 font-semibold flex-shrink-0">${myPlate}</span>
  `;
  selfEl.addEventListener('click', () => {
    if (state.map) {
      state.map.setView([state.myCoords.lat, state.myCoords.lng], 17, { animate: true });
      if (state.mapMarkers['self']) state.mapMarkers['self'].openPopup?.();
    }
  });
  leftContainer.appendChild(selfEl);

  // 2. Baris Anggota Rombongan Lainnya (Transparan & Rapi)
  if (processedRiders.length === 0) {
    const emptyNotice = document.createElement('div');
    emptyNotice.className = 'px-1.5 py-0.5 text-[10px] text-slate-300/70 italic [text-shadow:_0_1px_2px_rgb(0_0_0_/_90%)]';
    emptyNotice.textContent = 'Menunggu rider lain...';
    leftContainer.appendChild(emptyNotice);
    return;
  }

  processedRiders.forEach(rider => {
    const rRole = rider.role || 'MEMBER';
    const rRoleTag = rRole === 'LEADER' ? 'RC' : (rRole === 'SWEEPER' ? 'SW' : (rRole === 'MEDIC' ? 'MED' : 'MBR'));
    const rRoleColor = rRole === 'LEADER' 
      ? 'bg-blue-500/25 text-blue-300 border border-blue-500/40' 
      : (rRole === 'SWEEPER' 
        ? 'bg-rose-500/25 text-rose-300 border border-rose-500/40' 
        : (rRole === 'MEDIC' 
          ? 'bg-red-500/25 text-red-300 border border-red-500/40' 
          : 'bg-slate-800/60 text-slate-300 border border-slate-700/40'));

    const isOffline = rider.presenceStatus === 'OFFLINE';
    const isWeak = rider.presenceStatus === 'WEAK';

    let dotClass = 'bg-emerald-400 animate-pulse';
    let textClass = 'text-slate-200/95 group-hover:text-amber-300';
    let subInfo = formatDistance(rider.distance);
    let subClass = 'text-amber-300/90 font-bold';

    if (isOffline) {
      dotClass = 'bg-rose-500';
      textClass = 'line-through decoration-rose-500/60 text-rose-300/80';
      const mins = Math.max(1, Math.round((rider.lastSeenDiffSec || 30) / 60));
      subInfo = `${mins}m lalu`;
      subClass = 'text-rose-400 font-bold';
    } else if (isWeak) {
      dotClass = 'bg-amber-400 animate-pulse';
      textClass = 'text-amber-200/95 group-hover:text-amber-300';
      subInfo = `${rider.lastSeenDiffSec || 15}s lalu`;
      subClass = 'text-amber-400 font-bold';
    }

    const row = document.createElement('div');
    row.className = `cursor-pointer flex items-center justify-between px-2 py-1 rounded-lg ${isOffline ? 'bg-rose-950/20' : 'bg-black/15'} hover:bg-black/35 backdrop-blur-[2px] text-slate-200 transition active:scale-[0.98] group [text-shadow:_0_1px_3px_rgb(0_0_0_/_90%)]`;
    row.title = `Klik untuk lihat posisi ${rider.name} (${rider.plate}) di peta ${isOffline ? '(Titik Terakhir Terpantau)' : ''}`;
    row.innerHTML = `
      <div class="flex items-center gap-1.5 min-w-0 pr-1">
        <span class="w-1.5 h-1.5 rounded-full ${dotClass} flex-shrink-0"></span>
        <span class="px-1 py-0.2 rounded text-[9px] font-bold ${rRoleColor}">${rRoleTag}</span>
        <span class="font-medium text-xs truncate ${textClass} transition">${rider.name}</span>
      </div>
      <div class="flex items-center gap-1 flex-shrink-0">
        <span class="font-mono text-[10px] ${subClass}">${subInfo}</span>
      </div>
    `;
    row.addEventListener('click', () => {
      if (state.map && rider.lat !== undefined && rider.lng !== undefined) {
        state.map.setView([rider.lat, rider.lng], 17, { animate: true });
        if (state.mapMarkers[rider.id]) {
          state.mapMarkers[rider.id].openPopup();
        }
      }
    });
    leftContainer.appendChild(row);
  });
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
  // GPS Toggle button (Matikan / Nyalakan GPS)
  document.getElementById('btnToggleGps')?.addEventListener('click', toggleGeolocation);
  document.getElementById('gpsStatusText')?.addEventListener('click', toggleGeolocation);

  // Recenter map button
  document.getElementById('btnRecenter')?.addEventListener('click', () => {
    state.isAutoFollowMap = true;
    if (state.map) {
      state.map.setView([state.myCoords.lat, state.myCoords.lng], 17, { animate: true });
    }
  });

  // Drawer toggles
  const drawer = document.getElementById('rosterDrawer');
  document.getElementById('btnToggleRoster')?.addEventListener('click', () => {
    drawer?.classList.remove('translate-x-full', 'pointer-events-none');
    drawer?.classList.add('pointer-events-auto');
  });
  document.getElementById('btnCloseRoster')?.addEventListener('click', () => {
    drawer?.classList.add('translate-x-full', 'pointer-events-none');
    drawer?.classList.remove('pointer-events-auto');
  });

  // Zoom In (+) and Zoom Out (-) buttons (Persis di bawah tombol PTT)
  document.getElementById('btnZoomIn')?.addEventListener('click', () => {
    if (state.map) state.map.zoomIn();
  });
  document.getElementById('btnZoomOut')?.addEventListener('click', () => {
    if (state.map) state.map.zoomOut();
  });



  // Voice mute/unmute (Interkom Suara Teman)
  const voiceBtn = document.getElementById('btnVoiceToggle');
  voiceBtn?.addEventListener('click', () => {
    state.isVoiceActive = !state.isVoiceActive;
    voiceBtn.innerHTML = state.isVoiceActive
      ? '<i data-lucide="volume-2" class="w-4 h-4 text-emerald-400"></i>'
      : '<i data-lucide="volume-x" class="w-4 h-4 text-slate-500"></i>';
    if (window.lucide) lucide.createIcons();
  });

  // Alert Notification Mute Toggle (Lonceng Senyap / Bunyi)
  function updateAlertNotificationUI() {
    const btn = document.getElementById('btnToggleAlertNotification');
    if (!btn) return;
    if (state.isAlertNotificationMuted) {
      btn.className = 'flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-[10px] bg-slate-900/60 hover:bg-slate-800 text-slate-400 border border-slate-700/50 transition cursor-pointer';
      btn.title = 'Notifikasi Senyap (Klik untuk Nyalakan Bunyi)';
      btn.innerHTML = '<i data-lucide="bell-off" class="w-3 h-3 text-slate-400"></i> <span class="text-[9px]">Senyap</span>';
    } else {
      btn.className = 'flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-[10px] bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 transition cursor-pointer font-bold';
      btn.title = 'Notifikasi Bunyi Aktif (Klik untuk Matikan Suara)';
      btn.innerHTML = '<i data-lucide="bell" class="w-3 h-3 text-amber-300"></i> <span class="text-[9px]">Bunyi</span>';
    }
    if (window.lucide) lucide.createIcons();
  }

  document.getElementById('btnToggleAlertNotification')?.addEventListener('click', () => {
    state.isAlertNotificationMuted = !state.isAlertNotificationMuted;
    localStorage.setItem('touring_alert_muted', state.isAlertNotificationMuted ? 'true' : 'false');
    updateAlertNotificationUI();
  });
  updateAlertNotificationUI();

  // Simulation Button
  document.getElementById('btnSimulationToggle')?.addEventListener('click', toggleSimulation);

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
  document.getElementById('btnOpenEditProfile')?.addEventListener('click', openModal);
  document.getElementById('btnHeaderProfile')?.addEventListener('click', openModal);
  document.getElementById('btnCloseModal')?.addEventListener('click', () => modal?.classList.add('hidden'));

  document.getElementById('profileForm')?.addEventListener('submit', (e) => {
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
    document.getElementById('btnCloseModal')?.classList.remove('hidden');
    updateMapMarkers();
    renderRoster();
  });

  // Add custom rider button
  document.getElementById('btnAddNewRider')?.addEventListener('click', () => {
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

  document.getElementById('btnGenerateDummy')?.addEventListener('click', () => {
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
  document.getElementById('btnResetConvoy')?.addEventListener('click', () => {
    syncWithServer('set_convoy', { convoyList: DEFAULT_CONVOY });
    alert('Rombongan telah di-reset ke rombongan standar.');
  });

  // Clear all dummy riders (Kosongkan Rombongan)
  document.getElementById('btnClearAllRiders')?.addEventListener('click', () => {
    if (confirm('Yakin ingin membersihkan semua peserta dummy? Hanya HP/Laptop asli yang akan tersisa.')) {
      syncWithServer('clear');
    }
  });

  // Delete Individual Rider
  document.getElementById('riderListContainer')?.addEventListener('click', (e) => {
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
    // Current URL with clean Room path (e.g. https://domain.com/touring/3431/)
    const isTouringRepo = window.location.pathname.indexOf('/touring') !== -1;
    const cleanRoom = encodeURIComponent(state.roomCode || 'TOURING-1');
    const joinUrl = `${window.location.origin}${isTouringRepo ? '/touring/' : '/'}${cleanRoom}/`;
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

  document.getElementById('btnOpenQrModal')?.addEventListener('click', openQrModal);
  document.getElementById('btnCloseQrModal')?.addEventListener('click', () => {
    qrModal?.classList.add('hidden');
  });

  // Copy Link button
  document.getElementById('btnCopyShareUrl')?.addEventListener('click', () => {
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
  updateQuickModeUI();

  // Modal open/close
  const micModal = document.getElementById('micSettingsModal');
  document.getElementById('btnOpenMicModal')?.addEventListener('click', () => {
    micModal?.classList.remove('hidden');
    startVoxEngine(); // Start audio context for live meter preview
  });
  document.getElementById('btnCloseMicModal')?.addEventListener('click', () => {
    micModal?.classList.add('hidden');
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
  document.getElementById('btnSaveMicSettings')?.addEventListener('click', () => {
    const selectedMode = document.querySelector('input[name="micModeRadio"]:checked')?.value || 'PTT';
    setMicMode(selectedMode);
    micModal?.classList.add('hidden');
  });

  // 1-Tap Quick Switcher directly on HUD
  document.getElementById('btnQuickToggleHandsfree')?.addEventListener('click', (e) => {
    e.preventDefault();
    const nextMode = state.micMode === 'ALWAYS_ON' ? 'PTT' : 'ALWAYS_ON';
    setMicMode(nextMode);
    showPttToast(nextMode === 'ALWAYS_ON' ? '📻 Mode Hands-Free (Radio) Aktif' : '🔘 Mode PTT Aktif', 2000);
  });

  function updateQuickModeUI() {
    const btn = document.getElementById('btnQuickToggleHandsfree');
    const dot = document.getElementById('quickModeDot');
    const text = document.getElementById('quickModeText');
    if (!btn || !dot || !text) return;

    if (state.micMode === 'ALWAYS_ON') {
      btn.className = 'px-2 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-500/60 text-[10px] font-mono font-bold text-emerald-300 shadow-md backdrop-blur-md transition flex items-center gap-1 active:scale-95';
      dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping';
      text.textContent = '📻 HANDS-FREE';
      btn.title = 'Mode Hands-Free Aktif (Klik untuk Ganti ke PTT)';
    } else {
      btn.className = 'px-2 py-0.5 rounded-full bg-slate-900/90 border border-slate-700/60 text-[10px] font-mono font-bold text-slate-300 hover:text-amber-400 shadow-md backdrop-blur-md transition flex items-center gap-1 active:scale-95';
      dot.className = 'w-1.5 h-1.5 rounded-full bg-slate-400';
      text.textContent = '🔘 PTT';
      btn.title = 'Mode PTT Aktif (Klik untuk Ganti ke Hands-Free)';
    }
  }

  function setMicMode(newMode) {
    state.micMode = newMode;
    localStorage.setItem('touring_mic_mode', newMode);

    // Sync radio in modal
    const radioEl = document.getElementById('micMode' + (newMode === 'ALWAYS_ON' ? 'AlwaysOn' : (newMode === 'VOX' ? 'Vox' : 'Ptt')));
    if (radioEl) radioEl.checked = true;

    // Stop previous modes
    clearInterval(alwaysOnInterval);
    if (typeof radioCountdownTimer !== 'undefined' && radioCountdownTimer) {
      clearInterval(radioCountdownTimer);
      radioCountdownTimer = null;
    }
    if (typeof updateRadioTimerUI === 'function') updateRadioTimerUI();
    if (isRecordingPtt) stopPttRecording();

    if (state.micMode === 'ALWAYS_ON') {
      startAlwaysOnMode();
    } else if (state.micMode === 'VOX') {
      startVoxEngine();
    }

    updatePttButtonUI();
    updateQuickModeUI();
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

    if (isRecordingPtt && state.micMode === 'PTT') {
      pttBtn.className = 'w-16 h-16 rounded-full bg-rose-600 border-4 border-rose-300 text-white shadow-2xl flex flex-col items-center justify-center transition-all transform scale-110 select-none animate-pulse';
      pttLabel.textContent = 'REC...';
    } else if (state.micMode === 'ALWAYS_ON') {
      if (typeof isRadioTalkingActive !== 'undefined' && isRadioTalkingActive && isRecordingPtt) {
        // MERAH: Tanda Ngomong Terus
        pttBtn.className = 'w-16 h-16 rounded-full bg-rose-600 border-4 border-rose-300 text-white shadow-2xl flex flex-col items-center justify-center transition-all animate-pulse transform scale-105 select-none';
        pttBtn.title = 'Sedang Bicara Terus (Klik untuk Berhenti Ngobrol)';
        pttLabel.textContent = 'TALK 🔴';
      } else {
        // HIJAU: Tanda Berhenti Ngobrol (Standby)
        pttBtn.className = 'w-16 h-16 rounded-full bg-emerald-950/90 hover:bg-emerald-900/90 border-2 border-emerald-400 text-emerald-300 shadow-xl flex flex-col items-center justify-center transition-all select-none';
        pttBtn.title = 'Mode Radio Standby (Klik Sekali untuk Ngomong Terus)';
        pttLabel.textContent = 'RADIO 🟢';
      }
    } else if (state.micMode === 'VOX') {
      pttBtn.className = 'w-16 h-16 rounded-full bg-cyan-950/90 border-2 border-cyan-400 text-cyan-300 shadow-2xl flex flex-col items-center justify-center transition-all select-none';
      pttLabel.textContent = 'VOX AUTO';
    } else {
      // PTT Default
      pttBtn.className = 'w-16 h-16 rounded-full bg-slate-900/95 hover:bg-slate-800 border-2 border-emerald-500/80 text-emerald-400 shadow-2xl flex flex-col items-center justify-center transition-all transform active:scale-95 group focus:outline-none select-none';
      pttLabel.textContent = 'PTT';
    }
    if (typeof updateRadioTimerUI === 'function') updateRadioTimerUI();
    if (typeof updateQuickModeUI === 'function') updateQuickModeUI();
  }

  let pttToastTimer = null;
  function showPttToast(text, duration = 1500) {
    const ind = document.getElementById('pttStatusIndicator');
    const txt = document.getElementById('pttStatusText');
    const dot = document.getElementById('pttStatusDot');
    if (!ind || !txt) return;

    txt.textContent = text;
    ind.classList.remove('hidden');

    // Reset warna & animasi
    ind.classList.remove('bg-rose-600/95', 'border-rose-400/60', 'bg-emerald-600/95', 'border-emerald-400/60', 'bg-amber-600/95', 'border-amber-400/60', 'bg-slate-800/95', 'border-slate-600/60', 'animate-pulse');
    if (dot) dot.classList.remove('animate-ping', 'animate-pulse');

    if (text.includes('REKAM') || text.includes('🎙️') || text.includes('🔴')) {
      ind.classList.add('bg-rose-600/95', 'border-rose-400/60', 'animate-pulse');
      if (dot) dot.classList.add('animate-ping');
    } else if (text.includes('TERKIRIM') || text.includes('✅')) {
      ind.classList.add('bg-emerald-600/95', 'border-emerald-400/60');
      if (dot) dot.classList.add('animate-pulse');
    } else if (text.includes('Mengirim') || text.includes('📤')) {
      ind.classList.add('bg-amber-600/95', 'border-amber-400/60');
      if (dot) dot.classList.add('animate-pulse');
    } else {
      ind.classList.add('bg-slate-800/95', 'border-slate-600/60');
    }

    if (pttToastTimer) clearTimeout(pttToastTimer);
    if (duration > 0) {
      pttToastTimer = setTimeout(() => {
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

  let radioCountdownTimer = null;
  let radioSecondsRemaining = 600; // 10 menit = 600 detik
  const RADIO_CYCLE_SECONDS = 600;
  let isRadioTalkingActive = false; // true = MERAH (ngomong terus), false = HIJAU (berhenti ngobrol)

  function updateRadioTimerUI() {
    const badge = document.getElementById('radioTimerBadge');
    const display = document.getElementById('countdownDisplay');
    if (!badge || !display) return;

    if (state.micMode === 'ALWAYS_ON') {
      badge.classList.remove('hidden');
      const m = Math.floor(radioSecondsRemaining / 60);
      const s = radioSecondsRemaining % 60;
      display.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    } else {
      badge.classList.add('hidden');
    }
  }

  function startRadio10MinCountdown() {
    if (radioCountdownTimer) return;
    radioSecondsRemaining = RADIO_CYCLE_SECONDS;
    updateRadioTimerUI();

    radioCountdownTimer = setInterval(() => {
      if (state.micMode !== 'ALWAYS_ON') {
        clearInterval(radioCountdownTimer);
        radioCountdownTimer = null;
        updateRadioTimerUI();
        return;
      }

      radioSecondsRemaining--;
      updateRadioTimerUI();

      if (radioSecondsRemaining <= 0) {
        // Auto-reset buffer audio per 10 menit & auto reopen immediately!
        console.log('[Radio Hands-Free] 10 menit tercapai. Mereset buffer audio...');
        showPttToast('♻️ Audio Reset 10m', 1500);

        if (isRadioTalkingActive && isRecordingPtt) {
          stopPttRecording();
          setTimeout(() => {
            radioSecondsRemaining = RADIO_CYCLE_SECONDS;
            if (state.micMode === 'ALWAYS_ON' && isRadioTalkingActive && !state.isMutedByHost) {
              startPttRecording();
              console.log('[Radio Hands-Free] Berhasil terbuka otomatis kembali untuk 10 menit berikutnya!');
            }
          }, 150);
        } else {
          radioSecondsRemaining = RADIO_CYCLE_SECONDS;
        }
      }
    }, 1000);
  }

  // Radio Hands-Free Mode: Mulai dalam kondisi STANDBY (HIJAU 🟢)
  function startAlwaysOnMode() {
    isRadioTalkingActive = false;
    if (isRecordingPtt) stopPttRecording();
    clearInterval(alwaysOnInterval);
    startRadio10MinCountdown();
    updatePttButtonUI();
    showPttToast('📻 Mode Hands-Free (Klik Tombol untuk Bicara)', 2500);
  }

  // Klik sekali jadi MERAH tanda ngomong terus
  function startRadioTalking() {
    if (state.isMutedByHost) return;
    isRadioTalkingActive = true;
    startPttRecording();
    showPttToast('🎙️ NGOMONG TERUS (MERAH)', 0);

    clearInterval(alwaysOnInterval);
    alwaysOnInterval = setInterval(() => {
      if (state.micMode === 'ALWAYS_ON' && isRadioTalkingActive && isRecordingPtt && !state.isMutedByHost) {
        flushPcmChunksAndBroadcast();
      }
    }, 2500);

    updatePttButtonUI();
  }

  // Klik lagi jadi HIJAU tanda berhenti ngobrol
  function stopRadioTalking() {
    isRadioTalkingActive = false;
    clearInterval(alwaysOnInterval);
    stopPttRecording();
    showPttToast('✅ Berhenti Ngobrol (HIJAU)', 1800);
    updatePttButtonUI();
  }

  // Core Audio Recording using Web Audio ScriptProcessorNode (Cross-browser compatible iOS + Android + Desktop)
  async function startPttRecording(existingStream = null) {
    if (isRecordingPtt || state.isMutedByHost) return;
    isRecordingPtt = true;
    updatePttButtonUI();
    showPttToast('🎙️ MEREKAM...', 0);

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
      isRadioTalkingActive = false;
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
    const targetSampleRate = 12000; // 12kHz: jernih, ultra-ringan (~24KB/dtk), lolos limit MQTT

    let totalLength = 0;
    for (let i = 0; i < chunksToProcess.length; i++) totalLength += chunksToProcess[i].length;
    // Discard tiny noise clicks (<80ms)
    if (totalLength < inputSampleRate * 0.08) return;

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
    showPttToast('📤 Mengirim...', 1500);

    setTimeout(() => {
      flushPcmChunksAndBroadcast(() => {
        showPttToast('✅ TERKIRIM!', 2000);
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
    if (state.isMutedByHost) {
      alert('Mikrofon Anda sedang dimatikan oleh Host.');
      return;
    }
    if (!state.mqttClient || !state.mqttClient.connected) {
      console.warn('Cannot broadcast voice: MQTT not connected');
      showPttToast('⚠️ Cloud Belum Terhubung');
      initCloudMqtt();
      return;
    }
    const cleanRoom = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
    const topicVoice = `touringmate/rooms/${cleanRoom}/voice`;

    const myName = state.myProfile ? state.myProfile.name : 'Saya';
    const myId = state.myProfile ? state.myProfile.id : state.mqttClientId;
    const sizeKB = Math.round(audioDataUrl.length * 0.75 / 1024);

    const payload = {
      senderClientId: state.mqttClientId,
      senderId: myId,
      senderName: myName,
      audio: audioDataUrl,
      timestamp: Date.now()
    };

    console.log('[Voice] Broadcasting to', topicVoice, 'data length:', audioDataUrl.length);
    state.mqttClient.publish(topicVoice, JSON.stringify(payload), { qos: 0 }, (err) => {
      if (err) {
        console.error('[Voice] Publish error:', err);
        showPttToast('⚠️ Gagal Kirim Suara');
      } else {
        console.log('[Voice] Broadcast success!');
        showPttToast('✅ TERKIRIM!', 2000);
        // Record to local conversation history only upon successful send
        appendChatMessage({
          id: 'voice-' + Date.now(),
          type: 'voice_out',
          senderName: myName,
          sizeKB,
          audio: audioDataUrl,
          time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });
      }
    });
  }

  // --- INCOMING VOICE QUEUE & UNIVERSAL PLAYBACK ---
  const incomingVoiceQueue = [];
  let isVoicePlaying = false;

  function playIncomingVoice(speakerName, audioDataUrl) {
    console.log('[Voice] Queuing incoming transmission from:', speakerName);
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

    // Show toast immediately so receiver sees who is talking
    const toast = document.getElementById('incomingVoiceToast');
    const speakerEl = document.getElementById('incomingVoiceSpeaker');
    if (speakerEl) speakerEl.textContent = `${item.speakerName} bicara...`;
    if (toast) toast.classList.remove('hidden');

    try {
      if (ctx && ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (e) {}
      }

      if (ctx) playRadioChirp(ctx);

      const arrayBuffer = base64ToArrayBuffer(item.audioDataUrl);

      // WebKit Safari requires buffer.slice(0) copy
      ctx.decodeAudioData(arrayBuffer.slice(0), (audioBuffer) => {
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        source.onended = () => {
          if (incomingVoiceQueue.length === 0 && toast) {
            toast.classList.add('hidden');
          }
          setTimeout(processIncomingVoiceQueue, 80);
        };

        source.start(0);
      }, (err) => {
        console.warn('decodeAudioData error, attempting fallback:', err);
        const fallbackAudio = new Audio(item.audioDataUrl);
        fallbackAudio.onended = () => {
          if (incomingVoiceQueue.length === 0 && toast) toast.classList.add('hidden');
          setTimeout(processIncomingVoiceQueue, 80);
        };
        fallbackAudio.onerror = () => {
          if (incomingVoiceQueue.length === 0 && toast) toast.classList.add('hidden');
          setTimeout(processIncomingVoiceQueue, 80);
        };
        fallbackAudio.play().catch(() => {
          if (incomingVoiceQueue.length === 0 && toast) toast.classList.add('hidden');
          setTimeout(processIncomingVoiceQueue, 80);
        });
      });

    } catch (err) {
      console.warn('Voice play queue error:', err);
      if (incomingVoiceQueue.length === 0 && toast) toast.classList.add('hidden');
      setTimeout(processIncomingVoiceQueue, 80);
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
                const downsampled = downsampleBuffer(merged, inputSampleRate, 12000);
                const wavBlob = encodeWAV(downsampled, 12000);
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

  // PTT Button Event Listeners: Instant Push-to-Talk + Tap-to-Lock + Hands-Free Toggle
  const pttButton = document.getElementById('btnPtt');
  let pttStartTime = 0;
  let pttIsLocked = false;
  let lastTouchTime = 0;

  function handlePttStart(e) {
    if (e) {
      if (e.type === 'touchstart') {
        lastTouchTime = Date.now();
      } else if (e.type === 'mousedown') {
        // Cegah double event / ghost click pada HP layar sentuh (iOS Safari / Android)
        if (Date.now() - lastTouchTime < 800) {
          if (e.preventDefault) e.preventDefault();
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
    }
    unlockGlobalAudio();
    if (state.isMutedByHost) return;

    // Saat mode Hands-Free: klik sekali jadi merah tanda ngomong terus, klik lagi jadi hijau berhenti ngobrol
    if (state.micMode === 'ALWAYS_ON') {
      if (isRadioTalkingActive) {
        stopRadioTalking();
      } else {
        startRadioTalking();
      }
      return;
    }

    if (isRecordingPtt && pttIsLocked) {
      // User tapped while locked -> stop recording & send
      pttIsLocked = false;
      stopPttRecording();
      return;
    }

    pttStartTime = Date.now();
    startPttRecording();
  }

  function handlePttEnd(e) {
    if (e) {
      if (e.type === 'touchend') {
        lastTouchTime = Date.now();
      } else if (e.type === 'mouseup') {
        // Cegah double event / ghost click pada HP layar sentuh
        if (Date.now() - lastTouchTime < 800) {
          if (e.preventDefault) e.preventDefault();
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
    }
    if (state.isMutedByHost || state.micMode === 'ALWAYS_ON') return;

    const duration = Date.now() - pttStartTime;
    // Quick tap (< 350ms): lock mic on so rider can talk hands-free
    if (duration < 350 && isRecordingPtt && !pttIsLocked) {
      pttIsLocked = true;
      showPttToast('🔒 Mic Nyala (Ketuk lagi untuk kirim)', 3000);
      return;
    }

    pttIsLocked = false;
    stopPttRecording();
  }

  if (pttButton) {
    // Touch (Mobile iOS & Android)
    pttButton.addEventListener('touchstart', handlePttStart, { passive: false });
    pttButton.addEventListener('touchend', handlePttEnd, { passive: false });

    // Click/Mouse (Desktop)
    pttButton.addEventListener('mousedown', handlePttStart);
    pttButton.addEventListener('mouseup', handlePttEnd);

    // Cegah action klik bawaan browser
    pttButton.addEventListener('click', (e) => {
      e.preventDefault();
    });

    pttButton.addEventListener('mouseleave', () => {
      // PENTING: Pada mode Hands-Free, jangan matikan rekaman saat kursor/jari keluar area tombol!
      if (state.micMode === 'ALWAYS_ON') return;

      if (isRecordingPtt && !pttIsLocked) {
        stopPttRecording();
      }
    });
  }

  // Pre-warm mic stream on first user touch anywhere
  window.addEventListener('touchstart', () => {
    if (!persistentMicStream) getMicStream().catch(() => {});
  }, { once: true, passive: true });
  window.addEventListener('click', () => {
    if (!persistentMicStream) getMicStream().catch(() => {});
  }, { once: true, passive: true });

  // Host Mute Roster Events
  document.getElementById('riderListContainer')?.addEventListener('click', (e) => {
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

  // ==========================================================================
  // CONVERSATION & TRANSMISSION HISTORY FEED (CHAT & VOICE LOGS)
  // ==========================================================================
  function appendChatMessage(item) {
    state.chatHistory.push(item);
    renderChatLog();

    const modal = document.getElementById('chatLogModal');
    const isModalOpen = modal && !modal.classList.contains('hidden');

    if (!isModalOpen && (item.type === 'chat_in' || item.type === 'voice_in')) {
      state.unreadChatCount++;
      updateUnreadBadges();
    }
  }

  function updateUnreadBadges() {
    const badgeTop = document.getElementById('unreadChatBadge');
    const badgeFloat = document.getElementById('unreadChatBadgeFloating');
    if (state.unreadChatCount > 0) {
      if (badgeTop) {
        badgeTop.textContent = state.unreadChatCount;
        badgeTop.classList.remove('hidden');
      }
      if (badgeFloat) badgeFloat.classList.remove('hidden');
    } else {
      if (badgeTop) badgeTop.classList.add('hidden');
      if (badgeFloat) badgeFloat.classList.add('hidden');
    }
  }

  function showIncomingTextToast(senderName, text) {
    const toast = document.getElementById('incomingTextToast');
    const senderEl = document.getElementById('incomingTextSender');
    const msgEl = document.getElementById('incomingTextMessage');
    if (!toast || !senderEl || !msgEl) return;

    senderEl.textContent = `Pesan dari ${senderName}`;
    msgEl.textContent = text;
    toast.classList.remove('hidden');

    if (!state.isAlertNotificationMuted) {
      const audioEl = document.getElementById('alertAudio');
      if (audioEl) {
        audioEl.currentTime = 0;
        audioEl.play().catch(() => {});
      }
    }

    setTimeout(() => {
      toast.classList.add('hidden');
    }, 4500);
  }

  function renderChatLog() {
    const feed = document.getElementById('chatLogFeed');
    if (!feed) return;

    if (state.chatHistory.length === 0) {
      feed.innerHTML = `
        <div class="text-center text-slate-500 text-[11px] py-4">
          Belum ada percakapan. Mulai bicara lewat PTT atau ketik pesan teks di bawah untuk menguji koneksi antar HP!
        </div>
      `;
      return;
    }

    let html = '';
    state.chatHistory.forEach((msg, idx) => {
      if (msg.type === 'voice_out') {
        html += `
          <div class="flex justify-end">
            <div class="max-w-[85%] bg-emerald-950/70 border border-emerald-500/40 rounded-2xl rounded-tr-sm p-3 text-slate-100 shadow-md">
              <div class="flex items-center justify-between gap-3 text-[10px] text-emerald-400 mb-1 font-mono">
                <span class="font-bold">🎙️ Suara Saya</span>
                <span>${msg.time} • ${msg.sizeKB} KB</span>
              </div>
              <div class="flex items-center gap-2 mt-2">
                <button class="btn-play-voice-item px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition active:scale-95" data-idx="${idx}">
                  <i data-lucide="play" class="w-3 h-3"></i> Putar Suara
                </button>
                <span class="text-[10px] text-emerald-400/80 font-mono">✅ Disiarkan ke Cloud</span>
              </div>
            </div>
          </div>
        `;
      } else if (msg.type === 'voice_in') {
        html += `
          <div class="flex justify-start">
            <div class="max-w-[85%] bg-slate-800/90 border border-cyan-500/40 rounded-2xl rounded-tl-sm p-3 text-slate-100 shadow-md">
              <div class="flex items-center justify-between gap-3 text-[10px] text-cyan-400 mb-1 font-mono">
                <span class="font-bold">📻 ${escapeHtml(msg.senderName)}</span>
                <span>${msg.time} • ${msg.sizeKB} KB</span>
              </div>
              <div class="flex items-center gap-2 mt-2">
                <button class="btn-play-voice-item px-2.5 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition active:scale-95" data-idx="${idx}">
                  <i data-lucide="play" class="w-3 h-3"></i> Putar Suara
                </button>
                <span class="text-[10px] text-cyan-300/80 font-mono">Diterima dari Cloud</span>
              </div>
            </div>
          </div>
        `;
      } else if (msg.type === 'chat_out') {
        html += `
          <div class="flex justify-end">
            <div class="max-w-[85%] bg-emerald-600 text-white rounded-2xl rounded-tr-sm px-3.5 py-2 text-xs shadow-md">
              <div class="text-[9px] text-emerald-200 font-mono mb-0.5 text-right">${msg.time}</div>
              <div class="font-medium">${escapeHtml(msg.text)}</div>
            </div>
          </div>
        `;
      } else if (msg.type === 'chat_in') {
        html += `
          <div class="flex justify-start">
            <div class="max-w-[85%] bg-slate-800 border border-slate-700 text-slate-100 rounded-2xl rounded-tl-sm px-3.5 py-2 text-xs shadow-md">
              <div class="text-[10px] text-amber-400 font-bold mb-0.5 flex items-center justify-between gap-2">
                <span>${escapeHtml(msg.senderName)}</span>
                <span class="text-[9px] text-slate-400 font-mono">${msg.time}</span>
              </div>
              <div class="text-slate-200 font-medium">${escapeHtml(msg.text)}</div>
            </div>
          </div>
        `;
      }
    });

    feed.innerHTML = html;
    feed.scrollTop = feed.scrollHeight;
    if (window.lucide) lucide.createIcons();
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function broadcastTextMessage(text) {
    if (!text || !text.trim()) return;

    if (!state.mqttClient || !state.mqttClient.connected) {
      alert('⚠️ Belum terhubung ke Cloud MQTT. Mohon tunggu status "Cloud Terhubung" (hijau). Menghubungkan ulang...');
      initCloudMqtt();
      return;
    }

    const cleanRoom = (state.roomCode || 'TOURING-1').replace(/[^A-Z0-9_-]/gi, '');
    const topicChat = `touringmate/rooms/${cleanRoom}/chat`;

    const myName = state.myProfile ? state.myProfile.name : 'Saya';
    const myId = state.myProfile ? state.myProfile.id : state.mqttClientId;

    const payload = {
      senderClientId: state.mqttClientId,
      senderId: myId,
      senderName: myName,
      text: text.trim(),
      timestamp: Date.now()
    };

    state.mqttClient.publish(topicChat, JSON.stringify(payload), { qos: 0 }, (err) => {
      if (err) {
        alert('Gagal mengirim ke Cloud: ' + err.message);
      } else {
        appendChatMessage({
          id: 'chat-' + Date.now(),
          type: 'chat_out',
          senderName: myName,
          text: text.trim(),
          time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });
      }
    });
  }

  function sendSyntheticBeep() {
    unlockGlobalAudio();
    const sampleRate = 12000;
    const numSamples = Math.round(sampleRate * 0.4);
    const samples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const env = 1 - (i / numSamples);
      samples[i] = Math.sin(2 * Math.PI * 880 * t) * 0.6 * env;
    }
    const wavBlob = encodeWAV(samples, sampleRate);
    const reader = new FileReader();
    reader.onloadend = () => {
      broadcastVoice(reader.result);
      showPttToast('🧪 Beep Tes Terkirim!', 2000);
    };
    reader.readAsDataURL(wavBlob);
  }

  // Modal Open/Close & Actions
  const chatModal = document.getElementById('chatLogModal');
  const chatRoomBadge = document.getElementById('chatRoomBadge');

  function openChatModal() {
    if (chatModal) {
      chatModal.classList.remove('hidden');
      state.unreadChatCount = 0;
      updateUnreadBadges();
      if (chatRoomBadge) {
        chatRoomBadge.textContent = `Room: ${state.roomCode || 'TOURING-1'}`;
      }
      renderChatLog();
    }
  }

  document.getElementById('btnOpenChatLog')?.addEventListener('click', openChatModal);
  document.getElementById('btnOpenChatLogFloating')?.addEventListener('click', openChatModal);
  document.getElementById('btnCloseChatLog')?.addEventListener('click', () => {
    if (chatModal) chatModal.classList.add('hidden');
  });

  // Tap sembarang di luar modal (backdrop) untuk langsung menutup
  ['chatLogModal', 'profileModal', 'qrModal', 'micSettingsModal'].forEach(modalId => {
    const el = document.getElementById(modalId);
    el?.addEventListener('click', (e) => {
      if (e.target === el) {
        el.classList.add('hidden');
      }
    });
  });

  document.getElementById('chatForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = document.getElementById('inputChatMessage');
    if (inp && inp.value.trim()) {
      broadcastTextMessage(inp.value.trim());
      inp.value = '';
    }
  });

  document.getElementById('btnClearChatHistory')?.addEventListener('click', () => {
    state.chatHistory = [];
    renderChatLog();
  });

  document.getElementById('btnSendTestBeep')?.addEventListener('click', sendSyntheticBeep);
  document.getElementById('btnTestPingMqtt')?.addEventListener('click', () => sendPingTest(false));

  document.getElementById('chatLogFeed')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-play-voice-item');
    if (btn) {
      const idx = parseInt(btn.dataset.idx);
      const item = state.chatHistory[idx];
      if (item && item.audio) {
        unlockGlobalAudio();
        playIncomingVoice(item.senderName || 'Suara', item.audio);
      }
    }
  });

  // Expose global intercom & chat functions so initCloudMqtt and other handlers can access them
  window.appendChatMessage = appendChatMessage;
  window.playIncomingVoice = playIncomingVoice;
  window.showIncomingTextToast = showIncomingTextToast;
  window.applyHostMute = applyHostMute;
  window.broadcastTextMessage = broadcastTextMessage;
  window.broadcastVoice = broadcastVoice;
  window.sendPingTest = sendPingTest;

  // Auto-start VOX engine if saved
  if (state.micMode === 'VOX') startVoxEngine();
  else if (state.micMode === 'ALWAYS_ON') startAlwaysOnMode();
}
