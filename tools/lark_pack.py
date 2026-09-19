#!/usr/bin/env python3
"""Pack the Lark animation data into a binary the firmware can read without a JSON parser.

    python tools/lark_pack.py [anim_data.json] [-o lark_data.bin]

The source is hesjustalittleguy.com's own anim_data.json — 36 states and 15 clips, 88KB of text.
On an ESP32 that would mean shipping ArduinoJson and parsing 88KB into RAM at boot, for data that
never changes. This lays it out so the firmware can point a struct at it and read fields directly.

WHY int16 TENTHS, NOT FLOATS
The survey that sized this format: every coordinate in the file lies between 15.1 and 363.8, and
none carries more than ONE decimal place. Stored as tenths that is 151..3638, which fits int16 with
an order of magnitude to spare and is exact — not a rounding, a change of unit. Floats would double
the size and buy nothing, and the site's own .bin does the same trick (14KB against our 88KB).

WHAT IS DROPPED, AND WHY IT IS SAFE
  b        the node's bounding box. The runtime recomputes anchors from the path itself; lark.js
           keeps `b` only to resolve normalised anchors, and those can come from the path's extent.
  app/dis  appear/disappear curves. Unused while a state simply sits there, which is all the
           firmware does with a state.
  z        paint order. Nodes are written already sorted by it, so the order IS the data.
  names    state and clip names, kept in a trailing block for debugging; the firmware indexes
           by number.

WHAT WAS DROPPED AND SHOULD NOT HAVE BEEN (fixed in version 2)
Version 1 dropped the groups outright — "groups carry no geometry" — and with them every node's
identity, leaving nodes addressable only by kind and side. That resolves eye_l/r and pup_l/r
exactly, which covers idle, both pupil drifts, pup_scale and all three blinks. It cannot tell one
GROUP from another, so `rot` and `rot3d` — whose lanes target `eyes`, `group_eye_l` and
`group_eye_r` — played on the device and drew nothing at all.

Version 2 writes a one-byte node id per node and a group table alongside it. The id space is tiny
and closed: across all 36 states there are exactly eleven node names, and the hierarchy is the same
in every one (eyes -> group_eye_l/r -> eye_*/pup_*), so an id is a byte and the tree is a constant
the firmware can carry in a header rather than data it has to parse.

The round-trip test (test/test_lark_data) reads this back and compares every path, colour, duration
and keyframe against the JSON. Nothing that the runtime reads may differ.
"""

import argparse
import json
import struct
import sys
from pathlib import Path

MAGIC = b'LARK'
VERSION = 2

# Node kinds, in the order the renderer paints them.
KIND_GROUP, KIND_EYE, KIND_PUPIL, KIND_HIGHLIGHT = 0, 1, 2, 3

# Every node name that appears anywhere in the data, as a one-byte id. Surveyed across all 36
# states: these eleven are the complete set, and the hierarchy below them is identical in every
# state. That makes the id space closed, so an unknown name here is a change in the data rather
# than a gap in this table -- and pack_states raises instead of inventing an id for it.
#
# Lane objects address nodes by exactly these names, which is why the ids exist at all: without
# them a group lane (`eyes`, `group_eye_*`) has nothing to resolve to.
NODE_IDS = {
    'eyes': 0,
    'group_eye_l': 1,
    'group_eye_r': 2,
    'eye_l': 3,
    'eye_r': 4,
    'pup_l': 5,
    'pup_r': 6,
    'h1_l': 7,
    'h1_r': 8,
    'h2_l': 9,
    'h2_r': 10,
}
NODE_ROOT = 0                 # `eyes`, the only root in every state (rootObjs is ["eyes"] in all 36)

# A lane whose `object` is "" targets the SCENE root, not a node. It needs a marker distinct from
# every node id, because id 0 is `eyes` -- a real group that `rot` targets -- and conflating the two
# would send the look lane to the eye group and the rotation to nowhere.
LANE_ROOT = 0xFF

KEYPATHS = ['p', 't', 's', 'o', 'l', 'r', 't3d']       # index = wire value
REPEATS = {'n': 0, 'l': 1}


def kind_of(name, node):
    if node.get('type') == 'group':
        return KIND_GROUP
    if name.startswith('eye_'):
        return KIND_EYE
    if name.startswith('pup_'):
        return KIND_PUPIL
    return KIND_HIGHLIGHT


def tenths(v):
    """Coordinates are exact in tenths — see the note at the top. Assert rather than round, so a
    future data file with finer coordinates fails loudly instead of losing a pixel quietly."""
    t = round(v * 10)
    if abs(t - v * 10) > 1e-6:
        raise ValueError(f'coordinate {v} is not an exact tenth')
    if not -32768 <= t <= 32767:
        raise ValueError(f'coordinate {v} does not fit in int16 tenths')
    return t


