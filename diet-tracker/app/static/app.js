'use strict';

// ============================================================
//  מצב: כל הנתונים מגיעים מ-/api/summary ונשמרים בזיכרון (S.data).
//  כל כתיבה מעדכנת קודם את S.data (applyOp) ואז נשלחת לשרת,
//  ובאופליין נכנסת לתור ב-localStorage ונשלחת כשהחיבור חוזר.
// ============================================================
const MONTHS = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];
const OUTBOX_KEY = 'dt_outbox';
const MORNING_KEY = 'dt_morning_asked';
const OTHER_SIZES = [
  { key: 'small', label: 'קטן', kcal: 150 },
  { key: 'medium', label: 'בינוני', kcal: 400 },
  { key: 'large', label: 'גדול', kcal: 800 },
];

const $ = (s) => document.querySelector(s);
const S = { data: null, day: todayISO(), lastToday: todayISO() };

// ---------- עזרי תאריך ומספרים ----------
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
function weekStart(iso) { // יום ראשון
  const d = new Date(iso + 'T12:00:00');
  return addDays(iso, -d.getDay());
}
function fmtDate(iso, withYear = false) {
  const [y, m, d] = iso.split('-');
  return withYear ? `${+d}.${+m}.${y.slice(2)}` : `${+d}.${+m}`;
}
function fmtTime(ts) {
  const d = new Date(ts);
  return isNaN(d) ? '' : d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}
const r1 = (x) => Math.round(x * 10) / 10;
const fmtInt = (x) => Math.round(x).toLocaleString('he-IL');
const fmtG = (g) => String(r1(g));
const signed = (x) => '‎' + (x > 0 ? '+' : '') + x.toFixed(1); // LRM: שהמינוס יופיע במקום הנכון ב-RTL
const parseNum = (v) => parseFloat(String(v).replace(',', '.').trim());
function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `i${Date.now()}${Math.random().toString(36).slice(2)}`;
}
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
}

// ---------- נתונים נגזרים ----------
const settings = () => S.data.settings;
const entriesOn = (date) => S.data.entries.filter((e) => e.date === date)
  .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
const sumOn = (date, kind) => S.data.entries.reduce((s, e) => (e.date === date && e.kind === kind ? s + e.amount : s), 0);
const proteinOn = (date) => sumOn(date, 'protein');
const sinsOn = (date) => sumOn(date, 'sin');
function sumRange(kind, from, to) {
  return S.data.entries.reduce((s, e) => (e.kind === kind && e.date >= from && e.date <= to ? s + e.amount : s), 0);
}
const isChecked = (date, id) => S.data.checks.some((c) => c.date === date && c.item_id === id);
const weightOn = (date) => S.data.weights.find((w) => w.date === date);
const waistOn = (date) => S.data.waist.find((w) => w.date === date);
const notesOn = (date) => (S.data.notes.find((n) => n.date === date) || {}).notes || '';
function avg(list) { return list.length ? list.reduce((s, x) => s + x, 0) / list.length : null; }
function targetFor(iso) {
  const p = S.data.plan;
  const total = daysBetween(p.start, p.end);
  const t = Math.min(Math.max(daysBetween(p.start, iso), 0), total);
  return p.start_kg + (p.end_kg - p.start_kg) * t / total;
}

// ---------- applyOp: עדכון מקומי לכל סוג כתיבה (משמש גם לתור האופליין) ----------
function upsert(list, key, val, item) {
  const i = list.findIndex((x) => x[key] === val);
  if (item == null) { if (i >= 0) list.splice(i, 1); }
  else if (i >= 0) list[i] = { ...list[i], ...item };
  else list.push(item);
}
const byDate = (a, b) => a.date.localeCompare(b.date);
const OPS = [
  [/^\/api\/weights\/([\d-]+)$/, (m, op) => {
    upsert(S.data.weights, 'date', m[1], op.method === 'PUT' ? { date: m[1], kg: r1(op.body.kg) } : null);
    S.data.weights.sort(byDate);
  }],
  [/^\/api\/waist\/([\d-]+)$/, (m, op) => {
    upsert(S.data.waist, 'date', m[1], op.method === 'PUT' ? { date: m[1], cm: r1(op.body.cm) } : null);
    S.data.waist.sort(byDate);
  }],
  [/^\/api\/entries\/(.+)$/, (m, op) => upsert(S.data.entries, 'id', m[1], op.method === 'PUT' ? { id: m[1], ...op.body } : null)],
  [/^\/api\/checks\/([\d-]+)\/(.+)$/, (m, op) => {
    S.data.checks = S.data.checks.filter((c) => !(c.date === m[1] && c.item_id === m[2]));
    if (op.body.done) S.data.checks.push({ date: m[1], item_id: m[2] });
  }],
  [/^\/api\/days\/([\d-]+)$/, (m, op) => upsert(S.data.notes, 'date', m[1], { date: m[1], notes: op.body.notes })],
  [/^\/api\/weeks\/(\d+)$/, (m, op) => { const w = S.data.weeks.find((x) => x.week === +m[1]); if (w) w.notes = op.body.notes; }],
  [/^\/api\/foods\/(.+)$/, (m, op) => upsert(S.data.foods, 'id', m[1], op.method === 'PUT' ? { id: m[1], ...op.body } : null)],
  [/^\/api\/sin-items\/(.+)$/, (m, op) => upsert(S.data.sin_items, 'id', m[1], op.method === 'PUT' ? { id: m[1], ...op.body } : null)],
  [/^\/api\/checklist-items\/(.+)$/, (m, op) => upsert(S.data.checklist_items, 'id', m[1], op.method === 'PUT' ? { id: m[1], ...op.body } : null)],
  [/^\/api\/settings$/, (m, op) => Object.assign(S.data.settings, op.body)],
];
function applyOp(op) {
  for (const [re, fn] of OPS) {
    const m = op.path.match(re);
    if (m) { fn(m.map(decodeURIComponent), op); return; }
  }
}

