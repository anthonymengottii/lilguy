import { useCallback, useRef, useState } from 'react';

// The document and its history.
//
// Undo is a stack of PREVIOUS DOCUMENTS, not a log of inverse operations, which is why clipOps.js is
// written as pure functions: an inverse log has to be right for every operation, while a value stack
// is right by construction. The cost is memory, and it is affordable here -- the operations share
// structure, so an edit to one clip leaves the other 14 and all 36 states pointing at the same
// objects rather than copying 88KB.
//
// COALESCING. Dragging a slider or typing in a number field fires an edit per pixel or per
// character, and one undo per keystroke makes undo useless. Edits tagged with the same `mergeKey`
// within COALESCE_MS collapse into one history entry -- so a whole drag is one undo, but the drag
// and the click after it are two.
const COALESCE_MS = 600;
const MAX_HISTORY = 120;

export function useEditorState(initial) {
  const [doc, setDoc] = useState(initial);
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const lastEdit = useRef({ key: null, at: 0 });

  // Apply a pure operation. `mergeKey` groups rapid edits of the same control into one undo step.
  const apply = useCallback((fn, mergeKey = null) => {
    setDoc((current) => {
      const next = fn(current);
      if (next === current) return current;        // an op that declined to change anything

      const now = Date.now();
      const merging = mergeKey !== null
        && lastEdit.current.key === mergeKey
        && now - lastEdit.current.at < COALESCE_MS;
      lastEdit.current = { key: mergeKey, at: now };

      if (!merging) {
        setPast((p) => {
          const grown = p.concat([current]);
          return grown.length > MAX_HISTORY ? grown.slice(grown.length - MAX_HISTORY) : grown;
        });
      }
      setFuture([]);                               // a new edit discards the redo branch
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      const previous = p[p.length - 1];
      setDoc((current) => { setFuture((f) => [current].concat(f)); return previous; });
      lastEdit.current = { key: null, at: 0 };     // never merge across an undo
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      const next = f[0];
      setDoc((current) => { setPast((p) => p.concat([current])); return next; });
      lastEdit.current = { key: null, at: 0 };
      return f.slice(1);
    });
  }, []);

  // Replace the whole document and drop the history: loading a file or reverting is not an edit you
  // undo your way out of, and pretending otherwise would let undo mix two different documents.
  const reset = useCallback((next) => {
    setDoc(next);
    setPast([]);
    setFuture([]);
    lastEdit.current = { key: null, at: 0 };
  }, []);

  return {
    doc,
    apply,
    undo,
    redo,
    reset,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    dirty: past.length > 0,
  };
}
