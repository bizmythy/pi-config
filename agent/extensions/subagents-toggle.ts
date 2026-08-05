/**
 * Lazy loader for pi-subagents.
 *
 * pi-subagents package skills and prompt templates are disabled in settings.json
 * package filters, and this extension removes the subagent tool from the active
 * tool set by default. Use /subagents-on (or /subagents-attach) to attach those
 * resources for the current Pi process. Attachment survives session replacement
 * (/new, /resume, /fork, and /plan-implement) until /subagents-off or process exit.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const ATTACHED_KEY = "__piSubagentsToggleAttached";
const PACKAGE_ROOT = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");
const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");
const PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");

function getGlobalStore(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

function isAttached(): boolean {
  return getGlobalStore()[ATTACHED_KEY] === true;
}

function setAttached(attached: boolean): void {
  getGlobalStore()[ATTACHED_KEY] = attached;
}

async function reloadWithState(ctx: ExtensionCommandContext, attached: boolean): Promise<void> {
  setAttached(attached);
  if (ctx.hasUI) {
    ctx.ui.notify(
      attached ? "Attaching pi-subagents tools, skills, prompts, and slash commands..." : "Detaching pi-subagents...",
      "info",
    );
  }
  await ctx.reload();
}

function applySubagentToolState(pi: ExtensionAPI): void {
  const activeTools = new Set(pi.getActiveTools());
  if (isAttached()) {
    activeTools.add("subagent");
  } else {
    activeTools.delete("subagent");
  }
  pi.setActiveTools(Array.from(activeTools));
}

export default async function subagentsToggle(pi: ExtensionAPI): Promise<void> {
  pi.on("session_start", () => {
    applySubagentToolState(pi);
  });

  pi.on("resources_discover", () => {
    if (!isAttached()) return;
    return {
      skillPaths: [SKILLS_DIR],
      promptPaths: [PROMPTS_DIR],
    };
  });

  pi.registerCommand("subagents-on", {
    description: "Attach pi-subagents tools, slash commands, skills, and prompt templates for this Pi process",
    handler: async (_args, ctx) => {
      if (isAttached()) {
        if (ctx.hasUI) ctx.ui.notify("pi-subagents is already attached.", "info");
        return;
      }
      await reloadWithState(ctx, true);
    },
  });

  pi.registerCommand("subagents-attach", {
    description: "Alias for /subagents-on",
    handler: async (_args, ctx) => {
      if (isAttached()) {
        if (ctx.hasUI) ctx.ui.notify("pi-subagents is already attached.", "info");
        return;
      }
      await reloadWithState(ctx, true);
    },
  });

  pi.registerCommand("subagents-off", {
    description: "Detach pi-subagents and reload without its resources",
    handler: async (_args, ctx) => {
      if (!isAttached()) {
        if (ctx.hasUI) ctx.ui.notify("pi-subagents is already detached.", "info");
        return;
      }
      await reloadWithState(ctx, false);
    },
  });

  pi.registerCommand("subagents-status", {
    description: "Show whether pi-subagents is attached",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-subagents is ${isAttached() ? "attached" : "detached"}.`, "info");
      }
    },
  });
}
