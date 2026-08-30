import { expect, test } from "bun:test";
import { NeovimHost } from "../../extensions/neovim-editor/nvim-host";

// biome-ignore lint/suspicious/noControlCharactersInRegex: this strips terminal protocol sequences from assertions.
const terminalSequence = /\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*\x07)/g;
const stripAnsi = (value: string) => value.replace(terminalSequence, "");

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for embedded Neovim state");
    await Bun.sleep(10);
  }
}

test("a real embedded Neovim owns editing, state synchronization, and shutdown", async () => {
  if (!Bun.which("nvim")) return;

  let latestText = "";
  let latestDisplayHeight = 0;
  let exitRequests = 0;
  const errors: string[] = [];
  const host = new NeovimHost({
    cwd: process.cwd(),
    args: ["--clean", "--embed"],
    onState: (state) => {
      latestText = state.lines.join("\n");
      latestDisplayHeight = state.displayHeight;
    },
    onSubmit: () => undefined,
    onRequestExit: () => {
      exitRequests += 1;
    },
    onError: (message) => errors.push(message),
    onExit: () => undefined,
    onRender: () => undefined,
  });

  try {
    await host.start(50, 8);
    expect(host.isReady).toBe(true);
    expect(host.grid.size).toEqual({ width: 50, height: 8 });
    expect(latestDisplayHeight).toBe(1);
    await waitFor(() => host.grid.cursorShape === "vertical");
    expect(host.mode).toBe("insert");

    host.resize(12, 8);
    await waitFor(() => host.grid.size.width === 12);
    await host.setState(["abcdefghijklmnopqrstuvwx"], 0, 0);
    await waitFor(() => latestText === "abcdefghijklmnopqrstuvwx" && latestDisplayHeight > 1);
    await host.setText("");
    host.resize(50, 8);
    await waitFor(() => host.grid.size.width === 50 && latestText === "");

    expect(host.grid.cursorShape).toBe("vertical");
    const insertFrame = host.grid.render(false).join("\n");
    expect(insertFrame).not.toContain("-- INSERT --");
    expect(insertFrame).not.toContain("[Pi Prompt]");
    host.sendKeys("hello world<Esc>0dw");
    await waitFor(() => latestText === "world");
    expect(host.text).toBe("world");
    expect(host.grid.cursorShape).toBe("block");

    host.sendKeys(":");
    await waitFor(() => host.mode.startsWith("cmdline"));
    expect(host.grid.render(false).join("\n")).toContain(":");
    host.sendKeys("<Esc>");
    await waitFor(() => host.mode === "normal");

    await host.setState(["emoji 😀", "second"], 0, 8);
    await waitFor(() => latestText === "emoji 😀\nsecond" && latestDisplayHeight === 2);
    await host.insertText("!");
    await waitFor(() => latestText === "emoji 😀!\nsecond");

    await host.setState(["test 1234 hello"], 0, 0);
    host.sendKeys("v");
    await waitFor(() => host.mode === "visual" && host.grid.cursorShape === "block");
    expect(host.grid.cursorShape).toBe("block");
    const visualFrame = host.grid.version;
    host.sendKeys("w");
    await waitFor(() => host.grid.version > visualFrame);
    expect(stripAnsi(host.grid.render(false)[0])).toContain("test 1234 hello");
    host.sendKeys("<Esc>");
    await waitFor(() => host.mode === "normal");

    // Real replace mode must be reported as such (distinct from Neovim's
    // cursor-obscured "replace" redraw hint, which must never flip the label).
    host.sendKeys("R");
    await waitFor(() => host.mode === "replace");
    host.sendKeys("<Esc>");
    await waitFor(() => host.mode === "normal");

    await host.setText("");
    await waitFor(() => latestText === "" && host.mode === "insert");
    expect(host.grid.cursorShape).toBe("vertical");
    expect(host.mode).toBe("insert");

    expect(errors).toEqual([]);
  } finally {
    await host.dispose();
  }
  expect(exitRequests).toBe(0);
});

