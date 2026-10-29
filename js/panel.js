import * as tw from './twitch.js?v=20';
import { SCOPES } from './config.js?v=20';
import { Wheel } from './wheel.js?v=20';
import { createBus } from './bus.js?v=20';
import * as G from './giveaway.js?v=20';
import { MATERIALS } from './materials.js?v=20';
import { mark, DEBUG } from './perfhud.js?v=20';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'trg.settings';
const GIVEAWAY_KEY = 'trg.giveaway';

const FIELDS = [
  'keyword',
  'exactMatch',
  'minFollowDays',
  'excluded',
  'excludeBroadcaster',
  'prizeCount',
  'finalOrder',
  'allowRepeatWins',
  'spinSeconds',
  'eliminationSpinSeconds',
  'autoSpin',
  'autoDelaySeconds',
  'announce',
  'announceStart',
  'announceClose',
  'announceWin',
];
const PARTICIPATION_FIELDS = ['keyword', 'exactMatch', 'minFollowDays', 'excluded', 'excludeBroadcaster', 'eligibility'];
const GAME_FIELDS = ['prizeCount', 'finalOrder', 'allowRepeatWins', 'mode'];

const firstRun = !localStorage.getItem(SETTINGS_KEY);
const settings = G.normalizeSettings({ ...G.DEFAULT_SETTINGS, ...load(SETTINGS_KEY) });
const prizeName = G.prizeName;
let g = { ...G.newGiveaway(), ...load(GIVEAWAY_KEY) };
g.participants.forEach((p, i) => (p.mat ??= i % MATERIALS.length)); // записи, сохранённые до появления материалов
let byId = new Map(g.participants.map((p) => [p.id, p]));

let session = null;
let helix = null;
let chat = null;
let events = null; // события Twitch: новые фоллоу и сабы
const RECHECK_MS = 12000; // отклонённого перепроверяем по повторному слову не чаще раза в 12 с
let spinning = false;
let autoRunning = false;
let autoTimer = null;
// То, что сейчас нарисовано на колесе. После прокрута держим старый пул и подсветку до следующего прокрута.
let display = { entries: [], highlight: null, result: null, locked: false };

const wheel = new Wheel($('wheel'));
const bus = createBus((msg) => msg.type === 'hello' && broadcastState(true));

// ---------- Хранилище ----------

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}

const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
const saveGiveaway = () => localStorage.setItem(GIVEAWAY_KEY, JSON.stringify(g));

function setGiveaway(next) {
  g = next;
  byId = new Map(g.participants.map((p) => [p.id, p]));
  display = { entries: [], highlight: null, result: null, locked: false };
  wheel.setEntries([]); // снимаем подсветку и старый пул; render() нарисует актуальный
  saveGiveaway();
}

// ---------- Настройки ----------

function bindSettings() {
  for (const key of FIELDS) {
    const el = $(key);
    if (el.type === 'checkbox') el.checked = settings[key];
    else el.value = settings[key];
    const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      if (el.type === 'number' && el.value === '') return;
      settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
      G.normalizeSettings(settings);
      saveSettings();
      render();
    });
    // Когда поле теряет фокус, показываем исправленное значение (например, 0 призов → 1).
    if (el.type === 'number') el.addEventListener('change', () => (el.value = settings[key]));
  }

  for (const seg of document.querySelectorAll('.segmented')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[seg.dataset.name] = b.dataset.value;
      saveSettings();
      render();
    });
  }
}

/** Подтверждение в своём окне. Возвращает Promise<boolean>. */
function ask(text, yesLabel = 'Да') {
  const dlg = $('confirmDialog');
  $('confirmText').textContent = text;
  $('confirmYes').textContent = yesLabel;
  dlg.showModal();
  return new Promise((resolve) => {
    const done = (answer) => {
      $('confirmYes').onclick = $('confirmNo').onclick = dlg.oncancel = null;
      dlg.close();
      resolve(answer);
    };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
    dlg.oncancel = (e) => {
      e.preventDefault();
      done(false);
    };
  });
}

function openSettings(tab) {
  if (tab) selectTab(tab);
  $('settingsDialog').showModal();
}

function closeSettings() {
  $('settingsDialog').close();
}

function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== name;
}

// ---------- Вход в Twitch и чат ----------

