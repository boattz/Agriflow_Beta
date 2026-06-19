// Agriflow — Dashboard

let history = [];
let chartRange = 20;
let totalCount = 0;
let chart = null;
let evtSrc = null;
let rTimer = null;
let countdownInterval = null;
let countdownEndTime = null;
let currentConfig = { wateringMinutes: 3 };
let pendingConfig = null;
let lastValveState = 'CLOSE';
let isOffline = false;
let lastReadingTime = null;
let clockInterval = null;

// Clock - only show when ESP32 sends data
let clockInterval = null;
function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
}

function showClock() {
  if (!clockInterval) {
    updateClock();
    clockInterval = setInterval(updateClock, 1000);
    document.getElementById('clock').style.display = '';
  }
}

function hideClock() {
  if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
  document.getElementById('clock').style.display = 'none';
}

function setStatus(state) {
  document.getElementById('status-dot').className = `dot ${state}`;
  document.getElementById('status-txt').textContent = state === 'online' ? 'Live' : state === 'offline' ? 'Offline' : 'Connecting';
  
  if (state === 'offline') {
    hideClock();
    showToast('Disconnected', 'Reconnecting...');
  }
}

function setStatus(state) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-txt');
  const clock = document.getElementById('clock');
  
  dot.className = `dot ${state}`;
  txt.textContent = state === 'online' ? 'Live' : state === 'offline' ? 'Offline' : 'Connecting';
  
  if (state === 'online') {
    updateClock();
    if (!clockInterval) clockInterval = setInterval(updateClock, 1000);
    clock.style.display = '';
  } else {
    if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
    clock.style.display = 'none';
    if (state === 'offline') showToast('Disconnected', 'Reconnecting...');
  }
}

function updateDataIndicator() {
  const indicator = document.getElementById('data-indicator');
  const dot = document.getElementById('indicator-dot');
  const timeEl = document.getElementById('data-time');
  
  if (!lastReadingTime) {
    dot.className = 'indicator-dot';
    timeEl.textContent = 'No data';
    return;
  }
  
  const diff = Math.floor((Date.now() - lastReadingTime) / 1000);
  
  if (diff < 10) {
    dot.className = 'indicator-dot live';
    timeEl.textContent = 'Live';
  } else if (diff < 60) {
    dot.className = 'indicator-dot live';
    timeEl.textContent = diff + 's ago';
  } else if (diff < 300) {
    dot.className = 'indicator-dot stale';
    timeEl.textContent = Math.floor(diff / 60) + 'm ago';
  } else {
    dot.className = 'indicator-dot offline';
    timeEl.textContent = 'Offline';
  }
}

setInterval(updateDataIndicator, 1000);

// Ring
const RING_CIRC = 502;
function updateRing(pct, color) {
  document.getElementById('ring-arc').style.strokeDashoffset = RING_CIRC - (pct / 100) * RING_CIRC;
  document.getElementById('ring-arc').style.stroke = color;
  document.getElementById('moist-val').textContent = pct;
  document.getElementById('moist-val').style.color = color;
  document.getElementById('moist-fill').style.width = pct + '%';
  document.getElementById('moist-fill').style.background = color;
}

// Soil banner
function setSoilLevel(level) {
  const banner = document.getElementById('soil-banner');
  const label = document.getElementById('soil-label');
  if (level) {
    label.textContent = level.label;
    banner.style.background = level.color + '22';
    banner.style.color = level.color;
  }
}

// Valve
function updateValve(valve, wateringMinutes) {
  const icon = document.getElementById('valve-icon');
  const status = document.getElementById('valve-status');
  const sub = document.getElementById('valve-sub');
  const isOpen = valve === 'OPEN';

  status.textContent = isOpen ? 'Watering' : 'Idle';
  status.style.color = isOpen ? 'var(--green)' : 'var(--muted)';
  sub.textContent = isOpen ? 'In progress...' : 'Waiting for soil to dry';
  icon.className = isOpen ? 'valve-icon active' : 'valve-icon';

  if (isOpen && lastValveState !== 'OPEN' && wateringMinutes && !isOffline) {
    startCountdown(wateringMinutes);
  }
  if (!isOpen) stopCountdown();

  lastValveState = valve;
}

// Countdown
function startCountdown(minutes) {
  countdownEndTime = Date.now() + (minutes * 60 * 1000);
  const wrap = document.getElementById('countdown-wrap');
  const val = document.getElementById('countdown-val');
  wrap.hidden = false;

  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((countdownEndTime - Date.now()) / 1000));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    val.textContent = `${m}:${String(s).padStart(2, '0')}`;
    val.style.color = remaining <= 10 ? 'var(--red)' : remaining <= 30 ? 'var(--orange)' : 'var(--green)';
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      setTimeout(() => { wrap.hidden = true; }, 1000);
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  document.getElementById('countdown-wrap').hidden = true;
}