// ---------- רשת ----------
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

// כתיבה: עדכון מקומי מיד, ושליחה לשרת בשרשרת אחת לפי הסדר
let chain = Promise.resolve();
function write(method, path, body) {
  if (S.data) { applyOp({ method, path, body }); renderAll(); }
  chain = chain.then(() => send(method, path, body)).catch(() => {});
  return chain;
}
async function send(method, path, body) {
  if (loadOutbox().length) { enqueue(method, path, body); return flush(); }
  try {
    await api(method, path, body);
  } catch (e) {
    if (e instanceof TypeError) enqueue(method, path, body);
    else toast(e.message);
  }
  updateNet();
}
function enqueue(method, path, body) {
  const q = loadOutbox();
  q.push({ id: newId(), method, path, body });
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
        if (e instanceof TypeError) break;
        toast(e.message);
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
  const n = loadOutbox().length;
  const elNet = $('#net');
  if (!navigator.onLine) { elNet.textContent = 'אופליין'; elNet.hidden = false; }
  else if (n) { elNet.textContent = `ממתין לסנכרון (${n})`; elNet.hidden = false; }
  else elNet.hidden = true;
}

async function loadData() {
  try {
    S.data = await api('GET', '/api/summary');
  } catch {
    if (!S.data) { toast('אין נתונים שמורים לצפייה אופליין'); return; }
  }
  for (const op of loadOutbox()) applyOp(op); // כתיבות שעוד לא הגיעו לשרת
  $('#ai-box').hidden = !S.data.ai;
  $('#logout-card').hidden = S.data.auth === false;
  renderAll();
  renderSettings();
}

// ---------- הודעות וחלון אישור ----------
let toastTimer;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = el('div', { class: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/** חלון בתוך האפליקציה. מחזיר את value של הכפתור שנלחץ, או null. */
function modal({ title, body = [], actions }) {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(...body);
  $('#modal-actions').replaceChildren(...actions.map((a) =>
    el('button', { value: a.value, class: a.class || '', type: 'submit' }, a.label)));
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue && dlg.returnValue !== 'cancel' ? dlg.returnValue : null), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}
const confirmModal = (title, text, okLabel = 'אישור') => modal({
  title,
  body: text ? [el('p', {}, text)] : [],
  actions: [{ label: okLabel, value: 'ok', class: 'primary' }, { label: 'ביטול', value: 'cancel', class: 'subtle' }],
}).then((v) => v === 'ok');

// ---------- הזנות ----------
function addEntry(date, kind, name, amount, emoji = '') {
  const id = newId();
  write('PUT', '/api/entries/' + id, {
    date, kind, name, emoji, amount: r1(amount), created_at: new Date().toISOString(),
  });
  return id;
}
const delEntry = (id) => write('DELETE', '/api/entries/' + encodeURIComponent(id));

function addProtein(name, g) {
  if (!(g > 0)) return;
  addEntry(S.day, 'protein', name, g);
  toast(`+${fmtG(g)} ג׳ · ${name}`);
}
function addSin(date, item) {
  addEntry(date, 'sin', item.name, item.kcal, item.emoji);
  toast(`${item.emoji || '😈'} ${item.name} · ${fmtInt(item.kcal)} קל׳`);
}

async function otherSin(date) {
  let size = 'medium';
  const sizeBtns = OTHER_SIZES.map((s) => el('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(s.key === size),
    on: { click: () => { size = s.key; sizeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === size))); } },
  }, `${s.label} · ${s.kcal}`));
  sizeBtns.forEach((b, i) => { b.dataset.k = OTHER_SIZES[i].key; });
  const name = el('input', { type: 'text', maxlength: '60', placeholder: 'מה זה היה? (לא חובה)', autocomplete: 'off' });
  const v = await modal({
    title: 'חטא אחר',
    body: [el('div', { class: 'chips' }, ...sizeBtns), name],
    actions: [{ label: 'הוסף', value: 'ok', class: 'primary' }, { label: 'ביטול', value: 'cancel', class: 'subtle' }],
  });
  if (v !== 'ok') return;
  const s = OTHER_SIZES.find((x) => x.key === size);
  addSin(date, { emoji: '🍽️', name: name.value.trim() || `אחר (${s.label})`, kcal: s.kcal });
}

