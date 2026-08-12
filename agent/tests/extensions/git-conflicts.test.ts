import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { buildPrompt, createGitExecutor, type GitExecutor } from "../../extensions/git-conflicts.js";

const result = (code = 0, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr, killed: false });

function fakeGit(responses: Record<string, ExecResult>, calls: string[][] = []): GitExecutor {
  return async (args) => {
    calls.push(args);
    return responses[args.join(" ")] ?? result(1, "", "unavailable");
  };
}

test("git-conflicts Pi adapter supplies git, cwd, and timeout", async () => {
  let request: { command: string; args: string[]; options: unknown } | undefined;
  const exec = createGitExecutor(async (command, args, options) => {
    request = { command, args, options };
    return result();
  }, "/repo");
  await exec(["status"]);
  assert.deepEqual(request, { command: "git", args: ["status"], options: { cwd: "/repo", timeout: 20_000 } });
});

test("git-conflicts rejects non-repositories through the injected executor", async () => {
  await assert.rejects(buildPrompt(fakeGit({}), "/not-a-repo"), /must be run from inside a git repository/);
});

test("git-conflicts detects active operations and tolerates best-effort git failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-conflicts-"));
  const gitDir = join(root, ".git");
  await mkdir(join(gitDir, "rebase-merge"), { recursive: true });
  await writeFile(join(gitDir, "rebase-merge", "head-name"), "refs/heads/feature\n");
  await writeFile(join(gitDir, "rebase-merge", "msgnum"), "2\n");
  await writeFile(join(gitDir, "rebase-merge", "end"), "4\n");

  const calls: string[][] = [];
  try {
    const prompt = await buildPrompt(
      fakeGit(
        {
          "rev-parse --absolute-git-dir": result(0, `${gitDir}\n`),
          "rev-parse --show-toplevel": result(0, `${root}\n`),
          "branch --show-current": result(0, "feature\n"),
        },
        calls,
      ),
      root,
    );
    assert.match(prompt, /active git operation: rebase/);
    assert.match(prompt, /progress: 2\/4/);
    assert.match(prompt, /## remotes\n\(none\)/);
    assert.ok(calls.some((args) => args.join(" ") === "remote -v"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git-conflicts truncates captured prompt sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-conflicts-"));
  const gitDir = join(root, ".git");
  await mkdir(gitDir);
  try {
    const prompt = await buildPrompt(
      fakeGit({
        "rev-parse --absolute-git-dir": result(0, gitDir),
        "status --short --branch --untracked-files=all": result(0, "x".repeat(12_100)),
      }),
      root,
    );
    assert.match(prompt, /\.\.\. \[truncated 100 chars\]/);
    assert.ok(prompt.length < 20_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
