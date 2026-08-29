import assert from "node:assert/strict";
import test from "node:test";
import { _test } from "../../extensions/model-blacklist/filter.js";
import { MODEL_BLACKLIST } from "../../extensions/model-blacklist/patterns.js";

test("model blacklist removes requested families and version ranges", () => {
  const models = [
    { provider: "google", id: "gemini-3-flash" },
    { provider: "google", id: "gemma-4-31b-it" },
    { provider: "google", id: "deep-research-preview" },
    { provider: "grok-cli", id: "grok-4.3" },
    { provider: "grok-cli", id: "grok-4.5" },
    { provider: "grok-cli", id: "grok-composer-2.5-fast" },
    { provider: "openai-codex", id: "gpt-5.5" },
    { provider: "openai-codex", id: "gpt-5.6-luna" },
  ];

  assert.deepEqual(
    _test.filterModels(models).map((model) => model.id),
    ["grok-4.5", "grok-composer-2.5-fast", "gpt-5.6-luna"],
  );
});

test("blacklist patterns also match provider-qualified ids and display names", () => {
  const patterns = [/^vendor\/hidden$/i, /^Friendly hidden$/i];
  assert.equal(_test.isBlacklisted({ provider: "vendor", id: "hidden" }, patterns), true);
  assert.equal(_test.isBlacklisted({ provider: "vendor", id: "visible", name: "Friendly hidden" }, patterns), true);
  assert.equal(_test.isBlacklisted({ provider: "vendor", id: "visible", name: "Friendly visible" }, patterns), false);
  assert.equal(MODEL_BLACKLIST.length, 5);
});

test("runtime patch filters the built-in model snapshot and is idempotent", () => {
  const proto = {
    getAvailableSnapshot: () => [
      { provider: "google", id: "gemini-3-flash" },
      { provider: "openai-codex", id: "gpt-5.6-luna" },
    ],
  };

  _test.installModelBlacklist(proto);
  const patchedMethod = proto.getAvailableSnapshot;
  assert.deepEqual(
    proto.getAvailableSnapshot().map((model) => model.id),
    ["gpt-5.6-luna"],
  );

  _test.installModelBlacklist(proto, [/^gpt-/]);
  assert.equal(proto.getAvailableSnapshot, patchedMethod);
  assert.deepEqual(
    proto.getAvailableSnapshot().map((model) => model.id),
    ["gemini-3-flash"],
  );
});
