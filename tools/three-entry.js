// Точка входа для сборки js/vendor/three.bundle.js (см. tools/BUILD.md).
// Перечислено только то, что используют js/wheel.js и js/crowd.js — остальное сборщик выбрасывает.
// Добавили в коде новый THREE.Что-то — допишите сюда и пересоберите.
export {
  ACESFilmicToneMapping,
  AnimationMixer,
  BackSide,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EquirectangularReflectionMapping,
  Group,
  HemisphereLight,
  InstancedMesh,
  LatheGeometry,
  LoopOnce,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NearestFilter,
  NoColorSpace,
  OctahedronGeometry,
  OrthographicCamera,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  ShadowMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from '../js/vendor/three.module.js';
export { RoomEnvironment } from '../js/vendor/RoomEnvironment.js';
export { GLTFLoader } from '../js/vendor/GLTFLoader.js';
export { clone as cloneSkinned } from '../js/vendor/SkeletonUtils.js';
export { MeshoptDecoder } from '../js/vendor/meshopt_decoder.module.js';
