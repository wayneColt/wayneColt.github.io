/**
 * Murty grader — deterministic, no LLM, no Pyodide.
 * Same module is used by HUD, selftest, and (via copy) the Worker.
 *
 * House rules:
 *   1. Empty answers fail.
 *   2. Consumer register (please / act as / nice table) fails steering drills.
 *   3. Tool/object schemas without additionalProperties: false fail schema_closed.
 *   4. Streak only moves when pass === true. Reveal does not write the ledger.
 */

export const CONSUMER_PHRASES = [
  { token: 'please', re: /\bplease\b/i },
  { token: 'act as', re: /\bact as\b/i },
  { token: 'nice table', re: /\bnice table\b/i },
];

export const LEDGER_KEY = 'murty.ledger.v1';
export const DEFAULT_SECONDS = 80;
export const MIN_SECONDS = 60;
export const MAX_SECONDS = 100;
export const DEFAULT_HALF_LIFE = 1;

function isSteeringDrill(drill) {
  if (!drill) return false;
  const stage = String(drill.stage || '');
  if (/language-of-ai|language_of_ai|steer/i.test(stage)) return true;
  return (drill.assertions || []).some((a) => (a.op || a.type) === 'no_consumer_register');
}

export function consumerHits(text) {
  const s = String(text || '');
  const hits = [];
  for (const p of CONSUMER_PHRASES) {
    if (p.re.test(s)) hits.push(p.token);
  }
  return hits;
}

export function emptyAnswer(answer) {
  return answer == null || String(answer).trim() === '';
}

export function tokenCount(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

export function chicagoDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function addChicagoDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) throw new Error('addChicagoDays: expected YYYY-MM-DD');
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + Number(n));
  return dt.toISOString().slice(0, 10);
}

export function clampSeconds(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(x)));
}

export function defaultLedger() {
  return {
    v: 1,
    atoms: {},
    streak: { count: 0, lastDay: null },
    history: [],
  };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

export function getPath(obj, path) {
  if (path == null || path === '') return obj;
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function walk(obj, fn) {
  if (!obj || typeof obj !== 'object') return;
  fn(obj);
  if (Array.isArray(obj)) {
    for (const x of obj) walk(x, fn);
    return;
  }
  for (const v of Object.values(obj)) walk(v, fn);
}

export function checkSchemaClosed(obj) {
  const nodes = [];
  walk(obj, (n) => {
    if (Array.isArray(n)) return;
    if (n.type === 'object' || (n.properties && typeof n.properties === 'object')) {
      nodes.push(n);
    }
  });
  if (nodes.length === 0) {
    return { ok: false, kind: 'schema_closed', message: 'no object schema found' };
  }
  for (const n of nodes) {
    if (n.additionalProperties !== false) {
      return {
        ok: false,
        kind: 'schema_closed',
        message: 'schema missing additionalProperties: false',
      };
    }
  }
  return { ok: true };
}

function needle(hay, n, caseSensitive) {
  if (n == null) return false;
  if (caseSensitive) return String(hay).includes(String(n));
  return String(hay).toLowerCase().includes(String(n).toLowerCase());
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, message: e.message || 'invalid json' };
  }
}

