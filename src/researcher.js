// src/researcher.js — DeepSeek research agent (ported from builds/deepseek-research +
// builds/deepseek-search Python patterns to Node native-fetch SSE).
// ONE streaming Chat Completions call per idea: tools=[deepseek_web_search] + thinking
// enabled = deep search (multi-step server-side retrieval: search -> open_page ->
// find_in_page). Captures reasoning deltas (trajectory), tool-call counts (call-id
// dedupe), citations (annotations[].url_citation + delta/final server_tool_calls[]
// .calls[].sources[], merged by URL, annotations win), usage + server_tool_use cost.
// Hygiene: retries on 408/429/5xx + network errors, 200-with-body-error handled,
// 400 risk mapped to a 422-shaped envelope, strict-JSON repair path, concurrency-1
// busy lock -> 429 envelope.
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('./config');
const { db, ideaStmts, now } = require('./db');
const { pushTelegram } = require('./telegram');

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const REASONING_CAP = 80000; // chars of trajectory reasoning persisted (head+tail)

// ---------- typed failures (each maps to ONE envelope shape in routes) ----------
class NotConfiguredError extends Error {
  constructor() {
    super('DEEPSEEK_API_KEY is not set on this deployment.');
    this.code = 'not_configured';
    this.http = 503;
    this.nextAction = 'Railway -> your service -> Variables -> add DEEPSEEK_API_KEY (a key from https://platform.deepseek.com/api_keys). Setting the variable auto-redeploys and unpauses research.';
  }
}
class BusyError extends Error {
  constructor(active) {
    super(`A research is already running (concurrency ${active}).`);
    this.code = 'busy';
    this.http = 429;
    this.nextAction = 'Wait for the current research to finish; the queue drains one idea at a time.';
  }
}
class RiskError extends Error {
  constructor(msg) {
    super(msg || 'The research request was rejected before generation (HTTP 400).');
    this.code = 'risk_rejected';
    this.http = 422;
    this.nextAction = 'The idea text may have tripped a provider-side filter. Re-research after editing the idea name, or dismiss it.';
  }
}
class UpstreamError extends Error {
  constructor(msg, retryable = false) {
    super(msg);
    this.code = 'upstream_error';
    this.http = 502;
    this.retryable = retryable;
    this.nextAction = 'Transient upstream failures retry automatically. If this persists, check https://status.deepseek.com and the deploy logs.';
  }
}

// ---------- progress events (SSE) ----------
const bus = new EventEmitter();
bus.setMaxListeners(50);
function emit(ideaId, type, data = {}) {
  bus.emit(`idea:${ideaId}`, JSON.stringify({ type, ...data, ts: now() }));
}

// ---------- coverage context (for coverage_check) ----------
function loadCoverageRecords() {
  const candidates = [
    path.join(config.dataDir, 'coverage-cache.json'),
    path.join(__dirname, '..', 'watcher', 'coverage-cache.json'),
  ];
  for (const f of candidates) {
    try {
      const recs = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(recs) && recs.length > 100) return recs;
    } catch (e) { /* next */ }
  }
  return [];
}
function similarCoverage(name, records, limit = 25) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const toks = norm(name).split(' ').filter((t) => t.length >= 3);
  if (!toks.length) return [];
  const scored = [];
  for (const r of records) {
    const t = norm(`${r.name} ${r.code || ''}`);
    let hits = 0;
    for (const tok of toks) if (t.includes(tok)) hits++;
    if (hits) scored.push({ name: r.name, deploys: r.deploymentCount ?? r.deploys ?? null, hits });
  }
  return scored.sort((a, b) => b.hits - a.hits || (b.deploys || 0) - (a.deploys || 0)).slice(0, limit);
}

