'use strict';

// ---------- קבועים ----------
const FOODS = [
  { name: 'עוף 180 ג׳', g: 55 },
  { name: 'טונה', g: 25 },
  { name: '2 ביצים', g: 13 },
  { name: 'קוטג׳ 100 ג׳', g: 11 },
  { name: 'מעדן חלבון', g: 20 },
  { name: 'סקייר 200 ג׳', g: 20 },
];
const CHECKS = [
  ['protein_ok', 'עמידה ביעד החלבון'],
  ['strength', 'אימון כוח'],
  ['cardio', 'אירובי'],
  ['fish', 'דגים'],
  ['vitamin_d', 'ויטמין D'],
];
const PROTEIN_MIN = 130;
const PROTEIN_MAX = 150;
const MONTHS = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];
const OUTBOX_KEY = 'dt_outbox';

const $ = (s) => document.querySelector(s);
const S = { summary: null, day: todayISO(), lastToday: todayISO(), dayData: null, undo: [] };

// ---------- תאריכים ----------
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayISO() { return isoLocal(new Date()); }
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return isoLocal(d);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
}
function fmtDate(iso, withYear = false) {
  const [y, m, d] = iso.split('-');
  return withYear ? `${+d}.${+m}.${y.slice(2)}` : `${+d}.${+m}`;
}
function targetFor(iso) {
  const p = S.summary.plan;
  const total = daysBetween(p.start, p.end);
  const t = Math.min(Math.max(daysBetween(p.start, iso), 0), total);
  return p.start_kg + (p.end_kg - p.start_kg) * t / total;
}
const r1 = (x) => Math.round(x * 10) / 10;

// ---------- הודעות ----------
let toastTimer;
function toast(msg) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

// ---------- רשת + תור כתיבות אופליין ----------
class ApiError extends Error {}

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.replace('/login'); throw new ApiError('נדרשת התחברות'); }
  if (r.status === 503 && r.headers.get('X-Offline')) throw new TypeError('offline');
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new ApiError(typeof j.detail === 'string' ? j.detail : 'שגיאה בשמירה');
  }
  return r.json();
}

function loadOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch { return []; }
}
function saveOutbox(q) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)); } catch { /* אחסון חסום */ }
}

// כל הכתיבות עוברות בשרשרת אחת, כדי שיגיעו לשרת בסדר שבו נעשו
let chain = Promise.resolve();
function write(method, path, body) {
  chain = chain.then(() => doWrite(method, path, body)).catch(() => {});
  return chain;
}
async function doWrite(method, path, body) {
  if (loadOutbox().length) {
    enqueue(method, path, body);
    return flush();
  }
  try {
    await api(method, path, body);
  } catch (e) {
    if (e instanceof TypeError) { enqueue(method, path, body); }
    else toast(e.message);
  }
  updateNet();
}
function enqueue(method, path, body) {
  const q = loadOutbox();
  q.push({ id: Date.now() + Math.random(), method, path, body });
  saveOutbox(q);
  updateNet();
}
let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  let sent = 0;
  try {
    for (;;) {
      const op = loadOutbox()[0];
      if (!op) break;
      try {
        await api(op.method, op.path, op.body);
      } catch (e) {
        if (e instanceof TypeError) break; // עדיין אופליין — ננסה אחר כך
        toast(e.message); // שגיאת ולידציה: אין טעם לנסות שוב
      }
      saveOutbox(loadOutbox().filter((o) => o.id !== op.id));
      sent++;
    }
  } finally {
    flushing = false;
    updateNet();
  }
  if (sent && !loadOutbox().length) toast('הנתונים סונכרנו');
}
function updateNet() {
  const el = $('#net');
  const n = loadOutbox().length;
  if (!navigator.onLine) { el.textContent = 'אופליין'; el.hidden = false; }
  else if (n) { el.textContent = `ממתין לסנכרון (${n})`; el.hidden = false; }
  else el.hidden = true;
}

