// Участники-человечки для оверлея: невидимая сетка, в каждой ячейке свой участник.
// Персонажи — KayKit Adventurers 2.0 и Skeletons 1.1 (CC0), все на скелете Rig_Medium; анимации —
// настоящие клипы KayKit (Waving, Cheering, Idle_A, Death_A), переведённые из набора WCGEngine
// (tools/wcr2glb.py). Броня и одежда перекрашиваются в материал участника с колеса (металл — с бликом),
// кожа, волосы, глаза и кости остаются своими. Кружок под ногами — того же цвета.
//
// Мир: Y вверх, персонаж смотрит в +Z, рост ≈ 1.75. Ряды сетки стоят «полками» один над другим,
// как трибуна, поэтому никто никого не загораживает. Камера ортографическая и почти фронтальная:
// все ячейки одного размера, ни один ряд не мельче другого.

import * as THREE from './vendor/three.module.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import * as SkeletonUtils from './vendor/SkeletonUtils.js';
import { MATERIALS } from './materials.js?v=9';

const CHARACTERS = [
  'Knight',
  'Barbarian',
  'Mage',
  'Ranger',
  'Rogue',
  'Rogue_Hooded',
  'Skeleton_Warrior',
  'Skeleton_Mage',
  'Skeleton_Rogue',
  'Skeleton_Minion',
];
const modelUrl = (name) => new URL(`../assets/models/characters/${name}.glb`, import.meta.url).href;
const ANIMS_URL = new URL('../assets/models/kaykit_anims.glb', import.meta.url).href;
const MAX_CELLS = 24;
const CELL_W = 1.7;
const ROW_H = 2.45; // высота полки: рост, поднятые руки и подпись
const HEIGHT = 2.0; // с запасом на поднятые руки
const FADE_AFTER = 1.6; // секунд лежит выбывший, прежде чем исчезнуть
const FADE_TIME = 0.6;

export class Crowd {
  constructor(canvas, labelsEl) {
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    this.people = new Map(); // id → персонаж
    this.cells = []; // id участников по ячейкам
    this.extra = 0;
    this.ready = false;
    this.last = performance.now();

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);

    this.scene.add(new THREE.HemisphereLight(0xfff2dc, 0x1a2a1f, 0.6));
    const key = new THREE.DirectionalLight(0xfff0d8, 2.2);
    key.position.set(-4, 10, 8);
    this.scene.add(key);
    // Мягкое пятно тени под каждым — вместо карты теней: полки висят в воздухе, падать тени некуда.
    this.blobTexture = blobTexture();

