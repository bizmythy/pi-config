#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SecretSpec } from "secretspec";

const manifest = fileURLToPath(new URL("../../secretspec.toml", import.meta.url));
const resolved = await SecretSpec.builder()
  .withPath(manifest)
  .withProfile("linear")
  .withReason("Authenticate the Linear CLI during Pi configuration bootstrap")
  .loadAsync();

try {
  const credential = resolved.secrets.LINEAR_CREDENTIAL?.get()?.trim();
  if (!credential) throw new Error("SecretSpec returned an empty LINEAR_CREDENTIAL");

  const result = spawnSync("linear", ["auth", "login", "--plaintext"], {
    input: `${credential}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
} finally {
  resolved.dispose();
}
