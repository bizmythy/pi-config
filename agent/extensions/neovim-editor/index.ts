import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NeovimEditor } from "./editor";
import { PromptHistory } from "./history";

export default function neovimEditorExtension(pi: ExtensionAPI): void {
  const editors = new Set<NeovimEditor>();
  const history = new PromptHistory();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new NeovimEditor(tui, theme, keybindings, {
        cwd: ctx.cwd,
        history,
        notify: (message, level) => ctx.ui.notify(message, level),
      });
      editors.add(editor);
      return editor;
    });

    setTimeout(() => {
      history.enablePersistence();
      for (const editor of editors) editor.enableHistoryPersistence();
    }, 0);
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...editors].map((editor) => editor.dispose()));
    editors.clear();
  });

  pi.registerCommand("history-clear", {
    description: "Clear the persistent global prompt history",
    handler: async (_args, ctx) => {
      history.clear();
      for (const editor of editors) editor.clearHistory();
      ctx.ui.notify("Global prompt history cleared.", "info");
    },
  });
}