def rgb565(hexstr):
    r, g, b = int(hexstr[0:2], 16), int(hexstr[2:4], 16), int(hexstr[4:6], 16)
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def pack_states(data):
    """states: count, then per state: node count, then per node its fields and path.

    Version 2 adds a node id and a parent id to every node, and stops dropping the groups. A group
    carries no geometry -- pathCount is 0 and the renderer skips it -- but it MUST be present and
    identifiable, because clip lanes address it: `rot` drives `eyes`, `rot3d_2` drives
    `group_eye_l`/`group_eye_r`. Without them those clips play and draw nothing.
    """
    out = bytearray()
    names = []
    ids = sorted(data['states'].keys())
    out += struct.pack('<H', len(ids))
    for sid in ids:
        names.append(sid)
        objs = data['states'][sid]['objs']

        # Each node's parent, from the data's own child lists rather than from the name. A node with
        # no parent is a root and stores itself as its parent, which the reader reads as "no parent"
        # without needing a sentinel that could collide with a real id.
        parent = {}
        for n, o in objs.items():
            for child in (o.get('ch') or []):
                parent[child] = n

        # Paint order is the data's own z, and groups sort into it by their own z (eyes 0,
        # group_eye_l 1, group_eye_r 4) so a group always precedes the children it contains. The
        # renderer walks this list in order and skips anything with no path.
        ordered = sorted(objs.items(), key=lambda kv: kv[1].get('z', 0))
        out += struct.pack('<H', len(ordered))
        for name, o in ordered:
            if name not in NODE_IDS:
                raise ValueError(
                    f'{sid}/{name}: unknown node name. NODE_IDS was surveyed as the complete set '
                    f'across all 36 states -- a new name means the data changed, and the table and '
                    f'the firmware\'s copy of the hierarchy both need updating.')
            p = o.get('p') or []
            if len(p) not in (0, 24):
                raise ValueError(f'{sid}/{name}: unexpected path length {len(p)}')
            flags = 0
            if o.get('ul'):
                flags |= 1
            ll = o.get('ll') or [0, 0]
            lts = o.get('lts') or [0, 0]
            # Groups DO carry a colour in the data -- all three are FFFFFF -- even though nothing
            # paints them. Preserved as written rather than zeroed: this file's job is to be a
            # faithful re-encoding, and a field invented here is a field that cannot be checked
            # against the source.
            colour = rgb565(o['c']) if o.get('c') else 0
            out += struct.pack(
                '<BBBBHhhhh',
                NODE_IDS[name],
                NODE_IDS.get(parent.get(name), NODE_IDS[name]),   # self = no parent
                kind_of(name, o),
                flags,
                colour,
                round(ll[0] * 1000), round(ll[1] * 1000),     # 0..1, three decimals is plenty
                round(lts[0] * 1000), round(lts[1] * 1000),
            )
            out += struct.pack('<H', len(p))
            for v in p:
                out += struct.pack('<h', tenths(v))
    return bytes(out), names


def pack_value(keypath, k):
    """One keyframe's value, shaped by its keypath. `u: true` means 'the node's rest value' and
    carries no payload — the runtime substitutes it, exactly as lark.js does."""
    if k.get('u'):
        return b''
    v = k.get('v')
    if keypath == 'p':
        if not isinstance(v, list):
            return b''
        return struct.pack('<H', len(v)) + b''.join(struct.pack('<h', tenths(x)) for x in v)
    if keypath == 'o':
        return struct.pack('<h', round(float(v) * 1000))
    if keypath in ('t', 's', 'l'):
        vals = list(v) + [0] * (3 - len(v))
        return b''.join(struct.pack('<h', round(float(x) * 1000)) for x in vals[:3])
    if keypath in ('r', 't3d'):
        anc = v.get('anc') or [0, 0]
        piv = v.get('piv') or [0, 0]
        return struct.pack('<hhhhh',
                           round(float(v.get('ang', 0)) * 10000),   # radians, four decimals
                           round(anc[0] * 1000), round(anc[1] * 1000),
                           round(piv[0] * 1000), round(piv[1] * 1000))
    raise ValueError(f'unhandled keypath {keypath}')