// ---------- report prompt ----------
function buildReportPrompt(idea, coverageRecords) {
  const demand = idea.demand ? JSON.parse(idea.demand) : {};
  const sources = JSON.parse(idea.sources || '[]');
  const similar = similarCoverage(idea.name, coverageRecords);
  const facts = [
    `Idea/app name: ${idea.name}`,
    demand.stars ? `GitHub stars: ${demand.stars}` : null,
    demand.hnPoints ? `Hacker News points: ${demand.hnPoints}` : null,
    demand.starsToday ? `Trending: +${demand.starsToday} stars ${idea.sources && idea.sources.includes('github-trending-weekly') ? 'this week' : 'today'}` : null,
    idea.velocity_delta ? `Velocity spike: +${idea.velocity_delta} stars since last check` : null,
    demand.description ? `Description: ${demand.description}` : null,
    demand.url ? `Primary URL: ${demand.url}` : null,
    sources.length ? `Discovery sources: ${sources.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  return `You are a Railway-template research agent. Research the self-hostable open-source app/idea below using web search (this call runs DeepSeek server-side web search: search, open pages, read URLs) and produce a templating-potential report as ONE strict JSON object.

Subject facts:
${facts}

Context: we publish one-click Railway templates for self-hostable apps (reference marketplace: ~${coverageRecords.length} templates already published). A "high-potential" idea = popular (GitHub/HN demand) AND NOT already covered by an existing Railway template AND legally deployable.

Steps to perform with web search:
1. Verify what the app IS (repo, license, activity, what it does) and quantify demand.
2. Coverage check: scan the Railway template marketplace (railway.com/deploy) and the similar-names list below to judge whether it is already covered. Also note adjacent competitors there.
3. Competitor scan: find the 2-4 closest alternatives (hosted or self-hosted) and say why a template would or would not win.
4. ToS/legal flags: license issues, trademark limits, terms-of-service constraints for one-click hosting (e.g. Discord bots vs ToS, media servers, geo/DMCA risks).
5. Implementation sketch: Docker image quality, volume paths, ports, env vars, healthcheck endpoint, rough effort (S/M/L).

Similar marketplace names (may indicate existing coverage): ${similar.length ? JSON.stringify(similar) : '(none matched)'}

Output STRICTLY this JSON object and NOTHING ELSE. Wrap it in a single \`\`\`json fenced block. All 10 keys required; keep string values under 120 words each; rating is an integer 1-5 (5 = build now):

\`\`\`json
{
  "verdict": "BUILD NOW | BUILD SOON | WATCH | SKIP — one sentence why",
  "rating": 1,
  "demand": "measured demand summary with numbers",
  "coverage_check": "is it already on the Railway marketplace? which templates, how many deploys?",
  "competitor_scan": "closest alternatives and the win/lose case",
  "uniqueness": "what a fresh template adds; uniqueness rating in words",
  "tos_legal_flags": "license + ToS + legal flags or 'none found'",
  "implementation_sketch": "image, volumes, ports, env, healthcheck, effort S/M/L",
  "suggested_name_slug": "Template listing name (<= 45 chars) + slug (<= 40 chars, hyphenated)",
  "risks": "top risks of building/publishing this",
  "confidence": "HIGH|MEDIUM|LOW + one sentence"
}
\`\`\`

Remember: ONLY the fenced JSON block in your final answer. Use the web search tool extensively before answering.`;
}

// ---------- SSE streaming call ----------
async function streamChat({ prompt, key, ideaId, maxTokens }) {
  const payload = {
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'deepseek_web_search' }],
    thinking: { type: 'enabled' },
    stream: true,
    max_tokens: maxTokens,
  };

  const parts = [];
  const annotations = [];
  const stcRecords = [];
  const reasoningChunks = [];
  const queries = [];
  const seenCallIds = new Set();
  let usage = null;
  let finishReason = null;
  let refusalText = null;

  let lastStatus = null;
  let lastNetworkError = null;
  let lastBodyText = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt) {
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** (attempt - 1), 8000)));
    }
    let res;
    try {
      res = await fetch(`${config.deepseekBase}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(900000),
      });
    } catch (e) {
      lastNetworkError = `Upstream connection failed: ${e.name}`;
      if (attempt < MAX_RETRIES) { emit(ideaId, 'phase', { phase: 'retrying', note: lastNetworkError }); continue; }
      throw new UpstreamError(lastNetworkError, true);
    }
    lastStatus = res.status;
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      if (Number.isFinite(ra)) await new Promise((r) => setTimeout(r, Math.min(ra * 1000, 30000)));
      emit(ideaId, 'phase', { phase: 'retrying', note: `upstream HTTP ${res.status}` });
      continue;
    }
    if (res.status === 400) {
      const body = await res.text().catch(() => '');
      lastBodyText = body.slice(0, 300);
      throw new RiskError(`DeepSeek rejected the request (HTTP 400): ${lastBodyText}`);
    }
    if (res.status !== 200) {
      const body = await res.text().catch(() => '');
      throw new UpstreamError(upstreamErrorText(res.status, body), RETRYABLE_STATUS.has(res.status));
    }

    // ---- stream the 200 response ----
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = false;
    let sawBodyError = null;
    while (!done) {
      const { value, done: rdDone } = await reader.read();
      if (rdDone) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { done = true; break; }
        let chunk;
        try { chunk = JSON.parse(data); } catch (e) { continue; }
        if (chunk.error) {
          sawBodyError = JSON.stringify(chunk.error).slice(0, 300);
          done = true;
          break;
        }
        const choice = (chunk.choices || [{}])[0] || {};
        const delta = choice.delta || {};

        if (delta.content) {
          parts.push(delta.content);
          emit(ideaId, 'text', { chars: parts.join('').length });
        }
        if (delta.reasoning_content) {
          reasoningChunks.push(delta.reasoning_content);
          const tail = delta.reasoning_content.slice(-160);
          emit(ideaId, 'reasoning', { delta: tail, total_chars: reasoningChunks.join('').length });
        }
        if (delta.refusal) refusalText = delta.refusal;
        if (delta.annotations) {
          if (Array.isArray(delta.annotations)) annotations.push(...delta.annotations);
          else annotations.push(delta.annotations);
        }
        if (delta.server_tool_calls) {
          const stc = Array.isArray(delta.server_tool_calls) ? delta.server_tool_calls : [delta.server_tool_calls];
          stcRecords.push(...stc);
          let newCalls = 0;
          for (const block of stc) {
            for (const call of (block.calls || [])) {
              if (!call || typeof call !== 'object') continue;
              if (call.id) {
                if (seenCallIds.has(call.id)) continue;
                seenCallIds.add(call.id);
              }
              newCalls++;
              const inp = (call.input && typeof call.input === 'object') ? call.input : {};
              const q = inp.queries || call.queries;
              if (Array.isArray(q)) queries.push(...q.slice(0, 2).map(String));
            }
          }
          if (newCalls) {
            emit(ideaId, 'tools', { count: seenCallIds.size || undefined, queries: queries.slice(-2) });
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
    }
    if (sawBodyError) {
      // DeepSeek can report generation failures as HTTP 200 with an error object.
      throw new UpstreamError(`Upstream reported an error mid-stream: ${sawBodyError}`, false);
    }
    lastBodyText = null;
    break; // streamed successfully
  }
  if (lastStatus !== 200 && !parts.length && !reasoningChunks.length) {
    if (lastNetworkError && lastStatus === null) throw new UpstreamError(lastNetworkError, true);
    throw new UpstreamError(`Upstream HTTP ${lastStatus}${lastBodyText ? `: ${lastBodyText}` : ''}`, RETRYABLE_STATUS.has(lastStatus));
  }
  return { content: parts.join(''), reasoning: reasoningChunks.join(''), annotations, stcRecords, queries, usage, finishReason, refusalText, toolCalls: seenCallIds.size || stcRecords.reduce((n, b) => n + ((b.calls || []).length), 0) };
}

function upstreamErrorText(status, body) {
  let msg = '';
  try {
    const data = JSON.parse(body || '{}');
    const err = data && data.error;
    if (typeof err === 'string') msg = err;
    else if (err && typeof err === 'object') msg = err.message || '';
    else if (data && typeof data.message === 'string') msg = data.message;
  } catch (e) { /* raw */ }
  if (status === 401 && !msg) msg = 'Upstream rejected the configured DEEPSEEK_API_KEY — check the variable value.';
  return `Upstream error (HTTP ${status}): ${msg || (body || '').slice(0, 200)}`;
}

// ---------- citations (annotations win, merged by URL) ----------
function citationsFromAnnotations(annotations) {
  const out = [];
  const seen = new Set();
  for (const ann of annotations || []) {
    if (!ann || typeof ann !== 'object') continue;
    const uc = ann.url_citation || ann.web_search_result_location || null;
    if (!uc || typeof uc !== 'object') continue;
    const url = uc.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: uc.title || url, url });
  }
  return out;
}
function citationsFromToolCalls(records) {
  // Streaming shape: sources ride in delta.server_tool_calls[].calls[].sources[]
  // as {type:'url', url, title, snippet}.
  const out = [];
  const seen = new Set();
  for (const stc of records || []) {
    if (!stc || typeof stc !== 'object') continue;
    for (const call of (stc.calls || [])) {
      if (!call || typeof call !== 'object') continue;
      for (const src of (call.sources || [])) {
        if (!src || typeof src !== 'object' || src.type !== 'url') continue;
        const url = src.url;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const item = { title: src.title || url, url };
        if (src.snippet) item.cited_text = src.snippet;
        out.push(item);
      }
    }
  }
  return out;
}
function mergeCitations(primary, fallback) {
  const out = [...primary];
  const seen = new Set(primary.map((c) => c.url));
  for (const c of fallback || []) {
    if (c && c.url && !seen.has(c.url)) { out.push(c); seen.add(c.url); }
  }
  return out.filter((c) => typeof c.url === 'string' && /^https?:\/\//.test(c.url));
}
function usageOut(usage, toolCalls) {
  const u = usage || {};
  const stu = u.server_tool_use || {};
  const out = {
    input_tokens: u.prompt_tokens ?? null,
    output_tokens: u.completion_tokens ?? null,
    search_calls: stu.tool_search || 0,
    fetch_calls: stu.tool_fetch || 0,
    image_search_calls: stu.tool_image_search || 0,
    tool_calls: toolCalls || 0,
  };
  if (!(out.search_calls || out.fetch_calls || out.image_search_calls)) {
    out.search_calls = out.tool_calls; // best-effort fallback when counters absent
  }
  return out;
}
function estimateCost(usage) {
  const uses = (usage.search_calls || 0) + (usage.fetch_calls || 0) + (usage.image_search_calls || 0);
  return (uses / 1000.0) * config.priceSearchPer1k
    + ((usage.input_tokens || 0) / 1e6) * config.priceInPerM
    + ((usage.output_tokens || 0) / 1e6) * config.priceOutPerM;
}

// ---------- strict JSON extraction (fenced block + first { to last }) ----------
function extractJson(content) {
  if (!content) return null;
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch (e) { return null; }
}
function capReasoning(reasoning) {
  if (reasoning.length <= REASONING_CAP) return reasoning;
  const head = reasoning.slice(0, REASONING_CAP / 2);
  const tail = reasoning.slice(-REASONING_CAP / 2);
  return `${head}\n...[trajectory truncated, ${reasoning.length - REASONING_CAP} chars elided]...\n${tail}`;
}

async function repairJson(key, ideaName, rawText) {
  // One cheap no-tools repair call: "return ONLY the JSON".
  const payload = {
    model: config.model,
    messages: [{
      role: 'user',
      content: `The text below was supposed to be ONE strict JSON object for a template-research report on "${ideaName}" but had extra prose. Return ONLY the corrected JSON object — no prose, no fences, no explanation.\n\nText:\n${rawText.slice(0, 12000)}`,
    }],
    thinking: { type: 'disabled' },
    stream: false,
    max_tokens: 6000,
  };
  const res = await fetch(`${config.deepseekBase}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300000),
  });
  if (res.status !== 200) throw new UpstreamError(upstreamErrorText(res.status, await res.text().catch(() => '')));
  const data = await res.json();
  const msg = (data.choices || [{}])[0]?.message?.content || '';
  return extractJson(msg);
}

