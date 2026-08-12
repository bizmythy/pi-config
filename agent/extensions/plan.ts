import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { isPlanTargetPath } from "./plan-support/paths.js";
import { resolveExtensionPath } from "./shared/paths.js";
import { latestCustomEntryData } from "./shared/session-entries.js";
import { createLazyToolActivation } from "./shared/tool-activation.js";

const PLANS_ROOT = path.join(homedir(), "pCloudDrive", "pi-agent", "plans");
const MAX_PLAN_CHOICES = 20;
const FINISH_PLAN_TOOL_NAME = "finish_plan";

const BASE_PLAN_PROMPT = `# Plan Mode

You are now in planning mode. Read, research, and plan only. Do not make any project changes.

## Constraints

- Do NOT edit, create, or delete any project files.
- The ONLY file you may create or edit is a single plan file inside the target plan directory named below.
- Do NOT run commands that modify state (no git commit, no writes, no installs).
- Bash commands may ONLY read or inspect (ls, find, rg, git log, git diff, etc.).
- This overrides all other instructions. Zero exceptions.

## Workflow

### 1. Research

Before planning, explore the codebase to understand what exists:

- Check if any available skills relate to this task. Load them for specialized workflows and constraints.
- Read project documentation (AGENTS.md, READMEs, architecture docs) for conventions and guidelines.
- Read relevant files, configs, and conventions.
- Check for related patterns, prior art, and existing implementations.
- Review recent git history for context.
- Understand the architecture and constraints.
- Check documentation.
- Assess the current state of the code involved in this change. It may not be in its final form and may need refactoring before or during implementation. Form a judgment: is the current structure suitable for this change, or does it need restructuring first?

### 2. Plan

Structure the plan as end-to-end vertical slices. Each slice delivers a working, testable increment that cuts through all layers of the change. Order slices so earlier ones provide working foundations for later ones. If the code needs refactoring to support the change, that refactoring is its own slice.

Choose a detail level based on complexity:

**Minimal**, for simple, well-understood changes:
- What to change and why
- Tests to add or update (for coding tasks)
- Docs to add or update
- Acceptance criteria

**Standard**, for most features and non-trivial bugs:
- What to change and why
- Technical approach
- Tests to add or update (for coding tasks)
- Docs to add or update
- Acceptance criteria
- Risks or dependencies

**Comprehensive**, for architectural changes or complex features:
- What to change and why
- Technical approach with alternatives considered
- System-wide impact (what else is affected, error propagation, state risks)
- Implementation phases
- Test strategy: what kinds of tests, coverage of new paths, edge cases (for coding tasks)
- Documentation strategy
- Acceptance criteria
- Risks, dependencies, and mitigation

Default to **standard**. Use **minimal** when the change is obvious. Use **comprehensive** when the change is risky or cross-cutting.

For each significant change in the plan, explain *why* that change is needed, not just what it does. The overall goal provides context, but the reader should understand the reasoning behind each individual piece without having to infer it.

### 3. Present

Write the finished plan to the target plan file. The plan file should be self-contained and include:

- Feature description
- Research summary and relevant files/docs inspected
- The plan, structured as vertical slices
- Tests to add or update
- Docs to add or update, when behavior/features/APIs change
- Acceptance criteria
- Risks, dependencies, and open questions

Every question must include a suggested answer. You've done the research, so use it to propose the best default. The user can confirm or correct rather than figure it out from scratch. For each suggestion, explain the tradeoff: what alternatives you considered and why you chose this one over them.

When the plan file has been written, call the finish_plan tool. Do not provide a separate final message after that tool call.`;

interface PlanState {
  path?: string;
  dir?: string;
  description?: string;
  createdAt?: string;
}

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

async function ensurePlansRootExists(): Promise<void> {
  try {
    const rootStat = await stat(PLANS_ROOT);
    if (!rootStat.isDirectory()) {
      throw new Error(`Plan path exists but is not a directory: ${PLANS_ROOT}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Plan directory does not exist: ${PLANS_ROOT}`);
    }
    throw error;
  }
}

async function listPlanFiles(): Promise<PlanFile[]> {
  await ensurePlansRootExists();
  const dirs = await readdir(PLANS_ROOT);

  const plans: PlanFile[] = [];
  for (const dirname of dirs) {
    const dir = path.join(PLANS_ROOT, dirname);
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

function makePlanPrompt(description: string, planDir: string): string {
  return `${BASE_PLAN_PROMPT}

## Feature Description

${description}

## Target Plan Directory

Write the plan in this exact directory:

\`${planDir}\`

You choose the filename. Choose a concise, meaningful, kebab-case summary name based on the request and your research, not just the first words of the prompt. The filename must end with \`-plan.md\`.

Examples:
- \`auth-session-refresh-plan.md\`
- \`linear-pr-bootstrap-plan.md\`
- \`storybook-component-docs-plan.md\`

Create or overwrite only that plan file inside the target directory. Do not modify project files. After the plan file is complete, call \`finish_plan\` with the exact path you chose.`;
}

function makeImplementPrompt(planFile: string, planContent: string): string {
  return `Implement the selected plan.

Plan file: ${planFile}

First, read the plan and relevant project files as needed. Then execute the plan end-to-end, updating code, tests, and docs as appropriate. Keep the implementation aligned with the plan, but use judgment if you discover something during implementation that requires an adjustment. If you materially deviate from the plan, briefly explain why in your final response.

Selected plan content:

${planContent}`;
}

export default function planExtension(pi: ExtensionAPI) {
  let planningInProgress = false;
  let activePlan: PlanState = {};

  function persistPlanState() {
    pi.appendEntry("plan-extension-state", { activePlan });
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
    description: "Create a file-backed plan in ~/pCloudDrive/pi-agent/plans/<timestamp>/",
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

      await ensurePlansRootExists();

      const createdAt = timestamp();
      const dir = path.join(PLANS_ROOT, createdAt);
      await mkdir(dir);

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
        ctx.ui.notify(`No plans found in ${PLANS_ROOT}`, "warning");
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
    const lastState = latestCustomEntryData<{ activePlan?: PlanState }>(
      ctx.sessionManager.getEntries(),
      "plan-extension-state",
    );

    activePlan = lastState?.activePlan ?? {};
    planningInProgress = false;
    finishPlanTool.setEnabled(false);
    ctx.ui.setStatus("plan", undefined);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (planningInProgress) clearPlanStatus(ctx);
    finishPlanTool.setEnabled(false);
  });
}
