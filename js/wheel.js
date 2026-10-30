// 3D-рулетка на Three.js: модель колеса, снятая камерой под наклоном, со светом, тенями и отражениями.
// Используется и в пульте, и в оверлее.
//
// Размеры в долях радиуса (1 = внешний край обода), ось Y смотрит вверх.
// Угол a в мире — точка (cos a, ?, sin a). Ячейка i головы занимает углы [rotation + i*step, rotation + (i+1)*step].
// Угол -π/2 — дальняя от зрителя сторона колеса (верх кадра).

import * as THREE from './vendor/three.bundle.js?v=23';
import { RoomEnvironment } from './vendor/three.bundle.js?v=23';
import { drawHead } from './headart.js?v=23';
import { mark } from './perfhud.js?v=23';

const TAU = Math.PI * 2;
const MAX_FRETS = 256;
const COLLAPSE_MS = 650; // за столько выбывший сектор сжимается в ноль, а соседние занимают его место
const IDLE_FRAME_MS = 1000 / 30; // в покое (медленный дрейф, пульсация подсветки) хватает 30 кадров; прокрут — каждый кадр
const DRIFT = 0.12; // рад/с — в покое колесо медленно вращается, как настоящее
const R = {
  rimOuter: 1,
  trackOuter: 0.935,
  trackInner: 0.8,
  headOuter: 0.785,
  bandInner: 0.735,
  pocketInner: 0.665,
  hub: 0.15,
  texture: 0.8, // радиус, который покрывает текстура головы
};
// Радиусы головы для рисовалки ников (она работает и в фоновом потоке, поэтому — простые числа).
const HEAD_R = { hub: R.hub, pocketInner: R.pocketInner, bandInner: R.bandInner, headOuter: R.headOuter, texture: R.texture };
const H = { band: 0.04, coneOuter: 0.055, coneInner: 0.15 };
const BALL = 0.032;
const TRACK_R = 0.885;
const POCKET_R = 0.7;
const CAMERA_ELEVATION = (64 * Math.PI) / 180; // чем выше камера, тем меньше сплющены ники
const WINNER_ANGLE = Math.PI / 2; // ближняя к зрителю точка колеса — низ кадра

