import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { isPlanTargetPath } from "../../extensions/plan/paths.js";

const cwd = "/work/project";
const planDir = "/plans/turn";

test("plan target validation allows only normalized direct *-plan.md children", () => {
  assert.equal(isPlanTargetPath("@/plans/turn/feature-plan.md", cwd, planDir), true);
  assert.equal(isPlanTargetPath(join(planDir, "..", "other-plan.md"), cwd, planDir), false);
  assert.equal(isPlanTargetPath("/plans/turn/nested/feature-plan.md", cwd, planDir), false);
  assert.equal(isPlanTargetPath("/plans/turn/feature.md", cwd, planDir), false);
});
