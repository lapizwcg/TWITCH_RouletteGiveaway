// Толпа чиби-участников для оверлея: манекен KayKit (CC0) на скелете Rig_Medium, окрашенный
// материалом участника с колеса. Машут рукой; выбывший подпрыгивает и исчезает; победитель
// прыгает с поднятыми руками. Подписи с никами — HTML поверх холста.
//
// Мир: Y вверх, персонаж смотрит в +Z, рост ≈ 2.3. Ряды уходят вглубь (−Z).

import * as THREE from './vendor/three.module.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import * as SkeletonUtils from './vendor/SkeletonUtils.js';
import { MATERIALS } from './materials.js?v=7';

const MODEL_URL = new URL('../assets/models/Mannequin_Medium.glb', import.meta.url).href;
const MAX_SHOWN = 12;
const SPACING_X = 1.35;
const SPACING_Z = 1.9;
const HEIGHT = 2.3;
const OUT_TIME = 0.9; // секунд на исчезновение выбывшего
const Z = new THREE.Vector3(0, 0, 1);
const X = new THREE.Vector3(1, 0, 0);

export class Crowd {
  constructor(canvas, labelsEl) {
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    this.people = new Map(); // id → персонаж
    this.wanted = [];
    this.extra = 0;
    this.template = null;
    this.last = performance.now();

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);

