// Рисунок головы колеса: сектора участников в их материалах, номера на пояске и ники с обводкой,
// плюс карта свойств материалов (G — шероховатость, B — металл). Чистый 2D-холст без three.js —
// поэтому то же самое рисуется и в фоновом потоке (js/headart.worker.js), не тормозя кадры колеса.
import { MATERIALS } from './materials.js?v=16';

const TAU = Math.PI * 2;
const WOOD_ORM = 'rgb(0, 90, 13)'; // шероховатость 0.35, металл 0.05 для деревянной ступицы

/**
 * ctx — холст цвета (квадратный), orm — холст свойств; entries — [{ name, mat }];
 * R — радиусы головы колеса из wheel.js (hub, pocketInner, bandInner, headOuter, texture).
 */
export function drawHead(ctx, orm, entries, R) {
  const real = entries.length;
  const n = real || 24;
  const step = TAU / n;
  const size = ctx.canvas.width;
  const k = size / 2 / R.texture; // пикселей на единицу радиуса
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#3a1a08';
  ctx.fillRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);
  ctx.scale(k, k);

  const ko = orm.canvas.width / 2 / R.texture;
  orm.setTransform(1, 0, 0, 1, 0, 0);
  orm.fillStyle = WOOD_ORM;
  orm.fillRect(0, 0, orm.canvas.width, orm.canvas.height);
  orm.translate(orm.canvas.width / 2, orm.canvas.height / 2);
  orm.scale(ko, ko);

  // Сектор участника — конус с ником, ячейка и поясок — целиком из его материала.
  const mats = [];
  for (let i = 0; i < n; i++) {
    const m = MATERIALS[(real ? entries[i].mat : i) % MATERIALS.length];
    mats.push(m);
    sector(ctx, R.hub, R.headOuter + 0.02, i * step, (i + 1) * step);
    ctx.fillStyle = m.color;
    ctx.fill();
    sector(orm, R.hub, R.headOuter + 0.02, i * step, (i + 1) * step);
    orm.fillStyle = `rgb(0, ${Math.round(m.roughness * 255)}, ${Math.round(m.metalness * 255)})`;
    orm.fill();
  }
  // Цвет букв и обводки: на светлом материале тёмные буквы, на тёмном светлые.
  const ink = (m) => (luminance(m.color) > 0.45 ? ['#120b03', 'rgba(255,250,235,0.9)'] : ['#ffffff', 'rgba(0,0,0,0.9)']);
  // Буквы — матовая краска поверх материала: без этого на металле они отражают окружение и сливаются.
  const PAINT_ORM = 'rgb(0, 190, 0)';
  const paint = (text, x, y, fs, [fill, outline]) => {
    ctx.lineJoin = orm.lineJoin = 'round';
    ctx.lineWidth = orm.lineWidth = fs * 0.24;
    ctx.strokeStyle = outline;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    orm.strokeStyle = orm.fillStyle = PAINT_ORM;
    orm.strokeText(text, x, y);
    orm.fillText(text, x, y);
  };
  const withBoth = (fn) => {
    ctx.save();
    orm.save();
    fn();
    ctx.restore();
    orm.restore();
  };

  // Лёгкое затенение конуса к краю — основной объём даёт настоящий свет.
  const cone = ctx.createRadialGradient(0, 0, R.hub, 0, 0, R.pocketInner);
  cone.addColorStop(0, 'rgba(255,255,255,0.06)');
  cone.addColorStop(1, 'rgba(0,0,0,0.12)');
  ring(ctx, R.hub, R.pocketInner, cone);

  // Тонкие золотые линии между секторами имён.
  if (n > 1) {
    ctx.strokeStyle = 'rgba(222, 182, 92, 0.55)';
    ctx.lineWidth = Math.max(1 / k, 0.004);
    for (let i = 0; i < n; i++) {
      const a = i * step;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R.hub, Math.sin(a) * R.hub);
      ctx.lineTo(Math.cos(a) * R.pocketInner, Math.sin(a) * R.pocketInner);
      ctx.stroke();
    }
  }

  // Номера на пояске.
  const bandMid = (R.bandInner + R.headOuter) / 2;
  if (real && bandMid * step > 0.03) {
    const fs = Math.min(0.036, bandMid * step * 0.5);
    for (let i = 0; i < n; i++) {
      withBoth(() => {
        for (const c of [ctx, orm]) {
          c.font = `800 ${fs}px "Segoe UI", Inter, system-ui, sans-serif`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.rotate((i + 0.5) * step);
          c.translate(bandMid, 0);
          c.rotate(Math.PI / 2);
        }
        paint(String(i + 1), 0, 0, fs, ink(mats[i]));
      });
    }
  }

  // Имена — от края конуса к центру.
  if (real) {
    const midArc = ((R.hub + R.pocketInner) / 2) * step;
    const fs = Math.min(0.075, midArc * 0.7);
    if (fs * k >= 14) {
      const maxW = R.pocketInner - R.hub - 0.04;
      const font = (s) => `800 ${s}px "Segoe UI", Inter, system-ui, sans-serif`;
      const widthAt = (text, s) => {
        ctx.font = font(s);
        return ctx.measureText(text).width;
      };
      const textEnd = R.pocketInner - 0.02;
      // Наибольший размер, при котором строки влезают по длине и не вылезают за сектор у внутреннего конца.
      const fitSize = (lines) => {
        let s = fs;
        for (let iter = 0; iter < 40; iter++) {
          const w = Math.max(...lines.map((l) => widthAt(l, s)));
          if (w > maxW) {
            s *= maxW / w;
            continue;
          }
          const arcAtInnerEnd = (textEnd - w) * step * 0.9;
          if (lines.length * 1.05 * s <= arcAtInnerEnd) break;
          s *= 0.93;
        }
        return Math.max(s, fs * 0.4);
      };
      for (let i = 0; i < n; i++) {
        const name = entries[i].name;
        // Длинный ник: либо уменьшаем, либо переносим на две строки — что получится крупнее.
        let lines = [name];
        let size = fitSize(lines);
        if (size < fs * 0.8 && name.length > 3) {
          const two = splitName(name);
          const twoSize = fitSize(two);
          if (twoSize > size * 1.15) [lines, size] = [two, twoSize];
        }
        withBoth(() => {
          for (const c of [ctx, orm]) {
            c.font = font(size);
            c.textAlign = 'right';
            c.textBaseline = 'middle';
            c.rotate((i + 0.5) * step);
          }
          lines.forEach((line, j) => {
            const y = (j - (lines.length - 1) / 2) * size * 1.05;
            paint(fit(ctx, line, maxW), textEnd, y, size, ink(mats[i]));
          });
        });
      }
    }
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-R.texture, -R.texture, R.texture * 2, R.texture * 2);
  }

  // Ступица — полированное дерево.
  const hub = ctx.createRadialGradient(-0.04, -0.05, 0, 0, 0, R.hub);
  hub.addColorStop(0, '#a4612f');
  hub.addColorStop(0.7, '#62300f');
  hub.addColorStop(1, '#341707');
  ctx.beginPath();
  ctx.arc(0, 0, R.hub, 0, TAU);
  ctx.fillStyle = hub;
  ctx.fill();
}

