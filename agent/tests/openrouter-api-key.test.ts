import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseOpenRouterApiKey, readOpenRouterApiKey } from "../scripts/openrouter-api-key.js";

const SECRETS_FILE = "/home/test/.pi/secrets/personal.json";

test("OpenRouter credential reader returns only the configured key", () => {
  const contents = JSON.stringify({
    openai: { apiKey: "unrelated-secret" },
    openrouter: { apiKey: "  test-openrouter-key  " },
  });

  assert.equal(parseOpenRouterApiKey(contents, SECRETS_FILE), "test-openrouter-key");
});

test("OpenRouter credential errors are actionable without exposing secret values", () => {
  const malformed = '{"openrouter":{"apiKey":"must-not-leak"}';
  assert.throws(
    () => parseOpenRouterApiKey(malformed, SECRETS_FILE),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Unable to parse OpenRouter credentials/);
      assert.doesNotMatch(error.message, /must-not-leak/);
      return true;
    },
  );

  const unrelatedSecret = "another-secret-that-must-not-leak";
  assert.throws(
    () => parseOpenRouterApiKey(JSON.stringify({ openai: { apiKey: unrelatedSecret } }), SECRETS_FILE),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Missing OpenRouter API key at openrouter\.apiKey/);
      assert.match(error.message, /scripts\/install\.nu/);
      assert.doesNotMatch(error.message, new RegExp(unrelatedSecret));
      return true;
    },
  );
});

test("OpenRouter credential reader reports a missing generated secrets file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-openrouter-key-"));
  const missingFile = join(root, "missing-personal.json");

  try {
    await assert.rejects(readOpenRouterApiKey(missingFile), /Run \.\/scripts\/install\.nu/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenRouter credential reader reads the generated secret shape from disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-openrouter-key-"));
  const secretsFile = join(root, "personal.json");
  await writeFile(secretsFile, JSON.stringify({ openrouter: { apiKey: "disk-key" } }));

  try {
    assert.equal(await readOpenRouterApiKey(secretsFile), "disk-key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
