import { HOLE, isHole } from './clipOps';

// The selected node's colour.
//
// Colour lives on the node inside the STATE, not on the runtime — `LarkRuntime.setColour` exists
// and is what the published page uses, but a runtime override is not part of the document and
// would vanish on export. Editing `objs[node].c` means the change travels: export the JSON, run
// tools/lark_pack.py, and the device draws it.
//
// `000000` IS A HOLE, not black. Twenty of the 36 states colour their pupils that way and the
// renderer punches them out of the eye rather than filling them — what shows through is the
// background. So the swatch and the hole are separate controls:
//
//   - the swatch always PAINTS. Whatever colour it is given is the colour that is drawn.
//   - "buraco" sets `000000`, which punches.
//
// The one thing this cannot offer is a pupil painted pure black. The format has exactly one value
// for a hole and it is black, and it survives no disambiguation: 010101 and 020202 both quantise
// to 0x0000 in RGB565, so on the device a "nearly black" fill is bit-identical to the hole. Rather
// than ship a trick that works in the browser and fails on the panel, the panel says so.

export default function ColourPanel({ node, colour, onChange, onHole, isGroup, contains }) {
  if (!node) {
    return <p className="hint small">Clique num objeto na lista ou no palco.</p>;
  }

  // A group paints nothing — it is a handle for moving several nodes at once, which is how `rot`
  // turns the pair and `rot3d_2` turns one eye about its own anchor. Offering it a colour swatch
  // would be a control that does nothing.
  if (isGroup) {
    return (
      <div className="colour-panel">
        <div className="prop">
          <span>objeto</span>
          <b>{node}</b>
        </div>
        <div className="prop">
          <span>tipo</span>
          <span>grupo</span>
        </div>
        <div className="prop">
          <span>contém</span>
          <span>{contains?.length ?? 0}</span>
        </div>
        <p className="hint small">
          Grupos não têm cor nem contorno próprios. Uma lane aqui move tudo que ele contém —
          é assim que <code>rot</code> gira o par e <code>rot3d_2</code> gira cada olho.
        </p>
      </div>
    );
  }

  const hole = isHole(colour);
  // The swatch cannot show a hole — there is no colour to show — so it falls back to the eye's own
  // green while the hole is active, and the checkbox below says what is really set.
  const swatch = hole ? '#6ff5d0' : `#${colour}`;

  return (
    <div className="colour-panel">
      <div className="prop">
        <span>objeto</span>
        <b>{node}</b>
      </div>

      <div className="prop">
        <span>cor</span>
        <input
          type="color"
          value={swatch}
          disabled={hole}
          onChange={(e) => onChange(e.target.value.replace(/^#/, '').toUpperCase())}
        />
      </div>

      <div className="prop">
        <span>buraco</span>
        <input
          type="checkbox"
          checked={hole}
          onChange={(e) => (e.target.checked ? onHole() : onChange('6FF5D0'))}
        />
      </div>

      <p className="hint small">
        {hole
          ? <>Perfurado: o nó recorta o que está atrás em vez de pintar. É assim que 20 dos 36
             estados desenham as pupilas.</>
          : <>Pintado com <code>#{colour}</code>.</>}
      </p>

      {!hole && colour === HOLE && (
        <p className="warn">
          <b>Preto puro não é pintável.</b> O formato usa <code>000000</code> para buraco e não tem
          outro valor: no painel, qualquer preto vira <code>0x0000</code> em RGB565, igual ao
          buraco. Use um cinza bem escuro, ou marque buraco.
        </p>
      )}
    </div>
  );
}
