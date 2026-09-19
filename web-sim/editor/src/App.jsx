import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import Stage from './Stage';
import LaneList from './LaneList';
import KeyRuler from './KeyRuler';
import Inspector from './Inspector';
import CurveGraph from './CurveGraph';
import ColourPanel from './ColourPanel';
import { useEditorState } from './useEditorState';
import * as C from './clipOps';
import ANIM_DATA from '@data/anim_data.json';

// The Lark clip editor.
//
// It plays the site's own 15 clips through the real lark.js, lets their numeric lanes be retimed and
// retuned, lets new clips be built from those lanes, and exports anim_data.json in the shape
// tools/lark_pack.py already reads. Nothing here writes to the device: the export is a file, and the
// path to the hardware is the packer plus a reflash.
//
// LAID OUT LIKE THE TOOL THIS DATA CAME FROM: rails for states, clips and objects on the left, the
// stage in the middle, properties on the right, and the keyframe ruler and curve editor across the
// full width underneath. That is not imitation for its own sake — the graph is where authoring
// happens, so it gets the width, and everything that only SELECTS what you are editing stays in
// narrow rails around it.
//
// What it does NOT edit, deliberately: the `p` lanes, which carry the eyelid outlines as 24 Bezier
// numbers per keyframe. Those are shown and retimable but their shape is fixed. Editing them
// properly means a vector editor; editing them improperly (scaling the whole outline, say) produces
// shapes the original authoring never made, and they would be indistinguishable from real data once
// exported.

const PLAY_RATE = 1;

