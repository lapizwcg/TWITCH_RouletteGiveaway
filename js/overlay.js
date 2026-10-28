import { Wheel } from './wheel.js';
import { createBus } from './bus.js';
import { resultText } from './giveaway.js';

// Параметры адреса: ?winners=0 — не показывать список победителей.
const params = new URLSearchParams(location.search);
const showWinners = params.get('winners') !== '0';

const $ = (id) => document.getElementById(id);
// В OBS у страницы есть window.obsstudio. Вне OBS показываем тёмный фон и подсказку, пока пульт молчит.
const preview = !window.obsstudio;
document.body.classList.toggle('preview', preview);
const setIdle = (idle) => {
  $('root').classList.toggle('hidden', idle);
  $('hint').hidden = !(preview && idle);
};
setIdle(true);
const wheel = new Wheel($('wheel'));
let spinning = false;
let pending = null; // состояние, пришедшее во время прокрута
let shownEntries = '';

const bus = createBus((msg) => {
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
