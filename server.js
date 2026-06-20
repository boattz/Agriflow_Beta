require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const os      = require('os');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 10000;

const ALLOWED_ORIGINS = [
  process.env.RENDER_EXTERNAL_URL,
  'http://localhost:' + PORT,
  'http://127.0.0.1:' + PORT
].filter(Boolean);

app.use(cors({
  origin: function(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, false);
  }
}));
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const rateLimitStore = {};
function rateLimit(max, windowMs) {
  return function(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    if (!rateLimitStore[ip] || rateLimitStore[ip].reset < now) {
      rateLimitStore[ip] = { count: 1, reset: now + windowMs };
      return next();
    }
    rateLimitStore[ip].count++;
    if (rateLimitStore[ip].count > max) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(rateLimitStore)) {
    if (rateLimitStore[ip].reset < now) delete rateLimitStore[ip];
  }
}, 60000);

// ── Health Check (for Render.com) ─────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: dbReady ? 'connected' : 'disconnected' });
});

const STATIC_ALLOWED = ['.html', '.css', '.js', '.json', '.png', '.jpg', '.svg', '.ico'];
const BLOCKED_FILES = ['.env', 'server.js', 'package.json', 'package-lock.json', 'Procfile', 'render.yaml'];

app.use(express.static(__dirname, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath);
    const base = path.basename(filePath);
    if (!STATIC_ALLOWED.includes(ext) || BLOCKED_FILES.includes(base)) {
      res.status(403).end();
    }
    if (ext === '.html') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (ext === '.js' || ext === '.css') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ── PostgreSQL Connection (Supabase Pooler) ───
const dbUrl = process.env.DATABASE_URL;
console.log('[DB] Configured:', dbUrl ? 'YES' : 'NO');

const pool = new Pool({
  connectionString: dbUrl || 'postgresql://localhost:5432/postgres',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

let dbReady = false;

async function connectDB() {
  try {
    const client = await pool.connect();
    console.log('[DB] Connected to PostgreSQL (Supabase)');

    // Create tables if not exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS readings (
        id BIGSERIAL PRIMARY KEY,
        device VARCHAR(50),
        raw INT,
        moisture DECIMAL(5,1),
        valve VARCHAR(10),
        level_label VARCHAR(20),
        level_color VARCHAR(10),
        humidity DECIMAL(5,1),
        temperature DECIMAL(5,1),
        heat_index DECIMAL(5,1),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS config (
        id INT PRIMARY KEY DEFAULT 1,
        open_threshold INT DEFAULT 40,
        watering_minutes INT DEFAULT 3,
        reset_wifi BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Insert default config if not exist
    await client.query(`
      INSERT INTO config (id, open_threshold, watering_minutes)
      VALUES (1, 40, 3)
      ON CONFLICT (id) DO NOTHING
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_readings_created_at ON readings (created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_readings_device ON readings (device)`);

    client.release();
    dbReady = true;
    console.log('[DB] Tables ready');
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    console.log('[DB] Retrying in 5 seconds...');
    setTimeout(connectDB, 5000);
  }
}

connectDB();

// ── Config ───────────────────────────────────
let config = {
  openThreshold:   40,
  wateringMinutes: 3,
  resetWifi:       false
};

async function loadConfig() {
  if (!dbReady) return;
  try {
    const result = await pool.query('SELECT * FROM config WHERE id = 1');
    if (result.rows.length) {
      config.openThreshold   = result.rows[0].open_threshold;
      config.wateringMinutes = result.rows[0].watering_minutes;
    }
  } catch (err) {
    console.error('[DB] Load config failed:', err.message);
  }
}

async function saveConfig() {
  if (!dbReady) return;
  try {
    await pool.query(
      'UPDATE config SET open_threshold = $1, watering_minutes = $2, reset_wifi = $3 WHERE id = 1',
      [config.openThreshold, config.wateringMinutes, config.resetWifi]
    );
  } catch (err) {
    console.error('[DB] Save config failed:', err.message);
  }
}

// ── Keep-Alive Ping ──────────────────────────
const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000;
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || `https://agriflow-mvt7.onrender.com`;

setInterval(() => {
  fetch(KEEP_ALIVE_URL)
    .then(() => console.log(`[KEEP-ALIVE] Pinged at ${new Date().toISOString()}`))
    .catch(() => {});
}, KEEP_ALIVE_INTERVAL);

// ── SSE Clients ──────────────────────────────
let clients = [];
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(c => { try { c.write(msg); return true; } catch { return false; } });
}

// ── Soil Moisture Level ──────────────────────
function soilLevel(moisture) {
  if (moisture < 20)                         return { label: 'Very Dry',  color: '#ff4757' };
  if (moisture >= 20 && moisture < 40)       return { label: 'Dry',       color: '#ff6b35' };
  if (moisture >= 40 && moisture < 60)       return { label: 'Good',      color: '#2ed573' };
  if (moisture >= 60 && moisture < 80)       return { label: 'Moist',     color: '#00d2ff' };
  return                                            { label: 'Saturated', color: '#7b2ff7' };
}

// ── GET /api/config ──────────────────────────
app.get('/api/config', (req, res) => {
  res.json(config);
});

// ── POST /api/config ─────────────────────────
app.post('/api/config', rateLimit(30, 60000), async (req, res) => {
  const { openThreshold, wateringMinutes } = req.body;

  if (openThreshold !== undefined)   config.openThreshold   = Math.max(5, Math.min(95, parseInt(openThreshold)));
  if (wateringMinutes !== undefined) config.wateringMinutes = Math.max(1, Math.min(30, parseInt(wateringMinutes)));

  console.log(`[CONFIG] Open <${config.openThreshold}% | Water ${config.wateringMinutes} min`);
  await saveConfig();
  broadcast({ type: 'config', data: config });
  res.json({ ok: true, config });
});

// ── POST /api/reset-wifi ─────────────────────
app.post('/api/reset-wifi', rateLimit(5, 60000), async (req, res) => {
  console.log('[RESET] WiFi reset requested from dashboard');
  config.resetWifi = true;
  await saveConfig();
  broadcast({ type: 'config', data: config });
  res.json({ ok: true, message: 'ESP32 will reset WiFi on next send' });
});

// ── POST /api/sensor ─────────────────────────
app.post('/api/sensor', rateLimit(60, 60000), async (req, res) => {
  const {
    raw, moisture, valve, device, threshold, wateringMinutes: wm,
    humidity, temperature, heatIndex
  } = req.body;

  if (moisture === undefined && humidity === undefined) {
    return res.status(400).json({ error: 'Missing moisture or humidity' });
  }

  const id    = (typeof device === 'string' && device.length <= 50) ? device.replace(/[<>"'&]/g, '') : 'ESP32';
  const ts    = new Date().toISOString();
  const level = moisture !== undefined ? soilLevel(parseFloat(moisture)) : null;

  const reading = {
    device:      id,
    raw:         raw         !== undefined ? parseInt(raw)                  : null,
    moisture:    moisture    !== undefined ? parseFloat(moisture).toFixed(1) : null,
    valve:       valve       || 'CLOSE',
    level,
    humidity:    humidity    !== undefined ? parseFloat(humidity).toFixed(1)    : null,
    temperature: temperature !== undefined ? parseFloat(temperature).toFixed(1) : null,
    heatIndex:   heatIndex   !== undefined ? parseFloat(heatIndex).toFixed(1)   : null,
    config:      { ...config },
    timestamp:   ts
  };

  // Save to PostgreSQL
  if (dbReady) {
    try {
      await pool.query(
        `INSERT INTO readings (device, raw, moisture, valve, level_label, level_color, humidity, temperature, heat_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, reading.raw, reading.moisture, reading.valve,
         level?.label || null, level?.color || null,
         reading.humidity, reading.temperature, reading.heatIndex]
      );
    } catch (err) {
      console.error('[DB] Save reading failed:', err.message);
    }
  }

  const mPart = reading.moisture !== null ? `Moisture: ${reading.moisture}% | ` : '';
  const dhtPart = reading.humidity !== null ? `H: ${reading.humidity}% T: ${reading.temperature}°C | ` : '';
  console.log(`[${ts}] ${id} — ${mPart}${dhtPart}Valve: ${valve}${level ? ' | ' + level.label : ''}`);

  broadcast({ type: 'reading', data: reading });
  res.json({ ok: true, reading, config });
});

// ── GET /api/data ────────────────────────────
app.get('/api/data', async (req, res) => {
  let history = [];
  let devices = {};

  if (dbReady) {
    try {
      const result = await pool.query(
        'SELECT device, raw, moisture, valve, level_label, level_color, humidity, temperature, heat_index, created_at FROM readings ORDER BY created_at DESC LIMIT 200'
      );

      history = result.rows.map(r => ({
        device:      r.device,
        raw:         r.raw,
        moisture:    r.moisture !== null ? String(r.moisture) : null,
        valve:       r.valve,
        level:       r.level_label ? { label: r.level_label, color: r.level_color } : null,
        humidity:    r.humidity !== null ? String(r.humidity) : null,
        temperature: r.temperature !== null ? String(r.temperature) : null,
        heatIndex:   r.heat_index !== null ? String(r.heat_index) : null,
        timestamp:   r.created_at
      }));

      // Build devices object
      for (const r of history) {
        if (!devices[r.device]) {
          devices[r.device] = { count: 0, lastSeen: r.timestamp, latest: r };
        }
        devices[r.device].count++;
      }

      const deviceNames = Object.keys(devices);
      if (deviceNames.length) {
        const countResult = await pool.query(
          'SELECT device, COUNT(*) as count FROM readings WHERE device = ANY($1) GROUP BY device',
          [deviceNames]
        );
        for (const row of countResult.rows) {
          if (devices[row.device]) devices[row.device].count = parseInt(row.count);
        }
      }

    } catch (err) {
      console.error('[DB] Load data failed:', err.message);
    }
  }

  res.json({ latest: history[0] || null, history, devices, config });
});

// ── SSE stream ───────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',                'text/event-stream');
  res.setHeader('Cache-Control',               'no-cache');
  res.setHeader('Connection',                  'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0] || '*');
  res.flushHeaders();

  // Send initial data
  (async () => {
    let initData = { latest: null, history: [], devices: {}, config };
    if (dbReady) {
      try {
        const result = await pool.query(
          'SELECT device, raw, moisture, valve, level_label, level_color, humidity, temperature, heat_index, created_at FROM readings ORDER BY created_at DESC LIMIT 200'
        );
        initData.history = result.rows.map(r => ({
          device: r.device, raw: r.raw,
          moisture: r.moisture !== null ? String(r.moisture) : null,
          valve: r.valve,
          level: r.level_label ? { label: r.level_label, color: r.level_color } : null,
          humidity: r.humidity !== null ? String(r.humidity) : null,
          temperature: r.temperature !== null ? String(r.temperature) : null,
          heatIndex: r.heat_index !== null ? String(r.heat_index) : null,
          timestamp: r.created_at
        }));
        initData.latest = initData.history[0] || null;
      } catch {}
    }
    res.write(`data: ${JSON.stringify({ type: 'init', data: initData })}\n\n`);
  })();

  clients.push(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
  req.on('close', () => { clearInterval(hb); clients = clients.filter(c => c !== res); });
});

// ── Local IP ─────────────────────────────────
function localIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', async () => {
  await loadConfig();
  const ip = localIP();
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Agriflow — Moisture Server                     ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Dashboard : http://localhost:${PORT}              ║`);
  console.log(`║  Network   : http://${ip}:${PORT}             ║`);
  console.log(`║  Database  : PostgreSQL (Supabase)               ║`);
  console.log(`║  ESP32 URL : POST /api/sensor                   ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Config: Open <${config.openThreshold}% | Water ${config.wateringMinutes} min`);
  console.log('');
});