export function runAssertion(assertion, text) {
  const op = assertion.op || assertion.type;
  const fail = (message, extra) => ({
    ok: false,
    kind: op || 'assert',
    message,
    ...extra,
  });
  switch (op) {
    case 'contains':
      return needle(text, assertion.value, assertion.case)
        ? { ok: true }
        : fail(`missing token: ${assertion.value}`);
    case 'not_contains':
      return needle(text, assertion.value, assertion.case)
        ? fail(`forbidden token: ${assertion.value}`)
        : { ok: true };
    case 'regex': {
      let re;
      try {
        re = new RegExp(assertion.value, assertion.flags == null ? 'i' : assertion.flags);
      } catch (e) {
        return fail(`bad regex: ${e.message}`);
      }
      return re.test(String(text)) ? { ok: true } : fail(`regex miss: /${assertion.value}/`);
    }
    case 'token_max': {
      const n = tokenCount(text);
      const max = Number(assertion.value);
      return n <= max ? { ok: true } : fail(`token_max ${max}, got ${n}`);
    }
    case 'line_min':
      return runAssertion({ op: 'line_count', min: assertion.value }, text);
    case 'line_count': {
      const lines = String(text).replace(/\n$/, '').split('\n');
      const n = emptyAnswer(text) ? 0 : lines.length;
      if (assertion.min != null && n < assertion.min) return fail(`line_count min ${assertion.min}, got ${n}`);
      if (assertion.max != null && n > assertion.max) return fail(`line_count max ${assertion.max}, got ${n}`);
      return { ok: true };
    }
    case 'json_valid': {
      const p = parseJson(text);
      return p.ok ? { ok: true } : fail(`json_valid: ${p.message}`);
    }
    case 'json_path': {
      const p = parseJson(text);
      if (!p.ok) return fail(`json_path: not json (${p.message})`);
      const got = getPath(p.value, assertion.path);
      if (Object.prototype.hasOwnProperty.call(assertion, 'equals')) {
        return deepEqual(got, assertion.equals)
          ? { ok: true }
          : fail(`path ${assertion.path} expected ${JSON.stringify(assertion.equals)} got ${JSON.stringify(got)}`);
      }
      if (Object.prototype.hasOwnProperty.call(assertion, 'includes')) {
        if (Array.isArray(got)) {
          return got.includes(assertion.includes)
            ? { ok: true }
            : fail(`path ${assertion.path} missing ${JSON.stringify(assertion.includes)}`);
        }
        if (typeof got === 'string') {
          return got.includes(String(assertion.includes))
            ? { ok: true }
            : fail(`path ${assertion.path} missing substring`);
        }
        return fail(`path ${assertion.path} not searchable`);
      }
      return got !== undefined ? { ok: true } : fail(`path ${assertion.path} missing`);
    }
    case 'schema_closed': {
      const p = parseJson(text);
      if (!p.ok) return fail(`schema_closed: not json (${p.message})`);
      return checkSchemaClosed(p.value);
    }
    case 'no_consumer_register': {
      const hits = consumerHits(text);
      return hits.length
        ? fail(`consumer register: ${hits.join(', ')}`, { hits })
        : { ok: true };
    }
    default:
      return fail(`unknown assertion op: ${op}`);
  }
}

export function diffAgainst(expected, actual) {
  const exp = expected == null ? '' : String(expected);
  const act = actual == null ? '' : String(actual);
  const eLines = exp.split('\n');
  const aLines = act.split('\n');
  const n = Math.max(eLines.length, aLines.length);
  const lines = [];
  for (let i = 0; i < n; i++) {
    const e = eLines[i];
    const a = aLines[i];
    if (e === a) lines.push({ kind: 'same', text: a ?? '' });
    else {
      if (e != null) lines.push({ kind: 'expected', text: e });
      if (a != null) lines.push({ kind: 'actual', text: a });
    }
  }
  const eTok = exp.split(/\s+/).filter(Boolean);
  const aSet = new Set(act.split(/\s+/).filter(Boolean));
  const aTok = act.split(/\s+/).filter(Boolean);
  const eSet = new Set(eTok);
  const missing = [];
  for (const t of eTok) {
    if (!aSet.has(t) && !missing.includes(t)) missing.push(t);
    if (missing.length >= 16) break;
  }
  const extra = [];
  for (const t of aTok) {
    if (!eSet.has(t) && !extra.includes(t)) extra.push(t);
    if (extra.length >= 16) break;
  }
  return { lines, missing, extra };
}

function incident(drill, failures, answer) {
  return {
    t: new Date().toISOString(),
    chicago_day: chicagoDay(),
    drill_id: drill && drill.id,
    atom: drill && drill.atom,
    failures,
    answer_tokens: tokenCount(answer),
  };
}

export function grade(drill, answer) {
  const text = answer == null ? '' : String(answer);
  const failures = [];

  if (emptyAnswer(text)) {
    const f = [{ kind: 'empty', message: 'empty answers fail' }];
    return {
      pass: false,
      failures: f,
      diff: diffAgainst(drill && drill.good && drill.good[0], text),
      incident: incident(drill, f, text),
    };
  }

  if (isSteeringDrill(drill)) {
    const hits = consumerHits(text);
    if (hits.length) {
      failures.push({
        kind: 'consumer_register',
        message: `consumer register: ${hits.join(', ')}`,
        hits,
      });
    }
  }

  for (const a of drill && drill.assertions ? drill.assertions : []) {
    const r = runAssertion(a, text);
    if (!r.ok) failures.push(r);
  }

  const pass = failures.length === 0;
  return {
    pass,
    failures,
    diff: pass ? null : diffAgainst(drill && drill.good && drill.good[0], text),
    incident: pass ? null : incident(drill, failures, text),
  };
}