function updateOfflineState(offline) {
  isOffline = offline;
  if (offline) {
    stopCountdown();
    hideClock();
    firstReading = true;
  }
}

// Weather
function updateWeather(reading) {
  if (reading.humidity === null || reading.humidity === undefined) return;
  document.getElementById('card-weather').hidden = false;
  document.getElementById('weather-humidity').textContent = reading.humidity;
  document.getElementById('weather-temp').textContent = reading.temperature ?? '--';
  document.getElementById('weather-heat').textContent = reading.heatIndex ?? '--';
}

// Table
function updateTable() {
  const body = document.getElementById('tbl-body');
  if (history.length === 0) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">📡</div><div class="empty-title">Waiting for data</div><div class="empty-desc">Connect your ESP32 to start</div></div></td></tr>';
    return;
  }
  body.innerHTML = history.slice(0, 10).map((r, i) => {
    const t = new Date(r.timestamp).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
    const m = r.moisture !== null ? r.moisture + '%' : '--';
    const v = r.valve === 'OPEN';
    return `<tr>
      <td class="mono">${totalCount - i}</td>
      <td>${r.device}</td>
      <td style="font-weight:600">${m}</td>
      <td><span class="pill ${v ? 'pill-green' : 'pill-gray'}">${v ? 'Open' : 'Closed'}</span></td>
      <td class="mono">${t}</td>
    </tr>`;
  }).join('');
}

// Chart
function initChart() {
  const ctx = document.getElementById('mainChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Moisture %',
        data: [],
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.1)',
        borderWidth: 2,
        pointRadius: 3,
        tension: 0.4,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } },
        y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#22c55e', font: { size: 10 } } }
      },
      animation: { duration: 300 }
    }
  });
}

function updateChart() {
  if (!chart) return;
  const slice = [...history].reverse().slice(-chartRange);
  chart.data.labels = slice.map(r => new Date(r.timestamp).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'}));
  chart.data.datasets[0].data = slice.map(r => parseFloat(r.moisture));
  chart.update('none');
}

// Toast
let tTimer = null;
function showToast(title, msg) {
  document.getElementById('toast-title').textContent = title;
  document.getElementById('toast-msg').textContent = msg;
  const t = document.getElementById('toast');
  t.classList.add('show');
  clearTimeout(tTimer);
  tTimer = setTimeout(() => t.classList.remove('show'), 3000);
  const ariaLive = document.getElementById('aria-live');
  if (ariaLive) {
    ariaLive.textContent = `${title}. ${msg}`;
    setTimeout(() => { ariaLive.textContent = ''; }, 1000);
  }
}

// Last update
function updateLastSeen() {
  if (!lastReadingTime) {
    document.getElementById('mini-last-val').textContent = '—';
    return;
  }
  const diff = Math.floor((Date.now() - lastReadingTime) / 1000);
  let text;
  if (diff < 5) text = 'Just now';
  else if (diff < 60) text = diff + 's ago';
  else if (diff < 3600) text = Math.floor(diff / 60) + 'm ago';
  else text = Math.floor(diff / 3600) + 'h ago';
  document.getElementById('mini-last-val').textContent = text;
}

setInterval(updateLastSeen, 1000);

// Process reading
let firstReading = true;
function processReading(reading) {
  if (firstReading) {
    showToast('ESP32 Connected', 'Receiving sensor data');
    firstReading = false;
    showClock();
  }
  
  totalCount++;
  history.unshift(reading);
  if (history.length > 200) history.pop();

  const wm = reading.config ? reading.config.wateringMinutes : 3;
  if (reading.level) {
    updateRing(parseFloat(reading.moisture), reading.level.color);
    setSoilLevel(reading.level);
  }
  updateValve(reading.valve, wm);
  updateWeather(reading);

  document.getElementById('mini-device-val').textContent = reading.device;
  lastReadingTime = Date.now();
  updateLastSeen();

  const slice = history.slice(0, 10);
  if (slice.length) {
    const avg = (slice.reduce((s, r) => s + parseFloat(r.moisture || 0), 0) / slice.length).toFixed(1);
    document.getElementById('mini-avg-val').textContent = avg + '%';
  }

  updateTable();
  updateChart();
}

// SSE
function connectSSE() {
  setStatus('connecting');
  if (evtSrc) evtSrc.close();
  evtSrc = new EventSource('/api/events');
  evtSrc.onopen = () => { setStatus('online'); clearTimeout(rTimer); updateOfflineState(false); };
  evtSrc.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'init') {
        if (msg.data.history && msg.data.history.length) {
          history = msg.data.history;
          totalCount = history.length;
          processReading(history[0]);
        }
        if (msg.data.config) handleConfigUpdate(msg.data.config);
      } else if (msg.type === 'reading') {
        processReading(msg.data);
        if (msg.data.config) handleConfigUpdate(msg.data.config);
      } else if (msg.type === 'config') {
        handleConfigUpdate(msg.data);
      }
    } catch(err) {}
  };
  evtSrc.onerror = () => { setStatus('offline'); updateOfflineState(true); evtSrc.close(); rTimer = setTimeout(connectSSE, 5000); };
}

