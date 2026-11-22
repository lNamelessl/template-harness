// public/app.js — harness UI logic (vanilla JS, SSE progress, no frameworks).
'use strict';
const $ = (id) => document.getElementById(id);
const state = { ideas: [], selected: null, filter: '', es: null, poll: null, reasoningLive: '' };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// render a text field: escape, then bold + inline links (http(s) only)
function rich(s) {
  let h = esc(s);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(https?:\/\/[^\s<)"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return h;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || res.statusText);
    err.envelope = body;
    err.status = res.status;
    throw err;
  }
  return body;
}

function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.display = 'none'; }, 5000);
}

// ---------- ideas list ----------
async function loadIdeas() {
  try {
    const q = new URLSearchParams();
    if (state.filter) q.set('filter', state.filter);
    const data = await api(`/api/ideas?${q}`);
    state.ideas = data.ideas;
    renderList();
  } catch (e) {
    if (e.status === 401) window.location.href = '/login';
  }
}

function renderList() {
  const list = $('idea-list');
  if (!state.ideas.length) {
    list.innerHTML = '<div class="list-empty">No ideas yet.<br>The watcher runs hourly;<br>new finds land here automatically.</div>';
    $('list-count').textContent = '';
    return;
  }
  list.innerHTML = state.ideas.map((i) => {
    const badges = [
      i.stars != null ? `<span class="badge star">&#9733; ${i.stars}</span>` : '',
      i.hn_points != null ? `<span class="badge hn">HN ${i.hn_points}</span>` : '',
      i.velocity_delta ? `<span class="badge vel">+${i.velocity_delta}&#9733;</span>` : '',
      i.cost_usd != null ? `<span class="badge">$${i.cost_usd.toFixed(3)}</span>` : '',
      (i.sources || []).slice(0, 2).map((s) => `<span class="badge">${esc(s)}</span>`).join(''),
    ].filter(Boolean).join('');
    return `<div class="idea-card ${state.selected === i.id ? 'sel' : ''}" data-id="${i.id}">
      <div class="nm"><span class="name" title="${esc(i.name)}">${esc(i.name)}</span>
      <span class="chip-status st-${esc(i.status)}">${esc(i.status)}</span></div>
      <div class="badges">${i.rating ? `<span class="badge star">${'&#9733;'.repeat(i.rating)}</span>` : ''}${badges}</div>
    </div>`;
  }).join('');
  $('list-count').textContent = `${state.ideas.length} idea${state.ideas.length === 1 ? '' : 's'} · polling every 8s`;
  list.querySelectorAll('.idea-card').forEach((el) => {
    el.onclick = () => selectIdea(Number(el.dataset.id));
  });
}

// ---------- idea detail ----------
async function selectIdea(id) {
  state.selected = id;
  renderList();
  stopSSE();
  let idea;
  try { idea = await api(`/api/ideas/${id}`); } catch (e) { toast(e.message, true); return; }
  $('empty-center').style.display = 'none';
  $('idea-view').style.display = 'flex';
  renderIdea(idea);
  if (idea.status === 'RESEARCHING' || (idea.status === 'NEW' && idea.queued_at)) connectSSE(id);
}

