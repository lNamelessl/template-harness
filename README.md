# Template Idea Harness

One Railway service that productizes a template-building pipeline:

1. **Watcher** — the proven idea-watch v2 watcher (verbatim `watcher/watch.js`) runs on a schedule: a full marketplace+discovery sweep at boot (if none today) and daily at `FULL_RUN_HOUR` UTC, hourly fast checks in between. Discovery sources: GitHub search + trending, Hacker News (Show HN + front page), lobste.rs, Reddit, plus 10 app-store catalogs for coverage.
2. **Research agent** — every new high-potential idea goes to a DeepSeek research agent: one streaming Chat Completions call with `deepseek_web_search` + thinking enabled (deep search: multi-step server-side retrieval, URL reading). It writes a strict-JSON templating-potential report (verdict, rating, demand, coverage check vs the marketplace snapshot, competitor scan, ToS/legal flags, implementation sketch, suggested name/slug, risks) with full trajectory, citations, and per-idea cost captured.
3. **Review UI** — a dark, DeepSeek-Harness-desktop-style 3-pane workspace: left = idea list with status chips and demand badges, center = the report with a collapsible thinking/trajectory panel (live reasoning stream via SSE) and a composer-style action bar, right = workspace files (research.md, implementation prompt, dispatch log). Password-gated.
4. **Approve** — clicking **Approve build** generates the full playbook-aware implementation prompt (Steps 0-5, acceptance criteria, ease-of-use boilerplate), saves it as an artifact, and pushes a Telegram notification. Copy + download one click. Auto-build ships disabled as the v1.1 stub.

## Deploy

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/template-harness)

After deploying:

1. Open your Railway project -> the harness service -> **Variables** -> add `DEEPSEEK_API_KEY` with a key from [platform.deepseek.com -> API keys](https://platform.deepseek.com/api_keys). The service boots healthy WITHOUT the key (guided state); setting it auto-redeploys and unpauses research.
2. Reveal your UI password: `APP_ACCESS_PASSWORD` (generated per deploy) — open the service -> **Deployments -> View Logs** for the `HARNESS FIRST LOGIN` banner, or `railway ssh` + `cat /data/first-login.txt`. **Change it now** via the same variable.
3. Open the service domain, log in, and watch the watcher's boot sweep land ideas in the sidebar.
4. Click an idea -> **Re-research** (or wait for the automatic queue) -> watch thinking stream live.
5. **Approve build** -> grab `implementation-prompt.md` from workspace files (copy/download) -> build the template.

Optional variables: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (push on research-ready / research-failed / approved; same bot you use elsewhere), `RESEARCH_CONCURRENCY` (default 1), `FAST_INTERVAL_MIN` (60), `FULL_RUN_HOUR` (6 UTC), `VELOCITY_MIN_DELTA` (80), `RESEARCH_MAX_TOKENS` (12000).

## Variables

| Variable | Required | Default | What it is |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | yes (the ONE prompt) | - | Your DeepSeek API key — billed to YOUR account |
| `APP_ACCESS_PASSWORD` | no | `${{secret(24)}}` generated per deploy | UI gate password (find it in deploy logs / first-login.txt) |
| `TELEGRAM_BOT_TOKEN` | no | - | Existing Telegram bot token (optional push channel) |
| `TELEGRAM_CHAT_ID` | no | - | Chat id for the push channel |
| `RESEARCH_CONCURRENCY` | no | `1` | Parallel research slots (busy-lock returns a 429 envelope) |
| `FAST_INTERVAL_MIN` | no | `60` | Fast watcher cadence (minutes) |
| `FULL_RUN_HOUR` | no | `6` | Daily full sweep hour, UTC |
| `VELOCITY_MIN_DELTA` | no | `80` | Star delta that counts as a velocity spike |

## Architecture

- Node 22 (single runtime), Fastify, better-sqlite3 (WAL) on `/data/harness.db`
- `watcher/watch.js` runs VERBATIM as a spawned child process; the harness parses its stdout counters (`new high-potential: N`, `velocity spikes: N`, per-alert lines) and syncs ledger deltas (`/data/seen.json`, keyed by normalized name) into the ideas table
- Researcher: native-fetch SSE client (retries on 408/429/5xx + network errors, 200-with-body-error handled, strict JSON extraction with one repair call, call-id dedupe, citations merged annotations-first, cost from `usage` + `server_tool_use`)
- Ship state: the current seen-ledger (1,100+ entries) and coverage cache (8,200+ records) bake into the image and seed the volume on first boot
- Monthly marketplace refresh: Settings -> "Rescan marketplace now" (GraphQL category loop -> coverage-cache.json rewrite)

## Local development

```
npm ci --omit=dev --ignore-scripts
PORT=3199 DATA_DIR=./.data node src/server.js
node watcher/watch.js --selftest     # 9 checks
node watcher/watch.js --fast --test-inject   # synthetic 900-star idea appears
```