    this.scene.add(new THREE.HemisphereLight(0xfff2dc, 0x1a2a1f, 0.5));
    const key = new THREE.DirectionalLight(0xfff0d8, 2.2);
    key.position.set(-3, 8, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -6, right: 6, top: 8, bottom: -8, near: 1, far: 30 });
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.35 }));
    catcher.rotation.x = -Math.PI / 2;
    catcher.receiveShadow = true;
    this.scene.add(catcher);

    new GLTFLoader().load(MODEL_URL, (gltf) => {
      this.template = gltf.scene;
      this.sync();
    });

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    requestAnimationFrame((t) => this.loop(t));
  }

  /** list: [{ id, name, mat, status: 'in' | 'out' | 'win' }] — весь состав розыгрыша. */
  setPeople(list) {
    // На сцене: победители, затем те, кто ещё в игре. Выбывшие исчезают с анимацией.
    const shown = [...list.filter((p) => p.status === 'win'), ...list.filter((p) => p.status === 'in')];
    this.wanted = shown.slice(0, MAX_SHOWN);
    this.extra = Math.max(0, shown.length - MAX_SHOWN);
    this.statusById = new Map(list.map((p) => [p.id, p.status]));
    this.sync();
  }

  sync() {
    if (!this.template) return;
    const wantedIds = new Set(this.wanted.map((p) => p.id));
    for (const [id, c] of this.people) {
      if (!wantedIds.has(id) && c.state !== 'leaving') {
        // Выбыл (или просто больше не помещается) — уходит с анимацией.
        c.state = 'leaving';
        c.t = 0;
        c.label.classList.add('out');
      }
    }
    for (const p of this.wanted) {
      let c = this.people.get(p.id);
      if (!c || c.state === 'leaving') {
        if (c) this.remove(p.id);
        c = this.spawn(p);
        this.people.set(p.id, c);
      }
      c.win = this.statusById.get(p.id) === 'win';
      c.label.classList.toggle('win', c.win);
    }
    this.layout();
    this.renderExtra();
  }

  layout() {
    const n = this.wanted.length;
    // Колонка высокая и узкая: рядов больше, чем человек в ряду.
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const cols = Math.max(1, Math.min(n, 4, Math.round(Math.sqrt(n * aspect * 0.9))));
    const rows = Math.ceil(n / Math.max(1, cols));
    this.wanted.forEach((p, i) => {
      const c = this.people.get(p.id);
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols);
      const col = i % cols;
      // Ряды в шахматном порядке, чтобы задние не прятались за передними.
      const shift = row % 2 ? SPACING_X * 0.25 : 0;
      c.target.set((col - (inRow - 1) / 2) * SPACING_X + shift, 0, -(row - (rows - 1) / 2) * SPACING_Z);
      if (c.fresh) {
        c.root.position.copy(c.target);
        c.fresh = false;
      }
    });
    this.fitCamera(cols, rows);
  }

  spawn(p) {
    const root = SkeletonUtils.clone(this.template);
    const m = MATERIALS[p.mat % MATERIALS.length];
    const material = new THREE.MeshStandardMaterial({
      color: m.color,
      roughness: Math.max(0.25, m.roughness),
      metalness: m.metalness,
      envMapIntensity: 1.1,
    });
    root.traverse((o) => {
      if (o.isMesh) {
        o.material = material;
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false; // у скинированных сеток рамка не следует за костями
      }
    });
    root.updateMatrixWorld(true);

    const bones = {};
    root.traverse((o) => o.isBone && (bones[o.name] = o));
    // Запоминаем позу покоя: повороты костей задаются относительно неё.
    const rest = {};
    for (const [name, b] of Object.entries(bones)) {
      rest[name] = { local: b.quaternion.clone(), world: b.getWorldQuaternion(new THREE.Quaternion()), pos: b.position.clone() };
    }
    addFace(bones.head);

    this.scene.add(root);
    const label = document.createElement('div');
    label.className = 'crowd-label';
    label.textContent = p.name;
    this.labelsEl.append(label);

    return {
      id: p.id,
      root,
      bones,
      rest,
      label,
      material,
      target: new THREE.Vector3(),
      fresh: true,
      state: 'in',
      win: false,
      t: 0,
      phase: Math.random() * Math.PI * 2,
      speed: 5 + Math.random() * 2.5,
    };
  }

  remove(id) {
    const c = this.people.get(id);
    if (!c) return;
    this.scene.remove(c.root);
    c.material.dispose();
    c.label.remove();
    this.people.delete(id);
  }

  /** Поворот кости вокруг оси, заданной в мире, поверх позы покоя. */
  turn(c, name, axis, angle) {
    // GLTFLoader убирает из имён узлов точки и другие спецсимволы: «upperarm.r» → «upperarmr».
    const key = THREE.PropertyBinding.sanitizeNodeName(name);
    const b = c.bones[key];
    if (!b) return;
    const r = c.rest[key];
    const local = axis.clone().applyQuaternion(r.world.clone().invert());
    b.quaternion.copy(r.local).multiply(new THREE.Quaternion().setFromAxisAngle(local, angle));
  }

  animate(c, dt, time) {
    c.t += dt;
    c.root.position.lerp(c.target, Math.min(1, dt * 4));
    const s = time * c.speed + c.phase;

    // Руки у чиби короткие: поднятые вертикально, они прячутся в большой голове. Поэтому
    // плечо поднимаем в сторону, а машет предплечье — кисть оказывается рядом с головой.
    // Ось Z смотрит на зрителя: для правой руки (−X) минус поднимает, для левой (+X) — плюс.
    if (c.win) {
      // Победитель: обе руки буквой V и прыжки.
      const hop = Math.abs(Math.sin(time * 5 + c.phase));
      c.root.position.y = hop * 0.45;
      this.turn(c, 'upperarm.r', Z, -0.55);
      this.turn(c, 'upperarm.l', Z, 0.55);
      this.turn(c, 'lowerarm.r', Z, -0.75 - 0.25 * Math.sin(s * 1.5));
      this.turn(c, 'lowerarm.l', Z, 0.75 + 0.25 * Math.sin(s * 1.5));
      return;
    }

    // Машет правой рукой, левая опущена, корпус слегка покачивается.
    this.turn(c, 'upperarm.r', Z, -0.4 + 0.08 * Math.sin(s * 0.5));
    this.turn(c, 'lowerarm.r', Z, -1.0 + 0.55 * Math.sin(s));
    this.turn(c, 'upperarm.l', Z, -1.2);
    this.turn(c, 'lowerarm.l', Z, -0.1);
    this.turn(c, 'spine', Z, 0.06 * Math.sin(s * 0.5));
    this.turn(c, 'head', X, 0.05 * Math.sin(s * 0.5 + 1));
    c.root.position.y = 0.04 * Math.abs(Math.sin(s * 0.5));

    if (c.state === 'leaving') {
      // Выбывший: подпрыгивает, крутится и уменьшается до нуля.
      const k = Math.min(1, c.t / OUT_TIME);
      c.root.position.y = Math.sin(k * Math.PI) * 0.6;
      c.root.rotation.y = k * Math.PI * 2;
      c.root.scale.setScalar(1 - k * k);
      if (k >= 1) this.remove(c.id);
    }
  }

  loop(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const time = now / 1000;
    for (const c of [...this.people.values()]) this.animate(c, dt, time);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    requestAnimationFrame((t) => this.loop(t));
  }

  placeLabels() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const v = new THREE.Vector3();
    for (const c of this.people.values()) {
      v.set(c.root.position.x, 0, c.root.position.z).project(this.camera);
      c.label.style.transform = `translate(-50%, 0) translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
      c.label.style.zIndex = String(Math.round(1000 + c.root.position.z * 10));
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
    this.camera.aspect = w / h;
    if (this.template) this.layout();
    else this.fitCamera(this.cols || 1, this.rows || 1);
  }

  /** Камера спереди-сверху; картинка растягивается так, чтобы вся толпа вошла с полями под подписи. */
  fitCamera(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    const cam = this.camera;
    // Сверху-спереди (~45°): ряды расходятся по высоте кадра и не загораживают друг друга.
    cam.position.set(0, 13, 13);
    cam.lookAt(0, 1, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // Габариты считаем по фактическим местам человечков (с запасом на поднятые руки и прыжок).
    const spots = this.wanted.map((p) => this.people.get(p.id)?.target).filter(Boolean);
    if (!spots.length) spots.push(new THREE.Vector3());
    const pts = [];
    for (const t of spots) {
      for (const dx of [-0.6, 0.6]) for (const dz of [-0.4, 0.4]) for (const y of [0, HEIGHT + 0.5]) {
        pts.push(new THREE.Vector3(t.x + dx, y, t.z + dz));
      }
    }
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of pts) {
      p.project(cam);
      [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.y), Math.max(y1, p.y)];
    }
    y0 -= (y1 - y0) * 0.08; // место под подписи у ног
    // Не крупнее, чем если бы в толпе было ~4 человека, иначе один участник займёт полэкрана.
    const k = 0.92 * Math.min(2 / (x1 - x0), 2 / (y1 - y0), spots.length < 4 ? (2 / (y1 - y0)) * (spots.length / 4) ** 0.5 : Infinity);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    cam.projectionMatrix.premultiply(new THREE.Matrix4().set(k, 0, 0, -k * cx, 0, k, 0, -k * cy, 0, 0, 1, 0, 0, 0, 0, 1));
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }
}

/** Лицо в духе концепта: две тёмные круглые глаза с бликами и улыбка-дуга. Детали крепятся к кости головы. */
const FACE = {
  dark: new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.25 }),
  shine: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  eye: new THREE.SphereGeometry(0.085, 20, 14),
  glint: new THREE.SphereGeometry(0.028, 10, 8),
  smile: new THREE.TorusGeometry(0.09, 0.018, 8, 20, Math.PI),
};

function addFace(head) {
  if (!head) return;
  const inv = head.getWorldQuaternion(new THREE.Quaternion()).invert();
  const put = (mesh, x, y, z, worldQ) => {
    mesh.position.copy(head.worldToLocal(new THREE.Vector3(x, y, z)));
    if (worldQ) mesh.quaternion.copy(inv.clone().multiply(worldQ));
    head.add(mesh);
  };
  for (const side of [-1, 1]) {
    put(new THREE.Mesh(FACE.eye, FACE.dark), side * 0.2, 1.58, 0.47);
    put(new THREE.Mesh(FACE.glint, FACE.shine), side * 0.2 - 0.035, 1.615, 0.545);
  }
  // Нижняя половина тора — улыбка.
  put(new THREE.Mesh(FACE.smile, FACE.dark), 0, 1.44, 0.5, new THREE.Quaternion().setFromAxisAngle(Z, Math.PI));
}
