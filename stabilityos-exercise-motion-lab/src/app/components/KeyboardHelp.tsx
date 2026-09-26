import { useEffect, useId, useRef, useState } from 'react';

export const SHORTCUTS: readonly [string, string][] = [
  ['Space', 'Play / pause'],
  ['← / →', 'Step one frame back / forward'],
  ['Shift + ← / →', 'Previous / next phase'],
  ['Home / End', 'Go to start / end'],
  ['1 2 3 4 5', 'Front, left side, right side, oblique, top view'],
  ['L / R', 'Inspect left / right side (press again to clear)'],
  ['C', 'Toggle baseline comparison'],
  ['?', 'Show this help'],
  ['Esc', 'Close this help'],
];

export function KeyboardHelp(props: { openSignal: number }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (props.openSignal > 0) setOpen(true);
  }, [props.openSignal]);
  useEffect(() => {
    if (!open) return;
    popRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onDown = (e: PointerEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node) && e.target !== btnRef.current) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);
  return (
    <div className="kbd-help">
      <button
        ref={btnRef}
        type="button"
        className="btn btn-quiet"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        data-testid="keyboard-help-button"
      >
        <span aria-hidden="true">⌨</span> Keyboard
      </button>
      {open ? (
        <div className="popover" id={id} role="dialog" aria-label="Keyboard shortcuts" tabIndex={-1} ref={popRef} data-testid="keyboard-help">
          <h2>Keyboard shortcuts</h2>
          <p className="small muted">Shortcuts are ignored while typing in a text or number field.</p>
          <table className="kbd-table">
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">
                    <kbd>{k}</kbd>
                  </th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn" onClick={() => { setOpen(false); btnRef.current?.focus(); }}>
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}
