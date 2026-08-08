import { describe, expect, test } from "bun:test";
import { NeovimInputParser, splitTerminalKeyEvents } from "../../extensions/neovim-editor/input-events";

describe("embedded Neovim terminal input events", () => {
  test("preserves every Enter when rapid keys arrive in one terminal chunk", () => {
    const parser = new NeovimInputParser();

    expect(parser.push("word\r\r\r")).toEqual([
      { kind: "keys", value: "word" },
      { kind: "keys", value: "\r" },
      { kind: "keys", value: "\r" },
      { kind: "keys", value: "\r" },
    ]);
  });

  test("separates adjacent control and escape-sequence keys", () => {
    expect(splitTerminalKeyEvents("\x1b[A\x1b[B\t\x7f")).toEqual({
      events: ["\x1b[A", "\x1b[B", "\t", "\x7f"],
      remainder: "",
    });
  });

  test("buffers a split escape sequence and preserves bracketed paste", () => {
    const parser = new NeovimInputParser();

    expect(parser.push("\x1b[")).toEqual([]);
    expect(parser.push("A")).toEqual([{ kind: "keys", value: "\x1b[A" }]);
    expect(parser.push("\x1b[200~one\ntwo")).toEqual([]);
    expect(parser.push("\x1b[201~")).toEqual([{ kind: "paste", value: "one\ntwo" }]);
  });
});
