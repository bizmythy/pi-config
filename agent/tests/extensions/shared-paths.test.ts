import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveExtensionPath } from "../../extensions/shared/paths.js";

test("extension paths normalize relative, absolute, and leading-at inputs", () => {
  const cwd = resolve("/tmp", "project");
  assert.equal(resolveExtensionPath("src/file.ts", cwd), join(cwd, "src/file.ts"));
  assert.equal(resolveExtensionPath("@src/file.ts", cwd), join(cwd, "src/file.ts"));
  assert.equal(resolveExtensionPath("/var/tmp/file.ts", cwd), resolve("/var/tmp/file.ts"));
  assert.equal(resolveExtensionPath("@/var/tmp/file.ts", cwd), resolve("/var/tmp/file.ts"));
});

test("extension paths expand home inputs", () => {
  assert.equal(resolveExtensionPath("~", "/tmp"), homedir());
  assert.equal(resolveExtensionPath("~/child", "/tmp"), join(homedir(), "child"));
});