function sinButtons(date) {
  return [
    ...S.data.sin_items.map((it) => el('button', { type: 'button', on: { click: () => addSin(date, it) } },
      el('span', { class: 'emoji' }, it.emoji || '😈'), el('span', {}, it.name), el('small', {}, `${fmtInt(it.kcal)} קל׳`))),
    el('button', { type: 'button', class: 'other', on: { click: () => otherSin(date) } },
      el('span', { class: 'emoji' }, '➕'), el('span', {}, 'אחר'), el('small', {}, 'בוחרים גודל')),
  ];
}

function logItems(date, kinds) {
  const list = entriesOn(date).filter((e) => kinds.includes(e.kind));
  if (!list.length) return [el('li', { class: 'muted empty' }, 'עוד לא נרשם כלום')];
  return list.map((e) => el('li', {},
    el('span', { class: 'what' }, `${e.emoji ? e.emoji + ' ' : ''}${e.name}`),
    el('span', { class: 'amt' }, e.kind === 'protein' ? `${fmtG(e.amount)} ג׳` : `${fmtInt(e.amount)} קל׳`),
    el('span', { class: 'time muted' }, fmtTime(e.created_at)),
    el('button', { type: 'button', class: 'x', 'aria-label': `מחק ${e.name}`, on: { click: () => { delEntry(e.id); toast('נמחק'); } } }, '✕'),
  ));
}

// ---------- מסך "היום" ----------
function renderToday() {
  const d = S.day;
  $('#day').value = d;
  const st = settings();

  // שקילה
  const w = weightOn(d);
  if (document.activeElement !== $('#kg')) $('#kg').value = w ? w.kg.toFixed(1) : '';
  const t = targetFor(d);
  let info;
  if (w) {
    const diff = r1(w.kg - t);
    const parts = [w.kg.toFixed(1),
      diff > 0 ? `${diff.toFixed(1)} מעל היעד` : diff < 0 ? `${(-diff).toFixed(1)} מתחת ליעד 👏` : 'בדיוק ביעד'];
    const y = weightOn(addDays(d, -1));
    const prev = y || [...S.data.weights].reverse().find((x) => x.date < d);
    if (prev) parts.push(`${signed(r1(w.kg - prev.kg))} ${y ? 'מאתמול' : `מ-${fmtDate(prev.date)}`}`);
    info = parts.join(' · ');
  } else {
    info = `יעד ליום זה: ${t.toFixed(1)} ק״ג`;
  }
  $('#weight-info').textContent = info;

  const wa = waistOn(d);
  if (document.activeElement !== $('#waist')) $('#waist').value = wa ? wa.cm.toFixed(1) : '';
  const lastWaist = [...S.data.waist].reverse().find((x) => x.date < d);
  $('#waist-info').textContent = wa && lastWaist
    ? `${signed(r1(wa.cm - lastWaist.cm))} ס״מ מ-${fmtDate(lastWaist.date)}`
    : !wa && lastWaist ? `מדידה אחרונה: ${lastWaist.cm.toFixed(1)} ס״מ (${fmtDate(lastWaist.date)})` : '';

  // חלבון
  const target = st.protein_target;
  const g = proteinOn(d);
  const max = target * 1.15;
  $('#protein').textContent = fmtInt(g);
  $('#protein-status').textContent = g >= target ? '✓ ביעד' : `עוד ${fmtInt(target - g)} ג׳ ליעד`;
  $('#protein-status').classList.toggle('done', g >= target);
  $('#protein-bar').style.width = Math.min(100, (g / max) * 100) + '%';
  $('#protein-bar').classList.toggle('done', g >= target);
  $('#protein-mark').style.insetInlineStart = (target / max * 100) + '%';
  $('#foods').replaceChildren(...S.data.foods.map((f) => el('button', { type: 'button', on: { click: () => addProtein(f.name, f.protein_g) } },
    el('span', {}, f.name), el('small', {}, `+${fmtG(f.protein_g)} ג׳`))));

  // חטאים
  $('#sins').replaceChildren(...sinButtons(d));
  const ws = weekStart(d);
  const weekKcal = sumRange('sin', ws, addDays(ws, 6));
  const budget = st.sin_budget;
  $('#sin-week').textContent = `חטאים השבוע: ${fmtInt(weekKcal)} / ${fmtInt(budget)} קל׳`;
  const days = Math.round((weekKcal / st.deficit_daily) * 2) / 2;
  $('#sin-days').textContent = weekKcal ? `≈ ${days} ימי גירעון` : 'נקי השבוע 😇';
  $('#sin-bar').style.width = Math.min(100, budget ? (weekKcal / budget) * 100 : 100) + '%';
  $('#sin-bar').classList.toggle('over', weekKcal > budget);

  // רשימת ההזנות
  $('#log').replaceChildren(...logItems(d, ['protein', 'sin']));
  $('#undo').disabled = !entriesOn(d).length;

  // צ'ק-ליסט: החלבון אוטומטי
  const auto = el('div', { class: 'check auto', role: 'img', 'aria-label': `עמידה ביעד החלבון: ${g >= target ? 'כן' : 'לא'}`, 'data-done': String(g >= target) },
    el('span', {}, 'עמידה ביעד החלבון', el('small', { class: 'muted' }, ' · אוטומטי')));
  $('#checks').replaceChildren(auto, ...S.data.checklist_items.map((it) => el('button', {
    type: 'button', class: 'check', 'aria-pressed': String(isChecked(d, it.id)),
    on: { click: () => write('PUT', `/api/checks/${d}/${encodeURIComponent(it.id)}`, { done: !isChecked(d, it.id) }) },
  }, it.label)));
  if (document.activeElement !== $('#day-notes')) $('#day-notes').value = notesOn(d);

  renderMorning();
}

