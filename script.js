// Agriflow — Dashboard

// Unregister any old service workers
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function(regs) {
    regs.forEach(function(r) { r.unregister(); });
  });
  caches.keys().then(function(keys) { keys.forEach(function(k) { caches.delete(k); }); });
}

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
let pendingTableUpdate = false;
let pendingChartUpdate = false;
let lastScheduledUpdate = 0;

// Theme
(function() {
  var saved = localStorage.getItem('agriflow-theme');
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var theme = saved || (prefersDark ? 'dark' : 'dark');
  document.documentElement.setAttribute('data-theme', theme);
})();

function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('agriflow-theme', next);
  if (chart) {
    var isLight = next === 'light';
    var textColor = isLight ? '#334155' : '#64748b';
    var gridColor = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)';
    chart.options.scales.x.ticks.color = textColor;
    chart.options.scales.y.ticks.color = textColor;
    chart.options.scales.y.grid.color = gridColor;
    chart.update('none');
  }
}

var themeBtn = document.getElementById('theme-btn');
if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

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

var lastSeenText = '';
var lastSeenState = '';
function updateLastSeen() {
  var dot = document.getElementById('esp-dot');
  var txt = document.getElementById('esp-txt');
  var lastVal = document.getElementById('mini-last-val');
  if (!lastReadingTime) {
    if (lastSeenState !== 'nodata') {
      dot.className = 'dot offline';
      txt.textContent = 'No data';
      lastVal.textContent = '—';
      lastSeenState = 'nodata';
    }
    return;
  }
  var diff = Math.floor((Date.now() - lastReadingTime) / 1000);
  var newState = diff < 30 ? 'online' : 'offline';
  if (newState !== lastSeenState) {
    dot.className = 'dot ' + newState;
    txt.textContent = newState === 'online' ? 'Connected' : 'Disconnected';
    lastSeenState = newState;
    if (newState === 'offline') {
      lastVal.textContent = '—';
      lastSeenText = '';
      return;
    }
  }
  if (newState === 'offline') return;
  var text;
  if (diff < 5) text = 'Just now';
  else if (diff < 60) text = diff + 's ago';
  else if (diff < 3600) text = Math.floor(diff / 60) + 'm ago';
  else text = Math.floor(diff / 3600) + 'h ago';
  if (text !== lastSeenText) {
    lastVal.textContent = text;
    lastSeenText = text;
  }
}
setInterval(updateLastSeen, 1000);

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') {
    if (evtSrc) evtSrc.close();
  } else {
    if (!evtSrc || evtSrc.readyState === EventSource.CLOSED) connectSSE();
  }
});

