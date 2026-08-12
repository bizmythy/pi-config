import assert from "node:assert/strict";
import test from "node:test";
import { latestCustomEntryData } from "../../extensions/shared/session-entries.js";

test("latest custom entry data selects the last matching custom entry", () => {
  const entries = [
    { type: "custom", customType: "state", data: { value: 1 } },
    { type: "message", customType: "state", data: { value: 99 } },
    { type: "custom", customType: "other", data: { value: 2 } },
    { type: "custom", customType: "state", data: { value: 3 } },
  ];
  assert.deepEqual(latestCustomEntryData<{ value: number }>(entries, "state"), { value: 3 });
  assert.equal(latestCustomEntryData(entries, "missing"), undefined);
});

test("latest custom entry data returns falsy and undefined data safely", () => {
  assert.equal(latestCustomEntryData<number>([{ type: "custom", customType: "zero", data: 0 }], "zero"), 0);
  assert.equal(latestCustomEntryData([{ type: "custom", customType: "empty", data: undefined }], "empty"), undefined);
});
