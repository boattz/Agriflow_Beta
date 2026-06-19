// ================================================
// Agriflow — Moisture Dashboard | script.js
// ================================================

let history     = [];
let chartRange  = 20;
let totalCount  = 0;
let chart       = null;
let evtSrc      = null;
let rTimer      = null;
let countdownInterval = null;
let countdownEndTime  = null;
let currentConfig = { wateringMinutes: 3 };

// ── XSS Protection ────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Droplets ──────────────────────────────────
(function() {
  const wrap = document.getElementById('bg-particles');
  for (let i = 0; i < 30; i++) {
    const d = document.createElement('div');
    d.className = 'drop';
    const size = Math.random() * 6 + 3;
    d.style.cssText = `left:${Math.random()*100}%;bottom:${Math.random()*-20}%;width:${size}px;height:${size}px;animation-duration:${8+Math.random()*14}s;animation-delay:${Math.random()*12}s;`;
    wrap.appendChild(d);
  }
})();

// ── Clock ─────────────────────────────────────
(function() {
  const el = document.getElementById('clock');
  const tick = () => { el.textContent = new Date().toLocaleTimeString('en-GB'); };
  tick(); setInterval(tick, 1000);
})();

function setStatus(state) {
  document.getElementById('status-dot').className = `dot ${state}`;
  document.getElementById('status-txt').textContent = state === 'online' ? 'Live ✓' : state === 'offline' ? 'Disconnected' : 'Connecting…';
  
  // Show toast on state changes
  const icons = {
    success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
    warning: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>'
  };
  
  if (state === 'online') {
    showToast('Connected', 'Dashboard is live and receiving data', icons.success, 'success');
  } else if (state === 'offline') {
    showToast('Disconnected', 'Lost connection to server. Reconnecting...', icons.warning, 'warning');
  }
}

// SVG icons for soil levels
const soilIcons = {
  'Very Dry': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
  'Dry': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 15h8"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
  'Good': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
  'Moist': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
  'Saturated': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>'
};

function setSoilLevel(l) {
  document.getElementById('soil-icon').innerHTML = soilIcons[l.label] || soilIcons['Good'];
  document.getElementById('soil-label').textContent = l.label;
  document.getElementById('soil-banner').style.borderColor = l.color + '66';
  document.getElementById('soil-banner').style.color       = l.color;
}

// ── Ring ───────────────────────────────────────
const RING_CIRC = 502;
function updateRing(pct, color) {
  const arc = document.getElementById('ring-arc');
  const val = document.getElementById('moist-val');
  arc.style.strokeDashoffset = RING_CIRC - (pct / 100) * (RING_CIRC * 0.75);
  arc.style.stroke = color;
  val.textContent = pct;
  val.style.color = color;
  document.getElementById('moist-fill').style.width      = pct + '%';
  document.getElementById('moist-fill').style.background = `linear-gradient(90deg,${color},#00d2ff)`;
  document.getElementById('moist-fill').style.boxShadow  = `0 0 12px ${color}66`;
  document.getElementById('moist-thumb').style.left        = pct + '%';
  document.getElementById('moist-thumb').style.borderColor = color;
}

// SVG icons for valve states
const valveIcons = {
  open: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>',
  closed: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
};

// ── Valve ─────────────────────────────────────
let lastValveState = 'CLOSE';

