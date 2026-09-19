// Every edit the editor can make, as pure functions over the anim_data shape.
//
// Pure on purpose: each one takes the data and returns NEW data, so undo is a stack of previous
// values rather than a log of inverse operations. That is the whole reason this file is separate
// from the React components -- the operations are testable without a DOM, and the history in
// useEditorState does not need to know what any of them mean.
//
// The shape these operate on is the site's own anim_data.json, unchanged:
//
//   { states: {...}, animations: { <name>: { blend, durationMs, repeat, lanes: [...] } } }
//
// `lanes` is a FLAT array alternating head and keyframe list:
//
//   [ {keypath, object}, [ {c, t, v|u}, ... ], {keypath, object}, [ ... ], ... ]
//
// It is not a list of pairs, and treating it as one silently drops every other lane. The helpers
// below are the only place that indexing is done.

// The data's hole value. A node coloured exactly this is PUNCHED out of what is behind it rather
// than filled -- twenty of the 36 states draw their pupils this way, and reading it as the colour
// black cost this project most of its fidelity once.
export const HOLE = '000000';
export const isHole = (c) => String(c || '').toUpperCase() === HOLE;

// Set one node's colour inside one state.
//
// This edits the DOCUMENT, not the runtime. LarkRuntime.setColour exists and the published page
// uses it, but a runtime override is not part of anim_data.json: it would look right in the browser
// and vanish the moment the file was exported. Writing `objs[node].c` means the change survives
// export -> tools/lark_pack.py -> the device.
export function setNodeColour(data, stateId, node, hex) {
  const state = data.states?.[stateId];
  if (!state?.objs?.[node]) return data;
  const c = String(hex).replace(/^#/, '').toUpperCase();
  return {
    ...data,
    states: {
      ...data.states,
      [stateId]: {
        ...state,
        objs: { ...state.objs, [node]: { ...state.objs[node], c } },
      },
    },
  };
}

// Move one node's outline inside one state.
//
// The path is 24 numbers — 12 (x, y) points — so translating is adding the delta to every pair.
// This edits the STATE's geometry, which is what makes it apply to every clip and survive export,
// exactly as a colour change does.
//
// COORDINATES ARE ROUNDED TO TENTHS. Not cosmetic: tools/lark_pack.py stores them as int16 tenths
// and ASSERTS the value is an exact tenth rather than rounding, because a silent rounding there
// would be a shape that differs from the one authored. A drag produces arbitrary floats, so the
// rounding has to happen here, where it is visible, or the export refuses the file.
export function moveNode(data, stateId, node, dx, dy) {
  const state = data.states?.[stateId];
  const obj = state?.objs?.[node];
  if (!obj?.p || !obj.p.length) return data;
  const p = obj.p.map((v, i) => Math.round((v + (i % 2 === 0 ? dx : dy)) * 10) / 10);
  return {
    ...data,
    states: {
      ...data.states,
      [stateId]: { ...state, objs: { ...state.objs, [node]: { ...obj, p } } },
    },
  };
}

// A keyframe's value for each keypath when nothing else is specified. `u: true` means "the node's
// rest value" and carries no `v` at all.
export function defaultValueFor(keypath) {
  switch (keypath) {
    case 's': return [1, 1];
    case 'o': return 1;
    case 'r': case 't3d': return 0;
    default: return [0, 0, 0];      // t, l
  }
}

// How many numbers a keyframe carries on this keypath, and what to call each one.
export const FIELDS = {
  t: ['x', 'y'],
  s: ['x', 'y'],
  l: ['x', 'y'],
  o: ['a'],
  r: ['ângulo'],
  t3d: ['ângulo'],
};

export const KEYPATH_LABEL = {
  t: 'translação', s: 'escala', o: 'opacidade', l: 'olhar',
  r: 'rotação', t3d: 'perspectiva', p: 'contorno',
};

// The easing ids the data uses. CURVES in lark.js is the authority on what each does; 0 is the step
// that HOLDS its source value rather than jumping ahead to the target.
export const CURVE_OPTIONS = [
  { id: 0, label: '0 — degrau (segura a origem)' },
  { id: 14, label: '14 — ease-out' },
  { id: 15, label: '15 — ease-out (formas)' },
  { id: 22, label: '22 — ease-in-out' },
  { id: 23, label: '23 — ease-in-out' },
  { id: 24, label: '24 — ease-in-out (padrão)' },
];

// Walk a clip's flat lane array as {head, keys, index} triples. `index` is the position of the HEAD
// in the flat array, which is what every mutation below addresses.
export function lanesOf(clip) {
  const out = [];
  if (!clip?.lanes) return out;
  for (let i = 0; i < clip.lanes.length; i += 2) {
    out.push({ head: clip.lanes[i], keys: clip.lanes[i + 1], index: i });
  }
  return out;
}

// Clone just enough to mutate one clip without touching the rest. Cloning the whole anim_data on
// every keystroke would copy 88KB per character typed.
function withClip(data, name, mutate) {
  const clip = data.animations[name];
  if (!clip) return data;
  const next = { ...clip, lanes: clip.lanes.slice() };
  mutate(next);
  return { ...data, animations: { ...data.animations, [name]: next } };
}

function withKeys(clip, laneIndex, mutate) {
  const keys = clip.lanes[laneIndex + 1].map((k) => ({ ...k }));
  mutate(keys);
  // Keyframes MUST stay ordered in time: sampleLane walks them in order and assumes it, so a lane
  // whose times run backwards samples the wrong segment and the clip plays visibly wrong.
  keys.sort((a, b) => a.t - b.t);
  clip.lanes[laneIndex + 1] = keys;
}

export function setKeyTime(data, clipName, laneIndex, keyIndex, t) {
  return withClip(data, clipName, (clip) => {
    const limit = clip.durationMs;
    withKeys(clip, laneIndex, (keys) => {
      keys[keyIndex].t = Math.max(0, Math.min(limit, Math.round(t)));
    });
  });
}

export function setKeyCurve(data, clipName, laneIndex, keyIndex, curve) {
  return withClip(data, clipName, (clip) => {
    withKeys(clip, laneIndex, (keys) => { keys[keyIndex].c = curve; });
  });
}

// Set one component of a keyframe's value. `component` is an index into the FIELDS list.
export function setKeyComponent(data, clipName, laneIndex, keyIndex, component, value) {
  return withClip(data, clipName, (clip) => {
    const keypath = clip.lanes[laneIndex].keypath;
    withKeys(clip, laneIndex, (keys) => {
      const k = keys[keyIndex];
      delete k.u;                                   // an explicit value is no longer "rest"
      if (Array.isArray(k.v)) { const v = k.v.slice(); v[component] = value; k.v = v; }
      else if ((FIELDS[keypath] || []).length === 1) k.v = value;
      else { const v = defaultValueFor(keypath); v[component] = value; k.v = v; }
    });
  });
}

// Toggle a keyframe between "the node's rest value" and a concrete one.
export function setKeyRest(data, clipName, laneIndex, keyIndex, useRest) {
  return withClip(data, clipName, (clip) => {
    const keypath = clip.lanes[laneIndex].keypath;
    withKeys(clip, laneIndex, (keys) => {
      const k = keys[keyIndex];
      if (useRest) { k.u = true; delete k.v; }
      else { delete k.u; k.v = defaultValueFor(keypath); }
    });
  });
}

export function addKey(data, clipName, laneIndex, atMs) {
  return withClip(data, clipName, (clip) => {
    const keypath = clip.lanes[laneIndex].keypath;
    const t = Math.max(0, Math.min(clip.durationMs, Math.round(atMs)));
    withKeys(clip, laneIndex, (keys) => {
      if (keys.some((k) => k.t === t)) return;      // one keyframe per instant
      keys.push({ c: 24, t, v: defaultValueFor(keypath) });
    });
  });
}

export function removeKey(data, clipName, laneIndex, keyIndex) {
  return withClip(data, clipName, (clip) => {
    withKeys(clip, laneIndex, (keys) => {
      // A lane with no keyframes samples nothing and would be dead weight in the file.
      if (keys.length > 1) keys.splice(keyIndex, 1);
    });
  });
}

export function addLane(data, clipName, object, keypath) {
  return withClip(data, clipName, (clip) => {
    for (let i = 0; i < clip.lanes.length; i += 2) {
      if (clip.lanes[i].object === object && clip.lanes[i].keypath === keypath) return;
    }
    clip.lanes = clip.lanes.concat([
      { keypath, object },
      [{ c: 24, t: 0, u: true }, { c: 24, t: clip.durationMs, v: defaultValueFor(keypath) }],
    ]);
  });
}

export function removeLane(data, clipName, laneIndex) {
  return withClip(data, clipName, (clip) => {
    clip.lanes = clip.lanes.filter((_, i) => i !== laneIndex && i !== laneIndex + 1);
  });
}

// Changing the duration clamps every keyframe that now sits past the end. Leaving them out there
// would make them unreachable -- the clip stops before they are ever sampled -- while looking fine
// in the file.
export function setDuration(data, clipName, durationMs) {
  const d = Math.max(1, Math.round(durationMs));
  return withClip(data, clipName, (clip) => {
    clip.durationMs = d;
    clip.lanes = clip.lanes.map((entry, i) => {
      if (i % 2 === 0) return entry;
      return entry.map((k) => (k.t > d ? { ...k, t: d } : k));
    });
  });
}

export function setRepeat(data, clipName, loops) {
  return withClip(data, clipName, (clip) => { clip.repeat = loops ? 'l' : 'n'; });
}

// A new clip starts EMPTY rather than as a copy. A copy would carry the source's `p` lanes -- the
// eyelid outlines, 24 Bezier numbers per keyframe -- which this editor deliberately does not edit,
// so the copy would be mostly lanes the user cannot touch.
export function createClip(data, name) {
  if (!name || data.animations[name]) return data;
  return {
    ...data,
    animations: {
      ...data.animations,
      [name]: { blend: 'a', durationMs: 1000, repeat: 'n', lanes: [] },
    },
  };
}

export function deleteClip(data, name) {
  if (!data.animations[name]) return data;
  const animations = { ...data.animations };
  delete animations[name];
  return { ...data, animations };
}

export function renameClip(data, from, to) {
  if (!data.animations[from] || !to || data.animations[to]) return data;
  const animations = {};
  // Rebuilt in order rather than delete-then-add, so a rename does not move the clip to the end of
  // the file and produce a noisy diff against the original data.
  for (const [k, v] of Object.entries(data.animations)) animations[k === from ? to : k] = v;
  return { ...data, animations };
}

// Which node names a state actually contains -- the lane targets that will draw something. Read
// from the state rather than hardcoded, because states differ: not all have highlights.
export function nodeNamesOf(data, stateId) {
  return nodeTreeOf(data, stateId).map((n) => n.name);
}

// The state's object tree, in the order and depth the original tool shows it:
//
//   eyes
//     group_eye_l
//       eye_l
//       pup_l
//     group_eye_r
//       ...
//
// GROUPS ARE INCLUDED, and that matters for authoring: a lane on `eyes` moves the pair together,
// which is how `rot` works, and a lane on one eye group turns that eye about its own anchor, which
// is how `rot3d_2` works. Filtering them out -- as this did at first -- makes those clips
// impossible to author or even to understand.
//
// Built from the data's own `ch` child lists rather than from the names, so a state laid out
// differently still reads correctly.
export function nodeTreeOf(data, stateId) {
  const objs = data.states?.[stateId]?.objs;
  if (!objs) return [];

  const roots = data.states[stateId].rootObjs
    || Object.keys(objs).filter((k) => !Object.values(objs).some((o) => (o.ch || []).includes(k)));

  const out = [];
  const walk = (name, depth) => {
    const o = objs[name];
    if (!o) return;
    out.push({ name, depth, isGroup: o.type === 'group', z: o.z ?? 0 });
    for (const child of (o.ch || [])) walk(child, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

// Does this clip drive whole GROUPS rather than individual eyes and pupils? `rot` turns the pair
// about `eyes`; `rot3d_2` turns each eye about its own group. Worth surfacing in the UI because a
// group lane moves several nodes at once, which is not obvious from the lane's name alone.
//
// It used to mean something sharper -- "this clip draws nothing on the device" -- because version 1
// of the packed data dropped the groups and addressed nodes by kind and side. Version 2 carries
// node ids, so these clips now reach the pixels on the hardware too.
export function targetsGroups(clip) {
  if (!clip?.lanes) return false;
  return lanesOf(clip).some(({ head }) => head.object && !/^(eye|pup|h1|h2)_/.test(head.object));
}
