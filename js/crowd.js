// Участники-человечки для оверлея: невидимая сетка, в каждой ячейке свой участник.
// Персонажи — KayKit Adventurers 2.0 и Skeletons 1.1 (CC0), все на скелете Rig_Medium; анимации —
// настоящие клипы KayKit (Waving, Cheering, Idle_A, Death_A), переведённые из набора WCGEngine
// (tools/wcr2glb.py). Броня и одежда перекрашиваются в материал участника с колеса (металл — с бликом),
// кожа, волосы, глаза и кости остаются своими. Кружок под ногами — того же цвета.
//
// Мир: Y вверх, персонаж смотрит в +Z, рост ≈ 1.75. Ряды сетки стоят «полками» один над другим,
// как трибуна, поэтому никто никого не загораживает. Камера ортографическая и почти фронтальная:
// все ячейки одного размера, ни один ряд не мельче другого.

import * as THREE from './vendor/three.bundle.js?v=19';
import { RoomEnvironment, GLTFLoader, MeshoptDecoder, cloneSkinned } from './vendor/three.bundle.js?v=19';
import { MATERIALS } from './materials.js?v=19';
import { splitName } from './headart.js?v=19';
import { mark } from './perfhud.js?v=19';

// Текстура каждого персонажа KayKit — сетка 8×4 вертикальных градиентов («ячеек», по 128×256 пикселей):
// каждая ячейка — отдельный материал модели (кожа, сталь, ткань, ремни), а тени зашиты в градиент.
// Одна и та же ячейка у разных персонажей значит разное, поэтому для каждого явно перечислено,
// какие ячейки — броня и одежда (их красим в материал участника). Кожа, волосы, глаза, кости,
// кожаные ремни, пряжки и самоцветы остаются своими. Номера «столбец,строка» сняты по UV деталей
// моделей (какая деталь какие ячейки использует).
const CHARACTERS = [
  { name: 'Knight', paint: ['3,0', '7,0', '2,1', '4,0', '7,1', '0,1'] }, // латы, шлем, кольчуга, плащ
  { name: 'Barbarian', paint: ['7,0', '3,2', '7,1', '7,2', '3,0', '3,1', '2,1'] }, // мех, штаны, наручи
  { name: 'Mage', paint: ['0,1', '1,1', '7,1', '2,1', '3,2'] }, // мантия, шляпа, плащ, штаны
  { name: 'Ranger', paint: ['0,1', '7,0', '7,2', '3,2', '7,1', '5,0', '6,0'] }, // куртка, рубаха, плащ, штаны
  { name: 'Rogue', paint: ['0,1', '1,1', '3,2', '7,1'] }, // куртка, плащ, штаны
  { name: 'Rogue_Hooded', paint: ['0,1', '1,1', '3,2', '7,1'] }, // то же и капюшон с маской
  { name: 'Skeleton_Warrior', paint: ['3,0', '4,0', '2,2'] }, // латы, шлем, плащ
  { name: 'Skeleton_Mage', paint: ['2,2', '1,2', '3,2'] }, // мантия, шляпа
  { name: 'Skeleton_Rogue', paint: ['2,2', '3,0', '7,0'] }, // капюшон, плащ, наплечники
  { name: 'Skeleton_Minion', paint: ['5,0', '3,0'] }, // накидка, налокотники
];
const CELL_COLS = 8;
const CELL_ROWS = 4;
const modelUrl = (c) => new URL(`../assets/models/characters/${c.name}.glb`, import.meta.url).href;
const ANIMS_URL = new URL('../assets/models/kaykit_anims.glb', import.meta.url).href;
const MAX_CELLS = 24;
// Ячейка с запасом: модель (с головным убором до 2.66 — шляпа мага, шлем рыцаря ≈ 2.5; шире
// всех — рогатый шлем), под ней ник и зазор до соседей — чтобы ни модели, ни подписи не налезали.
// Полка: 2.66 (рост) + ~0.2 (наклон камеры) + ~0.55 (ник ряда выше) + ~0.3 зазор ≈ 3.8.
const CELL_W = 2.3;
const ROW_H = 3.8;
const HEIGHT = 2.7; // верх самой высокой модели с головным убором
// Сетка растёт ступенями: сначала на 4 места, затем 6, 8, 10… Масштаб меняется только на ступени,
// а не с каждым новым участником.
const BASE_CAPACITY = 4;
const CAPACITY_STEP = 2;
const FADE_AFTER = 1.6; // секунд лежит выбывший, прежде чем исчезнуть
const FADE_TIME = 0.6;
const FRAME_MS = 1000 / 30; // толпе хватает 30 кадров в секунду — на глаз не отличить, а видеокарте вдвое легче
const SPAWNS_PER_FRAME = 2; // новые участники появляются по паре за кадр — без подвисаний на больших розыгрышах
const PALETTE_SIZE = 256; // палитра — плоские градиенты, 256×256 хватает с запасом (оригинал 1024×1024)