export function dueQueue(drills, ledger, today = chicagoDay()) {
  const items = (drills || []).map((d) => {
    const atom = ledger && ledger.atoms ? ledger.atoms[d.atom] : null;
    const seen = !!(atom && atom.seen);
    const dueDay = atom && atom.dueDay ? atom.dueDay : today;
    const overdue = seen && dueDay < today;
    return { drill: d, seen, dueDay, overdue };
  });
  const overdue = items.filter((i) => i.overdue).sort((x, y) => x.dueDay.localeCompare(y.dueDay));
  const unseen = items.filter((i) => !i.seen);
  const soon = items.filter((i) => i.seen && !i.overdue).sort((x, y) => x.dueDay.localeCompare(y.dueDay));
  return [...overdue, ...unseen, ...soon].map((i) => i.drill);
}

export function dueCount(drills, ledger, today = chicagoDay()) {
  return dueQueue(drills, ledger, today).filter((d) => {
    const atom = ledger && ledger.atoms ? ledger.atoms[d.atom] : null;
    if (!atom || !atom.seen) return true;
    return atom.dueDay <= today;
  }).length;
}

/**
 * Ledger invariants are written ONLY after a green assertion.
 * Fail / reveal / skip do not mutate streak, atoms, or history.
 */
export function applyPass(ledger, drill, pass, today = chicagoDay()) {
  const src = ledger && typeof ledger === 'object' ? ledger : defaultLedger();
  const next = {
    v: 1,
    atoms: { ...(src.atoms || {}) },
    streak: { count: src.streak && src.streak.count ? src.streak.count : 0, lastDay: (src.streak && src.streak.lastDay) || null },
    history: Array.isArray(src.history) ? src.history.slice() : [],
  };
  if (pass !== true) return { ledger: next, streakMoved: false, wrote: false };

  const atomKey = (drill && drill.atom) || (drill && drill.id) || 'atom';
  const prev = next.atoms[atomKey] || { interval: drill && drill.half_life != null ? drill.half_life : DEFAULT_HALF_LIFE, seen: false };
  const base = prev.seen ? prev.interval * 2 : (drill && drill.half_life != null ? drill.half_life : DEFAULT_HALF_LIFE);
  const interval = Math.max(DEFAULT_HALF_LIFE, base);
  const dueDay = addChicagoDays(today, interval);
  next.atoms[atomKey] = {
    seen: true,
    lastPass: today,
    interval,
    dueDay,
  };

  let streakMoved = false;
  if (next.streak.lastDay === today) {
    streakMoved = false;
  } else if (next.streak.lastDay && next.streak.lastDay === addChicagoDays(today, -1)) {
    next.streak.count += 1;
    next.streak.lastDay = today;
    streakMoved = true;
  } else {
    next.streak.count = 1;
    next.streak.lastDay = today;
    streakMoved = true;
  }

  next.history.push({ drill_id: drill && drill.id, atom: atomKey, day: today, pass: true });
  return { ledger: next, streakMoved, wrote: true };
}

export function loadLedger(storage) {
  try {
    const raw = storage && storage.getItem && storage.getItem(LEDGER_KEY);
    if (!raw) return defaultLedger();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultLedger();
    return {
      v: 1,
      atoms: parsed.atoms && typeof parsed.atoms === 'object' ? parsed.atoms : {},
      streak: parsed.streak && typeof parsed.streak === 'object' ? parsed.streak : { count: 0, lastDay: null },
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return defaultLedger();
  }
}

export function saveLedger(storage, ledger) {
  if (!storage || !storage.setItem) return;
  storage.setItem(LEDGER_KEY, JSON.stringify(ledger));
}

export const MurtyGrader = {
  grade,
  chicagoDay,
  addChicagoDays,
  dueQueue,
  dueCount,
  applyPass,
  defaultLedger,
  loadLedger,
  saveLedger,
  checkSchemaClosed,
  consumerHits,
  emptyAnswer,
  tokenCount,
  clampSeconds,
  diffAgainst,
  runAssertion,
  LEDGER_KEY,
  DEFAULT_SECONDS,
  CONSUMER_PHRASES,
};

export default MurtyGrader;

if (typeof globalThis !== 'undefined') {
  globalThis.MurtyGrader = MurtyGrader;
}