function renderIdea(idea) {
  $('idea-name').textContent = idea.name;
  const st = $('idea-status');
  st.textContent = idea.status;
  st.className = `chip-status st-${idea.status}`;

  const chips = [];
  chips.push(`<span class="hdr-chip model">deepseek-flash · deep search</span>`);
  if (idea.cost_usd != null) chips.push(`<span class="hdr-chip cost">cost $${idea.cost_usd.toFixed(3)}</span>`);
  if (idea.usage) chips.push(`<span class="hdr-chip">tool calls ${idea.usage.tool_calls ?? 0}</span>`);
  if (idea.citations && idea.citations.length) chips.push(`<span class="hdr-chip">sources ${idea.citations.length}</span>`);
  if (idea.stars != null) chips.push(`<span class="hdr-chip">&#9733; ${idea.stars}</span>`);
  if (idea.hn_points != null) chips.push(`<span class="hdr-chip">HN ${idea.hn_points}</span>`);
  if (idea.velocity_delta) chips.push(`<span class="hdr-chip vel">+${idea.velocity_delta}&#9733; velocity</span>`);
  if (idea.trajectory?.repair_used) chips.push(`<span class="hdr-chip">JSON repair used</span>`);
  if (idea.researched_at) chips.push(`<span class="hdr-chip">${esc(idea.researched_at.slice(0, 16).replace('T', ' '))}Z</span>`);
  $('idea-chips').innerHTML = chips.join('');

  // thinking / trajectory panel
  const traj = idea.trajectory;
  const reasoning = state.reasoningLive || (traj?.reasoning || '');
  const re = $('reasoning');
  re.textContent = reasoning || '(no trajectory yet — run research)';
  const toolCalls = (traj?.tool_calls ?? (idea.usage?.tool_calls ?? 0));
  const queries = traj?.queries || [];
  $('tool-list').innerHTML = [
    `<li>&#128269; deep search: <b>${toolCalls}</b> server tool calls${queries.length ? ` — last queries: ${esc(queries.slice(-3).join(' · '))}` : ''}</li>`,
    idea.usage ? `<li>&#9650;&#65039; usage: ${idea.usage.input_tokens ?? '?'} in / ${idea.usage.output_tokens ?? '?'} out tokens · search ${idea.usage.search_calls ?? 0} · fetch ${idea.usage.fetch_calls ?? 0}</li>` : '',
    traj?.finish_reason ? `<li>&#127919; finish_reason: ${esc(traj.finish_reason)}</li>` : '',
  ].filter(Boolean).join('');
  const cites = idea.citations || [];
  $('cite-cards').innerHTML = cites.length
    ? cites.slice(0, 40).map((c) => `<a class="cite-card" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer"><span class="t">${esc((c.title || '').slice(0, 110))}</span>${esc(c.url)}</a>`).join('')
    : '';
  $('thinking-meta').textContent = `${reasoning.length} chars reasoning · ${toolCalls} tool calls · ${cites.length} citations`;

  // error / raw text
  let html = '';
  if (idea.research_error) {
    html += `<div class="report-section"><h3>Research error</h3><div class="val" style="color:var(--red)">${rich(idea.research_error)}</div>
      <div class="val" style="color:var(--fg-dim);font-size:12px;margin-top:6px">Use <b>Re-research</b> to retry${idea.raw_report_text ? ' — raw model output kept under workspace files (raw-output.txt)' : ''}.</div></div>`;
  }
  const rep = idea.report;
  if (rep) {
    if (rep.verdict !== undefined) {
      html += `<div class="verdict-box"><span class="stars">${'&#9733;'.repeat(Number(rep.rating) || 0)}${'&#9734;'.repeat(Math.max(0, 5 - (Number(rep.rating) || 0)))}</span>
        <div class="v">${rich(rep.verdict)}</div></div>`;
    }
    const secs = [
      ['demand', 'Demand'], ['coverage_check', 'Coverage check (vs marketplace)'],
      ['competitor_scan', 'Competitor scan'], ['uniqueness', 'Uniqueness'],
      ['tos_legal_flags', 'ToS / legal flags'], ['implementation_sketch', 'Implementation sketch'],
      ['suggested_name_slug', 'Suggested name / slug'], ['risks', 'Risks'], ['confidence', 'Confidence'],
    ];
    for (const [k, label] of secs) {
      if (rep[k] === undefined || rep[k] === null || rep[k] === '') continue;
      html += `<div class="report-section"><h3>${label}</h3><div class="val">${rich(k === 'rating' ? `${rep.rating}/5` : rep[k])}</div></div>`;
    }
  } else if (!idea.research_error) {
    html += `<div class="empty-center" style="height:auto;padding:40px 0"><div class="big">&#128270;</div>
      <div>Status: <b>${esc(idea.status)}</b></div>
      <div style="max-width:400px;font-size:12px">${
        idea.status === 'NEW' ? 'Queued for research. With DEEPSEEK_API_KEY set the queue drains automatically (concurrency 1); otherwise the guided no-key state above tells you the exact next action.'
          : idea.status === 'DISMISSED' ? 'Dismissed. Use Re-research to bring it back into the pipeline.'
            : 'Waiting for research output…'}</div></div>`;
  }
  $('report').innerHTML = html;

  // right panel: artifacts + dispatch log
  const arts = idea.artifacts || [];
  $('artifacts').innerHTML = arts.length ? arts.map((a) => `<div class="art-file">
      <div class="fn"><span>${esc(a.name)}</span><span class="bytes">${a.bytes} B</span></div>
      <div class="art-actions">
        <button class="mini" data-copy="${esc(a.path)}">copy</button>
        <a class="mini" href="${esc(a.path)}" download>download</a>
      </div></div>`).join('')
    : '<div class="rt-note">Research and approve an idea to generate artifacts (research.md, implementation-prompt.md).</div>';
  $('artifacts').querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      try {
        const res = await fetch(b.dataset.copy);
        await navigator.clipboard.writeText(await res.text());
        toast('Artifact copied to clipboard');
      } catch (e) { toast(`Copy failed: ${e.message}`, true); }
    };
  });
  $('dispatch-log').textContent = idea.dispatch_log || '(nothing dispatched yet)';

  // action buttons state
  $('act-approve').disabled = idea.status === 'APPROVED';
  $('act-research').disabled = idea.status === 'RESEARCHING';
  $('act-dismiss').disabled = idea.status === 'DISMISSED' || idea.status === 'APPROVED';
}

