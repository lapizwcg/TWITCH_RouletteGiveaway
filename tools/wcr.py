# Чтение наборов персонажей WCGEngine («WCR1», см. WCGEngine/src/WcgEngine/Anim/Rig.cs и Geometry/Mesh.cs).
import struct

Q = 32767.0


class R:
    def __init__(self, data):
        self.d = data
        self.o = 0

    def take(self, fmt):
        v = struct.unpack_from('<' + fmt, self.d, self.o)
        self.o += struct.calcsize('<' + fmt)
        return v

    def i32(self):
        return self.take('i')[0]

    def f32(self):
        return self.take('f')[0]

    def floats(self, n):
        return list(self.take('%df' % n))

    def bytes(self, n):
        b = self.d[self.o:self.o + n]
        self.o += n
        return b

    def string(self):
        # строка .NET BinaryWriter: длина 7-битными порциями, затем UTF-8
        n, shift = 0, 0
        while True:
            b = self.d[self.o]
            self.o += 1
            n |= (b & 0x7F) << shift
            if b < 0x80:
                break
            shift += 7
        return self.bytes(n).decode('utf-8')


def read_mesh(r):
    vc, ic = r.i32(), r.i32()
    m = {'P': r.floats(vc * 3), 'N': r.floats(vc * 3)}
    m['Zone'] = r.bytes(vc)
    m['Tone'] = r.bytes(vc)
    m['Bones'] = r.bytes(vc * 4)
    m['Weights'] = r.bytes(vc * 4)
    m['Idx'] = list(r.take('%di' % ic))
    m['vc'], m['ic'] = vc, ic
    return m


def read_rig(data):
    r = R(data)
    assert r.take('I')[0] == 0x31524357, 'не WCR1'
    assert r.i32() == 1, 'другая версия'
    n = r.i32()
    bones = []
    for _ in range(n):
        name = r.string()
        parent = r.i32()
        t = r.floats(3)
        q = r.floats(4)
        s = r.floats(3)
        inv = r.floats(16)
        bones.append({'name': name, 'parent': parent, 't': t, 'r': q, 's': s, 'inv': inv})
    zones = [(r.string(), r.f32(), r.f32()) for _ in range(r.i32())]
    parts = []
    for _ in range(r.i32()):
        name = r.string()
        parts.append({'name': name, 'mesh': read_mesh(r)})
    clips = []
    for _ in range(r.i32()):
        c = {'name': r.string(), 'duration': r.f32(), 'rate': r.f32(), 'loop': r.take('?')[0], 'keys': r.i32(), 'ground': r.f32()}
        rot, pos = [], []
        for _ in range(n):
            rl = r.i32()
            rot.append([v / Q for v in r.take('%dh' % rl)] if rl else None)
            pl = r.i32()
            pos.append(r.floats(pl) if pl else None)
        c['rot'], c['pos'] = rot, pos
        rl = r.i32()
        c['root'] = list(r.take('%di' % rl)) if rl else None
        c['events'] = [(r.f32(), r.string()) for _ in range(r.i32())]
        clips.append(c)
    return {'bones': bones, 'zones': zones, 'parts': parts, 'clips': clips}
