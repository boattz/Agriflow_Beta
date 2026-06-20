// Agriflow — Dashboard

let history = [];
let chartRange = 20;
let totalCount = 0;
let chart = null;
let valveStates = [];
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
let firstReading = true;
let reconnectAttempts = 0;

// Clock
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
  document.getElementById('status-dot').className = 'dot ' + state;
  document.getElementById('status-txt').textContent = state === 'online' ? 'Connected' : state === 'offline' ? 'Disconnected' : 'Connecting';
  if (state === 'offline') { hideClock(); showToast('Server', 'Disconnected'); }
}

function setESP32Status(connected) {
  document.getElementById('esp-dot').className = 'dot ' + (connected ? 'online' : 'offline');
  document.getElementById('esp-txt').textContent = connected ? 'Connected' : 'No data';
}

function updateLastSeen() {
  var dot = document.getElementById('esp-dot');
  var txt = document.getElementById('esp-txt');
  if (!lastReadingTime) {
    dot.className = 'dot offline';
    txt.textContent = 'No data';
    document.getElementById('mini-last-val').textContent = '—';
    return;
  }
  var diff = Math.floor((Date.now() - lastReadingTime) / 1000);
  if (diff < 30) { dot.className = 'dot online'; txt.textContent = 'Connected'; }
  else { dot.className = 'dot offline'; txt.textContent = 'Offline'; }
  var text;
  if (diff < 5) text = 'Just now';
  else if (diff < 60) text = diff + 's ago';
  else if (diff < 3600) text = Math.floor(diff / 60) + 'm ago';
  else text = Math.floor(diff / 3600) + 'h ago';
  document.getElementById('mini-last-val').textContent = text;
}
setInterval(updateLastSeen, 1000);

// Ring
var RING_CIRC = 502;
function updateRing(pct, color) {
  document.getElementById('ring-arc').style.strokeDashoffset = RING_CIRC - (pct / 100) * RING_CIRC;
  document.getElementById('ring-arc').style.stroke = color;
  document.getElementById('moist-val').textContent = pct;
  document.getElementById('moist-val').style.color = color;
  document.getElementById('moist-fill').style.width = pct + '%';
  document.getElementById('moist-fill').style.background = color;
}

function setSoilLevel(level) {
  if (!level) return;
  var banner = document.getElementById('soil-banner');
  var label = document.getElementById('soil-label');
  label.textContent = level.label;
  banner.style.background = level.color + '22';
  banner.style.color = level.color;
}

// Valve
function updateValve(valve, wateringMinutes) {
  var icon = document.getElementById('valve-icon');
  var status = document.getElementById('valve-status');
  var sub = document.getElementById('valve-sub');
  var isOpen = valve === 'OPEN';
  status.textContent = isOpen ? 'Watering' : 'Idle';
  status.style.color = isOpen ? 'var(--green)' : 'var(--muted)';
  sub.textContent = isOpen ? 'In progress...' : 'Waiting for soil to dry';
  icon.className = isOpen ? 'valve-icon active' : 'valve-icon';
  if (isOpen && lastValveState !== 'OPEN' && wateringMinutes && !isOffline) startCountdown(wateringMinutes);
  if (!isOpen) stopCountdown();
  lastValveState = valve;
}

