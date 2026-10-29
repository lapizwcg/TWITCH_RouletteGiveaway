# Перевод наборов персонажей WCGEngine (.wcr) в glTF (.glb) для three.js.
#
#   py -I tools/wcr2glb.py <набор.wcr> <выход.glb> [--mesh] [--clips Имя1,Имя2,...]
#
# --mesh   — положить сетки (со скином); без него в файле только скелет и анимации,
#            их можно применять к любой модели с теми же именами костей.
# --clips  — какие клипы взять (по умолчанию — все).
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # запуск с -I не добавляет папку скрипта
from wcr import read_rig  # noqa: E402


def pad4(b, fill=b'\0'):
    return b + fill * ((4 - len(b) % 4) % 4)


class Builder:
    def __init__(self):
        self.bin = bytearray()
        self.views, self.accessors = [], []

    def add(self, data, comp, typ, count, target=None, normalized=False, minmax=None):
        off = len(self.bin)
        self.bin += pad4(bytes(data))
        view = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            view['target'] = target
        self.views.append(view)
        acc = {'bufferView': len(self.views) - 1, 'componentType': comp, 'count': count, 'type': typ}
        if normalized:
            acc['normalized'] = True
        if minmax:
            acc['min'], acc['max'] = minmax
        self.accessors.append(acc)
        return len(self.accessors) - 1


FLOAT, UBYTE, UINT = 5126, 5121, 5125


def convert(src, dst, with_mesh, clip_names):
    rig = read_rig(open(src, 'rb').read())
    bones = rig['bones']
    b = Builder()
    nodes = []
    for bone in bones:
        nodes.append({'name': bone['name'], 'translation': bone['t'], 'rotation': bone['r'], 'scale': bone['s']})
    for i, bone in enumerate(bones):
        if bone['parent'] >= 0:
            nodes[bone['parent']].setdefault('children', []).append(i)
    roots = [i for i, bone in enumerate(bones) if bone['parent'] < 0]

    gltf = {'asset': {'version': '2.0', 'generator': 'wcr2glb'}, 'scene': 0, 'nodes': nodes}
    scene_nodes = list(roots)

    if with_mesh:
        # Матрицы System.Numerics записаны по строкам при умножении «вектор × матрица» — это ровно
        # тот же порядок чисел, что glTF ждёт по столбцам для «матрица × вектор».
        ibm = b.add(struct.pack('<%df' % (16 * len(bones)), *[x for bone in bones for x in bone['inv']]), FLOAT, 'MAT4', len(bones))
        gltf['skins'] = [{'joints': list(range(len(bones))), 'inverseBindMatrices': ibm, 'skeleton': roots[0]}]
        mats = [{'name': z[0], 'pbrMetallicRoughness': {'baseColorFactor': [0.9, 0.9, 0.9, 1], 'metallicFactor': 0, 'roughnessFactor': 0.5}} for z in rig['zones']] or [{'name': 'base'}]
        gltf['materials'] = mats
        meshes = []
        for part in rig['parts']:
            m = part['mesh']
            vc = m['vc']
            P = m['P']
            lo = [min(P[k::3]) for k in range(3)]
            hi = [max(P[k::3]) for k in range(3)]
            pos = b.add(struct.pack('<%df' % (vc * 3), *P), FLOAT, 'VEC3', vc, 34962, minmax=(lo, hi))
            nor = b.add(struct.pack('<%df' % (vc * 3), *m['N']), FLOAT, 'VEC3', vc, 34962)
            jnt = b.add(m['Bones'], UBYTE, 'VEC4', vc, 34962)
            wgt = b.add(m['Weights'], UBYTE, 'VEC4', vc, 34962, normalized=True)
            # По примитиву на зону материала: так у каждой зоны свой материал в three.js.
            prims = []
            idx = m['Idx']
            zone = m['Zone']
            by_zone = {}
            for t in range(0, len(idx), 3):
                z = zone[idx[t]]
                by_zone.setdefault(z, []).extend(idx[t:t + 3])
            for z, tri in sorted(by_zone.items()):
                ind = b.add(struct.pack('<%dI' % len(tri), *tri), UINT, 'SCALAR', len(tri), 34963)
                prims.append({'attributes': {'POSITION': pos, 'NORMAL': nor, 'JOINTS_0': jnt, 'WEIGHTS_0': wgt}, 'indices': ind, 'material': min(z, len(mats) - 1)})
            meshes.append({'name': part['name'], 'primitives': prims})
            nodes.append({'name': part['name'], 'mesh': len(meshes) - 1, 'skin': 0})
            scene_nodes.append(len(nodes) - 1)
        gltf['meshes'] = meshes

    anims = []
    for c in rig['clips']:
        if clip_names and c['name'] not in clip_names:
            continue
        keys, rate = c['keys'], c['rate']
        channels, samplers = [], []
        times_cache = {}

        def times(n):
            if n not in times_cache:
                t = [k / rate for k in range(n)]
                times_cache[n] = b.add(struct.pack('<%df' % n, *t), FLOAT, 'SCALAR', n, minmax=([0.0], [t[-1]]))
            return times_cache[n]

        for i in range(len(bones)):
            rot = c['rot'][i]
            if rot:
                n = len(rot) // 4
                # соседние ключи — в одном полушарии, иначе интерполяция крутит «длинной дорогой»
                q = [rot[k * 4:k * 4 + 4] for k in range(n)]
                for k in range(1, n):
                    if sum(a * b2 for a, b2 in zip(q[k], q[k - 1])) < 0:
                        q[k] = [-v for v in q[k]]
                out = b.add(struct.pack('<%df' % (n * 4), *[v for qq in q for v in qq]), FLOAT, 'VEC4', n)
                samplers.append({'input': times(n), 'output': out, 'interpolation': 'LINEAR'})
                channels.append({'sampler': len(samplers) - 1, 'target': {'node': i, 'path': 'rotation'}})
            pos = c['pos'][i]
            if pos:
                n = len(pos) // 3
                out = b.add(struct.pack('<%df' % (n * 3), *pos), FLOAT, 'VEC3', n)
                samplers.append({'input': times(n), 'output': out, 'interpolation': 'LINEAR'})
                channels.append({'sampler': len(samplers) - 1, 'target': {'node': i, 'path': 'translation'}})
        if channels:
            anims.append({'name': c['name'], 'channels': channels, 'samplers': samplers})
    if anims:
        gltf['animations'] = anims

    gltf['scenes'] = [{'nodes': scene_nodes}]
    gltf['buffers'] = [{'byteLength': len(b.bin)}]
    gltf['bufferViews'] = b.views
    gltf['accessors'] = b.accessors
    js = pad4(json.dumps(gltf, separators=(',', ':')).encode('utf-8'), b' ')
    body = bytes(b.bin)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(body))
    out += struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(body), 0x004E4942) + body
    open(dst, 'wb').write(out)
    print(dst, len(out), 'байт;', 'сеток', len(gltf.get('meshes', [])), 'клипов', len(anims))


if __name__ == '__main__':
    args = sys.argv[1:]
    with_mesh = '--mesh' in args
    clips = None
    if '--clips' in args:
        clips = set(args[args.index('--clips') + 1].split(','))
    pos = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] != '--clips')]
    convert(pos[0], pos[1], with_mesh, clips)
