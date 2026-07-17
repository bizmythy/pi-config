import assert from "node:assert/strict";
import test from "node:test";
import { commentLabel } from "./labels.js";
import { parseTuicrReview } from "./parser.js";

test("parses tuicr comments from Markdown structure rather than physical lines", () => {
  const review = parseTuicrReview(`## Session: diracq/buildos-web@drew-blueport-deck-capture/commits/b23e0a6..7840727

Summary: Focus on correctness

## Local tuicr Comments

1. **[SUGGESTION]** \`blueport-capture/build.rs:48-58\` - should consider setting
   this to just build *everything* for these pb instead of limiting and
   needing to manually add...

   This remains part of the same comment after a blank line.

2. **[ISSUE]** \`src/old.rs:~20-~25\` (commit abc1234) - The first line
   The second line with a [reference](https://example.test/details).

   - @bob - Agreed
   - Include the nested-list text too
`);

  assert.equal(review.session, "diracq/buildos-web@drew-blueport-deck-capture/commits/b23e0a6..7840727");
  assert.equal(review.summary, "Focus on correctness");
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
    body: "should consider setting\nthis to just build everything for these pb instead of limiting and\nneeding to manually add...\n\nThis remains part of the same comment after a blank line.",
  });
  assert.equal(review.comments[1]?.context, "(commit abc1234)");
  assert.equal(
    review.comments[1]?.body,
    "The first line\nThe second line with a reference.\n\n- @bob - Agreed\n- Include the nested-list text too",
  );
  assert.equal(review.comments[1]?.side, "old");
});

test("parses separate ordered comment lists and typeless comments", () => {
  const review = parseTuicrReview(`## Local tuicr Comments

1. \`src/auth.rs\` - Add tests

## Existing GitHub Comments

1. \`src/api.rs:42\` @alice - Handle the empty case
   <https://example.test/thread>
`);

  assert.equal(review.comments.length, 2);
  assert.equal(review.comments[0]?.ordinal, 1);
  assert.equal(review.comments[1]?.ordinal, 1);
  assert.equal(review.comments[1]?.context, "@alice");
  assert.equal(review.comments[1]?.body, "Handle the empty case\nhttps://example.test/thread");
});

test("dropdown labels use configured feedback emoji, omit ordinals, and include all body text", () => {
  const comment = parseTuicrReview(`1. **[NITPICK]** \`src/a.ts:7\` - First physical line
   and a wrapped second line

   plus another paragraph
`).comments[0];

  assert.ok(comment);
  assert.equal(
    commentLabel(comment),
    "🔧 src/a.ts:7 — First physical line and a wrapped second line plus another paragraph",
  );
  assert.doesNotMatch(commentLabel(comment), /^1\./);

  const configuredEmoji = {
    SUGGESTION: "💡",
    NITPICK: "🔧",
    QUESTION: "❓",
    ISSUE: "⚠️",
    PRAISE: "🙌",
  };
  for (const [type, emoji] of Object.entries(configuredEmoji)) {
    assert.match(commentLabel({ ...comment, type }), new RegExp(`^${emoji}`));
  }
});
