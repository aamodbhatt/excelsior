import { useEffect, useMemo, useRef, useState } from 'react';
import { completionPrefix, completions, highlight, signatureAt, signatureParts } from './formulaText';

export interface FormulaInputProps {
  value: string;
  onChange: (text: string) => void;
  /** Commit and move: down for Enter, right for Tab, or stay. */
  onCommit: (move: 'down' | 'right' | 'none') => void;
  onCancel: () => void;
  onFocus?: () => void;
  names: string[];
  autoFocus?: boolean;
  className?: string;
  readOnly?: boolean;
  testId?: string;
}

/**
 * A single-line formula editor: a transparent input over a syntax-highlighted mirror, with function
 * and name autocomplete and signature help for the call the caret is in.
 */
export function FormulaInput(props: FormulaInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(props.value.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const spans = useMemo(() => {
    // Each span is keyed by its offset in the text, a stable identity within one render.
    let start = 0;
    return highlight(props.value).spans.map((s) => {
      const out = { ...s, start };
      start += s.text.length;
      return out;
    });
  }, [props.value]);
  const prefix = dismissed ? null : completionPrefix(props.value, caret);
  const items = prefix ? completions(prefix, props.names) : [];
  const sig = signatureAt(props.value, caret);

  useEffect(() => {
    if (props.autoFocus) {
      input.current?.focus();
      const n = input.current?.value.length ?? 0;
      input.current?.setSelectionRange(n, n);
    }
  }, [props.autoFocus]);

  const syncScroll = () => {
    if (mirror.current && input.current) mirror.current.scrollLeft = input.current.scrollLeft;
  };

  const accept = (name: string, isFunction: boolean) => {
    const start = caret - (prefix?.length ?? 0);
    const insert = isFunction ? `${name}(` : name;
    const next = props.value.slice(0, start) + insert + props.value.slice(caret);
    props.onChange(next);
    const pos = start + insert.length;
    requestAnimationFrame(() => {
      input.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (items.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return;
    }
    if (
      items.length &&
      (e.key === 'Tab' ||
        (e.key === 'Enter' &&
          prefix &&
          prefix.length > 0 &&
          items[active]?.name.toUpperCase() !== prefix.toUpperCase()))
    ) {
      e.preventDefault();
      const it = items[Math.min(active, items.length - 1)];
      accept(it.name, it.isFunction);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      props.onCommit(e.shiftKey ? 'none' : 'down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      props.onCommit('right');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (items.length) setDismissed(true);
      else props.onCancel();
    }
    e.stopPropagation();
  };

  const parts = sig ? signatureParts(sig.fn.signature) : null;

  return (
    <div className={`fx ${props.className ?? ''}`}>
      <div className="fx-mirror" ref={mirror} aria-hidden>
        {spans.map((s) => (
          <span key={s.start} className={s.cls} style={s.color ? { color: s.color } : undefined}>
            {s.text}
          </span>
        ))}
      </div>
      <input
        ref={input}
        className="fx-input"
        data-testid={props.testId}
        value={props.value}
        readOnly={props.readOnly}
        spellCheck={false}
        autoComplete="off"
        onFocus={props.onFocus}
        onChange={(e) => {
          setDismissed(false);
          setActive(0);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          props.onChange(e.target.value);
          syncScroll();
        }}
        onSelect={(e) => {
          setCaret((e.target as HTMLInputElement).selectionStart ?? 0);
          syncScroll();
        }}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
      />
      {items.length > 0 && (
        <div className="fx-complete" role="listbox">
          {items.map((it, i) => (
            <div
              key={it.name}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(it.name, it.isFunction);
              }}
            >
              <b>{it.name}</b>
              <span>{it.detail}</span>
            </div>
          ))}
        </div>
      )}
      {!items.length && parts && (
        <div className="fx-signature" data-testid="signature-help">
          <b>{parts.name}</b>(
          {parts.params.map((p, i) => (
            <span key={p}>
              {i > 0 && ', '}
              <span className={i === Math.min(sig!.arg, parts.params.length - 1) ? 'sig-active' : ''}>
                {p}
              </span>
            </span>
          ))}
          ) <span className="sig-desc">{sig!.fn.description}</span>
        </div>
      )}
    </div>
  );
}
