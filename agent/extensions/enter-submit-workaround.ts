import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const PATCHED_EDITOR = Symbol("enter-submit-workaround");
const PATCHED_FACTORY = Symbol("enter-submit-workaround-factory");

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type PatchableFactory = EditorFactory & {
  [PATCHED_FACTORY]?: true;
};
type PatchableEditor = ReturnType<EditorFactory> & {
  [PATCHED_EDITOR]?: true;
};

function patchEditor(editor: PatchableEditor): PatchableEditor {
  if (editor[PATCHED_EDITOR]) return editor;

  const originalHandleInput = editor.handleInput;
  editor.handleInput = (data: string) => {
    // Pi 0.82 treats a lone LF as an unconditional newline before consulting
    // keybindings. Some terminals emit LF for Enter, so normalize it to the
    // CR sequence used by Pi's regular submit path.
    originalHandleInput.call(editor, data === "\n" ? "\r" : data);
  };
  editor[PATCHED_EDITOR] = true;
  return editor;
}

function installWorkaround(ctx: ExtensionContext): void {
  const current = ctx.ui.getEditorComponent() as PatchableFactory | undefined;
  if (current?.[PATCHED_FACTORY]) return;

  const factory = ((tui, theme, keybindings) => {
    const editor = current?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    return patchEditor(editor);
  }) as PatchableFactory;
  factory[PATCHED_FACTORY] = true;
  ctx.ui.setEditorComponent(factory);
}

export default function enterSubmitWorkaround(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    installWorkaround(ctx);
    setTimeout(() => installWorkaround(ctx), 0);
  });
}
