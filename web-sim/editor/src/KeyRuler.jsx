import { useCallback, useRef } from 'react';

// The keyframe ruler: one row per lane, every keyframe as a diamond, draggable along time.
//
// It sits directly above the curve graph and lines up with the lane rail beside it, so a lane's
// name, its keyframe times, and its curve are read across one horizontal band — which is how the
// original tool arranges the same three things.
//
// Dragging here moves a keyframe in TIME ONLY. Value editing belongs to the graph below, where
// there is a vertical axis to mean something.

// Row height and header depth come from the stylesheet, so the ruler and the lane rail beside it
// cannot drift apart: they are one band read across, and two hardcoded numbers in two files is
// exactly how that band gets out of step.
const CSS = getComputedStyle(document.documentElement);
const ROW = parseFloat(CSS.getPropertyValue('--lane-row')) || 30;
const HEAD = parseFloat(CSS.getPropertyValue('--ruler-head')) || 18;
const PAD = 8;

export default function KeyRuler({ clip, lanes, selection, onSelect, onMoveKey, onScrub, timeMs }) {
  const hostRef = useRef(null);
  const dragRef = useRef(null);

  const duration = clip?.durationMs || 1;

  const startDrag = useCallback((e, laneIndex, keyIndex) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { laneIndex, keyIndex };
    onSelect({ laneIndex, keyIndex });
  }, [onSelect]);

  const onDrag = useCallback((e) => {
    const d = dragRef.current;
    if (!d || !hostRef.current) return;
    const r = hostRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left - PAD) / (r.width - PAD * 2)));
    onMoveKey(d.laneIndex, d.keyIndex, frac * duration);
  }, [duration, onMoveKey]);

  const endDrag = useCallback(() => { dragRef.current = null; }, []);

  // When the ruler scrolls, the lane names must scroll with it, or a long clip's rows stop naming
  // the keyframes beside them. Driven from here rather than from both: one scroller leads.
  const onScrollSync = useCallback((e) => {
    const rail = document.querySelector('.lane-scroll');
    if (rail) rail.scrollTop = e.currentTarget.scrollTop;
  }, []);

  const scrubTo = useCallback((e) => {
    if (dragRef.current || !hostRef.current) return;
    const r = hostRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left - PAD) / (r.width - PAD * 2)));
    onScrub(frac * duration);
  }, [duration, onScrub]);

  if (!clip || !lanes?.length) {
    return <div className="ruler-strip" style={{ height: `${HEAD + ROW * 2}px` }} />;
  }

  // A tick roughly every 200ms, rounded to something readable.
  const step = niceStep(duration);
  const ticks = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);

  const pct = (t) => `calc(${PAD}px + ${(t / duration) * 100}% - ${(PAD * 2 * t) / duration}px)`;

  return (
    <div className="ruler-scroll" onScroll={onScrollSync}>
    <div
      ref={hostRef}
      className="ruler-strip"
      style={{ height: `${HEAD + lanes.length * ROW}px` }}
      onPointerDown={scrubTo}
      onPointerMove={onDrag}
      onPointerUp={endDrag}
    >
      {ticks.map((t) => (
        <div className="tick" key={t} style={{ left: pct(t) }}>
          <span>{t === 0 ? '0' : `${(t / 1000).toFixed(2)}s`}</span>
        </div>
      ))}

      {lanes.map(({ head, keys, index }, row) => {
        const readOnly = head.keypath === 'p';
        return keys.map((k, ki) => {
          const sel = selection?.laneIndex === index && selection?.keyIndex === ki;
          return (
            <button
              type="button"
              key={`${index}:${ki}`}
              className={`kf${sel ? ' sel' : ''}${readOnly ? ' ro' : ''}`}
              style={{ left: pct(k.t), top: `${HEAD + row * ROW + ROW / 2}px` }}
              title={`${head.object || '(raiz)'} · ${head.keypath} · ${k.t} ms${k.u ? ' · repouso' : ''}`}
              onPointerDown={(e) => startDrag(e, index, ki)}
              onPointerMove={onDrag}
              onPointerUp={endDrag}
            />
          );
        });
      })}

      <div className="playhead" style={{ left: pct(Math.min(timeMs, duration)) }} />
    </div>
    </div>
  );
}

// A tick spacing that lands on round numbers rather than on whatever duration/5 happens to be.
function niceStep(duration) {
  const target = duration / 5;
  for (const s of [50, 100, 200, 250, 500, 1000, 2000, 5000]) if (s >= target) return s;
  return 10000;
}
