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
    await waitFor(() => host.grid.mode.startsWith("cmdline"));
    expect(host.grid.render(false).join("\n")).toContain(":");
    host.sendKeys("<Esc>");
    await waitFor(() => host.grid.mode === "normal");

    await host.setState(["emoji 😀", "second"], 0, 8);
    await waitFor(() => latestText === "emoji 😀\nsecond" && latestDisplayHeight === 2);
    await host.insertText("!");
    await waitFor(() => latestText === "emoji 😀!\nsecond");

    await host.setState(["test 1234 hello"], 0, 0);
    host.sendKeys("v");
    await waitFor(() => host.grid.mode === "visual" && host.grid.cursorShape === "block");
    expect(host.grid.cursorShape).toBe("block");
    const visualFrame = host.grid.version;
    host.sendKeys("w");
    await waitFor(() => host.grid.version > visualFrame);
    expect(stripAnsi(host.grid.render(false)[0])).toContain("test 1234 hello");
    host.sendKeys("<Esc>");
    await waitFor(() => host.grid.mode === "normal");

    await host.setText("");
    await waitFor(() => latestText === "" && host.grid.mode.startsWith("insert"));
    expect(host.grid.cursorShape).toBe("vertical");

    expect(errors).toEqual([]);
  } finally {
    await host.dispose();
  }
  expect(exitRequests).toBe(0);
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
