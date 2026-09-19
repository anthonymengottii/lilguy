import { useCallback, useMemo, useRef, useState } from 'react';
import { CURVES } from '@lark';
import { FIELDS, lanesOf } from './clipOps';

// The curve editor: value against time, one line per component, keyframes draggable in both axes.
//
// This is the difference between reading a clip and authoring one. A row of diamonds tells you WHEN
// something happens; this tells you what it does in between, which is where the easing lives — and
// the easing is where this data hides its subtleties. `blink` reopens on the curve of the keyframe
// it LEAVES, not the one it approaches, and read the other way round the eye stays shut 480ms
// against the original's 150-300. On a graph that is visible; in a list of numbers it is not.
//
// THE CURVES ARE THE RUNTIME'S OWN. CURVES is imported from lark.js rather than reimplemented here,
// so the line drawn is the line played. An approximation would look plausible and lie — curve 0 in
// particular is a STEP that holds its source value, and drawing it as a ramp would misrepresent
// every keyframe that uses it.

const PAD = { l: 48, r: 14, t: 14, b: 20 };
const MIN_H = 180;

// Per-component colours. Distinct in both themes, and consistent across lanes so `x` is always the
// same colour whichever lane is open.
const SERIES = ['#4a90d9', '#d98a4a', '#5fa86b'];

const curveFn = (c) => (c in CURVES ? CURVES[c] : CURVES[24]);

// A keyframe's numeric components, whatever its shape. `u: true` means "the node's rest value",
// which has no number of its own — the runtime substitutes the node's own, and on a graph the
// honest thing is to draw it at the rest baseline rather than invent a height.
function componentsOf(key, keypath, restValue) {
  const names = FIELDS[keypath] || ['v'];
  if (key.u) return names.map(() => restValue);
  if (Array.isArray(key.v)) return names.map((_, i) => Number(key.v[i] ?? 0));
  if (typeof key.v === 'number') return names.map((_, i) => (i === 0 ? key.v : 0));
  // `r` and `t3d` carry an object: the angle is what animates, the anchors ride along.
  if (key.v && typeof key.v === 'object') return names.map((_, i) => (i === 0 ? Number(key.v.ang ?? 0) : 0));
  return names.map(() => 0);
}

// What `u: true` resolves to per keypath — a scale rests at 1, a translation at 0.
function restFor(keypath) {
  return keypath === 's' || keypath === 'o' ? 1 : 0;
}

