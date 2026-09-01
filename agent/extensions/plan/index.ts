import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { resolveExtensionPath } from "../shared/paths.js";
import { latestCustomEntryData } from "../shared/session-entries.js";
import { createLazyToolActivation } from "../shared/tool-activation.js";
import { isPlanTargetPath } from "./paths.js";
import { makeImplementPrompt, makePlanPrompt } from "./prompt.js";
import { type PersistedPlanExtensionState, type PlanState, restorePlanExtensionState } from "./state.js";

const PCLOUD_PLANS_ROOT = path.join(homedir(), "pCloudDrive", "pi-agent", "plans");
const FALLBACK_PLANS_ROOT = path.join(homedir(), ".pi", "agent", "plans");
const MAX_PLAN_CHOICES = 20;
const FINISH_PLAN_TOOL_NAME = "finish_plan";

interface PlanFile {
  path: string;
  dir: string;
  filename: string;
  mtimeMs: number;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Resolve the plans root: prefer the pCloud-synced directory when pCloud is
 * mounted, otherwise fall back to a gitignored directory under ~/.pi.
 */
async function resolvePlansRoot(): Promise<string> {
  try {
    const pCloudDrive = path.join(homedir(), "pCloudDrive");
    const driveStat = await stat(pCloudDrive);
    if (driveStat.isDirectory()) return PCLOUD_PLANS_ROOT;
  } catch {}
  return FALLBACK_PLANS_ROOT;
}

async function ensurePlansRootExists(root: string): Promise<void> {
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new Error(`Plan path exists but is not a directory: ${root}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(root, { recursive: true });
      return;
    }
    throw error;
  }
}

async function listPlanFiles(): Promise<PlanFile[]> {
  const plansRoot = await resolvePlansRoot();
  await ensurePlansRootExists(plansRoot);
  const dirs = await readdir(plansRoot);

  const plans: PlanFile[] = [];
  for (const dirname of dirs) {
    const dir = path.join(plansRoot, dirname);
    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
      dirStat = await stat(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }

    for (const filename of entries) {
      if (!filename.endsWith(".md")) continue;
      const filePath = path.join(dir, filename);
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) continue;
        plans.push({
          path: filePath,
          dir,
          filename,
          mtimeMs: Math.max(fileStat.mtimeMs, dirStat.mtimeMs),
        });
      } catch {}
    }
  }

  return plans.sort((a, b) => {
    const dirCompare = path.basename(b.dir).localeCompare(path.basename(a.dir));
    if (dirCompare !== 0) return dirCompare;
    return b.mtimeMs - a.mtimeMs;
  });
}

function formatPlanLabel(plan: PlanFile, index: number): string {
  const date = new Date(plan.mtimeMs).toISOString().replace("T", " ").slice(0, 19);
  const dirName = path.basename(plan.dir);
  return `${String(index + 1).padStart(2, "0")}. ${date}  ${dirName}/${plan.filename}`;
}

export default function planExtension(pi: ExtensionAPI) {
  let planningInProgress = false;
  let activePlan: PlanState = {};

  function persistPlanState() {
    pi.appendEntry("plan-extension-state", { activePlan, planningInProgress });
  }

  function clearPlanStatus(ctx?: ExtensionContext) {
    ctx?.ui.setStatus("plan", undefined);
  }

  function setPlanStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus("plan", ctx.ui.theme.fg("warning", "plan"));
  }

  const finishPlanTool = createLazyToolActivation(pi, FINISH_PLAN_TOOL_NAME, () => {
    pi.registerTool({
      name: FINISH_PLAN_TOOL_NAME,
      label: "Finish Plan",
      description: "Finish a /plan turn after the target plan file has been written.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The exact target plan file path that was written",
          },
          summary: {
            type: "string",
            description: "One-sentence summary of the plan",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!planningInProgress) {
          throw new Error("finish_plan is only available during an active /plan turn.");
        }

        const planDir =
          activePlan.dir ??
          (activePlan.path ? path.dirname(resolveExtensionPath(activePlan.path, ctx.cwd)) : undefined);
        if (!planDir) {
          throw new Error("No active plan directory is registered.");
        }

        const requestedPath = String(params.path);
        const actual = resolveExtensionPath(requestedPath, ctx.cwd);
        if (!isPlanTargetPath(requestedPath, ctx.cwd, planDir)) {
          throw new Error(`finish_plan path must be a *-plan.md file directly inside ${planDir}; got ${requestedPath}`);
        }

        try {
          const fileStat = await stat(actual);
          if (!fileStat.isFile()) throw new Error("not a file");
        } catch {
          throw new Error(`Plan file does not exist yet: ${requestedPath}`);
        }

        const planMarkdown = await readFile(actual, "utf8");
        activePlan = { ...activePlan, dir: planDir, path: actual };
        planningInProgress = false;
        clearPlanStatus(ctx);
        finishPlanTool.setEnabled(false);
        persistPlanState();

        const reviewMarkdown = `# Plan ready for review\n\nFile: \`${activePlan.path}\`\n\n---\n\n${planMarkdown}`;
        return {
          content: [{ type: "text", text: reviewMarkdown }],
          details: {
            path: activePlan.path,
            summary: params.summary,
            markdown: reviewMarkdown,
          },
          terminate: true,
        };
      },
      renderResult(result) {
        const details = result.details as { markdown?: string } | undefined;
        if (details?.markdown) {
          return new Markdown(details.markdown, 0, 0, getMarkdownTheme());
        }
        const firstContent = result.content?.[0];
        const fallbackText = firstContent && "text" in firstContent ? firstContent.text : "Plan saved.";
        return new Markdown(String(fallbackText), 0, 0, getMarkdownTheme());
      },
    });
  });

  pi.registerCommand("plan", {
    description:
      "Create a file-backed plan in ~/pCloudDrive/pi-agent/plans/<timestamp>/ (falls back to ~/.pi/agent/plans when pCloud is unavailable)",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const description = args.trim();
      if (!description) {
        ctx.ui.notify("Usage: /plan <description>", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current agent turn to finish before starting a plan.", "warning");
        return;
      }

      const plansRoot = await resolvePlansRoot();
      await ensurePlansRootExists(plansRoot);

      const createdAt = timestamp();
      const dir = path.join(plansRoot, createdAt);
      await mkdir(dir, { recursive: true });

      activePlan = { dir, description, createdAt };
      planningInProgress = true;
      finishPlanTool.setEnabled(true);
      persistPlanState();
      setPlanStatus(ctx);

      ctx.ui.notify(`Planning in ${dir}`, "info");
      pi.sendUserMessage(makePlanPrompt(description, dir));
    },
  });

  pi.registerCommand("plan-implement", {
    description: "Select one of the 20 most recent plans and implement it in a fresh session",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current agent turn to finish before implementing a plan.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/plan-implement requires an interactive UI for plan selection.", "warning");
        return;
      }

      const plans = (await listPlanFiles()).slice(0, MAX_PLAN_CHOICES);
      if (plans.length === 0) {
        ctx.ui.notify(`No plans found in ${await resolvePlansRoot()}`, "warning");
        return;
      }

      const labels = plans.map(formatPlanLabel);
      const selected = await ctx.ui.select("Select a plan to implement", labels);
      if (!selected) return;

      const index = labels.indexOf(selected);
      const plan = plans[index];
      if (!plan) return;

      const content = await readFile(plan.path, "utf8");
      const prompt = makeImplementPrompt(plan.path, content);

      const result = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Implementing ${plan.filename}`, "info");
          await newCtx.sendUserMessage(prompt);
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("Plan implementation session was cancelled.", "warning");
      }
    },
  });

  pi.registerCommand("plan-cancel", {
    description: "Cancel the current /plan turn and keep the active plan file context",
    handler: async (_args, ctx) => {
      planningInProgress = false;
      clearPlanStatus(ctx);
      finishPlanTool.setEnabled(false);
      persistPlanState();
      ctx.ui.notify("Plan turn cancelled.", "info");
    },
  });

  pi.on("before_agent_start", async (_event) => {
    const activePlanDir = activePlan.dir ?? (activePlan.path ? path.dirname(activePlan.path) : undefined);
    if (planningInProgress && activePlanDir) {
      return {
        message: {
          customType: "plan-extension-context",
          content: `[PLAN CREATION ACTIVE]\nTarget plan directory: ${activePlanDir}\nChoose a concise, meaningful kebab-case filename ending in -plan.md. Only create or edit that plan file inside this directory. Do not modify project files. When the plan file is complete, call finish_plan with the path you chose.`,
          display: false,
        },
      };
    }

    if (activePlan.path) {
      return {
        message: {
          customType: "plan-extension-context",
          content: `[ACTIVE PLAN FILE]\nMost recent plan file: ${activePlan.path}\nIf the user gives feedback or asks to refine the plan, edit that plan file. Do not edit project files unless the user explicitly asks to implement the plan or make code changes.`,
          display: false,
        },
      };
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const planDir =
      activePlan.dir ?? (activePlan.path ? path.dirname(resolveExtensionPath(activePlan.path, ctx.cwd)) : undefined);
    if (!planningInProgress || !planDir) return undefined;

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = String(event.input.path ?? "");
      if (!isPlanTargetPath(filePath, ctx.cwd, planDir)) {
        return {
          block: true,
          reason: `Plan mode can only write a *-plan.md file inside ${planDir}`,
        };
      }
    }

    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    const persisted = latestCustomEntryData<PersistedPlanExtensionState>(
      ctx.sessionManager.getBranch(),
      "plan-extension-state",
    );
    const restored = restorePlanExtensionState(persisted);

    activePlan = restored.activePlan;
    planningInProgress = restored.planningInProgress;
    finishPlanTool.setEnabled(planningInProgress);
    if (planningInProgress) {
      setPlanStatus(ctx);
    } else {
      clearPlanStatus(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (planningInProgress) clearPlanStatus(ctx);
    finishPlanTool.setEnabled(false);
  });
}
