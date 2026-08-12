import assert from "node:assert/strict";
import test from "node:test";
import { createLazyToolActivation, updateActiveTools } from "../../extensions/shared/tool-activation.js";

function runtime(initial: string[]) {
  let active = initial;
  const writes: string[][] = [];
  return {
    api: {
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
        writes.push(names);
      },
    },
    active: () => active,
    writes,
  };
}

test("active-tool updates preserve unrelated tools, order, and uniqueness", () => {
  const state = runtime(["read", "other", "read", "remove-me"]);
  assert.equal(
    updateActiveTools(state.api, {
      add: ["new", "other", "new", "conflict"],
      remove: ["remove-me", "conflict"],
    }),
    true,
  );
  assert.deepEqual(state.active(), ["read", "other", "new"]);
  assert.equal(state.writes.length, 1);
});

test("active-tool updates skip effective no-ops", () => {
  const state = runtime(["read", "bash"]);
  assert.equal(updateActiveTools(state.api, { add: ["read", "read"], remove: ["missing"] }), false);
  assert.deepEqual(state.writes, []);
});

test("active-tool updates enable and disable requested tools", () => {
  const state = runtime(["read", "foreign"]);
  updateActiveTools(state.api, { add: ["checkpoint"] });
  assert.deepEqual(state.active(), ["read", "foreign", "checkpoint"]);
  updateActiveTools(state.api, { remove: ["checkpoint"] });
  assert.deepEqual(state.active(), ["read", "foreign"]);
});

test("lazy activation registers once and does nothing when initially disabled", () => {
  const state = runtime(["read", "foreign"]);
  let registrations = 0;
  const activation = createLazyToolActivation(state.api, "checkpoint", () => {
    registrations += 1;
  });

  activation.setEnabled(false);
  assert.equal(activation.isRegistered(), false);
  assert.deepEqual(state.writes, []);

  activation.setEnabled(true);
  activation.setEnabled(true);
  assert.equal(registrations, 1);
  assert.deepEqual(state.active(), ["read", "foreign", "checkpoint"]);

  activation.setEnabled(false);
  activation.setEnabled(false);
  assert.deepEqual(state.active(), ["read", "foreign"]);
  assert.equal(state.writes.length, 2);
});