// ---------- artifacts ----------
function artifactDir(ideaId) { return path.join(config.dataDir, 'artifacts', String(ideaId)); }
function writeArtifact(ideaId, name, content) {
  const dir = artifactDir(ideaId);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return { name, path: `/api/ideas/${ideaId}/artifacts/${encodeURIComponent(name)}`, bytes: Buffer.byteLength(content), created_at: now() };
}

// ---------- main research pipeline ----------
let active = 0;
function activeCount() { return active; }

async function researchIdea(ideaId) {
  if (!config.deepseekKey) throw new NotConfiguredError();
  if (active >= config.researchConcurrency) throw new BusyError(active);
  active++;
  try {
    await runResearch(ideaId);
  } finally {
    active--;
  }
}

async function runResearch(ideaId) {
  const idea = ideaStmts.byId.get(ideaId);
  if (!idea) throw new Error('idea not found');
  ideaStmts.setStatus.run('RESEARCHING', null, ideaId);
  emit(ideaId, 'phase', { phase: 'thinking', status: 'RESEARCHING' });

  const key = config.deepseekKey;
  try {
    const coverageRecords = loadCoverageRecords();
    const prompt = buildReportPrompt(idea, coverageRecords);
    emit(ideaId, 'phase', { phase: 'searching', note: 'deep search streaming' });

    const r = await streamChat({ prompt, key, ideaId, maxTokens: config.maxTokens });

    if (r.finishReason === 'content_filter' || r.refusalText) {
      throw new RiskError(r.refusalText || 'The request was declined by the provider safety review.');
    }
    if (!r.content && r.finishReason === 'length') {
      throw new UpstreamError('The model spent its entire output budget on reasoning without producing report text — try again or lower RESEARCH_MAX_TOKENS.');
    }

    emit(ideaId, 'phase', { phase: 'parsing', note: 'extracting report JSON' });
    let report = extractJson(r.content);
    let repairUsed = false;
    if (!report && r.content) {
      try {
        report = await repairJson(key, idea.name, r.content);
        repairUsed = true;
      } catch (e) { /* repair failed -> graceful failure below */ }
    }
    if (!report || typeof report !== 'object') {
      // Graceful failure: keep the raw text as an artifact for manual review.
      const artifacts = [writeArtifact(ideaId, 'raw-output.txt', r.content || '(empty response)')];
      const err = 'Report JSON could not be parsed even after one repair call — raw model output kept as artifact raw-output.txt.';
      ideaStmts.saveFailure.run('RESEARCH_FAILED', err, r.content || null, now(), ideaId);
      ideaStmts.saveArtifacts.run(JSON.stringify(artifacts), ideaId);
      emit(ideaId, 'failed', { error: err });
      pushTelegram(`⚠️ research FAILED — ${idea.name}\n${err}`).catch(() => {});
      return;
    }

    const ratingRaw = parseInt(report.rating, 10);
    const rating = Number.isFinite(ratingRaw) ? Math.min(5, Math.max(1, ratingRaw)) : null;
    const citations = mergeCitations(citationsFromAnnotations(r.annotations), citationsFromToolCalls(r.stcRecords));
    const usage = usageOut(r.usage, r.toolCalls);
    const cost = estimateCost(usage);
    const trajectory = {
      reasoning: capReasoning(r.reasoning),
      tool_calls: r.toolCalls,
      queries: r.queries.slice(0, 20),
      finish_reason: r.finishReason,
      repair_used: repairUsed,
    };

    const artifacts = [writeArtifact(ideaId, 'research.md', reportToMarkdown(idea, report, citations, usage, cost))];
    ideaStmts.saveResearch.run(
      JSON.stringify(report), JSON.stringify(trajectory), JSON.stringify(citations),
      JSON.stringify(usage), cost, JSON.stringify(artifacts), now(), ideaId,
    );
    if (rating) db.prepare('UPDATE ideas SET rating = ? WHERE id = ?').run(rating, ideaId);
    emit(ideaId, 'done', { status: 'READY', cost_usd: cost, citations: citations.length, tool_calls: r.toolCalls });
    pushTelegram(`🔬 research READY — ${idea.name}\nverdict: ${report.verdict || '(none)'} | rating: ${'★'.repeat(rating || 0)} | cost: $${cost.toFixed(3)} | sources: ${citations.length}`).catch(() => {});
  } catch (err) {
    const typed = err instanceof NotConfiguredError || err instanceof BusyError || err instanceof RiskError || err instanceof UpstreamError;
    const errText = String(err.message || err).slice(0, 500);
    ideaStmts.saveFailure.run('RESEARCH_FAILED', errText, null, now(), ideaId);
    emit(ideaId, 'failed', { error: errText, code: typed ? err.code : 'internal_error' });
    pushTelegram(`⚠️ research FAILED — ${idea ? idea.name : ideaId}\n${errText.slice(0, 200)}`).catch(() => {});
    if (!typed) throw err;
  }
}

