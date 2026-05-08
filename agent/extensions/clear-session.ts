import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
  return typeof (ctx as ExtensionCommandContext).waitForIdle === "function" &&
    typeof (ctx as ExtensionCommandContext).newSession === "function";
}

async function clearSession(ctx: ExtensionCommandContext) {
  await ctx.waitForIdle();
  const result = await ctx.newSession({
    withSession: async (ctx) => {
      ctx.ui.notify("Started a fresh session", "success");
    },
  });

  if (result.cancelled) {
    ctx.ui.notify("Clear cancelled", "warning");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Restart from scratch in a fresh session",
    handler: async (_args, ctx) => {
      await clearSession(ctx);
    },
  });

  pi.registerShortcut("ctrl+n", {
    description: "Restart from scratch in a fresh session",
    handler: async (ctx) => {
      if (!isCommandContext(ctx)) {
        ctx.ui.notify("Use /clear to start a fresh session; shortcuts cannot switch sessions in this pi version.", "warning");
        return;
      }

      await clearSession(ctx);
    },
  });
}