export default function App() {
  const editor = useEditorState(ANIM_DATA);
  const { doc: data, apply } = editor;

  const clipNames = useMemo(() => Object.keys(data.animations).sort(), [data.animations]);
  const stateIds = useMemo(() => Object.keys(data.states), [data.states]);

  const [clipName, setClipName] = useState(() => (clipNames.includes('blink') ? 'blink' : clipNames[0]));
  const [stateId, setStateId] = useState('1b');
  const [selection, setSelection] = useState(null);
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [look, setLook] = useState([0, 0]);
  const [background, setBackground] = useState('#000000');
  const [message, setMessage] = useState('');

  const clip = data.animations[clipName];
  const duration = clip?.durationMs || 1000;

  // ---- playback --------------------------------------------------------------------------------

  const playRef = useRef({ startWall: 0, startMs: 0 });
  useEffect(() => {
    if (!playing) return undefined;
    playRef.current = { startWall: performance.now(), startMs: timeMs };
    let raf;
    const tick = () => {
      const { startWall, startMs } = playRef.current;
      const elapsed = (performance.now() - startWall) * PLAY_RATE + startMs;
      if (clip?.repeat === 'l') {
        setTimeMs(elapsed % duration);
      } else if (elapsed >= duration) {
        setTimeMs(duration);
        setPlaying(false);
        return;
      } else {
        setTimeMs(elapsed);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // timeMs is intentionally NOT a dependency: it changes every frame while playing, and including
    // it would restart the loop on each tick and make playback crawl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, clipName, duration, clip?.repeat]);

  const scrub = useCallback((ms) => {
    setPlaying(false);
    setTimeMs(Math.max(0, Math.min(duration, ms)));
  }, [duration]);

  const selectClip = useCallback((name) => {
    setClipName(name);
    setSelection(null);
    setTimeMs(0);
    setPlaying(false);
  }, []);

  // ---- edits -----------------------------------------------------------------------------------

  // Every op is bound to the current clip here, so the components below never carry the clip name.
  const ops = useMemo(() => ({
    setKeyTime: (sel, t, mk) =>
      apply((d) => C.setKeyTime(d, clipName, sel.laneIndex, sel.keyIndex, t), mk),
    setKeyCurve: (sel, c) =>
      apply((d) => C.setKeyCurve(d, clipName, sel.laneIndex, sel.keyIndex, c)),
    setKeyComponent: (sel, idx, v, mk) =>
      apply((d) => C.setKeyComponent(d, clipName, sel.laneIndex, sel.keyIndex, idx, v), mk),
    setKeyRest: (sel, useRest) =>
      apply((d) => C.setKeyRest(d, clipName, sel.laneIndex, sel.keyIndex, useRest)),
    removeKey: (sel) => {
      apply((d) => C.removeKey(d, clipName, sel.laneIndex, sel.keyIndex));
      setSelection(null);
    },
    removeLane: (laneIndex) => {
      apply((d) => C.removeLane(d, clipName, laneIndex));
      setSelection(null);
    },
  }), [apply, clipName]);

  const moveKey = useCallback((laneIndex, keyIndex, t) => {
    // One merge key per dragged keyframe, so a whole drag is a single undo step.
    apply((d) => C.setKeyTime(d, clipName, laneIndex, keyIndex, t), `drag:${laneIndex}:${keyIndex}`);
    setTimeMs(Math.max(0, Math.min(duration, t)));
  }, [apply, clipName, duration]);

  // The curve graph edits a value by dragging a point vertically. It shares the drag's merge key
  // with moveKey above, so one gesture that changes both time and value is still one undo.
  const setComponentAt = useCallback((laneIndex, keyIndex, component, value) => {
    apply(
      (d) => C.setKeyComponent(d, clipName, laneIndex, keyIndex, component, value),
      `drag:${laneIndex}:${keyIndex}`,
    );
  }, [apply, clipName]);

  // The lane the curve graph is showing: whichever holds the selected keyframe.
  const lanes = useMemo(() => C.lanesOf(clip), [clip]);
  const activeLane = useMemo(() => {
    if (!selection) return lanes[0] || null;
    return lanes.find((l) => l.index === selection.laneIndex) || lanes[0] || null;
  }, [lanes, selection]);

  // The graph is an SVG, so it needs pixel dimensions rather than CSS ones.
  const graphHost = useRef(null);
  const [graphBox, setGraphBox] = useState({ w: 640, h: 240 });
  useEffect(() => {
    const el = graphHost.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      setGraphBox({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- new lane --------------------------------------------------------------------------------

  // The object tree, groups included: a lane on `eyes` moves the pair, a lane on one eye group
  // turns that eye about its own anchor. Those are the two things `rot` and `rot3d` do, and without
  // the groups here they cannot be authored at all.
  const nodeTree = useMemo(() => C.nodeTreeOf(data, stateId), [data, stateId]);
  const nodeNames = useMemo(() => nodeTree.map((n) => n.name), [nodeTree]);
  // One selected object, shared by the tree, the stage and the colour panel. Clicking an eye on the
  // stage and clicking it in the tree are the same act, so they must not be two states that can
  // disagree.
  const [newObj, setNewObj] = useState('');
  const [newKp, setNewKp] = useState('t');
  useEffect(() => { if (!newObj && nodeNames.length) setNewObj(nodeNames[0]); }, [nodeNames, newObj]);

  // Colour lives on the node inside the state, so the edit travels with the exported JSON.
  const selectedNode = data.states?.[stateId]?.objs?.[newObj];
  const selectedColour = selectedNode?.c;
  const setColour = useCallback((hex) => {
    apply((d) => C.setNodeColour(d, stateId, newObj, hex), `colour:${stateId}:${newObj}`);
  }, [apply, stateId, newObj]);

  // ---- file ------------------------------------------------------------------------------------

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'anim_data.json';
    a.click();
    URL.revokeObjectURL(a.href);
    setMessage('anim_data.json baixado — gere o binário com tools/lark_pack.py');
  }, [data]);

  const importJson = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed.animations || !parsed.states) throw new Error('faltam `animations` ou `states`');
        editor.reset(parsed);
        setSelection(null);
        setMessage(`carregado: ${Object.keys(parsed.animations).length} clipes`);
      } catch (err) {
        setMessage(`não deu para ler: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }, [editor]);

  const revert = useCallback(() => {
    editor.reset(ANIM_DATA);
    setSelection(null);
    setMessage('dados originais restaurados');
  }, [editor]);

  // Leaving with unsaved edits loses them: nothing persists this document.
  useEffect(() => {
    const warn = (e) => { if (editor.dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editor.dirty]);

  // ---- keyboard --------------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e) => {
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) editor.redo(); else editor.undo();
        return;
      }
      if (typing) return;
      if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); scrub(timeMs - (e.shiftKey ? 100 : 10)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); scrub(timeMs + (e.shiftKey ? 100 : 10)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, scrub, timeMs]);

  // ---- render ----------------------------------------------------------------------------------

  const groupOnly = clip && C.targetsGroups(clip);
  const hasSelection = Boolean(selection && clip?.lanes?.[selection.laneIndex]);

  const newClip = () => {
    const name = window.prompt('Nome do clipe novo:', 'meu_clipe');
    if (!name) return;
    if (data.animations[name]) { setMessage(`já existe um clipe "${name}"`); return; }
    apply((d) => C.createClip(d, name));
    selectClip(name);
  };

  return (
    <div className="app">
      <header className="titlebar">
        <h1>Lark</h1>
        <span className="spacer" />
        <button type="button" onClick={editor.undo} disabled={!editor.canUndo}>desfazer</button>
        <button type="button" onClick={editor.redo} disabled={!editor.canRedo}>refazer</button>
        <label className="filebtn">
          importar
          <input
            type="file"
            accept="application/json"
            onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])}
          />
        </label>
        <button type="button" onClick={exportJson}>Export anim_data.json</button>
      </header>

      <div className="statusbar">
        <span className="chip">web-sim</span>
        <span>{clipNames.length} animações</span>
        <span>{stateIds.length} estados</span>
        <span className={editor.dirty ? 'dirty' : 'ok'}>
          {editor.dirty ? '● alterado' : '✓ sem alterações'}
        </span>
        <span className="spacer" />
        {message && <span>{message}</span>}
        <span className="nowrap">espaço toca · ←→ 10ms · ctrl+Z desfaz</span>
      </div>

      <div className="workspace">
        {/* What you are looking at, and what is playing on it. */}
        <div className="col">
          <div className="section">
            <div className="section-head">
              <span>Estados</span>
              <span className="spacer" />
              <span>{stateIds.length}</span>
            </div>
            <div className="section-body" style={{ maxHeight: '10rem' }}>
              <div className="list">
                {stateIds.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={s === stateId ? 'sel' : ''}
                    onClick={() => setStateId(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="section grow">
            <div className="section-head">
              <span>Animações</span>
              <span className="spacer" />
              <button type="button" className="icon" title="novo clipe" onClick={newClip}>+</button>
            </div>
            <div className="section-body">
              <div className="list">
                {clipNames.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={n === clipName ? 'sel' : ''}
                    onClick={() => selectClip(n)}
                  >
                    {n}
                    {C.targetsGroups(data.animations[n]) && <span className="tag">grupos</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* The object tree. Groups are listed because a lane on one moves everything inside it. */}
        <div className="col">
          <div className="section grow">
            <div className="section-head"><span>Objetos</span></div>
            <div className="section-body">
              <div className="tree">
                {nodeTree.map(({ name, depth, isGroup }) => {
                  const c = data.states[stateId]?.objs?.[name]?.c;
                  const hole = !isGroup && C.isHole(c);
                  return (
                    <button
                      key={name}
                      type="button"
                      className={name === newObj ? 'sel' : ''}
                      style={{ paddingLeft: `${0.35 + depth * 0.7}rem` }}
                      onClick={() => setNewObj(name)}
                      title={isGroup
                        ? 'grupo — uma lane aqui move tudo que ele contém'
                        : `${name} · ${hole ? 'buraco' : `#${c}`}`}
                    >
                      {/* The dot carries the node's ACTUAL colour, so the tree doubles as a legend.
                          A hole has no colour to show, so it is drawn hollow. */}
                      <i
                        className={`dot${hole ? ' hole' : ''}`}
                        style={!isGroup && !hole ? { background: `#${c}` } : undefined}
                      />
                      <span className={isGroup ? 'grp' : undefined}>{name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* The stage. */}
        <div className="col stage-col">
          <div className="stage-wrap">
            <Stage
              data={data}
              stateId={stateId}
              clipName={clipName}
              timeMs={timeMs}
              background={background}
              look={look}
              onLook={setLook}
              selected={newObj}
              onPick={(n) => n && setNewObj(n)}
            />
          </div>
          <div className="transport">
            <button type="button" className="play" onClick={() => setPlaying((p) => !p)}>
              {playing ? '⏸' : '▶'}
            </button>
            <input
              type="range"
              min={0}
              max={duration}
              step={1}
              value={Math.round(timeMs)}
              onChange={(e) => scrub(Number(e.target.value))}
            />
            <span className="time">
              {(timeMs / 1000).toFixed(2)}s / {(duration / 1000).toFixed(2)}s
            </span>
            <input
              type="color"
              value={background}
              title="cor de fundo"
              onChange={(e) => setBackground(e.target.value)}
            />
          </div>
        </div>

        {/* Properties: the state, the clip, and the selected keyframe. */}
        <div className="col">
          <div className="props">
            <div className="group">
              <div className="group-title">Estado</div>
              <div className="prop"><span>nome</span><span>{stateId}</span></div>
              <div className="prop"><span>objetos</span><span>{nodeTree.length}</span></div>
            </div>

            {/* Colour belongs to the node inside the STATE, not to the clip — which is why it sits
                under the state's own group and changes when you switch states. */}
            <div className="group">
              <div className="group-title">Objeto</div>
              <ColourPanel
                node={selectedNode ? newObj : null}
                colour={selectedColour}
                onChange={setColour}
                onHole={() => setColour(C.HOLE)}
              />
            </div>

            <div className="group">
              <div className="group-title">Animação</div>
              <div className="prop">
                <span>nome</span>
                <button
                  type="button"
                  className="icon"
                  title="renomear"
                  onClick={() => {
                    const to = window.prompt('Novo nome:', clipName);
                    if (!to || to === clipName) return;
                    if (data.animations[to]) { setMessage(`já existe um clipe "${to}"`); return; }
                    apply((d) => C.renameClip(d, clipName, to));
                    selectClip(to);
                  }}
                >
                  {clipName}
                </button>
              </div>
              <div className="prop">
                <span>duração (ms)</span>
                <input
                  type="number"
                  min={1}
                  value={duration}
                  onChange={(e) => apply(
                    (d) => C.setDuration(d, clipName, Number(e.target.value) || 1),
                    'duration',
                  )}
                />
              </div>
              <div className="prop">
                <span>em laço</span>
                <input
                  type="checkbox"
                  checked={clip?.repeat === 'l'}
                  onChange={(e) => apply((d) => C.setRepeat(d, clipName, e.target.checked))}
                />
              </div>
              <div className="prop"><span>lanes</span><span>{lanes.length}</span></div>
              <div className="row" style={{ marginTop: '.45rem' }}>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    if (!window.confirm(`Remover o clipe "${clipName}"? Só vale ao exportar.`)) return;
                    apply((d) => C.deleteClip(d, clipName));
                    const rest = clipNames.filter((n) => n !== clipName);
                    selectClip(rest[0] || '');
                  }}
                >
                  remover
                </button>
                <button type="button" className="danger" onClick={revert}>original</button>
              </div>
            </div>

            {groupOnly && (
              <p className="warn">
                Dirige <b>grupos</b>: <code>eyes</code> gira o par junto,{' '}
                <code>group_eye_*</code> gira cada olho no próprio eixo.
              </p>
            )}

            <div className="group">
              <div className="group-title">Keyframe</div>
              {hasSelection
                ? <Inspector clip={clip} selection={selection} ops={ops} />
                : <p className="hint small">Clique num keyframe na régua ou no gráfico.</p>}
            </div>
          </div>
        </div>
      </div>

      {/* The bottom half: lanes on their rail, the ruler and curve editor across the rest. */}
      <div className="editor-bottom">
        <div className="lane-rail">
          <div className="section-head"><span>Lanes</span></div>
          <div className="lane-scroll">
            <LaneList
              clip={clip}
              clipName={clipName}
              selection={selection}
              onSelect={setSelection}
            />
          </div>
          <div className="addlane">
            <select value={newKp} onChange={(e) => setNewKp(e.target.value)}>
              <option value="t">translação</option>
              <option value="s">escala</option>
              <option value="o">opacidade</option>
              <option value="r">rotação</option>
              <option value="t3d">perspectiva</option>
              <option value="l">olhar (raiz)</option>
            </select>
            <button
              type="button"
              title={newKp === 'l' ? 'adicionar na raiz' : `adicionar em ${newObj || '(raiz)'}`}
              onClick={() => apply((d) => C.addLane(d, clipName, newKp === 'l' ? '' : newObj, newKp))}
            >
              + lane
            </button>
            <button
              type="button"
              disabled={!hasSelection}
              title="inserir keyframe no tempo atual"
              onClick={() => selection && apply((d) => C.addKey(d, clipName, selection.laneIndex, timeMs))}
            >
              + key
            </button>
          </div>
        </div>

        <div className="graph-pane">
          {/* The same header height as the lane rail's, so row 1 of the names sits opposite row 1
              of the keyframes. Without it the two columns start 25px apart and every row is off. */}
          <div className="section-head">
            <span>{clipName}</span>
            <span className="spacer" />
            <span>{(duration / 1000).toFixed(2)}s · {lanes.length} lanes</span>
          </div>
          <KeyRuler
            clip={clip}
            lanes={lanes}
            selection={selection}
            onSelect={setSelection}
            onMoveKey={moveKey}
            onScrub={scrub}
            timeMs={timeMs}
          />
          <div className="graph-host" ref={graphHost}>
            <CurveGraph
              clip={clip}
              lane={activeLane}
              laneIndex={activeLane?.index ?? 0}
              selection={selection}
              onSelect={setSelection}
              onMoveKey={moveKey}
              onSetComponent={setComponentAt}
              onScrub={scrub}
              timeMs={timeMs}
              width={graphBox.w}
              height={graphBox.h}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
