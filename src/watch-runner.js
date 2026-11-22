// src/watch-runner.js — idea-watch v2 watcher loop (ported from idea-watch-worker/
// worker.js into the Fastify process). Runs watcher/watch.js VERBATIM as a child
// process: boot full-if-new-day -> hourly fast -> daily full at FULL_RUN_HOUR UTC.
// Single-flight guard; /data/worker-state.json + /data/worker-heartbeat.json in the
// worker's exact format; stdout counters parsed (new high-potential / velocity spikes
// + the per-alert 📈 lines); after each run the ledger deltas sync into the ideas
// table and digest files are indexed.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { ideaStmts, digestStmts, upsertIdea, now } = require('./db');
const researcher = require('./researcher');

const WATCH_DIR = path.join(__dirname, '..', 'watcher');
const DATA = config.dataDir;
const BOOT = new Date().toISOString();

let running = false;
let lastRun = null;

const stateFile = path.join(DATA, 'worker-state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { /* first boot */ }
const today = () => new Date().toISOString().slice(0, 10);
const persistState = () => {
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (e) { /* non-fatal */ }
};
function writeHeartbeat() {
  try {
    fs.writeFileSync(path.join(DATA, 'worker-heartbeat.json'), JSON.stringify({ lastRun, boot: BOOT }, null, 2));
  } catch (e) { /* non-fatal */ }
}

function normkey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function runWatch(mode) {
  return new Promise((resolve) => {
    if (running) { console.log(`[watch] ${mode} skipped — previous run still active`); return resolve('skipped'); }
    running = true;
    const started = new Date().toISOString();
    console.log(`[watch] ${mode} run starting ${started}`);
    const args = mode === 'fast' ? ['--fast'] : [];
    const child = spawn(process.execPath, ['watch.js', ...args], {
      cwd: WATCH_DIR,
      env: { ...process.env, IDEA_WATCH_DATA_DIR: DATA },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('close', (code) => {
      running = false;
      lastRun = {
        mode, started, finished: new Date().toISOString(), exitCode: code,
        high: parseInt((out.match(/new high-potential: (\d+)/) || [])[1] ?? 'NaN', 10) || 0,
        velocity: parseInt((out.match(/velocity spikes: (\d+)/) || [])[1] ?? 'NaN', 10) || 0,
      };
      writeHeartbeat();
      console.log(`[watch] ${mode} run done exit=${code} high=${lastRun.high} velocity=${lastRun.velocity}`);
      syncLedger(out);
      indexDigests();
      resolve(code);
    });
  });
}

// ---------- ledger -> ideas sync ----------
// watch.js keeps /data/seen.json keyed by norm(name) with statuses
// candidate/watch/seeded. NEW candidate+watch entries meeting the high-potential
// bar sync into the ideas table (INSERT OR IGNORE by normkey; demand refresh on
// re-see); velocity-spike names parsed from stdout get enqueued too.
function syncLedger(runOutput = '') {
  const ledgerFile = path.join(DATA, 'seen.json');
  let seen;
  try { seen = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch (e) { return { created: 0 }; }
  const velocityNames = new Map();
  for (const m of (runOutput || '').matchAll(/📈 (.+?) \+(\d+)★/g)) {
    velocityNames.set(normkey(m[1]), { name: m[1], delta: parseInt(m[2], 10) });
  }
  let created = 0;
  for (const [key, entry] of Object.entries(seen)) {
    if (!entry || !entry.name) continue;
    const isCandidate = entry.status === 'candidate';
    const isVeloced = velocityNames.has(key);
    if (!isCandidate && !isVeloced) continue; // watch-tier below the bar stays out
    const vel = isVeloced ? velocityNames.get(key).delta : null;
    const r = upsertIdea({
      name: entry.name, normkey: key, sources: entry.sources || [],
      demand: entry.demand || null,
    }, { velocityDelta: vel });
    if (r.created) {
      created++;
      console.log(`[sync] new idea queued: ${entry.name}`);
    }
  }
  // enqueue everything still NEW
  const newOnes = require('./db').db.prepare("SELECT id FROM ideas WHERE status = 'NEW'").all();
  for (const row of newOnes) queueResearch(row.id);
  return { created };
}

function indexDigests() {
  // digest files: DATA/digests/<stamp>.md (full) and DATA/digests/fast/<stamp>.md
  for (const [dirName, mode] of [['digests', 'full'], [path.join('digests', 'fast'), 'fast']]) {
    const dir = path.join(DATA, dirName);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch (e) { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      if (digestStmts.has.get(full)) continue;
      let high = 0; let velocity = 0; let ledger = 0;
      try {
        const md = fs.readFileSync(full, 'utf8');
        high = parseInt((md.match(/## NEW high-potential \((\d+)\)/) || [])[1] || '0', 10);
        velocity = parseInt((md.match(/## Velocity spikes \((\d+)\)/) || [])[1] || '0', 10);
        ledger = parseInt((md.match(/candidates seen: (\d+)/) || [])[1] || '0', 10);
      } catch (e) { /* index with zeros */ }
      digestStmts.insert.run(full, f.replace(/\.md$/, ''), mode, high, velocity, ledger, now());
    }
  }
}

// ---------- research queue (drains via researcher's concurrency lock) ----------
const queued = new Set();
function queueResearch(id) {
  const row = require('./db').db.prepare('SELECT status FROM ideas WHERE id = ?').get(id);
  if (!row || row.status !== 'NEW') return; // skip stale re-queues
  if (queued.has(id)) return;
  queued.add(id);
  // run async: researcher's own lock serializes (RESEARCH_CONCURRENCY, default 1).
  // NotConfigured (no key yet) leaves the idea NEW — the periodic drain below
  // retries it after the variable lands (guided no-key state -> auto-unpause).
  researcher.researchIdea(id)
    .catch((e) => {
      if (e && e.code === 'busy') {
        setTimeout(() => queueResearch(id), 90 * 1000); // re-queue once the slot frees
        return;
      }
      if (e && e.code === 'not_configured') return; // stays NEW; drain retries
      console.error(`[research] idea ${id} failed: ${e.message}`);
    })
    .finally(() => queued.delete(id));
}

// periodic drain: NEW ideas (incl. ones that hit the no-key guided state) get
// researched automatically once DEEPSEEK_API_KEY exists — "setting it auto-recovers".
setInterval(() => {
  if (!config.deepseekKey) return;
  try {
    const rows = require('./db').db.prepare("SELECT id FROM ideas WHERE status = 'NEW'").all();
    for (const r of rows) queueResearch(r.id);
  } catch (e) { /* non-fatal */ }
}, 5 * 60 * 1000).unref();

function queueIdea(id) {
  // explicit queue for API-initiated research
  ideaStmts.setStatus.run('NEW', now(), id);
  queueResearch(id);
}

async function loop() {
  // boot: full sweep if none recorded today (rebuilds coverage cache + heartbeat),
  // else a quick fast check — identical to idea-watch-worker's proven loop.
  if (state.lastFullDate !== today()) {
    await runWatch('full');
    state.lastFullDate = today();
    persistState();
  } else {
    await runWatch('fast');
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, config.fastIntervalMin * 60 * 1000));
    const n = new Date();
    const dueFull = n.getUTCHours() === config.fullRunHour && state.lastFullDate !== today();
    if (dueFull) {
      await runWatch('full');
      state.lastFullDate = today();
      persistState();
    } else {
      await runWatch('fast');
    }
  }
}

function start() {
  // boot reconciliation: a redeploy mid-research leaves RESEARCHING rows stuck —
  // re-queue them (the drain + auto-research resumes them).
  try {
    const stuck = require('./db').db.prepare("SELECT id FROM ideas WHERE status = 'RESEARCHING'").all();
    for (const r of stuck) {
      ideaStmts.setStatus.run('NEW', now(), r.id);
      console.log(`[boot] reconciled stuck RESEARCHING idea ${r.id} -> NEW`);
    }
  } catch (e) { /* non-fatal */ }
  loop().catch((e) => { console.error('[watch] fatal loop error', e); });
  console.log(`[watch] loop started: fast every ${config.fastIntervalMin}min, full daily ${config.fullRunHour}:00 UTC, data ${DATA}`);
}

module.exports = { start, runWatch, syncLedger, indexDigests, queueIdea, isRunning: () => running, lastRun: () => lastRun, state: () => state, boot: () => BOOT };