// Config
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
    pendingConfig = { ...c };
    document.getElementById('cfg-threshold').value = c.openThreshold;
    document.getElementById('cfg-threshold-val').textContent = c.openThreshold;
    document.getElementById('cfg-duration').value = c.wateringMinutes;
    document.getElementById('cfg-duration-val').textContent = c.wateringMinutes;
    updatePresets('threshold-presets', c.openThreshold);
    updatePresets('duration-presets', c.wateringMinutes);
  }).catch(() => {});
}

function saveConfig(data) {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(r => r.json()).then(res => {
    if (res.ok) {
      currentConfig = { ...pendingConfig };
      showToast('Saved', 'Settings updated');
    }
  }).catch(() => showToast('Error', 'Could not save'));
}

function handleConfigUpdate(cfg) {
  const c = clampConfig(cfg);
  currentConfig = c;
  pendingConfig = { ...c };
  document.getElementById('cfg-threshold').value = c.openThreshold;
  document.getElementById('cfg-threshold-val').textContent = c.openThreshold;
  document.getElementById('cfg-duration').value = c.wateringMinutes;
  document.getElementById('cfg-duration-val').textContent = c.wateringMinutes;
  updatePresets('threshold-presets', c.openThreshold);
  updatePresets('duration-presets', c.wateringMinutes);
  if (lastValveState === 'OPEN' && countdownInterval) startCountdown(c.wateringMinutes);
}

function updatePresets(id, value) {
  document.querySelectorAll(`#${id} .preset`).forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.val) === value);
  });
}

// Slider events
document.getElementById('cfg-threshold').addEventListener('input', e => {
  const val = parseInt(e.target.value);
  pendingConfig = pendingConfig || { ...currentConfig };
  pendingConfig.openThreshold = val;
  document.getElementById('cfg-threshold-val').textContent = val;
  updatePresets('threshold-presets', val);
});

document.getElementById('cfg-duration').addEventListener('input', e => {
  const val = parseInt(e.target.value);
  pendingConfig = pendingConfig || { ...currentConfig };
  pendingConfig.wateringMinutes = val;
  document.getElementById('cfg-duration-val').textContent = val;
  updatePresets('duration-presets', val);
});

// Preset buttons
document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const val = parseInt(btn.dataset.val);
    const slider = btn.closest('.config-row').querySelector('input[type="range"]');
    if (slider) { slider.value = val; slider.dispatchEvent(new Event('input')); }
  });
});

// Chart range buttons
document.querySelectorAll('.chart-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartRange = parseInt(btn.dataset.n);
    updateChart();
  });
});

// Save button
document.getElementById('save-config-btn').addEventListener('click', () => {
  if (pendingConfig) saveConfig(pendingConfig);
});

// WiFi reset
document.getElementById('reset-wifi-btn').addEventListener('click', () => {
  if (!confirm('Reset WiFi? ESP32 will reboot.')) return;
  fetch('/api/reset-wifi', { method: 'POST' }).then(r => r.json()).then(res => {
    if (res.ok) showToast('WiFi Reset', 'ESP32 rebooting...');
  }).catch(() => showToast('Error', 'Failed to reset'));
});

// Guide
document.getElementById('guide-btn').addEventListener('click', () => document.getElementById('guide-modal').classList.add('open'));
document.getElementById('guide-close').addEventListener('click', () => document.getElementById('guide-modal').classList.remove('open'));
document.getElementById('guide-modal').addEventListener('click', e => { if (e.target === e.currentTarget) e.target.classList.remove('open'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('guide-modal').classList.remove('open'); });

// Init
initChart();
connectSSE();
loadConfig();
