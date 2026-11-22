Template Idea Harness — the idea-finding pipeline this marketplace factory runs on itself, productized. A single Railway service watches the marketplace hourly for high-potential template ideas, sends each new candidate to a DeepSeek research agent with live web search (server-side, deep thinking, URL reading), and serves a dark three-pane review UI, styled after DeepSeek Harness desktop, where you read the structured report and decide what gets built. Approving an idea generates a full playbook-aware implementation prompt, ready to copy, download, or receive on Telegram.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.app/new?github_url=https://github.com/lNamelessl/template-harness)

## After deploying

1. Grab the login password from the deploy logs (the HARNESS FIRST LOGIN banner) or from `first-login.txt` on the `/data` volume — it is the auto-generated `APP_ACCESS_PASSWORD`. Change it now via the `APP_ACCESS_PASSWORD` variable.
2. Add `DEEPSEEK_API_KEY` (from [platform.deepseek.com](https://platform.deepseek.com/api_keys) — API keys → Create) under Railway → your service → Variables if you did not supply it in the deploy form. Setting it auto-redeploys and unpauses research; the guided banner in the UI and deploy logs clears itself.
3. Open the public domain, log in, and watch the sidebar: the bundled ledger seeds ~1,100 known ideas, and the watcher runs a full marketplace sweep on boot, queueing new candidates for research.
4. Click Research on any NEW idea — you see the model's thinking stream live (the trajectory panel), then a structured report: verdict, star rating, demand evidence, coverage check against the marketplace, competitor scan, legal flags, and an implementation sketch.
5. Approve to generate the implementation prompt (right pane → artifacts: `research.md` + `implementation-prompt.md`), then copy or download it. Optional: add `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` to get research-ready and approval pushes on your phone.

## How it works

- **Watcher** — the proven idea-watch v2 engine runs inside the service: an hourly fast sweep plus a full marketplace run at boot and daily at 06:00 UTC (single-flight guarded, heartbeat JSON written to the volume). New high-potential and velocity-spike candidates enter the ideas table automatically.
- **Researcher** — one streaming DeepSeek Chat Completions call per idea with the `deepseek_web_search` tool at deep depth: reasoning deltas are captured as a trajectory, citations are merged from annotations and server-side tool sources, and cost is tallied from usage. Strict JSON report, defensive parse, one repair pass, typed error envelopes with retries on 408/429/5xx. Concurrency 1 — a busy idea returns a clean 429.
- **Review UI** — left pane: ideas with status chips (NEW / RESEARCHING / READY / APPROVED / DISMISSED) and demand badges; center: header chips (model, deep search, measured cost), collapsible thinking panel, rendered report; right: workspace artifacts. Password-gated, SSE progress, guided no-key state.
- **Approvals** — the generated implementation prompt carries the verdict, evidence context, a key-requirements table, numbered build steps including publish pipeline and fresh-deploy verification, and the ease-of-use acceptance block. Auto-build ships disabled (v1.1 stub) — nothing is dispatched without a human click.

# Deploy and Host

This template provisions one Railway service from a pinned Node 22 Alpine image, attaches a persistent volume at `/data` (SQLite database, watch ledger, coverage cache, artifacts, first-login file), and assigns a public HTTPS domain. Health is probed at the unauthenticated `health` endpoint; on failure the service restarts automatically. The deploy form asks for exactly one value — your `DEEPSEEK_API_KEY` — everything else is pre-configured: the UI password is auto-generated per deploy and surfaced in the logs, and every other knob has a sensible baked default.

## About Hosting

You are hosting a self-contained Node.js application: Fastify serves the UI, the API, and per-idea Server-Sent Events; better-sqlite3 (WAL mode) stores ideas, reports, trajectories, and artifacts at `/data/harness.db`; the bundled watcher runs as a supervised child process on its schedule. Expect roughly 200–400 MB RSS — the default Railway memory is comfortable, and no external database or cache is needed. The DeepSeek API is the only outbound dependency; the watcher adds read-only requests to the marketplace. Research pauses gracefully without an API key: the service stays healthy, the UI shows a guided banner, and adding the variable later auto-recovers without a rebuild. Do not mount anything over `/data` and keep `PORT` at its managed default — the app derives both from Railway.

## Why Deploy

Running the watcher, the research agent, and the review UI as three separate scripts on a laptop means three processes to babysit and no shared state. This template collapses them into one always-on service with a persistent volume: the watcher keeps scanning while you sleep, research results accumulate with their full reasoning trajectory and citations, and approval history survives redeploys. It is the exact pipeline behind dozens of published marketplace templates, including its own listing — the harness researches, you approve, and the generated prompt is ready to paste into your build environment.

## Common Use Cases

- Solo operators and small teams hunting Railway (or general SaaS) template ideas: get a researched, evidenced shortlist every morning instead of a raw firehose.
- Marketplace researchers auditing coverage: the bundled ledger ships ~1,100 known ideas and an 8,000-record coverage cache, so new reports arrive with an already-built competitive picture.
- Prompt-pipeline tinkerers: swap `DEEPSEEK_MODEL`, tune `VELOCITY_MIN_DELTA`, or read the trajectory JSON to see exactly how the agent formed its verdict.
- Automation enthusiasts wiring Telegram: research-ready, research-failed, and approval events push straight to your chat — quiet otherwise, no spam.

## Dependencies for

Outbound: the DeepSeek API (one streaming call per idea with web search — the only user credential) and read-only HTTPS to the marketplace site for watching. Inbound: one HTTPS public domain for the UI (auto-assigned). Storage: one persistent volume at `/data` (auto-attached, survives redeploys). No external databases, no message queues, no other services.

### Deployment Dependencies

| Variable | Required | Where to get it |
|---|---|---|
| `DEEPSEEK_API_KEY` | Yes — the deploy form asks for it | [platform.deepseek.com](https://platform.deepseek.com/api_keys) → API keys → Create new API key. Billing is pay-as-you-go; see cost limits below. |
| `APP_ACCESS_PASSWORD` | No — auto-generated `${{secret(24)}}` per deploy | Read it from the deploy-log HARNESS FIRST LOGIN banner or `/data/first-login.txt`, then change it via the variable. Leave empty to disable the gate (not recommended). |
| `TELEGRAM_BOT_TOKEN` | No | Telegram: message @BotFather → /newbot → copy the token. |
| `TELEGRAM_CHAT_ID` | No | Telegram: message your new bot once, then read the chat id from the getUpdates API (or use your numeric user id). |
| `RESEARCH_CONCURRENCY`, `FAST_INTERVAL_MIN`, `FULL_RUN_HOUR`, `VELOCITY_MIN_DELTA` | No | Baked defaults (1, 60, 6 UTC, 80). Set only if you want different pacing. |

## Measured limits and cost

| Limit | Value |
|---|---|
| Per-idea research cost | Typically $0.01–$0.08 with web search at peak-window list prices; off-peak DeepSeek windows are about half that. Cost is measured per idea and shown in the UI header chip. |
| Research concurrency | 1 by default — one idea researches at a time; extra requests get a typed 429 envelope, ideas stay queued. |
| Watcher schedule | Hourly fast sweep; full marketplace run at boot and daily at 06:00 UTC (about 8–15 min). |
| Coverage refresh | Monthly marketplace rescan rewrites the 8,000-record coverage cache; trigger manually via the rescan action. |
| Auto-build | Disabled in v1.1 by design — approval generates and distributes the prompt; nothing deploys autonomously. |
| Telegram | Optional and quiet: pushes fire only on research-ready, research-failed, and approved events. |
