// Agriflow — LINE Messaging API helper (no new deps, native fetch)
// Env: LINE_ENABLED, LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET,
//      LINE_REG_CODE, LINE_OFFLINE_MIN, LINE_COOLDOWN_MIN, LINE_MIN_INTERVAL_MIN
const crypto = require('crypto');

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_MULTICAST_URL = 'https://api.line.me/v2/bot/message/multicast';
const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_PROFILE_URL = 'https://api.line.me/v2/bot/profile';

function cfg() {
  return {
    enabled: String(process.env.LINE_ENABLED || '').toLowerCase() === 'true',
    token: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    secret: process.env.LINE_CHANNEL_SECRET || '',
    regCode: process.env.LINE_REG_CODE || '',
    offlineMin: Math.max(1, parseInt(process.env.LINE_OFFLINE_MIN || '1', 10) || 1),
    cooldownMin: Math.max(1, parseInt(process.env.LINE_COOLDOWN_MIN || '60', 10) || 60),
    minIntervalMin: Math.max(1, parseInt(process.env.LINE_MIN_INTERVAL_MIN || '3', 10) || 3),
  };
}

function isLineEnabled() {
  const c = cfg();
  return c.enabled && !!c.token;
}

function hasLineConfig() {
  return !!cfg().token;
}

async function lineFetch(url, body, timeoutMs = 8000) {
  const c = cfg();
  if (!c.token) throw new Error('LINE token not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + c.token,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('LINE API ' + res.status + ': ' + txt.slice(0, 200));
    }
    return true;
  } finally {
    clearTimeout(t);
  }
}

function toMessages(text) {
  // LINE text limit 5000 chars — keep messages short upstream, hard-cut here
  return [{ type: 'text', text: String(text).slice(0, 4500) }];
}

function asMessages(msg) {
  if (Array.isArray(msg)) return msg;
  if (typeof msg === 'string') return toMessages(msg);
  return [msg]; // single flex/text object
}

async function sendPush(to, text) {
  return lineFetch(LINE_PUSH_URL, { to, messages: asMessages(text) });
}

// Multicast: max 500 recipients/call — chunk automatically
async function sendMulticast(toList, text) {
  const list = [...new Set((toList || []).filter(Boolean))];
  if (!list.length) return { sent: 0 };
  const messages = asMessages(text);
  let sent = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    await lineFetch(LINE_MULTICAST_URL, { to: chunk, messages });
    sent += chunk.length;
  }
  return { sent };
}

async function sendReply(replyToken, text) {
  if (!replyToken) return false;
  return lineFetch(LINE_REPLY_URL, { replyToken, messages: asMessages(text) });
}

// ── Flex UI builders ─────────────────────────
// row: label left, value right. btn: footer button sending text back.
function flexRow(label, value, valueColor) {
  return {
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: String(label), size: 'sm', color: '#8b9bb4', flex: 0 },
      { type: 'text', text: String(value), size: 'sm', color: valueColor || '#1a1a1a', weight: 'bold', align: 'end', wrap: true },
    ],
  };
}

function flexBtn(label, text, style) {
  return {
    type: 'button', style: style || 'link', height: 'sm',
    action: { type: 'message', label: String(label).slice(0, 20), text },
  };
}

