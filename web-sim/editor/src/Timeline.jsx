import { useCallback, useRef } from 'react';
import { KEYPATH_LABEL, lanesOf } from './clipOps';

// The lane tracks, one row per lane, keyframes draggable along them.
//
// `p` lanes -- the eyelid outlines -- are shown but their keyframes are marked read-only for VALUE.
// They can still be dragged in TIME, which is the useful half: retiming a blink is a real edit, and
// the shape itself needs a vector editor this app deliberately does not have (24 Bezier numbers per
// keyframe, authored in whatever tool the site's makers used).

function fmt(ms) { return `${(ms / 1000).toFixed(2)}s`; }

export default function Timeline({
  clip, clipName, selection, onSelect, onMoveKey, onScrub, timeMs,
}) {
  const dragRef = useRef(null);
  const duration = clip?.durationMs || 1;

  // Pointer capture on the track, so a drag that leaves the row vertically still tracks horizontally
  // -- without it the keyframe is dropped the moment the cursor drifts, which feels broken.
  const startDrag = useCallback((e, laneIndex, keyIndex) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const track = e.currentTarget.parentElement;
    dragRef.current = { laneIndex, keyIndex, track };
    onSelect({ laneIndex, keyIndex });
  }, [onSelect]);

  const onDrag = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const r = d.track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    onMoveKey(d.laneIndex, d.keyIndex, frac * duration);
  }, [duration, onMoveKey]);

  const endDrag = useCallback(() => { dragRef.current = null; }, []);

  if (!clip) return <p className="hint">Nenhum clipe selecionado.</p>;

  const lanes = lanesOf(clip);
  if (!lanes.length) {
    return (
      <p className="hint">
        Este clipe não tem lanes ainda. Adicione uma abaixo para começar a animar.
      </p>
    );
  }

  return (
    <div className="timeline">
      {/* The playhead spans every track, so a keyframe's position relative to the current time is
          readable without counting pixels. */}
      <div className="ruler" onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onScrub(((e.clientX - r.left) / r.width) * duration);
      }}>
        <span>0</span>
        <span>{fmt(duration / 2)}</span>
        <span>{fmt(duration)}</span>
        <div className="playhead" style={{ left: `${(timeMs / duration) * 100}%` }} />
      </div>

      {lanes.map(({ head, keys, index }) => {
        const readOnly = head.keypath === 'p';
        return (
          <div className="lane" key={`${clipName}:${index}`}>
            {/* Clicking the name opens this lane in the curve graph without disturbing which
                keyframe is selected for editing -- selecting keyframe 0 as a side effect of
                switching lanes would silently retarget the inspector. */}
            <button
              type="button"
              className={`lane-name${selection?.laneIndex === index ? ' active' : ''}`}
              onClick={() => onSelect({ laneIndex: index, keyIndex: 0 })}
            >
              <b>{head.object || '(raiz)'}</b>
              <span className="kp">{KEYPATH_LABEL[head.keypath] || head.keypath}</span>
              {readOnly && <span className="ro" title="Contorno de pálpebra: 24 números de Bézier por keyframe. Editável no tempo, não na forma.">forma fixa</span>}
            </button>
            <div
              className="track"
              onPointerMove={onDrag}
              onPointerUp={endDrag}
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onScrub(((e.clientX - r.left) / r.width) * duration);
              }}
            >
              <div className="playhead thin" style={{ left: `${(timeMs / duration) * 100}%` }} />
              {keys.map((k, ki) => {
                const isSel = selection
                  && selection.laneIndex === index
                  && selection.keyIndex === ki;
                return (
                  <button
                    type="button"
                    key={ki}
                    className={`key${isSel ? ' sel' : ''}${readOnly ? ' ro' : ''}`}
                    style={{ left: `${(k.t / duration) * 100}%` }}
                    title={`${k.t} ms${k.u ? ' — valor de repouso' : ''}`}
                    onPointerDown={(e) => startDrag(e, index, ki)}
                    onPointerMove={onDrag}
                    onPointerUp={endDrag}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
