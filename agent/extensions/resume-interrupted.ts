import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RESUME_PROMPT =
  "Continue from where you left off before the interruption. Proceed with the existing task using the current conversation context; do not ask for confirmation unless blocked.";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("alt+p", {
    description: "Resume after interrupt",
    handler: (ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is already working; interrupt first, then press Alt+P to resume.", "info");
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