function updateValve(valve, wateringMinutes) {
  const circle = document.getElementById('valve-circle');
  const iconEl = document.getElementById('valve-emoji');
  const status = document.getElementById('valve-status');
  const sub    = document.getElementById('valve-sub');
  const ripple = document.getElementById('valve-ripple');
  const wrap   = document.getElementById('valve-icon-wrap');
  const isOpen = valve === 'OPEN';

  status.textContent = isOpen ? 'OPEN' : 'CLOSED';
  status.style.color = isOpen ? '#2ed573' : '#ff4757';
  iconEl.innerHTML   = isOpen ? valveIcons.open : valveIcons.closed;
  circle.style.background = isOpen ? 'linear-gradient(135deg,#2ed573,#00d2ff)' : 'linear-gradient(135deg,#ff4757,#ff6b35)';
  circle.style.boxShadow  = isOpen ? '0 0 30px rgba(46,213,115,.5)' : '0 0 30px rgba(255,71,87,.3)';
  sub.textContent = isOpen ? 'Watering in progress...' : 'Idle — waiting for dry soil';

  if (isOpen) {
    ripple.classList.add('active');
    wrap.classList.add('watering');
    document.getElementById('card-valve').classList.add('watering');
    if (lastValveState !== 'OPEN' && wateringMinutes) {
      startCountdown(wateringMinutes);
    }
  } else {
    ripple.classList.remove('active');
    wrap.classList.remove('watering');
    document.getElementById('card-valve').classList.remove('watering');
    stopCountdown();
  }
  
  lastValveState = valve;
}

function updateRaw(raw) {
  document.getElementById('raw-val').textContent = raw !== null ? raw : '--';
}

// ── Countdown Timer ────────────────────────────
const COUNTDOWN_CIRC = 264;

function startCountdown(durationMinutes) {
  const totalSeconds = durationMinutes * 60;
  countdownEndTime = Date.now() + (totalSeconds * 1000);
  
  const wrap = document.getElementById('countdown-wrap');
  const arcEl = document.getElementById('countdown-arc');
  const valEl = document.getElementById('countdown-val');
  const textEl = document.getElementById('countdown-text');
  
  wrap.hidden = false;
  wrap.classList.remove('warning', 'critical');
  
  if (countdownInterval) clearInterval(countdownInterval);
  
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((countdownEndTime - Date.now()) / 1000));
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    
    valEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    
    const progress = 1 - (remaining / totalSeconds);
    arcEl.style.strokeDashoffset = COUNTDOWN_CIRC * progress;
    
    wrap.classList.remove('warning', 'critical');
    if (remaining <= 10) {
      wrap.classList.add('critical');
      textEl.textContent = 'Valve closing soon...';
    } else if (remaining <= 30) {
      wrap.classList.add('warning');
      textEl.textContent = 'Almost done watering...';
    } else {
      textEl.textContent = 'Watering in progress...';
    }
    
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      setTimeout(() => { wrap.hidden = true; }, 1500);
    }
  }, 1000);
  
  document.getElementById('countdown-val').textContent = `${durationMinutes}:00`;
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  document.getElementById('countdown-wrap').hidden = true;
  document.getElementById('countdown-wrap').classList.remove('warning', 'critical');
}

// ── Weather (DHT) ─────────────────────────────
// Only shown when a reading carries air humidity/temperature.
function updateWeather(reading) {
  const card = document.getElementById('card-weather');
  if (reading.humidity === null || reading.humidity === undefined) return;

  card.hidden = false;
  document.getElementById('weather-humidity').textContent = reading.humidity;
  document.getElementById('weather-temp').textContent    = reading.temperature ?? '--';
  document.getElementById('weather-heat').textContent     = reading.heatIndex ?? '--';
  flashCard('card-weather');
}

// ── Mini Stats ────────────────────────────────
let lastReadingTime = null;

function updateMini(reading) {
  document.getElementById('mini-device-val').textContent = reading.device;
  document.getElementById('mini-count-val').textContent  = totalCount;
  lastReadingTime = new Date(reading.timestamp);
  updateLastSeen();
  updateDataIndicator();
  const slice = history.slice(0, 10);
  if (slice.length) {
    const avg = (slice.reduce((s, r) => s + parseFloat(r.moisture), 0) / slice.length).toFixed(1);
    document.getElementById('mini-avg-val').textContent = avg + '%';
  }
}

