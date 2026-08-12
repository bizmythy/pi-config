import assert from "node:assert/strict";
import test from "node:test";
import { resolveReviewPath } from "../../extensions/tuicr-review/path.js";

test("tuicr review path parsing removes one matching quote pair before normalization", () => {
  assert.equal(resolveReviewPath("  '@reviews/local review.md'  ", "/repo"), "/repo/reviews/local review.md");
  assert.equal(resolveReviewPath('"/tmp/review.md"', "/repo"), "/tmp/review.md");
});
