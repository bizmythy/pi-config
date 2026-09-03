import assert from "node:assert/strict";
import test from "node:test";
import {
  type ClipboardExec,
  type ClipboardExecResult,
  clipboardReadCommands,
  readClipboardText,
} from "../../extensions/shared/clipboard.js";

function fakeExec(responses: Record<string, ClipboardExecResult | Error>, calls: string[] = []): ClipboardExec {
  return async (command) => {
    calls.push(command);
    const response = responses[command] ?? new Error(`spawn ${command} ENOENT`);
    if (response instanceof Error) throw response;
    return response;
  };
}

const ok = (stdout: string): ClipboardExecResult => ({ stdout, stderr: "", code: 0 });

test("clipboard read commands pick platform-specific tools", () => {
  assert.deepEqual(
    clipboardReadCommands("darwin", {}).map((c) => c.command),
    ["pbpaste"],
  );
  assert.deepEqual(
    clipboardReadCommands("win32", {}).map((c) => c.command),
    ["powershell.exe"],
  );
  assert.deepEqual(
    clipboardReadCommands("linux", { WAYLAND_DISPLAY: "wayland-0" }).map((c) => c.command),
    ["wl-paste", "xclip", "xsel"],
  );
  assert.deepEqual(
    clipboardReadCommands("linux", { DISPLAY: ":0" }).map((c) => c.command),
    ["xclip", "xsel", "wl-paste"],
  );
  assert.deepEqual(
    clipboardReadCommands("linux", { TERMUX_VERSION: "0.118" }).map((c) => c.command),
    ["termux-clipboard-get"],
  );
});

test("readClipboardText uses pbpaste on macOS and preserves stdout verbatim", async () => {
  const calls: string[] = [];
  const result = await readClipboardText(fakeExec({ pbpaste: ok("line 1\nline 2\n") }, calls), {
    platform: "darwin",
  });
  assert.deepEqual(result, { text: "line 1\nline 2\n", source: "macOS clipboard" });
  assert.deepEqual(calls, ["pbpaste"]);
});

test("readClipboardText falls through missing and failing Linux tools", async () => {
  const calls: string[] = [];
  const exec = fakeExec(
    {
      xclip: { stdout: "", stderr: "Error: target STRING not available", code: 1 },
      xsel: ok("from xsel"),
    },
    calls,
  );
  const result = await readClipboardText(exec, { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } });
  assert.deepEqual(result, { text: "from xsel", source: "X11 clipboard" });
  assert.deepEqual(calls, ["wl-paste", "xclip", "xsel"]);
});

test("readClipboardText reports every attempted tool when all fail", async () => {
  await assert.rejects(
    readClipboardText(fakeExec({ xclip: { stdout: "", stderr: "", code: 1 } }), { platform: "linux", env: {} }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Unable to read clipboard text\./);
      assert.match(error.message, /xclip: exited with status 1/);
      assert.match(error.message, /xsel: spawn xsel ENOENT/);
      assert.match(error.message, /wl-paste: spawn wl-paste ENOENT/);
      return true;
    },
  );
});
