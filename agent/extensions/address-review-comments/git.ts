import type { CommandExecutor } from "./types.js";

function detail(result: { code: number; stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || `exited with status ${result.code}`;
}

async function runGit(exec: CommandExecutor, cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, timeout: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${detail(result)}`);
  return result.stdout.trim();
}

export async function resolveRepositoryRoot(exec: CommandExecutor, cwd: string): Promise<string> {
  return runGit(exec, cwd, ["rev-parse", "--show-toplevel"]);
}

export async function currentBranch(exec: CommandExecutor, cwd: string): Promise<string> {
  const branch = await runGit(exec, cwd, ["branch", "--show-current"]);
  if (!branch) throw new Error("Detached HEAD; cannot infer the active pull request.");
  return branch;
}

export async function shortHead(exec: CommandExecutor, cwd: string): Promise<string> {
  return runGit(exec, cwd, ["rev-parse", "--short", "HEAD"]);
}

async function isDirty(exec: CommandExecutor, cwd: string): Promise<boolean> {
  return (await runGit(exec, cwd, ["status", "--porcelain"])) !== "";
}

export async function checkoutExplicitPull(
  exec: CommandExecutor,
  cwd: string,
  repository: string,
  pullNumber: number,
  expectedHeadBranch: string,
): Promise<boolean> {
  const [branch, dirty] = await Promise.all([currentBranch(exec, cwd), isDirty(exec, cwd)]);
  if (dirty) {
    if (branch !== expectedHeadBranch) {
      throw new Error(
        `Worktree is dirty; refusing to switch from ${branch} to pull request branch ${expectedHeadBranch}.`,
      );
    }
    return false;
  }

  const result = await exec("gh", ["pr", "checkout", String(pullNumber), "--repo", repository], {
    cwd,
    timeout: 120_000,
  });
  if (result.code !== 0) throw new Error(`gh pr checkout failed: ${detail(result)}`);
  return branch !== expectedHeadBranch;
}