// Countdown
function startCountdown(minutes) {
  countdownEndTime = Date.now() + (minutes * 60 * 1000);
  var wrap = document.getElementById('countdown-wrap');
  var val = document.getElementById('countdown-val');
  wrap.hidden = false;
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(function() {
    var remaining = Math.max(0, Math.floor((countdownEndTime - Date.now()) / 1000));
    var m = Math.floor(remaining / 60);
    var s = remaining % 60;
    val.textContent = m + ':' + String(s).padStart(2, '0');
    val.style.color = remaining <= 10 ? 'var(--red)' : remaining <= 30 ? 'var(--orange)' : 'var(--green)';
    if (remaining <= 0) { clearInterval(countdownInterval); countdownInterval = null; setTimeout(function() { wrap.hidden = true; }, 1000); }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  document.getElementById('countdown-wrap').hidden = true;
}

function updateOfflineState(offline) {
  isOffline = offline;
  if (offline) { stopCountdown(); hideClock(); firstReading = true; setESP32Status(false); }
}

// Table
function updateTable() {
  var body = document.getElementById('tbl-body');
  if (history.length === 0) { body.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">📡</div><div class="empty-title">Waiting for data</div><div class="empty-desc">Connect your ESP32 to start</div></div></td></tr>'; return; }
  body.innerHTML = history.slice(0, 10).map(function(r, i) {
    var t = new Date(r.timestamp).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
    var m = r.moisture !== null ? r.moisture + '%' : '--';
    var v = r.valve === 'OPEN';
    return '<tr><td class="mono">' + (totalCount - i) + '</td><td>' + r.device + '</td><td style="font-weight:600">' + m + '</td><td><span class="pill ' + (v ? 'pill-green' : 'pill-gray') + '">' + (v ? 'Open' : 'Closed') + '</span></td><td class="mono">' + t + '</td></tr>';
  }).join('');
}

// ── Gradient fill plugin ──
var gradientPlugin = {
  id: 'gradientFill',
  beforeDraw: function(chart) {
    var ctx = chart.ctx;
    var chartArea = chart.chartArea;
    if (!chartArea) return;
    var gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, 'rgba(34,197,94,0.25)');
    gradient.addColorStop(0.5, 'rgba(34,197,94,0.08)');
    gradient.addColorStop(1, 'rgba(34,197,94,0.01)');
    chart.data.datasets[0].backgroundColor = gradient;
  }
};

// ── Threshold line plugin ──
var thresholdPlugin = {
  id: 'thresholdLine',
  afterDraw: function(chart) {
    if (!currentConfig || currentConfig.openThreshold == null) return;
    var ctx = chart.ctx;
    var chartArea = chart.chartArea;
    if (!chartArea) return;
    var yScale = chart.scales.y;
    var y = yScale.getPixelForValue(currentConfig.openThreshold);
    if (y < chartArea.top || y > chartArea.bottom) return;
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(239,68,68,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(239,68,68,0.6)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('Threshold ' + currentConfig.openThreshold + '%', chartArea.right - 6, y - 5);
    ctx.restore();
  }
};

// Chart
function initChart() {
  var ctx = document.getElementById('mainChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Moisture %',
        data: [],
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.08)',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 7,
        pointHoverBackgroundColor: '#22c55e',
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
        tension: 0.4,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#f1f5f9',
          titleFont: { size: 11, weight: '600' },
          bodyColor: '#22c55e',
          bodyFont: { size: 14, weight: '700' },
          borderColor: 'rgba(34,197,94,0.2)',
          borderWidth: 1,
          padding: { x: 14, y: 10 },
          cornerRadius: 10,
          displayColors: false,
          callbacks: {
            title: function(items) {
              if (!items.length) return '';
              return items[0].label;
            },
            label: function(context) {
              return 'Moisture: ' + context.parsed.y + '%';
            },
            afterLabel: function(context) {
              var valve = valveStates[context.dataIndex] || 'CLOSED';
              var icon = valve === 'OPEN' ? '● Open' : '○ Closed';
              return 'Valve: ' + icon;
            }
          }
        }
      },
      interaction: {
        mode: 'nearest',
        axis: 'x',
        intersect: false
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 },
          border: { display: false }
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#64748b', font: { size: 10 }, callback: function(v) { return v + '%'; } },
          border: { display: false }
        }
      },
      animation: { duration: 300 }
    },
    plugins: [gradientPlugin, thresholdPlugin]
  });
}

