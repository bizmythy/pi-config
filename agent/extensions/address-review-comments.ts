import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  Markdown,
  matchesKey,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const REVIEW_SCRIPT_RELATIVE_PATH = "dev_tools/review/address_comments.py";
const REPLY_TEMPLATES_RELATIVE_PATH =
  "generate/agentskills/manual_skills/address-review-comments/references/comment-reply-templates.md";
const REPLACED_SKILL_NAME = "address-review-comments";
const EXPECTED_REMOTE = "diracq/buildos-web";
const CHECKPOINT_OPTIONS = ["resolve", "post", "edit", "feedback", "skip", "abort"] as const;

const CHECKPOINT_OPTION_LABELS = {
  resolve: "resolve - post the draft reply and resolve the thread",
  post: "post - post the draft reply only",
  edit: "edit - provide instructions to edit the draft reply",
  feedback: "feedback - provide feedback for the agent to address, then checkpoint again",
  skip: "skip - post nothing for this thread",
  abort: "abort - stop processing remaining comments",
} as const;

type CheckpointOption = (typeof CHECKPOINT_OPTIONS)[number];

interface CheckpointParams {
  threadId: string;
  location: string;
  reviewer?: string;
  checkpointMarkdown: string;
  draftReply: string;
  recommendedAction?: "resolve" | "post";
}

interface WorkflowState {
  repoRoot: string;
  fetchResponsePath: string;
  startCommitShort: string;
  prNumber?: number;
  startedAt: string;
  active?: boolean;
  finishedAt?: string;
}

interface FetchPayload {
  repository?: string;
  pull_request?: {
    number?: number;
    title?: string;
  };
  review_threads?: Array<{
    id?: string;
    is_outdated?: boolean;
    comments?: Array<{ author?: string | null; author_is_bot?: boolean }>;
  }>;
}

interface RepoResolution {
  repoRoot: string;
  remoteSlug?: string;
}

function parseArgs(args: string): { ok: true; prNumber?: number } | { ok: false; message: string } {
  const trimmed = args.trim();
  if (!trimmed) return { ok: true };

  const parts = trimmed.split(/\s+/);
  if (parts.includes("--auto")) {
    return { ok: false, message: "Automatic mode is not supported. Use /address-review-comments [PR_NUMBER]." };
  }
  if (parts.some((part) => part.startsWith("-"))) {
    return { ok: false, message: "Unsupported option. Use /address-review-comments [PR_NUMBER]." };
  }
  if (parts.length > 1) {
    return { ok: false, message: "Too many arguments. Use /address-review-comments [PR_NUMBER]." };
  }
  if (!/^\d+$/.test(parts[0] ?? "")) {
    return { ok: false, message: "PR number must be a positive integer." };
  }

  return { ok: true, prNumber: Number(parts[0]) };
}

