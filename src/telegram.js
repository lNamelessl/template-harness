// src/telegram.js — optional push channel (existing bot creds via env).
'use strict';
const config = require('./config');

async function pushTelegram(text) {
  if (!config.telegramToken || !config.telegramChat) {
    return { pushed: false, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured (optional)' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChat, text: String(text).slice(0, 4000) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { pushed: false, reason: `telegram HTTP ${res.status}` };
    return { pushed: true, channel: 'telegram' };
  } catch (e) {
    return { pushed: false, reason: String(e.message || e).slice(0, 100) };
  }
}

module.exports = { pushTelegram };
