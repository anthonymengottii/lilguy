import { useCallback, useRef } from 'react';

// A direct control for the gaze, so a specific angle can be dialled in and held — without keeping
// the mouse parked over the disc, which is what Stage's pointer handler otherwise requires: it
// drives `look` from `pointermove` and resets it to [0, 0] the moment the cursor leaves the canvas.
//
// The range is ±2, matching LOOK_CAP in lark.js exactly — not ±1. The mouse-driven gaze on the
// stage rarely exceeds ~1 in practice (it is unit direction times distance over the smaller WINDOW
// dimension), but the runtime's own ceiling is 2, and clips like `idle` add their own offset on top
// of the pointer's. A pad capped at 1 would make some on-device angles impossible to dial in here.

const SIZE = 120;   // px, the square's rendered side
const RANGE = 2;    // -RANGE..RANGE maps to the full square

export default function LookPad({ look, onChange }) {
  const padRef = useRef(null);

  const fromEvent = useCallback((e) => {
    const r = padRef.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;   // -1..1 across the pad
    const y = ((e.clientY - r.top) / r.height) * 2 - 1;
    return [
      Math.max(-RANGE, Math.min(RANGE, x * RANGE)),
      Math.max(-RANGE, Math.min(RANGE, y * RANGE)),
    ];
  }, []);

  const dragging = useRef(false);
  const onDown = (e) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(fromEvent(e));
  };
  const onMove = (e) => { if (dragging.current) onChange(fromEvent(e)); };
  const onUp = () => { dragging.current = false; };

  const px = ((look[0] / RANGE) * 0.5 + 0.5) * SIZE;
  const py = ((look[1] / RANGE) * 0.5 + 0.5) * SIZE;

  return (
    <div className="lookpad">
      <div
        ref={padRef}
        className="lookpad-square"
        style={{ width: SIZE, height: SIZE }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div className="lookpad-cross" />
        <div className="lookpad-dot" style={{ left: px, top: py }} />
      </div>
      <div className="lookpad-fields">
        <label className="field">
          <span>x</span>
          <input
            type="number"
            step="0.05"
            min={-RANGE}
            max={RANGE}
            value={round2(look[0])}
            onChange={(e) => onChange([clamp(Number(e.target.value)), look[1]])}
          />
        </label>
        <label className="field">
          <span>y</span>
          <input
            type="number"
            step="0.05"
            min={-RANGE}
            max={RANGE}
            value={round2(look[1])}
            onChange={(e) => onChange([look[0], clamp(Number(e.target.value))])}
          />
        </label>
        <button type="button" onClick={() => onChange([0, 0])}>centro</button>
      </div>
    </div>
  );
}

function clamp(v) {
  if (Number.isNaN(v)) return 0;
  return Math.max(-RANGE, Math.min(RANGE, v));
}
function round2(v) {
  return Math.round(v * 100) / 100;
}
