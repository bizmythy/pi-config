import { describe, expect, test } from "bun:test";
import { NeovimGrid } from "../../extensions/neovim-editor/grid";

// biome-ignore lint/suspicious/noControlCharactersInRegex: this strips terminal protocol sequences from assertions.
const terminalSequence = /\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*\x07)/g;
const stripAnsi = (value: string) => value.replace(terminalSequence, "");

describe("embedded Neovim line-grid rendering", () => {
  test("applies repeated cells, highlights, scrolling, and flush boundaries", () => {
    const grid = new NeovimGrid();
    let flushes = 0;
    grid.onFlush = () => {
      flushes += 1;
    };

    grid.handleRedraw([
      ["grid_resize", [1, 8, 3]],
      ["hl_attr_define", [4, { foreground: 0x112233, bold: true }, {}, []]],
      [
        "grid_line",
        [
          1,
          0,
          0,
          [
            ["a", 4, 3],
            ["界", 0],
            ["", 0],
            [" ", 0, 3],
          ],
          false,
        ],
      ],
    ]);
    expect(flushes).toBe(0);

    grid.handleRedraw([["flush", []]]);
    expect(flushes).toBe(1);
    expect(stripAnsi(grid.render(false)[0])).toBe("aaa界   ");
    expect(grid.render(false)[0]).toContain("38;2;17;34;51");

    grid.handleRedraw([
      ["grid_line", [1, 1, 0, [["s", 0], ["e"], ["c"], ["o"], ["n"], ["d"], [" ", 0, 2]], false]],
      ["grid_scroll", [1, 0, 2, 0, 8, 1, 0]],
      ["flush", []],
    ]);
    expect(stripAnsi(grid.render(false)[0])).toBe("second  ");
    expect(stripAnsi(grid.render(false)[1])).toBe("        ");
  });

  test("places Pi's zero-width cursor marker at Neovim's cursor cell", () => {
    const grid = new NeovimGrid();
    grid.handleRedraw([
      ["grid_resize", [1, 4, 1]],
      ["grid_line", [1, 0, 0, [["t", 0], ["e"], ["x"], ["t"]], false]],
      ["grid_cursor_goto", [1, 0, 2]],
      ["flush", []],
    ]);

    const focused = grid.render(true)[0];
    expect(focused).toContain("\x1b_pi:c\x07");
    expect(stripAnsi(focused)).toBe("text");
    expect(grid.render(false)).not.toContain("\x1b_pi:c\x07");
  });

  test("ignores unknown redraw events without losing the next frame", () => {
    const grid = new NeovimGrid();
    grid.handleRedraw([
      ["grid_resize", [1, 2, 1]],
      ["future_event", [1, 2, 3]],
      ["grid_line", [1, 0, 0, [["o", 0], ["k"]], false]],
      ["flush", []],
    ]);
    expect(stripAnsi(grid.render(false)[0])).toBe("ok");
  });
});
