import assert from "node:assert/strict";
import test from "node:test";
import { restorePlanExtensionState } from "../../extensions/plan/state.js";

const activePlan = {
  dir: "/plans/turn",
  description: "Plan a feature",
  createdAt: "20260820-135132-384",
};

test("active plan creation survives a session resume", () => {
  assert.deepEqual(
    restorePlanExtensionState({
      activePlan,
      planningInProgress: true,
    }),
    {
      activePlan,
      planningInProgress: true,
    },
  );
});

test("completed and cancelled plans remain inactive after resume", () => {
  const completedPlan = { ...activePlan, path: "/plans/turn/feature-plan.md" };

  assert.equal(
    restorePlanExtensionState({ activePlan: completedPlan, planningInProgress: false }).planningInProgress,
    false,
  );
  assert.equal(restorePlanExtensionState({ activePlan, planningInProgress: false }).planningInProgress, false);
});

test("legacy plan state is not revived without an explicit lifecycle flag", () => {
  assert.deepEqual(restorePlanExtensionState({ activePlan }), {
    activePlan,
    planningInProgress: false,
  });
  assert.deepEqual(restorePlanExtensionState(undefined), {
    activePlan: {},
    planningInProgress: false,
  });
});
