// Фоновый поток: рисует голову колеса (ники с обводкой — самая дорогая часть, 100+ мс на 2048×2048)
// на OffscreenCanvas и отдаёт готовые картинки. Основной поток в это время спокойно крутит колесо.
import { drawHead } from './headart.js?v=29';

const color = new OffscreenCanvas(2048, 2048);
const orm = new OffscreenCanvas(512, 512);
// Рисуем на процессоре (willReadFrequently): холст на видеокарте делил её с колесом — в момент, когда
// картинка была готова, кадр колеса задерживался (рывок при быстром нажатии «КРУТИТЬ»).
const colorCtx = color.getContext('2d', { willReadFrequently: true });
const ormCtx = orm.getContext('2d', { willReadFrequently: true });

self.onmessage = async ({ data: { id, entries, R } }) => {
  drawHead(colorCtx, ormCtx, entries, R);
  // Отдаём сырые пиксели, а не ImageBitmap: массив байт переходит в основной поток без копирования и
  // не задействует видеокарту, а приём ImageBitmap задерживал кадр колеса (рывок на «КРУТИТЬ»).
  const c = pixels(colorCtx);
  const o = pixels(ormCtx);
  self.postMessage({ id, color: c, orm: o }, [c.data.buffer, o.data.buffer]);
};

// Строки снизу вверх: развёртка UV головы рассчитана на перевёрнутую картинку (как у обычного холста).
function pixels(ctx) {
  const { width: w, height: h } = ctx.canvas;
  const src = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(src.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) data.set(src.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
  return { data, width: w, height: h };
}
