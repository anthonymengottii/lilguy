import { useEffect, useRef } from 'react';
import { LarkRuntime } from '@lark';

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

export default function Stage({ data, stateId, clipName, timeMs, background, look, onLook }) {
  const canvasRef = useRef(null);
  const rtRef = useRef(null);
  const frameRef = useRef(null);

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
        ctx.clearRect(0, 0, PANEL, PANEL);
        rt.draw(ctx, now, { width: PANEL, height: PANEL, background });
      }
      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [data, clipName, timeMs, background, look]);

  // The pointer normalisation is the original's own: unit direction times distance over the smaller
  // WINDOW dimension, capped at 2. Copied from artifact-page.js rather than re-derived, so the
  // preview's gaze matches the published page's exactly.
  const handleMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const mag = Math.hypot(dx, dy);
    if (!mag) return onLook([0, 0]);
    const scale = Math.min(mag / Math.min(window.innerWidth, window.innerHeight), 2);
    onLook([(dx / mag) * scale, (dy / mag) * scale]);
  };

  return (
    <div className="bezel">
      <canvas
        ref={canvasRef}
        width={PANEL}
        height={PANEL}
        onPointerMove={handleMove}
        onPointerLeave={() => onLook([0, 0])}
      />
    </div>
  );
}
