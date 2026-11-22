// src/server.js — Fastify app: /health (dotless, unauth, zero upstream calls),
// password gate (cookie/header), ideas API, per-idea SSE progress, artifacts
// download (whitelist-only), settings view-only, marketplace rescan, static UI.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const cookie = require('@fastify/cookie');

const config = require('./config');
const { isAuthed, tokenFor, TOKEN, writeFirstLoginFile, bootBanner, sha256 } = require('./auth');
const { db, ideaStmts, digestStmts, now } = require('./db');
const researcher = require('./researcher');
const watchRunner = require('./watch-runner');
const { approveIdea } = require('./approver');

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 512 * 1024 });
app.register(cookie);

// ---------- static assets (open: css/js only, no secrets) ----------
app.register(fastifyStatic, { root: path.join(__dirname, '..', 'public'), prefix: '/public/' });

// ---------- auth gate for /api/* ----------
app.addHook('onRequest', async (req, reply) => {
  const url = req.url.split('?')[0];
  const open = url === '/health' || url === '/login' || url === '/api/me' || url.startsWith('/public/');
  if (open) return;
  if (url.startsWith('/api/') && !isAuthed(req)) {
    reply.code(401).send({
      error: 'unauthorized',
      message: 'This harness is password-gated.',
      next_action: config.appPassword
        ? 'Log in at /login (password = APP_ACCESS_PASSWORD) or send the x-platform-password header.'
        : 'Set APP_ACCESS_PASSWORD (Railway -> Variables) to enable the gate.',
    });
  }
});

// ---------- health (dotless, unauth, NO upstream calls) ----------
app.get('/health', async () => {
  const counts = {};
  try {
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM ideas GROUP BY status').all()) counts[r.status] = r.n;
  } catch (e) { /* db not ready yet */ }
  return {
    status: 'ok',
    service: 'template-harness',
    key_set: Boolean(config.deepseekKey),
    guided_no_key: !config.deepseekKey,
    password_gate: Boolean(config.appPassword),
    telegram: Boolean(config.telegramToken && config.telegramChat),
    watcher: { running: watchRunner.isRunning(), lastRun: watchRunner.lastRun(), boot: watchRunner.boot() },
    ideas: counts,
    uptime_s: Math.round(process.uptime()),
    model: config.model,
  };
});