function updateLastSeen() {
  if (!lastReadingTime) {
    document.getElementById('mini-last-val').textContent = '—';
    return;
  }
  const now = new Date();
  const diff = Math.floor((now - lastReadingTime) / 1000);
  
  let text;
  if (diff < 5) {
    text = 'Just now';
  } else if (diff < 60) {
    text = diff + 's ago';
  } else if (diff < 3600) {
    text = Math.floor(diff / 60) + 'm ago';
  } else {
    text = Math.floor(diff / 3600) + 'h ago';
  }
  
  document.getElementById('mini-last-val').textContent = text;
  
  // Update color based on freshness
  const el = document.getElementById('mini-last-val');
  if (diff < 10) {
    el.style.color = '#2ed573'; // green - fresh
  } else if (diff < 30) {
    el.style.color = '#ffa502'; // orange - getting old
  } else {
    el.style.color = '#ff4757'; // red - stale
  }
}

function updateDataIndicator() {
  const indicator = document.getElementById('data-indicator');
  const timeEl = document.getElementById('data-time');
  
  if (!lastReadingTime) {
    indicator.className = 'data-indicator';
    timeEl.textContent = 'No data';
    updateCardOfflineStates(true);
    return;
  }
  
  const now = new Date();
  const diff = Math.floor((now - lastReadingTime) / 1000);
  
  let text, className;
  let isOffline = false;
  if (diff < 10) {
    text = 'Live';
    className = 'data-indicator active';
  } else if (diff < 60) {
    text = diff + 's ago';
    className = 'data-indicator active';
  } else if (diff < 300) {
    text = Math.floor(diff / 60) + 'm ago';
    className = 'data-indicator stale';
  } else {
    text = 'Offline';
    className = 'data-indicator dead';
    isOffline = true;
  }
  
  timeEl.textContent = text;
  indicator.className = className;
  updateCardOfflineStates(isOffline);
}

function updateCardOfflineStates(isOffline) {
  const cards = ['card-moisture', 'card-valve', 'card-weather'];
  cards.forEach(id => {
    const card = document.getElementById(id);
    if (card) {
      if (isOffline) {
        card.classList.add('card-offline');
      } else {
        card.classList.remove('card-offline');
      }
    }
  });
  
  // Update valve sub text
  const valveSub = document.getElementById('valve-sub');
  if (valveSub && isOffline && lastValveState !== 'OPEN') {
    valveSub.textContent = 'Sensor offline — no data';
  }
  
  // Stop countdown when offline
  if (isOffline) {
    stopCountdown();
  }
}

// Update indicators every second
setInterval(() => {
  updateLastSeen();
  updateDataIndicator();
}, 1000);

// ── Table ─────────────────────────────────────
function updateTable() {
  const body = document.getElementById('tbl-body');
  
  if (history.length === 0) {
    body.innerHTML = `<tr class="empty"><td colspan="7"><div class="empty-state"><div class="empty-state-icon">📡</div><div class="empty-state-title">Waiting for sensor data</div><div class="empty-state-desc">Connect your ESP32 to start receiving moisture readings. Check the Setup Guide for help.</div></div></td></tr>`;
    return;
  }
  
  const rows = history.slice(0, 15).map((r, i) => {
    const t = new Date(r.timestamp).toLocaleTimeString('en-GB');
    const vc = r.valve === 'OPEN' ? '#2ed573' : '#ff4757';
    const moistureDisplay = r.moisture !== null ? r.moisture + '%' : '--';
    const levelColor = r.level ? r.level.color : '#4a6070';
    const levelLabel = r.level ? r.level.label : '--';
    return `<tr class="${i===0?'new-row':''}">
      <td class="mono">${totalCount-i}</td><td>${escapeHtml(r.device)}</td>
      <td style="font-weight:800;color:${levelColor}">${moistureDisplay}</td>
      <td class="mono">${r.raw??'--'}</td>
      <td><span class="pill" style="color:${vc};background:${vc}15;border-color:${vc}44">${r.valve==='OPEN'?'💦':'🚫'} ${r.valve}</span></td>
      <td><span class="pill" style="color:${levelColor};background:${levelColor}15;border-color:${levelColor}44">${levelLabel}</span></td>
      <td class="mono">${t}</td></tr>`;
  }).join('');
  body.innerHTML = rows;
}

