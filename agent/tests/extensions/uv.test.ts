import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import uvExtension, { _test } from "../../extensions/uv.js";

function registerToolCallHandler() {
  let handler: ((event: never) => unknown) | undefined;
  const pi = {
    on(eventName: string, candidate: (event: never) => unknown) {
      if (eventName === "tool_call") handler = candidate;
    },
  } as unknown as ExtensionAPI;

  uvExtension(pi);
  assert.ok(handler);
  return handler;
}

test("Python commands are rewritten through uv without changing unrelated or explicit-path commands", () => {
  assert.equal(_test.rewritePythonCommands("python3 -c 'print(1)'"), "uv run python -c 'print(1)'");
  assert.equal(
    _test.rewritePythonCommands("printf ready && python script.py | python3.14 -c 'print(1)'"),
    "printf ready && uv run python script.py | uv run python -c 'print(1)'",
  );
  assert.equal(_test.rewritePythonCommands("uv run python script.py"), "uv run python script.py");
  assert.equal(_test.rewritePythonCommands(".venv/bin/python script.py"), ".venv/bin/python script.py");
  assert.equal(_test.rewritePythonCommands("echo python3"), "echo python3");
});

test("disallowed Python package and environment commands return actionable rejection reasons", () => {
  assert.match(_test.getBlockedCommandMessage("pip3 install pillow") ?? "", /^pip3 is disabled/);
  assert.match(_test.getBlockedCommandMessage("poetry sync") ?? "", /^poetry is disabled/);
  assert.match(_test.getBlockedCommandMessage("python3 -m pip install pillow") ?? "", /python -m pip/);
  assert.match(_test.getBlockedCommandMessage("uv run python -m venv .venv") ?? "", /python -m venv/);
  assert.match(
    _test.getBlockedCommandMessage(".venv/bin/python3.14 -m py_compile script.py") ?? "",
    /python -m py_compile/,
  );
  assert.equal(_test.getBlockedCommandMessage("uv pip install pillow"), null);
  assert.equal(_test.getBlockedCommandMessage("uv run python -m ast script.py"), null);
});

test("the tool_call hook mutates allowed bash calls and blocks rejected calls before execution", () => {
  const handler = registerToolCallHandler();
  const allowed = { toolName: "bash", input: { command: "python3 --version" } };

  assert.equal(handler(allowed as never), undefined);
  assert.equal(allowed.input.command, "uv run python --version");

  const blocked = { toolName: "bash", input: { command: "pip install pillow" } };
  assert.deepEqual(handler(blocked as never), {
    block: true,
    reason: [
      "pip is disabled. Use uv instead:",
      "",
      "  Install a package for a script: uv run --with PACKAGE python script.py",
      "  Add a project dependency: uv add PACKAGE",
    ].join("\n"),
  });
  assert.equal(blocked.input.command, "pip install pillow");
});
