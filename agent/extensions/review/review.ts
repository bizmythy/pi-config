export const DEFAULT_BASE_BRANCH = "main";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitExecutor = (args: string[]) => Promise<GitResult>;

export interface ResolvedReview {
  baseBranch: string;
  currentBranch: string;
  mergeBase: string;
  prompt: string;
}

export interface ReviewFinding {
  title: string;
  body: string;
  confidence_score: number;
  priority?: number | null;
  code_location: {
    absolute_file_path: string;
    line_range: {
      start: number;
      end: number;
    };
  };
}

export interface ReviewOutput {
  findings: ReviewFinding[];
  overall_correctness: "patch is correct" | "patch is incorrect";
  overall_explanation: string;
  overall_confidence_score: number;
}

interface MessageLike {
  role: string;
  content?: unknown;
}

function commandError(command: string, result: GitResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `git exited with status ${result.code}`;
  return new Error(`${command}: ${detail}`);
}

export async function resolveReview(baseArgument: string, git: GitExecutor): Promise<ResolvedReview> {
  const baseBranch = baseArgument.trim() || DEFAULT_BASE_BRANCH;
  if (/\s/.test(baseBranch)) {
    throw new Error("/review accepts one base branch name, for example: /review main");
  }

  const repository = await git(["rev-parse", "--is-inside-work-tree"]);
  if (repository.code !== 0 || repository.stdout.trim() !== "true") {
    throw new Error("/review must be run from inside a git working tree.");
  }

  const head = await git(["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) throw commandError("Unable to resolve HEAD", head);

  const currentBranchResult = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (currentBranchResult.code !== 0 || !currentBranchResult.stdout.trim()) {
    throw new Error("/review requires HEAD to be on a branch; detached HEAD is not supported.");
  }

  const base = await git(["rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`]);
  if (base.code !== 0 || !base.stdout.trim()) {
    throw new Error(`Base branch '${baseBranch}' does not resolve to a commit.`);
  }

  const mergeBaseResult = await git(["merge-base", "HEAD", baseBranch]);
  const mergeBase = mergeBaseResult.stdout.trim();
  if (mergeBaseResult.code !== 0 || !mergeBase) {
    throw commandError(`Unable to find a merge base between HEAD and '${baseBranch}'`, mergeBaseResult);
  }

  return {
    baseBranch,
    currentBranch: currentBranchResult.stdout.trim(),
    mergeBase,
    prompt: `Review the code changes against the base branch '${baseBranch}'. The merge base commit for this comparison is ${mergeBase}. Run \`git diff ${mergeBase}\` to inspect the changes relative to ${baseBranch}. Provide prioritized, actionable findings.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPriority(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 3;
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  if (!isRecord(value) || !isRecord(value.code_location)) return false;
  const range = value.code_location.line_range;
  if (!isRecord(range)) return false;

  return (
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    isFiniteNumber(value.confidence_score) &&
    (value.priority === undefined || value.priority === null || isPriority(value.priority)) &&
    typeof value.code_location.absolute_file_path === "string" &&
    isFiniteNumber(range.start) &&
    isFiniteNumber(range.end)
  );
}

function isReviewOutput(value: unknown): value is ReviewOutput {
  if (!isRecord(value) || !Array.isArray(value.findings)) return false;
  return (
    value.findings.every(isReviewFinding) &&
    (value.overall_correctness === "patch is correct" || value.overall_correctness === "patch is incorrect") &&
    typeof value.overall_explanation === "string" &&
    isFiniteNumber(value.overall_confidence_score)
  );
}

export function parseReviewOutput(text: string): ReviewOutput | undefined {
  const candidates = [text.trim()];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isReviewOutput(parsed)) return parsed;
    } catch {}
  }
  return undefined;
}

function formatLocation(finding: ReviewFinding): string {
  const { absolute_file_path: filePath, line_range: range } = finding.code_location;
  return `${filePath}:${range.start}-${range.end}`;
}

function formatTitle(finding: ReviewFinding): string {
  if (finding.priority === undefined || finding.priority === null || /^\[P[0-3]\]\s/.test(finding.title)) {
    return finding.title;
  }
  return `[P${finding.priority}] ${finding.title}`;
}

export function renderReviewOutput(output: ReviewOutput): string {
  const sections: string[] = [];
  const explanation = output.overall_explanation.trim();
  if (explanation) sections.push(explanation);

  if (output.findings.length > 0) {
    const lines = [output.findings.length > 1 ? "Full review comments:" : "Review comment:"];
    for (const finding of output.findings) {
      lines.push("", `- ${formatTitle(finding)} — ${formatLocation(finding)}`);
      for (const bodyLine of finding.body.split("\n")) lines.push(`  ${bodyLine}`);
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n") || "Reviewer failed to output a response.";
}

function messageText(message: MessageLike): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;

  const text = message.content
    .filter((item): item is { type: "text"; text: string } => {
      return isRecord(item) && item.type === "text" && typeof item.text === "string";
    })
    .map((item) => item.text)
    .join("");
  return text || undefined;
}

export function isolateReviewMessages<T extends MessageLike>(messages: T[], reviewPrompt: string): T[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && messageText(message) === reviewPrompt) return messages.slice(index);
  }
  return messages;
}
