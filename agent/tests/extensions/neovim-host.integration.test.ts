import { expect, test } from "bun:test";
import { NeovimHost } from "../../extensions/neovim-editor/nvim-host";

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
  const errors: string[] = [];
  const host = new NeovimHost({
    cwd: process.cwd(),
    args: ["--clean", "--embed"],
    onState: (state) => {
      latestText = state.lines.join("\n");
    },
    onSubmit: () => undefined,
    onError: (message) => errors.push(message),
    onExit: () => undefined,
    onRender: () => undefined,
  });

  try {
    await host.start(50, 8);
    expect(host.isReady).toBe(true);
    expect(host.grid.size).toEqual({ width: 50, height: 8 });

    expect(host.grid.cursorShape).toBe("block");
    host.sendKeys("i");
    await waitFor(() => host.grid.cursorShape === "vertical");
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
    await waitFor(() => latestText === "emoji 😀\nsecond");
    await host.insertText("!");
    await waitFor(() => latestText === "emoji 😀!\nsecond");
    expect(errors).toEqual([]);
  } finally {
    await host.dispose();
  }
});