def pack_clips(data):
    out = bytearray()
    names = []
    ids = sorted(data['animations'].keys())
    out += struct.pack('<H', len(ids))
    for cid in ids:
        names.append(cid)
        c = data['animations'][cid]
        lanes = c['lanes']
        out += struct.pack('<HBB', c['durationMs'], REPEATS[c['repeat']], len(lanes) // 2)
        for i in range(0, len(lanes), 2):
            head, keys = lanes[i], lanes[i + 1]
            kp = head['keypath']
            if kp not in KEYPATHS:
                raise ValueError(f'{cid}: unhandled keypath {kp}')
            # The lane's target, as a node id rather than a name. `object: ""` means the ROOT of the
            # scene -- where every clip drives the look -- which is not a node, so it gets its own
            # marker rather than being confused with node id 0 (`eyes`, a real group that `rot`
            # actually targets).
            obj = head.get('object') or ''
            if obj and obj not in NODE_IDS:
                raise ValueError(f'{cid}: lane targets unknown node "{obj}"')
            target = NODE_IDS[obj] if obj else LANE_ROOT
            out += struct.pack('<BBB', KEYPATHS.index(kp), len(keys), target)
            for k in keys:
                payload = pack_value(kp, k)
                out += struct.pack('<HBB', k['t'], k.get('c', 24), 1 if k.get('u') else 0)
                out += struct.pack('<H', len(payload)) + payload
    return bytes(out), names


def pack_names(names):
    out = bytearray(struct.pack('<H', len(names)))
    for n in names:
        b = n.encode()
        out += struct.pack('<B', len(b)) + b
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source', nargs='?',
                    default=str(Path(__file__).resolve().parents[2] / 'lilguy-fork' / 'public' / 'anim_data.json'))
    ap.add_argument('-o', '--out', default=str(Path(__file__).resolve().parents[1] / 'lark_data.bin'))
    args = ap.parse_args()

    data = json.loads(Path(args.source).read_text(encoding='utf-8'))
    states, stateNames = pack_states(data)
    clips, clipNames = pack_clips(data)
    sNames, cNames = pack_names(stateNames), pack_names(clipNames)

    # header: magic, version, then (offset, size) for each of the four sections
    header = struct.pack('<4sH', MAGIC, VERSION)
    head_len = len(header) + 4 * 8
    off = head_len
    parts = []
    for blob in (states, clips, sNames, cNames):
        parts.append(struct.pack('<II', off, len(blob)))
        off += len(blob)
    blob = header + b''.join(parts) + states + clips + sNames + cNames

    Path(args.out).write_bytes(blob)
    src = len(Path(args.source).read_bytes())
    print(f'{args.out}: {len(blob)} bytes  ({len(states)} states + {len(clips)} clips '
          f'+ {len(sNames) + len(cNames)} names)')
    print(f'  source JSON {src} bytes -> {len(blob) * 100 // src}% of it')

    # The same bytes as a C array, so the firmware can carry them in its own flash.
    #
    # LittleFS would be the obvious home, but that partition is shared with the GIF sets and the
    # slideshow, and `pio run -t uploadfs` writes a WHOLE directory -- it erases whatever else was
    # there. Shipping the scene data that way means loading a GIF set silently deletes the eyes, and
    # loading the eyes silently deletes the GIF set. This data is fixed and never edited on the unit
    # (unlike GIFs and slides, which is exactly why THOSE belong on the filesystem), so putting it in
    # the application image removes the coupling instead of documenting it.
    # `lark_data_blob.h`, NOT `lark_data.h` -- that name is already the hand-written reader, and
    # with_suffix('.h') on the .bin path lands right on top of it.
    hdr = Path(args.out).with_name('lark_data_blob.h')
    guard = 'const'
    lines = [
        '#pragma once',
        '// GENERATED by tools/lark_pack.py -- do not edit.',
        '// The packed Lark scene data, embedded in the application image rather than LittleFS: that',
        '// partition is shared with the GIF sets, and `uploadfs` erases the whole directory, so one',
        '// upload would wipe the other feature. Regenerate with:  python tools/lark_pack.py',
        '#include <stdint.h>',
        '',
        f'{guard} uint32_t LARK_DATA_LEN = {len(blob)};',
        f'{guard} uint8_t LARK_DATA[{len(blob)}] = {{',
    ]
    for i in range(0, len(blob), 16):
        lines.append('  ' + ''.join(f'0x{b:02x},' for b in blob[i:i + 16]))
    lines.append('};')

    # Refuse to clobber a file this script did not write. Picking the output name by suffix once
    # landed this array on top of the hand-written reader, which the marker check would have caught.
    if hdr.exists() and 'GENERATED by tools/lark_pack.py' not in hdr.read_text(encoding='utf-8', errors='replace')[:400]:
        sys.exit(f'{hdr} exists and is not generated by this script -- refusing to overwrite it')
    hdr.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'  {hdr.name}: same bytes as a C array for the firmware image')


if __name__ == '__main__':
    sys.exit(main())
