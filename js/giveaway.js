// Правила розыгрыша без привязки к интерфейсу.

export const DEFAULT_SETTINGS = {
  keyword: '!участвую',
  exactMatch: true,
  eligibility: 'followers', // 'all' | 'followers' | 'subs'
  minFollowDays: 0,
  excludeBroadcaster: true,
  excluded: 'nightbot, streamelements, moobot, streamlabs, fossabot, wizebot',
  prizeCount: 1,
  mode: 'elimination', // 'elimination' | 'simple'
  finalOrder: 'first', // 'first' — первым разыгрывается приз №1, 'last' — последний приз, главный достаётся оставшемуся
  allowRepeatWins: false,
  spinSeconds: 6,
  eliminationSpinSeconds: 3,
  autoSpin: false,
  autoDelaySeconds: 2,
  announce: true,
  announceStart: '🎰 Розыгрыш начался! Пишите {keyword} в чат, чтобы участвовать. {rules}',
  announceClose: '⏳ Регистрация закрыта, участников: {count}. Крутим!',
  announceWin: '🏆 {prize} — @{name}! Поздравляем!', // {prize} = «1 место», «2 место»…
};

export function newGiveaway() {
  return {
    phase: 'idle', // 'idle' | 'registration' | 'closed' | 'finished'
    participants: [], // { id, login, name, status: 'checking' | 'ok' | 'rejected', reason, test }
    eliminated: [], // id в порядке выбывания
    winners: [], // { prizeIndex, id }
  };
}

export function rulesText(s) {
  const parts = [];
  if (s.eligibility === 'followers') {
    parts.push(s.minFollowDays > 0 ? `Нужен фоллоу не меньше ${s.minFollowDays} дн.` : 'Нужен фоллоу.');
  } else if (s.eligibility === 'subs') parts.push('Только для сабов.');
  parts.push(`Призов: ${s.prizeCount}.`);
  return parts.join(' ');
}

export function excludedLogins(s, broadcasterLogin) {
  const list = s.excluded
    .split(/[\s,;]+/)
    .map((x) => x.replace(/^@/, '').toLowerCase())
    .filter(Boolean);
  if (s.excludeBroadcaster && broadcasterLogin) list.push(broadcasterLogin.toLowerCase());
  return new Set(list);
}

export function matchesKeyword(text, s) {
  const t = text.trim().toLowerCase();
  const k = s.keyword.trim().toLowerCase();
  if (!k) return false;
  return s.exactMatch ? t === k : t.includes(k);
}

/**
 * Следующий шаг розыгрыша или null, если всё разыграно.
 * kind: 'eliminate' — колесо выбивает участника; 'win' — колесо выбирает обладателя приза prizeIndex.
 * auto: true — в пуле один человек, исход очевиден: приз уходит ему без прокрута.
 */
export function planNextStep(g, s) {
  const ok = g.participants.filter((p) => p.status === 'ok').map((p) => p.id);
  const won = new Set(g.winners.map((w) => w.id));
  const out = new Set(g.eliminated);
  const totalPrizes = s.prizeCount;
  if (g.winners.length >= totalPrizes) return null;

  if (s.mode === 'simple') {
    const pool = s.allowRepeatWins ? ok : ok.filter((id) => !won.has(id));
    if (!pool.length) return null;
    return { kind: 'win', pool, prizeIndex: g.winners.length, auto: pool.length === 1 && !s.allowRepeatWins };
  }

  const pool = ok.filter((id) => !won.has(id) && !out.has(id));
  if (!pool.length) return null;
  const left = totalPrizes - g.winners.length;
  if (pool.length > left) return { kind: 'eliminate', pool, auto: false };
  const prizeIndex = s.finalOrder === 'last' ? pool.length - 1 : g.winners.length;
  return { kind: 'win', pool, prizeIndex, auto: pool.length === 1 };
}

export function applyStep(g, step, id) {
  if (step.kind === 'eliminate') g.eliminated.push(id);
  else g.winners.push({ prizeIndex: step.prizeIndex, id });
}

/** Сколько ещё прокрутов осталось (для подсказки в интерфейсе). Очевидные шаги без прокрута не считаются. */
export function spinsLeft(g, s) {
  const sim = { ...g, eliminated: [...g.eliminated], winners: [...g.winners] };
  let spins = 0;
  for (let step; (step = planNextStep(sim, s)); ) {
    if (!step.auto) spins++;
    applyStep(sim, step, step.pool[0]); // кто именно выпадет, на число прокрутов не влияет
  }
  return spins;
}

/** Текст плашки результата; also — места, выданные сразу после прокрута без своего прокрута. */
export function resultText(r) {
  if (r.kind !== 'win') return `Выбывает: ${r.name}`;
  return [`🏆 ${r.prize} — ${r.name}`, ...(r.also || []).map((a) => `${a.prize} — ${a.name}`)].join('  ·  ');
}

/** Призы — это просто места: «1 место», «2 место»… */
export const prizeName = (i) => `${i + 1} место`;

/** Настройки из старых версий: список призов превращаем в их количество, число — в целое от 1 до 100. */
export function normalizeSettings(s) {
  if (Array.isArray(s.prizes)) s.prizeCount = s.prizes.length;
  delete s.prizes;
  s.prizeCount = Math.min(100, Math.max(1, Math.round(Number(s.prizeCount) || 1)));
  return s;
}

export function randomInt(n) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n; // без перекоса по модулю
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

export function randomFloat() {
  return randomInt(1_000_000) / 1_000_000;
}

export function fillTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
