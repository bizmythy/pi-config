import { describe, expect, test } from "bun:test";
import { neovimGridHeight } from "../../extensions/neovim-editor/layout";

describe("embedded Neovim editor height", () => {
  test("starts at one row and grows with displayed prompt rows", () => {
    expect(neovimGridHeight(1, 40)).toBe(1);
    expect(neovimGridHeight(2, 40)).toBe(2);
    expect(neovimGridHeight(7, 40)).toBe(7);
  });

  test("uses Pi's terminal-relative maximum before Neovim scrolls", () => {
    expect(neovimGridHeight(100, 40)).toBe(12);
    expect(neovimGridHeight(100, 10)).toBe(5);
    expect(neovimGridHeight(100, 100)).toBe(30);
  });

  test("normalizes invalid or empty measurements to one row", () => {
    expect(neovimGridHeight(0, 40)).toBe(1);
    expect(neovimGridHeight(Number.NaN, 40)).toBe(1);
  });
});