// ── Chart ─────────────────────────────────────
function initChart() {
  const ctx = document.getElementById('mainChart').getContext('2d');
  const gM = ctx.createLinearGradient(0,0,0,250);
  gM.addColorStop(0,'rgba(46,213,115,.3)'); gM.addColorStop(1,'rgba(46,213,115,0)');
  const gR = ctx.createLinearGradient(0,0,0,250);
  gR.addColorStop(0,'rgba(0,210,255,.3)'); gR.addColorStop(1,'rgba(0,210,255,0)');

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label:'Moisture %', data:[], borderColor:'#2ed573', backgroundColor:gM, borderWidth:2.5, pointRadius:3, tension:.4, pointBackgroundColor:'#2ed573', fill:true, yAxisID:'y' },
        { label:'Raw ADC', data:[], borderColor:'#00d2ff', backgroundColor:gR, borderWidth:2.5, pointRadius:3, tension:.4, pointBackgroundColor:'#00d2ff', fill:true, yAxisID:'y1', hidden:true }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      interaction:{intersect:false,mode:'index'},
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#0b0f1e',borderColor:'rgba(0,210,255,.3)',borderWidth:1,titleColor:'#4a6070',bodyColor:'#ddeeff',padding:12}},
      scales:{
        x:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#4a6070',font:{size:10},maxTicksLimit:8,maxRotation:0}},
        y:{min:0,max:100,position:'left',grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#2ed573',font:{size:10},callback:v=>v+'%'}},
        y1:{min:0,max:4095,position:'right',grid:{drawOnChartArea:false},ticks:{color:'#00d2ff',font:{size:10}}}
      },
      animation:{duration:500}
    }
  });
}

function updateChart() {
  const slice = [...history].reverse().slice(-chartRange);
  chart.data.labels = slice.map(r => new Date(r.timestamp).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}));
  chart.data.datasets[0].data = slice.map(r => parseFloat(r.moisture));
  chart.data.datasets[1].data = slice.map(r => r.raw !== null ? parseInt(r.raw) : null);
  chart.update('none');
}

// ── Toast ─────────────────────────────────────
let tTimer = null;
const toastIcons = {
  success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
  error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
  warning: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>'
};

function showToast(title, msg, icon, type='warning') {
  document.getElementById('toast-title').textContent = title;
  document.getElementById('toast-msg').textContent   = msg;
  document.getElementById('toast-icon').innerHTML    = icon || toastIcons[type] || toastIcons.warning;
  const t = document.getElementById('toast');
  
  // Set color based on type
  t.style.borderColor = type === 'success' ? 'rgba(46,213,115,.4)' : 
                         type === 'error' ? 'rgba(255,71,87,.4)' : 
                         type === 'info' ? 'rgba(0,210,255,.4)' : 'var(--border)';
  
  t.classList.add('show');
  clearTimeout(tTimer);
  tTimer = setTimeout(() => {
    t.classList.remove('show');
    t.style.borderColor = 'var(--border)';
  }, type === 'error' ? 8000 : 5000);
  
  // Announce to screen readers
  const ariaLive = document.getElementById('aria-live');
  if (ariaLive) {
    ariaLive.textContent = `${title}. ${msg}`;
    setTimeout(() => { ariaLive.textContent = ''; }, 1000);
  }
}

function flashCard(id) {
  const c = document.getElementById(id);
  if (!c) return;
  c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
}

// ── Process Reading ───────────────────────────
function processReading(reading) {
  totalCount++;
  history.unshift(reading);
  if (history.length > 200) history.pop();

  const wateringMinutes = reading.config ? reading.config.wateringMinutes : 3;
  if (reading.level) updateRing(parseFloat(reading.moisture), reading.level.color);
  updateValve(reading.valve, wateringMinutes);
  updateRaw(reading.raw);
  if (reading.level) setSoilLevel(reading.level);
  updateMini(reading);
  updateTable();
  updateChart();
  updateWeather(reading);
  flashCard('card-moisture');
  flashCard('card-valve');
}

