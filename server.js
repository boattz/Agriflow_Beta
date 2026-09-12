require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const os      = require('os');
const path    = require('path');
const line    = require('./lineNotify');

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
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

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

// Block sensitive files BEFORE static (setHeaders can't stop the send and
// would cause "headers already sent" errors on scanner hits like /server.js)
app.use((req, res, next) => {
  const base = path.basename(req.path);
  const ext = path.extname(req.path);
  if (BLOCKED_FILES.includes(base) || (ext && !STATIC_ALLOWED.includes(ext) && req.path !== '/')) {
    return res.status(403).end();
  }
  next();
});
app.use(express.static(__dirname, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath);
    if (ext === '.html' || ext === '.js' || ext === '.css') {
      // no-cache (not immutable): dashboard must pick up new deploys immediately
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
        crop_id VARCHAR(50) DEFAULT 'custom',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Migration for existing DBs
    await client.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS crop_id VARCHAR(50) DEFAULT 'custom'`);

    // Insert default config if not exist
    await client.query(`
      INSERT INTO config (id, open_threshold, watering_minutes)
      VALUES (1, 40, 3)
      ON CONFLICT (id) DO NOTHING
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_readings_created_at ON readings (created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_readings_device ON readings (device)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS line_subscribers (
        line_user_id VARCHAR(50) PRIMARY KEY,
        display_name VARCHAR(100),
        active BOOLEAN DEFAULT TRUE,
        subscribed_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    client.release();
    dbReady = true;
    console.log('[DB] Tables ready');
    cleanupOldReadings().catch(() => {}); // delete once at boot (agriscan-style)
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    console.log('[DB] Retrying in 5 seconds...');
    setTimeout(connectDB, 5000);
  }
}

connectDB();

// ── Data retention (agriscan-style): DELETE readings older than RETENTION_DAYS ──
// Runs once at boot + every CLEANUP_EVERY inserts (not every insert — saves resources)
const RETENTION_DAYS = Math.max(1, parseInt(process.env.RETENTION_DAYS || '30', 10) || 30);
const CLEANUP_EVERY = 50;
let insertCounter = 0;

async function cleanupOldReadings() {
  if (!dbReady) return;
  try {
    const r = await pool.query(
      `DELETE FROM readings WHERE created_at < NOW() - ($1 || ' days')::interval`,
      [String(RETENTION_DAYS)]
    );
    console.log(`[DB] Retention: deleted ${r.rowCount} readings older than ${RETENTION_DAYS}d`);
  } catch (err) {
    console.error('[DB] Retention cleanup failed:', err.message);
  }
}

// ── Ingest auth (agriscan-style X-API-Key) ──
// Set SENSOR_API_KEY on server + matching key in ESP32 secrets.h.
// When unset (default) the endpoint stays open for backward compatibility.
const SENSOR_API_KEY = process.env.SENSOR_API_KEY || '';
function checkSensorAuth(req) {
  if (!SENSOR_API_KEY) return true;
  return req.headers['x-api-key'] === SENSOR_API_KEY;
}

// ── Crop profiles (research-backed presets) ──
// threshold = open valve when moisture drops below (%). minutes = watering duration estimate.
// Sources: FAO-56 Table 22 (p = depletion fraction, threshold ≈ (1-p)×100),
// Thai research (durian/cassava/mangosteen/rubber/jujube), US Extension (potato/watermelon/citrus).
// confidence: high | medium | low (low = proxy, needs field tuning).
const CROP_PROFILES = [
  { id: 'rice',       name: 'ข้าว',            threshold: 70, minutes: 10, source: 'FAO-56 p=0.20 saturation (paddy)', confidence: 'high',   hint: 'นาข้าวชอบแฉะ รักษาดินชื้นสูง' },
  { id: 'corn',       name: 'ข้าวโพด',         threshold: 45, minutes: 5,  source: 'FAO-56 p=0.50-0.55 (maize)', confidence: 'high', hint: 'ช่วงออกไหม-ติดเมล็ดห้ามขาดน้ำ' },
  { id: 'rubber',     name: 'ยางพารา',         threshold: 40, minutes: 3,  source: 'FAO-56 p=0.40 + REW<0.4 เครียด (Sopharat)', confidence: 'medium', hint: 'ต้นโตทนแล้ง ต้นเล็กควรใช้ ~50%' },
  { id: 'longan',     name: 'ลำไย',            threshold: 45, minutes: 5,  source: 'proxy: FAO fruit trees p=0.50', confidence: 'low', hint: 'ค่าประมาณ — ช่วงติดผลต้องการน้ำสม่ำเสมอ ปรับหน้างาน' },
  { id: 'lychee',     name: 'ลิ้นจี่',          threshold: 45, minutes: 5,  source: 'proxy: FAO fruit trees p=0.50', confidence: 'low', hint: 'ค่าประมาณ — ระวังแตกผลถ้าน้ำแกว่ง' },
  { id: 'durian',     name: 'ทุเรียน',          threshold: 45, minutes: 5,  source: 'Thai res: VWC<0.19 เครียด, avg 65%/crit 20%', confidence: 'medium', hint: 'ขาดน้ำดอกร่วง แฉะเกินรากเน่า' },
  { id: 'cassava',    name: 'มันสำปะหลัง',     threshold: 35, minutes: 2,  source: 'FAO-56 p=0.35 + critical 39%/15.7% AWHC (Machikowa)', confidence: 'medium', hint: 'ทนแล้ง 3 เดือนแรกห้ามขาดน้ำ ดินทรายปล่อยต่ำได้' },
  { id: 'potato',     name: 'มันอาลู (มันฝรั่ง)', threshold: 55, minutes: 4, source: 'FAO-56 p=0.35 + UC/Maine 60% AW', confidence: 'high', hint: 'รากตื้น ช่วงลงหัวห้ามแห้ง' },
  { id: 'shallot',    name: 'หอม',             threshold: 55, minutes: 3,  source: 'FAO-56 p=0.30 (onion)', confidence: 'high', hint: 'รากตื้น ต้องรดบ่อยครั้งละน้อย' },
  { id: 'garlic',     name: 'กระเทียม',        threshold: 55, minutes: 3,  source: 'FAO-56 p=0.30 (garlic)', confidence: 'high', hint: 'รากตื้น ช่วงลงหัวห้ามแฉะเกิน' },
  { id: 'mangosteen', name: 'มังคุด',           threshold: 45, minutes: 5,  source: 'Salakpetch stress -1.0MPa ทำดอก + IoT 2024', confidence: 'medium', hint: 'ช่วงทำดอกต้องงดน้ำก่อน แล้วค่อยอัดน้ำ' },
  { id: 'jujube',     name: 'พุทรา',           threshold: 40, minutes: 3,  source: '80-100% ETc ดีสุด (Bai/Liu)', confidence: 'medium', hint: 'ทนแล้งปานกลาง ไม่ชอบแฉะ' },
  { id: 'watermelon', name: 'แตงโม',           threshold: 50, minutes: 4,  source: 'FAO-56 p=0.40 + เริ่มรด -30kPa (Huh)', confidence: 'high', hint: 'ช่วงขยายผลต้องการน้ำสม่ำเสมอ ใกล้เก็บลดน้ำเพิ่มหวาน' },
  { id: 'pumpkin',    name: 'ฟักทอง',          threshold: 50, minutes: 4,  source: 'FAO-56 p=0.35 (pumpkin/winter squash)', confidence: 'high', hint: 'ช่วงติดผล-ขยายผลห้ามขาดน้ำ' },
  { id: 'kitchen',    name: 'ผักสวนครัว',      threshold: 55, minutes: 3,  source: 'FAO-56 p=0.30-0.45 (leafy/small veg)', confidence: 'medium', hint: 'ผักใบชอบชื้นสม่ำเสมอ' },
  { id: 'pomelo',     name: 'ส้มโอ',           threshold: 45, minutes: 5,  source: 'FAO citrus p=0.50 + UF 25-33%/50-66%', confidence: 'high', hint: 'ออกดอก-ติดผลอ่อนใช้น้ำมาก หน้าฝนยอมแห้งได้บ้าง' },
  { id: 'guava',      name: 'ฝรั่ง',            threshold: 40, minutes: 4,  source: 'proxy: FAO citrus/fruit p=0.50', confidence: 'low', hint: 'ค่าประมาณ — ห่อผลแล้วรดสม่ำเสมอ' },
  { id: 'custom',     name: 'กำหนดเอง',        threshold: null, minutes: null, source: 'user-defined', confidence: 'high', hint: 'ปรับ slider เองตามดินหน้างาน' }
];
function findCrop(id) { return CROP_PROFILES.find(c => c.id === id) || null; }

// ── Config ───────────────────────────────────
let config = {
  openThreshold:   40,
  wateringMinutes: 3,
  cropId:          'custom',
  resetWifi:       false
};

// ── Manual valve override (temporary, in-memory only) ──
// { action: 'open'|'close', expiresAt: epochMs } | null
let valveOverride = null;
function getValveOverride() {
  if (valveOverride && valveOverride.expiresAt <= Date.now()) valveOverride = null;
  return valveOverride;
}
function configWithOverride() {
  return { ...config, valveOverride: getValveOverride() };
}

const RESET_TOKEN = process.env.RESET_TOKEN || '';
function checkResetAuth(req) {
  if (!RESET_TOKEN) return true; // local dev: no token configured → allow
  const t = req.headers['x-reset-token'] || req.body?.token;
  return t === RESET_TOKEN;
}

async function loadConfig() {
  if (!dbReady) return;
  try {
    const result = await pool.query('SELECT * FROM config WHERE id = 1');
    if (result.rows.length) {
      config.openThreshold   = result.rows[0].open_threshold;
      config.wateringMinutes = result.rows[0].watering_minutes;
      config.cropId          = result.rows[0].crop_id || 'custom';
      config.resetWifi       = !!result.rows[0].reset_wifi;
    }
  } catch (err) {
    console.error('[DB] Load config failed:', err.message);
  }
}

async function saveConfig() {
  if (!dbReady) return;
  try {
    await pool.query(
      'UPDATE config SET open_threshold = $1, watering_minutes = $2, reset_wifi = $3, crop_id = $4 WHERE id = 1',
      [config.openThreshold, config.wateringMinutes, config.resetWifi, config.cropId]
    );
  } catch (err) {
    console.error('[DB] Save config failed:', err.message);
  }
}

// ── Keep-Alive Ping ──────────────────────────
const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000;
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

// ── LINE Notify (multicast to registered subscribers) ──
// Spec lock: valve flip + soil-level change → send; 3-min cooldown/device;
// Very Dry (<20%) bypasses cooldown; offline (>OFFLINE_MIN) once + recovery.
const lastValveByDevice = {};
const lastLevelByDevice = {};
const lastSeenByDevice = {};
const offlineNotifiedByDevice = {};
const pendingLevelByDevice = {}; // latest level seen during cooldown → summary after

async function getActiveSubscriberIds() {
  if (!dbReady) return [];
  try {
    const r = await pool.query(`SELECT line_user_id FROM line_subscribers WHERE active = TRUE`);
    return r.rows.map(x => x.line_user_id).filter(Boolean);
  } catch (err) {
    console.error('[LINE] subscribers query failed:', err.message);
    return [];
  }
}

async function multicastToAll(msg, logLabel) {
  if (!line.isLineEnabled()) return;
  try {
    const ids = await getActiveSubscriberIds();
    if (!ids.length) return;
    const r = await line.sendMulticast(ids, msg);
    const label = logLabel || (typeof msg === 'string' ? msg : (msg.altText || msg.type || 'flex'));
    console.log(`[LINE] sent → ${r.sent} subs: ${String(label).slice(0, 80)}`);
  } catch (err) {
    console.error('[LINE] send failed:', err.message);
  }
}

// Contextual buttons under every alert card
function alertButtons(valve) {
  return valve === 'OPEN'
    ? [{ label: '🛑 หยุด', text: 'หยุด' }, { label: '📊 สถานะ', text: 'สถานะ' }]
    : [{ label: '🚰 เปิดวาล์ว', text: 'เปิดวาล์ว' }, { label: '📊 สถานะ', text: 'สถานะ' }];
}

function fmtTime(d) {
  try { return new Date(d).toLocaleString('th-TH', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }); }
  catch { return String(d); }
}

// Fire-and-forget from POST /api/sensor — never throws
function handleSensorNotify(reading) {
  if (!line.isLineEnabled()) return;
  const c = line.cfg();
  const id = reading.device || 'ESP32';
  const now = Date.now();
  lastSeenByDevice[id] = now;
  // Device back online → recovery notice (only if we previously flagged offline)
  if (offlineNotifiedByDevice[id]) {
    offlineNotifiedByDevice[id] = false;
    multicastToAll(line.flexAlert({
      accent: '#22c55e', title: `✅ ${id} กลับมาออนไลน์แล้ว`,
      alt: `${id} กลับมาออนไลน์แล้ว`, device: id, time: fmtTime(reading.timestamp),
      buttons: alertButtons(valve),
    }), 'recovery:' + id);
  }

  const valve = String(reading.valve || 'CLOSE');
  const levelLabel = (reading.level && reading.level.label) || null;
  const moisture = reading.moisture;
  const prevValve = lastValveByDevice[id];
  const prevLevel = lastLevelByDevice[id];

  const valveChanged = prevValve !== undefined && prevValve !== valve;
  const levelChanged = prevLevel !== undefined && levelLabel && prevLevel !== levelLabel;
  const isVeryDry = moisture !== null && parseFloat(moisture) < 20;

  // First sighting → just record baseline, don't spam
  if (prevValve === undefined) lastValveByDevice[id] = valve;
  if (prevLevel === undefined && levelLabel) lastLevelByDevice[id] = levelLabel;
  if (!valveChanged && !levelChanged && !isVeryDry) return;

  const minIntervalMs = c.minIntervalMin * 60000;
  const critCooldownMs = c.cooldownMin * 60000;
  const keyBase = 'dev:' + id;

  if (valveChanged) {
    lastValveByDevice[id] = valve;
    if (line.shouldNotify(keyBase + ':valve', 0)) {
      const opened = valve === 'OPEN';
      multicastToAll(line.flexAlert({
        accent: opened ? '#22c55e' : '#64748b',
        title: opened ? '🚰 วาล์วเปิดแล้ว' : '🛑 วาล์วปิดแล้ว',
        alt: `วาล์ว${opened ? 'เปิด' : 'ปิด'}แล้ว ความชื้น ${moisture}%`,
        moisture, level: levelLabel, levelColor: (reading.level && reading.level.color) || undefined,
        valve, device: id, time: fmtTime(reading.timestamp),
        buttons: alertButtons(valve),
      }), 'valve:' + id + ':' + valve);
    }
  }

  if (levelChanged || isVeryDry) {
    const key = keyBase + ':level';
    const bypass = isVeryDry && line.shouldNotify(keyBase + ':crit', critCooldownMs);
    if (bypass || line.shouldNotify(key, minIntervalMs)) {
      if (levelLabel) lastLevelByDevice[id] = levelLabel;
      delete pendingLevelByDevice[id];
      multicastToAll(isVeryDry
        ? line.flexAlert({
            accent: '#ff4757', title: '🚨 ดินแห้งวิกฤต',
            alt: `ดินแห้งวิกฤต ${moisture}% ควรตรวจสอบระบบน้ำ`,
            moisture, level: levelLabel, levelColor: (reading.level && reading.level.color) || undefined,
            valve, device: id, time: fmtTime(reading.timestamp),
            extra: ['คำแนะนำ', 'ตรวจสอบระบบน้ำ'],
            buttons: [{ label: '🚰 เปิดวาล์วตอนนี้', text: 'เปิดวาล์ว', style: 'primary' }, { label: '📊 สถานะ', text: 'สถานะ' }],
          })
        : line.flexAlert({
            accent: '#38bdf8', title: `💧 ความชื้นเปลี่ยน: ${prevLevel} → ${levelLabel}`,
            alt: `ความชื้นเปลี่ยนเป็น ${levelLabel} ${moisture}%`,
            moisture, level: levelLabel, levelColor: (reading.level && reading.level.color) || undefined,
            valve, device: id, time: fmtTime(reading.timestamp),
            buttons: alertButtons(valve),
          }), 'level:' + id + ':' + levelLabel);
    } else if (levelLabel) {
      // flapping inside cooldown → remember latest, summarize later
      pendingLevelByDevice[id] = { label: levelLabel, moisture, ts: reading.timestamp };
    }
  }
}

// Flush pending level summaries after cooldown (runs inside offline checker tick)
async function flushPendingLevels() {
  if (!line.isLineEnabled()) return;
  const c = line.cfg();
  const minIntervalMs = c.minIntervalMin * 60000;
  for (const [id, p] of Object.entries(pendingLevelByDevice)) {
    if (line.shouldNotify('dev:' + id + ':level', minIntervalMs)) {
      lastLevelByDevice[id] = p.label;
      delete pendingLevelByDevice[id];
      multicastToAll(line.flexAlert({
        accent: '#38bdf8', title: `💧 ความชื้น (สรุป): ${p.label}`,
        alt: `สรุปความชื้น ${p.label} ${p.moisture}%`,
        moisture: p.moisture, level: p.label, device: id, time: fmtTime(p.ts),
        buttons: [{ label: '📊 สถานะ', text: 'สถานะ' }],
      }), 'level-summary:' + id);
    }
  }
}

async function checkOfflineDevices() {
  if (!line.isLineEnabled() || !dbReady) return;
  const c = line.cfg();
  const now = Date.now();
  for (const [id, last] of Object.entries(lastSeenByDevice)) {
    if (offlineNotifiedByDevice[id]) continue;
    if (now - last > c.offlineMin * 60000) {
      offlineNotifiedByDevice[id] = true;
      multicastToAll(line.flexAlert({
        accent: '#f59e0b', title: `⚠️ ${id} ไม่ออนไลน์`,
        alt: `${id} ไม่ออนไลน์เกิน ${c.offlineMin} นาที`,
        device: id, time: fmtTime(Date.now()),
        extra: ['เห็นล่าสุด', fmtTime(last)],
        buttons: [{ label: '📊 เช็คสถานะ', text: 'สถานะ' }],
      }), 'offline:' + id);
    }
  }
  flushPendingLevels().catch(() => {});
}
setInterval(checkOfflineDevices, 30000);

// ── LINE webhook (OA → /api/line/webhook) ────
app.post('/api/line/webhook', async (req, res) => {
  try {
    const sig = req.headers['x-line-signature'];
    if (!line.verifySignature(req.rawBody, sig)) {
      return res.status(403).json({ error: 'Invalid signature' });
    }
    const events = (req.body && req.body.events) || [];
    const c = line.cfg();
    for (const ev of events) {
      const src = ev.source || {};
      const userId = src.userId || src.groupId || src.roomId;
      if (!userId) continue;
      if (ev.type === 'follow' || ev.type === 'join') {
        try {
          let name = null;
          if (ev.type === 'follow' && line.hasLineConfig()) {
            const prof = await line.getProfile(userId).catch(() => null);
            if (prof && prof.displayName) name = String(prof.displayName).slice(0, 100);
          }
          if (dbReady) {
            await pool.query(
              `INSERT INTO line_subscribers (line_user_id, display_name, active, subscribed_at)
               VALUES ($1, $2, FALSE, NOW())
               ON CONFLICT (line_user_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, line_subscribers.display_name)`,
              [userId, name]
            );
          }
        } catch (e) { console.error('[LINE] follow save failed:', e.message); }
        if (c.enabled) {
          await line.sendReply(ev.replyToken, [
            { type: 'text', text: 'ยินดีต้อนรับ 🌱 Agriflow\nพิมพ์รหัสลงทะเบียนเพื่อรับแจ้งเตือน\n(ขอจากผู้ดูแลระบบ)' },
            line.flexMenu(),
          ]).catch(() => {});
        }
      } else if (ev.type === 'unfollow' || ev.type === 'leave') {
        if (dbReady) {
          await pool.query(`UPDATE line_subscribers SET active = FALSE WHERE line_user_id = $1`, [userId]).catch(() => {});
        }
      } else if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
        if (!c.enabled) continue;
        await handleLineMessage(userId, ev.replyToken, ev.message.text);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[LINE] webhook error:', err.message);
    res.json({ ok: true }); // always 200 so LINE doesn't retry-storm
  }
});

// ── LINE admin (hidden, RESET_TOKEN auth, no dashboard UI per spec) ──
app.get('/api/line/subscribers', async (req, res) => {
  if (!checkResetAuth(req)) return res.status(403).json({ error: 'Invalid reset token' });
  if (!dbReady) return res.json({ count: 0, subscribers: [] });
  try {
    const r = await pool.query(`SELECT line_user_id, display_name, active, subscribed_at FROM line_subscribers ORDER BY subscribed_at DESC LIMIT 500`);
    res.json({ count: r.rows.length, active: r.rows.filter(x => x.active).length, subscribers: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/line/test', rateLimit(5, 60000), async (req, res) => {
  if (!checkResetAuth(req)) return res.status(403).json({ error: 'Invalid reset token' });
  if (!line.isLineEnabled()) return res.status(400).json({ error: 'LINE not enabled/configured' });
  const { to, text, menu } = req.body || {};
  try {
    if (to) {
      await line.sendPush(String(to), String(text || 'ทดสอบ Agriflow ✅'));
      return res.json({ ok: true, mode: 'push', to });
    }
    if (menu) {
      await multicastToAll(line.flexMenu(), 'menu-card');
      return res.json({ ok: true, mode: 'multicast-menu' });
    }
    await multicastToAll(String(text || 'ทดสอบ Agriflow ✅ ระบบแจ้งเตือนพร้อมใช้งาน'));
    res.json({ ok: true, mode: 'multicast' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/crops ───────────────────────────
app.get('/api/crops', (req, res) => {
  res.json(CROP_PROFILES);
});

// ── GET /api/config ──────────────────────────
app.get('/api/config', (req, res) => {
  res.json(configWithOverride());
});

// ── POST /api/config ─────────────────────────
app.post('/api/config', rateLimit(30, 60000), async (req, res) => {
  const { openThreshold, wateringMinutes, cropId } = req.body;

  // If a known crop preset is selected, auto-fill its values
  if (cropId !== undefined && cropId !== 'custom') {
    const crop = findCrop(String(cropId));
    if (crop) {
      config.cropId          = crop.id;
      config.openThreshold   = crop.threshold;
      config.wateringMinutes = crop.minutes;
      console.log(`[CONFIG] Crop ${crop.name} <${config.openThreshold}% | Water ${config.wateringMinutes} min`);
      await saveConfig();
      broadcast({ type: 'config', data: configWithOverride() });
      return res.json({ ok: true, config: configWithOverride() });
    }
  }

  // Manual adjustment → mark as custom
  if (openThreshold !== undefined)   config.openThreshold   = Math.max(5, Math.min(95, parseInt(openThreshold)));
  if (wateringMinutes !== undefined) config.wateringMinutes = Math.max(1, Math.min(30, parseInt(wateringMinutes)));
  if (cropId !== undefined) {
    config.cropId = (cropId === 'custom' || findCrop(String(cropId))) ? String(cropId) : 'custom';
  } else {
    config.cropId = 'custom'; // any manual slider move drops the preset
  }

  console.log(`[CONFIG] Open <${config.openThreshold}% | Water ${config.wateringMinutes} min (${config.cropId})`);
  await saveConfig();
  broadcast({ type: 'config', data: configWithOverride() });
  res.json({ ok: true, config: configWithOverride() });
});

// ── POST /api/reset-wifi ─────────────────────
app.post('/api/reset-wifi', rateLimit(5, 60000), async (req, res) => {
  if (!checkResetAuth(req)) return res.status(403).json({ error: 'Invalid reset token' });
  console.log('[RESET] WiFi reset requested from dashboard');
  config.resetWifi = true;
  await saveConfig();
  broadcast({ type: 'config', data: configWithOverride() });
  res.json({ ok: true, message: 'ESP32 will reset WiFi on next send' });
});

// ── POST /api/valve (manual temporary override) ─
// Body: { action: 'open'|'close'|'auto' }. open/close lasts wateringMinutes, auto clears.
// Shared with LINE remote control below.
function applyValveAction(action) {
  if (action === 'auto' || action === 'clear') {
    valveOverride = null;
    broadcast({ type: 'config', data: configWithOverride() });
    return { ok: true, config: configWithOverride() };
  }
  if (action !== 'open' && action !== 'close') {
    return { error: "action must be 'open', 'close' or 'auto'" };
  }
  valveOverride = {
    action,
    expiresAt: Date.now() + Math.max(1, config.wateringMinutes) * 60000
  };
  console.log(`[VALVE] Manual ${action} for ${config.wateringMinutes} min`);
  broadcast({ type: 'config', data: configWithOverride() });
  return { ok: true, config: configWithOverride() };
}
app.post('/api/valve', rateLimit(30, 60000), async (req, res) => {
  const r = applyValveAction((req.body || {}).action);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

// Shared with LINE remote control: threshold 5-95%, minutes 1-30 (mirrors /api/config)
async function applyLineConfig({ threshold, minutes }) {
  if (threshold !== undefined) config.openThreshold = Math.max(5, Math.min(95, Math.round(threshold)));
  if (minutes !== undefined) config.wateringMinutes = Math.max(1, Math.min(30, Math.round(minutes)));
  config.cropId = 'custom';
  console.log(`[CONFIG] via LINE: Open <${config.openThreshold}% | Water ${config.wateringMinutes} min`);
  await saveConfig();
  broadcast({ type: 'config', data: configWithOverride() });
  return configWithOverride();
}

// ── LINE remote control (same power as dashboard) ──
const lineCmdCooldown = new Map(); // userId → last command ts (anti-spam)

async function isLineSubscribed(userId) {
  if (!dbReady) return false;
  try {
    const r = await pool.query('SELECT active FROM line_subscribers WHERE line_user_id = $1', [userId]);
    return r.rows.length > 0 && !!r.rows[0].active;
  } catch { return false; }
}

async function fetchLineName(userId) {
  try {
    if (!line.hasLineConfig()) return null;
    const prof = await line.getProfile(userId).catch(() => null);
    if (prof && prof.displayName) return String(prof.displayName).slice(0, 100);
  } catch {}
  return null;
}

async function latestLineReading() {
  if (!dbReady) return null;
  try {
    const r = await pool.query(
      `SELECT device, moisture, valve, level_label, level_color, created_at
       FROM readings ORDER BY created_at DESC LIMIT 1`);
    return r.rows[0] || null;
  } catch { return null; }
}

async function subscribeLineUser(userId) {
  const name = await fetchLineName(userId);
  if (dbReady) {
    await pool.query(
      `INSERT INTO line_subscribers (line_user_id, display_name, active, subscribed_at)
       VALUES ($1, $2, TRUE, NOW())
       ON CONFLICT (line_user_id) DO UPDATE SET active = TRUE, subscribed_at = NOW(),
         display_name = COALESCE(EXCLUDED.display_name, line_subscribers.display_name)`,
      [userId, name]
    ).catch(e => console.error('[LINE] subscribe failed:', e.message));
  }
}

function replyCmd(replyToken, msg) {
  if (!replyToken) return Promise.resolve(false);
  return line.sendReply(replyToken, msg).catch(() => false);
}

async function handleLineMessage(userId, replyToken, rawText) {
  const c = line.cfg();
  const text = String(rawText || '').trim();
  if (!text) return;

  // ① Registration code — works even when not subscribed yet
  if (c.regCode && text === c.regCode) {
    await subscribeLineUser(userId);
    await replyCmd(replyToken, [
      { type: 'text', text: 'สมัครสำเร็จ ✅\nแตะปุ่มด้านล่างสั่งงานได้เลย' },
      line.flexMenu(),
    ]);
    return;
  }

  // Must be an active subscriber for everything else
  if (!await isLineSubscribed(userId)) {
    await replyCmd(replyToken, [
      { type: 'text', text: 'ต้องสมัครก่อนนะ 🌱\nพิมพ์รหัสลงทะเบียนที่ได้จากผู้ดูแลระบบ' },
      line.flexMenu(),
    ]);
    return;
  }

  // Anti-spam: 1 command / 2 sec per user
  const now = Date.now();
  if (now - (lineCmdCooldown.get(userId) || 0) < 2000) return;
  lineCmdCooldown.set(userId, now);

  const lower = text.toLowerCase();

  // ② Unsubscribe (note: หยุด = valve stop, NOT unsubscribe)
  if (['ยกเลิก', 'เลิกรับ', 'เลิกติดตาม', 'unsubscribe'].includes(lower)) {
    if (dbReady) await pool.query(`UPDATE line_subscribers SET active = FALSE WHERE line_user_id = $1`, [userId]).catch(() => {});
    await replyCmd(replyToken, 'เลิกรับแจ้งเตือนแล้ว 🔕\nพิมพ์รหัสลงทะเบียนเพื่อสมัครใหม่');
    return;
  }

  // ③ Menu / help
  if (['เมนู', 'menu', 'help', 'ช่วยเหลือ', 'คำสั่ง', 'ช่วย'].includes(lower)) {
    await replyCmd(replyToken, line.flexMenu());
    return;
  }

  // ④ Status snapshot (flex card)
  if (['สถานะ', 'status', 'ดูสถานะ'].includes(lower)) {
    const x = await latestLineReading();
    if (!x) { await replyCmd(replyToken, 'ยังไม่มีข้อมูลเซ็นเซอร์ 📡\nรอ ESP32 ส่งข้อมูลรอบแรก'); return; }
    await replyCmd(replyToken, line.flexStatus({
      device: x.device, moisture: x.moisture != null ? String(x.moisture) : null,
      level: x.level_label, levelColor: x.level_color, valve: x.valve,
      threshold: config.openThreshold, minutes: config.wateringMinutes,
      time: fmtTime(x.created_at),
    }));
    return;
  }

  // ⑤ Manual valve open (lasts wateringMinutes, like dashboard button)
  if (lower === 'เปิดวาล์ว' || lower === 'เปิดวาล์วตอนนี้' || lower === 'เปิดน้ำ' || lower === 'เปิด') {
    applyValveAction('open');
    await replyCmd(replyToken, `🚰 เปิดวาล์วแล้ว (ปิดเองใน ${config.wateringMinutes} นาที)\nสั่ง “หยุด” เพื่อหยุดก่อนเวลา`);
    return;
  }

  // ⑥ Back to auto
  if (['หยุด', 'หยุดวาล์ว', 'ปิดวาล์ว', 'ปิดน้ำ', 'auto'].includes(lower)) {
    applyValveAction('auto');
    await replyCmd(replyToken, '🛑 กลับโหมด Auto แล้ว\nวาล์วจะทำงานตามความชื้นดิน');
    return;
  }

  // ⑦ Set threshold — e.g. เกณฑ์ 45 / threshold 45
  let m = text.match(/(?:เกณฑ์|threshold)\s*(\d{1,2})/i);
  if (m) {
    const v = Math.max(5, Math.min(95, parseInt(m[1], 10)));
    await applyLineConfig({ threshold: v });
    await replyCmd(replyToken, `⚙️ ตั้งเกณฑ์เปิดวาล์ว <${v}% แล้ว\n(ESP32 รับค่าใหม่รอบส่งถัดไป)`);
    return;
  }
  if (lower === 'เกณฑ์' || lower === 'threshold') {
    await replyCmd(replyToken, `เกณฑ์ตอนนี้ <${config.openThreshold}%\nพิมพ์เช่น “เกณฑ์ 45” เพื่อเปลี่ยน (5–95)`);
    return;
  }

  // ⑧ Set watering minutes — e.g. รด 5 นาที / เวลา 5 / 5 นาที
  m = text.match(/(?:รด|เวลา|นาที|min|duration)\s*(\d{1,2})/i) || text.match(/^(\d{1,2})\s*(?:นาที|min)$/i);
  if (m) {
    const v = Math.max(1, Math.min(30, parseInt(m[1], 10)));
    await applyLineConfig({ minutes: v });
    await replyCmd(replyToken, `⏱️ ตั้งเวลารดน้ำ ${v} นาทีแล้ว`);
    return;
  }
  if (['เวลา', 'นาที', 'รดน้ำ'].includes(lower)) {
    await replyCmd(replyToken, `เวลารดตอนนี้ ${config.wateringMinutes} นาที\nพิมพ์เช่น “รด 5 นาที” เพื่อเปลี่ยน (1–30)`);
    return;
  }

  // ⑨ Fallback → hint + menu
  await replyCmd(replyToken, [
    { type: 'text', text: 'ไม่เข้าใจคำสั่ง 🤔\nแตะปุ่มด้านล่างได้เลย' },
    line.flexMenu(),
  ]);
}

// ── POST /api/sensor ─────────────────────────
app.post('/api/sensor', rateLimit(60, 60000), async (req, res) => {
  if (!checkSensorAuth(req)) {
    return res.status(401).json({ error: 'Invalid X-API-Key (set SENSOR_API_KEY on server + secrets.h on ESP32)' });
  }
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

  // One-shot resetWifi: deliver true once, then clear so ESP doesn't bootloop
  const resetOnce = config.resetWifi === true;
  const snapshot = { ...configWithOverride(), resetWifi: resetOnce };
  if (resetOnce) {
    config.resetWifi = false;
    saveConfig().catch(() => {});
    broadcast({ type: 'config', data: configWithOverride() });
  }

  const reading = {
    device:      id,
    raw:         raw         !== undefined ? parseInt(raw)                  : null,
    moisture:    moisture    !== undefined ? parseFloat(moisture).toFixed(1) : null,
    valve:       valve       || 'CLOSE',
    level,
    humidity:    humidity    !== undefined ? parseFloat(humidity).toFixed(1)    : null,
    temperature: temperature !== undefined ? parseFloat(temperature).toFixed(1) : null,
    heatIndex:   heatIndex   !== undefined ? parseFloat(heatIndex).toFixed(1)   : null,
    config:      snapshot,
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
      if (++insertCounter % CLEANUP_EVERY === 0) cleanupOldReadings().catch(() => {});
    } catch (err) {
      console.error('[DB] Save reading failed:', err.message);
    }
  }

  const mPart = reading.moisture !== null ? `Moisture: ${reading.moisture}% | ` : '';
  const dhtPart = reading.humidity !== null ? `H: ${reading.humidity}% T: ${reading.temperature}°C | ` : '';
  console.log(`[${ts}] ${id} — ${mPart}${dhtPart}Valve: ${valve}${level ? ' | ' + level.label : ''}`);

  broadcast({ type: 'reading', data: reading });
  try { handleSensorNotify(reading); } catch (e) { console.error('[LINE] notify hook:', e.message); }
  res.json({ ok: true, reading, config: snapshot });
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

  res.json({ latest: history[0] || null, history, devices, config: configWithOverride() });
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
    let initData = { latest: null, history: [], devices: {}, config: configWithOverride() };
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

const server = app.listen(PORT, '0.0.0.0', async () => {
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
  console.log(`Config: Open <${config.openThreshold}% | Water ${config.wateringMinutes} min (${config.cropId})`);
  console.log('');
});
// Keep ESP32 TLS connections alive across 15s sends (handshake once, reuse).
// Must exceed the send interval or the server closes idle conns first.
server.keepAliveTimeout = 30000;
server.headersTimeout = 35000;
