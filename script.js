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
let currentConfig = { wateringMinutes: 3, openThreshold: 40, cropId: 'custom', valveOverride: null };
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

var lanBtn = document.getElementById('lan-btn');
if (lanBtn) lanBtn.addEventListener('click', setLanIp);

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
  var newState = diff < 60 ? 'online' : 'offline';
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
  if (lastSeenState === 'online') {
    var wantTxt = 'Connected' + (isLanFresh() ? ' · LAN' : '');
    if (txt.textContent !== wantTxt) txt.textContent = wantTxt;
  }
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
  if (offline) { hideClock(); firstReading = true; setESP32Status(false); }
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
            c.wateringMinutes !== currentConfig.wateringMinutes ||
            c.cropId !== currentConfig.cropId ||
            JSON.stringify(c.valveOverride) !== JSON.stringify(currentConfig.valveOverride)) {
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
            if (diffSec < 60) {
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

// ── LAN fast path (ESP32 direct, Agriscan-style) ──
// Cloud (Render free) is slow: TLS handshake + cold starts. When this device
// is on the same WiFi as the ESP32, poll it directly every 3s over plain HTTP.
// Cloud SSE/poll stays as fallback + history/config source.
// NOTE: var (not let) — updateLastSeen above reads these every second.
var lanBase = null;   // working origin, e.g. http://192.168.1.50
var lanFreshAt = 0;   // last successful LAN poll
var lanBusy = false;

function lanCandidates() {
  var list = [];
  var custom = null;
  try { custom = localStorage.getItem('agriflow_esp32_ip'); } catch (e) {}
  if (custom) {
    var u = custom.trim();
    if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
    if (u) list.push(u.replace(/\/+$/, ''));
  }
  if (lanBase) list.push(lanBase);
  list.push('http://agriflow.local');
  return list.filter(function(u, i) { return list.indexOf(u) === i; });
}

function setLanIp() {
  var cur = '';
  try { cur = localStorage.getItem('agriflow_esp32_ip') || ''; } catch (e) {}
  var input = prompt('IP ของ ESP32 ใน WiFi วงเดียวกัน (เช่น 192.168.1.50)\nเว้นว่าง = ใช้ agriflow.local อัตโนมัติ', cur);
  if (input === null) return;
  try {
    if (input.trim()) localStorage.setItem('agriflow_esp32_ip', input.trim());
    else localStorage.removeItem('agriflow_esp32_ip');
  } catch (e) {}
  lanBase = null;
  pollLan();
}

function handleLanReading(j) {
  var m = parseFloat(j.moisture);
  var color = m < 20 ? '#ff4757' : m < 40 ? '#ff6b35' : m < 60 ? '#2ed573' : m < 80 ? '#00d2ff' : '#7b2ff7';
  var label = m < 20 ? 'Very Dry' : m < 40 ? 'Dry' : m < 60 ? 'Good' : m < 80 ? 'Moist' : 'Saturated';
  processReading({
    device: j.device || 'ESP32',
    raw: j.raw !== undefined ? j.raw : null,
    moisture: String(j.moisture),
    valve: j.valve || 'CLOSE',
    level: { label: label, color: color },
    humidity: null, temperature: null, heatIndex: null,
    config: (typeof currentConfig !== 'undefined' && currentConfig) ? currentConfig : null,
    timestamp: new Date().toISOString()
  }, false);
  lastReadingTime = Date.now();
  updateLastSeen();
}

function pollLan() {
  if (lanBusy || document.visibilityState === 'hidden') return;
  lanBusy = true;
  var cands = lanCandidates();
  var i = 0;
  function next() {
    if (i >= cands.length) { lanBusy = false; return; }
    var base = cands[i++];
    var ctrl = new AbortController();
    var to = setTimeout(function() { ctrl.abort(); }, 2500);
    fetch(base + '/local-data', { signal: ctrl.signal })
      .then(function(res) { clearTimeout(to); if (!res.ok) throw 0; return res.json(); })
      .then(function(j) {
        if (j.moisture === undefined) throw 0;
        lanBase = base;
        lanFreshAt = Date.now();
        handleLanReading(j);
        lanBusy = false;
      })
      .catch(function() { next(); });
  }
  next();
}
setInterval(pollLan, 3000);

function isLanFresh() { return Date.now() - lanFreshAt < 10000; }

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
        // Skip cloud echo while LAN fast path feeds fresher same-value data
        var last = history.length ? history[history.length - 1] : null;
        var dup = isLanFresh() && last && msg.data &&
          last.device === msg.data.device &&
          String(last.moisture) === String(msg.data.moisture) &&
          last.valve === msg.data.valve;
        if (!dup) processReading(msg.data, false);
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

// ── Crop presets (mirror of server; refreshed from /api/crops when online) ──
let cropProfiles = [
  { id: 'rice', name: 'ข้าว', threshold: 70, minutes: 10, source: 'FAO-56 p=0.20', confidence: 'high', hint: 'นาข้าวชอบแฉะ' },
  { id: 'corn', name: 'ข้าวโพด', threshold: 45, minutes: 5, source: 'FAO-56 p=0.50-0.55', confidence: 'high', hint: '' },
  { id: 'rubber', name: 'ยางพารา', threshold: 40, minutes: 3, source: 'FAO-56 p=0.40', confidence: 'medium', hint: '' },
  { id: 'longan', name: 'ลำไย', threshold: 45, minutes: 5, source: 'proxy fruit trees', confidence: 'low', hint: '' },
  { id: 'lychee', name: 'ลิ้นจี่', threshold: 45, minutes: 5, source: 'proxy fruit trees', confidence: 'low', hint: '' },
  { id: 'durian', name: 'ทุเรียน', threshold: 45, minutes: 5, source: 'Thai res VWC<0.19', confidence: 'medium', hint: '' },
  { id: 'cassava', name: 'มันสำปะหลัง', threshold: 35, minutes: 2, source: 'FAO-56 p=0.35', confidence: 'medium', hint: '' },
  { id: 'potato', name: 'มันอาลู (มันฝรั่ง)', threshold: 55, minutes: 4, source: 'FAO-56 p=0.35', confidence: 'high', hint: '' },
  { id: 'shallot', name: 'หอม', threshold: 55, minutes: 3, source: 'FAO-56 p=0.30', confidence: 'high', hint: '' },
  { id: 'garlic', name: 'กระเทียม', threshold: 55, minutes: 3, source: 'FAO-56 p=0.30', confidence: 'high', hint: '' },
  { id: 'mangosteen', name: 'มังคุด', threshold: 45, minutes: 5, source: 'Salakpetch/IoT 2024', confidence: 'medium', hint: '' },
  { id: 'jujube', name: 'พุทรา', threshold: 40, minutes: 3, source: '80-100% ETc', confidence: 'medium', hint: '' },
  { id: 'watermelon', name: 'แตงโม', threshold: 50, minutes: 4, source: 'FAO-56 p=0.40', confidence: 'high', hint: '' },
  { id: 'pumpkin', name: 'ฟักทอง', threshold: 50, minutes: 4, source: 'FAO-56 p=0.35', confidence: 'high', hint: '' },
  { id: 'kitchen', name: 'ผักสวนครัว', threshold: 55, minutes: 3, source: 'FAO-56 p=0.30-0.45', confidence: 'medium', hint: '' },
  { id: 'pomelo', name: 'ส้มโอ', threshold: 45, minutes: 5, source: 'FAO citrus p=0.50', confidence: 'high', hint: '' },
  { id: 'guava', name: 'ฝรั่ง', threshold: 40, minutes: 4, source: 'proxy citrus/fruit', confidence: 'low', hint: '' },
  { id: 'custom', name: 'กำหนดเอง', threshold: null, minutes: null, source: 'user-defined', confidence: 'high', hint: '' }
];
function findCropProfile(id) { return cropProfiles.filter(function(c) { return c.id === id; })[0] || null; }

function updateCropHint(crop) {
  var el = document.getElementById('crop-hint');
  if (!el) return;
  if (!crop || crop.id === 'custom') { el.textContent = 'ปรับ slider เองตามดินหน้างาน — เวลารดเป็นค่าประมาณตามระบบน้ำ'; return; }
  var conf = crop.confidence === 'low' ? 'ค่าประมาณ — ควรปรับหน้างาน' : crop.confidence === 'medium' ? 'เชื่อถือปานกลาง' : 'งานวิจัยรองรับดี';
  el.textContent = 'เกณฑ์ ' + crop.name + ': <' + crop.threshold + '% รด ' + crop.minutes + ' นาที | ' + crop.source + ' (' + conf + ')' + (crop.hint ? ' — ' + crop.hint : '');
}

function populateCropSelect(selectedId) {
  var sel = document.getElementById('cfg-crop');
  if (!sel) return;
  var cur = selectedId || sel.value || 'custom';
  var html = '';
  for (var i = 0; i < cropProfiles.length; i++) {
    var c = cropProfiles[i];
    html += '<option value="' + c.id + '"' + (c.id === cur ? ' selected' : '') + '>' + c.name + (c.threshold != null ? ' — <' + c.threshold + '%' : '') + '</option>';
  }
  sel.innerHTML = html;
}

function loadCrops() {
  fetch('/api/crops').then(function(r) { return r.json(); }).then(function(list) {
    if (list && list.length) { cropProfiles = list; populateCropSelect(currentConfig.cropId); updateCropHint(findCropProfile(currentConfig.cropId)); }
  }).catch(function() { populateCropSelect(currentConfig.cropId); });
}

// Config
function clampConfig(cfg) {
  var cropId = (cfg && cfg.cropId) || 'custom';
  if (!findCropProfile(cropId)) cropId = 'custom';
  return { openThreshold: Math.min(95, Math.max(5, Math.round((cfg && cfg.openThreshold) || 40))), wateringMinutes: Math.min(30, Math.max(1, Math.round((cfg && cfg.wateringMinutes) || 3))), cropId: cropId, valveOverride: (cfg && cfg.valveOverride) || null };
}

// ── Manual valve override (temporary) ──
function updateManualUI() {
  var el = document.getElementById('manual-sub');
  if (!el) return;
  var o = currentConfig.valveOverride;
  if (o && o.expiresAt > Date.now()) {
    var secs = Math.max(0, Math.round((o.expiresAt - Date.now()) / 1000));
    el.hidden = false;
    el.textContent = 'Manual ' + o.action + ' เหลือ ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') + ' → กลับ auto เอง';
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}
setInterval(updateManualUI, 1000);

function sendValve(action) {
  // LAN first (instant on same WiFi), cloud fallback
  if (isLanFresh() && lanBase) {
    var ctrl = new AbortController();
    var to = setTimeout(function() { ctrl.abort(); }, 2500);
    fetch(lanBase + '/local-valve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action }), signal: ctrl.signal })
    .then(function(r) { clearTimeout(to); if (!r.ok) throw 0; return r.json(); })
    .then(function() {
      showToast('Valve', action === 'auto' ? 'กลับโหมด auto แล้ว (LAN)' : 'สั่ง ' + action + ' แล้ว (LAN)');
    })
    .catch(function() { sendValveCloud(action); });
    return;
  }
  sendValveCloud(action);
}

function sendValveCloud(action) {
  fetch('/api/valve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action }) })
  .then(function(r) { return r.json().then(function(j) { return { status: r.status, body: j }; }); })
  .then(function(res) {
    if (res.status === 200 && res.body.ok) {
      handleConfigUpdate(res.body.config);
      showToast('Valve', action === 'auto' ? 'กลับโหมด auto แล้ว' : 'สั่ง ' + action + ' แล้ว (' + currentConfig.wateringMinutes + ' นาที)');
    } else {
      showToast('Error', (res.body && res.body.error) || 'สั่งวาล์วไม่สำเร็จ');
    }
  })
  .catch(function() { showToast('Error', 'สั่งวาล์วไม่สำเร็จ'); });
}

function loadConfig() {
  fetch('/api/config').then(function(r) { return r.json(); }).then(function(cfg) {
    var c = clampConfig(cfg); currentConfig = c; pendingConfig = Object.assign({}, c);
    populateCropSelect(c.cropId); updateCropHint(findCropProfile(c.cropId));
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
  var c = clampConfig(cfg);
  var changed = c.wateringMinutes !== currentConfig.wateringMinutes;
  currentConfig = c; pendingConfig = Object.assign({}, c);
  updateManualUI();
  populateCropSelect(c.cropId); updateCropHint(findCropProfile(c.cropId));
  document.getElementById('cfg-threshold').value = c.openThreshold;
  document.getElementById('cfg-threshold-val').textContent = c.openThreshold;
  document.getElementById('cfg-duration').value = c.wateringMinutes;
  document.getElementById('cfg-duration-val').textContent = c.wateringMinutes;
  updatePresets('threshold-presets', c.openThreshold);
  updatePresets('duration-presets', c.wateringMinutes);
  if (lastValveState === 'OPEN' && countdownInterval && changed) startCountdown(c.wateringMinutes);
}

function updatePresets(id, value) {
  document.querySelectorAll('#' + id + ' .preset').forEach(function(btn) { btn.classList.toggle('active', parseInt(btn.dataset.val) === value); });
}

// Slider events (manual move → drop preset to custom)
function markCustom() {
  pendingConfig = pendingConfig || Object.assign({}, currentConfig);
  pendingConfig.cropId = 'custom';
  var sel = document.getElementById('cfg-crop');
  if (sel) sel.value = 'custom';
  updateCropHint(findCropProfile('custom'));
}
document.getElementById('cfg-threshold').addEventListener('input', function(e) {
  var val = parseInt(e.target.value); pendingConfig = pendingConfig || Object.assign({}, currentConfig); pendingConfig.openThreshold = val;
  document.getElementById('cfg-threshold-val').textContent = val; updatePresets('threshold-presets', val);
  markCustom();
});
document.getElementById('cfg-duration').addEventListener('input', function(e) {
  var val = parseInt(e.target.value); pendingConfig = pendingConfig || Object.assign({}, currentConfig); pendingConfig.wateringMinutes = val;
  document.getElementById('cfg-duration-val').textContent = val; updatePresets('duration-presets', val);
  markCustom();
});

// Crop select — picking a crop auto-fills threshold + duration (save to apply)
document.getElementById('cfg-crop').addEventListener('change', function(e) {
  var crop = findCropProfile(e.target.value);
  if (!crop) return;
  updateCropHint(crop);
  if (crop.id === 'custom') {
    pendingConfig = pendingConfig || Object.assign({}, currentConfig);
    pendingConfig.cropId = 'custom';
    return;
  }
  pendingConfig = { openThreshold: crop.threshold, wateringMinutes: crop.minutes, cropId: crop.id };
  document.getElementById('cfg-threshold').value = crop.threshold;
  document.getElementById('cfg-threshold-val').textContent = crop.threshold;
  document.getElementById('cfg-duration').value = crop.minutes;
  document.getElementById('cfg-duration-val').textContent = crop.minutes;
  updatePresets('threshold-presets', crop.threshold);
  updatePresets('duration-presets', crop.minutes);
  showToast('เกณฑ์' + crop.name, '<' + crop.threshold + '% รด ' + crop.minutes + ' นาที — กด Save เพื่อใช้');
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
document.getElementById('manual-open-btn').addEventListener('click', function() { sendValve('open'); });
document.getElementById('manual-stop-btn').addEventListener('click', function() { sendValve('auto'); });

function getResetToken() {
  var t = localStorage.getItem('agriflow-reset-token') || '';
  if (!t) {
    t = prompt('Reset token (ตั้งใน Render env RESET_TOKEN, ว่างได้ถ้า dev):', '') || '';
    if (t) localStorage.setItem('agriflow-reset-token', t);
  }
  return t;
}
document.getElementById('reset-wifi-btn').addEventListener('click', function() {
  if (!confirm('Reset WiFi? ESP32 จะ reboot แล้วเปิด AP Agriflow-Setup')) return;
  var token = getResetToken();
  showToast('WiFi Reset', 'สั่งรีเซ็ตแล้ว รอ ESP ออฟไลน์...');
  fetch('/api/reset-wifi', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-reset-token': token }, body: JSON.stringify({ token: token }) })
  .then(function(r) { return r.json().then(function(j) { return { status: r.status, body: j }; }); })
  .then(function(res) {
    if (res.status === 403) { localStorage.removeItem('agriflow-reset-token'); showToast('Error', 'Token ผิด ลองใหม่'); return; }
    if (res.body.ok) {
      showToast('WiFi Reset', 'ESP32 จะ reboot ใน ~5 วิ');
      var t0 = Date.now();
      var checker = setInterval(function() {
        if (!lastReadingTime || Date.now() - lastReadingTime > 15000 || Date.now() - t0 > 60000) {
          clearInterval(checker);
          showToast('WiFi Reset', 'ต่อ WiFi Agriflow-Setup แล้วเปิด 192.168.4.1');
        }
      }, 3000);
    } else { showToast('Error', 'สั่งรีเซ็ตไม่สำเร็จ'); }
  }).catch(function() { showToast('Error', 'สั่งรีเซ็ตไม่สำเร็จ'); });
});

// Guide
document.getElementById('guide-btn').addEventListener('click', function() { document.getElementById('guide-modal').classList.add('open'); });
document.getElementById('guide-close').addEventListener('click', function() { document.getElementById('guide-modal').classList.remove('open'); });
document.getElementById('guide-modal').addEventListener('click', function(e) { if (e.target === e.currentTarget) e.target.classList.remove('open'); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') document.getElementById('guide-modal').classList.remove('open'); });

// Init
cacheDom();
initChart();
populateCropSelect('custom');
loadConfig();
loadCrops();
pollLan();
startPolling();
connectSSE();

// Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(function(reg) {
    reg.onupdatefound = function() {
      var newWorker = reg.installing;
      newWorker.onstatechange = function() {
        if (newWorker.state === 'activated') {
          caches.keys().then(function(keys) {
            return Promise.all(keys.filter(function(k) { return k !== 'agriflow-v3'; }).map(function(k) { return caches.delete(k); }));
          });
        }
      };
    };
  }).catch(function() {});
}