export class Crowd {
  constructor(canvas, labelsEl) {
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    this.people = new Map(); // id → персонаж
    this.cells = []; // id участников по ячейкам
    this.extra = 0;
    this.ready = false;
    this.active = true;
    this.raf = 0;
    this.queue = []; // участники, ждущие появления
    this.last = performance.now();
    this.lastRender = 0;

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

    // Модели сжаты gltfpack (meshopt), поэтому загрузчику нужен распаковщик.
    this.loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    this.recolored = new Map(); // «персонаж|материал» → перекрашенные материалы
    // Персонажи грузятся по требованию: только те, что выпали участникам.
    this.templates = new Array(CHARACTERS.length);
    this.loading = new Map();
    this.loader.loadAsync(ANIMS_URL).then((anims) => {
      this.clips = Object.fromEntries(anims.animations.map((a) => [a.name, a]));
      this.ready = true;
      this.sync();
    });

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.wake();
  }

  /** Оверлей прозрачен (розыгрыша нет) — не рисуем вообще, видеокарта свободна для стрима. */
  setActive(active) {
    this.active = active;
    if (active) this.wake();
  }

  wake() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  /** Модель персонажа: из кеша или загрузка (один раз на вид персонажа). */
  template(kind) {
    if (this.templates[kind]) return this.templates[kind];
    if (!this.loading.has(kind)) {
      this.loading.set(
        kind,
        this.loader.loadAsync(modelUrl(CHARACTERS[kind])).then((m) => {
          mark(`толпа: загружен ${CHARACTERS[kind].name}`);
          this.templates[kind] = m.scene;
          this.sync();
        }),
      );
    }
    return null;
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
    this.wanted = new Map(shown.map((p) => [p.id, p]));
    for (const p of shown) {
      const c = this.people.get(p.id);
      if (c) this.setStatus(c, p.status);
      else if (!this.queue.includes(p.id)) this.queue.push(p.id); // появится в ближайших кадрах
    }
    this.renderExtra();
    this.wake();
  }

  /** Появление участников из очереди — понемногу за кадр. Пока модель грузится, ячейка пустая. */
  spawnQueued() {
    let budget = SPAWNS_PER_FRAME;
    for (let i = 0; i < this.queue.length && budget > 0; ) {
      const p = this.wanted?.get(this.queue[i]);
      if (!p || this.people.has(p.id)) {
        this.queue.splice(i, 1);
        continue;
      }
      const kind = hash(p.id) % CHARACTERS.length;
      if (!this.template(kind)) {
        i++;
        continue;
      }
      mark('толпа: появление участника');
      const c = this.spawn(p, kind);
      this.people.set(p.id, c);
      this.placeInCell(c);
      this.setStatus(c, p.status);
      this.fitLabel(c);
      this.queue.splice(i, 1);
      budget--;
    }
  }