function reportToMarkdown(idea, report, citations, usage, cost) {
  const L = [];
  L.push(`# Research report — ${idea.name}`);
  L.push('');
  L.push(`*model ${config.model} · deep search · cost $${cost.toFixed(4)} · tool calls ${usage.tool_calls} · ${new Date().toISOString()}*`);
  L.push('');
  for (const [k, label] of [
    ['verdict', 'Verdict'], ['rating', 'Rating'], ['demand', 'Demand'],
    ['coverage_check', 'Coverage check'], ['competitor_scan', 'Competitor scan'],
    ['uniqueness', 'Uniqueness'], ['tos_legal_flags', 'ToS / legal flags'],
    ['implementation_sketch', 'Implementation sketch'], ['suggested_name_slug', 'Suggested name / slug'],
    ['risks', 'Risks'], ['confidence', 'Confidence'],
  ]) {
    if (report[k] === undefined) continue;
    L.push(`## ${label}`);
    if (k === 'rating') L.push(`${'★'.repeat(Number(report.rating) || 0)} (${report.rating}/5)`);
    else if (report[k] !== null && typeof report[k] === 'object') L.push('```json\n' + JSON.stringify(report[k], null, 2) + '\n```');
    else L.push(String(report[k]));
    L.push('');
  }
  if (citations.length) {
    L.push('## Sources');
    for (const c of citations) L.push(`- [${c.title}](${c.url})`);
  }
  return L.join('\n');
}

module.exports = {
  researchIdea, bus, activeCount, extractJson, estimateCost, loadCoverageRecords,
  NotConfiguredError, BusyError, RiskError, UpstreamError,
};
