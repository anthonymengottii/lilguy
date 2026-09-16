import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Stage from './Stage';
import Timeline from './Timeline';
import Inspector from './Inspector';
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

  // ---- new lane --------------------------------------------------------------------------------

  const nodeNames = useMemo(() => C.nodeNamesOf(data, stateId), [data, stateId]);
  const [newObj, setNewObj] = useState('');
  const [newKp, setNewKp] = useState('t');
  useEffect(() => { if (!newObj && nodeNames.length) setNewObj(nodeNames[0]); }, [nodeNames, newObj]);

  // ---- file ------------------------------------------------------------------------------------

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'anim_data.json';
    a.click();
    URL.revokeObjectURL(a.href);
    setMessage('anim_data.json baixado. Para levar ao aparelho: python tools/lark_pack.py <arquivo>, depois reflash.');
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

  return (
    <div className="app">
      <header>
        <h1>Editor de clipes Lark</h1>
        <p className="sub">
          Toca e edita as animações do <a href="https://hesjustalittleguy.com">hesjustalittleguy.com</a>{' '}
          com o mesmo runtime que o ocellus usa. {editor.dirty && <b className="dirty">• alterado</b>}
        </p>
      </header>

      <div className="columns">
        <section className="left">
          <Stage
            data={data}
            stateId={stateId}
            clipName={clipName}
            timeMs={timeMs}
            background={background}
            look={look}
            onLook={setLook}
          />

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
            <span className="time">{(timeMs / 1000).toFixed(2)}s / {(duration / 1000).toFixed(2)}s</span>
          </div>

          <div className="row wrap">
            <label className="field inline">
              <span>estado</span>
              <select value={stateId} onChange={(e) => setStateId(e.target.value)}>
                {stateIds.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field inline">
              <span>fundo</span>
              <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} />
            </label>
          </div>

          <p className="hint small">
            Espaço toca/pausa · setas ↔ movem 10ms (100ms com Shift) · Ctrl+Z desfaz.
            Mova o cursor sobre o disco para guiar o olhar.
          </p>
        </section>

        <section className="right">
          <div className="panel">
            <div className="row wrap">
              <label className="field inline grow">
                <span>clipe</span>
                <select value={clipName} onChange={(e) => selectClip(e.target.value)}>
                  {clipNames.map((n) => (
                    <option key={n} value={n}>
                      {n}{C.targetsGroups(data.animations[n]) ? ' (grupos)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => {
                const name = window.prompt('Nome do clipe novo:', 'meu_clipe');
                if (!name) return;
                if (data.animations[name]) { setMessage(`já existe um clipe "${name}"`); return; }
                apply((d) => C.createClip(d, name));
                selectClip(name);
              }}>novo</button>
              <button type="button" onClick={() => {
                const to = window.prompt('Novo nome:', clipName);
                if (!to || to === clipName) return;
                if (data.animations[to]) { setMessage(`já existe um clipe "${to}"`); return; }
                apply((d) => C.renameClip(d, clipName, to));
                selectClip(to);
              }}>renomear</button>
              <button type="button" className="danger" onClick={() => {
                if (!window.confirm(`Remover o clipe "${clipName}"? Isso não vai para o disco até você exportar.`)) return;
                apply((d) => C.deleteClip(d, clipName));
                const rest = clipNames.filter((n) => n !== clipName);
                selectClip(rest[0] || '');
              }}>remover</button>
            </div>

            {groupOnly && (
              <p className="warn">
                Este clipe dirige <b>grupos</b> da cena (<code>eyes</code>, <code>group_eye_*</code>).
                Aqui no navegador ele anima; no firmware ele toca e não desenha, porque os dados
                empacotados não guardam nome de nó — veja <code>lark_behavior.h</code>.
              </p>
            )}

            <div className="row wrap">
              <label className="field inline">
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
              </label>
              <label className="field inline check">
                <input
                  type="checkbox"
                  checked={clip?.repeat === 'l'}
                  onChange={(e) => apply((d) => C.setRepeat(d, clipName, e.target.checked))}
                />
                <span>em laço</span>
              </label>
            </div>
          </div>

          <div className="panel">
            <Timeline
              clip={clip}
              clipName={clipName}
              selection={selection}
              onSelect={setSelection}
              onMoveKey={moveKey}
              onScrub={scrub}
              timeMs={timeMs}
            />

            <div className="row wrap addlane">
              <span className="label">nova lane</span>
              <select value={newObj} onChange={(e) => setNewObj(e.target.value)}>
                <option value="">(raiz — olhar)</option>
                {nodeNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <select value={newKp} onChange={(e) => setNewKp(e.target.value)}>
                <option value="t">translação</option>
                <option value="s">escala</option>
                <option value="o">opacidade</option>
                <option value="r">rotação</option>
                <option value="t3d">perspectiva</option>
                {newObj === '' && <option value="l">olhar</option>}
              </select>
              <button type="button" onClick={() => apply((d) => C.addLane(d, clipName, newObj, newKp))}>
                adicionar
              </button>
              <button type="button" disabled={!selection} onClick={() => {
                if (!selection) return;
                apply((d) => C.addKey(d, clipName, selection.laneIndex, timeMs));
              }}>
                keyframe aqui
              </button>
            </div>
          </div>

          <div className="panel">
            <Inspector clip={clip} selection={selection} ops={ops} />
          </div>

          <div className="panel">
            <div className="row wrap">
              <button type="button" onClick={editor.undo} disabled={!editor.canUndo}>desfazer</button>
              <button type="button" onClick={editor.redo} disabled={!editor.canRedo}>refazer</button>
              <button type="button" onClick={exportJson}>exportar JSON</button>
              <label className="filebtn">
                importar
                <input
                  type="file"
                  accept="application/json"
                  onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])}
                />
              </label>
              <button type="button" className="danger" onClick={revert}>voltar ao original</button>
            </div>
            {message && <p className="hint small">{message}</p>}
            <p className="hint small">
              O export tem a forma do <code>anim_data.json</code> do site, então
              <code> tools/lark_pack.py</code> lê sem conversão. Nada aqui grava no aparelho.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