// ---------- SSE progress ----------
function connectSSE(id) {
  stopSSE();
  state.reasoningLive = '';
  const es = new EventSource(`/api/ideas/${id}/events`);
  state.es = es;
  const phase = $('phase-line');
  phase.style.display = 'block';
  es.addEventListener('progress', (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.type === 'reasoning') {
      state.reasoningLive = `${state.reasoningLive}${d.delta || ''}`.slice(-9000);
      const re = $('reasoning');
      re.textContent = state.reasoningLive;
      re.scrollTop = re.scrollHeight;
      $('thinking-meta').textContent = `${state.reasoningLive.length}+ chars streaming · live`;
    } else if (d.type === 'tools') {
      const tl = $('tool-list');
      tl.innerHTML = `<li>&#128269; deep search running — <b>${d.count ?? '?'} tool calls</b>${d.queries?.length ? ` — ${esc(d.queries.join(' · '))}` : ''}</li>`;
    } else if (d.type === 'phase') {
      phase.textContent = `phase: ${d.phase}${d.note ? ` — ${d.note}` : ''}`;
    } else if (d.type === 'done' || d.type === 'failed') {
      es.close(); state.es = null;
      phase.style.display = 'none';
      loadIdeas();
      selectIdea(id);
      toast(d.type === 'done' ? `Research done — idea READY (cost $${(d.cost_usd || 0).toFixed(3)})` : `Research failed: ${(d.error || '').slice(0, 120)}`, d.type !== 'done');
    }
  });
  es.onerror = () => { /* stream closed by server or idea finished */ };
}

function stopSSE() {
  if (state.es) { state.es.close(); state.es = null; }
  state.reasoningLive = '';
  $('phase-line').style.display = 'none';
}

// ---------- actions ----------
$('act-approve').onclick = async () => {
  if (!state.selected) return;
  try {
    const r = await api(`/api/ideas/${state.selected}/approve`, { method: 'POST' });
    toast(r.already ? 'Already approved — prompt artifact in workspace files' : 'Approved — implementation prompt generated, Telegram pushed');
    loadIdeas(); selectIdea(state.selected);
  } catch (e) { toast(`Approve failed: ${e.message}`, true); }
};
$('act-dismiss').onclick = async () => {
  if (!state.selected) return;
  try {
    await api(`/api/ideas/${state.selected}/dismiss`, { method: 'POST' });
    toast('Idea dismissed');
    loadIdeas(); selectIdea(state.selected);
  } catch (e) { toast(`Dismiss failed: ${e.message}`, true); }
};
$('act-research').onclick = async () => {
  if (!state.selected) return;
  try {
    const r = await api(`/api/ideas/${state.selected}/research`, { method: 'POST' });
    if (r.queued) { toast('Research queued — streaming progress below'); loadIdeas(); selectIdea(state.selected); }
  } catch (e) {
    const env = e.envelope || {};
    toast(`${e.message}${env.next_action ? ` — ${env.next_action}` : ''}`, true);
  }
};
$('act-rename').onclick = async () => {
  if (!state.selected) return;
  const cur = state.ideas.find((i) => i.id === state.selected);
  const name = prompt('Rename idea', cur ? cur.name : '');
  if (!name || !name.trim()) return;
  try {
    await api(`/api/ideas/${state.selected}/rename`, { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    toast('Renamed'); loadIdeas(); selectIdea(state.selected);
  } catch (e) { toast(`Rename failed: ${e.message}`, true); }
};

// ---------- filter ----------
$('filter').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  loadIdeas();
});

