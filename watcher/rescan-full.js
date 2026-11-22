// watcher/rescan-full.js — monthly marketplace coverage refresh (ported from the
// workspace rescan_full.js GraphQL category loop). Rewrites coverage-cache.json in
// IDEA_WATCH_DATA_DIR (falls back to this directory) with the fresh full-market
// snapshot. Triggered by the UI Settings -> "Rescan marketplace now" (POST /api/rescan)
// or manually: node watcher/rescan-full.js
'use strict';
const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = process.env.IDEA_WATCH_DATA_DIR ? path.resolve(process.env.IDEA_WATCH_DATA_DIR) : __dirname;

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 200));
  return json.data;
}

const PAGE_Q = `
query($c: String, $first: Int!, $after: String) {
  templateSearch(first: $first, after: $after, query: "", category: $c) {
    edges { node { id code name creatorName description deploymentCount healthScore isVerified } }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Known-good category list (Sep-12 rescan proven: 3,792 unique templates)
const CATEGORIES = ['ai/ml', 'analytics', 'authentication', 'automation', 'blogs', 'bots',
  'cms', 'observability', 'other', 'starters', 'storage', 'queues'];

async function pageCategory(slug) {
  const out = [];
  let after = null;
  for (;;) {
    const d = await gql(PAGE_Q, { c: slug, first: 100, after });
    const conn = d.templateSearch;
    for (const e of conn.edges) out.push(e.node);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor || out.length >= 1200) break;
    after = conn.pageInfo.endCursor;
    await sleep(150);
  }
  return out;
}

async function main() {
  const byCode = new Map();
  for (const slug of CATEGORIES) {
    const rows = await pageCategory(slug);
    for (const n of rows) {
      if (!byCode.has(n.code)) byCode.set(n.code, { ...n, categories: [slug] });
      else if (!byCode.get(n.code).categories.includes(slug)) byCode.get(n.code).categories.push(slug);
    }
    console.error(`${slug}: ${rows.length}`);
    await sleep(200);
  }
  const all = [...byCode.values()];
  // coverage-cache shape: the fields watch.js nameMatches + the researcher's
  // coverage_check context actually use (code/name) plus demand context extras.
  const recs = all.map((r) => ({
    code: r.code, name: r.name,
    deploys: r.deploymentCount ?? null, health: r.healthScore ?? null,
    creator: r.creatorName ?? null,
  }));
  const outFile = path.join(DATA, 'coverage-cache.json');
  fs.writeFileSync(outFile, JSON.stringify(recs));
  console.log(`Total unique: ${all.length}`);
  console.log(`Coverage cache rewritten: ${outFile} (${recs.length} records)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
