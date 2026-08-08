import { decodeKittyPrintable, isKeyRelease, parseKey } from "@earendil-works/pi-tui";

export { NeovimInputParser } from "./input-events";

const SPECIAL_KEYS: Record<string, string> = {
  escape: "Esc",
  esc: "Esc",
  enter: "CR",
  return: "CR",
  tab: "Tab",
  space: "Space",
  backspace: "BS",
  delete: "Del",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageUp: "PageUp",
  pageDown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
};

const MODIFIERS: Record<string, string> = {
  ctrl: "C",
  shift: "S",
  alt: "M",
  super: "D",
};

function literalInput(value: string): string {
  return value.replaceAll("<", "<LT>");
}

/** Translate one Pi TUI input event into nvim_input() key notation. */
export function toNeovimInput(data: string): string | undefined {
  if (!data || isKeyRelease(data)) return undefined;

  const kittyPrintable = decodeKittyPrintable(data);
  if (kittyPrintable !== undefined) return literalInput(kittyPrintable);
  if ([...data].every((character) => character >= " " && character !== "\x7f")) return literalInput(data);

  const parsed = parseKey(data);
  if (!parsed) {
    // Pi may deliver several printable characters together. Preserve those,
    // but never forward unknown escape/control sequences as text.
    return [...data].every((character) => character >= " " && character !== "\x7f") ? literalInput(data) : undefined;
  }

  const parts = parsed.split("+");
  const base = parts.pop();
  if (!base) return undefined;
  const modifiers = parts.map((modifier) => MODIFIERS[modifier]).filter(Boolean);
  const special = SPECIAL_KEYS[base];

  if (modifiers.length === 0 && !special) return literalInput(base);
  const key = special ?? (base === "<" ? "LT" : base);
  return `<${[...modifiers, key].join("-")}>`;
}
