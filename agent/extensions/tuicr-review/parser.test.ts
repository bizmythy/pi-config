import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseTuicrReview } from "./parser.js";

test("parses the repository's example tuicr review", async () => {
  const markdown = await readFile(new URL("../../../example-review.md", import.meta.url), "utf8");
  const review = parseTuicrReview(markdown);

  assert.equal(review.session, "diracq/buildos-web@drew-blueport-deck-capture/commits/b23e0a6..7840727");
  assert.equal(review.comments.length, 2);
  assert.deepEqual(review.comments[0], {
    id: "comment-1",
    ordinal: 1,
    type: "SUGGESTION",
    location: "blueport-capture/build.rs:48-58",
    path: "blueport-capture/build.rs",
    startLine: 48,
    endLine: 58,
    side: "new",
    context: undefined,
    body: "should consider setting this to just build _everything_ for these pb instead of limiting and needing to manually add...",
  });
});

test("parses typeless, commit-scoped, deleted-line, and multiline comments", () => {
  const review = parseTuicrReview(`## Session: owner/repo@main/worktree

Summary: Focus on correctness

## Local tuicr Comments

1. \`src/auth.rs\` - Add tests
2. **[ISSUE]** \`src/old.rs:~20-~25\` (commit abc1234) - The first line
   The second line

## Existing GitHub Comments

1. \`src/api.rs:42\` @alice - Handle the empty case
   <https://example.test/thread>
   - @bob - Agreed
`);

  assert.equal(review.summary, "Focus on correctness");
  assert.equal(review.comments.length, 3);
  assert.deepEqual(review.comments[1], {
    id: "comment-2",
    ordinal: 2,
    type: "ISSUE",
    location: "src/old.rs:~20-~25",
    path: "src/old.rs",
    startLine: 20,
    endLine: 25,
    side: "old",
    context: "(commit abc1234)",
    body: "The first line\nThe second line",
  });
  assert.equal(review.comments[2].context, "@alice");
  assert.equal(review.comments[2].body, "Handle the empty case\n<https://example.test/thread>\n- @bob - Agreed");
});
