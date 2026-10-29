import { Wheel } from './wheel.js?v=14';
import { createBus } from './bus.js?v=14';
import { Crowd } from './crowd.js?v=14';
import { MATERIALS } from './materials.js?v=14';

const $ = (id) => document.getElementById(id);
// В OBS у страницы есть window.obsstudio; вне OBS фон тёмный, чтобы было что видно.
const preview = !window.obsstudio;
document.body.classList.toggle('preview', preview);
window.__overlayStarted = true; // встроенный скрипт в overlay.html проверяет, что модули вообще загрузились

// Карточка-подсказка видна, пока от пульта не пришло ни одного сигнала — и в OBS тоже,
// иначе пустую рамку не отличить от поломки. Когда пульт подключён, в OBS оверлей
// прозрачен до начала розыгрыша, а в обычном браузере остаётся подсказка.
let connected = false;
let idle = true;
const renderHint = () => {
  $('root').classList.toggle('hidden', idle);
  $('hint').hidden = connected && !(preview && idle);
  $('hintStatus').textContent = connected
    ? 'Пульт подключён. Колесо появится, когда вы начнёте регистрацию.'
    : 'Пульт не подключён: откройте его в этом же браузере (в OBS — как док-панель) с того же адреса.';
};
const setIdle = (value) => {
  idle = value;
  renderHint();
  // Пока розыгрыша нет, оверлей прозрачен — обе 3D-сцены спят и не нагружают видеокарту.
  wheel?.setActive(!idle);
  crowd?.setActive(!idle);
};
renderHint();
const wheel = new Wheel($('wheel'));
const crowd = new Crowd($('crowd'), $('crowdLabels'));
// До первого сигнала пульта розыгрыша нет — сцены сразу спят.
wheel.setActive(false);
crowd.setActive(false);
let roster = [];
let spinning = false;
let pending = null; // состояние, пришедшее во время прокрута
let shownEntries = '';

const bus = createBus((msg) => {
  if (!connected && (msg.type === 'spin' || msg.type === 'state')) {
    connected = true;
    renderHint();
  }
  if (msg.type === 'spin') onSpin(msg);
  else if (msg.type === 'state') {
    if (spinning) pending = msg;
    else applyState(msg);
  }
});
bus.send('hello');

function applyState(s) {
  setIdle(s.phase === 'idle');

  // Сверху — только призыв во время регистрации; в остальное время строка пустая, но место за ней сохранено.
  $('header').innerHTML =
    s.phase === 'registration'
      ? `Пишите <span class="kw">${escapeHtml(s.keyword)}</span> в чат <span class="count">· участников: ${s.count}</span>`
      : '';

  const key = entriesKey(s.entries);
  if (key !== shownEntries) {
    shownEntries = key;
    wheel.setEntries(s.entries);
  }
  wheel.setHighlight(s.highlight);
  showResult(s.result);

  roster = s.roster || [];
  crowd.setPeople(roster);
  renderRoster();
}

// Список справа: победители по местам, затем кто ещё в игре, затем выбывшие (последний выбывший выше).
// Строк ровно столько, сколько помещается; остальное — «и ещё N».
function renderRoster() {
  const wins = roster.filter((p) => p.status === 'win').sort((a, b) => a.place - b.place);
  const inGame = roster.filter((p) => p.status === 'in');
  const out = roster.filter((p) => p.status === 'out').sort((a, b) => b.order - a.order);
  const all = [...wins, ...inGame, ...out];
  $('rosterCount').textContent = roster.length ? `${inGame.length + wins.length} / ${roster.length}` : '';

  const list = $('roster');
  const u = Math.min(innerHeight / 100, innerWidth * 0.005625); // то же, что --u в CSS
  const probe = list.firstElementChild?.getBoundingClientRect().height || u * 3.4;
  const fit = Math.max(1, Math.floor(list.clientHeight / probe));
  const shown = all.length > fit ? all.slice(0, fit - 1) : all;
  list.innerHTML = shown
    .map((p) => {
      const color = MATERIALS[p.mat % MATERIALS.length].color;
      const place = p.status === 'win' ? `<span class="place">${p.place} место</span>` : '';
      return `<li class="${p.status}"><span class="chip" style="background:${color}"></span><span class="nm">${escapeHtml(p.name)}</span>${place}</li>`;
    })
    .join('');
  $('rosterMore').textContent = all.length > shown.length ? `и ещё ${all.length - shown.length}` : '';
}

new ResizeObserver(() => renderRoster()).observe($('roster'));

async function onSpin(msg) {
  setIdle(false);
  $('header').innerHTML = '';
  showResult(null);
  shownEntries = entriesKey(msg.entries);
  wheel.setEntries(msg.entries, { keepBall: true });
  spinning = true;
  await wheel.spin(msg.params);
  spinning = false;
  wheel.setHighlight({ index: msg.params.index, kind: msg.result.kind });
  showResult(msg.result);
  if (pending) {
    applyState(pending);
    pending = null;
  }
}

// Результат: главная строка крупно, места, выданные без прокрута, — второй строкой помельче.
function showResult(r) {
  const el = $('result');
  if (!r) {
    el.className = 'result';
    return;
  }
  $('resultMain').textContent = r.kind === 'win' ? `🏆 ${r.prize} — ${r.name}` : `Выбывает: ${r.name}`;
  $('resultSub').textContent = (r.also || []).map((a) => `${a.prize} — ${a.name}`).join('  ·  ');
  el.className = `result ${r.kind} show`;
}

function entriesKey(entries) {
  return entries.map((e) => `${e.mat}:${e.name}`).join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