export class Wheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.entries = [];
    this.rotation = 0;
    this.highlight = null; // { index, kind: 'eliminate' | 'win' }
    this.ball = { mode: 'track', angle: -Math.PI / 2, r: TRACK_R, y: trackY(TRACK_R) + BALL };
    this.anim = null;
    this.active = true;
    this.raf = 0;
    this.last = performance.now();
    this.lastRender = 0;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);

    this.buildLights();
    this.buildBowl();
    this.buildHead();
    this.buildBall();
    this.paintHead();
    // Шейдеры компилируем сразу при загрузке, а не в момент первого прокрута.
    renderer.compile(this.scene, this.camera);

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.wake();
  }

  /** Колесо не видно (оверлей прозрачен) — не рисуем вообще, видеокарта свободна для стрима. */
  setActive(active) {
    this.active = active;
    if (active) this.wake();
  }

  wake() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  get spinning() {
    return !!this.anim;
  }

  /**
   * entries: [{ name, mat }] — mat это индекс в MATERIALS.
   * keepBall: шарик остаётся там, где лежал, — следующий прокрут поднимет его из ячейки.
   */
  setEntries(entries, { keepBall = false } = {}) {
    const angle = this.ballAngle();
    this.ball = keepBall
      ? { mode: 'free', angle, r: this.ball.r, y: this.ball.y }
      : { mode: 'track', angle, r: TRACK_R, y: trackY(TRACK_R) + BALL };
    // Тот же список (обычное «КРУТИТЬ» без выбывания) — голову не перерисовываем: каждая
    // перерисовка — это заливка текстур в видеокарту, а на старте прокрута это заметный рывок.
    const key = entriesKey(entries);
    if (key === this.entriesKey) {
      mark('колесо: тот же список');
      this.setHighlight(null);
      return;
    }
    const prev = this.entries;
    this.entriesKey = key;
    this.entries = entries;
    this.highlight = null;
    const back = this.buffers[1 - this.front];
    const removed = removedIndex(prev, entries);
    if (removed >= 0 && this.buffers[this.front].key === entriesKey(prev)) {
      // Выбыл один: его сектор плавно схлопывается, соседи занимают место; новая картинка
      // (обычно уже заготовлена) подменит старую в конце, когда они совпадут.
      this.hl.uHlIndex.value = -1;
      mark(`колесо: сжатие сектора, заготовка ${back.key === key ? 'есть' : 'НЕТ'}`);
      this.collapse = { t0: performance.now(), oldCount: prev.length, removed, key };
      this.hl.uWarpOn.value = 1;
      this.hl.uOldCount.value = prev.length;
      this.hl.uRemoved.value = removed;
      this.hl.uWarpT.value = 0;
      if (back.key !== key) this.paint(entries, false);
      this.wake();
      return;
    }
    if (back.key === key) {
      mark('колесо: новый список, заготовка есть');
      this.swap(); // заготовка уже в видеокарте — только переключаем текстуры
      return;
    }
    mark('колесо: новый список, рисуем');
    this.paint(entries, true);
  }

  setHighlight(highlight) {
    const same = JSON.stringify(highlight) === JSON.stringify(this.highlight);
    this.highlight = highlight;
    if (!same) this.updateHighlight();
  }

  ballAngle() {
    return this.ball.mode === 'pocket' ? this.rotation + this.ball.rel : this.ball.angle;
  }

  /**
   * Запускает шарик. Все случайные величины приходят снаружи, чтобы пульт и оверлей
   * показали одно и то же: index — ячейка, offset — место внутри ячейки (0..1),
   * wheelTurns/ballTurns — сколько оборотов делают колесо и шарик.
   * Колесо останавливается так, что выпавшая ячейка оказывается внизу, ближе всего к зрителю.
   */
  spin({ index, offset, wheelTurns, ballTurns, duration }) {
    const step = TAU / this.entries.length;
    const rot0 = this.rotation;
    const r0 = this.ball.r;
    // При одной ячейке ник написан посередине сектора — туда же кладём шарик.
    const relTarget = (index + (this.entries.length === 1 ? 0.5 : offset)) * step;
    const W = Math.floor(wheelTurns) * TAU + mod(WINNER_ANGLE - relTarget - rot0, TAU);
    // Шарик стартует ровно оттуда, где лежит сейчас.
    const S = ballTurns * TAU + mod(this.ballAngle() - rot0 - relTarget, TAU);
    const L = 0.8; // к этой доле времени шарик уже в ячейке

    const apply = (u) => {
      // Колесо тормозит с постоянным трением: скорость падает равномерно до нуля. Кубическая кривая
      // давала долгий «хвост», где колесо двигалось меньше пикселя за кадр и казалось, что оно дёргается.
      this.rotation = rot0 + W * easeOutQuad(u);
      const x = Math.min(1, u / L);
      // Шарик плавно догоняет свою ячейку и остаётся в ней — без покачивания туда-обратно: на медленном
      // колесе оно выглядело как мелкие рывки.
      const rel = relTarget + S * (1 - x) ** 2;
      let r;
      let hop = 0;
      if (u < 0.08) {
        const q = u / 0.08;
        r = r0 + (TRACK_R - r0) * easeOutCubic(q);
        hop = 0.04 * Math.sin(Math.PI * q);
      } else if (u < 0.5) r = TRACK_R;
      else if (u < L) {
        const p = (u - 0.5) / (L - 0.5);
        r = POCKET_R + (TRACK_R - POCKET_R) * (1 - p) ** 2 + 0.045 * Math.abs(Math.sin(p * Math.PI * 2.5)) * (1 - p);
        hop = 0.035 * Math.abs(Math.sin(p * Math.PI * 3.5)) * (1 - p);
      } else r = POCKET_R;
      this.ball = { mode: 'free', angle: this.rotation + rel, r, y: surfaceY(r) + BALL + hop };
    };

    this.setHighlight(null);
    // Конец прокрута отсчитывает таймер: в свёрнутом окне или фоновой вкладке
    // requestAnimationFrame не вызывается, а розыгрыш всё равно должен идти дальше.
    return new Promise((resolve) => {
      const finish = () => {
        if (this.anim !== anim) return;
        apply(1);
        this.rotation = mod(this.rotation, TAU);
        this.ball = { mode: 'pocket', rel: relTarget, r: POCKET_R, y: BALL };
        this.anim = null;
        resolve();
      };
      const anim = { t0: performance.now(), duration, apply, finish };
      this.anim = anim;
      this.wake();
      setTimeout(finish, duration);
    });
  }

  // ---------- Кадр ----------

  loop(now) {
    this.raf = 0;
    if (!this.active && !this.anim) return; // скрыто — цикл стоит, пока его не разбудят
    this.raf = requestAnimationFrame((t) => this.loop(t));
    if (!this.anim && now - this.lastRender < IDLE_FRAME_MS - 2) return;
    this.lastRender = now;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.anim) {
      const u = Math.min(1, (now - this.anim.t0) / this.anim.duration);
      if (u >= 1) this.anim.finish();
      else this.anim.apply(u);
    } else if (!this.highlight) {
      // После прокрута колесо стоит, победитель внизу; в остальное время медленно вращается.
      this.rotation = mod(this.rotation + DRIFT * dt, TAU);
    }

    this.head.rotation.y = -this.rotation;
    const a = this.ballAngle();
    this.ballMesh.position.set(Math.cos(a) * this.ball.r, this.ball.y, Math.sin(a) * this.ball.r);
    this.hl.uHlStrength.value = this.highlight ? 0.55 + 0.45 * Math.sin(now / 260) : 0;
    if (this.collapse) this.stepCollapse(now);

    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    cam.aspect = w / h;
    const dist = 3.6;
    cam.position.set(0, Math.sin(CAMERA_ELEVATION) * dist, Math.cos(CAMERA_ELEVATION) * dist);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    // Вписываем колесо в кадр: проецируем его габариты и растягиваем/сдвигаем картинку так,
    // чтобы колесо заняло кадр целиком с небольшим полем при любом соотношении сторон.
    const pts = [new THREE.Vector3(0, 0.3, 0)];
    for (let i = 0; i < 64; i++) {
      const a = (i * TAU) / 64;
      for (const y of [-0.1, 0.125]) pts.push(new THREE.Vector3(Math.cos(a) * 1.015, y, Math.sin(a) * 1.015));
    }
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of pts) {
      p.project(cam);
      [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.y), Math.max(y1, p.y)];
    }
    const k = 0.96 * Math.min(2 / (x1 - x0), 2 / (y1 - y0));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const fit = new THREE.Matrix4().set(k, 0, 0, -k * cx, 0, k, 0, -k * cy, 0, 0, 1, 0, 0, 0, 0, 1);
    cam.projectionMatrix.premultiply(fit);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  // ---------- Сцена ----------

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xfff2dc, 0x1a1420, 0.35));

    const key = new THREE.DirectionalLight(0xfff0d8, 2.4);
    key.position.set(-1.8, 4, 1.6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -1.3, right: 1.3, top: 1.3, bottom: -1.3, near: 1, far: 9 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.01;
    key.shadow.radius = 3;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xffcf8a, 0.9);
    rim.position.set(2.5, 2, -2.5);
    this.scene.add(rim);

    // Мягкая тень колеса на прозрачный фон.
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.35 }));
    catcher.rotation.x = -Math.PI / 2;
    catcher.position.y = -0.1;
    catcher.receiveShadow = true;
    this.scene.add(catcher);
  }

  buildBowl() {
    const wood = new THREE.MeshStandardMaterial({
      map: woodTexture(this.maxAniso),
      roughness: 0.32,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const rim = lathe(
      [
        [0.935, 0.1],
        [0.95, 0.116],
        [0.985, 0.12],
        [1.0, 0.108],
        [1.012, 0.04],
        [1.0, -0.08],
        [0.96, -0.095],
        [0.6, -0.095],
      ],
      wood,
    );
    this.scene.add(rim);

    // Чаша, по которой бежит шарик: тёмный лак.
    const lacquer = new THREE.MeshStandardMaterial({ color: 0x141418, roughness: 0.22, metalness: 0.15, side: THREE.DoubleSide });
    const track = lathe(
      [
        [0.78, -0.012],
        [0.8, 0.005],
        [0.84, 0.022],
        [0.88, 0.046],
        [0.91, 0.07],
        [0.935, 0.1],
      ],
      lacquer,
    );
    this.scene.add(track);

    this.gold = new THREE.MeshStandardMaterial({ color: 0xd8aa45, metalness: 1, roughness: 0.22 });
    this.scene.add(torus(0.94, 0.108, 0.007, this.gold));
    this.scene.add(torus(1.004, 0.106, 0.008, this.gold));

    // Ромбы-отбойники на чаше: восемь одинаковых, вытянуты к центру и лежат на уклоне чаши.
    const diamond = new THREE.OctahedronGeometry(1, 0);
    const r = 0.858;
    const tilt = Math.atan2(trackY(r + 0.01) - trackY(r - 0.01), 0.02);
    for (let k = 0; k < 8; k++) {
      const a = (k * TAU) / 8 + TAU / 16;
      const m = new THREE.Mesh(diamond, this.gold);
      m.position.set(Math.cos(a) * r, trackY(r) + 0.006, Math.sin(a) * r);
      m.rotation.set(0, -a, tilt, 'YZX');
      m.scale.set(0.036, 0.009, 0.013);
      m.castShadow = true;
      this.scene.add(m);
    }
  }

  buildHead() {
    this.head = new THREE.Group();
    this.scene.add(this.head);

    // Два комплекта текстур головы (ники + свойства материалов). Ники с обводкой рисуются в фоновом
    // потоке (js/headart.worker.js) — на 2048×2048 это 100+ мс, в основном потоке это был рывок колеса.
    // Готовая картинка кладётся в запасной комплект и заливается в видеокарту, пока колесо стоит;
    // на «КРУТИТЬ» колесо просто переключается на неё.
    const makeBuffer = () => {
      const tex = new THREE.Texture();
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.maxAniso;
      const orm = new THREE.Texture();
      orm.colorSpace = THREE.NoColorSpace;
      return { tex, orm, key: null, count: 0 };
    };
    this.buffers = [makeBuffer(), makeBuffer()];
    this.front = 0;
    this.jobs = new Map();
    this.jobId = 0;
    try {
      this.worker = new Worker(new URL('./headart.worker.js?v=23', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onPainted(e.data);
      this.worker.onerror = () => (this.worker = null); // нет OffscreenCanvas — рисуем в основном потоке
    } catch {
      this.worker = null;
    }

    // Подсветка выпавшего сектора считается в шейдере по номеру сектора — без рисования и заливки текстур.
    this.hl = {
      uHlIndex: { value: -1 },
      uHlCount: { value: 1 },
      uHlColor: { value: new THREE.Color() },
      uHlStrength: { value: 0 },
      // Сжатие выбывшего сектора: старая картинка растягивается по углу, пока сектор uRemoved
      // из uOldCount не схлопнется (uWarpT 0 → 1). Тогда она совпадает с новой и подменяется ею.
      uWarpOn: { value: 0 },
      uOldCount: { value: 2 },
      uRemoved: { value: 0 },
      uWarpT: { value: 0 },
    };
    this.headMaterial = new THREE.MeshStandardMaterial({
      map: this.buffers[0].tex,
      roughness: 1,
      metalness: 1,
      roughnessMap: this.buffers[0].orm,
      metalnessMap: this.buffers[0].orm,
      side: THREE.DoubleSide,
    });
    const glsl = (x) => x.toFixed(4);
    this.headMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.hl);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'uniform float uHlIndex;',
            'uniform float uHlCount;',
            'uniform vec3 uHlColor;',
            'uniform float uHlStrength;',
            'uniform float uWarpOn;',
            'uniform float uOldCount;',
            'uniform float uRemoved;',
            'uniform float uWarpT;',
            // Точка головы при раскладке «в процессе сжатия» → где она была на старой картинке.
            'vec2 headWarp(vec2 uv) {',
            '  if (uWarpOn < 0.5) return uv;',
            `  vec2 p = vec2(uv.x - 0.5, 0.5 - uv.y) * ${glsl(2 * R.texture)};`,
            '  float r = length(p);',
            `  if (r < ${glsl(R.hub)}) return uv;`,
            '  float a = mod(atan(p.y, p.x), 6.2831853);',
            '  float so = 6.2831853 / uOldCount;',
            '  float sn = 6.2831853 / max(uOldCount - 1.0, 1.0);',
            '  float w = so + uWarpT * (sn - so);',
            '  float wr = so * (1.0 - uWarpT);',
            '  float before = uRemoved * w;',
            '  float j; float f;',
            '  if (a < before) { j = floor(a / w); f = a / w - j; }',
            '  else if (a < before + wr) { j = uRemoved; f = (a - before) / max(wr, 1e-5); }',
            '  else { float q = (a - before - wr) / w; j = uRemoved + 1.0 + floor(q); f = fract(q); }',
            '  float ao = (j + f) * so;',
            '  vec2 po = r * vec2(cos(ao), sin(ao));',
            `  return vec2(0.5 + po.x / ${glsl(2 * R.texture)}, 0.5 - po.y / ${glsl(2 * R.texture)});`,
            '}',
          ].join('\n'),
        )
        // Все выборки из карт головы — по растянутым координатам.
        .replace('void main() {', 'void main() {\nvec2 hUv = headWarp(vMapUv);\n#define vMapUv hUv\n#define vRoughnessMapUv hUv\n#define vMetalnessMapUv hUv')
        .replace(
          '#include <emissivemap_fragment>',
          [
            '#include <emissivemap_fragment>',
            'if (uHlIndex >= 0.0) {',
            // UV головы — проекция сверху: из неё восстанавливаем точку (x, z) и её угол.
            `  vec2 p = vec2(vMapUv.x - 0.5, 0.5 - vMapUv.y) * ${glsl(2 * R.texture)};`,
            '  float r = length(p);',
            '  float a = mod(atan(p.y, p.x), 6.2831853);',
            '  float idx = floor(a / (6.2831853 / uHlCount));',
            `  if (r > ${glsl(R.hub + 0.01)} && r < ${glsl(R.headOuter + 0.02)} && abs(idx - uHlIndex) < 0.5) {`,
            '    totalEmissiveRadiance += uHlColor * uHlStrength;',
            '  }',
            '}',
          ].join('\n'),
        );
    };

    // Профиль головы: внешняя стенка, поясок с номерами, ячейки, конус с именами, ступица.
    const geo = new THREE.LatheGeometry(
      [
        [0.0, H.coneInner + 0.006],
        [R.hub, H.coneInner + 0.006],
        [R.hub + 0.004, H.coneInner],
        [0.3, 0.115],
        [0.5, 0.08],
        [R.pocketInner, H.coneOuter],
        [R.pocketInner, 0.0],
        [R.bandInner, 0.0],
        [R.bandInner, H.band],
        [R.headOuter, H.band],
        [R.headOuter, -0.07],
      ].map(([x, y]) => new THREE.Vector2(x, y)),
      256,
    );
    planarUV(geo);
    const headMesh = new THREE.Mesh(geo, this.headMaterial);
    headMesh.castShadow = true;
    headMesh.receiveShadow = true;
    this.head.add(headMesh);

    this.head.add(torus(R.headOuter, H.band, 0.006, this.gold));
    this.head.add(torus(R.pocketInner, H.coneOuter, 0.005, this.gold));
    this.head.add(torus(R.hub, H.coneInner + 0.006, 0.006, this.gold));

    this.buildTurret();
  }

  buildTurret() {
    const t = new THREE.Group();
    // Точки снизу вверх: так грани смотрят наружу, и непрозрачный верх не просвечивает.
    const body = lathe(
      [
        [0.078, 0.121],
        [0.07, 0.14],
        [0.045, 0.158],
        [0.022, 0.175],
        [0.018, 0.195],
        [0.03, 0.215],
        [0.038, 0.238],
        [0.03, 0.258],
        [0.016, 0.271],
        [0.0, 0.275],
      ],
      this.gold,
    );
    t.position.y = H.coneInner - 0.115; // модель крестовины сделана под ступицу на высоте 0.115
    t.add(body);
    const arm = new THREE.CylinderGeometry(0.0085, 0.006, 0.1, 16);
    const knob = new THREE.SphereGeometry(0.017, 24, 16);
    for (let k = 0; k < 4; k++) {
      const a = (k * TAU) / 4 + TAU / 8;
      const g = new THREE.Group();
      g.rotation.y = -a;
      const bar = new THREE.Mesh(arm, this.gold);
      bar.rotation.z = Math.PI / 2;
      bar.position.set(0.065, 0.19, 0);
      const ball = new THREE.Mesh(knob, this.gold);
      ball.position.set(0.118, 0.19, 0);
      g.add(bar, ball);
      t.add(g);
    }
    t.traverse((o) => o.isMesh && (o.castShadow = true));
    this.head.add(t);
  }

  /** Шарик: полированная сталь с лаком — отражает окружение и даёт резкий блик от света; тонкий тёмный контур. */
  buildBall() {
    this.ballMesh = new THREE.Group();

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL, 64, 48),
      new THREE.MeshPhysicalMaterial({
        color: 0xeef1f5,
        metalness: 1,
        roughness: 0.05,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        envMap: this.chromeEnvironment(),
        envMapIntensity: 1.25,
      }),
    );
    ball.castShadow = true;

    // Контур — «вывернутая» сфера чуть больше шарика. Обычная геометрия с проверкой глубины,
    // поэтому, как и сам шарик, прячется за бортиками и не просвечивает сквозь колесо.
    const outline = new THREE.Mesh(
      new THREE.SphereGeometry(BALL * 1.05, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x0c0c0e, side: THREE.BackSide }),
    );

    this.ballMesh.add(outline, ball);
    this.scene.add(this.ballMesh);
  }

  /**
   * Окружение только для шарика, как в студийной съёмке хрома: светлое небо, тёмная линия горизонта,
   * тёплое отражение колеса снизу и яркое «солнце» сверху слева, со стороны основного света. Отсюда объём и блик.
   */
  chromeEnvironment() {
    const W = 1024;
    const H = 512;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    // Чередование светлых и тёмных полос даёт хрому объём: без контраста металл выглядит серым кругом.
    sky.addColorStop(0, '#7d8792');
    sky.addColorStop(0.16, '#eef2f6');
    sky.addColorStop(0.3, '#69717c');
    sky.addColorStop(0.42, '#262a31');
    sky.addColorStop(0.5, '#0b0c0f');
    sky.addColorStop(0.58, '#4a3518');
    sky.addColorStop(0.75, '#a47833');
    sky.addColorStop(1, '#20160b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Точка на развёртке для направления dir (так же, как three.js читает equirect-текстуру).
    const spot = (x, y, z, radius, alpha) => {
      const len = Math.hypot(x, y, z);
      const u = Math.atan2(z / len, x / len) / TAU + 0.5;
      const v = Math.asin(y / len) / Math.PI + 0.5;
      const px = u * W;
      const py = (1 - v) * H;
      const g = ctx.createRadialGradient(px, py, 0, px, py, radius);
      g.addColorStop(0, `rgba(255,255,255,${alpha})`);
      g.addColorStop(0.35, `rgba(255,250,235,${alpha * 0.8})`);
      g.addColorStop(1, 'rgba(255,250,235,0)');
      ctx.fillStyle = g;
      ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
    };
    spot(-0.45, 0.8, 0.4, 42, 1); // главный блик — со стороны ключевого света и камеры
    spot(-0.45, 0.8, 0.4, 16, 1);
    spot(0.7, 0.35, -0.6, 90, 0.45); // мягкий контровой

    const tex = new THREE.CanvasTexture(cv);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    pmrem.dispose();
    return env;
  }

  /**
   * Заказывает рисунок головы для списка entries в запасной комплект; swap — сразу переключиться
   * на него, когда будет готов. Без фонового потока рисуем здесь же (медленнее, но работает везде).
   */
  paint(entries, swap) {
    const key = entriesKey(entries);
    if (this.worker) {
      const id = ++this.jobId;
      this.jobs.set(id, { key, count: entries.length, swap });
      this.worker.postMessage({ id, entries, R: HEAD_R });
      return;
    }
    const color = document.createElement('canvas');
    color.width = color.height = 2048;
    const orm = document.createElement('canvas');
    orm.width = orm.height = 512;
    drawHead(color.getContext('2d'), orm.getContext('2d'), entries, HEAD_R);
    this.fill({ key, count: entries.length, swap }, color, orm, true);
  }

  onPainted({ id, color, orm }) {
    const job = this.jobs.get(id);
    this.jobs.delete(id);
    if (job) this.fill(job, color, orm, false);
  }

  /** Кладёт готовые картинки в запасной комплект и заливает их в видеокарту. */
  fill(job, color, orm, flipY) {
    mark('колесо: картинка готова, заливка');
    const back = this.buffers[1 - this.front];
    for (const [tex, image] of [
      [back.tex, color],
      [back.orm, orm],
    ]) {
      if (tex.image && tex.image.close) tex.image.close(); // старую картинку-ImageBitmap освобождаем
      tex.image = image;
      tex.flipY = flipY; // картинки из фонового потока уже перевёрнуты там
      tex.needsUpdate = true;
      this.renderer.initTexture(tex);
    }
    back.key = job.key;
    back.count = job.count;
    // Переключаемся, только если этот список всё ещё нужен (за время рисования могли заказать другой).
    if (job.swap && job.key === this.entriesKey && !this.collapse) this.swap();
  }

  /** Переключение на запасной комплект: только смена ссылок на текстуры, без рисования и заливки. */
  swap() {
    mark('колесо: переключение текстур');
    this.collapse = null;
    this.hl.uWarpOn.value = 0;
    this.front = 1 - this.front;
    const buf = this.buffers[this.front];
    this.headMaterial.map = buf.tex;
    this.headMaterial.roughnessMap = buf.orm;
    this.headMaterial.metalnessMap = buf.orm;
    this.buildFrets(buf.count || 24);
    this.updateHighlight();
  }

  /** Перерисовывает голову под текущий список. */
  paintHead() {
    this.paint(this.entries, true);
  }

  /**
   * Заготовка следующего списка (после выбывания): рисуем в запасной комплект и заливаем в
   * видеокарту, пока колесо стоит с результатом. Следующий setEntries с этим списком — мгновенный.
   */
  prepare(entries) {
    const key = entriesKey(entries);
    const back = this.buffers[1 - this.front];
    if (key === this.entriesKey || key === back.key || !entries.length) return;
    mark('колесо: заготовка следующего списка');
    this.paint(entries, false);
  }

  /**
   * Золотые перегородки между ячейками — настоящие, объёмные. Сетка создаётся один раз на MAX_FRETS
   * штук, дальше меняются только их число и расстановка: пересоздание выкидывало шейдер из видеокарты
   * и компилировало его заново — это и был фриз в начале каждого прокрута.
   */
  buildFrets(n) {
    n = Math.min(n, MAX_FRETS);
    this.placeFrets(Array.from({ length: n }, (_, i) => (i * TAU) / n), n);
  }

  /** Шаг сжатия выбывшего сектора: границы и перегородки едут, в конце — подмена картинки. */
  stepCollapse(now) {
    const c = this.collapse;
    const u = Math.min(1, (now - c.t0) / COLLAPSE_MS);
    const t = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; // плавно разогнаться и затормозить
    this.hl.uWarpT.value = t;
    const so = TAU / c.oldCount;
    const sn = TAU / (c.oldCount - 1);
    const w = so + t * (sn - so);
    const wr = so * (1 - t);
    const angles = [];
    let a = 0;
    for (let i = 0; i < c.oldCount; i++) {
      angles.push(a);
      a += i === c.removed ? wr : w;
    }
    this.placeFrets(angles, c.oldCount);
    // Сжатие закончилось — подменяем на новую картинку, как только она готова (обычно уже).
    if (u >= 1 && this.buffers[1 - this.front].key === c.key) this.swap();
  }

  placeFrets(angles, countForThickness) {
    if (!this.frets) {
      const geo = new THREE.BoxGeometry(R.headOuter - R.pocketInner, 0.06, 1); // толщина задаётся масштабом
      this.frets = new THREE.InstancedMesh(geo, this.gold, MAX_FRETS);
      this.frets.castShadow = true;
      this.frets.receiveShadow = true;
      this.head.add(this.frets);
    }
    const n = Math.min(angles.length, MAX_FRETS);
    const thickness = countForThickness > 150 ? 0.003 : countForThickness > 60 ? 0.006 : 0.011;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const scale = new THREE.Vector3(1, 1, thickness);
    const mid = (R.pocketInner + R.headOuter) / 2;
    for (let i = 0; i < n; i++) {
      const a = angles[i];
      q.setFromAxisAngle(up, -a);
      m.compose(new THREE.Vector3(Math.cos(a) * mid, 0.03, Math.sin(a) * mid), q, scale);
      this.frets.setMatrixAt(i, m);
    }
    this.frets.count = n;
    this.frets.instanceMatrix.needsUpdate = true;
  }

  /** Подсветка выпавшего сектора — только числа для шейдера, без рисования. */
  updateHighlight() {
    const h = this.highlight;
    const count = this.buffers[this.front].count || this.entries.length;
    // Номер сектора относится к списку на колесе; пока колесо показывает старый список — не подсвечиваем.
    this.hl.uHlIndex.value = h && count === this.entries.length ? h.index : -1;
    this.hl.uHlCount.value = Math.max(1, count);
    this.hl.uHlColor.value.set(h && h.kind === 'win' ? '#b8860b' : '#a01010');
  }

}

