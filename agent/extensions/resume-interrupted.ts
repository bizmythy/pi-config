import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configuredShortcut } from "./shared/configured-shortcuts";

const RESUME_PROMPT =
  "Continue from where you left off before the interruption. Proceed with the existing task using the current conversation context; do not ask for confirmation unless blocked.";

export default function (pi: ExtensionAPI) {
  const shortcut = configuredShortcut("extension.resumeInterrupted");
  if (!shortcut) return;

  pi.registerShortcut(shortcut, {
    description: "Resume after interrupt",
    handler: (ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is already working; interrupt first, then use the configured resume shortcut.", "info");
        return;
      }

      pi.sendMessage(
        {
          customType: "resume-interrupted",
          content: RESUME_PROMPT,
          display: true,
        },
        { triggerTurn: true },
      );
      ctx.ui.notify("Resuming...", "info");
    },
  });
}