function parseGitHubSlug(remoteUrl: string): string | undefined {
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ssh) return ssh[1];

  const https = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (https) return https[1];

  return undefined;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeFetch(payload: FetchPayload): string {
  const threads = payload.review_threads ?? [];
  const outdated = threads.filter((thread) => thread.is_outdated).length;
  const actionable = threads.length - outdated;
  const authors = new Set<string>();

  for (const thread of threads) {
    for (const comment of thread.comments ?? []) {
      if (!comment.author_is_bot && comment.author) authors.add(comment.author);
    }
  }

  const pr = payload.pull_request?.number ? `PR #${payload.pull_request.number}` : "the PR";
  const title = payload.pull_request?.title ? ` (${payload.pull_request.title})` : "";
  const reviewers =
    authors.size > 0
      ? ` from ${[...authors]
          .sort()
          .map((author) => `@${author}`)
          .join(", ")}`
      : "";

  return [
    `Found ${threads.length} unresolved review thread(s) on ${pr}${title}.`,
    `- ${actionable} actionable/current`,
    `- ${outdated} outdated`,
    reviewers ? `- reviewers: ${reviewers}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

async function resolveRepo(pi: ExtensionAPI, ctx: ExtensionContext): Promise<RepoResolution> {
  const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 5_000 });
  if (rootResult.code !== 0) {
    throw new Error("/address-review-comments must be run from inside the BuildOS git repository.");
  }

  const repoRoot = rootResult.stdout.trim();
  if (!repoRoot) throw new Error("Unable to determine repository root.");

  const scriptPath = path.join(repoRoot, REVIEW_SCRIPT_RELATIVE_PATH);
  try {
    await access(scriptPath);
  } catch {
    throw new Error(`This does not look like the BuildOS repository; missing ${REVIEW_SCRIPT_RELATIVE_PATH}.`);
  }

  const remoteResult = await pi.exec("git", ["remote", "get-url", "origin"], { cwd: repoRoot, timeout: 5_000 });
  const remoteSlug = remoteResult.code === 0 ? parseGitHubSlug(remoteResult.stdout.trim()) : undefined;
  if (remoteSlug && remoteSlug !== EXPECTED_REMOTE) {
    throw new Error(`This extension is intended for ${EXPECTED_REMOTE}; current origin is ${remoteSlug}.`);
  }

  return { repoRoot, remoteSlug };
}

async function getShortHead(pi: ExtensionAPI, repoRoot: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, timeout: 5_000 });
  if (result.code !== 0)
    throw new Error(`Unable to determine current commit.\n${result.stderr || result.stdout}`.trim());
  return result.stdout.trim();
}

async function runFetch(pi: ExtensionAPI, repoRoot: string, prNumber?: number): Promise<string> {
  const args = ["run", REVIEW_SCRIPT_RELATIVE_PATH, "fetch"];
  if (prNumber !== undefined) args.push(String(prNumber));

  const result = await pi.exec("uv", args, { cwd: repoRoot, timeout: 120_000 });
  if (result.code !== 0) {
    throw new Error(`Failed to fetch review comments.\n${result.stderr || result.stdout}`.trim());
  }

  const responsePath = firstLine(result.stdout);
  if (!responsePath) throw new Error("Review comment fetch did not return a response file path.");

  try {
    await access(responsePath);
  } catch {
    throw new Error(`Review comment fetch returned an unreadable path: ${responsePath}`);
  }

  return responsePath;
}

async function loadFetchPayload(fetchResponsePath: string): Promise<FetchPayload> {
  const raw = await readFile(fetchResponsePath, "utf8");
  return JSON.parse(raw) as FetchPayload;
}

async function runReply(
  pi: ExtensionAPI,
  state: WorkflowState,
  threadId: string,
  draftReply: string,
  resolve: boolean,
): Promise<string> {
  const args = ["run", REVIEW_SCRIPT_RELATIVE_PATH, "reply", threadId, "--comment", draftReply];
  if (resolve) args.push("--resolve");

  const result = await pi.exec("uv", args, { cwd: state.repoRoot, timeout: 120_000 });
  if (result.code !== 0) {
    throw new Error(`Failed to submit review reply.\n${result.stderr || result.stdout}`.trim());
  }

  const responsePath = firstLine(result.stdout);
  if (!responsePath) throw new Error("Review reply submission did not return a response file path.");

  try {
    await access(responsePath);
  } catch {
    throw new Error(`Review reply submission returned an unreadable path: ${responsePath}`);
  }

  return responsePath;
}

function makeCheckpointMarkdown(checkpoint: CheckpointParams): string {
  const reviewer = checkpoint.reviewer ? `\n**Reviewer:** @${checkpoint.reviewer}` : "";
  const recommended = checkpoint.recommendedAction
    ? `\n**Recommended action:** \`${checkpoint.recommendedAction}\``
    : "";
  return `# Review checkpoint\n\n**Location:** \`${checkpoint.location}\`${reviewer}${recommended}\n\n---\n\n${checkpoint.checkpointMarkdown}\n\n---\n\n## Draft reply\n\n${checkpoint.draftReply}`;
}

function padToWidth(line: string, width: number): string {
  const truncated = truncateToWidth(line, width, "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

class ReviewCheckpointDialog implements Component {
  private readonly markdown: Markdown;
  private scrollOffset = 0;
  private selectedIndex: number;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    checkpoint: CheckpointParams,
    private readonly done: (result: CheckpointOption | undefined) => void,
  ) {
    this.markdown = new Markdown(makeCheckpointMarkdown(checkpoint), 1, 0, getMarkdownTheme(), {
      bgColor: (text) => theme.bg("customMessageBg", text),
    });
    this.selectedIndex = Math.max(0, CHECKPOINT_OPTIONS.indexOf(checkpoint.recommendedAction ?? "resolve"));
  }

  render(width: number): string[] {
    const availableHeight = Math.max(1, this.tui.terminal.rows - 2);
    const height = Math.min(availableHeight, Math.max(12, Math.floor(this.tui.terminal.rows * 0.9)));
    const bodyWidth = Math.max(1, width - 2);
    const bodyLines = this.markdown.render(bodyWidth);
    const fixedLineCount = 7;
    const viewportHeight = Math.max(1, height - fixedLineCount);
    const maxScrollOffset = Math.max(0, bodyLines.length - viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));

    const visibleBody = bodyLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
    while (visibleBody.length < viewportHeight)
      visibleBody.push(this.theme.bg("customMessageBg", " ".repeat(bodyWidth)));

    const lines = [
      this.border("╭", "╮", width),
      this.frame(this.theme.fg("accent", this.theme.bold("Review checkpoint")), width),
      this.frame(this.scrollText(bodyLines.length, viewportHeight), width),
      ...visibleBody.map((line) => this.frame(line, width)),
      this.frame(this.actionText(), width),
      this.frame(this.theme.fg("dim", CHECKPOINT_OPTION_LABELS[CHECKPOINT_OPTIONS[this.selectedIndex]]), width),
      this.frame(
        this.theme.fg("dim", "↑↓/PgUp/PgDn scroll • ←→ choose • 1-6 shortcut • Enter select • Esc abort"),
        width,
      ),
      this.border("╰", "╯", width),
    ];

    return lines.slice(0, height);
  }

  handleInput(data: string): void {
    const page = Math.max(3, Math.floor(this.tui.terminal.rows * 0.5));

    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(CHECKPOINT_OPTIONS[this.selectedIndex]);
      return;
    }
    if (/^[1-6]$/.test(data)) {
      this.done(CHECKPOINT_OPTIONS[Number(data) - 1]);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.selectedIndex = (this.selectedIndex + CHECKPOINT_OPTIONS.length - 1) % CHECKPOINT_OPTIONS.length;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.selectedIndex = (this.selectedIndex + 1) % CHECKPOINT_OPTIONS.length;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset += 1;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - page);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += page;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  private border(left: string, right: string, width: number): string {
    return this.theme.fg("borderAccent", left + "─".repeat(Math.max(0, width - 2)) + right);
  }

  private frame(content: string, width: number): string {
    const innerWidth = Math.max(0, width - 2);
    const inner = padToWidth(content, innerWidth);
    return this.theme.fg("borderAccent", "│") + inner + this.theme.fg("borderAccent", "│");
  }

  private scrollText(totalLines: number, viewportHeight: number): string {
    const first = Math.min(totalLines, this.scrollOffset + 1);
    const last = Math.min(totalLines, this.scrollOffset + viewportHeight);
    const moreAbove = this.scrollOffset > 0 ? `↑ ${this.scrollOffset} above` : "top";
    const moreBelow = last < totalLines ? `↓ ${totalLines - last} below` : "bottom";
    return this.theme.fg("dim", `Showing ${first}-${last} of ${totalLines} lines (${moreAbove}, ${moreBelow})`);
  }

  private actionText(): string {
    return CHECKPOINT_OPTIONS.map((option, index) => {
      const label = ` ${index + 1}:${option} `;
      return index === this.selectedIndex
        ? this.theme.bg("selectedBg", this.theme.fg("accent", label))
        : this.theme.fg("muted", label);
    }).join(" ");
  }
}

function makeAgentPrompt(state: WorkflowState, summary: string): string {
  const replyTemplatesPath = path.join(state.repoRoot, REPLY_TEMPLATES_RELATIVE_PATH);
  return `# Address PR Review Comments

You are addressing PR review comments in manual interactive mode. The review context has already been fetched for you.

Repository root: \`${state.repoRoot}\`
Fetch response JSON file: \`${state.fetchResponsePath}\`
Starting commit: \`${state.startCommitShort}\` (compare against this to track overall review changes)
Reply templates: \`${replyTemplatesPath}\`

${summary}

## Critical rules

- Treat the fetch response JSON file as the source of truth. Inspect it with \`jq\`, \`read\`, or other read-only tools as needed. The JSON payload itself is intentionally not pasted here.
- Summarize the unresolved review threads, then proceed immediately. Do not ask the user whether to proceed.
- Process review threads one at a time. Continue until every thread is resolved, posted, skipped, flagged, or the user selects abort.
- Never attempt to fix different issues at once, fix one issue at a time and present a checkpoint before continuing.
  - If multiple comments are regarding the same issue/fix, you may group those.
- Never run the hidden review-comment fetch/reply operations yourself and never use manual GitHub reply/resolve commands.
- To ask for human approval or submit any reply, call \`address_review_checkpoint\`. This includes outdated-thread replies.
- The human is the only approval gate. A reply is submitted only when \`address_review_checkpoint\` returns \`resolve\` or \`post\` with a response file path.
- When \`address_review_checkpoint\` returns \`edit\`, incorporate the user's edit instructions and recreate the checkpoint for the same thread.
- When it returns \`feedback\`, address the user's feedback in the code and/or draft reply, then recreate the checkpoint for the same thread.
- When it returns \`skip\`, revert all code changes you made for that comment, post no reply, track it as skipped, and continue.
- When it returns \`abort\`, stop processing remaining comments and summarize the current state.
- Leave your own changes unstaged. Never commit. The user may commit changes while you work, so HEAD may advance or status may be clean at the end.
- Never add AI attribution or co-authorship.

## Suggested workflow

1. Inspect the fetch response JSON and authored diff path. Use \`jq\` to list thread ids, locations, authors, comments, outdated status, and diff hunks.
2. Present a concise summary of the review threads.
3. For each thread:
   - Show reviewer, location, diff hunk, and full conversation.
   - Read the current file state around the relevant code.
   - If line numbers shifted, locate the code using the diff hunk/surrounding context.
   - Decide whether this is a code change, question, disagreement, out-of-scope note, ambiguous request, generated-code issue, or outdated concern.
   - Make the appropriate code change when needed.
   - Draft a concise reply using the reply templates.
   - Call \`address_review_checkpoint\` with the thread id, location, checkpoint summary/diff, and exact draft reply.
4. After all threads are processed, summarize addressed/skipped/flagged items.`;
}

function setWorkflowStatus(ctx: ExtensionContext, active: boolean) {
  ctx.ui.setStatus("review-comments", active ? ctx.ui.theme.fg("warning", "review-comments") : undefined);
}

function stripReplacedSkillFromSystemPrompt(systemPrompt: string): string {
  let next = systemPrompt.replace(
    /\n? {2}<skill>\n {4}<name>address-review-comments<\/name>\n[\s\S]*? {2}<\/skill>\n?/g,
    "\n",
  );

  next = next.replace(/<available_skills>\n\s*<\/available_skills>/g, "<available_skills>\n</available_skills>");
  return next;
}

export default function addressReviewCommentsExtension(pi: ExtensionAPI) {
  let activeWorkflow: WorkflowState | undefined;

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    if (new RegExp(`^/skill:${REPLACED_SKILL_NAME}(\\s|$)`).test(event.text.trim())) {
      ctx.ui.notify(
        `The ${REPLACED_SKILL_NAME} skill is disabled in pi; use /address-review-comments instead.`,
        "warning",
      );
      return { action: "handled" };
    }

    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    const hasReplacedSkill = event.systemPromptOptions.skills?.some((skill) => skill.name === REPLACED_SKILL_NAME);
    if (!hasReplacedSkill) return undefined;

    return { systemPrompt: stripReplacedSkillFromSystemPrompt(event.systemPrompt) };
  });

  pi.registerCommand("address-review-comments", {
    description: "Address PR review comments with structured human checkpoints",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current agent turn to finish before addressing review comments.", "warning");
        return;
      }

      const parsed = parseArgs(args);
      if (parsed.ok === false) {
        ctx.ui.notify(parsed.message, "warning");
        return;
      }

      try {
        const { repoRoot } = await resolveRepo(pi, ctx);
        const startCommitShort = await getShortHead(pi, repoRoot);
        ctx.ui.notify("Fetching review comments...", "info");
        const fetchResponsePath = await runFetch(pi, repoRoot, parsed.prNumber);
        const payload = await loadFetchPayload(fetchResponsePath);
        const threads = payload.review_threads ?? [];

        if (threads.length === 0) {
          ctx.ui.notify("No unresolved review comments found.", "info");
          return;
        }

        activeWorkflow = {
          repoRoot,
          fetchResponsePath,
          startCommitShort,
          prNumber: parsed.prNumber ?? payload.pull_request?.number,
          startedAt: new Date().toISOString(),
          active: true,
        };
        pi.appendEntry("address-review-comments-state", activeWorkflow);
        setWorkflowStatus(ctx, true);

        const summary = summarizeFetch(payload);
        ctx.ui.notify(`Fetched ${threads.length} unresolved review thread(s). Starting agent workflow.`, "info");
        pi.sendUserMessage(makeAgentPrompt(activeWorkflow, summary));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
    },
  });

  pi.registerTool({
    name: "address_review_checkpoint",
    label: "Review Checkpoint",
    description:
      "Present a review-comment checkpoint to the user. Use for every review-comment reply decision; the tool handles approved submissions after human review.",
    promptSnippet: "Present a review-comment checkpoint for human approval before any reply is submitted",
    promptGuidelines: [
      "Use address_review_checkpoint for every PR review-comment reply decision; do not submit review-comment replies any other way.",
      "After address_review_checkpoint returns edit or feedback, update the draft or code and call address_review_checkpoint again for the same thread.",
      "After address_review_checkpoint returns skip, revert changes for that thread and continue to the next thread.",
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "GitHub review thread id from the fetched review payload",
        },
        location: {
          type: "string",
          description: "Human-readable file:line location for this thread",
        },
        reviewer: {
          type: "string",
          description: "Reviewer login, if known",
        },
        checkpointMarkdown: {
          type: "string",
          description: "Markdown summary for the user: comment, analysis, changes, and relevant diff excerpt",
        },
        draftReply: {
          type: "string",
          description: "Exact reply body proposed for posting if the user approves",
        },
        recommendedAction: {
          type: "string",
          enum: ["resolve", "post"],
          description: "Recommended approval action for display only",
        },
      },
      required: ["threadId", "location", "checkpointMarkdown", "draftReply"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error("address_review_checkpoint requires an interactive UI because human review is mandatory.");
      }
      if (!activeWorkflow) {
        throw new Error("No active /address-review-comments workflow. Start one with /address-review-comments first.");
      }

      const checkpoint = params as CheckpointParams;
      const selectedOption = await ctx.ui.custom<CheckpointOption | undefined>(
        (tui, theme, _keybindings, done) => new ReviewCheckpointDialog(tui, theme, checkpoint, done),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 },
        },
      );

      if (!selectedOption) {
        const finishedWorkflow = { ...activeWorkflow, active: false, finishedAt: new Date().toISOString() };
        activeWorkflow = undefined;
        pi.appendEntry("address-review-comments-state", finishedWorkflow);
        setWorkflowStatus(ctx, false);
        return {
          content: [
            {
              type: "text",
              text: "User dismissed the checkpoint. Treat this as abort: stop processing remaining comments and summarize current state.",
            },
          ],
          details: { selectedOption: "abort", threadId: checkpoint.threadId },
        };
      }

      if (selectedOption === "edit" || selectedOption === "feedback") {
        const prompt =
          selectedOption === "edit"
            ? "Describe how the draft reply should be edited."
            : "Provide feedback for the agent to address before recreating this checkpoint.";
        const userText = await ctx.ui.editor(prompt, "");
        return {
          content: [
            {
              type: "text",
              text: `User selected ${selectedOption}. User input:\n\n${userText ?? ""}\n\nIncorporate this input, then call address_review_checkpoint again for the same thread.`,
            },
          ],
          details: { selectedOption, threadId: checkpoint.threadId, userText: userText ?? "" },
        };
      }

      if (selectedOption === "skip" || selectedOption === "abort") {
        if (selectedOption === "abort") {
          const finishedWorkflow = { ...activeWorkflow, active: false, finishedAt: new Date().toISOString() };
          activeWorkflow = undefined;
          pi.appendEntry("address-review-comments-state", finishedWorkflow);
          setWorkflowStatus(ctx, false);
        }

        return {
          content: [
            {
              type: "text",
              text:
                selectedOption === "skip"
                  ? "User selected skip. Revert changes made for this thread, post no reply, track it as skipped, and continue."
                  : "User selected abort. Stop processing remaining comments and summarize current state.",
            },
          ],
          details: { selectedOption, threadId: checkpoint.threadId },
        };
      }

      const replyResponsePath = await runReply(
        pi,
        activeWorkflow,
        checkpoint.threadId,
        checkpoint.draftReply,
        selectedOption === "resolve",
      );
      pi.appendEntry("address-review-comments-checkpoint", {
        threadId: checkpoint.threadId,
        selectedOption,
        replyResponsePath,
        location: checkpoint.location,
      });

      return {
        content: [
          {
            type: "text",
            text: `User selected ${selectedOption}. Reply submitted. Response JSON file: ${replyResponsePath}\n\nInspect the response file if needed, then continue to the next review thread.`,
          },
        ],
        details: { selectedOption, threadId: checkpoint.threadId, replyResponsePath },
      };
    },
    renderCall(args) {
      const location = typeof args.location === "string" ? args.location : "unknown location";
      const reviewer = typeof args.reviewer === "string" ? `@${args.reviewer}` : undefined;
      const checkpointMarkdown =
        typeof args.checkpointMarkdown === "string" ? args.checkpointMarkdown : "No checkpoint summary provided.";
      const draftReply = typeof args.draftReply === "string" ? args.draftReply : "";
      const recommendedAction =
        args.recommendedAction === "resolve" || args.recommendedAction === "post" ? args.recommendedAction : undefined;

      const metadata = [
        `**Location:** \`${location}\``,
        reviewer ? `**Reviewer:** ${reviewer}` : undefined,
        recommendedAction ? `**Recommended action:** \`${recommendedAction}\`` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");

      const markdown = `## Review checkpoint\n\n${metadata}\n\n---\n\n${checkpointMarkdown}\n\n---\n\n### Draft reply\n\n${draftReply}`;
      return new Markdown(markdown, 0, 0, getMarkdownTheme());
    },
    renderResult(result, _options, theme) {
      const details = result.details as
        | { selectedOption?: string; replyResponsePath?: string; userText?: string }
        | undefined;
      if (!details?.selectedOption) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      let text = `${theme.fg("success", "✓")} ${theme.fg("accent", details.selectedOption)}`;
      if (details.replyResponsePath) text += `\n${theme.fg("dim", `response: ${details.replyResponsePath}`)}`;
      if (details.userText) text += `\n${theme.fg("dim", "user input provided")}`;
      return new Text(text, 0, 0);
    },
  });

  pi.on("tool_call", async (event) => {
    if (!activeWorkflow || event.toolName !== "bash") return undefined;

    const command = String(event.input.command ?? "");
    const isReviewOperation = command.includes(REVIEW_SCRIPT_RELATIVE_PATH) && /\b(fetch|reply)\b/.test(command);
    const isManualGitHubReviewMutation =
      /\bgh\s+api\b/.test(command) &&
      /(addPullRequestReviewThreadReply|resolveReviewThread|reviewThreads)/.test(command);

    if (isReviewOperation || isManualGitHubReviewMutation) {
      return {
        block: true,
        reason:
          "Direct review-comment fetch/reply operations are blocked during /address-review-comments. Use the provided JSON file path and address_review_checkpoint instead.",
      };
    }

    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    const lastState = ctx.sessionManager
      .getEntries()
      .filter(
        (entry: { type: string; customType?: string }) =>
          entry.type === "custom" && entry.customType === "address-review-comments-state",
      )
      .pop() as { data?: WorkflowState } | undefined;

    activeWorkflow = lastState?.data?.active === false ? undefined : lastState?.data;
    setWorkflowStatus(ctx, Boolean(activeWorkflow));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    setWorkflowStatus(ctx, false);
  });
}