// שכבת כתיבות שעדיין לא הגיעו לשרת מעל הנתונים שנטענו
function applyOutbox() {
  for (const op of loadOutbox()) {
    let m;
    if ((m = op.path.match(/^\/api\/weights\/([\d-]+)$/))) {
      const w = S.summary.weights.filter((x) => x.date !== m[1]);
      if (op.method === 'PUT') w.push({ date: m[1], kg: r1(op.body.kg) });
      w.sort((a, b) => a.date.localeCompare(b.date));
      S.summary.weights = w;
    } else if ((m = op.path.match(/^\/api\/days\/([\d-]+)$/))) {
      if (S.dayData && S.dayData.date === m[1]) Object.assign(S.dayData, op.body);
    } else if ((m = op.path.match(/^\/api\/weeks\/(\d+)$/))) {
      const wk = S.summary.weeks.find((w) => w.week === +m[1]);
      if (wk) wk.notes = op.body.notes;
    }
  }
}

// ---------- טעינה ----------
async function loadSummary() {
  try {
    S.summary = await api('GET', '/api/summary');
  } catch (e) {
    if (!S.summary) { toast('אין נתונים שמורים לצפייה אופליין'); return; }
  }
  $('#logout').hidden = S.summary.auth === false;
  applyOutbox();
  renderAll();
}

function blankDay(date) {
  return { date, protein_g: 0, protein_ok: false, strength: false, cardio: false, fish: false, vitamin_d: false, notes: '' };
}

async function loadDay() {
  const d = S.day;
  let data;
  try {
    data = await api('GET', '/api/days/' + d);
  } catch {
    data = (S.summary?.recent_days || []).find((x) => x.date === d) || blankDay(d);
  }
  if (d !== S.day) return; // המשתמש כבר עבר ליום אחר
  S.dayData = data;
  applyOutbox();
  renderDay();
}

// ---------- מסך "היום" ----------
function renderDay() {
  const d = S.dayData;
  if (!d) return;
  $('#day').value = S.day;

  if (S.summary) {
    const w = S.summary.weights.find((x) => x.date === S.day);
    if (document.activeElement !== $('#kg')) $('#kg').value = w ? w.kg.toFixed(1) : '';
    const t = targetFor(S.day);
    let info = `יעד ליום זה: ${t.toFixed(1)} ק״ג`;
    if (w) {
      const diff = r1(w.kg - t);
      info += diff > 0 ? ` · ${diff.toFixed(1)} מעל היעד` : diff < 0 ? ` · ${(-diff).toFixed(1)} מתחת ליעד 👏` : ' · בדיוק ביעד';
    }
    $('#weight-info').textContent = info;
  }

  const g = d.protein_g || 0;
  $('#protein').textContent = g;
  const bar = $('#protein-bar');
  bar.style.width = Math.min(100, (g / PROTEIN_MAX) * 100) + '%';
  bar.classList.toggle('done', g >= PROTEIN_MIN);
  $('#undo').disabled = !S.undo.some((u) => u.day === S.day);

  for (const [key] of CHECKS) {
    const btn = document.querySelector(`.check[data-key="${key}"]`);
    btn.setAttribute('aria-pressed', String(!!d[key]));
  }
  if (document.activeElement !== $('#day-notes')) $('#day-notes').value = d.notes || '';
}

function saveDay(patch) {
  Object.assign(S.dayData, patch);
  renderDay();
  write('PATCH', '/api/days/' + S.dayData.date, patch);
}

function addProtein(amount) {
  if (!S.dayData || !amount) return;
  const cur = S.dayData.protein_g || 0;
  const next = Math.max(0, Math.min(1000, cur + amount));
  S.undo.push({ day: S.day, prev: cur });
  const patch = { protein_g: next };
  if (cur < PROTEIN_MIN && next >= PROTEIN_MIN && !S.dayData.protein_ok) patch.protein_ok = true;
  saveDay(patch);
}

