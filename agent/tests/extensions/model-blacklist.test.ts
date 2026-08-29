import assert from "node:assert/strict";
import test from "node:test";
import { _test } from "../../extensions/model-blacklist/filter.js";

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

test("model blacklist exposes only GLM 5.3 Flash from OpenRouter", () => {
  const models = [
    { provider: "openrouter", id: "anthropic/claude-opus-4.1" },
    { provider: "openrouter", id: "z-ai/glm-5.3-flash" },
    { provider: "z-ai", id: "glm-5.3-flash" },
  ];

  assert.deepEqual(
    _test.filterModels(models).map((model) => `${model.provider}/${model.id}`),
    ["openrouter/z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"],
  );
});

test("blacklist patterns also match provider-qualified ids and display names", () => {
  const patterns = [/^vendor\/hidden$/i, /^Friendly hidden$/i];
  assert.equal(_test.isBlacklisted({ provider: "vendor", id: "hidden" }, patterns), true);
  assert.equal(_test.isBlacklisted({ provider: "vendor", id: "visible", name: "Friendly hidden" }, patterns), true);
  assert.equal(_test.isBlacklisted({ provider: "vendor", id: "visible", name: "Friendly visible" }, patterns), false);
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
