import { useEffect, useRef } from 'react';
import { LarkRuntime, tracePath } from '@lark';

// The preview, drawn by the REAL runtime.
//
// This is the point of the whole app: lark.js is imported, not reimplemented. A clip that plays
// correctly here plays correctly on the artifact page, and -- through the C++ port, which is held to
// the same measurements -- on the device. A viewer written to "look like" the runtime would drift
// from it the first time either changed, and the drift would be invisible.
//
// The canvas backing store is 240x240 because that is the panel: the Waveshare ESP32-S3-Touch-LCD-1.28
// (GC9A01) the ocellus ships on. What is drawn here is what the hardware draws; the browser only
// scales it up for the screen.
const PANEL = 240;
const RADIUS = PANEL / 2;

// The authoring space is 400x400 and the scene sits centred on (196, 188) inside it -- measured
// across all 36 states and every clip: the union of drawn pixels is x 15..377, y 42..334. The
// drawing has to be mapped onto the disc, and skipping that map is not a cosmetic slip: `draw`
// renders in authoring units, so an unmapped canvas shows the scene at 1:1 with most of the second
// eye off the right edge and the bottom cut off at y=239.
//
// The same three numbers appear in tools/artifact-page.js and in lark_scene.h. They are the single
// mapping from authoring space to the panel, so all three must agree or the browser, the published
// page and the device each draw the eyes at a different size.
const SCENE_CX = 196;
const SCENE_CY = 188;
// 0.65 is the last scale that never touches the disc's mask in a pose anyone holds, and is 11%
// larger than the figure that clips nothing anywhere.
const SCENE_SCALE = 0.65;

// Id-pass colours: one per node, each far from the others in EVERY channel so that no blend of two
// can equal a third. Eight is more than any state needs — the most nodes a state carries is six
// drawable ones (two eyes, two pupils, two highlights).
const ID_COLOURS = ['FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', 'FF8000', '8000FF'];
const ID_RGB = ID_COLOURS.map((h) => [
  parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
]);

// Which node is under the cursor?
//
// Answered by drawing an ID PASS on an offscreen canvas: every node gets a unique flat colour, the
// scene is drawn again with the same transform, and the pixel under the pointer names the node.
// Exact by construction — it uses the real draw path, so a node hit here is a node that is actually
// visible, clipped and z-ordered exactly as on screen.
//
// Reading the visible canvas instead would be simpler and wrong: nodes share colours (both pupils
// in state 1b are 106E54), a hole punches to the background rather than to a colour of its own,
// and antialiased edges blend two nodes into a third value that matches neither.
// Render the id pass and hand back the pixels plus the node names its indices map to. Shared by
// the hit test and by the group outline, so both read exactly what the scene draws.
function idPass(LarkRuntimeCtor, data, stateId, clipName, timeMs, look) {
  const probe = document.createElement('canvas');
  probe.width = PANEL;
  probe.height = PANEL;
  const ctx = probe.getContext('2d', { willReadFrequently: true });

  const rt = new LarkRuntimeCtor(data, stateId);
  const names = Object.keys(rt.objs).filter((n) => rt.objs[n]?.type !== 'group');

  // One flat colour per node. Packing ids into a single channel does NOT work: antialiasing
  // averages two neighbouring ids, and with ids at 16, 32, 48, 64 the blend of 32 and 64 is
  // exactly 48 — a third node's id, indistinguishable from its interior. Measured on state 1b,
  // that put `pup_l` at x 65..157, straddling both eyes, and stretched the left group's box
  // across the pair.
  //
  // Spreading each id across all three channels removes the ambiguity: a blend of two ids differs
  // from every real id in at least one channel, so an exact three-channel match rejects it.
  names.forEach((n, i) => rt.setColour(n, ID_COLOURS[i % ID_COLOURS.length]));

  const now = 1e6;
  const clip = data.animations[clipName];
  rt.active = [];
  if (clip) {
    let t = timeMs;
    if (clip.repeat === 'l' && clip.durationMs) t = timeMs % clip.durationMs;
    rt.active.push({ clip, name: clipName, start: now - t, category: null });
  }
  rt.setLook(look[0], look[1]);

  ctx.clearRect(0, 0, PANEL, PANEL);
  ctx.save();
  ctx.beginPath();
  ctx.arc(RADIUS, RADIUS, RADIUS, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(RADIUS, RADIUS);
  ctx.scale(SCENE_SCALE, SCENE_SCALE);
  ctx.translate(-SCENE_CX, -SCENE_CY);
  rt.draw(ctx, now, { width: 400, height: 400 });
  ctx.restore();

  return { ctx, names, rt };
}

// Which id, if any, a pixel is exactly. Returns -1 for the background and for any antialiased
// blend between two nodes.
function idAt(d, offset) {
  if (d[offset + 3] < 255) return -1;
  for (let i = 0; i < ID_COLOURS.length; i++) {
    const c = ID_RGB[i];
    if (d[offset] === c[0] && d[offset + 1] === c[1] && d[offset + 2] === c[2]) return i;
  }
  return -1;
}

function hitTest(LarkRuntimeCtor, data, stateId, clipName, timeMs, look, x, y) {
  const { ctx, names } = idPass(LarkRuntimeCtor, data, stateId, clipName, timeMs, look);
  // Sample a small neighbourhood: a click can land on an antialiased edge, which belongs to no id.
  const px = Math.round(x), py = Math.round(y);
  for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const sx = px + ox, sy = py + oy;
    if (sx < 0 || sy < 0 || sx >= PANEL || sy >= PANEL) continue;
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    const id = idAt(d, 0);
    if (id >= 0) return names[id] ?? null;
  }
  return null;
}