function buildTodayControls() {
  const foods = $('#foods');
  for (const f of FOODS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span></span><small>+${f.g} ג׳</small>`;
    b.firstChild.textContent = f.name;
    b.addEventListener('click', () => { addProtein(f.g); toast(`+${f.g} ג׳ · ${f.name}`); });
    foods.append(b);
  }
  const checks = $('#checks');
  for (const [key, label] of CHECKS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'check';
    b.dataset.key = key;
    b.textContent = label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { if (S.dayData) saveDay({ [key]: !S.dayData[key] }); });
    checks.append(b);
  }

  $('#custom-add').addEventListener('click', () => {
    const v = parseInt($('#custom-g').value, 10);
    if (Number.isFinite(v) && v !== 0) { addProtein(v); $('#custom-g').value = ''; }
  });
  $('#undo').addEventListener('click', () => {
    for (let i = S.undo.length - 1; i >= 0; i--) {
      if (S.undo[i].day === S.day) {
        const [u] = S.undo.splice(i, 1);
        saveDay({ protein_g: u.prev });
        return;
      }
    }
  });
  $('#reset').addEventListener('click', () => {
    if (S.dayData && confirm('לאפס את מונה החלבון של היום?')) {
      S.undo.push({ day: S.day, prev: S.dayData.protein_g });
      saveDay({ protein_g: 0 });
    }
  });

  let notesTimer;
  const saveNotes = () => {
    clearTimeout(notesTimer);
    if (S.dayData && $('#day-notes').value !== S.dayData.notes) saveDay({ notes: $('#day-notes').value });
  };
  $('#day-notes').addEventListener('input', () => { clearTimeout(notesTimer); notesTimer = setTimeout(saveNotes, 1000); });
  $('#day-notes').addEventListener('change', saveNotes);

  $('#weight-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const kg = r1(parseFloat(String($('#kg').value).replace(',', '.')));
    if (!(kg >= 30 && kg <= 250)) { toast('משקל לא תקין'); return; }
    setWeight(S.day, kg);
    $('#kg').blur();
    toast(`נשמר: ${kg.toFixed(1)} ק״ג`);
  });

  const go = (n) => setDay(addDays(S.day, n));
  $('#prev-day').addEventListener('click', () => go(-1));
  $('#next-day').addEventListener('click', () => go(1));
  $('#day').addEventListener('change', (e) => { if (e.target.value) setDay(e.target.value); });
}

function setDay(iso) {
  saveNotesNow();
  S.day = iso;
  S.dayData = null;
  $('#day').value = iso;
  loadDay();
}
function saveNotesNow() {
  if (S.dayData && $('#day-notes').value !== S.dayData.notes) saveDay({ notes: $('#day-notes').value });
}

function setWeight(date, kg) {
  const w = S.summary.weights.filter((x) => x.date !== date);
  if (kg != null) w.push({ date, kg });
  w.sort((a, b) => a.date.localeCompare(b.date));
  S.summary.weights = w;
  renderAll();
  if (kg != null) write('PUT', '/api/weights/' + date, { kg });
  else write('DELETE', '/api/weights/' + date);
}

// ---------- ממוצעים שבועיים (מחושבים בצד הלקוח, כך שעובד גם אופליין) ----------
function weekAverages() {
  const ws = S.summary.weights;
  return S.summary.weeks.map((wk) => {
    const inWeek = ws.filter((w) => w.date >= wk.from && w.date <= wk.date);
    const avg = inWeek.length ? inWeek.reduce((s, w) => s + w.kg, 0) / inWeek.length : null;
    return { ...wk, avg_kg: avg, count: inWeek.length };
  });
}

// ---------- גרף SVG ----------
function el(tag, attrs, text) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
}

function renderChart() {
  const box = $('#chart');
  if (!S.summary || !box.offsetParent) return; // מצויר רק כשהטאב גלוי
  const p = S.summary.plan;
  const ws = S.summary.weights;
  const weeks = weekAverages();
  const W = 360, H = 240, m = { l: 30, r: 10, t: 10, b: 26 };

  let x0 = p.start, x1 = p.end;
  if (ws.length) {
    if (ws[0].date < x0) x0 = ws[0].date;
    if (ws[ws.length - 1].date > x1) x1 = ws[ws.length - 1].date;
  }
  const span = Math.max(1, daysBetween(x0, x1));
  const kgs = ws.map((w) => w.kg).concat([p.start_kg, p.end_kg]);
  const y0 = Math.floor(Math.min(...kgs) - 0.5), y1 = Math.ceil(Math.max(...kgs) + 0.5);
  const X = (iso) => m.l + (W - m.l - m.r) * daysBetween(x0, iso) / span;
  const Y = (kg) => m.t + (H - m.t - m.b) * (y1 - kg) / (y1 - y0);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, direction: 'ltr', role: 'img', 'aria-label': 'גרף משקל מול יעד' });
  const step = y1 - y0 > 12 ? 2 : 1;
  for (let kg = y0; kg <= y1; kg += step) {
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: Y(kg), y2: Y(kg), stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(el('text', { x: m.l - 4, y: Y(kg) + 3, 'text-anchor': 'end' }, kg));
  }
  // תחילת כל חודש
  const d = new Date(x0 + 'T12:00:00');
  d.setDate(1);
  for (;;) {
    d.setMonth(d.getMonth() + 1);
    const iso = isoLocal(d);
    if (iso > x1) break;
    const x = X(iso);
    svg.append(el('line', { x1: x, x2: x, y1: m.t, y2: H - m.b, stroke: 'var(--line)', 'stroke-dasharray': '2 3' }));
    svg.append(el('text', { x, y: H - m.b + 14, 'text-anchor': 'middle' }, MONTHS[d.getMonth()]));
  }
  // היום
  const today = todayISO();
  if (today >= x0 && today <= x1) {
    svg.append(el('line', { x1: X(today), x2: X(today), y1: m.t, y2: H - m.b, stroke: 'var(--muted)', 'stroke-width': 1, opacity: 0.6 }));
  }
  // קו יעד
  svg.append(el('line', {
    x1: X(p.start), y1: Y(p.start_kg), x2: X(p.end), y2: Y(p.end_kg),
    stroke: 'var(--target)', 'stroke-width': 2, 'stroke-dasharray': '6 4',
  }));
  // שקילות בפועל
  if (ws.length) {
    svg.append(el('polyline', {
      points: ws.map((w) => `${X(w.date)},${Y(w.kg)}`).join(' '),
      fill: 'none', stroke: 'var(--actual)', 'stroke-width': 1.2, opacity: 0.6,
    }));
    for (const w of ws) svg.append(el('circle', { cx: X(w.date), cy: Y(w.kg), r: 2.5, fill: 'var(--actual)' }));
  }
  // ממוצע שבועי
  const avgs = weeks.filter((w) => w.avg_kg != null);
  if (avgs.length) {
    svg.append(el('polyline', {
      points: avgs.map((w) => `${X(w.date)},${Y(w.avg_kg)}`).join(' '),
      fill: 'none', stroke: 'var(--avg)', 'stroke-width': 2.5, 'stroke-linejoin': 'round',
    }));
    for (const w of avgs) svg.append(el('circle', { cx: X(w.date), cy: Y(w.avg_kg), r: 4, fill: 'var(--avg)' }));
  }
  box.replaceChildren(svg);
}

function renderStats() {
  const p = S.summary.plan;
  const ws = S.summary.weights;
  const last = ws[ws.length - 1];
  const today = todayISO();
  const t = targetFor(today);
  const left = Math.max(0, daysBetween(today, p.end));
  const cells = [
    ['משקל אחרון', last ? `${last.kg.toFixed(1)} ק״ג` : '—'],
    ['יעד להיום', `${t.toFixed(1)} ק״ג`],
    ['ירדת', last ? `${r1(p.start_kg - last.kg).toFixed(1)} ק״ג` : '—'],
    ['נשאר לסיום', last ? `${Math.max(0, r1(last.kg - p.end_kg)).toFixed(1)} ק״ג` : '—'],
    ['מול הקו', last ? '\u200e' + `${r1(last.kg - targetFor(last.date)) > 0 ? '+' : ''}${r1(last.kg - targetFor(last.date)).toFixed(1)}` : '—'],
    ['ימים לסיום', String(left)],
  ];
  $('#stats').replaceChildren(...cells.map(([k, v]) => {
    const div = document.createElement('div');
    const s = document.createElement('span'); s.className = 'muted'; s.textContent = k;
    const b = document.createElement('strong'); b.textContent = v;
    div.append(s, b);
    return div;
  }));
}

// ---------- טבלה ----------
function renderTable() {
  const today = todayISO();
  const tbody = $('#weeks tbody');
  const focused = document.activeElement?.dataset?.week;
  if (focused) return; // לא לדרוס הקלדה פעילה
  tbody.replaceChildren(...weekAverages().map((wk) => {
    const tr = document.createElement('tr');
    if (today >= wk.from && today <= wk.date) tr.className = 'current';
    const td = (text, cls) => { const c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; return c; };
    const avgCls = wk.avg_kg == null ? 'num' : `num ${wk.avg_kg <= wk.target_kg + 0.05 ? 'good' : 'bad'}`;
    const notes = document.createElement('td');
    const inp = document.createElement('input');
    inp.value = wk.notes || '';
    inp.maxLength = 2000;
    inp.dataset.week = wk.week;
    inp.setAttribute('aria-label', `הערות לשבוע ${wk.week}`);
    inp.addEventListener('change', () => {
      const w = S.summary.weeks.find((x) => x.week === wk.week);
      w.notes = inp.value;
      write('PATCH', `/api/weeks/${wk.week}`, { notes: inp.value });
    });
    notes.append(inp);
    tr.append(
      td(wk.week, 'num'),
      td(fmtDate(wk.date, true)),
      td(wk.target_kg.toFixed(1), 'num'),
      td(wk.avg_kg == null ? '—' : wk.avg_kg.toFixed(1), avgCls),
      notes,
    );
    return tr;
  }));

  const recent = S.summary.weights.slice(-14).reverse();
  $('#recent').replaceChildren(...(recent.length ? recent.map((w) => {
    const li = document.createElement('li');
    const s = document.createElement('span');
    s.textContent = `${fmtDate(w.date, true)} · ${w.kg.toFixed(1)} ק״ג`;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'danger'; b.textContent = 'מחק';
    b.addEventListener('click', () => { if (confirm(`למחוק את השקילה מ-${fmtDate(w.date, true)}?`)) setWeight(w.date, null); });
    li.append(s, b);
    return li;
  }) : [Object.assign(document.createElement('li'), { textContent: 'אין עדיין שקילות', className: 'muted' })]));
}

function renderAll() {
  if (!S.summary) return;
  renderDay();
  renderChart();
  renderStats();
  renderTable();
}

// ---------- טאבים, ערכת צבעים, יציאה ----------
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  });
  try { localStorage.setItem('dt_tab', name); } catch { /* */ }
  if (name === 'chart') renderChart();
}

const THEMES = ['auto', 'light', 'dark'];
const THEME_NAMES = { auto: 'לפי המערכת', light: 'בהיר', dark: 'כהה' };
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

function init() {
  buildTodayControls();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  let theme = 'auto';
  try { theme = localStorage.getItem('dt_theme') || 'auto'; } catch { /* */ }
  applyTheme(theme);
  $('#theme').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    applyTheme(theme);
    try { localStorage.setItem('dt_theme', theme); } catch { /* */ }
    toast('מצב תצוגה: ' + THEME_NAMES[theme]);
  });
  $('#logout').addEventListener('click', async () => {
    if (!confirm('להתנתק?')) return;
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* */ }
    if (window.caches) for (const k of await caches.keys()) if (k.startsWith('dt-data')) await caches.delete(k);
    location.replace('/login');
  });

  let tab = 'today';
  try { tab = localStorage.getItem('dt_tab') || 'today'; } catch { /* */ }
  showTab(tab);

  window.addEventListener('online', () => { updateNet(); flush().then(refresh); });
  window.addEventListener('offline', updateNet);
  window.addEventListener('resize', renderChart);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = todayISO();
    if (now !== S.lastToday) {
      if (S.day === S.lastToday) S.day = now; // יום חדש — המונה "מתאפס" כי עוברים לרשומה חדשה
      S.lastToday = now;
    }
    refresh();
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  updateNet();
  refresh();
  setInterval(() => { if (loadOutbox().length && navigator.onLine) flush(); }, 30000);
}

async function refresh() {
  if (loadOutbox().length && navigator.onLine) await flush();
  await loadSummary();
  await loadDay();
}

init();
