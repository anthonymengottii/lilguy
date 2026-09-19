import { KEYPATH_LABEL, lanesOf } from './clipOps';

// The lane names, on their rail beside the keyframe ruler — the two line up row for row, the way
// the original tool's do. Clicking a name opens that lane in the curve graph.
//
// `p` lanes are listed but marked: they carry the eyelid outline as 24 Bezier numbers per keyframe,
// which this editor retimes but does not reshape.

export default function LaneList({ clip, clipName, selection, onSelect }) {
  if (!clip) return <p className="hint small" style={{ padding: '.4rem' }}>Nenhum clipe.</p>;

  const lanes = lanesOf(clip);
  if (!lanes.length) {
    return (
      <p className="hint small" style={{ padding: '.4rem' }}>
        Sem lanes. Escolha um objeto e adicione uma abaixo.
      </p>
    );
  }

  return (
    <div className="lanes">
      {lanes.map(({ head, keys, index }) => {
        const readOnly = head.keypath === 'p';
        const active = selection?.laneIndex === index;
        return (
          <button
            key={`${clipName}:${index}`}
            type="button"
            className={`lane-name${active ? ' active' : ''}`}
            // Selecting keyframe 0 opens the lane in the graph without needing a separate notion of
            // "current lane" that could drift from the current selection.
            onClick={() => onSelect({ laneIndex: index, keyIndex: 0 })}
            title={readOnly
              ? 'contorno de pálpebra: 24 números de Bézier por keyframe, editável no tempo'
              : `${head.object || '(raiz)'} · ${head.keypath}`}
          >
            <b>{head.object || '(raiz)'}</b>
            <span className="kp">
              {KEYPATH_LABEL[head.keypath] || head.keypath}
              {' · '}{keys.length}
              {readOnly && <span className="ro"> · forma fixa</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