// ── SSE ───────────────────────────────────────
function connectSSE() {
  setStatus('connecting');
  if (evtSrc) evtSrc.close();
  evtSrc = new EventSource('/api/events');

  evtSrc.onopen = () => { setStatus('online'); clearTimeout(rTimer); };

  evtSrc.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'init') {
        if (msg.data.history && msg.data.history.length) {
          history = msg.data.history;
          totalCount = history.length;
          const r = history[0];
          const wateringMinutes = msg.data.config ? msg.data.config.wateringMinutes : 3;
          if (r.level) updateRing(parseFloat(r.moisture), r.level.color);
          updateValve(r.valve, wateringMinutes);
          updateRaw(r.raw);
          if (r.level) setSoilLevel(r.level);
          updateMini(r);
          updateTable();
          updateChart();
          updateWeather(r);
        }
        if (msg.data.config) handleConfigUpdate(msg.data.config);
      } else if (msg.type === 'reading') {
        processReading(msg.data);
        if (msg.data.config) handleConfigUpdate(msg.data.config);
      } else if (msg.type === 'config') {
        handleConfigUpdate(msg.data);
      }
    } catch(err) { console.warn(err); }
  };

  evtSrc.onerror = () => { setStatus('offline'); evtSrc.close(); rTimer = setTimeout(connectSSE, 5000); };
}

// ── Toggles ───────────────────────────────────
document.querySelectorAll('.tog').forEach(btn => {
  btn.addEventListener('click', () => {
    const ds = parseInt(btn.dataset.ds);
    btn.classList.toggle('active');
    chart.data.datasets[ds].hidden = !btn.classList.contains('active');
    chart.update();
  });
});
document.querySelectorAll('.rbtn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rbtn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartRange = parseInt(btn.dataset.n);
    updateChart();
  });
});

// ── Config UI ───────────────────────────────────
let saveTimer = null;

function clampConfig(cfg) {
  return {
    openThreshold: Math.min(95, Math.max(5, Math.round(cfg.openThreshold || 40))),
    wateringMinutes: Math.min(30, Math.max(1, Math.round(cfg.wateringMinutes || 3)))
  };
}

function loadConfig() {
  fetch('/api/config').then(r => r.json()).then(cfg => {
    const c = clampConfig(cfg);
    currentConfig = c;
    document.getElementById('cfg-threshold').value = c.openThreshold;
    document.getElementById('cfg-threshold-val').textContent = c.openThreshold;
    document.getElementById('cfg-duration').value = c.wateringMinutes;
    document.getElementById('cfg-duration-val').textContent = c.wateringMinutes;
    updatePresetActive('threshold-presets', c.openThreshold);
    updatePresetActive('duration-presets', c.wateringMinutes);
  }).catch(() => {});
}

function saveConfig(data) {
  const statusEl = document.getElementById('config-save-status');
  const textEl = document.getElementById('config-save-text');
  statusEl.classList.add('saving');
  statusEl.classList.remove('saved');
  textEl.textContent = 'Saving…';

  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
  .then(r => r.json())
  .then(res => {
    if (res.ok) {
      statusEl.classList.remove('saving');
      statusEl.classList.add('saved');
      textEl.textContent = 'Saved';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        statusEl.classList.remove('saved');
        textEl.textContent = 'Synced';
      }, 2000);
      showToast('Config Updated', 'Watering settings saved successfully', toastIcons.success, 'success');
    }
  })
  .catch(() => {
    statusEl.classList.remove('saving');
    textEl.textContent = 'Error';
    showToast('Save Failed', 'Could not save configuration. Try again.', toastIcons.error, 'error');
  });
}