async function initSession() {
  const err = tw.consumeRedirect();
  if (err) showNotice(`Вход не удался: ${escapeHtml(err)}`, true);

  if (!tw.isConfigured()) {
    showNotice(
      `Чтобы подключить Twitch, создайте приложение на <a href="https://dev.twitch.tv/console/apps" target="_blank" rel="noopener">dev.twitch.tv/console/apps</a>,
       укажите OAuth Redirect URL <code>${tw.redirectUri()}</code> и вставьте его Client ID в <code>js/config.js</code>.
       Пока можно потренироваться на тестовых участниках.`,
    );
    renderAccount();
    return;
  }

  session = await tw.restoreSession().catch(() => null);
  if (session) {
    helix = new tw.Helix(session);
    const missing = SCOPES.filter((s) => !session.scopes.includes(s));
    if (missing.length) showNotice('Приложению не хватает разрешений. Выйдите и войдите снова.', true);
    chat = new tw.ChatReader(session.login, onChatMessage, renderChatStatus);
    events = new tw.EventSub(helix, onTwitchEvent);
    requeueChecks();
  }
  renderAccount();
}

async function renderAccount() {
  const box = $('account');
  if (!session) {
    box.innerHTML = '<button class="btn primary" id="login">Войти через Twitch</button>';
    $('login').disabled = !tw.isConfigured();
    $('login').addEventListener('click', tw.login);
    return;
  }
  box.innerHTML = `<span id="me"></span><button class="btn ghost small" id="logout">Выйти</button>`;
  $('me').textContent = session.login;
  $('logout').addEventListener('click', async () => {
    chat?.close();
    events?.close();
    await tw.logout(session);
    location.reload();
  });
  try {
    const json = await helix.request(`users?id=${session.userId}`);
    const u = json.data[0];
    if (u) {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.src = u.profile_image_url;
      img.alt = '';
      box.prepend(img);
      $('me').textContent = u.display_name;
    }
  } catch {}
}

function renderChatStatus(status) {
  const pill = $('chatStatus');
  pill.hidden = false;
  const map = {
    connecting: ['warn', 'Подключаемся к чату…'],
    reconnecting: ['warn', 'Переподключаемся к чату…'],
    connected: ['ok', `Чат #${session.login}`],
    disconnected: ['', 'Чат отключён'],
  };
  const [cls, text] = map[status];
  pill.className = `pill ${cls}`;
  pill.textContent = text;
}

function onChatMessage(msg) {
  if (g.phase !== 'registration' || !msg.userId) return;
  if (!G.matchesKeyword(msg.text, settings)) return;
  // Повторное слово записанного участника ничего не добавляет (защита от накрутки по Twitch ID).
  // Но если его отклонили — проверяем заново: вдруг он только что подписался.
  const p = byId.get(msg.userId);
  if (p) return void recheck(p);
  register({ id: msg.userId, login: msg.login, name: msg.name });
}

/** Перепроверка отклонённого участника (не чаще раза в RECHECK_MS). */
function recheck(p) {
  if (p.status !== 'rejected' || p.test || hasResults()) return;
  if (Date.now() - (p.checkedAt || 0) < RECHECK_MS) return;
  p.status = 'checking';
  p.reason = 'перепроверка';
  enqueueCheck(p.id);
  renderSoon();
}

/**
 * Новый фоллоу или саб на канале. Если это отклонённый участник открытой регистрации и теперь он
 * подходит под условия — допускаем сразу, без повторного сообщения в чате.
 */
function onTwitchEvent(ev) {
  mark(`Twitch: ${ev.type} ${ev.login}`);
  if (g.phase !== 'registration') return;
  const p = byId.get(ev.userId);
  if (!p || p.status !== 'rejected') return;
  const fits =
    (ev.type === 'follow' && settings.eligibility === 'followers' && !(settings.minFollowDays > 0)) ||
    (ev.type === 'subscribe' && settings.eligibility === 'subs');
  if (!fits) return; // например, нужен стаж фоллоу — новый фоллоу его не даёт
  p.status = 'ok';
  p.reason = ev.type === 'follow' ? 'фоллоу только что' : 'саб только что';
  p.checkedAt = Date.now();
  saveGiveaway();
  renderSoon();
  toast(`${p.name} ${ev.type === 'follow' ? 'зафолловил' : 'подписался'} — допущен к розыгрышу`);
}

// ---------- Участники ----------

function register(user, { test = false } = {}) {
  if (byId.has(user.id)) return false;
  if (G.excludedLogins(settings, session?.login).has(user.login.toLowerCase())) return false;
  // Материал выдаётся по кругу в порядке записи, поэтому соседи на колесе разные.
  const p = { ...user, status: 'checking', reason: '', test, mat: g.participants.length % MATERIALS.length };
  g.participants.push(p);
  byId.set(p.id, p);
  enqueueCheck(p.id);
  saveGiveaway();
  renderSoon();
  return true;
}