  layoutGrid() {
    const n = Math.max(BASE_CAPACITY, Math.ceil(this.cells.length / CAPACITY_STEP) * CAPACITY_STEP);
    this.capacity = n;
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

  spawn(p, kind) {
    // Персонаж выбирается по участнику (всегда один и тот же для того же ника), материал — его с колеса.
    const root = cloneSkinned(this.templates[kind]);
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
    label.dataset.name = p.name;
    this.labelsEl.append(label);

    return { id: p.id, root, mixer, actions, current: actions.wave, label, materials: own, status: 'in', t: 0 };
  }

  /**
   * Перекраска палитры KayKit по ячейкам. Ячейки брони и одежды (рецепт персонажа) получают цвет
   * материала участника: градиент внутри ячейки сохраняется (тени и блики на месте), а разные ячейки
   * сохраняют свою светлоту относительно друг друга — тёмные пластины остаются темнее светлых.
   * Карта свойств делает покрашенное металлом или лаком этого материала. Результат кешируется.
   */
  recolor(material, kind, matIndex) {
    if (!material.map) return material; // светящиеся глаза скелетов — без текстуры
    const key = `${kind}|${matIndex}|${material.name}`;
    if (this.recolored.has(key)) return this.recolored.get(key);

    // Работаем с уменьшенной копией палитры: градиенты плоские, а пикселей в 16 раз меньше.
    const img = material.map.image;
    const w = PALETTE_SIZE;
    const h = PALETTE_SIZE;
    const cw = w / CELL_COLS;
    const ch = h / CELL_ROWS;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const color = ctx.getImageData(0, 0, w, h);
    const px = color.data;
    const orm = ctx.createImageData(w, h);
    const out = orm.data;
    const m = MATERIALS[matIndex];
    const target = new THREE.Color(m.color);
    const lum = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

    // Всё по умолчанию — не металл, шероховатость ~0.6.
    for (let i = 0; i < out.length; i += 4) {
      out[i + 1] = 150;
      out[i + 3] = 255;
    }

    const cells = CHARACTERS[kind].paint.map((s) => s.split(',').map(Number));
    // Средняя светлота каждой покрашенной ячейки — чтобы сохранить разницу между ними.
    const mean = cells.map(([cx, cy]) => {
      let sum = 0;
      let n = 0;
      for (let y = cy * ch; y < (cy + 1) * ch; y += 2) {
        for (let x = cx * cw; x < (cx + 1) * cw; x += 2) {
          sum += lum((y * w + x) * 4);
          n++;
        }
      }
      return Math.max(1, sum / n);
    });
    const top = Math.max(...mean);

    cells.forEach(([cx, cy], k) => {
      const shade = Math.min(1, Math.max(0.3, (mean[k] / top) ** 0.7)); // светлота ячейки среди прочих
      for (let y = cy * ch; y < (cy + 1) * ch; y++) {
        for (let x = cx * cw; x < (cx + 1) * cw; x++) {
          const i = (y * w + x) * 4;
          const rel = Math.min(1.6, lum(i) / mean[k]); // форма градиента внутри ячейки
          const f = shade * rel * 255;
          px[i] = Math.min(255, target.r * f);
          px[i + 1] = Math.min(255, target.g * f);
          px[i + 2] = Math.min(255, target.b * f);
          out[i + 1] = Math.round(Math.max(0.15, m.roughness) * 255);
          out[i + 2] = Math.round(m.metalness * 255);
        }
      }
    });

    ctx.putImageData(color, 0, 0);
    const map = new THREE.CanvasTexture(cv);
    const ormCanvas = document.createElement('canvas');
    ormCanvas.width = w;
    ormCanvas.height = h;
    ormCanvas.getContext('2d').putImageData(orm, 0, 0);
    const ormMap = new THREE.CanvasTexture(ormCanvas);
    const src = material.map;
    for (const t of [map, ormMap]) {
      t.flipY = false; // как у текстур glTF
      // gltfpack упаковывает UV и компенсирует это преобразованием текстуры (KHR_texture_transform) —
      // переносим его, иначе раскраска съедет.
      t.offset.copy(src.offset);
      t.repeat.copy(src.repeat);
      t.center.copy(src.center);
      t.rotation = src.rotation;
      t.channel = src.channel;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter; // ячейки не должны «подтекать» друг в друга на мип-уровнях
      t.generateMipmaps = false;
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
    this.raf = 0;
    if (!this.active) return; // оверлей скрыт — цикл стоит, пока его не разбудят
    this.raf = requestAnimationFrame((t) => this.loop(t));
    if (now - this.lastRender < FRAME_MS - 2) return;
    this.lastRender = now;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.spawnQueued();
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
    y0 -= 1.1; // место под подписи у нижнего ряда (до двух строк)
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    let halfW = (x1 - x0) / 2;
    let halfH = (y1 - y0) / 2;
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    Object.assign(cam, { left: cx - halfW, right: cx + halfW, top: cy + halfH, bottom: cy - halfH });
    cam.updateProjectionMatrix();

    // Подпись не шире своей ячейки, шрифт — от размера ячейки: при ступени вниз уменьшается вместе с сеткой.
    const cellPx = (CELL_W * this.canvas.clientWidth) / (2 * halfW);
    this.labelMax = cellPx * 0.94;
    this.labelFont = Math.min(24, Math.max(11, cellPx * 0.12));
    this.labelsEl.style.setProperty('--label-max', `${Math.round(this.labelMax)}px`);
    for (const c of this.people.values()) this.fitLabel(c);
  }

  /**
   * Ник целиком в своей ячейке и читаемый: сначала в одну строку обычным размером; если длинный —
   * чуть уменьшаем (не мельче 80%); если всё равно не влезает — переносим на две строки в
   * естественном месте («Neformalization_» / «Official», «xX» / «SlayerXx») и подбираем размер
   * под обе. Ник Twitch — максимум 25 символов, двух строк хватает всегда.
   */
  fitLabel(c) {
    if (!this.labelMax) return;
    const name = c.label.dataset.name;
    const base = this.labelFont;
    const room = this.labelMax - base * 1.1; // за вычетом полей подписи (по 0.55em слева и справа)
    const ctx = (this.measure ||= document.createElement('canvas').getContext('2d'));
    ctx.font = `700 ${base}px 'Segoe UI', Inter, system-ui, sans-serif`;
    const width = (t) => ctx.measureText(t).width;

    let lines = [name];
    let size = Math.min(base, (base * room) / width(name));
    if (size < base * 0.8) {
      const two = splitName(name);
      const twoSize = Math.min(base, (base * room) / Math.max(width(two[0]), width(two[1])));
      if (twoSize > size) [lines, size] = [two, twoSize];
    }
    c.label.textContent = lines.join('\n');
    c.label.style.fontSize = `${Math.max(9, size).toFixed(1)}px`;
    c.label.classList.toggle('two-lines', lines.length > 1);
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
