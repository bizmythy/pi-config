import { decodeKittyPrintable, isKeyRelease, parseKey } from "@earendil-works/pi-tui";

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

export interface ParsedInput {
  kind: "keys" | "paste";
  value: string;
}

/** Incremental parser for bracketed paste, whose markers may span input chunks. */
export class NeovimInputParser {
  private buffer = "";
  private inPaste = false;
  private static readonly start = "\x1b[200~";
  private static readonly end = "\x1b[201~";

  get hasPendingKeys(): boolean {
    return !this.inPaste && this.buffer.length > 0;
  }

  flushPendingKeys(): ParsedInput[] {
    if (!this.hasPendingKeys) return [];
    const value = this.buffer;
    this.buffer = "";
    return [{ kind: "keys", value }];
  }

  push(data: string): ParsedInput[] {
    this.buffer += data;
    const result: ParsedInput[] = [];

    while (this.buffer.length > 0) {
      if (this.inPaste) {
        const endIndex = this.buffer.indexOf(NeovimInputParser.end);
        if (endIndex < 0) return result;
        result.push({ kind: "paste", value: this.buffer.slice(0, endIndex) });
        this.buffer = this.buffer.slice(endIndex + NeovimInputParser.end.length);
        this.inPaste = false;
        continue;
      }

      const startIndex = this.buffer.indexOf(NeovimInputParser.start);
      if (startIndex < 0) {
        // Hold a suffix which might be the beginning of a split start marker.
        let suffixLength = 0;
        for (let length = 1; length < NeovimInputParser.start.length; length += 1) {
          if (this.buffer.endsWith(NeovimInputParser.start.slice(0, length))) suffixLength = length;
        }
        const ready = this.buffer.slice(0, this.buffer.length - suffixLength);
        if (ready) result.push({ kind: "keys", value: ready });
        this.buffer = this.buffer.slice(this.buffer.length - suffixLength);
        return result;
      }

      const before = this.buffer.slice(0, startIndex);
      if (before) result.push({ kind: "keys", value: before });
      this.buffer = this.buffer.slice(startIndex + NeovimInputParser.start.length);
      this.inPaste = true;
    }

    return result;
  }
}
