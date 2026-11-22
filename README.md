# Template Idea Harness

Private, always-on idea pipeline for the Railway template practice — one Node 22 service that
watches for template ideas, researches each one with DeepSeek deep search, and waits for your
approval before a build. Live instance: https://template-harness-production.up.railway.app
(project `template-harness`, creator deploy; NOT published as a marketplace template — personal
infrastructure).

1. **Watcher** — idea-watch v2 (verbatim `watcher/watch.js`) runs on a schedule: full sweep at
   boot (if none today) and daily at `FULL_RUN_HOUR` UTC, hourly fast checks. Sources: GitHub
   search + trending, Hacker News (Show HN + front page), lobste.rs, Reddit, plus 10 app-store
   catalogs for marketplace coverage.
2. **Research agent** — every new high-potential idea gets ONE streaming DeepSeek call
   (`deepseek_web_search` + thinking = deep search): strict-JSON report (verdict, rating,
   demand, coverage check vs the marketplace snapshot, competitor scan, ToS/legal flags,
   implementation sketch, suggested name/slug, risks), full reasoning trajectory, citations
   (annotations + tool sources merged), per-idea cost. Concurrency 1; retries on
   408/429/5xx; 200-with-body-error handled; JSON repair call on parse failure.
3. **Review UI** — dark 3-pane workspace (password-gated): left = ideas with status chips +
   demand badges, center = report with collapsible live thinking panel (SSE), right = workspace
   files + dispatch log.
4. **Approve** — generates the full playbook-aware implementation prompt artifact (Steps 0-5 +
   acceptance criteria + ease-of-use block), pushes Telegram, copy + download one click.
   Auto-build stays a disabled v1.1 stub.

## Operations quickstart

1. **UI**: open the domain, log in with `APP_ACCESS_PASSWORD` (deploy logs `HARNESS FIRST LOGIN`
   banner or `railway ssh` + `cat /data/first-login.txt`; change it via the variable).
2. **Key**: `DEEPSEEK_API_KEY` set as a Railway variable (platform.deepseek.com -> API keys).
   Without it the service boots healthy in a guided state and research queues up.
3. **Ideas flow automatically**: watcher runs -> candidates sync into the sidebar -> research
   drains the queue (concurrency 1) -> READY reports -> you approve.
4. **Monthly refresh**: Settings -> "Rescan marketplace now" (rewrites coverage-cache.json).

## Variables (on the service)

| Variable | State | What it is |
|---|---|---|
| `DEEPSEEK_API_KEY` | set | DeepSeek key — billed to your account |
| `APP_ACCESS_PASSWORD` | set (`secret(24)` generated; rotate anytime) | UI gate password |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | set (same bot as idea-watch-worker) | push on research-ready / research-failed / approved |
| `RESEARCH_CONCURRENCY` | default 1 | parallel research slots |
| `FAST_INTERVAL_MIN` / `FULL_RUN_HOUR` / `VELOCITY_MIN_DELTA` | 60 / 6 UTC / 80 | watcher schedule |

## Layout

```
src/server.js         Fastify: /health (dotless, unauth), gate, ideas API, SSE, artifacts
src/db.js             better-sqlite3 WAL on /data/harness.db (ideas, digests, kv)
src/watch-runner.js   worker.js loop port: boot full-if-new-day -> hourly fast -> daily full;
                      single-flight guard; ledger -> ideas sync; digest index; research queue
src/researcher.js     DeepSeek SSE client (reasoning/tool-call/citation capture, cost, JSON repair)
src/approver.js       implementation-prompt generator + Telegram push
src/auth.js           sha256 password gate + first-login file/banner
public/               dsh-style dark 3-pane UI (vanilla JS, EventSource progress)
watcher/watch.js      idea-watch v2 VERBATIM (md5-verified against idea-watch/watch.js)
watcher/seen.json     baked ledger (seeds /data on first boot; live copy migrated from the worker)
watcher/coverage-cache.json  baked marketplace coverage (8,240 records)
watcher/rescan-full.js  monthly marketplace coverage refresh (GraphQL category loop)
```

## Cutover state (2026-11-22)

`/data/seen.json` on this service is byte-identical (sha256-verified) to the live
idea-watch-worker volume ledger (1,214 entries at migration). The worker
(project ed643c8d, service 327c2b1a) STAYS RUNNING until the user confirms retirement;
afterwards this service is the single source of truth.

## Local development

```
npm ci --ignore-scripts
PORT=3199 DATA_DIR=./.data node src/server.js
node watcher/watch.js --selftest            # 9 checks
node watcher/watch.js --fast --test-inject  # synthetic 900-star idea appears
```
