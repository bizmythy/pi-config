/**
 * Redirect Python tooling in agent bash calls to uv equivalents.
 *
 * The extension uses Pi's tool_call hook so blocked commands produce explicit
 * tool rejections and supported Python invocations are rewritten before bash
 * runs. It intentionally does not depend on PATH shims or generated files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SHELL_COMMAND_PREFIX = String.raw`(?:^|\n|[;|&]{1,2})\s*`;
const PYTHON_EXECUTABLE = String.raw`(?:\S+/)?python(?:3(?:\.\d+)?)?`;

function getBlockedCommandMessage(command: string): string | null {
  const pipCommandPattern = new RegExp(`${SHELL_COMMAND_PREFIX}(?:\\S+/)?pip(?:$|\\s)`, "m");
  const pip3CommandPattern = new RegExp(`${SHELL_COMMAND_PREFIX}(?:\\S+/)?pip3(?:$|\\s)`, "m");
  const poetryCommandPattern = new RegExp(`${SHELL_COMMAND_PREFIX}(?:\\S+/)?poetry(?:$|\\s)`, "m");
  const pythonInvocation = String.raw`(?:uv\s+run(?:\s+--)?\s+)?${PYTHON_EXECUTABLE}\b[^\n;|&]*`;
  const pythonPipPattern = new RegExp(`${SHELL_COMMAND_PREFIX}${pythonInvocation}(?:\\s-m\\s*pip\\b|\\s-mpip\\b)`, "m");
  const pythonVenvPattern = new RegExp(
    `${SHELL_COMMAND_PREFIX}${pythonInvocation}(?:\\s-m\\s*venv\\b|\\s-mvenv\\b)`,
    "m",
  );
  const pythonPyCompilePattern = new RegExp(
    `${SHELL_COMMAND_PREFIX}${pythonInvocation}(?:\\s-m\\s*py_compile\\b|\\s-mpy_compile\\b)`,
    "m",
  );

  if (pip3CommandPattern.test(command)) {
    return [
      "pip3 is disabled. Use uv instead:",
      "",
      "  Install a package for a script: uv run --with PACKAGE python script.py",
      "  Add a project dependency: uv add PACKAGE",
    ].join("\n");
  }

  if (pipCommandPattern.test(command)) {
    return [
      "pip is disabled. Use uv instead:",
      "",
      "  Install a package for a script: uv run --with PACKAGE python script.py",
      "  Add a project dependency: uv add PACKAGE",
    ].join("\n");
  }

  if (poetryCommandPattern.test(command)) {
    return [
      "poetry is disabled. Use uv instead:",
      "",
      "  Initialize a project: uv init",
      "  Add a dependency: uv add PACKAGE",
      "  Sync dependencies: uv sync",
      "  Run a command: uv run COMMAND",
    ].join("\n");
  }

  if (pythonPipPattern.test(command)) {
    return [
      "'python -m pip' is disabled. Use uv instead:",
      "",
      "  Install a package for a script: uv run --with PACKAGE python script.py",
      "  Add a project dependency: uv add PACKAGE",
    ].join("\n");
  }

  if (pythonVenvPattern.test(command)) {
    return ["'python -m venv' is disabled. Create the environment with: uv venv"].join("\n");
  }

  if (pythonPyCompilePattern.test(command)) {
    return [
      "'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
      "",
      "  Verify syntax without bytecode: uv run python -m ast path/to/file.py >/dev/null",
    ].join("\n");
  }

  return null;
}

function rewritePythonCommands(command: string): string {
  // Rewrite bare Python commands at shell-segment boundaries. Explicit paths
  // remain untouched so project virtual environments can still be selected
  // deliberately.
  const pythonCommandPattern = /(^|\n|;|&&|\|\||\|)([ \t]*)(python(?:3(?:\.\d+)?)?)(?=[ \t]|$)/g;

  return command.replace(pythonCommandPattern, "$1$2uv run python");
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;

    const input = event.input as { command: string };
    const blockedMessage = getBlockedCommandMessage(input.command);
    if (blockedMessage) {
      return { block: true, reason: blockedMessage };
    }

    input.command = rewritePythonCommands(input.command);
    return undefined;
  });
}

export const _test = {
  getBlockedCommandMessage,
  rewritePythonCommands,
};
