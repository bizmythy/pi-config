import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 12_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 10,
  });
  return String(stdout).trimEnd();
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

function readGitFile(gitDir: string, relativePath: string): string | null {
  const path = join(gitDir, relativePath);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function truncate(value: string | null, max = MAX_OUTPUT): string {
  if (!value) return "(none)";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n... [truncated ${value.length - max} chars]`;
}

type Operation = {
  name: string;
  instruction: string;
  details: string[];
};

async function detectOperation(cwd: string, gitDir: string): Promise<Operation> {
  const details: string[] = [];

  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    const dir = existsSync(join(gitDir, "rebase-merge")) ? "rebase-merge" : "rebase-apply";
    const headName = readGitFile(gitDir, `${dir}/head-name`);
    const onto = readGitFile(gitDir, `${dir}/onto`);
    const msgnum = readGitFile(gitDir, `${dir}/msgnum`);
    const end = readGitFile(gitDir, `${dir}/end`);
    const currentPatch = readGitFile(gitDir, `${dir}/patch`);
    const stoppedSha = readGitFile(gitDir, `${dir}/stopped-sha`);

    details.push(`rebase state dir: ${dir}`);
    if (headName) details.push(`rebasing branch: ${headName}`);
    if (onto) details.push(`onto: ${onto}`);
    if (msgnum || end) details.push(`progress: ${msgnum ?? "?"}/${end ?? "?"}`);
    if (stoppedSha) details.push(`stopped commit: ${stoppedSha}`);
    if (currentPatch) details.push(`current patch:\n${truncate(currentPatch, 8_000)}`);

    return {
      name: "rebase",
      instruction:
        "Continue the in-progress rebase. Resolve conflicts semantically, stage the resolved files, and run `git rebase --continue`. Repeat until the rebase is fully complete, handling any additional conflicts that appear.",
      details,
    };
  }

  const cherryPickHead = readGitFile(gitDir, "CHERRY_PICK_HEAD");
  if (cherryPickHead) {
    const commit = await tryGit(cwd, ["show", "--stat", "--format=fuller", "--no-renames", cherryPickHead]);
    details.push(`cherry-pick commit: ${cherryPickHead}`);
    if (commit) details.push(`cherry-pick commit details:\n${truncate(commit, 10_000)}`);
    return {
      name: "cherry-pick",
      instruction:
        "Continue the in-progress cherry-pick. Resolve conflicts semantically, stage the resolved files, and run `git cherry-pick --continue`. Repeat if the operation includes a sequence of commits until fully complete.",
      details,
    };
  }

  const revertHead = readGitFile(gitDir, "REVERT_HEAD");
  if (revertHead) {
    const commit = await tryGit(cwd, ["show", "--stat", "--format=fuller", "--no-renames", revertHead]);
    details.push(`revert commit: ${revertHead}`);
    if (commit) details.push(`revert commit details:\n${truncate(commit, 10_000)}`);
    return {
      name: "revert",
      instruction:
        "Continue the in-progress revert. Resolve conflicts semantically, stage the resolved files, and run `git revert --continue`. Repeat if the operation includes a sequence of commits until fully complete.",
      details,
    };
  }

  const mergeHead = readGitFile(gitDir, "MERGE_HEAD");
  if (mergeHead) {
    const commits = await tryGit(cwd, ["show", "--stat", "--format=fuller", "--no-renames", ...mergeHead.split(/\s+/)]);
    details.push(`merge head(s): ${mergeHead}`);
    const mergeMsg = readGitFile(gitDir, "MERGE_MSG");
    if (mergeMsg) details.push(`merge message:\n${mergeMsg}`);
    if (commits) details.push(`merge commit details:\n${truncate(commits, 10_000)}`);
    return {
      name: "merge",
      instruction:
        "Continue the in-progress merge. Resolve conflicts semantically, stage the resolved files, and commit the merge using the existing merge message when appropriate. Repeat checks until the working tree is no longer in a conflicted merge state.",
      details,
    };
  }

  if (existsSync(join(gitDir, "BISECT_LOG"))) {
    details.push("bisect state detected");
    return {
      name: "bisect",
      instruction:
        "A git bisect appears to be active. Resolve any conflicts semantically if present, then proceed carefully with the bisect workflow only as needed.",
      details,
    };
  }

  if (existsSync(join(gitDir, "sequencer"))) {
    const todo = readGitFile(gitDir, "sequencer/todo");
    const head = readGitFile(gitDir, "sequencer/head");
    if (head) details.push(`sequencer head: ${head}`);
    if (todo) details.push(`sequencer todo:\n${todo}`);
    return {
      name: "sequencer",
      instruction:
        "A git sequencer operation appears to be active. Determine whether it is a cherry-pick/revert sequence, resolve conflicts semantically, stage resolved files, and continue with the appropriate `git ... --continue` command until fully complete.",
      details,
    };
  }

  return {
    name: "none detected",
    instruction:
      "No active git operation was detected. If conflicts are present, resolve them semantically and stage the resolved files. Do not invent or start a merge/rebase/cherry-pick operation unless the repository state clearly requires it.",
    details,
  };
}

async function buildPrompt(cwd: string): Promise<string> {
  const gitDir = await tryGit(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) {
    throw new Error("/git-conflicts must be run from inside a git repository (no .git directory found).");
  }

  const [repoRoot, branch, upstream, status, conflictedFiles, unmergedEntries, remotes] = await Promise.all([
    tryGit(cwd, ["rev-parse", "--show-toplevel"]),
    tryGit(cwd, ["branch", "--show-current"]),
    tryGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    tryGit(cwd, ["status", "--short", "--branch", "--untracked-files=all"]),
    tryGit(cwd, ["diff", "--name-only", "--diff-filter=U"]),
    tryGit(cwd, ["ls-files", "-u"]),
    tryGit(cwd, ["remote", "-v"]),
  ]);

  const mainRef =
    (await tryGit(cwd, ["rev-parse", "--verify", "main"])) ? "main" :
    (await tryGit(cwd, ["rev-parse", "--verify", "origin/main"])) ? "origin/main" :
    (await tryGit(cwd, ["rev-parse", "--verify", "master"])) ? "master" :
    (await tryGit(cwd, ["rev-parse", "--verify", "origin/master"])) ? "origin/master" :
    null;

  const [recentBranchLog, recentMainLog, mergeBase, diffStatMain] = await Promise.all([
    tryGit(cwd, ["log", "--oneline", "--decorate", "-12", "HEAD", "--"]),
    mainRef ? tryGit(cwd, ["log", "--oneline", "--decorate", "-12", mainRef, "--"]) : Promise.resolve(null),
    mainRef ? tryGit(cwd, ["merge-base", "HEAD", mainRef]) : Promise.resolve(null),
    mainRef ? tryGit(cwd, ["diff", "--stat", `${mainRef}...HEAD`]) : Promise.resolve(null),
  ]);

  const operation = await detectOperation(cwd, gitDir);

  return `View the git context for the current repository branch and main, then resolve all conflicts and proceed with the current operation until fully complete and all conflicts are resolved.

Detected git repository context:
- repository root: ${repoRoot ?? cwd}
- git dir: ${gitDir}
- current branch: ${branch || "(detached HEAD or unknown)"}
- upstream: ${upstream ?? "(none)"}
- main ref used for context: ${mainRef ?? "(none found; inspect refs manually if needed)"}
- merge-base with main ref: ${mergeBase ?? "(not available)"}
- active git operation: ${operation.name}

Operation-specific instruction:
${operation.instruction}

Rules for conflict resolution:
- ALWAYS analyze conflicts semantically and preserve the intention of BOTH sides whenever possible.
- If intent is unclear, read commit messages, surrounding code, tests, and related files until you can resolve safely without deleting crucial work.
- Prefer minimal, coherent resolutions that compile and preserve behavior from both sides.
- After editing conflict files, remove all conflict markers, stage resolved files, and run the appropriate continue command for the active operation.
- If more conflicts appear after continuing, repeat the same process until the git operation is complete.
- Verify completion with git status. Run relevant tests or checks when practical.
- Do not abort, skip commits, reset, or force-push unless the user explicitly asks.

Relevant git details captured at invocation:

## git status --short --branch --untracked-files=all
${truncate(status)}

## conflicted files (git diff --name-only --diff-filter=U)
${truncate(conflictedFiles)}

## unmerged index entries (git ls-files -u)
${truncate(unmergedEntries)}

## remotes
${truncate(remotes)}

## active operation details
${operation.details.length ? operation.details.map((detail) => `### ${detail}`).join("\n\n") : "(none)"}

## recent current-branch commits
${truncate(recentBranchLog)}

## recent main commits
${truncate(recentMainLog)}

## diff stat main...HEAD
${truncate(diffStatMain)}

Start by inspecting the conflicted files and relevant commit context, then resolve and continue the operation until git reports it is fully complete.`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git-conflicts", {
    description: "Resolve git conflicts and continue the active merge/rebase/cherry-pick operation",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Run /git-conflicts again when it is idle.", "warning");
        return;
      }

      try {
        const prompt = await buildPrompt(ctx.cwd);
        ctx.ui.notify("Starting git conflict resolution workflow", "info");
        pi.sendUserMessage(prompt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
    },
  });
}