// ── Threshold Slider ─────────────────────────
document.getElementById('cfg-threshold').addEventListener('input', e => {
  const val = parseInt(e.target.value);
  currentConfig.openThreshold = val;
  document.getElementById('cfg-threshold-val').textContent = val;
  updatePresetActive('threshold-presets', val);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveConfig({ openThreshold: val }), 500);
});

// ── Duration Slider ──────────────────────────
document.getElementById('cfg-duration').addEventListener('input', e => {
  const val = parseInt(e.target.value);
  currentConfig.wateringMinutes = val;
  document.getElementById('cfg-duration-val').textContent = val;
  updatePresetActive('duration-presets', val);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveConfig({ wateringMinutes: val }), 500);
});

// ── Preset Buttons ───────────────────────────
function updatePresetActive(containerId, value) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.val) === value);
  });
}

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const val = parseInt(btn.dataset.val);
    const slider = btn.closest('.config-setting').querySelector('.cfg-slider');
    if (slider) {
      slider.value = val;
      slider.dispatchEvent(new Event('input'));
    }
  });
});

// ── Reset WiFi Button ────────────────────────
document.getElementById('reset-wifi-btn').addEventListener('click', () => {
  if (!confirm('Reset WiFi? ESP32 will reboot and open setup portal.')) return;
  
  fetch('/api/reset-wifi', { method: 'POST' })
    .then(r => r.json())
    .then(res => {
      if (res.ok) {
        showToast('WiFi Reset', 'ESP32 will reboot into setup mode', toastIcons.warning, 'warning');
      }
    })
    .catch(() => {
      showToast('Error', 'Failed to reset WiFi', toastIcons.error, 'error');
    });
});

// Handle SSE config updates from other clients
function handleConfigUpdate(cfg) {
  const c = clampConfig(cfg);
  currentConfig = c;
  document.getElementById('cfg-threshold').value = c.openThreshold;
  document.getElementById('cfg-threshold-val').textContent = c.openThreshold;
  document.getElementById('cfg-duration').value = c.wateringMinutes;
  document.getElementById('cfg-duration-val').textContent = c.wateringMinutes;
  updatePresetActive('threshold-presets', c.openThreshold);
  updatePresetActive('duration-presets', c.wateringMinutes);
  
  // Restart countdown if valve is currently open
  if (lastValveState === 'OPEN' && countdownInterval) {
    startCountdown(c.wateringMinutes);
  }
}

// ── Guide ─────────────────────────────────────
document.getElementById('guide-btn').addEventListener('click', () => document.getElementById('guide-modal').classList.add('open'));
document.getElementById('guide-btn').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    document.getElementById('guide-modal').classList.add('open');
  }
});
document.getElementById('guide-close').addEventListener('click', () => document.getElementById('guide-modal').classList.remove('open'));
document.getElementById('guide-close').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    document.getElementById('guide-modal').classList.remove('open');
  }
});
document.getElementById('guide-modal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });
document.getElementById('guide-modal').addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('guide-modal').classList.remove('open');
});
fetch('/api/data').then(r=>r.json()).then(()=>{
  const host = location.hostname;
  document.querySelectorAll('#guide-ip,#guide-ep').forEach(el => el.textContent = host);
}).catch(()=>{});

// ── Keyboard Shortcuts ────────────────────────
document.addEventListener('keydown', e => {
  // Ctrl/Cmd + G = Open Guide
  if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
    e.preventDefault();
    document.getElementById('guide-modal').classList.add('open');
  }
  // Escape = Close modal
  if (e.key === 'Escape') {
    document.getElementById('guide-modal').classList.remove('open');
  }
  // 1/2/3 = Switch chart range
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === '1') document.querySelector('.rbtn[data-n="20"]')?.click();
    if (e.key === '2') document.querySelector('.rbtn[data-n="50"]')?.click();
    if (e.key === '3') document.querySelector('.rbtn[data-n="100"]')?.click();
  }
});

// ── Init ──────────────────────────────────────
initChart();
connectSSE();
loadConfig();