function ring(ctx, r0, r1, fill) {
  ctx.beginPath();
  ctx.arc(0, 0, r1, 0, TAU);
  ctx.arc(0, 0, r0, 0, TAU, true);
  ctx.fillStyle = fill;
  ctx.fill();
}

function sector(ctx, r0, r1, a0, a1) {
  ctx.beginPath();
  ctx.arc(0, 0, r1, a0, a1);
  ctx.arc(0, 0, r0, a1, a0, true);
  ctx.closePath();
}

function fit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

export function splitName(name) {
  const mid = name.length / 2;
  let best = -1;
  let drop = 0; // сколько символов выкинуть на месте разреза (пробел)
  const isLower = (c) => c !== c.toUpperCase() && c === c.toLowerCase();
  const isUpper = (c) => c !== c.toLowerCase() && c === c.toUpperCase();
  const isDigit = (c) => c >= '0' && c <= '9';
  const consider = (cut, skip) => {
    if (cut <= 0 || cut >= name.length) return;
    if (best < 0 || Math.abs(cut - mid) < Math.abs(best - mid)) [best, drop] = [cut, skip];
  };
  for (let i = 1; i < name.length; i++) {
    const a = name[i - 1];
    const b = name[i];
    if (b === ' ') consider(i, 1);
    else if ('_-.'.includes(a)) consider(i, 0); // разделитель остаётся в конце первой строки
    else if ((isLower(a) && isUpper(b)) || (isDigit(a) !== isDigit(b) && /[\p{L}\d]/u.test(a + b))) consider(i, 0);
  }
  if (best > 0 && Math.abs(best - mid) <= name.length * 0.3) return [name.slice(0, best), name.slice(best + drop)];
  const cut = Math.ceil(mid);
  return [name.slice(0, cut), name.slice(cut)];
}

function luminance(hex) {
  const v = parseInt(hex.slice(1), 16);
  return (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
}