const queue = [];
let active = 0;

function enqueueCheck(id) {
  queue.push(id);
  pump();
}

function requeueChecks() {
  for (const p of g.participants) if (p.status === 'checking') enqueueCheck(p.id);
}

function pump() {
  while (active < 4 && queue.length) {
    const id = queue.shift();
    active++;
    checkOne(id).finally(() => {
      active--;
      pump();
    });
  }
}

async function checkOne(id) {
  const p = byId.get(id);
  if (!p || p.status !== 'checking') return;
  const needsApi = !p.test && settings.eligibility !== 'all';
  if (needsApi && !helix) return; // проверим после входа
  p.checkedAt = Date.now();
  try {
    Object.assign(p, needsApi ? await checkEligibility(p) : { status: 'ok', reason: '' });
  } catch (e) {
    p.status = 'rejected';
    p.reason = 'ошибка проверки';
    showNotice(`Twitch API: ${escapeHtml(e.message)}`, true);
  }
  saveGiveaway();
  renderSoon();
}

async function checkEligibility(p) {
  if (settings.eligibility === 'followers') {
    const at = await helix.followedAt(p.id);
    if (!at) return { status: 'rejected', reason: 'нет фоллоу' };
    const days = Math.floor((Date.now() - at) / 864e5);
    if (settings.minFollowDays > 0 && days < settings.minFollowDays) {
      return { status: 'rejected', reason: `фоллоу ${days} дн.` };
    }
    return { status: 'ok', reason: `фоллоу ${days} дн.` };
  }
  const tier = await helix.subTier(p.id);
  return tier ? { status: 'ok', reason: `саб T${tier[0]}` } : { status: 'rejected', reason: 'нет саба' };
}

function addTestUsers() {
  const start = g.participants.filter((p) => p.test).length + 1;
  for (let i = 0; i < 10; i++) {
    const n = String(start + i).padStart(2, '0');
    register({ id: `test:${start + i}`, login: `tester_${n}`, name: `Тестер_${n}` }, { test: true });
  }
}

async function addManual(raw) {
  const login = raw.trim().replace(/^@/, '').toLowerCase();
  if (!login) return;
  if (!helix) {
    register({ id: `manual:${login}`, login, name: raw.trim().replace(/^@/, '') }, { test: true });
    return;
  }
  try {
    const user = await helix.userByLogin(login);
    if (!user) return toast(`Пользователь ${login} не найден`);
    if (!register(user)) toast(`${user.name} уже в списке или в исключениях`);
  } catch (e) {
    toast(`Не удалось найти ${login}: ${e.message}`);
  }
}

// ---------- Ход розыгрыша ----------

function startRegistration() {
  if (g.phase === 'idle') announce(settings.announceStart, {});
  g.phase = 'registration';
  saveGiveaway();
  render();
}

function closeRegistration() {
  g.phase = 'closed';
  saveGiveaway();
  announce(settings.announceClose, { count: okCount() });
  render();
}

async function spin() {
  if (spinning) return;
  clearTimeout(autoTimer);
  const step = G.planNextStep(g, settings);
  if (!step) return afterSpin();
  if (step.auto) {
    // Участник один с самого начала — крутить нечего.
    const r = giveAuto(step);
    display = { ...display, highlight: null, result: { kind: 'win', ...r }, locked: true };
    return afterSpin();
  }

  const entries = entriesOf(step.pool);
  const index = G.randomInt(entries.length);
  const seconds = Math.max(1, step.kind === 'eliminate' ? settings.eliminationSpinSeconds : settings.spinSeconds);
  const params = {
    index,
    offset: 0.35 + G.randomFloat() * 0.3, // шарик ложится ближе к середине ячейки
    wheelTurns: 1 + seconds * 0.2 + G.randomFloat(),
    ballTurns: Math.round(2 + seconds * 1.1),
    duration: seconds * 1000,
  };

  spinning = true;
  display = { entries, highlight: null, result: null, locked: true };
  wheel.setEntries(entries, { keepBall: true });
  bus.send('spin', { entries, params, result: resultView(step, step.pool[index]) });
  render();
  await wheel.spin(params);
  spinning = false;

  const id = step.pool[index];
  G.applyStep(g, step, id);
  display.highlight = { index, kind: step.kind };
  display.result = resultView(step, id);
  wheel.setHighlight(display.highlight);
  if (step.kind === 'win') announceWin(step.prizeIndex, id);
  // Если остался один финалист, его место очевидно — выдаём сразу и показываем в той же плашке.
  const also = [];
  for (let next; (next = G.planNextStep(g, settings)) && next.auto; ) also.push(giveAuto(next));
  if (also.length) display.result.also = also;
  afterSpin();
}

