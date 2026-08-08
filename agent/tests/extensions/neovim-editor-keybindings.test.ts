import { expect, test } from "bun:test";
import { releaseGlobalDebugHandler } from "../../extensions/neovim-editor/debug-key";

test("embedded editor claims Pi's former global debug chord for exit", async () => {
  const keybindings = (await Bun.file(new URL("../../keybindings.json", import.meta.url)).json()) as Record<
    string,
    string | string[]
  >;

  expect(keybindings["app.exit"]).toBe("ctrl+shift+d");
});

test("embedded editor releases and restores Pi's global debug handler", () => {
  let debugCalls = 0;
  const tui = { onDebug: () => (debugCalls += 1) };
  const previous = tui.onDebug;

  const restore = releaseGlobalDebugHandler(tui);
  expect(tui.onDebug).toBeUndefined();
  restore();

  expect(tui.onDebug).toBe(previous);
  tui.onDebug?.();
  expect(debugCalls).toBe(1);
});

test("debug-handler restoration does not overwrite a newer owner", () => {
  const tui: { onDebug?: () => void } = { onDebug: () => undefined };
  const restore = releaseGlobalDebugHandler(tui);
  const replacement = () => undefined;
  tui.onDebug = replacement;

  restore();

  expect(tui.onDebug).toBe(replacement);
});
