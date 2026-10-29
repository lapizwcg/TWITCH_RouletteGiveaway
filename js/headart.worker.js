// Фоновый поток: рисует голову колеса (ники с обводкой — самая дорогая часть, 100+ мс на 2048×2048)
// на OffscreenCanvas и отдаёт готовые картинки. Основной поток в это время спокойно крутит колесо.
import { drawHead } from './headart.js?v=16';

const color = new OffscreenCanvas(2048, 2048);
const orm = new OffscreenCanvas(512, 512);

self.onmessage = async ({ data: { id, entries, R } }) => {
  drawHead(color.getContext('2d'), orm.getContext('2d'), entries, R);
  // Переворачиваем по вертикали здесь: у картинки-ImageBitmap видеокарта не переворачивает сама,
  // а развёртка UV головы рассчитана на перевёрнутую (как у обычного холста).
  const [c, o] = await Promise.all([
    createImageBitmap(color, { imageOrientation: 'flipY' }),
    createImageBitmap(orm, { imageOrientation: 'flipY' }),
  ]);
  self.postMessage({ id, color: c, orm: o }, [c, o]);
};