test('Neovim\'s cursor-obscured "replace" hint never flips the insert-mode indicator', async () => {
  if (!Bun.which("nvim")) return;

  let latestText = "";
  const errors: string[] = [];
  const host = new NeovimHost({
    cwd: process.cwd(),
    args: ["--clean", "--embed"],
    onState: (state) => {
      latestText = state.lines.join("\n");
    },
    onSubmit: () => undefined,
    onRequestExit: () => undefined,
    onError: (message) => errors.push(message),
    onExit: () => undefined,
    onRender: () => undefined,
  });
  const hints: string[] = [];
  const originalHandleRedraw = host.grid.handleRedraw.bind(host.grid);
  host.grid.handleRedraw = (events: unknown[]) => {
    for (const event of events as unknown[][]) {
      if (event?.[0] === "mode_change") hints.push(JSON.stringify(event[1]));
    }
    originalHandleRedraw(events);
  };

  try {
    await host.start(30, 3);
    expect(host.mode).toBe("insert");
    await host.setState(["head hear heat heel heed help hello h"], 0, 31);
    await waitFor(() => latestText.endsWith(" h"));

    // The completion popup opens over the cursor (the grid is too short to
    // fit it below), so Neovim emits its cursor-obscured `mode_change`
    // ["replace", 3] hint even though the editor stays in insert mode.
    hints.length = 0;
    host.sendKeys("i\x14"); // i_CTRL-N
    await waitFor(() => hints.some((hint) => hint.includes("replace")));
    await Bun.sleep(100); // allow the state sync following the hint to land
    expect(host.mode).toBe("insert");

    host.sendKeys("\x1b\x1b");
    await waitFor(() => host.mode === "normal");
    expect(errors).toEqual([]);
  } finally {
    await host.dispose();
  }
});

test("the prompt viewport never scrolls past the end of the buffer", async () => {
  if (!Bun.which("nvim")) return;

  let latestText = "";
  const errors: string[] = [];
  const host = new NeovimHost({
    cwd: process.cwd(),
    args: ["--clean", "--embed"],
    onState: (state) => {
      latestText = state.lines.join("\n");
    },
    onSubmit: () => undefined,
    onRequestExit: () => undefined,
    onError: (message) => errors.push(message),
    onExit: () => undefined,
    onRender: () => undefined,
  });
  const renderedRows = () => host.grid.render(false).map((line) => stripAnsi(line).trimEnd());

  try {
    await host.start(20, 2);
    await host.setState(["one", "two", "three"], 2, 0);
    await waitFor(() => latestText === "one\ntwo\nthree" && renderedRows().join("|") === "two|three");

    host.resize(20, 3);
    await waitFor(() => host.grid.size.height === 3 && renderedRows().join("|") === "one|two|three");

    const version = host.grid.version;
    host.sendKeys("<Esc><C-E>");
    await waitFor(() => host.grid.version > version);
    await waitFor(() => renderedRows().join("|") === "one|two|three");

    expect(renderedRows()).toEqual(["one", "two", "three"]);
    expect(errors).toEqual([]);
  } finally {
    await host.dispose();
  }
});

test("Neovim :q requests Pi exit instead of reporting an unexpected child exit", async () => {
  if (!Bun.which("nvim")) return;

  let exitRequests = 0;
  const childExits: boolean[] = [];
  const host = new NeovimHost({
    cwd: process.cwd(),
    args: ["--clean", "--embed"],
    onState: () => undefined,
    onSubmit: () => undefined,
    onRequestExit: () => {
      exitRequests += 1;
    },
    onError: () => undefined,
    onExit: (unexpected) => childExits.push(unexpected),
    onRender: () => undefined,
  });

  try {
    await host.start(40, 6);
    host.sendKeys("<Esc>:q<CR>");
    await waitFor(() => childExits.length === 1);

    expect(exitRequests).toBe(1);
    expect(childExits).toEqual([false]);
  } finally {
    await host.dispose();
  }
});
