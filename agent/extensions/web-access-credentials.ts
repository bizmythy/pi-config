import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECRETS_FILE = join(homedir(), ".pi", "secrets", "work.json");
const ENV_NAMES = ["GEMINI_API_KEY", "EXA_API_KEY"] as const;

type EnvName = (typeof ENV_NAMES)[number];
type Credentials = Record<EnvName, string>;
type EnvSnapshot = Partial<Record<EnvName, string | undefined>>;
type WorkSecrets = {
  webAccess: {
    geminiApiKey: string;
    exaApiKey: string;
  };
};

function readCredentials(): Credentials {
  const secrets = JSON.parse(readFileSync(SECRETS_FILE, "utf8")) as WorkSecrets;
  const credentials = {
    GEMINI_API_KEY: secrets.webAccess.geminiApiKey?.trim(),
    EXA_API_KEY: secrets.webAccess.exaApiKey?.trim(),
  };

  for (const envName of ENV_NAMES) {
    if (!credentials[envName]) {
      throw new Error(`${SECRETS_FILE} contains an empty ${envName}`);
    }
  }

  return credentials;
}

export default function (pi: ExtensionAPI) {
  const credentials = readCredentials();
  const envSnapshot: EnvSnapshot = {};

  for (const envName of ENV_NAMES) {
    envSnapshot[envName] = process.env[envName];
    process.env[envName] = credentials[envName];
  }

  pi.on("session_shutdown", async () => {
    for (const envName of ENV_NAMES) {
      const previous = envSnapshot[envName];
      if (previous === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previous;
      }
    }
  });
}
