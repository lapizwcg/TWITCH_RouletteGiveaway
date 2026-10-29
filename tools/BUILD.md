# Сборка ресурсов

Сайт работает без сборки: в репозитории уже лежат готовые `js/vendor/three.bundle.js` и сжатые модели.
Пересобирать нужно, только если меняете модели или начинаете использовать в коде новые классы three.js.

Инструменты ставятся в любую временную папку (в репозиторий их класть не нужно):

```bash
npm install gltfpack@0.22.0 esbuild@0.24.0
```

## three.js

`js/vendor/three.bundle.js` — минифицированная сборка только того, что используют `js/wheel.js` и `js/crowd.js`
(≈ 590 КБ, по сети ≈ 150 КБ сжатым; полный three.js с загрузчиками — ≈ 1.4 МБ). Список — в `tools/three-entry.js`.
Исходники для сборки — `js/vendor/three.module.js` и соседние файлы (страницы их не загружают).

```bash
esbuild tools/three-entry.js --bundle --format=esm --minify --target=chrome95 --legal-comments=none --outfile=js/vendor/three.bundle.js
```

После пересборки поднимите номер версии `?v=` во всех файлах (иначе OBS возьмёт старую сборку из кеша).

## Модели

Персонажи KayKit и набор анимаций сжаты gltfpack (геометрия упакована meshopt — в 3–4 раза меньше,
распаковщик `MeshoptDecoder` уже в сборке three.js). `-kn -km` сохраняют имена костей и материалов.

```bash
gltfpack -i Knight.glb -o assets/models/characters/Knight.glb -cc -kn -km
gltfpack -i kaykit_anims.glb -o assets/models/kaykit_anims.glb -cc -kn
```

Исходники персонажей — пакеты KayKit Adventurers 2.0 и Skeletons 1.1 (`Characters/gltf/*.glb`);
`kaykit_anims.glb` до сжатия получается из набора WCGEngine скриптом `tools/wcr2glb.py`.
gltfpack упаковывает UV и добавляет `KHR_texture_transform`; перекраска в `js/crowd.js` переносит это
преобразование на свои текстуры.