// ---------- thinking collapse ----------
$('thinking-toggle').onclick = () => {
  const p = $('thinking-panel');
  p.classList.toggle('open');
  $('thinking-meta').textContent = p.classList.contains('open') ? 'expanded' : 'collapsed';
};

// ---------- settings modal ----------
$('btn-settings').onclick = async () => {
  try {
    const s = await api('/api/settings');
    const rows = [
      ['Model', s.model], ['Deep search', s.deep_search ? 'enabled (thinking + server-side web search)' : 'off'],
      ['Research concurrency', s.research_concurrency], ['Fast watch interval', `${s.fast_interval_min} min`],
      ['Full sweep', `${s.full_run_hour_utc}:00 UTC daily`], ['Velocity alert threshold', `+${s.velocity_min_delta} stars`],
      ['Max output tokens', s.max_output_tokens], ['DEEPSEEK_API_KEY', s.key_set ? 'set' : 'NOT SET (guided state)'],
      ['Telegram push', s.telegram ? 'configured' : 'not configured (optional)'],
      ['Cost estimate basis', s.price_note],
    ];
    $('settings-rows').innerHTML = rows.map(([k, v]) => `<div class="set-row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('')
      + `<div class="set-row"><span class="k">Auto-build (in-harness builder)</span><span class="v"><span class="autobuild-stub" style="margin:0"><span class="switch"></span><span class="tag">v1.1</span> disabled</span></span></div>`;
    $('modal-settings').classList.remove('hidden');
  } catch (e) { toast(e.message, true); }
};
$('settings-close').onclick = () => $('modal-settings').classList.add('hidden');
$('btn-rescan').onclick = async () => {
  try {
    const r = await api('/api/rescan', { method: 'POST' });
    toast(r.note || 'Rescan started');
  } catch (e) { toast(`Rescan failed: ${e.message}`, true); }
};

// ---------- header status + guided no-key banner ----------
async function bootMeta() {
  try {
    const me = await api('/api/me');
    $('hdr-key').textContent = me.key_set ? `key: set · ${me.model}` : 'DEEPSEEK_API_KEY: NOT SET';
    $('hdr-key').style.color = me.key_set ? 'var(--green)' : 'var(--amber)';
    const banner = $('gate-banner');
    if (!me.key_set) {
      banner.innerHTML = `<b>Guided setup:</b> DEEPSEEK_API_KEY is not set — research is paused. Exact next action: Railway → your service → <b>Variables</b> → add <b>DEEPSEEK_API_KEY</b> (get a key at <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">platform.deepseek.com → API keys</a>). Setting the variable auto-redeploys and unpauses research. The watcher runs without it — new ideas queue up.`;
      banner.style.display = 'block';
      $('empty-hint').textContent = 'No key yet — research is queued in the guided state above.';
    } else {
      banner.style.display = 'none';
      $('empty-hint').textContent = '';
    }
  } catch (e) { /* ignore */ }
  try {
    const w = await api('/api/worker');
    const lr = w.lastRun;
    $('hdr-watcher').textContent = lr
      ? `watcher: last ${lr.mode} ${lr.finished ? lr.finished.slice(11, 16) : ''}Z · high ${lr.high} · vel ${lr.velocity}`
      : 'watcher: booting';
  } catch (e) { /* ignore */ }
}

// ---------- poll loop ----------
loadIdeas();
bootMeta();
state.poll = setInterval(loadIdeas, 8000);
setInterval(bootMeta, 30000);
