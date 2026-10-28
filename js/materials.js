// Материалы секторов рулетки. Каждый участник при записи получает следующий материал по кругу,
// поэтому соседи на колесе всегда разные. Список можно менять и дополнять как угодно.
// color — базовый цвет, roughness — шероховатость (0 зеркало … 1 матовый), metalness — металл (0 или 1).

export const MATERIALS = [
  { name: 'Золото', color: '#e3b04b', roughness: 0.22, metalness: 1 },
  { name: 'Рубиновый лак', color: '#b3121f', roughness: 0.14, metalness: 0.1 },
  { name: 'Сапфир', color: '#1f4fbf', roughness: 0.16, metalness: 0.2 },
  { name: 'Серебро', color: '#d6dbe1', roughness: 0.2, metalness: 1 },
  { name: 'Изумруд', color: '#0f8a4f', roughness: 0.16, metalness: 0.2 },
  { name: 'Оникс', color: '#18181d', roughness: 0.1, metalness: 0.1 },
  { name: 'Медь', color: '#c4703f', roughness: 0.28, metalness: 1 },
  { name: 'Аметист', color: '#7a3db8', roughness: 0.18, metalness: 0.2 },
  { name: 'Жемчуг', color: '#efe7da', roughness: 0.3, metalness: 0.05 },
  { name: 'Twitch-анодированный', color: '#9146ff', roughness: 0.26, metalness: 0.85 },
  { name: 'Янтарь', color: '#e08a1a', roughness: 0.18, metalness: 0.1 },
  { name: 'Графит', color: '#3a3d44', roughness: 0.38, metalness: 0.6 },
  { name: 'Бирюза', color: '#1fb5a8', roughness: 0.3, metalness: 0 },
  { name: 'Розовое золото', color: '#e3a08e', roughness: 0.24, metalness: 1 },
  { name: 'Синий хром', color: '#3d7bd9', roughness: 0.2, metalness: 0.9 },
  { name: 'Малахит', color: '#127a5a', roughness: 0.32, metalness: 0 },
];
