// idea-watch/watch.js — template-idea watcher (full 4×/day sweep + hourly --fast mode)
// Pipeline: fetch catalogs + discovery (GitHub search/trending, HN show+front, lobsters,
// reddit) + velocity re-check → classify (coverage set, seen-ledger, blocklist) →
// demand filter → digest .md + optional push (Telegram/Discord, file or env creds).
// Reuses verified parsers from sweep_catalogs.js / sweep_fixups*.js / crossref_catalogs.js.
'use strict';
const fs = require('fs');
const path = require('path');
const __dirnameFixed = __dirname;
const DATA = process.env.IDEA_WATCH_DATA_DIR ? path.resolve(process.env.IDEA_WATCH_DATA_DIR) : __dirnameFixed;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jget(url, opts) {
  const headers = { 'User-Agent': 'idea-watch', ...(opts?.headers || {}) };
  if (/api\.github\.com/.test(url) && process.env.GITHUB_TOKEN && !headers.Authorization) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { ...opts, headers, signal: opts?.signal || AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---------- normalization + matching (verbatim from crossref_catalogs.js) ----------
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter(Boolean);
function nameMatches(appName, template) {
  const a = norm(appName);
  if (!a) return false;
  const targets = [norm(template.name), norm(template.code)];
  for (const b of targets) {
    if (!b) continue;
    if (b.includes(a) || a.includes(b)) return true;
    const at = tokens(appName).filter(t => t.length >= 3);
    if (at.length && at.every(t => b.split(' ').includes(t))) return true;
  }
  return false;
}
const ALIASES = { traccar: ['tracker gps tracking software'], piwigo: ['piwigo one click'] };

// ---------- blocklist ----------
const BLOCKLIST = require('./blocklist.json');
const normList = (arr) => new Set(arr.map(norm));
const BLOCK_EXACT = normList(BLOCKLIST.names);
const BLOCK_REGEX = (BLOCKLIST.regexes || []).map(r => new RegExp(r, 'i'));
function isBlocked(name) {
  const n = norm(name);
  if (BLOCK_EXACT.has(n)) return true;
  return BLOCK_REGEX.some(re => re.test(n));
}

// ---------- coverage set ----------
function loadCoverage() {
  const recs = [];
  const push = (f, map) => { try { for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) { const m = map(r); if (m) recs.push(m); } } catch (e) { console.error(`coverage load failed: ${f} ${e.message.slice(0, 80)}`); } };
  push(path.join(__dirnameFixed, '..', 'templates_full_2026-11-09.json'), r => ({ code: r.code, name: r.name, deploys: r.deploymentCount, health: r.healthScore, creator: r.creatorName }));
  push(path.join(__dirnameFixed, '..', 'templates_cohort_snapshot.json'), r => ({ code: r.code, name: r.name, deploys: r.deploymentCount, health: r.healthScore, creator: r.creatorName }));
  push(path.join(__dirnameFixed, '..', 'own_traction_2026-11-15.json'), r => r.status === 'ok' ? { code: r.code, name: r.name, deploys: r.projects, health: r.health, creator: r.creator?.name } : null);
  if (!recs.length) return loadCoverageCache(); // cloud image: snapshots not baked — use the cache
  return recs;
}
function coverageCacheFile() {
  const inData = path.join(DATA, 'coverage-cache.json');
  return fs.existsSync(inData) ? inData : path.join(__dirnameFixed, 'coverage-cache.json');
}
function loadCoverageCache() {
  try {
    return JSON.parse(fs.readFileSync(coverageCacheFile(), 'utf8'));
  } catch (e) { console.error('coverage-cache missing/stale — coverage filtering degraded this run'); return []; }
}
function writeCoverageCache(recs) {
  try { fs.writeFileSync(path.join(DATA, 'coverage-cache.json'), JSON.stringify(recs.map(r => ({ code: r.code, name: r.name })))); } catch (e) { console.error(`coverage-cache write failed: ${e.message.slice(0, 80)}`); }
}

// ---------- catalog fetchers (fixup-corrected parsers) ----------
async function fetchCatalogs() {
  const out = {};
  // selfhst (demand layer too)
  try {
    const d = await jget('https://raw.githubusercontent.com/rocketnova/selfhst-apps/main/data/projects.json');
    const arr = Array.isArray(d) ? d : d.projects || [];
    out.selfhst = arr.filter(p => (p.Type || p.type) === 'Software' && (p.Project || p.project))
      .map(p => ({ name: p.Project || p.project, stars: p.Stars ?? p.stars ?? null, license: p.License || p.license || null, description: (p.Description || '').slice(0, 160) }));
  } catch (e) { out.selfhst_err = e.message.slice(0, 100); }
  await sleep(250);
  // cloudron
  try {
    const d = await jget('https://api.cloudron.io/api/v1/apps');
    out.cloudron = (d.apps || []).filter(a => a.visibility === 'listed' && a.publishState === 'approved')
      .map(a => ({ name: a.manifest?.title || a.id, description: (a.manifest?.description || '').slice(0, 160) }));
  } catch (e) { out.cloudron_err = e.message.slice(0, 100); }
  await sleep(250);
  // truenas
  try {
    const d = await jget('https://raw.githubusercontent.com/truenas/apps/master/catalog.json');
    const apps = [];
    for (const [train, buckets] of Object.entries(d)) {
      if (typeof buckets !== 'object' || !buckets) continue;
      for (const [name, meta] of Object.entries(buckets)) {
        if (typeof meta !== 'object' || !meta) continue;
        apps.push({ name, train, categories: meta.categories || null });
      }
    }
    out.truenas = apps;
  } catch (e) { out.truenas_err = e.message.slice(0, 100); }
  await sleep(250);
  // elestio
  try {
    const d = await jget('https://api.elest.io/api/servers/getTemplates');
    out.elestio = (d.instances || []).map(t => ({ name: t.title, category: t.category, popular: t.isPopular ?? null }));
  } catch (e) { out.elestio_err = e.message.slice(0, 100); }
  await sleep(250);
  // portainer
  try {
    const d = await jget('https://raw.githubusercontent.com/portainer/templates/v3/templates.json');
    out.portainer = (d.templates || []).map(t => ({ name: t.name, categories: t.categories }));
  } catch (e) { out.portainer_err = e.message.slice(0, 100); }
  await sleep(250);
  // casaos
  try {
    const repo = await jget('https://api.github.com/repos/iceWhaleTech/CasaOS-AppStore');
    const t = await jget(`https://api.github.com/repos/iceWhaleTech/CasaOS-AppStore/git/trees/${repo.default_branch}?recursive=1`);
    const jsons = (t.tree || []).filter(e => e.type === 'blob' && /featured-apps\.json$|index.*\.json$/.test(e.path)).map(e => e.path);
    for (const p of jsons) {
      try {
        const d = await jget(`https://raw.githubusercontent.com/iceWhaleTech/CasaOS-AppStore/${repo.default_branch}/${p}`);
        const arr = d.apps || d.Apps || (Array.isArray(d) ? d : null);
        if (!arr || !arr.length) continue;
        out.casaos = arr.map(a => ({ name: a.name?.en || a.name || a.title || null, tagline: a.tagline?.en || null })).filter(a => a.name);
        break;
      } catch (e) { /* next */ }
    }
  } catch (e) { out.casaos_err = e.message.slice(0, 100); }
  await sleep(300);
  // tree listings
  async function treeListing(owner, repo, matchRe) {
    const repoMeta = await jget(`https://api.github.com/repos/${owner}/${repo}`);
    const t = await jget(`https://api.github.com/repos/${owner}/${repo}/git/trees/${repoMeta.default_branch}?recursive=1`);
    const names = new Set();
    for (const e of t.tree || []) {
      if (e.type !== 'blob') continue;
      const m = e.path.match(matchRe);
      if (m) names.add(m[1]);
    }
    return [...names].sort();
  }
  try { out.runtipi = await treeListing('runtipi', 'runtipi-appstore', /apps\/([^\/]+)\/config\.json$/); } catch (e) { out.runtipi_err = e.message.slice(0, 100); }
  await sleep(300);
  try { out.caprover = await treeListing('caprover', 'one-click-apps', /apps\/(.+)\.(yml|yaml)$/); } catch (e) { out.caprover_err = e.message.slice(0, 100); }
  await sleep(300);
  try { out.cosmos = await treeListing('azukaar', 'cosmos-servapps-official', /servapps\/([^\/]+)\//); } catch (e) { out.cosmos_err = e.message.slice(0, 100); }
  await sleep(300);
  try { out.easypanel = await treeListing('easypanel-io', 'templates', /templates\/([^\/]+)\/(index\.ts|meta\.yaml)$/); } catch (e) { out.easypanel_err = e.message.slice(0, 100); }
  return out;
}

// ---------- discovery sources ----------
async function fetchGithubDiscovery() {
  // GitHub search: 10 req/min unauthenticated — queries 6.5 s apart; skip on rate-limit.
  // First query is a rolling 7-day window: catches explosive newborn repos early.
  const weekAgo = new Date(Date.now() - 7 * 86400).toISOString().slice(0, 10);
  const queries = [
    `created:>=${weekAgo} stars:>=50`,
    'self-hosted created:>2026-08-01 stars:>50',
    'selfhosted created:>2026-09-01 stars:>50',
    'topic:self-hosted created:>2026-09-15 stars:>100',
  ];
  const out = [];
  for (const q of queries) {
    try {
      const d = await jget(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`);
      for (const r of d.items || []) {
        const ageDays = Math.floor((Date.now() - new Date(r.created_at)) / 86400000);
        out.push({ name: r.name, full: r.full_name, stars: r.stargazers_count, forks: r.forks_count, description: (r.description || '').slice(0, 160), ageDays, url: r.html_url, source: 'github-discovery' });
      }
    } catch (e) { out.push({ name: `[github-search failed: ${e.message.slice(0, 60)}]`, stars: null }); }
    await sleep(6500); // 10 req/min unauthenticated
  }
  return out;
}

async function fetchTrending() {
  // github.com/trending HTML scrape (no official API). Page announced for removal —
  // treat parse failure as non-fatal. "N stars today/this week" = built-in velocity.
  const out = [];
  for (const since of ['daily', 'weekly']) {
    try {
      const res = await fetch(`https://github.com/trending?since=${since}`, { headers: { 'User-Agent': 'idea-watch', Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const articles = html.split('<article').slice(1);
      let parsed = 0;
      for (const art of articles) {
        // repo link lives in the h2 heading (first href may be a sponsor/login button)
        const mRepo = art.match(/<h2[^>]*>\s*<a[^>]*href="\/([\w.-]+\/[\w.-]+)"/);
        if (!mRepo) continue;
        const full = mRepo[1];
        const base = full.split('/')[1];
        const mToday = art.match(/([\d,]+)\s+stars\s+(today|this week)/);
        // counts sit inside <a href=".../stargazers"><svg/>N</a> — the number is the
        // last thing before </a>; class names like "tmp-mr-3" must not fuse into it
        const anchorNum = (tail) => {
          const m = art.match(tail);
          if (!m) return null;
          const end = m[0].match(/([\d,]+)\s*<\/a>\s*$/) || m[0].match(/([\d,]+)\s*$/);
          if (!end) return null;
          const v = parseInt(end[1].replace(/,/g, ''), 10);
          return Number.isFinite(v) ? v : null;
        };
        const stars = anchorNum(/href="\/[\w.-]+\/[\w.-]+\/stargazers"[\s\S]*?<\/a>/);
        const forks = anchorNum(/href="\/[\w.-]+\/[\w.-]+\/forks"[\s\S]*?<\/a>/);
        const mDesc = art.match(/<p class="col-9[^"]*">\s*([^<]+?)\s*<\/p>/);
        if (!mToday && stars == null) continue;
        parsed++;
        out.push({
          name: base, full,
          stars,
          forks,
          starsToday: mToday ? parseInt(mToday[1].replace(/,/g, ''), 10) : null,
          since,
          description: mDesc ? mDesc[1].slice(0, 160) : null,
          url: `https://github.com/${full}`,
          source: since === 'daily' ? 'github-trending' : 'github-trending-weekly',
        });
      }
      if (!parsed) out.push({ name: `[trending parse failed: 0 repos from ${since} page]`, stars: null });
    } catch (e) { out.push({ name: `[trending failed: ${e.message.slice(0, 60)}]`, stars: null }); }
    await sleep(1000);
  }
  return out;
}

async function fetchHN() {
  // Show-HN, 7-day window, points >= 30 (Algolia, unauth, no key)
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const out = [];
  for (const q of ['self-hosted', 'selfhosted', 'open source alternative']) {
    try {
      const d = await jget(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=show_hn&numericFilters=created_at_i>${since},points>30&hitsPerPage=30`);
      for (const h of d.hits || []) {
        out.push({ name: h.title, points: h.points, comments: h.num_comments, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, created: h.created_at, source: 'hn-showhn' });
      }
    } catch (e) { out.push({ name: `[hn failed: ${e.message.slice(0, 60)}]`, points: null }); }
    await sleep(1000);
  }
  return out;
}

async function fetchHNFrontPage() {
  // HN front page: catches OSS going viral via ANY story (incl. social-media
  // announcements), the moment it lands on the front page. 48h window.
  const since = Math.floor(Date.now() / 1000) - 48 * 3600;
  const out = [];
  try {
    const d = await jget(`https://hn.algolia.com/api/v1/search_by_date?tags=front_page&numericFilters=created_at_i>${since}&hitsPerPage=50`);
    for (const h of d.hits || []) {
      out.push({ name: h.title, points: h.points, comments: h.num_comments, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, created: h.created_at, source: 'hn-front' });
    }
  } catch (e) { out.push({ name: `[hn-front failed: ${e.message.slice(0, 60)}]`, points: null }); }
  return out;
}

async function fetchLobsters() {
  // lobste.rs newest JSON, selfhosting tag only (low volume, cheap)
  const out = [];
  try {
    const d = await jget('https://lobste.rs/newest.json', { headers: { 'User-Agent': 'idea-watch/1.0 (personal monitoring)' } });
    for (const s of Array.isArray(d) ? d : []) {
      if (!(s.tags || []).includes('selfhosting')) continue;
      out.push({ name: s.title, points: s.score, comments: s.comment_count, url: s.url || s.short_id_url, created: s.created_at, source: 'lobsters' });
    }
  } catch (e) { out.push({ name: `[lobsters failed: ${e.message.slice(0, 60)}]`, points: null }); }
  return out;
}

async function fetchReddit() {
  // Reddit new.json for selfhost-adjacent subs linking to GitHub repos.
  // Datacenter IPs are frequently 403-blocked — best-effort, silent skip.
  const out = [];
  let blocked = false;
  for (const sub of ['selfhosted', 'opensource']) {
    try {
      const d = await jget(`https://www.reddit.com/r/${sub}/new.json?limit=50`, { headers: { 'User-Agent': 'idea-watch/1.0 (personal monitoring script)' } });
      for (const c of d?.data?.children || []) {
        const p = c.data || {};
        const gh = (p.url_overridden_by_dest || p.url || '').match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
        if (!gh) continue;
        const base = gh[2].replace(/\.git$/, '');
        if (!base || ['about', 'topics'].includes(base)) continue;
        out.push({ name: base, points: p.score, comments: p.num_comments, url: `https://github.com/${gh[1]}/${gh[2]}`, description: (p.title || '').slice(0, 160), created: new Date((p.created_utc || 0) * 1000).toISOString(), source: `reddit-${sub}` });
      }
    } catch (e) {
      if (/HTTP 403|HTTP 429/.test(e.message)) blocked = true;
      else out.push({ name: `[reddit-${sub} failed: ${e.message.slice(0, 60)}]`, points: null });
    }
    await sleep(500);
  }
  return { items: out, blocked };
}

// ---------- velocity re-check (ledger star-deltas = star velocity) ----------
const VELOCITY_MIN_DELTA = parseInt(process.env.VELOCITY_MIN_DELTA || '80', 10);
const VELOCITY_CAP = parseInt(process.env.VELOCITY_CAP || '20', 10);
async function checkVelocity(seen, nowIso) {
  const alerts = [];
  const entries = Object.entries(seen)
    .filter(([k, e]) => ['candidate', 'watch'].includes(e.status) && e.demand?.url && /github\.com\/[\w.-]+\/[\w.-]+/.test(e.demand.url))
    .filter(([k, e]) => (Date.now() - new Date(e.firstSeen).getTime()) < 21 * 86400000)
    .sort((a, b) => String(a[1].lastChecked || '').localeCompare(String(b[1].lastChecked || '')))
    .slice(0, VELOCITY_CAP);
  for (const [key, e] of entries) {
    const m = e.demand.url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
    const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
    try {
      const r = await jget(`https://api.github.com/repos/${repo}`);
      const stars = r.stargazers_count;
      const base = e.lastStars ?? e.demand.stars ?? null;
      e.lastStars = stars;
      e.lastChecked = nowIso;
      if (stars > (e.demand.stars ?? 0)) e.demand.stars = stars;
      if (base != null && stars - base >= VELOCITY_MIN_DELTA) {
        alerts.push({ name: e.name, delta: stars - base, stars, forks: r.forks_count, url: e.demand.url });
      }
    } catch (err) {
      if (/403|429/.test(err.message)) { console.log(`velocity: rate-limited at ${repo}, stopping re-check`); break; }
    }
    await sleep(300);
  }
  return alerts;
}

// ---------- notify ----------
async function pushNotify(text) {
  const nf = path.join(DATA, 'notify.json');
  let n = {};
  try { if (fs.existsSync(nf)) n = JSON.parse(fs.readFileSync(nf, 'utf8')); } catch (e) { /* fall through to env */ }
  const tgToken = n.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = n.telegramChatId || process.env.TELEGRAM_CHAT_ID;
  try {
    if (n.discordWebhookUrl) {
      const res = await fetch(n.discordWebhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) });
      if (!res.ok) return { pushed: false, reason: `discord HTTP ${res.status}` };
      return { pushed: true, channel: 'discord' };
    }
    if (tgToken && tgChat) {
      const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: tgChat, text: text.slice(0, 4000) }) });
      if (!res.ok) return { pushed: false, reason: `telegram HTTP ${res.status}` };
      return { pushed: true, channel: 'telegram' };
    }
    return { pushed: false, reason: 'no channel configured (notify.json / env)' };
  } catch (e) { return { pushed: false, reason: e.message.slice(0, 100) }; }
}

