// src/db.js — better-sqlite3 (WAL) on the /data volume.
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'harness.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normkey TEXT NOT NULL UNIQUE,
  sources TEXT NOT NULL DEFAULT '[]',
  demand TEXT,
  velocity_delta INTEGER,
  status TEXT NOT NULL DEFAULT 'NEW',
  rating INTEGER,
  report TEXT,
  trajectory TEXT,
  citations TEXT,
  artifacts TEXT,
  usage_json TEXT,
  cost_usd REAL,
  research_error TEXT,
  raw_report_text TEXT,
  queued_at TEXT,
  researched_at TEXT,
  approved_at TEXT,
  dispatch_log TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
CREATE INDEX IF NOT EXISTS idx_ideas_last_seen ON ideas(last_seen);
CREATE TABLE IF NOT EXISTS digests (
  file TEXT PRIMARY KEY,
  stamp TEXT,
  mode TEXT,
  high INTEGER,
  velocity INTEGER,
  ledger INTEGER,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
`);

const now = () => new Date().toISOString();

// ---------- ideas ----------
const ideaStmts = {
  insert: db.prepare(`INSERT OR IGNORE INTO ideas
    (name, normkey, sources, demand, status, first_seen, last_seen, queued_at)
    VALUES (@name, @normkey, @sources, @demand, 'NEW', @now, @now, @now)`),
  byNormkey: db.prepare('SELECT * FROM ideas WHERE normkey = ?'),
  byId: db.prepare('SELECT * FROM ideas WHERE id = ?'),
  list: db.prepare(`SELECT id, name, status, rating, sources, demand, velocity_delta, cost_usd,
    first_seen, last_seen, researched_at, approved_at, queued_at, research_error IS NOT NULL AS has_error
    FROM ideas ORDER BY
    CASE status WHEN 'NEW' THEN 0 WHEN 'RESEARCHING' THEN 1 WHEN 'READY' THEN 2
      WHEN 'RESEARCH_FAILED' THEN 3 WHEN 'APPROVED' THEN 4 ELSE 5 END,
    last_seen DESC`),
  touch: db.prepare("UPDATE ideas SET last_seen = ?, demand = ?, sources = ? WHERE normkey = ? AND status NOT IN ('RESEARCHING')"),
  setVelocity: db.prepare('UPDATE ideas SET velocity_delta = ? WHERE normkey = ?'),
  setStatus: db.prepare('UPDATE ideas SET status = ?, queued_at = ? WHERE id = ?'),
  saveResearch: db.prepare(`UPDATE ideas SET status='READY', report=?, trajectory=?, citations=?,
    usage_json=?, cost_usd=?, artifacts=?, research_error=NULL, raw_report_text=NULL, researched_at=? WHERE id=?`),
  saveFailure: db.prepare('UPDATE ideas SET status = ?, research_error = ?, raw_report_text = ?, researched_at = ? WHERE id = ?'),
  saveArtifacts: db.prepare('UPDATE ideas SET artifacts = ? WHERE id = ?'),
  approve: db.prepare('UPDATE ideas SET status = ?, approved_at = ?, artifacts = ? WHERE id = ?'),
  rename: db.prepare('UPDATE ideas SET name = ? WHERE id = ?'),
  appendDispatch: db.prepare('UPDATE ideas SET dispatch_log = ? WHERE id = ?'),
};

function upsertIdea(entry, { velocityDelta = null } = {}) {
  const demandJson = entry.demand ? JSON.stringify(entry.demand) : null;
  const sourcesJson = JSON.stringify(entry.sources || []);
  const nowIso = now();
  const r = ideaStmts.insert.run({
    name: entry.name, normkey: entry.normkey, sources: sourcesJson,
    demand: demandJson, now: nowIso,
  });
  if (r.changes > 0) return { created: true, id: r.lastInsertRowid };
  ideaStmts.touch.run(nowIso, demandJson, sourcesJson, entry.normkey);
  if (velocityDelta) ideaStmts.setVelocity.run(velocityDelta, entry.normkey);
  const row = ideaStmts.byNormkey.get(entry.normkey);
  return { created: false, id: row ? row.id : null };
}

// ---------- digests ----------
const digestStmts = {
  insert: db.prepare('INSERT OR IGNORE INTO digests (file, stamp, mode, high, velocity, ledger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  all: db.prepare('SELECT * FROM digests ORDER BY stamp DESC LIMIT 60'),
  has: db.prepare('SELECT 1 FROM digests WHERE file = ?'),
};

// ---------- kv ----------
function kvGet(k) { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; }
function kvSet(k, v) { db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v)); }

module.exports = { db, ideaStmts, digestStmts, kvGet, kvSet, upsertIdea, now };