// Everything a group contains, however deep: eyes -> group_eye_* -> eye_*/pup_*.
function descendantsOf(objs, name, out = []) {
  for (const child of (objs[name]?.ch || [])) {
    out.push(child);
    descendantsOf(objs, child, out);
  }
  return out;
}

// The on-screen box a group occupies RIGHT NOW.
//
// Read from the id pass rather than from the group's own `b` or from its children's raw paths.
// Both of those describe the rest pose, while drawNode applies the look, the turn and the running
// clip's channels on the way to the screen — so a box taken from the data sits still while the eyes
// move, which is worse than no box at all.
function groupBox(LarkRuntimeCtor, data, stateId, clipName, timeMs, look, group) {
  const { ctx, names, rt } = idPass(LarkRuntimeCtor, data, stateId, clipName, timeMs, look);
  const kids = new Set(descendantsOf(rt.objs, group));
  const wanted = new Set();
  names.forEach((n, i) => { if (kids.has(n)) wanted.add(i); });
  if (!wanted.size) return null;

  const d = ctx.getImageData(0, 0, PANEL, PANEL).data;
  let x0 = PANEL, y0 = PANEL, x1 = -1, y1 = -1;
  for (let y = 0; y < PANEL; y++) {
    for (let x = 0; x < PANEL; x++) {
      const i = (y * PANEL + x) * 4;
      const id = idAt(d, i);
      if (id < 0 || !wanted.has(id)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export default function Stage({
  data, stateId, clipName, timeMs, background, look, onLook, onPick, onMove, selected,
}) {
  const canvasRef = useRef(null);
  const rtRef = useRef(null);
  const frameRef = useRef(null);
  const dragRef = useRef(null);
  // The group box costs a full extra render, so it is cached against everything that could move it.
  const boxRef = useRef({ key: null, box: null });
  // Held in a ref rather than a dependency: the selection changes far more often than the draw
  // loop should be torn down and rebuilt, and the loop reads it fresh on every frame anyway.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // The runtime is rebuilt when the DATA identity changes, which every edit causes. That is cheap
  // (it reads the scene graph out of the state) and it is what makes an edit show up immediately.
  useEffect(() => {
    rtRef.current = new LarkRuntime(data, stateId);
  }, [data, stateId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      const rt = rtRef.current;
      if (rt) {
        // Drawing at an arbitrary time means planting an instance whose start is that far in the
        // past: the runtime computes `now - start` itself, so scrubbing and playback go through the
        // exact same code path. A separate "evaluate at t" function could disagree with playback,
        // and the disagreement would look like a bug in the clip.
        const now = 1e6;
        const clip = data.animations[clipName];
        rt.active = [];
        if (clip) {
          let t = timeMs;
          if (clip.repeat === 'l' && clip.durationMs) t = timeMs % clip.durationMs;
          rt.active.push({ clip, name: clipName, start: now - t, category: null });
        }
        rt.setLook(look[0], look[1]);

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, PANEL, PANEL);
        if (background) {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, PANEL, PANEL);
        }

        // Clip to the disc. Not decoration: it is the panel's actual shape, and anything outside it
        // does not exist on the device. Doing it here rather than with a CSS border-radius means a
        // screenshot of this canvas is what the hardware would show.
        ctx.save();
        ctx.beginPath();
        ctx.arc(RADIUS, RADIUS, RADIUS, 0, Math.PI * 2);
        ctx.clip();

        // Authoring space (400x400, scene centred on 196,188) -> the 240px disc.
        ctx.translate(RADIUS, RADIUS);
        ctx.scale(SCENE_SCALE, SCENE_SCALE);
        ctx.translate(-SCENE_CX, -SCENE_CY);
        rt.draw(ctx, now, { width: 400, height: 400 });
        ctx.restore();
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        // Mark the selection.
        //
        // A LEAF is outlined by its own path, traced in the same transform the scene just used, so
        // the ring lands exactly on the node including whatever the gaze and the clip did to it.
        //
        // A GROUP has no path — `p` is [] on all three — so it gets a bounding box instead, drawn
        // around everything it contains. That is also what a group IS here: a handle for moving
        // several nodes at once, which is how `rot` turns the pair and `rot3d_2` turns one eye.
        const sel = selectedRef.current;
        const node = sel && rt.objs[sel];
        if (node && node.type !== 'group') {
          const p = rt.channelsFor(sel, now).p || node.p;
          if (p && p.length) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(RADIUS, RADIUS, RADIUS, 0, Math.PI * 2);
            ctx.clip();
            ctx.translate(RADIUS, RADIUS);
            ctx.scale(SCENE_SCALE, SCENE_SCALE);
            ctx.translate(-SCENE_CX, -SCENE_CY);
            ctx.beginPath();
            tracePath(ctx, p);
            ctx.strokeStyle = '#ffffff';
            // Scaled back up, so the ring is a constant 2px on screen rather than 2 authoring units.
            ctx.lineWidth = 2 / SCENE_SCALE;
            ctx.setLineDash([6 / SCENE_SCALE, 4 / SCENE_SCALE]);
            ctx.stroke();
            ctx.restore();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
          }
        } else if (node) {
          // The box costs a whole extra render of the scene, so it is computed when something that
          // could move it changes rather than every frame.
          const key = `${sel}|${stateId}|${clipName}|${Math.round(timeMs)}|${look[0].toFixed(3)},${look[1].toFixed(3)}`;
          if (boxRef.current.key !== key) {
            boxRef.current = {
              key,
              box: groupBox(LarkRuntime, data, stateId, clipName, timeMs, look, sel),
            };
          }
          const b = boxRef.current.box;
          if (b) {
            const pad = 3;
            ctx.save();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 3]);
            ctx.strokeRect(
              b.x0 - pad + 0.5, b.y0 - pad + 0.5,
              (b.x1 - b.x0) + pad * 2, (b.y1 - b.y0) + pad * 2,
            );
            // Corner ticks, so a box round the whole pair still reads as a selection rather than
            // as a frame someone drew on the panel.
            ctx.setLineDash([]);
            ctx.lineWidth = 2;
            const len = 7;
            const corners = [
              [b.x0 - pad, b.y0 - pad, 1, 1],
              [b.x1 + pad, b.y0 - pad, -1, 1],
              [b.x0 - pad, b.y1 + pad, 1, -1],
              [b.x1 + pad, b.y1 + pad, -1, -1],
            ];
            for (const [cx, cy, sx, sy] of corners) {
              ctx.beginPath();
              ctx.moveTo(cx + sx * len, cy);
              ctx.lineTo(cx, cy);
              ctx.lineTo(cx, cy + sy * len);
              ctx.stroke();
            }
            ctx.restore();
          }
        }
      }
      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
    // stateId belongs here: the group box is computed inside the loop and keyed on it, so leaving
    // it out would keep drawing the previous state's box after a state change.
  }, [data, stateId, clipName, timeMs, background, look]);

  // Canvas-relative position in PANEL units. The canvas is displayed larger than its 240px backing
  // store, so a CSS pixel is not a panel pixel and using one for the other picks the wrong place.
  const panelPos = (e, el) => {
    const r = el.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * PANEL,
      y: ((e.clientY - r.top) / r.height) * PANEL,
    };
  };

  // Press: pick the node under the cursor and arm a drag.
  //
  // Alt selects the containing GROUP instead of the leaf, which is the only way to reach `eyes` or
  // `group_eye_*` from the stage — they draw nothing of their own, so the id pass can never return
  // one. Alt+alt again walks further up, so a second press on a pupil reaches `eyes`.
  const handleDown = (e) => {
    if (!onPick) return;
    const { x, y } = panelPos(e, e.currentTarget);
    let hit = hitTest(LarkRuntime, data, stateId, clipName, timeMs, look, x, y);
    if (!hit) return;

    if (e.altKey) {
      const objs = data.states?.[stateId]?.objs || {};
      // Walk up from whatever is currently selected if it is already an ancestor of the hit, so
      // repeated alt-presses climb: pup_l -> group_eye_l -> eyes.
      const chain = [];
      for (let n = hit; n; ) {
        const parent = Object.keys(objs).find((k) => (objs[k].ch || []).includes(n));
        if (!parent) break;
        chain.push(parent);
        n = parent;
      }
      // If an ancestor is already selected, climb past it; otherwise start at the direct parent.
      // `indexOf` gives -1 when the selection is unrelated, and -1 + 1 is 0 — the direct parent —
      // which is the behaviour wanted, but only by accident, so it is written out.
      const at = chain.indexOf(selected);
      hit = (at >= 0 ? chain[at + 1] : chain[0]) ?? chain[0] ?? hit;
    }

    onPick(hit);

    // Groups carry no geometry, so there is nothing to translate — dragging one would have to move
    // its children, and that is a different edit from the one this gesture makes.
    const isGroup = data.states?.[stateId]?.objs?.[hit]?.type === 'group';
    if (!isGroup && onMove) {
      e.currentTarget.setPointerCapture(e.pointerId);
      // `applied` tracks how far the node has ACTUALLY been moved, which is not the same as how far
      // the cursor has travelled: the data stores tenths, so each step is rounded. Accumulating raw
      // deltas would let that rounding error compound and the node drift away from the cursor over
      // a long drag. Measuring against the drag's origin each time keeps them together.
      dragRef.current = { node: hit, originX: x, originY: y, appliedX: 0, appliedY: 0 };
    }
  };

  const handleMove = (e) => {
    const drag = dragRef.current;
    if (drag) {
      const { x, y } = panelPos(e, e.currentTarget);
      // Panel pixels back into authoring units: the scene is drawn at SCENE_SCALE, so a 1px drag on
      // screen is 1/0.65 units in the data. Without this the node lags the cursor by a third.
      const wantX = (x - drag.originX) / SCENE_SCALE;
      const wantY = (y - drag.originY) / SCENE_SCALE;
      // Send only the part not yet applied, and remember what the data rounded it to.
      const stepX = Math.round((wantX - drag.appliedX) * 10) / 10;
      const stepY = Math.round((wantY - drag.appliedY) * 10) / 10;
      if (stepX || stepY) {
        drag.appliedX += stepX;
        drag.appliedY += stepY;
        onMove(drag.node, stepX, stepY);
      }
      return;
    }

    // Not dragging: the pointer drives the gaze. The normalisation is the original's own — unit
    // direction times distance over the smaller WINDOW dimension, capped at 2 — copied from
    // artifact-page.js rather than re-derived, so the preview matches the published page.
    const r = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const mag = Math.hypot(dx, dy);
    if (!mag) return onLook([0, 0]);
    const scale = Math.min(mag / Math.min(window.innerWidth, window.innerHeight), 2);
    onLook([(dx / mag) * scale, (dy / mag) * scale]);
  };

  const handleUp = () => { dragRef.current = null; };

  return (
    <div className="bezel">
      <canvas
        ref={canvasRef}
        width={PANEL}
        height={PANEL}
        style={{ cursor: onMove ? 'move' : (onPick ? 'pointer' : 'default') }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onPointerLeave={() => { if (!dragRef.current) onLook([0, 0]); }}
      />
    </div>
  );
}
