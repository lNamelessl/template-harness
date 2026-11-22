Watcher finds template ideas, DeepSeek researches each one, you approve builds.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/template-harness)

**Template Idea Harness** is one Node 22 service that runs your idea pipeline end to end: a battle-tested idea watcher sweeps GitHub search + trending, Hacker News, lobste.rs, Reddit and ten app-store catalogs hourly; every new high-potential idea (300+ stars, hot Show HN, velocity spikes) goes to a DeepSeek deep-search research agent that verifies demand, checks Railway marketplace coverage, scans competitors, flags ToS/legal issues, and writes a strict-JSON report with rating, sources and cost; then a dark desktop-style review UI (left idea list, center report with live thinking stream, right workspace files) lets you **approve the template build** — which generates the full playbook-aware implementation prompt and pushes it to Telegram.

## After deploying

1. Add your key: Railway -> your harness service -> **Variables** -> `DEEPSEEK_API_KEY` (paste a key from [platform.deepseek.com -> API keys](https://platform.deepseek.com/api_keys)). The deploy stays healthy without it; setting it auto-redeploys and unpauses research.
2. Get your UI password: it is the generated `APP_ACCESS_PASSWORD` variable. Open the service -> **Deployments -> View Logs** -> the `HARNESS FIRST LOGIN` banner prints it, or run `railway ssh` and `cat /data/first-login.txt`. **Change it now** by editing that variable.
3. Open the service domain and log in. The watcher's boot sweep is already running — new high-potential ideas appear in the left pane with demand badges.
4. Click an idea -> research streams live in the **Thinking and trajectory** panel (reasoning deltas, tool calls, citations) -> the report renders below with verdict, rating and cost.
5. Click **Approve build** -> the full implementation prompt lands in **workspace files** (`implementation-prompt.md`) with copy + download buttons, and Telegram gets notified (optional).

## What is inside

| Capability | Detail |
|---|---|
| Watcher (verbatim) | idea-watch v2 as a spawned child process: boot + daily full sweep (10 catalogs, discovery, velocity re-check), hourly fast checks; single-flight guard; heartbeat JSON; current ledger of 1,100+ known ideas and 8,200-record marketplace coverage cache ship baked and seed the volume on first boot |
| Research agent | ONE streaming DeepSeek call per idea: `deepseek_web_search` + thinking enabled (deep search, up to ~20 server-side tool calls: search, open page, find in page). Reasoning trajectory, tool-call dedupe, citations (annotations + tool sources merged), usage and per-idea cost all persisted. Retries on 408/429/5xx; 200-with-body-error handled; strict JSON with one repair call, else graceful failure keeping the raw output |
| Review UI | Dark 3-pane desktop-style workspace: status chips (NEW / RESEARCHING / READY / APPROVED / DISMISSED), demand badges (stars, HN points, velocity), composer-style filter; collapsible thinking panel with live SSE reasoning stream; composer action bar (Approve build / Dismiss / Re-research / Rename); workspace-files panel with copy + download; settings modal (schedule view-only, marketplace rescan button) |
| Approval | Generates the complete implementation prompt artifact (evidence context, key-requirements table, Steps 0-5 incl. publish pipeline + 2/2 fresh-deploy verification, acceptance criteria, ease-of-use boilerplate) -> saved to DB + volume -> Telegram push -> one-click copy/download. Auto-build ships DISABLED as the v1.1 stub |
| Ops | `/health` dotless, unauth, zero upstream calls; healthcheck-gated deploys; restart ON_FAILURE/10; keyless boot healthy (guided state + loud deploy-log banner); typed error envelopes (503 not-configured / 429 busy / 422 risk-rejected / 502 upstream); SQLite WAL on the volume; non-root container |

## Honest limits (measured)

| Limit | Value |
|---|---|
| Research cost per idea | about $0.02-0.25 measured on deep search (tool uses at $0.75/1k + tokens; cost shown per idea as a header chip). Off-peak windows (01:00-04:00, 06:00-10:00 UTC Mon-Fri) are half price |
| Research concurrency | 1 by default (`RESEARCH_CONCURRENCY`); extra requests get a typed 429 envelope and the queue drains in order |
| Research duration | 1-4 minutes per idea (multi-step retrieval); progress streams live |
| Watcher cadence | fast checks hourly (6.5 s spacing on unauthenticated GitHub search); full sweep ~5-10 min daily; Reddit is frequently 403-blocked from datacenter IPs (best-effort, non-fatal) |
| Telegram | optional — leave `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` empty and everything else works; pushes fire only on research-ready / research-failed / approved (anti-spam) |
| Auto-build | disabled v1.1 stub — approval generates the prompt; the in-harness builder (GitHub + Railway tokens + coding agent) is on the roadmap |
| Billing | DeepSeek usage is billed to YOUR DeepSeek account; Railway resources to your Railway plan. The SQLite DB + artifacts live on the /data volume (start ~1 MB, grows slowly) |

# Deploy and Host

## About Hosting

Hosting Template Idea Harness is one Railway service (Node 22 container, non-root, ~200 MB RAM idle) with a `/data` volume holding the SQLite database, the watcher ledger, digests, coverage cache and generated artifacts. Deploys are healthcheck-gated on a dotless `/health` route that performs zero upstream calls, so the service boots healthy even before you add the DeepSeek key: research stays paused in a guided state (loud deploy-log banner + in-app banner naming the exact next action) and unpauses automatically once `DEEPSEEK_API_KEY` lands. The watcher loop (boot full sweep, hourly fast checks, daily full sweep) runs inside the same process as a spawned child with a single-flight guard; state and heartbeat persist on the volume across restarts.

## Why Deploy

Manually this pipeline is three moving parts: a monitoring script on a box, a research workflow in a chat window, and a pile of notes for what to build next — plus copy-pasting reasoning and citations by hand. This template collapses all of it into one healthcheck-gated service where ideas accumulate automatically, each research is reproducible (full trajectory, citations and cost persisted next to the report), and every approved idea produces a complete implementation prompt artifact instead of a loose thread. The one-click deploy form has exactly one prompt (your DeepSeek key); the password, database, domains and schedule all provision or derive themselves.

## Common Use Cases

- Solo template authors / agencies maintaining a Railway template portfolio: keep a researched, ranked backlog of what to build next
- Indie hackers scanning for self-hostable apps with real demand (GitHub velocity, Show HN traction) before competitors cover them on the marketplace
- Ops teams tracking the self-hosting ecosystem: the same watcher doubles as a daily digest with Telegram pushes on velocity spikes
- Reviewing AI research with evidence: every report keeps its reasoning trajectory, tool-call counts and source citations for audit

## Dependencies for

### Deployment Dependencies

- **DEEPSEEK_API_KEY** (the only required variable): a DeepSeek API key from platform.deepseek.com -> API keys (https://platform.deepseek.com/api_keys). Create an account, add credit, create a key, paste it as the deploy prompt. Billed to your DeepSeek account. All retrieval is server-side via the `deepseek_web_search` tool — no SERP keys, no scraping infrastructure needed.
- **APP_ACCESS_PASSWORD**: generated per deploy (`${{secret(24)}}`); surfaced in the deploy-log banner and `/data/first-login.txt`. Change it immediately via the Variables tab.
- **TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID** (optional): your existing Telegram bot (create one via @BotFather and get the chat id) if you want push notifications.
- Everything else self-provisions: Node 22 base image, SQLite via better-sqlite3 (bundled prebuilds), the `/data` volume, the public domain, and the watcher schedule defaults.