// Alert card: accent header + big moisture + detail rows + action buttons
// buttons: [{label, text, style}] (max ~3)
function flexAlert(o) {
  const body = [
    {
      type: 'text', text: o.moisture != null ? o.moisture + '%' : '—',
      size: 'xxl', weight: 'bold', color: o.levelColor || '#22c55e', align: 'center',
    },
  ];
  if (o.level) body.push({ type: 'text', text: o.level, size: 'sm', color: '#8b9bb4', align: 'center', margin: 'xs' });
  body.push({ type: 'separator', margin: 'md' });
  const rows = [
    flexRow('อุปกรณ์', o.device || '-'),
    flexRow('วาล์ว', o.valve === 'OPEN' ? '● เปิด' : '○ ปิด', o.valve === 'OPEN' ? '#22c55e' : '#8b9bb4'),
    flexRow('เวลา', o.time || '-'),
  ];
  if (o.extra) rows.push(flexRow(o.extra[0], o.extra[1]));
  body.push({ type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm', contents: rows });
  const contents = {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', paddingAll: '12px', backgroundColor: o.accent || '#22c55e',
      contents: [{ type: 'text', text: o.title, weight: 'bold', size: 'md', color: '#ffffff' }],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
  };
  if (o.buttons && o.buttons.length) {
    contents.footer = {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: o.buttons.map(b => flexBtn(b.label, b.text, b.style)),
    };
  }
  return { type: 'flex', altText: o.alt || o.title, contents };
}

// Status card: full snapshot + config + control buttons
function flexStatus(o) {
  return flexAlert({
    accent: '#0ea5e9',
    title: '📊 สถานะ Agriflow',
    alt: `สถานะ: ความชื้น ${o.moisture}% วาล์ว ${o.valve}`,
    moisture: o.moisture, level: o.level, levelColor: o.levelColor,
    valve: o.valve, device: o.device, time: o.time,
    extra: ['เกณฑ์รดน้ำ', `<${o.threshold}% · ${o.minutes} นาที`],
    buttons: [
      { label: '🚰 เปิดวาล์ว', text: 'เปิดวาล์ว' },
      { label: '🛑 หยุด · Auto', text: 'หยุด' },
    ],
  });
}

// Menu card: what the bot can do
function flexMenu() {
  return {
    type: 'flex',
    altText: 'เมนู Agriflow: สถานะ เปิดวาล์ว หยุด ตั้งเกณฑ์',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '12px', backgroundColor: '#16a34a',
        contents: [{ type: 'text', text: '🌱 เมนู Agriflow', weight: 'bold', size: 'md', color: '#ffffff' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          { type: 'text', text: 'แตะปุ่ม หรือพิมพ์สั่งได้เลย', size: 'sm', color: '#8b9bb4', wrap: true },
          { type: 'separator', margin: 'md' },
          {
            type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm',
            contents: [
              flexRow('เกณฑ์', 'เช่น “เกณฑ์ 45”'),
              flexRow('เวลา', 'เช่น “รด 5 นาที”'),
              flexRow('เลิกรับ', 'พิมพ์ “ยกเลิก”'),
            ],
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
        contents: [
          flexBtn('📊 ดูสถานะ', 'สถานะ', 'primary'),
          flexBtn('🚰 เปิดวาล์วตอนนี้', 'เปิดวาล์ว'),
          flexBtn('🛑 หยุด · กลับ Auto', 'หยุด'),
        ],
      },
    },
  };
}

async function getProfile(userId) {
  const c = cfg();
  if (!c.token || !userId) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(LINE_PROFILE_URL + '/' + encodeURIComponent(userId), {
        headers: { Authorization: 'Bearer ' + c.token },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

function verifySignature(rawBody, signature) {
  const c = cfg();
  if (!c.secret) return true; // no secret configured → skip verify (dev)
  if (!signature || !rawBody) return false;
  const hmac = crypto.createHmac('SHA256', c.secret).update(rawBody).digest('base64');
  const a = Buffer.from(hmac);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Cooldown map (in-memory; resets on restart — acceptable per spec) ──
const lastSentByKey = new Map();
function shouldNotify(key, cooldownMs) {
  const now = Date.now();
  const last = lastSentByKey.get(key) || 0;
  if (now - last < cooldownMs) return false;
  lastSentByKey.set(key, now);
  return true;
}
function peekLastSent(key) {
  return lastSentByKey.get(key) || 0;
}

module.exports = {
  cfg,
  isLineEnabled,
  hasLineConfig,
  sendPush,
  sendMulticast,
  sendReply,
  getProfile,
  verifySignature,
  shouldNotify,
  peekLastSent,
  flexAlert,
  flexStatus,
  flexMenu,
};