// ---------- Геометрия ----------

function lathe(points, material) {
  const geo = new THREE.LatheGeometry(
    points.map(([x, y]) => new THREE.Vector2(x, y)),
    256,
  );
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function torus(radius, y, tube, material) {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 12, 256), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = y;
  mesh.castShadow = true;
  return mesh;
}

/** Текстура головы нарисована «сверху» — проецируем её на модель по плоскости XZ. */
function planarUV(geo) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, 0.5 + pos.getX(i) / (2 * R.texture), 0.5 - pos.getZ(i) / (2 * R.texture));
  }
  uv.needsUpdate = true;
}

/** Высота поверхности под шариком на радиусе r. */
function surfaceY(r) {
  if (r >= 0.8) return trackY(r);
  const band = H.band * smoothstep(R.bandInner - 0.012, R.bandInner + 0.008, r);
  return band - (band - 0.005) * smoothstep(R.headOuter, 0.8, r);
}

function trackY(r) {
  return 0.005 + ((r - 0.8) / (0.935 - 0.8)) * 0.095;
}

// ---------- Текстуры ----------

function canvasTexture(canvas, aniso) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

function woodTexture(aniso) {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, cv.height);
  g.addColorStop(0, '#5a2a0e');
  g.addColorStop(0.5, '#8a4a1f');
  g.addColorStop(1, '#4a2009');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cv.width, cv.height);
  const rnd = seeded(11);
  for (let i = 0; i < 90; i++) {
    const y = rnd() * cv.height;
    const amp = 2 + rnd() * 5;
    const freq = 1 + rnd() * 4;
    ctx.beginPath();
    for (let x = 0; x <= cv.width; x += 16) {
      const yy = y + Math.sin((x / cv.width) * TAU * freq + i) * amp;
      x ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
    }
    ctx.lineWidth = 0.6 + rnd() * 1.8;
    ctx.strokeStyle = rnd() > 0.5 ? `rgba(40,15,3,${0.15 + rnd() * 0.3})` : `rgba(190,110,55,${0.08 + rnd() * 0.15})`;
    ctx.stroke();
  }
  const t = canvasTexture(cv, aniso);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(6, 1);
  return t;
}





/** Индекс единственного выбывшего элемента (остальные — те же и в том же порядке), иначе −1. */
function removedIndex(prev, next) {
  if (!prev || prev.length !== next.length + 1 || prev.length < 2) return -1;
  let i = 0;
  while (i < next.length && prev[i].name === next[i].name && prev[i].mat === next[i].mat) i++;
  for (let j = i; j < next.length; j++) {
    if (prev[j + 1].name !== next[j].name || prev[j + 1].mat !== next[j].mat) return -1;
  }
  return i;
}

function entriesKey(entries) {
  return entries.map((e) => `${e.mat}:${e.name}`).join('|');
}


function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
const mod = (a, m) => ((a % m) + m) % m;
