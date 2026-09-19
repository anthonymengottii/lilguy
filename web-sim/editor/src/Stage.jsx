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
function hitTest(LarkRuntimeCtor, data, stateId, clipName, timeMs, look, x, y) {
  const probe = document.createElement('canvas');
  probe.width = PANEL;
  probe.height = PANEL;
  const ctx = probe.getContext('2d', { willReadFrequently: true });

  const rt = new LarkRuntimeCtor(data, stateId);
  const names = Object.keys(rt.objs).filter((n) => rt.objs[n]?.type !== 'group');

  // One flat colour per node, spread far enough apart that an antialiased edge cannot be mistaken
  // for a neighbour: index i becomes (i+1)*16 in the red channel.
  names.forEach((n, i) => rt.setColour(n, ((i + 1) * 16).toString(16).padStart(2, '0') + '0000'));

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

  const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  if (px[3] < 128) return null;                       // nothing drawn here
  const idx = Math.round(px[0] / 16) - 1;
  return names[idx] ?? null;
}

export default function Stage({
  data, stateId, clipName, timeMs, background, look, onLook, onPick, onMove, selected,
}) {
  const canvasRef = useRef(null);
  const rtRef = useRef(null);
  const frameRef = useRef(null);
  const dragRef = useRef(null);
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

        // Mark the selected node. Drawn as its own path in the SAME transform the scene just used,
        // so the outline lands exactly where the node is — including whatever the gaze and the
        // running clip have done to it this frame.
        const sel = selectedRef.current;
        if (sel && rt.objs[sel]) {
          const p = rt.channelsFor(sel, now).p || rt.objs[sel].p;
          if (p) {
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
        }
      }
      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [data, clipName, timeMs, background, look]);

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
  const handleDown = (e) => {
    if (!onPick) return;
    const { x, y } = panelPos(e, e.currentTarget);
    const hit = hitTest(LarkRuntime, data, stateId, clipName, timeMs, look, x, y);
    if (hit) onPick(hit);
    if (hit && onMove) {
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