// ---------- login ----------
function loginPage(message = '') {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness login</title><style>
body{background:#101014;color:#e8e8ef;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1a1a22;border:1px solid #2c2c38;border-radius:14px;padding:34px;width:340px}
h1{font-size:17px;margin:0 0 4px}.sub{color:#8b8ba0;font-size:12.5px;margin-bottom:18px}
input{width:100%;box-sizing:border-box;background:#0e0e12;border:1px solid #2c2c38;color:#e8e8ef;border-radius:9px;padding:11px 13px;font-size:14px;outline:none}
input:focus{border-color:#4d6bfe}
button{width:100%;margin-top:12px;background:#4d6bfe;color:#fff;border:0;border-radius:9px;padding:11px;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#3f5ce0}
.msg{color:#ff8a8a;font-size:12.5px;margin-top:10px;white-space:pre-wrap}
.brand{color:#6d6d84;font-size:11px;margin-top:16px;text-align:center}
</style></head><body><div class="card"><h1>&#9678; Template Idea Harness</h1>
<div class="sub">Watcher &rarr; DeepSeek research &rarr; you approve builds</div>
<form method="post" action="/login"><input type="password" name="password" placeholder="Access password" autofocus autocomplete="current-password">
<button type="submit">Unlock workspace</button>${message ? `<div class="msg">${esc(message)}</div>` : ''}</form>
<div class="brand">password = APP_ACCESS_PASSWORD (Railway &rarr; Variables)</div></div></body></html>`;
}

app.get('/login', async (req, reply) => {
  if (!config.appPassword) return reply.redirect('/');
  reply.type('text/html').send(loginPage());
});

app.post('/login', async (req, reply) => {
  if (!config.appPassword) return reply.redirect('/');
  const body = req.body || {};
  const supplied = body.password || req.headers['x-platform-password'] || '';
  if (sha256(String(supplied)) !== sha256(config.appPassword)) {
    reply.code(401).type('text/html').send(loginPage('Wrong password — it is the APP_ACCESS_PASSWORD variable value (Railway → your service → Variables, or /data/first-login.txt).'));
    return;
  }
  reply.setCookie('harness_token', TOKEN, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 });
  reply.redirect('/');
});

app.post('/logout', async (req, reply) => {
  reply.clearCookie('harness_token', { path: '/' });
  reply.send({ ok: true });
});

// ---------- UI ----------
app.get('/', async (req, reply) => {
  if (config.appPassword && !isAuthed(req)) return reply.redirect('/login');
  reply.type('text/html').send(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html')));
});

// ---------- me / settings ----------
app.get('/api/me', async () => ({
  password_enabled: Boolean(config.appPassword),
  key_set: Boolean(config.deepseekKey),
  model: config.model,
  telegram: Boolean(config.telegramToken && config.telegramChat),
}));

app.get('/api/settings', async () => ({
  model: config.model,
  deep_search: true,
  research_concurrency: config.researchConcurrency,
  fast_interval_min: config.fastIntervalMin,
  full_run_hour_utc: config.fullRunHour,
  velocity_min_delta: config.velocityMinDelta,
  max_output_tokens: config.maxTokens,
  key_set: Boolean(config.deepseekKey),
  telegram: Boolean(config.telegramToken && config.telegramChat),
  auto_build: { enabled: false, version: 'v1.1' },
  price_note: 'estimates use peak list prices: $0.75/1k server-tool uses, $0.30/M in, $1.20/M out (off-peak is half)',
}));

// ---------- ideas ----------
app.get('/api/ideas', async (req) => {
  const filter = String(req.query.filter || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim();
  let rows = ideaStmts.list.all();
  if (status) rows = rows.filter((r) => r.status === status);
  if (filter) {
    rows = rows.filter((r) => r.name.toLowerCase().includes(filter)
      || String(r.sources || '').toLowerCase().includes(filter));
  }
  return { ideas: rows.map(hydrate) };
});

function hydrate(r) {
  let demand = null;
  try { demand = r.demand ? JSON.parse(r.demand) : null; } catch (e) { /* */ }
  return {
    id: r.id, name: r.name, status: r.status, rating: r.rating,
    stars: demand?.stars ?? null, hn_points: demand?.hnPoints ?? null,
    stars_today: demand?.starsToday ?? null, url: demand?.url ?? null,
    description: demand?.description ?? null,
    sources: safeParse(r.sources, []),
    velocity_delta: r.velocity_delta ?? null,
    cost_usd: r.cost_usd ?? null,
    first_seen: r.first_seen, last_seen: r.last_seen,
    researched_at: r.researched_at, approved_at: r.approved_at, queued_at: r.queued_at,
    has_error: Boolean(r.has_error),
  };
}
const safeParse = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; } };

app.get('/api/ideas/:id', async (req, reply) => {
  const r = ideaStmts.byId.get(Number(req.params.id));
  if (!r) return reply.code(404).send({ error: 'not_found', message: 'No such idea.', next_action: 'Pick one from the sidebar list.' });
  const h = hydrate(r);
  return {
    ...h,
    report: safeParse(r.report, null),
    trajectory: safeParse(r.trajectory, null),
    citations: safeParse(r.citations, []),
    usage: safeParse(r.usage_json, null),
    artifacts: safeParse(r.artifacts, []),
    research_error: r.research_error || null,
    raw_report_text: r.raw_report_text ? `${r.raw_report_text.slice(0, 4000)}${r.raw_report_text.length > 4000 ? '…' : ''}` : null,
    dispatch_log: r.dispatch_log || null,
  };
});

// ---------- SSE research progress ----------
app.get('/api/ideas/:id/events', async (req, reply) => {
  const id = Number(req.params.id);
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(`event: hello\ndata: ${JSON.stringify({ idea: id, active: researcher.activeCount() })}\n\n`);
  const listener = (payload) => {
    try { reply.raw.write(`event: progress\ndata: ${payload}\n\n`); } catch (e) { /* closed */ }
  };
  researcher.bus.on(`idea:${id}`, listener);
  const ping = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch (e) { /* */ } }, 15000);
  req.raw.on('close', () => { clearInterval(ping); researcher.bus.off(`idea:${id}`, listener); });
});

// ---------- research / approve / dismiss / rename ----------
app.post('/api/ideas/:id/research', async (req, reply) => {
  const id = Number(req.params.id);
  const r = ideaStmts.byId.get(id);
  if (!r) return reply.code(404).send({ error: 'not_found', message: 'No such idea.', next_action: 'Pick one from the sidebar list.' });
  if (!config.deepseekKey) {
    return reply.code(503).send({
      error: 'not_configured',
      message: 'DEEPSEEK_API_KEY is not set on this deployment — research is paused.',
      next_action: 'Railway → your service → Variables → add DEEPSEEK_API_KEY. Get a key at https://platform.deepseek.com/api_keys (API keys → Create). Setting the variable auto-redeploys and unpauses research.',
      link: 'https://platform.deepseek.com/api_keys',
    });
  }
  if (researcher.activeCount() >= config.researchConcurrency) {
    return reply.code(429).send({
      error: 'busy',
      message: `A research is already running (concurrency ${config.researchConcurrency}).`,
      next_action: 'Wait for the current research to finish, then retry.',
    });
  }
  watchRunner.queueIdea(id);
  reply.code(202).send({ queued: true, id, status: 'NEW' });
});

app.post('/api/ideas/:id/approve', async (req, reply) => {
  try {
    const res = await approveIdea(Number(req.params.id));
    reply.send(res);
  } catch (e) {
    reply.code(400).send({ error: 'approve_failed', message: String(e.message || e).slice(0, 300), next_action: 'Check the idea exists and try again.' });
  }
});

app.post('/api/ideas/:id/dismiss', async (req, reply) => {
  const id = Number(req.params.id);
  const r = ideaStmts.byId.get(id);
  if (!r) return reply.code(404).send({ error: 'not_found', message: 'No such idea.', next_action: 'Pick one from the sidebar list.' });
  ideaStmts.setStatus.run('DISMISSED', null, id);
  db.prepare('UPDATE ideas SET research_error = NULL WHERE id = ?').run(id);
  reply.send({ dismissed: true, id });
});

app.post('/api/ideas/:id/rename', async (req, reply) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name || name.length > 200) return reply.code(400).send({ error: 'bad_name', message: 'Provide a name (1-200 chars).', next_action: 'Retry with a shorter name.' });
  const id = Number(req.params.id);
  if (!ideaStmts.byId.get(id)) return reply.code(404).send({ error: 'not_found', message: 'No such idea.', next_action: 'Pick one from the sidebar list.' });
  ideaStmts.rename.run(name, id);
  reply.send({ renamed: true, id, name });
});

// ---------- artifacts (whitelist-only; /data itself is never served) ----------
app.get('/api/ideas/:id/artifacts/:name', async (req, reply) => {
  const id = Number(req.params.id);
  const r = ideaStmts.byId.get(id);
  if (!r) return reply.code(404).send({ error: 'not_found', message: 'No such idea.' });
  const wanted = String(req.params.name || '');
  if (!/^[a-z0-9._-]+$/i.test(wanted)) return reply.code(400).send({ error: 'bad_name', message: 'Artifact name restricted to [a-z0-9._-].' });
  const artifacts = safeParse(r.artifacts, []);
  const meta = artifacts.find((a) => a.name === wanted);
  if (!meta) return reply.code(404).send({ error: 'not_found', message: `No artifact named ${wanted} for this idea.`, next_action: 'Approve the idea to generate implementation-prompt.md, or run a research to get research.md.' });
  const p = path.join(config.dataDir, 'artifacts', String(id), wanted);
  if (!fs.existsSync(p)) return reply.code(410).send({ error: 'gone', message: 'Artifact file missing from the volume.', next_action: 'Re-run the research / re-approve to regenerate it.' });
  const content = fs.readFileSync(p);
  reply.header('Content-Type', 'text/markdown; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="${wanted}"`);
  reply.send(content);
});

// ---------- worker info + digests ----------
app.get('/api/worker', async () => {
  let hb = null;
  try { hb = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'worker-heartbeat.json'), 'utf8')); } catch (e) { /* */ }
  return {
    heartbeat: hb,
    running: watchRunner.isRunning(),
    lastRun: watchRunner.lastRun(),
    loopState: watchRunner.state(),
    boot: watchRunner.boot(),
    next_full_at: `${String(config.fullRunHour).padStart(2, '0')}:00 UTC (if not already run today)`,
    digests: digestStmts.all(),
  };
});

// ---------- marketplace rescan (monthly coverage refresh) ----------
app.post('/api/rescan', async (req, reply) => {
  const logFile = path.join(config.dataDir, 'rescan.log');
  const child = require('child_process').spawn(process.execPath, ['rescan-full.js'], {
    cwd: path.join(__dirname, '..', 'watcher'),
    env: { ...process.env, IDEA_WATCH_DATA_DIR: config.dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  child.stdout.pipe(out); child.stderr.pipe(out);
  child.on('close', (code) => { out.end(`\n[rescan] exit=${code} ${now()}\n`); });
  reply.code(202).send({ started: true, note: 'Marketplace rescan running in background (10 categories, ~1-2 min). Log: /data/rescan.log' });
});

// ---------- boot ----------
writeFirstLoginFile();
bootBanner();
watchRunner.start();

app.listen({ port: config.port, host: '0.0.0.0' })
  .then(() => console.log(`[harness] listening on :${config.port}`))
  .catch((e) => { console.error('[harness] listen failed', e); process.exit(1); });

module.exports = app;
