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
    offlineMin: Math.max(2, parseInt(process.env.LINE_OFFLINE_MIN || '10', 10) || 10),
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

async function sendPush(to, text) {
  return lineFetch(LINE_PUSH_URL, { to, messages: toMessages(text) });
}

// Multicast: max 500 recipients/call — chunk automatically
async function sendMulticast(toList, text) {
  const list = [...new Set((toList || []).filter(Boolean))];
  if (!list.length) return { sent: 0 };
  const messages = toMessages(text);
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
  return lineFetch(LINE_REPLY_URL, { replyToken, messages: toMessages(text) });
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
};