// Ring
var RING_CIRC = 502;
var ringArc, moistVal, moistFill;
function cacheDom() {
  ringArc = document.getElementById('ring-arc');
  moistVal = document.getElementById('moist-val');
  moistFill = document.getElementById('moist-fill');
}
function updateRing(pct, color) {
  ringArc.style.strokeDashoffset = RING_CIRC - (pct / 100) * RING_CIRC;
  ringArc.style.stroke = color;
  moistVal.textContent = pct;
  moistVal.style.color = color;
  moistFill.style.width = pct + '%';
  moistFill.style.background = color;
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
var _tableRows = [];
function updateTable() {
  var body = document.getElementById('tbl-body');
  if (history.length === 0) { body.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">📡</div><div class="empty-title">Waiting for data</div><div class="empty-desc">Connect your ESP32 to start</div></div></td></tr>'; return; }
  var recent = history.slice(-10).reverse();
  var html = '';
  for (var i = 0; i < recent.length; i++) {
    var r = recent[i];
    var t = new Date(r.timestamp).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
    var m = r.moisture !== null ? r.moisture + '%' : '--';
    var v = r.valve === 'OPEN';
    var idx = totalCount - i;
    if (_tableRows[i] && _tableRows[i].idx === idx && _tableRows[i].m === m && _tableRows[i].v === v && _tableRows[i].t === t && _tableRows[i].d === r.device) continue;
    _tableRows[i] = { idx: idx, m: m, v: v, t: t, d: r.device };
    html += '<tr><td class="mono">' + idx + '</td><td>' + r.device + '</td><td style="font-weight:600">' + m + '</td><td><span class="pill ' + (v ? 'pill-green' : 'pill-gray') + '">' + (v ? 'Open' : 'Closed') + '</span></td><td class="mono">' + t + '</td></tr>';
  }
  if (html) body.innerHTML = html;
}

// Schedule batched DOM updates
var _pendingGradient = null;
function scheduleUpdate() {
  var now = performance.now();
  if (now - lastScheduledUpdate > 200) {
    lastScheduledUpdate = now;
    requestAnimationFrame(function() {
      updateTable();
      updateChart();
    });
  }
}

// ── Gradient fill plugin ──
var gradientPlugin = {
  id: 'gradientFill',
  beforeDraw: function(chart) {
    var ctx = chart.ctx;
    var chartArea = chart.chartArea;
    if (!chartArea) return;
    var w = chartArea.right - chartArea.left;
    var h = chartArea.bottom - chartArea.top;
    if (_pendingGradient && _pendingGradient.w === w && _pendingGradient.h === h) {
      chart.data.datasets[0].backgroundColor = _pendingGradient.g;
      return;
    }
    var gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, 'rgba(34,197,94,0.25)');
    gradient.addColorStop(0.5, 'rgba(34,197,94,0.08)');
    gradient.addColorStop(1, 'rgba(34,197,94,0.01)');
    chart.data.datasets[0].backgroundColor = gradient;
    _pendingGradient = { g: gradient, w: w, h: h };
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
  var isLight = document.documentElement.getAttribute('data-theme') === 'light';
  var textColor = isLight ? '#334155' : '#64748b';
  var gridColor = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)';
  var tooltipBg = isLight ? 'rgba(255,255,255,0.95)' : 'rgba(15,23,42,0.95)';
  var tooltipTitle = isLight ? '#0f172a' : '#f1f5f9';
  var tooltipBorder = isLight ? 'rgba(22,163,74,0.2)' : 'rgba(34,197,94,0.2)';
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
          backgroundColor: tooltipBg,
          titleColor: tooltipTitle,
          titleFont: { size: 11, weight: '600' },
          bodyColor: '#22c55e',
          bodyFont: { size: 14, weight: '700' },
          borderColor: tooltipBorder,
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
          ticks: { color: textColor, font: { size: 10 }, maxTicksLimit: 8 },
          border: { display: false }
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 10 }, callback: function(v) { return v + '%'; } },
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
  var len = history.length;
  var start = Math.max(0, len - chartRange);
  var labels = new Array(len - start);
  var data = new Array(len - start);
  valveStates = new Array(len - start);
  for (var i = start; i < len; i++) {
    var j = i - start;
    var r = history[i];
    labels[j] = new Date(r.timestamp).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    data[j] = parseFloat(r.moisture);
    valveStates[j] = r.valve === 'OPEN' ? 'OPEN' : 'CLOSED';
  }
  chart.data.labels = labels;
  chart.data.datasets[0].data = data;
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
  if (!fromHistory) setESP32Status(true);
  totalCount++;
  history.push(reading);
  if (history.length > 200) history.shift();
  var wm = reading.config ? reading.config.wateringMinutes : 3;
  if (reading.level) { updateRing(parseFloat(reading.moisture), reading.level.color); setSoilLevel(reading.level); }
  if (!fromHistory) updateValve(reading.valve, wm);
  document.getElementById('mini-device-val').textContent = reading.device;
  if (!fromHistory) {
    lastReadingTime = Date.now();
    updateLastSeen();
  }
  var slice = history.slice(-10);
  if (slice.length) { var avg = (slice.reduce(function(s, r) { return s + parseFloat(r.moisture || 0); }, 0) / slice.length).toFixed(1); document.getElementById('mini-avg-val').textContent = avg + '%'; }
  scheduleUpdate();
}

// Polling for config sync (backup for SSE)
let pollTimer = null;
const POLL_INTERVAL = 5000; // 5 seconds

function startPolling() {
  stopPolling();
  console.log('[POLL] Starting polling every', POLL_INTERVAL/1000, 'seconds');
  pollTimer = setInterval(function() {
    // 1. Check config changes
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
        console.error('[POLL] Config failed:', err);
      });
    
    // 2. Check new sensor data
    fetch('/api/data')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.latest && data.latest.timestamp) {
          var latestTime = new Date(data.latest.timestamp).getTime();
          var lastTime = lastReadingTime || 0;
          if (latestTime > lastTime) {
            console.log('[POLL] New sensor data!');
            processReading(data.latest, true);
            var diffSec = Math.floor((Date.now() - latestTime) / 1000);
            if (diffSec < 30) {
              lastReadingTime = Date.now();
              updateLastSeen();
            }
          }
        }
      })
      .catch(function(err) {
        console.error('[POLL] Data failed:', err);
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
    stopPolling();
    console.log('[SSE] Connected — polling stopped');
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
    evtSrc = null;
    startPolling();
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

// Guide — now links to PRESENTATION.html

// Init
cacheDom();
initChart();
loadConfig();
startPolling();
connectSSE();