export default function CurveGraph({
  clip, lane, laneIndex, selection, onSelect, onMoveKey, onSetComponent, onScrub, timeMs,
  width, height,
}) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const [hidden, setHidden] = useState(() => new Set());

  const duration = clip?.durationMs || 1;
  const keypath = lane?.head?.keypath;
  const names = FIELDS[keypath] || ['v'];
  const isPath = keypath === 'p';

  // The graph fills whatever the pane gives it: it is the working surface, so it gets the room.
  const W = Math.max(320, width || 640);
  const H = Math.max(MIN_H, height || 240);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  // The value range, from the data itself plus a margin, so a lane that barely moves still fills the
  // graph rather than sitting as a flat line at the bottom.
  const { lo, hi } = useMemo(() => {
    if (!lane || isPath) return { lo: 0, hi: 1 };
    const rest = restFor(keypath);
    let min = Infinity, max = -Infinity;
    for (const k of lane.keys) {
      for (const v of componentsOf(k, keypath, rest)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min)) return { lo: 0, hi: 1 };
    if (max - min < 1e-6) { min -= 0.5; max += 0.5; }
    const pad = (max - min) * 0.15;
    return { lo: min - pad, hi: max + pad };
  }, [lane, keypath, isPath]);

  const xOf = useCallback((t) => PAD.l + (t / duration) * plotW, [duration, plotW]);
  const yOf = useCallback((v) => PAD.t + plotH - ((v - lo) / (hi - lo)) * plotH, [lo, hi, plotH]);
  const tOf = useCallback((px) => ((px - PAD.l) / plotW) * duration, [duration, plotW]);
  const vOf = useCallback((py) => lo + ((PAD.t + plotH - py) / plotH) * (hi - lo), [lo, hi, plotH]);

  // The played line, sampled through the runtime's own easing. Sampling rather than emitting a
  // Bezier `d`: the curves are arbitrary functions, and only sampling is guaranteed to show what
  // actually plays — including curve 0, which holds flat and then jumps.
  const paths = useMemo(() => {
    if (!lane || isPath) return [];
    const rest = restFor(keypath);
    const keys = lane.keys;
    if (keys.length < 1) return [];
    return names.map((_, ci) => {
      const pts = [];
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i], b = keys[i + 1];
        const va = componentsOf(a, keypath, rest)[ci];
        const vb = componentsOf(b, keypath, rest)[ci];
        const fn = curveFn(a.c ?? 24);                 // the EARLIER keyframe's curve
        const span = Math.max(1, b.t - a.t);
        const steps = Math.max(2, Math.min(64, Math.round(span / 12)));
        for (let s = 0; s <= steps; s++) {
          const t = a.t + (span * s) / steps;
          const u = fn(s / steps);
          pts.push([xOf(t), yOf(va + (vb - va) * u)]);
        }
      }
      if (keys.length === 1) {
        const v = componentsOf(keys[0], keypath, rest)[ci];
        pts.push([xOf(0), yOf(v)], [xOf(duration), yOf(v)]);
      }
      return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    });
  }, [lane, keypath, names, isPath, xOf, yOf, duration]);

  const startDrag = useCallback((e, keyIndex, componentIndex) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { keyIndex, componentIndex, moved: false };
    onSelect({ laneIndex, keyIndex });
  }, [laneIndex, onSelect]);

  const onDrag = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const r = svgRef.current.getBoundingClientRect();
    const t = Math.max(0, Math.min(duration, tOf(e.clientX - r.left)));
    onMoveKey(laneIndex, d.keyIndex, t);
    // Vertical drag edits the value, so one gesture sets both when and how much. Shift constrains
    // to time only, for retiming without disturbing a value that is already right.
    if (!e.shiftKey && !isPath) {
      onSetComponent(laneIndex, d.keyIndex, d.componentIndex, round(vOf(e.clientY - r.top), keypath));
    }
    d.moved = true;
  }, [duration, tOf, vOf, onMoveKey, onSetComponent, laneIndex, isPath, keypath]);

  const endDrag = useCallback(() => { dragRef.current = null; }, []);

  if (!lane) return <p className="hint">Selecione uma lane para ver a curva.</p>;

  if (isPath) {
    return (
      <div className="curve-empty">
        <p className="hint">
          <b>{lane.head.object}</b> — contorno de pálpebra. São 24 números de Bézier por keyframe,
          uma forma e não um valor, então não há curva para desenhar aqui. Os keyframes continuam
          arrastáveis no tempo pela timeline.
        </p>
      </div>
    );
  }

  const rest = restFor(keypath);
  const gridVals = [hi, lo + (hi - lo) / 2, lo];

  return (
    <div className="curve">
      <div className="curve-legend">
        <span className="lane-target">
          <b>{lane.head.object || '(raiz)'}</b> · {keypath}
        </span>
        {names.map((nm, i) => (
          <button
            type="button"
            key={nm}
            className={`series${hidden.has(i) ? ' off' : ''}`}
            style={{ '--c': SERIES[i % SERIES.length] }}
            onClick={() => setHidden((h) => {
              const next = new Set(h);
              if (next.has(i)) next.delete(i); else next.add(i);
              return next;
            })}
            title="mostrar/ocultar"
          >
            <i /> {nm}
          </button>
        ))}
        <span className="hint small nowrap">arraste: tempo + valor · shift: só tempo</span>
      </div>

      <svg
        ref={svgRef}
        className="curve-svg"
        width={W}
        height={H}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerDown={(e) => {
          if (dragRef.current) return;
          const r = svgRef.current.getBoundingClientRect();
          onScrub(Math.max(0, Math.min(duration, tOf(e.clientX - r.left))));
        }}
      >
        {gridVals.map((v, i) => (
          <g key={i}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={yOf(v)} y2={yOf(v)} />
            <text className="axis" x={PAD.l - 6} y={yOf(v) + 3} textAnchor="end">{fmtVal(v)}</text>
          </g>
        ))}
        {/* The rest baseline, where `u: true` keyframes sit. */}
        {rest >= lo && rest <= hi && (
          <line className="rest" x1={PAD.l} x2={W - PAD.r} y1={yOf(rest)} y2={yOf(rest)} />
        )}

        <line className="playhead-line" x1={xOf(timeMs)} x2={xOf(timeMs)} y1={PAD.t} y2={PAD.t + plotH} />

        {paths.map((d, ci) => hidden.has(ci) ? null : (
          <path key={ci} className="curve-line" d={d} style={{ stroke: SERIES[ci % SERIES.length] }} />
        ))}

        {lane.keys.map((k, ki) => {
          const vals = componentsOf(k, keypath, rest);
          return names.map((_, ci) => {
            if (hidden.has(ci)) return null;
            const isSel = selection && selection.laneIndex === laneIndex && selection.keyIndex === ki;
            return (
              <circle
                key={`${ki}:${ci}`}
                className={`curve-key${isSel ? ' sel' : ''}${k.u ? ' rest' : ''}`}
                cx={xOf(k.t)}
                cy={yOf(vals[ci])}
                r={isSel ? 6 : 4.5}
                style={{ '--c': SERIES[ci % SERIES.length] }}
                onPointerDown={(e) => startDrag(e, ki, ci)}
                onPointerMove={onDrag}
                onPointerUp={endDrag}
              >
                <title>{`${k.t} ms · ${names[ci]} ${fmtVal(vals[ci])}${k.u ? ' (repouso)' : ''}`}</title>
              </circle>
            );
          });
        })}

        <text className="axis" x={PAD.l} y={H - 6}>0</text>
        <text className="axis" x={W - PAD.r} y={H - 6} textAnchor="end">{(duration / 1000).toFixed(2)}s</text>
      </svg>
    </div>
  );
}

// Snap to the precision each keypath is authored at, so dragging does not produce 4.999999998.
function round(v, keypath) {
  if (keypath === 's' || keypath === 'o') return Math.round(v * 100) / 100;
  if (keypath === 'r' || keypath === 't3d') return Math.round(v * 1000) / 1000;
  return Math.round(v * 10) / 10;
}

function fmtVal(v) {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export { lanesOf };