function buildPushLines(newHigh, velocityAlerts) {
  const lines = [];
  for (const r of newHigh) {
    lines.push(`🚀 ${r.name}` +
      (r.stars ? ` — ★${r.stars}` : '') +
      (r.hnPoints ? ` — HN ${r.hnPoints}pts` : '') +
      ` [${r.sources.join('+')}]` +
      (r.description ? ` — ${String(r.description).slice(0, 100)}` : '') +
      (r.url ? ` — ${r.url}` : ''));
  }
  for (const v of velocityAlerts) {
    lines.push(`📈 ${v.name} +${v.delta}★ since last check (now ${v.stars}★, ${v.forks} forks) — ${v.url}`);
  }
  return lines;
}

// ---------- selftest ----------
async function selfTest() {
  const results = [];
  const t = async (name, fn) => {
    try { const info = await fn(); results.push([name, 'OK', info]); }
    catch (e) { results.push([name, 'FAIL', String(e.message).slice(0, 90)]); }
  };
  await t('github api + rate limit', async () => {
    const d = await jget('https://api.github.com/rate_limit');
    return `core ${d.resources.core.remaining}/${d.resources.core.limit}, search ${d.resources.search.remaining}/${d.resources.search.limit}${process.env.GITHUB_TOKEN ? ' (token)' : ''}`;
  });
  await t('github trending parse', async () => {
    const r = await fetchTrending();
    const ok = r.filter(x => x.source && !x.name.startsWith('['));
    if (!ok.length) throw new Error(r[0]?.name || 'no repos parsed');
    return `${ok.length} repos (daily+weekly)`;
  });
  await t('hn showhn', async () => { const h = await fetchHN(); return `${h.length} hits (7d)`; });
  await t('hn front_page', async () => { const h = await fetchHNFrontPage(); return `${h.length} hits (48h)`; });
  await t('lobsters selfhosting', async () => { const h = await fetchLobsters(); return `${h.length} posts`; });
  await t('reddit (best-effort)', async () => {
    const r = await fetchReddit();
    return r.blocked ? `BLOCKED 403/429 — skipped (non-fatal), ${r.items.length} posts` : `${r.items.length} posts`;
  });
  await t('ledger writable', async () => {
    const p = path.join(DATA, '.selftest-write');
    fs.writeFileSync(p, 'ok'); const v = fs.readFileSync(p, 'utf8'); fs.unlinkSync(p);
    if (v !== 'ok') throw new Error('readback mismatch');
    return path.join(DATA, 'seen.json');
  });
  await t('coverage cache', async () => {
    const c = loadCoverageCache();
    if (!c.length) throw new Error('empty — run full watch.js once to build it');
    return `${c.length} records (${coverageCacheFile()})`;
  });
  await t('telegram', async () => {
    const nf = path.join(DATA, 'notify.json');
    let n = {};
    try { if (fs.existsSync(nf)) n = JSON.parse(fs.readFileSync(nf, 'utf8')); } catch (e) { /* env fallback */ }
    const token = n.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
    const chat = n.telegramChatId || process.env.TELEGRAM_CHAT_ID;
    if (!token) return 'NOT CONFIGURED (expected until bot is set up)';
    const me = await jget(`https://api.telegram.org/bot${token}/getMe`);
    const msg = await jget(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: `✅ idea-watch selftest OK — ${new Date().toISOString()}` }) });
    return `bot @${me.result.username} → message delivered (chat ${msg.result.chat.id}) — check your phone`;
  });
  const width = Math.max(...results.map(r => r[0].length));
  console.log('\n== selftest ==');
  for (const [name, status, info] of results) console.log(`  ${name.padEnd(width)}  ${status}  ${info}`);
  const fails = results.filter(r => r[1] === 'FAIL').length;
  console.log(`SELFTEST: ${fails ? 'FAIL' : 'PASS'} (${results.length - fails}/${results.length} ok)`);
  return fails === 0;
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const SEED = args.includes('--seed');
  const TEST_INJECT = args.includes('--test-inject');
  const FAST = args.includes('--fast');
  const now = new Date();
  const nowIso = now.toISOString();
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-').slice(0, 13);
  const digestDir = FAST ? path.join(DATA, 'digests', 'fast') : path.join(DATA, 'digests');
  const digestFile = path.join(digestDir, `${stamp}.md`);
  fs.mkdirSync(digestDir, { recursive: true });

  // first boot with a separate DATA dir: seed ledger from the baked copy
  const stateFile = path.join(DATA, 'seen.json');
  if (DATA !== __dirnameFixed && !fs.existsSync(stateFile) && fs.existsSync(path.join(__dirnameFixed, 'seen.json'))) {
    fs.copyFileSync(path.join(__dirnameFixed, 'seen.json'), stateFile);
    console.log('seeded ledger copy into DATA dir');
  }
  const seen = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const seenCount0 = Object.keys(seen).length;

  let cats = {}, catNames = [], coverage;
  if (FAST) {
    console.log('== fast mode: discovery-only (catalogs skipped) ==');
    coverage = loadCoverageCache();
    console.log(`coverage cache: ${coverage.length} records`);
  } else {
    console.log('== fetching catalogs ==');
    cats = await fetchCatalogs();
    catNames = Object.keys(cats).filter(k => !k.endsWith('_err'));
    console.log('catalogs ok:', catNames.join(', '));
    console.log('== coverage set ==');
    coverage = loadCoverage();
    writeCoverageCache(coverage);
    console.log(`coverage records: ${coverage.length} (cache written)`);
  }

  console.log('== discovery sources ==');
  const gh = await fetchGithubDiscovery();
  const trending = await fetchTrending();
  const hn = await fetchHN();
  const hnFront = await fetchHNFrontPage();
  const lobsters = await fetchLobsters();
  const reddit = await fetchReddit();
  console.log(`github-discovery: ${gh.filter(r => r.source).length} | trending: ${trending.filter(r => r.source).length} | hn: ${hn.filter(r => r.source).length} | hn-front: ${hnFront.filter(r => r.source).length} | lobsters: ${lobsters.filter(r => r.source).length} | reddit: ${reddit.items.length}${reddit.blocked ? ' (403-blocked, skipped)' : ''}`);

  // demand index from selfhst (full mode only)
  const demandIdx = new Map((cats.selfhst || []).map(a => [norm(a.name), a]));

  // classify every candidate from catalogs + discovery
  const candidates = new Map(); // norm -> {name, sources:Set, demand, description, blocked, blockedBy, covered}
  function addCandidate(name, source, extra) {
    if (!name || typeof name !== 'string') return;
    if (!source || name.startsWith('[')) return; // diagnostics (e.g. "[reddit failed: …]") are not candidates
    const n = norm(name);
    if (!n || n.length < 2) return;
    const c = candidates.get(n) || { name, sources: new Set(), demand: null, description: null, covered: false, blocked: false };
    c.sources.add(source);
    if (extra?.stars != null && c.demand?.stars == null) c.demand = { stars: extra.stars, starsToday: extra.starsToday ?? null, forks: extra.forks ?? null, description: extra.description || null, url: extra.url || null };
    if (extra?.points != null && c.demand?.hnPoints == null) c.demand = { ...(c.demand || {}), hnPoints: extra.points };
    if (extra?.description && !c.description) c.description = extra.description;
    candidates.set(n, c);
  }

  let coveredCount = 0;
  if (!FAST) {
    for (const cat of catNames) {
      for (const app of cats[cat] || []) {
        const name = typeof app === 'string' ? app : (app.name || app.title || null);
        if (!name) continue;
        let covered = coverage.some(t => nameMatches(name, t)) || (ALIASES[norm(name)] || []).some(al => coverage.some(t => norm(t.name).includes(al) || norm(t.code).includes(al)));
        if (covered) { coveredCount++; continue; }
        addCandidate(name, cat, { stars: app.stars ?? null, description: app.description || null });
      }
    }
  } else {
    // fast mode: discovery candidates must pass the coverage cache
    for (const r of gh) if (r.source && coverage.some(t => nameMatches(r.name, t))) { coveredCount++; r.skip = true; }
    for (const tr of trending) if (tr.source && coverage.some(t => nameMatches(tr.name, t))) { coveredCount++; tr.skip = true; }
  }
  // discovery sources are all "not covered by definition" — they ARE the coverage reference
  for (const r of gh) if (!r.skip) addCandidate(r.name, 'github-discovery', { stars: r.stars, forks: r.forks, description: r.description, url: r.url });
  for (const tr of trending) if (!tr.skip) addCandidate(tr.name, tr.source, { stars: tr.stars, starsToday: tr.starsToday, forks: tr.forks, description: tr.description, url: tr.url });
  for (const h of hn) addCandidate(h.name, 'hn-showhn', { hnPoints: h.points, description: h.url });
  for (const h of hnFront) addCandidate(h.name, 'hn-front', { hnPoints: h.points, description: h.url });
  for (const h of lobsters) addCandidate(h.name, 'lobsters', { hnPoints: h.points, description: h.url });
  for (const h of reddit.items) addCandidate(h.name, h.source, { hnPoints: h.points, description: h.description, url: h.url });

  // TEST_INJECT: synthetic 900-star app
  if (TEST_INJECT) {
    addCandidate('Zz-Test-Injection App', 'cloudron', { stars: 900, description: 'SYNTHETIC TEST APP — safe to ignore' });
    candidates.set(norm('Zz-Test-Injection App'), { name: 'Zz-Test-Injection App', sources: new Set(['cloudron']), demand: { stars: 900, description: 'SYNTHETIC TEST APP' }, covered: false });
  }

  // classify
  const newHigh = [], newLow = [], blocked = [], known = [];
  for (const [n, c] of candidates) {
    if (c.covered) { coveredCount++; continue; }
    const blockedBy = isBlocked(c.name) ? 'verdict-blocklist' : null;
    if (blockedBy) { blocked.push({ name: c.name, reason: blockedBy }); continue; }
    const seenEntry = seen[n];
    const demand = c.demand || demandIdx.get(n) || null;
    const stars = demand?.stars ?? null;
    const hnPoints = demand?.hnPoints ?? null;
    const srcArr = [...c.sources];
    const high = (stars != null && stars >= 300)
      || (hnPoints != null && hnPoints >= 50)
      || (c.sources.has('hn-showhn') && hnPoints >= 50)
      || (c.sources.has('hn-front') && hnPoints >= 15)
      || (c.sources.has('lobsters') && hnPoints >= 10)
      || (srcArr.some(s => s && s.startsWith('reddit')) && hnPoints >= 20)
      || (c.sources.has('github-trending') && (demand?.starsToday ?? 0) >= 150)
      || (c.sources.has('github-trending-weekly') && (demand?.starsToday ?? 0) >= 400);
    const isNew = !seenEntry;
    if (seenEntry) { seen[n].lastSeen = nowIso; if (demand) seen[n].demand = demand; continue; }
    // genuinely new
    seen[n] = { name: c.name, firstSeen: nowIso, lastSeen: nowIso, sources: srcArr, demand, status: SEED ? 'seeded' : (high ? 'candidate' : 'watch') };
    const rec = { name: c.name, sources: srcArr, stars, hnPoints, starsToday: demand?.starsToday ?? null, description: c.description || (demand?.description ?? null), url: demand?.url ?? null, high };
    if (SEED) { seen[n].status = 'seeded'; }
    else if (high) newHigh.push(rec);
    else newLow.push(rec);
  }

  console.log('== velocity re-check ==');
  const velocityAlerts = SEED ? [] : await checkVelocity(seen, nowIso);
  if (velocityAlerts.length) for (const v of velocityAlerts) console.log(`  📈 ${v.name} +${v.delta}★ (now ${v.stars}★)`);

  fs.writeFileSync(stateFile, JSON.stringify(seen, null, 1));

  // push: fast mode pushes ONLY when there is news; full runs always push a heartbeat
  let pushText;
  const richLines = buildPushLines(newHigh, velocityAlerts);
  if (SEED) {
    pushText = `Idea-watch seeded: ${Object.keys(seen).length} items on ledger.`;
  } else if (richLines.length) {
    pushText = `🔭 idea-watch ${FAST ? 'hourly' : 'full'} — ${nowIso.slice(0, 16)}Z\n${richLines.join('\n')}`;
  } else if (FAST) {
    pushText = null; // quiet hourly run — no push (anti-spam)
  } else {
    pushText = `🔭 idea-watch full — no new high-potential finds; ledger ${Object.keys(seen).length} entries.`;
  }
  const pushResult = pushText === null ? { pushed: false, reason: 'quiet fast run — no push needed' } : await pushNotify(pushText);

  // digest
  const md = [];
  md.push(`# Idea-Watch Digest — ${nowIso}`);
  md.push('');
  md.push(`Mode: ${SEED ? 'SEED (ledger initialized)' : (FAST ? 'fast hourly' : 'regular full')} | ${FAST ? `coverage cache: ${coverage.length}` : `catalogs ok: ${catNames.length} | coverage: ${coverage.length} records`} | candidates seen: ${Object.keys(seen).length} (was ${seenCount0})`);
  md.push('');
  if (!SEED) {
    md.push(`## NEW high-potential (${newHigh.length})`);
    for (const r of newHigh.sort((a, b) => (b.stars || b.hnPoints || 0) - (a.stars || a.hnPoints || 0))) {
      md.push(`- **${r.name}** — ${r.stars ? `${r.stars}★ ` : ''}${r.starsToday ? `(+${r.starsToday} ${r.sources.includes('github-trending-weekly') ? 'this wk' : 'today'}) ` : ''}${r.hnPoints ? `HN ${r.hnPoints}pts ` : ''}[${r.sources.join(', ')}]${r.description ? ` — ${r.description}` : ''}${r.url ? ` — ${r.url}` : ''}`);
    }
    md.push('');
    md.push(`## Velocity spikes (${velocityAlerts.length})`);
    for (const v of velocityAlerts) md.push(`- 📈 **${v.name}** +${v.delta}★ since last check (now ${v.stars}★, ${v.forks} forks) — ${v.url}`);
    md.push('');
    md.push(`## New watch-tier (${newLow.length})`);
    for (const r of newLow.slice(0, 40)) md.push(`- ${r.name} — [${r.sources.join(', ')}]`);
    md.push('');
  }
  md.push(`## Blocked by verdict-blocklist: ${blocked.length}`);
  md.push(`## Covered by existing templates: ${coveredCount}`);
  md.push(`## Push: ${JSON.stringify(pushResult)} — ${pushText ?? '(quiet fast run — no push)'}`);
  fs.writeFileSync(digestFile, md.join('\n'));
  if (!FAST) fs.writeFileSync(path.join(DATA, 'LATEST.md'), `Latest digest: ${digestFile}\n\n` + md.join('\n'));

  console.log(`\n== digest ==`);
  console.log(`new high-potential: ${SEED ? '(seed mode — recorded, not surfaced)' : newHigh.length}`);
  console.log(`velocity spikes: ${velocityAlerts.length}`);
  console.log(`new watch-tier: ${SEED ? '(seeded)' : newLow.length}`);
  console.log(`blocked: ${blocked.length} | covered: ${coveredCount}`);
  console.log(`ledger: ${Object.keys(seen).length} entries`);
  console.log(`digest: ${digestFile}`);
  console.log(`push: ${JSON.stringify(pushResult)}`);
}

if (process.argv.includes('--selftest')) {
  selfTest().then(ok => process.exit(ok ? 0 : 1)).catch(e => { console.error(e); process.exit(1); });
} else {
  main().catch(e => { console.error(e); process.exit(1); });
}
