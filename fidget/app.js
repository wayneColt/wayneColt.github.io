import {
  grade,
  chicagoDay,
  dueQueue,
  dueCount,
  applyPass,
  defaultLedger,
  loadLedger,
  saveLedger,
  clampSeconds,
  DEFAULT_SECONDS,
} from './grader.js';

const BOOT = window.__MURTY_BOOTSTRAP__ || null;

const $ = (id) => document.getElementById(id);

const state = {
  drills: BOOT ? [BOOT] : [],
  loaded: false,
  current: BOOT || null,
  ledger: defaultLedger(),
  incidents: [],
  seconds: DEFAULT_SECONDS,
  remaining: DEFAULT_SECONDS,
  tick: null,
  revealed: false,
};

function paintTicker() {
  const t = $('ticker-track');
  if (!t) return;
  const unit =
    'ROUTING IS INTELLIGENCE  ·  LANGUAGE OF AI  ·  JOBSITE SPANISH  ·  CLOCK ON  ·  NO VIBES  ·  CONTRACTS NOT MANNERS  ·  ';
  t.textContent = unit + unit + unit;
}

function renderMeta() {
  const today = chicagoDay();
  $('streak').textContent = String((state.ledger.streak && state.ledger.streak.count) || 0);
  $('due').textContent = String(dueCount(state.drills, state.ledger, today));
  $('day').textContent = today;
  $('bank').textContent = String(state.drills.length);
}

function renderDrill() {
  const d = state.current;
  if (!d) {
    $('atom').textContent = '—';
    $('stage').textContent = '—';
    $('title').textContent = 'no drill';
    $('prompt').textContent = 'drills.json missing';
    return;
  }
  $('atom').textContent = d.atom || d.id;
  $('stage').textContent = d.stage || '';
  $('title').textContent = d.title || d.id;
  $('prompt').textContent = d.prompt || '';
  $('answer').value = '';
  $('reveal-box').classList.remove('show');
  $('reveal-box').textContent = '';
  $('verdict').textContent = 'idle';
  $('verdict').className = 'verdict';
  $('diff').textContent = '';
  state.revealed = false;
  const cap = clampSeconds(d.seconds || state.seconds);
  state.seconds = cap;
  $('seconds-range').value = String(cap);
  $('seconds-label').textContent = String(cap);
  restartClock(cap);
  renderMeta();
}

function restartClock(seconds) {
  state.remaining = seconds;
  paintClock();
  if (state.tick) clearInterval(state.tick);
  state.tick = setInterval(() => {
    state.remaining -= 1;
    if (state.remaining <= 0) {
      state.remaining = 0;
      paintClock();
      return;
    }
    paintClock();
  }, 1000);
}

function paintClock() {
  const el = $('time');
  const s = Math.max(0, state.remaining);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  el.textContent = `${mm}:${ss}`;
  el.classList.toggle('expire', s === 0);
}

function formatDiff(diff) {
  if (!diff) return '';
  const lines = (diff.lines || [])
    .map((l) => {
      if (l.kind === 'expected') return `+ ${l.text}`;
      if (l.kind === 'actual') return `- ${l.text}`;
      return `  ${l.text}`;
    })
    .join('\n');
  const miss = diff.missing && diff.missing.length ? `\nmissing: ${diff.missing.join(' ')}` : '';
  const extra = diff.extra && diff.extra.length ? `\nextra: ${diff.extra.join(' ')}` : '';
  return `${lines}${miss}${extra}`.trim();
}

function appendIncident(inc) {
  state.incidents.push(inc);
  const box = $('incidents');
  const item = document.createElement('div');
  item.className = 'item';
  const kinds = (inc.failures || []).map((f) => f.kind || f.message).join(', ');
  item.textContent = `${inc.t}  ${inc.drill_id}  ${kinds}`;
  box.prepend(item);
}

function run() {
  const d = state.current;
  if (!d) return;
  const answer = $('answer').value;
  const result = grade(d, answer);
  const verdict = $('verdict');
  if (result.pass) {
    verdict.textContent = 'PASS';
    verdict.className = 'verdict pass';
    $('diff').textContent = '';
    const applied = applyPass(state.ledger, d, true, chicagoDay());
    state.ledger = applied.ledger;
    saveLedger(window.localStorage, state.ledger);
    renderMeta();
  } else {
    verdict.textContent = `FAIL  ${(result.failures || []).map((f) => f.message || f.kind).join(' · ')}`;
    verdict.className = 'verdict fail';
    $('diff').innerHTML = '';
    const pre = document.createElement('div');
    pre.textContent = formatDiff(result.diff);
    const lines = (result.diff && result.diff.lines) || [];
    if (lines.length) {
      pre.textContent = '';
      for (const l of lines) {
        const div = document.createElement('div');
        div.className = l.kind;
        div.textContent = (l.kind === 'expected' ? '+ ' : l.kind === 'actual' ? '- ' : '  ') + (l.text || '');
        pre.appendChild(div);
      }
      if (result.diff.missing && result.diff.missing.length) {
        const m = document.createElement('div');
        m.className = 'expected';
        m.textContent = 'missing: ' + result.diff.missing.join(' ');
        pre.appendChild(m);
      }
    }
    $('diff').appendChild(pre);
    if (result.incident) appendIncident(result.incident);
  }
}

function reveal() {
  const d = state.current;
  if (!d) return;
  state.revealed = true;
  const box = $('reveal-box');
  const good = d.good && d.good[0] ? d.good[0] : '';
  box.textContent = `${d.reveal || ''}\n\n${good}`.trim();
  box.classList.add('show');
}

function nextDue() {
  const q = dueQueue(state.drills, state.ledger, chicagoDay());
  if (!q.length) return;
  const curId = state.current && state.current.id;
  const idx = q.findIndex((d) => d.id === curId);
  state.current = q[(idx + 1) % q.length];
  renderDrill();
}

async function loadBank() {
  try {
    const r = await fetch('drills.json', { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    const drills = Array.isArray(data) ? data : data.drills;
    if (Array.isArray(drills) && drills.length) {
      state.drills = drills;
      state.loaded = true;
      const q = dueQueue(state.drills, state.ledger, chicagoDay());
      const keep = state.current && drills.find((d) => d.id === state.current.id);
      state.current = keep || q[0] || drills[0];
      renderDrill();
    }
  } catch {
    /* HUD must not wait on a worker; bootstrap already painted */
  }
}

function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

function bind() {
  $('run').addEventListener('click', run);
  $('reveal').addEventListener('click', reveal);
  $('next').addEventListener('click', nextDue);
  $('seconds-range').addEventListener('input', (e) => {
    const cap = clampSeconds(e.target.value);
    state.seconds = cap;
    $('seconds-label').textContent = String(cap);
    restartClock(cap);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  });
}

function boot() {
  paintTicker();
  try {
    state.ledger = loadLedger(window.localStorage);
  } catch {
    state.ledger = defaultLedger();
  }
  bind();
  renderDrill();
  loadBank();
  registerSw();
}

boot();
