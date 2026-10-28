import { Wheel } from './wheel.js?v=5';
import { createBus } from './bus.js?v=5';
import { resultText } from './giveaway.js?v=5';

// Параметры адреса: ?winners=0 — не показывать список победителей.
const params = new URLSearchParams(location.search);
const showWinners = params.get('winners') !== '0';

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
};
renderHint();
const wheel = new Wheel($('wheel'));
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

  const kw = `<span class="kw">${escapeHtml(s.keyword)}</span>`;
  $('header').innerHTML =
    s.phase === 'registration'
      ? `Пишите ${kw} в чат<span class="count">${escapeHtml(s.rules)} Участников: ${s.count}</span>`
      : s.phase === 'finished'
        ? 'Розыгрыш завершён!'
        : '';

  const key = entriesKey(s.entries);
  if (key !== shownEntries) {
    shownEntries = key;
    wheel.setEntries(s.entries);
  }
  wheel.setHighlight(s.highlight);
  showResult(s.result);

  const list = s.winners || [];
  $('winnersBox').hidden = !showWinners || !list.length;
  $('winners').innerHTML = list
    .map((w) => `<li><span class="prize">${escapeHtml(w.prize)}</span><span class="name">${escapeHtml(w.name)}</span></li>`)
    .join('');
}

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

function showResult(r) {
  const el = $('result');
  if (!r) {
    el.className = 'result';
    return;
  }
  el.textContent = resultText(r);
  el.className = `result ${r.kind} show`;
}

function entriesKey(entries) {
  return entries.map((e) => `${e.mat}:${e.name}`).join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
