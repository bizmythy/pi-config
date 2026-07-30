import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REVIEW_PROMPT } from "./prompt.js";
import { isolateReviewMessages, parseReviewOutput, renderReviewOutput, resolveReview } from "./review.js";

const STATUS_ID = "review";

interface ActiveReview {
  baseBranch: string;
  prompt: string;
}

function projectInstructions(contextFiles: Array<{ path: string; content: string }> | undefined): string {
  if (!contextFiles?.length) return "";
  const files = contextFiles.map(({ path, content }) => `## ${path}\n\n${content.trim()}`).join("\n\n");
  return `\n\n# Project instructions\n\n${files}`;
}

export default function reviewExtension(pi: ExtensionAPI) {
  let activeReview: ActiveReview | undefined;

  const clearReview = (ctx?: { ui: { setStatus(key: string, text: string | undefined): void } }) => {
    activeReview = undefined;
    ctx?.ui.setStatus(STATUS_ID, undefined);
  };

  pi.registerCommand("review", {
    description: "Review the current branch against a base branch (default: main)",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current agent turn to finish before starting a review.", "warning");
        return;
      }

      try {
        const resolved = await resolveReview(args, async (gitArgs) => {
          return pi.exec("git", gitArgs, { cwd: ctx.cwd, timeout: 10_000 });
        });

        activeReview = { baseBranch: resolved.baseBranch, prompt: resolved.prompt };
        ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `review:${resolved.baseBranch}`));
        ctx.ui.notify(`Reviewing ${resolved.currentBranch} against ${resolved.baseBranch}`, "info");
        pi.sendUserMessage(resolved.prompt);
      } catch (error) {
        clearReview(ctx);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!activeReview || event.prompt !== activeReview.prompt) return undefined;
    return {
      systemPrompt: REVIEW_PROMPT + projectInstructions(event.systemPromptOptions.contextFiles),
    };
  });

  pi.on("context", async (event) => {
    if (!activeReview) return undefined;
    return { messages: isolateReviewMessages(event.messages, activeReview.prompt) };
  });

  pi.on("tool_call", async (event) => {
    if (!activeReview) return undefined;
    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: "/review is read-only and cannot modify files.",
      };
    }
    return undefined;
  });

  pi.on("message_end", async (event) => {
    if (!activeReview || event.message.role !== "assistant" || event.message.stopReason === "toolUse") {
      return undefined;
    }

    const responseText = event.message.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("");
    const output = parseReviewOutput(responseText);
    if (!output) return undefined;

    return {
      message: {
        ...event.message,
        content: [
          ...event.message.content.filter((content) => content.type !== "text"),
          { type: "text" as const, text: renderReviewOutput(output) },
        ],
      },
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (activeReview) clearReview(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearReview(ctx);
  });
}
