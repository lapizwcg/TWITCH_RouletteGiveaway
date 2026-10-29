// 3D-рулетка на Three.js: модель колеса, снятая камерой под наклоном, со светом, тенями и отражениями.
// Используется и в пульте, и в оверлее.
//
// Размеры в долях радиуса (1 = внешний край обода), ось Y смотрит вверх.
// Угол a в мире — точка (cos a, ?, sin a). Ячейка i головы занимает углы [rotation + i*step, rotation + (i+1)*step].
// Угол -π/2 — дальняя от зрителя сторона колеса (верх кадра).

import * as THREE from './vendor/three.module.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { MATERIALS } from './materials.js?v=10';

const TAU = Math.PI * 2;
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
const H = { band: 0.04, coneOuter: 0.055, coneInner: 0.15 };
const BALL = 0.032;
const TRACK_R = 0.885;
const POCKET_R = 0.7;
const CAMERA_ELEVATION = (64 * Math.PI) / 180; // чем выше камера, тем меньше сплющены ники
const WINNER_ANGLE = Math.PI / 2; // ближняя к зрителю точка колеса — низ кадра
const WOOD_ORM = 'rgb(0, 90, 13)'; // шероховатость 0.35, металл 0.05 для деревянной ступицы

export class Wheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.entries = [];
    this.rotation = 0;
    this.highlight = null; // { index, kind: 'eliminate' | 'win' }
    this.ball = { mode: 'track', angle: -Math.PI / 2, r: TRACK_R, y: trackY(TRACK_R) + BALL };
    this.anim = null;
    this.last = performance.now();

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

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    requestAnimationFrame((t) => this.loop(t));
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
    this.entries = entries;
    this.highlight = null;
    this.paintHead();
  }

  setHighlight(highlight) {
    const same = JSON.stringify(highlight) === JSON.stringify(this.highlight);
    this.highlight = highlight;
    if (!same) this.paintHighlight();
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
      this.rotation = rot0 + W * easeOutCubic(u);
      const x = Math.min(1, u / L);
      let rel = relTarget + S * (1 - x) ** 2;
      if (u > L) {
        const p = (u - L) / (1 - L);
        rel += step * 0.2 * Math.sin(p * Math.PI * 3) * (1 - p) ** 2; // покачивание в ячейке
      }
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

    this.highlight = null;
    this.paintHighlight();
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
      setTimeout(finish, duration);
    });
  }

  // ---------- Кадр ----------

  loop(now) {
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
    this.headMaterial.emissiveIntensity = this.highlight ? 0.55 + 0.45 * Math.sin(now / 260) : 0;

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame((t) => this.loop(t));
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

    // Ромбы-отбойники на чаше.
    const diamond = new THREE.OctahedronGeometry(1, 0);
    for (let k = 0; k < 8; k++) {
      const a = (k * TAU) / 8 + TAU / 16;
      const radial = k % 2 === 0;
      const m = new THREE.Mesh(diamond, this.gold);
      const r = 0.858;
      m.position.set(Math.cos(a) * r, trackY(r) + 0.006, Math.sin(a) * r);
      m.rotation.y = -a;
      m.rotation.z = 0.6; // ложится на уклон чаши
      m.scale.set(radial ? 0.04 : 0.014, 0.01, radial ? 0.013 : 0.032);
      m.castShadow = true;
      this.scene.add(m);
    }
  }

  buildHead() {
    this.head = new THREE.Group();
    this.scene.add(this.head);

    this.headCanvas = document.createElement('canvas');
    this.headCanvas.width = this.headCanvas.height = 2048;
    this.headTexture = canvasTexture(this.headCanvas, this.maxAniso);
    this.glowCanvas = document.createElement('canvas');
    this.glowCanvas.width = this.glowCanvas.height = 1024;
    this.glowTexture = canvasTexture(this.glowCanvas, this.maxAniso);
    // Карта свойств материала по секторам: G — шероховатость, B — металл.
    this.ormCanvas = document.createElement('canvas');
    this.ormCanvas.width = this.ormCanvas.height = 1024;
    this.ormTexture = canvasTexture(this.ormCanvas, this.maxAniso);
    this.ormTexture.colorSpace = THREE.NoColorSpace;

    this.headMaterial = new THREE.MeshStandardMaterial({
      map: this.headTexture,
      roughness: 1,
      metalness: 1,
      roughnessMap: this.ormTexture,
      metalnessMap: this.ormTexture,
      emissive: 0xffffff,
      emissiveMap: this.glowTexture,
      emissiveIntensity: 0,
      side: THREE.DoubleSide,
    });

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
    const body = lathe(
      [
        [0.0, 0.275],
        [0.016, 0.271],
        [0.03, 0.258],
        [0.038, 0.238],
        [0.03, 0.215],
        [0.018, 0.195],
        [0.022, 0.175],
        [0.045, 0.158],
        [0.07, 0.14],
        [0.078, 0.121],
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

  /** Перерисовывает текстуру головы и перегородки под текущий список участников. */
  paintHead() {
    const real = this.entries.length;
    const n = real || 24;
    const step = TAU / n;
    const ctx = this.headCanvas.getContext('2d');
    const size = this.headCanvas.width;
    const k = size / 2 / R.texture; // пикселей на единицу радиуса
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#3a1a08';
    ctx.fillRect(0, 0, size, size);
    ctx.translate(size / 2, size / 2);
    ctx.scale(k, k);

    const orm = this.ormCanvas.getContext('2d');
    const ko = this.ormCanvas.width / 2 / R.texture;
    orm.setTransform(1, 0, 0, 1, 0, 0);
    orm.fillStyle = WOOD_ORM;
    orm.fillRect(0, 0, this.ormCanvas.width, this.ormCanvas.height);
    orm.translate(this.ormCanvas.width / 2, this.ormCanvas.height / 2);
    orm.scale(ko, ko);

    // Сектор участника — конус с ником, ячейка и поясок — целиком из его материала.
    const mats = [];
    for (let i = 0; i < n; i++) {
      const m = MATERIALS[(real ? this.entries[i].mat : i) % MATERIALS.length];
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
          const name = this.entries[i].name;
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

    this.headTexture.needsUpdate = true;
    this.ormTexture.needsUpdate = true;
    this.buildFrets(n);
    this.paintHighlight();
  }

  /** Золотые перегородки между ячейками — настоящие, объёмные. */
  buildFrets(n) {
    if (this.frets) {
      this.head.remove(this.frets);
      this.frets.geometry.dispose();
      this.frets.dispose();
    }
    const thickness = n > 150 ? 0.003 : n > 60 ? 0.006 : 0.011;
    const geo = new THREE.BoxGeometry(R.headOuter - R.pocketInner, 0.06, thickness);
    this.frets = new THREE.InstancedMesh(geo, this.gold, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const scale = new THREE.Vector3(1, 1, 1);
    const mid = (R.pocketInner + R.headOuter) / 2;
    for (let i = 0; i < n; i++) {
      const a = (i * TAU) / n;
      q.setFromAxisAngle(up, -a);
      m.compose(new THREE.Vector3(Math.cos(a) * mid, 0.03, Math.sin(a) * mid), q, scale);
      this.frets.setMatrixAt(i, m);
    }
    this.frets.castShadow = true;
    this.frets.receiveShadow = true;
    this.head.add(this.frets);
  }

  paintHighlight() {
    const ctx = this.glowCanvas.getContext('2d');
    const size = this.glowCanvas.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    if (this.highlight && this.entries.length) {
      const k = size / 2 / R.texture;
      ctx.translate(size / 2, size / 2);
      ctx.scale(k, k);
      const step = TAU / this.entries.length;
      const a0 = this.highlight.index * step;
      const color = this.highlight.kind === 'win' ? '#b8860b' : '#a01010';
      sector(ctx, R.hub + 0.01, R.headOuter + 0.02, a0, a0 + step);
      ctx.fillStyle = color;
      ctx.fill();
    }
    this.glowTexture.needsUpdate = true;
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

/** Делит ник на две строки: по «_», «-», «.» или пробелу ближе к середине, иначе ровно пополам. */
function splitName(name) {
  const mid = name.length / 2;
  let best = -1;
  for (let i = 1; i < name.length - 1; i++) {
    if ('_-. '.includes(name[i]) && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  if (best > 0 && Math.abs(best - mid) <= name.length * 0.3) {
    const sep = name[best];
    // Подчёркивание оставляем в конце первой строки, пробел убираем.
    return sep === ' ' ? [name.slice(0, best), name.slice(best + 1)] : [name.slice(0, best + 1), name.slice(best + 1)];
  }
  const cut = Math.ceil(mid);
  return [name.slice(0, cut), name.slice(cut)];
}

function luminance(hex) {
  const v = parseInt(hex.slice(1), 16);
  return (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
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
const mod = (a, m) => ((a % m) + m) % m;