    const loader = new GLTFLoader();
    this.recolored = new Map(); // «персонаж|материал» → перекрашенные материалы
    Promise.all([loader.loadAsync(ANIMS_URL), ...CHARACTERS.map((n) => loader.loadAsync(modelUrl(n)))]).then(([anims, ...models]) => {
      this.templates = models.map((m) => m.scene);
      this.clips = Object.fromEntries(anims.animations.map((a) => [a.name, a]));
      this.ready = true;
      this.sync();
    });

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    requestAnimationFrame((t) => this.loop(t));
  }

  /** list: [{ id, name, mat, status: 'in' | 'out' | 'win' }] — весь состав розыгрыша в порядке записи. */
  setPeople(list) {
    this.list = list;
    this.sync();
  }

  sync() {
    if (!this.ready || !this.list) return;
    const list = this.list;
    // Пока все помещаются — у каждого своя постоянная ячейка, выбывшие оставляют её пустой.
    // Если участников больше, чем ячеек, в сетке только те, кто ещё в игре, и победители.
    const visible = list.length <= MAX_CELLS ? list : list.filter((p) => p.status !== 'out');
    const shown = visible.slice(0, MAX_CELLS);
    this.extra = visible.length - shown.length;

    const ids = shown.map((p) => p.id);
    if (ids.join('|') !== this.cells.join('|')) {
      for (const id of [...this.people.keys()]) if (!ids.includes(id)) this.remove(id);
      this.cells = ids;
      this.layoutGrid();
    }
    for (const p of shown) {
      let c = this.people.get(p.id);
      if (!c) {
        c = this.spawn(p);
        this.people.set(p.id, c);
        this.placeInCell(c);
      }
      this.setStatus(c, p.status);
    }
    this.renderExtra();
  }

  layoutGrid() {
    const n = Math.max(1, this.cells.length);
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    // Сколько колонок, чтобы ячейки были крупнее всего при данной форме области.
    let best = 1;
    let bestSize = 0;
    for (let cols = 1; cols <= Math.min(n, 6); cols++) {
      const rows = Math.ceil(n / cols);
      const size = Math.min(aspect / (cols * CELL_W), 1 / (rows * ROW_H));
      if (size > bestSize) [best, bestSize] = [cols, size];
    }
    this.cols = best;
    this.rows = Math.ceil(n / best);
    for (const c of this.people.values()) this.placeInCell(c);
    this.fitCamera();
  }

  cellPos(i) {
    const col = i % this.cols;
    const row = Math.floor(i / this.cols);
    // Верхний ряд — первые участники; полка каждого следующего ряда ниже на ROW_H.
    return new THREE.Vector3((col - (this.cols - 1) / 2) * CELL_W, (this.rows - 1 - row) * ROW_H, 0);
  }

  placeInCell(c) {
    const i = this.cells.indexOf(c.id);
    if (i >= 0) c.root.position.copy(this.cellPos(i));
  }

  spawn(p) {
    // Персонаж выбирается по участнику (всегда один и тот же для того же ника), материал — его с колеса.
    const kind = hash(p.id) % CHARACTERS.length;
    const root = SkeletonUtils.clone(this.templates[kind]);
    const m = MATERIALS[p.mat % MATERIALS.length];
    const own = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false; // рамка скинированной сетки не следует за костями
      // Своя копия материала — чтобы выбывшего можно было растворить, не трогая остальных.
      o.material = this.recolor(o.material, kind, p.mat % MATERIALS.length).clone();
      own.push(o.material);
    });

    // Кружок под ногами — «место» участника в его цвете.
    const spot = new THREE.Mesh(
      new THREE.CircleGeometry(0.62, 40),
      new THREE.MeshStandardMaterial({ color: m.color, roughness: 0.5, metalness: m.metalness * 0.6, transparent: true, opacity: 0.85 }),
    );
    spot.material.userData.opacity = 0.85; // исходная прозрачность — к ней возвращаемся после «Переиграть»
    spot.rotation.x = -Math.PI / 2;
    spot.position.y = 0.01;
    root.add(spot);
    own.push(spot.material);
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 24),
      new THREE.MeshBasicMaterial({ map: this.blobTexture, transparent: true, depthWrite: false, opacity: 0.6 }),
    );
    blob.material.userData.opacity = 0.6;
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    root.add(blob);
    own.push(blob.material);

    const mixer = new THREE.AnimationMixer(root);
    const act = (name, loop = true) => {
      const a = mixer.clipAction(this.clips[name]);
      if (!loop) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      return a;
    };
    const actions = { wave: act('Waving'), idle: act('Idle_A'), cheer: act('Cheering'), death: act('Death_A', false) };
    // Каждый машет в своём ритме: разный сдвиг и чуть разная скорость.
    actions.wave.time = Math.random() * this.clips.Waving.duration;
    actions.wave.timeScale = 0.85 + Math.random() * 0.3;
    actions.wave.play();

    this.scene.add(root);
    const label = document.createElement('div');
    label.className = 'crowd-label';
    label.textContent = p.name;
    this.labelsEl.append(label);

    return { id: p.id, root, mixer, actions, current: actions.wave, label, materials: own, status: 'in', t: 0 };
  }

  /**
   * Перекраска палитры KayKit: у них одна текстура из плоских цветных плашек. Плашки брони и одежды
   * получают цвет материала участника (с сохранением светлоты — тени и детали на месте), а карта
   * свойств делает их металлом/лаком этого материала. Тёмные (глаза, контуры), очень светлые (кости,
   * блики) и тёплые телесные (кожа, светлые волосы) плашки не трогаем. Результат кешируется.
   */
  recolor(material, kind, matIndex) {
    if (!material.map) return material; // например, светящиеся глаза скелетов
    const key = `${kind}|${matIndex}|${material.name}`;
    if (this.recolored.has(key)) return this.recolored.get(key);

    const img = material.map.image;
    const w = img.width;
    const h = img.height;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const color = ctx.getImageData(0, 0, w, h);
    const orm = ctx.createImageData(w, h);
    const m = MATERIALS[matIndex];
    const target = new THREE.Color(m.color);
    const tl = Math.max(0.08, (target.r + target.g + target.b) / 3);
    const px = color.data;
    const out = orm.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255;
      const g = px[i + 1] / 255;
      const b = px[i + 2] / 255;
      const hi = Math.max(r, g, b);
      const lo = Math.min(r, g, b);
      const l = (hi + lo) / 2;
      const sat = hi === lo ? 0 : (hi - lo) / (1 - Math.abs(2 * l - 1));
      let hue = 0;
      if (hi !== lo) {
        if (hi === r) hue = ((g - b) / (hi - lo) + 6) % 6;
        else if (hi === g) hue = (b - r) / (hi - lo) + 2;
        else hue = (r - g) / (hi - lo) + 4;
        hue *= 60;
      }
      const skin = hue >= 8 && hue <= 50 && sat > 0.25 && l > 0.45;
      const darkHair = hue >= 8 && hue <= 45 && sat > 0.2 && l < 0.36; // брови, бороды, тёмные волосы
      const keep = l < 0.13 || l > 0.86 || skin || darkHair;
      out[i + 3] = 255;
      if (keep) {
        out[i + 1] = 150; // шероховатость ~0.6
        out[i + 2] = 0; // не металл
        continue;
      }
      // Светлота плашки переносится на цвет материала: светлая броня — светлый оттенок, тёмная — тёмный.
      const k = Math.min(2.2, (0.35 + l) / (0.35 + tl * 0.9));
      px[i] = Math.min(255, target.r * k * 255);
      px[i + 1] = Math.min(255, target.g * k * 255);
      px[i + 2] = Math.min(255, target.b * k * 255);
      out[i + 1] = Math.round(Math.max(0.2, m.roughness) * 255);
      out[i + 2] = Math.round(m.metalness * 255);
    }
    ctx.putImageData(color, 0, 0);
    const map = new THREE.CanvasTexture(cv);
    const ormCanvas = document.createElement('canvas');
    ormCanvas.width = w;
    ormCanvas.height = h;
    ormCanvas.getContext('2d').putImageData(orm, 0, 0);
    const ormMap = new THREE.CanvasTexture(ormCanvas);
    for (const t of [map, ormMap]) {
      t.flipY = false; // как у текстур glTF
      t.magFilter = THREE.NearestFilter; // палитра из плашек: без размытия на границах
    }
    map.colorSpace = THREE.SRGBColorSpace;
    const result = new THREE.MeshStandardMaterial({
      name: material.name,
      map,
      roughnessMap: ormMap,
      metalnessMap: ormMap,
      roughness: 1,
      metalness: 1,
      envMapIntensity: 1.2,
    });
    this.recolored.set(key, result);
    return result;
  }

  play(c, action, fade = 0.3) {
    if (c.current === action) return;
    action.reset().play();
    c.current.crossFadeTo(action, fade, false);
    c.current = action;
  }

  setStatus(c, status) {
    if (c.status === status) return;
    c.status = status;
    c.t = 0;
    c.label.classList.toggle('win', status === 'win');
    c.label.classList.toggle('out', status === 'out');
    if (status === 'win') this.play(c, c.actions.cheer);
    else if (status === 'out') this.play(c, c.actions.death, 0.15);
    else {
      // Вернулся в игру (например, «Переиграть»): снова виден и машет.
      for (const m of c.materials) m.opacity = m.userData.opacity ?? 1;
      c.root.visible = true;
      this.play(c, c.actions.wave);
    }
  }

  remove(id) {
    const c = this.people.get(id);
    if (!c) return;
    this.scene.remove(c.root);
    c.mixer.stopAllAction();
    for (const m of c.materials) m.dispose();
    c.label.remove();
    this.people.delete(id);
  }

  loop(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    for (const c of this.people.values()) {
      c.t += dt;
      c.mixer.update(dt);
      if (c.status === 'out') {
        // Выбывший падает, лежит и тает; ячейка остаётся пустой.
        const k = Math.min(1, Math.max(0, (c.t - FADE_AFTER) / FADE_TIME));
        for (const m of c.materials) {
          m.transparent = true;
          m.opacity = (m.userData.opacity ?? 1) * (1 - k);
        }
        c.root.visible = k < 1;
      }
    }
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    requestAnimationFrame((t) => this.loop(t));
  }

  placeLabels() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const v = new THREE.Vector3();
    for (const c of this.people.values()) {
      // Подпись — под кружком участника.
      v.set(c.root.position.x, c.root.position.y, c.root.position.z + 0.62).project(this.camera);
      c.label.style.transform = `translate(-50%, 0) translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }

  renderExtra() {
    let el = this.labelsEl.querySelector('.crowd-extra');
    if (!this.extra) return el?.remove();
    if (!el) {
      el = document.createElement('div');
      el.className = 'crowd-extra';
      this.labelsEl.append(el);
    }
    el.textContent = `и ещё ${this.extra}`;
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    if (this.cells.length) this.layoutGrid();
    else this.fitCamera();
  }

  /** Камера спереди-сверху; рамка подгоняется под всю сетку с полями под подписи. */
  fitCamera() {
    const cam = this.camera;
    // Почти спереди (~20° сверху): кружки под ногами видны, а полки не загораживают друг друга.
    cam.position.set(0, 5, 14);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const cols = this.cols || 1;
    const rows = this.rows || 1;
    const hw = (cols * CELL_W) / 2;
    const inv = cam.matrixWorldInverse;
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const x of [-hw, hw]) for (const z of [-0.6, 0.7]) for (const y of [0, (rows - 1) * ROW_H + HEIGHT]) {
      const p = new THREE.Vector3(x, y, z).applyMatrix4(inv);
      [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.y), Math.max(y1, p.y)];
    }
    y0 -= 0.45; // место под подписи у нижнего ряда
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    let halfW = (x1 - x0) / 2;
    let halfH = (y1 - y0) / 2;
    // Не крупнее, чем если бы в ряду было 3 ячейки: один участник не займёт всю колонку.
    halfW = Math.max(halfW, (3 * CELL_W) / 2);
    halfH = Math.max(halfH, (2.2 * ROW_H) / 2);
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    Object.assign(cam, { left: cx - halfW, right: cx + halfW, top: cy + halfH, bottom: cy - halfH });
    cam.updateProjectionMatrix();
  }
}

function blobTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.75)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

function hash(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}
