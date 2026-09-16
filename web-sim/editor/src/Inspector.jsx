import { CURVE_OPTIONS, FIELDS, KEYPATH_LABEL } from './clipOps';

// The selected keyframe's fields.
//
// Every control here edits through a pure op in clipOps.js, tagged with a mergeKey so that dragging
// a number does not fill the undo stack with one entry per pixel.

function stepFor(keypath) {
  if (keypath === 's' || keypath === 'o') return 0.05;      // ratios
  if (keypath === 'r' || keypath === 't3d') return 0.01;    // turns, not degrees
  return 1;                                                 // pixels
}

export default function Inspector({ clip, selection, ops }) {
  if (!clip || !selection) {
    return <p className="hint">Clique num keyframe na timeline para editar.</p>;
  }
  const head = clip.lanes[selection.laneIndex];
  const key = clip.lanes[selection.laneIndex + 1]?.[selection.keyIndex];
  if (!head || !key) return <p className="hint">Keyframe não encontrado.</p>;

  const kp = head.keypath;
  const isPath = kp === 'p';
  const names = FIELDS[kp] || ['valor'];
  const mergeBase = `${selection.laneIndex}:${selection.keyIndex}`;

  return (
    <div className="inspector">
      <div className="insp-head">
        <b>{head.object || '(raiz)'}</b>
        <span className="kp">{KEYPATH_LABEL[kp] || kp}</span>
      </div>

      <label className="field">
        <span>tempo (ms)</span>
        <input
          type="number"
          min={0}
          max={clip.durationMs}
          value={key.t}
          onChange={(e) => ops.setKeyTime(selection, Number(e.target.value) || 0, `${mergeBase}:t`)}
        />
      </label>

      {isPath ? (
        <p className="hint">
          Contorno de pálpebra: 24 números de Bézier por keyframe. Este editor move o keyframe no
          tempo, mas não edita a forma — isso exigiria um editor de curvas, e uma edição parcial
          (escalar o contorno inteiro, por exemplo) produziria formas que a autoria original nunca
          fez. As formas vêm dos 36 estados.
        </p>
      ) : (
        <>
          <label className="field check">
            <input
              type="checkbox"
              checked={!!key.u}
              onChange={(e) => ops.setKeyRest(selection, e.target.checked)}
            />
            <span>usar valor de repouso do nó</span>
          </label>

          {!key.u && names.map((nm, idx) => {
            const value = Array.isArray(key.v) ? (key.v[idx] ?? 0) : (key.v ?? 0);
            return (
              <label className="field" key={nm}>
                <span>{nm}</span>
                <input
                  type="number"
                  step={stepFor(kp)}
                  value={value}
                  onChange={(e) => ops.setKeyComponent(
                    selection, idx, Number(e.target.value) || 0, `${mergeBase}:${idx}`,
                  )}
                />
              </label>
            );
          })}
        </>
      )}

      <label className="field">
        <span>curva</span>
        <select
          value={key.c ?? 24}
          onChange={(e) => ops.setKeyCurve(selection, Number(e.target.value))}
        >
          {CURVE_OPTIONS.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </label>

      <p className="hint small">
        A curva de um segmento é a do keyframe de onde ele <i>sai</i>, não a do keyframe aonde
        chega. Lendo ao contrário, <code>blink</code> reabre sob uma curva lenta e o olho fica
        fechado 480ms — a original pisca entre 150 e 300ms.
      </p>

      <div className="row">
        <button type="button" onClick={() => ops.removeKey(selection)}>remover keyframe</button>
        <button type="button" className="danger" onClick={() => ops.removeLane(selection.laneIndex)}>
          remover lane
        </button>
      </div>
    </div>
  );
}