function giveAuto(step) {
  const id = step.pool[0];
  G.applyStep(g, step, id);
  announceWin(step.prizeIndex, id);
  return { prize: prizeName(step.prizeIndex), name: byId.get(id).name };
}

function announceWin(prizeIndex, id) {
  announce(settings.announceWin, { prize: prizeName(prizeIndex), name: byId.get(id).login, place: prizeIndex + 1 });
}

function afterSpin() {
  mark('пульт: результат');
  if (!G.planNextStep(g, settings)) {
    g.phase = 'finished';
    autoRunning = false;
  }
  saveGiveaway();
  render();
  broadcastState(true);
  // Пока колесо стоит с результатом, заготавливаем следующий список (без выбывшего) —
  // тогда «КРУТИТЬ» стартует без рывка.
  setTimeout(() => {
    const next = nextEntries();
    if (next && !spinning) wheel.prepare(next);
  }, 400);
  if (autoRunning) autoTimer = setTimeout(spin, Math.max(300, settings.autoDelaySeconds * 1000));
}

/** Список ячеек следующего прокрута (или null, если крутить больше нечего). */
function nextEntries() {
  const step = g.phase === 'closed' ? G.planNextStep(g, settings) : null;
  return step && !step.auto ? entriesOf(step.pool) : null;
}

function onSpinClick() {
  mark('пульт: нажата КРУТИТЬ');
  autoRunning = settings.autoSpin;
  spin();
}

function stopAuto() {
  autoRunning = false;
  clearTimeout(autoTimer);
  render();
}

async function restart() {
  if (!(await ask('Сбросить результаты и разыграть заново среди тех же участников?', 'Переиграть'))) return;
  stopAuto();
  setGiveaway({ ...g, phase: 'closed', eliminated: [], winners: [] });
  render();
  broadcastState(true);
}

async function reset() {
  if (spinning) return;
  if (g.participants.length && !(await ask('Начать новый розыгрыш? Участники и результаты будут удалены.', 'Начать новый'))) return;
  stopAuto();
  setGiveaway(G.newGiveaway());
  render();
  broadcastState(true);
}

function resultView(step, id) {
  const name = byId.get(id).name;
  return step.kind === 'win' ? { kind: 'win', name, prize: prizeName(step.prizeIndex) } : { kind: 'eliminate', name };
}

async function announce(template, vars) {
  if (!settings.announce || !helix || !template.trim()) return;
  const text = G.fillTemplate(template, { keyword: settings.keyword, rules: G.rulesText(settings), count: okCount(), ...vars });
  try {
    await helix.sendChat(text);
  } catch (e) {
    toast(`Не удалось написать в чат: ${e.message}`);
  }
}

function entriesOf(ids) {
  return ids.map((id) => {
    const p = byId.get(id);
    return { name: p.name, mat: p.mat ?? 0 };
  });
}

const entriesKey = (entries) => entries.map((e) => `${e.mat}:${e.name}`).join('\n');

const okCount = () => g.participants.reduce((n, p) => n + (p.status === 'ok'), 0);
const hasResults = () => g.winners.length > 0 || g.eliminated.length > 0;

// ---------- Отрисовка ----------

// Таймер, а не requestAnimationFrame: пульт в фоновой вкладке должен продолжать обновлять оверлей.
let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 50);
}

function render() {
  renderSettingsState();
  renderStage();
  renderWinners();
  renderPeople();
  broadcastState();
}

