import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const GO_126_NEW_WARNING =
  "Go 1.26 note: the built-in `new` may take an expression, not just a type. `new(expr)` allocates storage initialized to `expr` and returns a pointer, e.g. `p := new(int64(300))` gives `*int64` pointing to `300`. Double-check your work when editing Go code that uses `new()`.";

function isGoPath(path: unknown): path is string {
  return typeof path === "string" && path.endsWith(".go");
}

function usesNewCall(line: string): boolean {
  return /\bnew\s*\(/.test(line);
}

function changedLines(oldText: string, newText: string): string[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const lengths: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    Array.from({ length: newLines.length + 1 }, () => 0),
  );

  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      lengths[i][j] =
        oldLines[i] === newLines[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const changed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      changed.push(oldLines[i++]);
    } else {
      changed.push(newLines[j++]);
    }
  }
  while (i < oldLines.length) changed.push(oldLines[i++]);
  while (j < newLines.length) changed.push(newLines[j++]);

  return changed;
}

function editTouchesNewCall(input: Record<string, unknown>): boolean {
  if (!isGoPath(input.path)) return false;

  const edits = input.edits;
  if (!Array.isArray(edits)) return false;

  return edits.some((edit) => {
    if (typeof edit !== "object" || edit === null) return false;
    const oldText = (edit as { oldText?: unknown }).oldText;
    const newText = (edit as { newText?: unknown }).newText;
    if (typeof oldText !== "string" || typeof newText !== "string") return false;
    return changedLines(oldText, newText).some(usesNewCall);
  });
}

function appendWarning(content: ToolResultEvent["content"]): ToolResultEvent["content"] {
  const warningBlock: ToolResultEvent["content"][number] = { type: "text", text: `\n\n⚠️ ${GO_126_NEW_WARNING}` };
  return [...content, warningBlock];
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "edit") return undefined;
    if (!editTouchesNewCall(event.input)) return undefined;

    return { content: appendWarning(event.content) };
  });
}