// ---------- תזכורת בוקר ----------
function morningAsked() { try { return localStorage.getItem(MORNING_KEY); } catch { return null; } }
function setMorningAsked(v) { try { localStorage.setItem(MORNING_KEY, v); } catch { /* */ } }
let morningOpenFor = null;
function maybeAskMorning() {
  const today = todayISO();
  if (S.day !== today || morningAsked() === today) return;
  setMorningAsked(today); // פעם אחת ביום
  morningOpenFor = today;
  renderMorning();
}
function renderMorning() {
  const box = $('#morning');
  const open = morningOpenFor && morningOpenFor === S.day;
  box.hidden = !open;
  if (!open) return;
  const y = addDays(S.day, -1);
  $('#morning-sins').replaceChildren(...sinButtons(y));
  const had = entriesOn(y).some((e) => e.kind === 'sin');
  $('#morning-log').replaceChildren(...(had ? logItems(y, ['sin']) : []));
  $('#morning-done').textContent = had ? 'סיום ✓' : 'לא, היה נקי ✨';
}

// ---------- גרף משקל ----------
function svgEl(tag, attrs, text) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
}
function axes(svg, { W, H, m, x0, x1, y0, y1, X, Y, step }) {
  for (let v = y0; v <= y1 + 1e-9; v += step) {
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: 'var(--line)' }));
    svg.append(svgEl('text', { x: m.l - 4, y: Y(v) + 3, 'text-anchor': 'end' }, r1(v)));
  }
  const d = new Date(x0 + 'T12:00:00');
  d.setDate(1);
  for (;;) {
    d.setMonth(d.getMonth() + 1);
    const iso = isoLocal(d);
    if (iso > x1) break;
    svg.append(svgEl('line', { x1: X(iso), x2: X(iso), y1: m.t, y2: H - m.b, stroke: 'var(--line)', 'stroke-dasharray': '2 3' }));
    svg.append(svgEl('text', { x: X(iso), y: H - m.b + 14, 'text-anchor': 'middle' }, MONTHS[d.getMonth()]));
  }
  const today = todayISO();
  if (today >= x0 && today <= x1) {
    svg.append(svgEl('line', { x1: X(today), x2: X(today), y1: m.t, y2: H - m.b, stroke: 'var(--muted)', opacity: 0.5 }));
  }
}
function movingAvg(list, key) { // ממוצע של המדידות ב-7 הימים שמסתיימים בכל מדידה
  return list.map((p) => {
    const from = addDays(p.date, -6);
    return { date: p.date, v: avg(list.filter((q) => q.date >= from && q.date <= p.date).map((q) => q[key])) };
  });
}
function renderChart() {
  const box = $('#chart');
  if (!S.data || !box.offsetParent) return;
  const p = S.data.plan;
  const ws = S.data.weights;
  const W = 360, H = 250, m = { l: 30, r: 10, t: 10, b: 26 };
  let x0 = p.start, x1 = p.end;
  if (ws.length) { if (ws[0].date < x0) x0 = ws[0].date; if (ws.at(-1).date > x1) x1 = ws.at(-1).date; }
  const span = Math.max(1, daysBetween(x0, x1));
  const kgs = ws.map((w) => w.kg).concat([p.start_kg, p.end_kg]);
  const y0 = Math.floor(Math.min(...kgs) - 0.5), y1 = Math.ceil(Math.max(...kgs) + 0.5);
  const X = (iso) => m.l + (W - m.l - m.r) * daysBetween(x0, iso) / span;
  const plotBottom = H - m.b - 10; // פס תחתון לסימוני חטאים
  const Y = (kg) => m.t + (plotBottom - m.t) * (y1 - kg) / (y1 - y0);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, direction: 'ltr', role: 'img', 'aria-label': 'גרף משקל מול התוכנית' });
  axes(svg, { W, H, m, x0, x1, y0, y1, X, Y, step: y1 - y0 > 12 ? 2 : 1 });

  svg.append(svgEl('line', { x1: X(p.start), y1: Y(p.start_kg), x2: X(p.end), y2: Y(p.end_kg),
    stroke: 'var(--target)', 'stroke-width': 2, 'stroke-dasharray': '6 4' }));
  for (const w of ws) svg.append(svgEl('circle', { cx: X(w.date), cy: Y(w.kg), r: 2.6, fill: 'var(--actual)', opacity: 0.55 }));
  const ma = movingAvg(ws, 'kg');
  if (ma.length > 1) {
    svg.append(svgEl('polyline', { points: ma.map((q) => `${X(q.date)},${Y(q.v)}`).join(' '),
      fill: 'none', stroke: 'var(--avg)', 'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  // ימים עם חטאים: נקודה בפס התחתון, גודל לפי כמות
  const sinDays = new Map();
  for (const e of S.data.entries) if (e.kind === 'sin') sinDays.set(e.date, (sinDays.get(e.date) || 0) + e.amount);
  for (const [date, kcal] of sinDays) {
    if (date < x0 || date > x1) continue;
    const c = svgEl('circle', { cx: X(date), cy: H - m.b - 4, r: 2 + Math.min(3, kcal / 400), fill: 'var(--sin)' });
    c.append(svgEl('title', {}, `${fmtDate(date)} · ${fmtInt(kcal)} קל׳`));
    svg.append(c);
  }
  box.replaceChildren(svg);
}

function renderWaistChart() {
  const box = $('#waist-chart');
  if (!S.data || !box.offsetParent) return;
  const list = S.data.waist;
  if (!list.length) { box.replaceChildren(el('p', { class: 'muted' }, 'עוד אין מדידות. מודדים פעם בשבוע במסך "היום".')); return; }
  const p = S.data.plan;
  const W = 360, H = 200, m = { l: 30, r: 10, t: 10, b: 26 };
  let x0 = p.start < list[0].date ? p.start : list[0].date;
  let x1 = p.end > list.at(-1).date ? p.end : list.at(-1).date;
  const span = Math.max(1, daysBetween(x0, x1));
  const cms = list.map((w) => w.cm);
  const y0 = Math.floor(Math.min(...cms) - 1), y1 = Math.ceil(Math.max(...cms) + 1);
  const X = (iso) => m.l + (W - m.l - m.r) * daysBetween(x0, iso) / span;
  const Y = (v) => m.t + (H - m.b - m.t) * (y1 - v) / (y1 - y0);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, direction: 'ltr', role: 'img', 'aria-label': 'גרף היקף מותניים' });
  axes(svg, { W, H, m, x0, x1, y0, y1, X, Y, step: y1 - y0 > 10 ? 2 : 1 });
  if (list.length > 1) {
    svg.append(svgEl('polyline', { points: list.map((w) => `${X(w.date)},${Y(w.cm)}`).join(' '),
      fill: 'none', stroke: 'var(--actual)', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
  }
  for (const w of list) svg.append(svgEl('circle', { cx: X(w.date), cy: Y(w.cm), r: 4, fill: 'var(--actual)' }));
  box.replaceChildren(svg);
}

// ---------- סיכום שבועי ----------
function weekStats(from) {
  const to = addDays(from, 6);
  const limit = todayISO() < to ? todayISO() : to;
  const days = [];
  for (let d = from; d <= limit; d = addDays(d, 1)) days.push(d);
  const target = settings().protein_target;
  return {
    weight: avg(S.data.weights.filter((w) => w.date >= from && w.date <= to).map((w) => w.kg)),
    protein: days.filter((d) => proteinOn(d) >= target).length,
    days: days.length,
    checks: Object.fromEntries(S.data.checklist_items.map((it) => [it.id, days.filter((d) => isChecked(d, it.id)).length])),
    sins: sumRange('sin', from, to),
  };
}
function renderWeekly() {
  if (!S.data) return;
  const cur = weekStart(todayISO());
  const a = weekStats(cur), b = weekStats(addDays(cur, -7));
  const kg = (s) => (s.weight == null ? '—' : s.weight.toFixed(1));
  const change = a.weight != null && b.weight != null ? ` (${signed(r1(a.weight - b.weight))})` : '';
  const rows = [
    ['ממוצע משקל', kg(a) + change, kg(b)],
    ['ימים ביעד החלבון', `${a.protein} / ${a.days}`, `${b.protein} / ${b.days}`],
    ...S.data.checklist_items.map((it) => [it.label, String(a.checks[it.id]), String(b.checks[it.id])]),
    ['חטאים (קל׳)', fmtInt(a.sins), fmtInt(b.sins)],
  ];
  $('#weekly tbody').replaceChildren(...rows.map((r) => el('tr', {}, el('th', {}, r[0]), el('td', { class: 'num' }, r[1]), el('td', { class: 'num muted' }, r[2]))));
  $('#weekly thead th:nth-child(2)').textContent = `השבוע (${fmtDate(cur)})`;
}

function renderStats() {
  if (!S.data) return;
  const p = S.data.plan;
  const last = S.data.weights.at(-1);
  const today = todayISO();
  const cells = [
    ['משקל אחרון', last ? `${last.kg.toFixed(1)} ק״ג` : '—'],
    ['יעד להיום', `${targetFor(today).toFixed(1)} ק״ג`],
    ['ירדת', last ? `${r1(p.start_kg - last.kg).toFixed(1)} ק״ג` : '—'],
    ['נשאר לסיום', last ? `${Math.max(0, r1(last.kg - p.end_kg)).toFixed(1)} ק״ג` : '—'],
    ['מול התוכנית', last ? signed(r1(last.kg - targetFor(last.date))) : '—'],
    ['ימים לסיום', String(Math.max(0, daysBetween(today, p.end)))],
  ];
  $('#stats').replaceChildren(...cells.map(([k, v]) => el('div', {}, el('span', { class: 'muted' }, k), el('strong', {}, v))));
}

// ---------- טבלה ----------
function renderTable() {
  if (!S.data || document.activeElement?.dataset?.week) return; // לא לדרוס הקלדה
  const today = todayISO();
  $('#weeks tbody').replaceChildren(...S.data.weeks.map((wk) => {
    const inRange = (x) => x.date >= wk.from && x.date <= wk.date;
    const a = avg(S.data.weights.filter(inRange).map((w) => w.kg));
    const waist = avg(S.data.waist.filter(inRange).map((w) => w.cm));
    const sins = sumRange('sin', wk.from, wk.date);
    const inp = el('input', { value: wk.notes || '', maxlength: '2000', 'aria-label': `הערות לשבוע ${wk.week}`,
      on: { change: (e) => write('PATCH', `/api/weeks/${wk.week}`, { notes: e.target.value }) } });
    inp.dataset.week = wk.week;
    return el('tr', { class: today >= wk.from && today <= wk.date ? 'current' : '' },
      el('td', { class: 'num' }, String(wk.week)),
      el('td', {}, fmtDate(wk.date, true)),
      el('td', { class: 'num' }, wk.target_kg.toFixed(1)),
      el('td', { class: a == null ? 'num' : `num ${a <= wk.target_kg + 0.05 ? 'good' : 'bad'}` }, a == null ? '—' : a.toFixed(1)),
      el('td', { class: 'num' }, waist == null ? '—' : waist.toFixed(1)),
      el('td', { class: 'num' }, sins ? fmtInt(sins) : '—'),
      el('td', {}, inp));
  }));

  const recent = S.data.weights.slice(-14).reverse();
  $('#recent').replaceChildren(...(recent.length ? recent.map((w) => el('li', {},
    el('span', {}, `${fmtDate(w.date, true)} · ${w.kg.toFixed(1)} ק״ג`),
    el('button', { type: 'button', class: 'subtle', on: { click: async () => {
      if (await confirmModal('מחיקת שקילה', `למחוק את השקילה מ-${fmtDate(w.date, true)}?`, 'מחק')) {
        write('DELETE', '/api/weights/' + w.date);
      }
    } } }, 'מחק'))) : [el('li', { class: 'muted' }, 'אין עדיין שקילות')]));
}

// ---------- הגדרות ----------
function editList(container, items, fields, path, makeNew) {
  const row = (it) => {
    const inputs = fields.map((f) => el('input', {
      type: 'text', value: String(it[f.key] ?? ''), placeholder: f.label, 'aria-label': f.label,
      inputmode: f.num ? 'decimal' : 'text', maxlength: f.max || '60', class: f.cls || '', autocomplete: 'off',
    }));
    const save = () => {
      const body = {};
      for (const [i, f] of fields.entries()) {
        const v = f.num ? parseNum(inputs[i].value) : inputs[i].value.trim();
        if (f.num ? !(v >= 0) : (!v && f.required)) { toast(`${f.label}: ערך לא תקין`); inputs[i].value = it[f.key] ?? ''; return; }
        body[f.key] = v;
      }
      write('PUT', `${path}/${encodeURIComponent(it.id)}`, body);
      Object.assign(it, body);
      toast('נשמר');
    };
    inputs.forEach((i) => i.addEventListener('change', save));
    const del = el('button', { type: 'button', class: 'x', 'aria-label': 'מחק', on: { click: async () => {
      const name = it[fields.find((f) => f.required).key];
      if (await confirmModal('מחיקה', `למחוק את "${name}"?`, 'מחק')) {
        write('DELETE', `${path}/${encodeURIComponent(it.id)}`);
        renderSettings();
      }
    } } }, '✕');
    return el('div', { class: 'edit-row' }, ...inputs, del);
  };
  const addInputs = fields.map((f) => el('input', {
    type: 'text', placeholder: f.label, 'aria-label': f.label, inputmode: f.num ? 'decimal' : 'text',
    maxlength: f.max || '60', class: f.cls || '', autocomplete: 'off',
  }));
  const addForm = el('form', { class: 'edit-row add', on: { submit: (e) => {
    e.preventDefault();
    const body = {};
    for (const [i, f] of fields.entries()) {
      const v = f.num ? parseNum(addInputs[i].value) : addInputs[i].value.trim();
      if (f.num ? !(v >= 0) : (!v && f.required)) { toast(`${f.label}: חסר או לא תקין`); return; }
      body[f.key] = v;
    }
    write('PUT', `${path}/${newId()}`, body);
    renderSettings();
    toast('נוסף');
  } } }, ...addInputs, el('button', { type: 'submit', class: 'primary' }, 'הוסף'));
  container.replaceChildren(...items.map(row), addForm);
}

function renderSettings() {
  if (!S.data) return;
  const st = settings();
  $('#set-protein').value = st.protein_target;
  $('#set-budget').value = st.sin_budget;
  $('#set-deficit').value = st.deficit_daily;
  editList($('#edit-foods'), S.data.foods,
    [{ key: 'name', label: 'שם', required: true }, { key: 'protein_g', label: 'ג׳', num: true, cls: 'narrow' }], '/api/foods');
  editList($('#edit-sins'), S.data.sin_items,
    [{ key: 'emoji', label: '🙂', cls: 'emoji-in', max: '8' }, { key: 'name', label: 'שם', required: true },
     { key: 'kcal', label: 'קל׳', num: true, cls: 'narrow' }], '/api/sin-items');
  editList($('#edit-checks'), S.data.checklist_items,
    [{ key: 'label', label: 'פריט', required: true }], '/api/checklist-items');
}

function renderAll() {
  if (!S.data) return;
  renderToday();
  renderWeekly();
  renderChart();
  renderWaistChart();
  renderStats();
  renderTable();
}

// ---------- Claude ----------
async function runEstimate() {
  const text = $('#ai-text').value.trim();
  if (text.length < 2) { $('#ai-text').focus(); return; }
  if (!navigator.onLine) { toast('צריך חיבור לאינטרנט כדי לחשב'); return; }
  const btn = $('#ai-go');
  const out = $('#ai-result');
  btn.disabled = true;
  btn.textContent = 'מחשב…';
  out.replaceChildren();
  try {
    renderEstimate(await api('POST', '/api/protein/estimate', { text }));
  } catch (e) {
    out.append(el('p', { class: 'error' }, e instanceof TypeError ? 'אין חיבור לשרת' : e.message));
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ חשב חלבון עם Claude';
  }
}
function renderEstimate(r) {
  const out = $('#ai-result');
  const nodes = r.items.map((it) => {
    const save = el('button', { type: 'button', title: 'שמור ככפתור מהיר', 'aria-label': `שמור "${it.name}" ככפתור מהיר`, on: { click: () => {
      if (save.classList.contains('saved')) return;
      write('PUT', '/api/foods/' + newId(), { name: `${it.name} ${it.amount}`.slice(0, 60), protein_g: it.protein_g });
      save.classList.add('saved'); save.textContent = '★';
      toast('נשמר ככפתור מהיר');
    } } }, '☆');
    return el('div', { class: 'ai-item' },
      el('div', { class: 'txt' }, el('span', {}, it.name), el('small', {}, it.amount)),
      el('strong', {}, `${fmtG(it.protein_g)} ג׳`),
      el('button', { type: 'button', 'aria-label': `הוסף ${it.name}`, on: { click: () => addProtein(`${it.name} (${it.amount})`.slice(0, 80), it.protein_g) } }, '+'),
      save);
  });
  if (r.note) nodes.push(el('p', { class: 'muted' }, r.note));
  if (r.items.length) {
    nodes.push(el('button', { type: 'button', class: 'primary big', on: { click: () => {
      for (const it of r.items) addEntry(S.day, 'protein', `${it.name} (${it.amount})`.slice(0, 80), it.protein_g);
      toast(`+${r.total_g} ג׳`);
      $('#ai-text').value = '';
      out.replaceChildren();
    } } }, `הוסף הכול · ${r.total_g} ג׳`));
  }
  out.replaceChildren(...nodes);
}

// ---------- אירועים ----------
function setDay(iso) {
  saveNotesNow();
  S.day = iso;
  renderAll();
}
let notesTimer;
function saveNotesNow() {
  clearTimeout(notesTimer);
  if (!S.data) return;
  const v = $('#day-notes').value;
  if (v !== notesOn(S.day)) write('PATCH', '/api/days/' + S.day, { notes: v });
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  });
  try { localStorage.setItem('dt_tab', name); } catch { /* */ }
  window.scrollTo(0, 0);
  if (name === 'chart') { renderChart(); renderWaistChart(); }
  if (name === 'settings') renderSettings();
}

const THEMES = ['auto', 'light', 'dark'];
const THEME_NAMES = { auto: 'לפי המערכת', light: 'בהיר', dark: 'כהה' };
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

function bind() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));

  $('#prev-day').addEventListener('click', () => setDay(addDays(S.day, -1)));
  $('#next-day').addEventListener('click', () => setDay(addDays(S.day, 1)));
  $('#day').addEventListener('change', (e) => { if (e.target.value) setDay(e.target.value); });

  $('#weight-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const kg = r1(parseNum($('#kg').value));
    if (!(kg >= 30 && kg <= 250)) { toast('משקל לא תקין'); return; }
    $('#kg').blur();
    write('PUT', '/api/weights/' + S.day, { kg });
    toast(`נשמר: ${kg.toFixed(1)} ק״ג`);
    maybeAskMorning();
  });
  $('#waist-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const cm = r1(parseNum($('#waist').value));
    if (!(cm >= 40 && cm <= 200)) { toast('היקף לא תקין'); return; }
    $('#waist').blur();
    write('PUT', '/api/waist/' + S.day, { cm });
    toast(`נשמר: ${cm.toFixed(1)} ס״מ`);
  });
  $('#morning-done').addEventListener('click', () => { morningOpenFor = null; renderMorning(); });

  $('#custom-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const g = parseNum($('#custom-g').value);
    if (!(g > 0 && g <= 300)) { toast('כמות לא תקינה'); return; }
    addProtein('ידני', g);
    $('#custom-g').value = '';
  });
  $('#reset').addEventListener('click', async () => {
    const list = entriesOn(S.day).filter((e) => e.kind === 'protein');
    if (!list.length) { toast('אין חלבון לאפס'); return; }
    const ok = await confirmModal('לאפס את החלבון של היום?',
      `${list.length} הזנות חלבון (${fmtInt(proteinOn(S.day))} ג׳) יימחקו. חטאים לא נמחקים.`, 'אפס');
    if (ok) { list.forEach((e) => delEntry(e.id)); toast('החלבון של היום אופס'); }
  });
  $('#undo').addEventListener('click', () => {
    const last = entriesOn(S.day).at(-1);
    if (last) { delEntry(last.id); toast(`בוטל: ${last.name}`); }
  });
  $('#ai-go').addEventListener('click', runEstimate);

  $('#day-notes').addEventListener('input', () => { clearTimeout(notesTimer); notesTimer = setTimeout(saveNotesNow, 1000); });
  $('#day-notes').addEventListener('change', saveNotesNow);

  $('#goals-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const body = { protein_target: parseNum($('#set-protein').value), sin_budget: parseNum($('#set-budget').value),
      deficit_daily: parseNum($('#set-deficit').value) };
    if (!(body.protein_target >= 10 && body.protein_target <= 400)) { toast('יעד חלבון: 10–400'); return; }
    if (!(body.sin_budget >= 0 && body.sin_budget <= 20000)) { toast('תקציב חטאים לא תקין'); return; }
    if (!(body.deficit_daily >= 50 && body.deficit_daily <= 3000)) { toast('גירעון יומי: 50–3000'); return; }
    write('PUT', '/api/settings', body);
    toast('היעדים נשמרו');
  });

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
    if (!(await confirmModal('להתנתק?', '', 'יציאה'))) return;
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* */ }
    if (window.caches) for (const k of await caches.keys()) if (k.startsWith('dt-data')) await caches.delete(k);
    location.replace('/login');
  });

  window.addEventListener('online', () => { updateNet(); flush().then(loadData); });
  window.addEventListener('offline', updateNet);
  window.addEventListener('resize', () => { renderChart(); renderWaistChart(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = todayISO();
    if (now !== S.lastToday) {
      if (S.day === S.lastToday) S.day = now; // יום חדש — המונים "מתאפסים" כי עוברים לתאריך חדש
      S.lastToday = now;
    }
    refresh();
  });
}

async function refresh() {
  if (loadOutbox().length && navigator.onLine) await flush();
  await loadData();
}

function init() {
  bind();
  let tab = 'today';
  try { tab = localStorage.getItem('dt_tab') || 'today'; } catch { /* */ }
  showTab(tab);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  updateNet();
  refresh();
  setInterval(() => { if (loadOutbox().length && navigator.onLine) flush(); }, 30000);
}

init();
