import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolateReviewMessages, parseReviewOutput, renderReviewOutput, resolveReview } from "./review.js";

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("resolves the default base to the real branch merge base", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-review-"));
  try {
    assert.equal(runGit(cwd, ["init", "-b", "main"]).code, 0);
    assert.equal(runGit(cwd, ["config", "user.name", "Review Test"]).code, 0);
    assert.equal(runGit(cwd, ["config", "user.email", "review@example.test"]).code, 0);

    await writeFile(path.join(cwd, "file.txt"), "base\n");
    assert.equal(runGit(cwd, ["add", "file.txt"]).code, 0);
    assert.equal(runGit(cwd, ["commit", "-m", "base"]).code, 0);
    const expectedMergeBase = runGit(cwd, ["rev-parse", "HEAD"]).stdout.trim();

    assert.equal(runGit(cwd, ["switch", "-c", "feature"]).code, 0);
    await writeFile(path.join(cwd, "file.txt"), "base\nfeature\n");
    assert.equal(runGit(cwd, ["commit", "-am", "feature"]).code, 0);

    const review = await resolveReview("", async (args) => runGit(cwd, args));
    assert.equal(review.baseBranch, "main");
    assert.equal(review.currentBranch, "feature");
    assert.equal(review.mergeBase, expectedMergeBase);
    assert.match(review.prompt, new RegExp(`git diff ${expectedMergeBase}`));
    assert.match(review.prompt, /relative to main/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reports a missing base branch before starting a review", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-review-"));
  try {
    assert.equal(runGit(cwd, ["init", "-b", "main"]).code, 0);
    assert.equal(runGit(cwd, ["config", "user.name", "Review Test"]).code, 0);
    assert.equal(runGit(cwd, ["config", "user.email", "review@example.test"]).code, 0);
    await writeFile(path.join(cwd, "file.txt"), "base\n");
    assert.equal(runGit(cwd, ["add", "file.txt"]).code, 0);
    assert.equal(runGit(cwd, ["commit", "-m", "base"]).code, 0);

    await assert.rejects(
      resolveReview("does-not-exist", async (args) => runGit(cwd, args)),
      /Base branch 'does-not-exist' does not resolve to a commit/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("parses Codex review JSON and renders the user-facing review", () => {
  const raw = `Review result:\n\n\`\`\`json
{
  "findings": [{
    "title": "Preserve the refresh token",
    "body": "This path drops the token needed by the next request.",
    "confidence_score": 0.97,
    "priority": 1,
    "code_location": {
      "absolute_file_path": "/repo/src/auth.ts",
      "line_range": {"start": 42, "end": 43}
    }
  }],
  "overall_correctness": "patch is incorrect",
  "overall_explanation": "The token regression breaks session refresh.",
  "overall_confidence_score": 0.95
}
\`\`\``;

  const output = parseReviewOutput(raw);
  assert.ok(output);
  assert.equal(
    renderReviewOutput(output),
    "The token regression breaks session refresh.\n\nReview comment:\n\n- [P1] Preserve the refresh token — /repo/src/auth.ts:42-43\n  This path drops the token needed by the next request.",
  );
});

test("isolates a review turn from earlier conversation while retaining its tool exchange", () => {
  const prompt = "Review branch against main";
  const messages = [
    { role: "user", content: "Implement the feature" },
    { role: "assistant", content: [{ type: "text", text: "Done" }] },
    { role: "user", content: [{ type: "text", text: prompt }] },
    { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
    { role: "toolResult", content: [{ type: "text", text: "diff" }] },
  ];

  assert.deepEqual(isolateReviewMessages(messages, prompt), messages.slice(2));
});
