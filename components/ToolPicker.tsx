"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { searchProducts, type AiProduct } from "@/lib/products";

export type PickedTool = { name: string; slug: string | null };

// Searchable popover for the AI tool. Deliberately not a <select> or
// <datalist>: one consistent list on every device, filtered as you type.
export default function ToolPicker({
  products,
  value,
  onChange,
}: {
  products: AiProduct[];
  value: PickedTool | null;
  onChange: (v: PickedTool | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [manual, setManual] = useState(false);
  const [manualName, setManualName] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const results = useMemo(() => searchProducts(query, products), [query, products]);
  const total = results.length + 1; // + "enter it manually"

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  useEffect(() => setActive(0), [query]);

  function pick(p: AiProduct) {
    onChange({ name: p.name, slug: p.slug });
    setOpen(false);
    setQuery("");
  }

  function chooseManual() {
    setManual(true);
    setManualName(query);
    setOpen(false);
    onChange(query.trim() ? { name: query.trim(), slug: null } : null);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % total);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + total) % total);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active < results.length) pick(results[active]);
      else chooseManual();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  if (manual) {
    return (
      <div>
        <input
          id="tool"
          type="text"
          value={manualName}
          onChange={(e) => {
            setManualName(e.target.value);
            onChange(e.target.value.trim() ? { name: e.target.value.trim(), slug: null } : null);
          }}
          placeholder="Type your AI tool's name"
          maxLength={80}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="linkish"
          style={{ marginTop: 6 }}
          onClick={() => {
            setManual(false);
            onChange(null);
            setOpen(true);
          }}
        >
          Back to the list
        </button>
      </div>
    );
  }

  return (
    <div className="picker" ref={root}>
      <button
        id="tool"
        type="button"
        className={`picker-trigger${value ? "" : " placeholder"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {value ? value.name : "Choose your AI tool"}
      </button>
      {open ? (
        <div className="picker-pop">
          <input
            className="picker-search"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={`${listId}-${active}`}
            aria-label="Search AI tools"
            placeholder="Search tools"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
          />
          <ul className="picker-list" role="listbox" id={listId}>
            {results.map((p, i) => (
              <li
                key={p.slug}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
              >
                <span>{p.name}</span>
                <span className="cap">{p.capability}</span>
              </li>
            ))}
            {results.length === 0 ? <li className="picker-empty" role="presentation">No match for &ldquo;{query}&rdquo;.</li> : null}
            <li
              id={`${listId}-${results.length}`}
              role="option"
              aria-selected={active === results.length}
              className="manual"
              onMouseEnter={() => setActive(results.length)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={chooseManual}
            >
              Can&apos;t find your tool? Enter it manually.
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
