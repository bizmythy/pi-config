export interface ParsedInput {
  kind: "keys" | "paste";
  value: string;
}

interface SplitResult {
  events: string[];
  remainder: string;
}

/** Split an arbitrary terminal chunk without collapsing repeated control keys. */
export function splitTerminalKeyEvents(data: string): SplitResult {
  const events: string[] = [];
  let index = 0;

  while (index < data.length) {
    const code = data.charCodeAt(index);
    if (code === 0x1b) {
      if (index + 1 >= data.length) return { events, remainder: data.slice(index) };
      const next = data[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < data.length) {
          const finalCode = data.charCodeAt(end);
          if (finalCode >= 0x40 && finalCode <= 0x7e) {
            events.push(data.slice(index, end + 1));
            index = end + 1;
            break;
          }
          end += 1;
        }
        if (end >= data.length) return { events, remainder: data.slice(index) };
        continue;
      }
      if (next === "O") {
        if (index + 2 >= data.length) return { events, remainder: data.slice(index) };
        events.push(data.slice(index, index + 3));
        index += 3;
        continue;
      }

      const nextCodePoint = data.codePointAt(index + 1) ?? 0;
      const nextLength = nextCodePoint > 0xffff ? 2 : 1;
      events.push(data.slice(index, index + 1 + nextLength));
      index += 1 + nextLength;
      continue;
    }

    if (code < 0x20 || code === 0x7f) {
      events.push(data[index]);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < data.length) {
      const nextCode = data.charCodeAt(end);
      if (nextCode === 0x1b || nextCode < 0x20 || nextCode === 0x7f) break;
      end += 1;
    }
    events.push(data.slice(index, end));
    index = end;
  }

  return { events, remainder: "" };
}

/** Incremental parser for terminal keys and bracketed paste. */
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
      if (startIndex >= 0) {
        const before = this.buffer.slice(0, startIndex);
        const split = splitTerminalKeyEvents(before);
        result.push(...split.events.map((value) => ({ kind: "keys" as const, value })));
        if (split.remainder) return result;
        this.buffer = this.buffer.slice(startIndex + NeovimInputParser.start.length);
        this.inPaste = true;
        continue;
      }

      const split = splitTerminalKeyEvents(this.buffer);
      result.push(...split.events.map((value) => ({ kind: "keys" as const, value })));
      this.buffer = split.remainder;
      return result;
    }

    return result;
  }
}