function updateChart() {
  if (!chart) return;
  var slice = history.slice().reverse().slice(-chartRange);
  chart.data.labels = slice.map(function(r) { return new Date(r.timestamp).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'}); });
  chart.data.datasets[0].data = slice.map(function(r) { return parseFloat(r.moisture); });
  valveStates = slice.map(function(r) { return r.valve === 'OPEN' ? 'OPEN' : 'CLOSED'; });
  chart.update('none');
}

// Toast
var tTimer = null;
function showToast(title, msg) {
  document.getElementById('toast-title').textContent = title;
  document.getElementById('toast-msg').textContent = msg;
  var t = document.getElementById('toast');
  t.classList.add('show');
  clearTimeout(tTimer);
  tTimer = setTimeout(function() { t.classList.remove('show'); }, 3000);
  var ariaLive = document.getElementById('aria-live');
  if (ariaLive) { ariaLive.textContent = title + '. ' + msg; setTimeout(function() { ariaLive.textContent = ''; }, 1000); }
}

// Process reading
function processReading(reading, fromHistory) {
  if (firstReading && !fromHistory) { showToast('ESP32 Connected', 'Receiving sensor data'); firstReading = false; showClock(); }
  setESP32Status(true);
  totalCount++;
  history.unshift(reading);
  if (history.length > 200) history.pop();
  var wm = reading.config ? reading.config.wateringMinutes : 3;
  if (reading.level) { updateRing(parseFloat(reading.moisture), reading.level.color); setSoilLevel(reading.level); }
  if (!fromHistory) updateValve(reading.valve, wm);
  document.getElementById('mini-device-val').textContent = reading.device;
  lastReadingTime = Date.now();
  updateLastSeen();
  var slice = history.slice(0, 10);
  if (slice.length) { var avg = (slice.reduce(function(s, r) { return s + parseFloat(r.moisture || 0); }, 0) / slice.length).toFixed(1); document.getElementById('mini-avg-val').textContent = avg + '%'; }
  updateTable();
  updateChart();
}

// Polling for config sync (backup for SSE)
let pollTimer = null;
const POLL_INTERVAL = 5000; // 5 seconds

function startPolling() {
  stopPolling();
  console.log('[POLL] Starting polling every', POLL_INTERVAL/1000, 'seconds');
  pollTimer = setInterval(function() {
    fetch('/api/config')
      .then(function(r) { return r.json(); })
      .then(function(cfg) {
        var c = clampConfig(cfg);
        if (c.openThreshold !== currentConfig.openThreshold || 
            c.wateringMinutes !== currentConfig.wateringMinutes) {
          console.log('[POLL] Config change detected!', c);
          handleConfigUpdate(c);
          showToast('Synced', 'Settings updated');
        }
        if (isOffline) {
          setStatus('online');
          updateOfflineState(false);
        }
      })
      .catch(function(err) {
        console.error('[POLL] Failed:', err);
      });
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// SSE
function connectSSE() {
  setStatus('connecting');
  if (evtSrc) { evtSrc.close(); evtSrc = null; }
  
  var sseUrl = window.location.origin + '/api/events';
  console.log('[SSE] Connecting to:', sseUrl);
  
  try {
    evtSrc = new EventSource(sseUrl);
  } catch(err) {
    console.error('[SSE] Failed:', err);
    setStatus('offline');
    startPolling();
    return;
  }
  
  evtSrc.onopen = function() { 
    setStatus('online'); 
    clearTimeout(rTimer); 
    updateOfflineState(false); 
    console.log('[SSE] Connected');
  };
  
  evtSrc.onmessage = function(e) {
    try {
      if (e.data.startsWith(':')) return; // skip pings
      var msg = JSON.parse(e.data);
      console.log('[SSE] Received:', msg.type);
      
      if (msg.type === 'init') {
        if (msg.data.history && msg.data.history.length) { history = msg.data.history; totalCount = history.length; processReading(history[0], true); }
        if (msg.data.config) handleConfigUpdate(msg.data.config);
      } else if (msg.type === 'reading') {
        processReading(msg.data, false);
        if (msg.data.config) handleConfigUpdate(msg.data.config);
      } else if (msg.type === 'config') {
        console.log('[SSE] Config update!');
        handleConfigUpdate(msg.data);
        showToast('Synced', 'Settings updated');
      }
    } catch(err) {}
  };
  
  evtSrc.onerror = function() {
    console.log('[SSE] Error, readyState:', evtSrc ? evtSrc.readyState : 'null');
    if (document.visibilityState === 'hidden') {
      if (evtSrc) evtSrc.close();
      return;
    }
    setStatus('offline');
    updateOfflineState(true);
    if (evtSrc) evtSrc.close();
    var retryDelay = Math.min(30000, 2000 * Math.pow(2, reconnectAttempts));
    reconnectAttempts++;
    rTimer = setTimeout(connectSSE, retryDelay);
  };
}

// Config
function clampConfig(cfg) {
  return { openThreshold: Math.min(95, Math.max(5, Math.round(cfg.openThreshold || 40))), wateringMinutes: Math.min(30, Math.max(1, Math.round(cfg.wateringMinutes || 3))) };
}

function loadConfig() {
  fetch('/api/config').then(function(r) { return r.json(); }).then(function(cfg) {
    var c = clampConfig(cfg); currentConfig = c; pendingConfig = Object.assign({}, c);
    document.getElementById('cfg-threshold').value = c.openThreshold;
    document.getElementById('cfg-threshold-val').textContent = c.openThreshold;
    document.getElementById('cfg-duration').value = c.wateringMinutes;
    document.getElementById('cfg-duration-val').textContent = c.wateringMinutes;
    updatePresets('threshold-presets', c.openThreshold);
    updatePresets('duration-presets', c.wateringMinutes);
  }).catch(function() {});
}

function saveConfig(data) {
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  .then(function(r) { return r.json(); })
  .then(function(res) { if (res.ok) { currentConfig = Object.assign({}, pendingConfig); showToast('Saved', 'Settings updated'); } })
  .catch(function() { showToast('Error', 'Could not save'); });
}

function handleConfigUpdate(cfg) {
  var c = clampConfig(cfg); currentConfig = c; pendingConfig = Object.assign({}, c);
  document.getElementById('cfg-threshold').value = c.openThreshold;
  document.getElementById('cfg-threshold-val').textContent = c.openThreshold;
  document.getElementById('cfg-duration').value = c.wateringMinutes;
  document.getElementById('cfg-duration-val').textContent = c.wateringMinutes;
  updatePresets('threshold-presets', c.openThreshold);
  updatePresets('duration-presets', c.wateringMinutes);
  if (lastValveState === 'OPEN' && countdownInterval) startCountdown(c.wateringMinutes);
}

function updatePresets(id, value) {
  document.querySelectorAll('#' + id + ' .preset').forEach(function(btn) { btn.classList.toggle('active', parseInt(btn.dataset.val) === value); });
}

// Slider events
document.getElementById('cfg-threshold').addEventListener('input', function(e) {
  var val = parseInt(e.target.value); pendingConfig = pendingConfig || Object.assign({}, currentConfig); pendingConfig.openThreshold = val;
  document.getElementById('cfg-threshold-val').textContent = val; updatePresets('threshold-presets', val);
});
document.getElementById('cfg-duration').addEventListener('input', function(e) {
  var val = parseInt(e.target.value); pendingConfig = pendingConfig || Object.assign({}, currentConfig); pendingConfig.wateringMinutes = val;
  document.getElementById('cfg-duration-val').textContent = val; updatePresets('duration-presets', val);
});

// Preset buttons
document.querySelectorAll('.preset').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var val = parseInt(btn.dataset.val); var slider = btn.closest('.config-row').querySelector('input[type="range"]');
    if (slider) { slider.value = val; slider.dispatchEvent(new Event('input')); }
  });
});

// Chart range buttons
document.querySelectorAll('.chart-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.chart-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active'); chartRange = parseInt(btn.dataset.n); updateChart();
  });
});

// Buttons
document.getElementById('save-config-btn').addEventListener('click', function() { if (pendingConfig) saveConfig(pendingConfig); });
document.getElementById('reset-wifi-btn').addEventListener('click', function() {
  if (!confirm('Reset WiFi? ESP32 will reboot.')) return;
  fetch('/api/reset-wifi', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(res) { if (res.ok) showToast('WiFi Reset', 'ESP32 rebooting...'); }).catch(function() { showToast('Error', 'Failed'); });
});

// Guide
document.getElementById('guide-btn').addEventListener('click', function() { document.getElementById('guide-modal').classList.add('open'); });
document.getElementById('guide-close').addEventListener('click', function() { document.getElementById('guide-modal').classList.remove('open'); });
document.getElementById('guide-modal').addEventListener('click', function(e) { if (e.target === e.currentTarget) e.target.classList.remove('open'); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') document.getElementById('guide-modal').classList.remove('open'); });

// Init
initChart();
loadConfig();
startPolling(); // Polling first (primary sync)
connectSSE();  // SSE as bonus