function renderSettingsState() {
  const lockParticipation = g.phase !== 'idle';
  const lockGame = hasResults() || spinning;
  for (const key of FIELDS) {
    const el = $(key);
    if (PARTICIPATION_FIELDS.includes(key)) el.disabled = lockParticipation;
    if (GAME_FIELDS.includes(key)) el.disabled = lockGame;
  }
  for (const seg of document.querySelectorAll('.segmented')) {
    const name = seg.dataset.name;
    for (const b of seg.children) b.classList.toggle('active', b.dataset.value === settings[name]);
    seg.classList.toggle('disabled', name === 'mode' ? lockGame : lockParticipation);
  }
  const lockNote = lockGame
    ? 'Розыгрыш идёт: участие, призы и режим заблокированы.'
    : lockParticipation
      ? 'Регистрация открыта: условия участия заблокированы.'
      : '';
  $('lockText').textContent = lockNote;
  $('lockNote').hidden = !lockNote;
  $('lockReset').disabled = spinning;
  $('restart').hidden = !hasResults();
  $('restart').disabled = spinning;

  for (const el of document.querySelectorAll('[data-show]')) {
    const [key, value] = el.dataset.show.split('=');
    el.hidden = String(settings[key]) !== value;
  }

  const n = settings.prizeCount;
  $('modeHint').textContent =
    settings.mode === 'elimination'
      ? `Колесо выбивает участников по одному, пока их не останется ${n} (по числу призов). Затем между ними разыгрываются призы.`
      : `Один прокрут — один приз. Колесо крутится ${n} ${plural(n, 'раз', 'раза', 'раз')} среди всех участников.`;
}

function renderStage() {
  const step = G.planNextStep(g, settings);

  if (!spinning && !display.locked) {
    const ids =
      g.phase === 'closed' && step ? step.pool : g.participants.filter((p) => p.status === 'ok').map((p) => p.id);
    const entries = entriesOf(ids);
    if (entriesKey(entries) !== entriesKey(display.entries)) {
      display.entries = entries;
      wheel.setEntries(entries);
    }
  }

  const res = $('result');
  // Плашка не исчезает из разметки, а становится невидимой — так кнопка под ней остаётся на месте.
  const showResult = display.result && !spinning;
  res.className = `result ${showResult ? display.result.kind : 'empty'}`;
  res.textContent = showResult ? G.resultText(display.result) : '';
  res.title = res.textContent;

  // Внизу всегда одна главная кнопка по ходу розыгрыша; остальное — в окне настроек.
  const show = (id, cond) => ($(id).hidden = !cond);
  show('startReg', g.phase === 'idle');
  $('startReg').disabled = !settings.keyword.trim();
  show('closeReg', g.phase === 'registration');
  show('spin', g.phase === 'closed' && !!step && !autoRunning);
  $('spin').disabled = spinning;
  show('stopAuto', autoRunning);
  show('reset', (g.phase === 'finished' || (g.phase === 'closed' && !step)) && !spinning);
}

function renderWinners() {
  const list = winnersView();
  $('winners').innerHTML = list.length
    ? list.map((w) => `<li><span class="prize">${escapeHtml(w.prize)}</span><span class="name">${escapeHtml(w.name)}</span></li>`).join('')
    : '<li class="empty">Пока никого</li>';
}

function winnersView() {
  return [...g.winners]
    .sort((a, b) => a.prizeIndex - b.prizeIndex)
    .map((w) => ({ prize: prizeName(w.prizeIndex), name: byId.get(w.id)?.name ?? '?' }));
}

function renderPeople() {
  const counts = { ok: 0, checking: 0, rejected: 0 };
  for (const p of g.participants) counts[p.status]++;
  $('counts').innerHTML = `<span>допущено <b class="ok">${counts.ok}</b></span>
    ${counts.checking ? `<span>проверка <b class="checking">${counts.checking}</b></span>` : ''}
    <span>отклонено <b class="rejected">${counts.rejected}</b></span>`;

  const q = $('search').value.trim().toLowerCase();
  const filter = $('filter').value;
  const out = new Set(g.eliminated);
  const won = new Set(g.winners.map((w) => w.id));
  const canEdit = !hasResults() && !spinning;
  const shown = g.participants
    .filter((p) => (filter === 'all' || p.status === filter) && (!q || p.login.includes(q) || p.name.toLowerCase().includes(q)))
    .slice(-500)
    .reverse();

  $('people').innerHTML = shown.length
    ? shown
        .map((p) => {
          const cls = won.has(p.id) ? 'won' : out.has(p.id) ? 'out' : '';
          const actions = !canEdit
            ? ''
            : p.status === 'rejected'
              ? `<button class="icon-btn" data-act="allow" data-id="${p.id}" title="Допустить вручную">✓</button>`
              : `<button class="icon-btn" data-act="remove" data-id="${p.id}" title="Убрать">✕</button>`;
          return `<li class="${cls}">
            <span class="dot ${p.status}"></span>
            <span class="who">${escapeHtml(p.name)}</span>
            ${p.test ? '<span class="tag">тест</span>' : ''}
            <span class="reason">${escapeHtml(p.reason || '')}</span>
            ${actions}
          </li>`;
        })
        .join('')
    : `<li class="empty">${g.participants.length ? 'Никого не найдено' : 'Пока никто не записался'}</li>`;

  const canAdd = g.phase !== 'finished' && !hasResults();
  for (const el of [$('addName'), $('addForm').querySelector('button'), $('addTest')]) el.disabled = !canAdd;
}

function onPeopleClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const p = byId.get(b.dataset.id);
  if (!p) return;
  if (b.dataset.act === 'allow') {
    p.status = 'ok';
    p.reason = 'допущен вручную';
  } else {
    g.participants = g.participants.filter((x) => x !== p);
    byId.delete(p.id);
  }
  saveGiveaway();
  render();
}

// ---------- Оверлей ----------

let lastBroadcast = 0;
let broadcastTimer = null;
function broadcastState(force = false) {
  if (spinning) return; // оверлей сам доводит анимацию до конца
  const wait = force ? 0 : Math.max(0, 250 - (Date.now() - lastBroadcast));
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    lastBroadcast = Date.now();
    bus.send('state', {
      phase: g.phase,
      keyword: settings.keyword,
      rules: G.rulesText(settings),
      count: okCount(),
      entries: display.entries,
      highlight: display.highlight,
      result: display.result,
      winners: winnersView(),
      roster: rosterView(),
      next: nextEntries(), // оверлей заранее готовит колесо к следующему прокруту
    });
  }, wait);
}

/** Весь допущенный состав для оверлея: кто в игре, кто выбыл (и в каком порядке), кто какое место занял. */
function rosterView() {
  const out = new Map(g.eliminated.map((id, i) => [id, i]));
  const won = new Map(g.winners.map((w) => [w.id, w.prizeIndex + 1]));
  return g.participants
    .filter((p) => p.status === 'ok')
    .map((p) => ({
      id: p.id,
      name: p.name,
      mat: p.mat ?? 0,
      status: won.has(p.id) ? 'win' : out.has(p.id) ? 'out' : 'in',
      place: won.get(p.id),
      order: out.get(p.id),
    }));
}

function copyOverlayUrl() {
  const url = new URL('overlay.html', location.href).href;
  navigator.clipboard.writeText(url).then(
    () => toast('Ссылка на оверлей скопирована. В OBS: Источник → Браузер, 1920×1080.'),
    () => prompt('Ссылка на оверлей для OBS:', url),
  );
}

// ---------- Мелочи ----------

function showNotice(html, error = false) {
  const el = $('notice');
  el.innerHTML = html;
  el.className = `notice${error ? ' error' : ''}`;
  el.hidden = false;
}

let toastTimer = null;
function toast(text) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.append(el);
  }
  el.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- Старт ----------

bindSettings();
$('startReg').addEventListener('click', startRegistration);
$('closeReg').addEventListener('click', closeRegistration);
$('spin').addEventListener('click', onSpinClick);
$('stopAuto').addEventListener('click', stopAuto);
$('restart').addEventListener('click', () => {
  closeSettings();
  restart();
});
$('reset').addEventListener('click', reset);
$('copyOverlay').addEventListener('click', copyOverlayUrl);
$('openSettings').addEventListener('click', () => openSettings());
$('closeSettings').addEventListener('click', closeSettings);
$('lockReset').addEventListener('click', () => {
  closeSettings();
  reset();
});
$('closeSettingsX').addEventListener('click', closeSettings);
$('settingsDialog').addEventListener('click', (e) => e.target === $('settingsDialog') && closeSettings());
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));
$('addTest').addEventListener('click', addTestUsers);
$('people').addEventListener('click', onPeopleClick);
$('search').addEventListener('input', renderPeople);
$('filter').addEventListener('change', renderPeople);
$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  addManual($('addName').value);
  $('addName').value = '';
});

render();
requeueChecks();
initSession().then(render);
if (firstRun) {
  saveSettings();
  openSettings('entry');
}
$('appVersion').textContent = window.__appVersion ? `v${window.__appVersion}` : '';
// В режиме ?debug=1 — ручной ввод сообщений чата и событий Twitch (проверка сценариев без стрима).
if (DEBUG) window.__roulette = { chat: onChatMessage, twitchEvent: onTwitchEvent, participant: (id) => byId.get(id) };
window.__panelStarted = true; // встроенный скрипт в index.html проверяет, что пульт запустился
