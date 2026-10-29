// Диагностика рывков: включается параметром ?debug=1 в адресе пульта или оверлея.
// Табло в углу записывает каждый долгий кадр (дольше ~28 мс) и что в этот момент делало приложение
// (метки mark() из wheel.js, panel.js, overlay.js, crowd.js). Отчёт копируется кнопкой.
// Без ?debug=1 ничего не делает и ничего не рисует.

export const DEBUG = new URLSearchParams(location.search).has('debug');

const events = []; // [время, метка]
const hitches = []; // { at, dur, around: [метки рядом] }

export function mark(label) {
  if (!DEBUG) return;
  events.push([performance.now(), label]);
  if (events.length > 600) events.shift();
}

if (DEBUG) start();

function start() {
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:99999;width:340px;max-height:46vh;overflow:auto;padding:8px 10px;' +
    'background:rgba(0,0,0,.82);color:#e8e8e8;font:12px/1.35 Consolas,monospace;border:1px solid #555;border-radius:6px';
  box.innerHTML =
    '<div><b>Диагностика</b> <span id="__hudInfo"></span></div>' +
    '<div style="margin:4px 0"><button id="__hudCopy">Копировать отчёт</button> <button id="__hudClear">Очистить</button></div>' +
    '<div id="__hudList"></div>';
  const attach = () => document.body.append(box);
  document.body ? attach() : addEventListener('DOMContentLoaded', attach);

  let last = performance.now();
  let frames = 0;
  let fpsAt = last;
  let fps = 0;
  const loop = (now) => {
    const d = now - last;
    last = now;
    frames++;
    if (now - fpsAt > 1000) {
      fps = Math.round((frames * 1000) / (now - fpsAt));
      frames = 0;
      fpsAt = now;
      render();
    }
    if (d > 28) {
      const from = now - d - 150;
      hitches.push({
        at: Math.round(now - d),
        dur: Math.round(d),
        around: events.filter(([t]) => t >= from && t <= now).map(([t, l]) => `${Math.round(t - (now - d))}мс ${l}`),
      });
      if (hitches.length > 60) hitches.shift();
      render();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => mark(`долгая задача ${Math.round(e.duration)}мс`))).observe({ type: 'longtask' });
  } catch {}
  try {
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => {
        const s = (e.scripts || [])
          .filter((x) => x.duration > 5)
          .map((x) => `${x.sourceFunctionName || x.invoker || '?'}@${String(x.sourceURL || '').split('/').pop()} ${Math.round(x.duration)}мс`);
        mark(`долгий кадр ${Math.round(e.duration)}мс` + (s.length ? ': ' + s.join(', ') : ''));
      }),
    ).observe({ type: 'long-animation-frame' });
  } catch {}

  function render() {
    const info = document.getElementById('__hudInfo');
    if (info) info.textContent = `${fps} fps · рывков: ${hitches.length}`;
    const list = document.getElementById('__hudList');
    if (!list) return;
    list.innerHTML = hitches
      .slice(-8)
      .reverse()
      .map((h) => `<div style="margin-top:4px"><b>${h.dur} мс</b> в ${(h.at / 1000).toFixed(1)} с<br>${h.around.map(esc).join('<br>') || '—'}</div>`)
      .join('');
  }

  addEventListener('click', (e) => {
    if (e.target.id === '__hudClear') {
      hitches.length = 0;
      render();
    }
    if (e.target.id === '__hudCopy') {
      const text = [
        `Страница: ${location.pathname.split('/').pop() || 'index.html'} ${location.search}`,
        `Браузер: ${navigator.userAgent}`,
        `Время работы: ${(performance.now() / 1000).toFixed(0)} с, fps сейчас: ${fps}`,
        '',
        ...hitches.map((h) => `${h.dur} мс в ${(h.at / 1000).toFixed(1)} с\n  ${h.around.join('\n  ') || '—'}`),
      ].join('\n');
      navigator.clipboard.writeText(text).then(
        () => (e.target.textContent = 'Скопировано'),
        () => prompt('Скопируйте отчёт:', text),
      );
    }
  });
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
