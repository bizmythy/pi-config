import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const HISTORY_FILE = path.join(os.homedir(), ".pi", "agent", "prompt-history.json");
const HISTORY_VERSION = 1;
const MAX_PERSISTED_ENTRIES = 1000;
// The built-in editor currently caps in-memory up/down history at 100 entries.
const MAX_SEEDED_EDITOR_ENTRIES = 100;
const WRAPPED_FACTORY = Symbol("global-history-wrapped-editor-factory");

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

type HistoryFile = {
  version: number;
  entries: string[];
};

type WrappedEditorFactory = EditorFactory & { [WRAPPED_FACTORY]?: true };
type HistoryCapableEditor = ReturnType<EditorFactory> & {
  addToHistory?: (text: string) => void;
};

let persistEnabled = false;

function normalizeEntry(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEntries(entries: unknown, limit = MAX_PERSISTED_ENTRIES): string[] {
  if (!Array.isArray(entries)) return [];

  const result: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== "string") continue;

    const normalized = normalizeEntry(entry);
    if (!normalized || seen.has(normalized)) continue;

    result.push(normalized);
    seen.add(normalized);

    if (result.length >= limit) break;
  }

  return result;
}

function readHistory(): string[] {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];

    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<HistoryFile>;
    return normalizeEntries(parsed.entries);
  } catch {
    // If the file is missing, truncated, or manually edited incorrectly, leave pi usable.
    return [];
  }
}

function writeHistory(entries: string[]): void {
  const normalized = normalizeEntries(entries);
  const payload: HistoryFile = {
    version: HISTORY_VERSION,
    entries: normalized,
  };

  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });

  const tmp = `${HISTORY_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, HISTORY_FILE);
}

function saveEntry(text: string): void {
  const entry = normalizeEntry(text);
  if (!entry) return;

  try {
    // Re-read on each save so concurrent pi instances are less likely to clobber
    // each other's recent prompts. This is not a full file lock, but it avoids
    // most last-writer-wins losses.
    const current = readHistory();
    writeHistory([entry, ...current.filter((existing) => existing !== entry)]);
  } catch {
    // History persistence should never break prompt submission.
  }
}

function clearHistory(): void {
  writeHistory([]);
}

function seedEditorHistory(editor: HistoryCapableEditor, addToHistory: (text: string) => void): void {
  // addToHistory() unshifts, so seed oldest -> newest to preserve newest-first order.
  const entriesToSeed = readHistory().slice(0, MAX_SEEDED_EDITOR_ENTRIES).reverse();
  for (const entry of entriesToSeed) {
    addToHistory.call(editor, entry);
  }
}

function patchEditorHistory(editor: HistoryCapableEditor): HistoryCapableEditor {
  if (typeof editor.addToHistory !== "function") {
    return editor;
  }

  const originalAddToHistory = editor.addToHistory;
  seedEditorHistory(editor, originalAddToHistory);

  editor.addToHistory = (text: string) => {
    const entry = normalizeEntry(text);
    if (!entry) return;

    originalAddToHistory.call(editor, entry);

    if (persistEnabled) {
      saveEntry(entry);
    }
  };

  return editor;
}

function makeWrappedEditorFactory(previous: EditorFactory | undefined): WrappedEditorFactory {
  const factory = ((tui, theme, keybindings) => {
    const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    return patchEditorHistory(editor);
  }) as WrappedEditorFactory;

  factory[WRAPPED_FACTORY] = true;
  return factory;
}

function isWrappedFactory(factory: EditorFactory | undefined): boolean {
  return Boolean((factory as WrappedEditorFactory | undefined)?.[WRAPPED_FACTORY]);
}

function installGlobalHistoryWrapper(ctx: ExtensionContext): void {
  const current = ctx.ui.getEditorComponent();
  if (isWrappedFactory(current)) return;

  ctx.ui.setEditorComponent(makeWrappedEditorFactory(current));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    persistEnabled = false;

    // Install now if this extension runs after other editor extensions.
    installGlobalHistoryWrapper(ctx);

    setTimeout(() => {
      // Install again after all session_start handlers have had a chance to run.
      // This preserves compatibility with editor extensions that run after this one,
      // such as pi-vim: we wrap their final editor instead of replacing it.
      installGlobalHistoryWrapper(ctx);

      // Resumed sessions populate editor history immediately after session_start.
      // Delay persistence so those replayed messages are not bulk-imported into
      // the global history file just by opening an old session.
      persistEnabled = true;
    }, 0);
  });

  pi.on("session_shutdown", () => {
    persistEnabled = false;
  });

  pi.registerCommand("history-clear", {
    description: "Clear the persistent global prompt history used by up-arrow navigation",
    handler: async (_args, ctx) => {
      clearHistory();
      ctx.ui.notify(
        "Global prompt history cleared. Current in-memory history resets on /reload or next session.",
        "success" as "info",
      );
    },
  });
}
