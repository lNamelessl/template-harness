// src/auth.js — APP_ACCESS_PASSWORD gate (colab-gpu-platform pattern, Node port).
// sha256-derived session token; accepted via cookie, x-platform-password header
// (raw password), or Authorization Bearer. Empty password = gate disabled.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function tokenFor(password) { return sha256(`harness-v1:${password}`); }

const TOKEN = config.appPassword ? tokenFor(config.appPassword) : null;

function requestToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)harness_token=([A-Za-z0-9]+)/);
  if (m) return m[1];
  const header = req.headers['x-platform-password'];
  if (header) return tokenFor(String(header));
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return tokenFor(auth.slice(7));
  return null;
}

function isAuthed(req) {
  if (!config.appPassword) return true; // gate disabled
  return requestToken(req) === TOKEN;
}

// ---------- first-login self-service (playbook rule 5) ----------
// Marker-guarded: rewrites first-login.txt only when the password hash changes.
function writeFirstLoginFile() {
  if (!config.appPassword) return;
  try {
    const marker = path.join(config.dataDir, '.first-login-marker');
    const prev = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    const cur = sha256(config.appPassword);
    if (prev === cur) return;
    fs.writeFileSync(path.join(config.dataDir, 'first-login.txt'),
      `Harness first login\n===================\n\nLogin password (from APP_ACCESS_PASSWORD):\n\n    ${config.appPassword}\n\nChange it NOW via the APP_ACCESS_PASSWORD variable (Railway -> your service -> Variables).\nThis file refreshes only when the password changes.\n`);
    fs.writeFileSync(marker, cur);
  } catch (e) { /* non-fatal */ }
}

function bootBanner() {
  const lines = [];
  if (config.appPassword) {
    lines.push('==============================================================');
    lines.push('  HARNESS FIRST LOGIN');
    lines.push(`  UI password = value of APP_ACCESS_PASSWORD:  ${config.appPassword}`);
    lines.push('  (also written to /data/first-login.txt on the volume)');
    lines.push('  CHANGE IT NOW: Railway -> your service -> Variables -> APP_ACCESS_PASSWORD');
    lines.push('==============================================================');
  } else {
    lines.push('[auth] APP_ACCESS_PASSWORD empty — UI gate DISABLED. Set the variable (e.g. ${{secret(24)}}) to protect the harness.');
  }
  if (!config.deepseekKey) {
    lines.push('==============================================================');
    lines.push('  DEEPSEEK_API_KEY NOT SET — RESEARCH IS PAUSED');
    lines.push('  Exact next action: Railway -> your service -> Variables ->');
    lines.push('  add DEEPSEEK_API_KEY with a key from platform.deepseek.com:');
    lines.push('  https://platform.deepseek.com/api_keys  (API keys -> Create)');
    lines.push('  The idea watcher RUNS WITHOUT IT; researched ideas queue up,');
    lines.push('  and setting the variable auto-redeploys + unpauses research.');
    lines.push('==============================================================');
  }
  for (const l of lines) console.log(l);
}

module.exports = { isAuthed, tokenFor, TOKEN, writeFirstLoginFile, bootBanner, sha256 };
