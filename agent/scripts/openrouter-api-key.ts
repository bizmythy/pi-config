import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SECRETS_FILE = join(homedir(), ".pi", "secrets", "personal.json");

type PersonalSecrets = {
  openrouter?: {
    apiKey?: unknown;
  };
};

export function parseOpenRouterApiKey(contents: string, secretsFile: string): string {
  let secrets: PersonalSecrets;
  try {
    secrets = JSON.parse(contents) as PersonalSecrets;
  } catch {
    throw new Error(`Unable to parse OpenRouter credentials in ${secretsFile}.`);
  }

  const apiKey = secrets.openrouter?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error(
      `Missing OpenRouter API key at openrouter.apiKey in ${secretsFile}. Run ./scripts/install.nu to regenerate personal secrets.`,
    );
  }
  return apiKey.trim();
}

export async function readOpenRouterApiKey(secretsFile = DEFAULT_SECRETS_FILE): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(secretsFile, "utf8");
  } catch {
    throw new Error(
      `Unable to read OpenRouter credentials from ${secretsFile}. Run ./scripts/install.nu to regenerate personal secrets.`,
    );
  }
  return parseOpenRouterApiKey(contents, secretsFile);
}

if (import.meta.main) {
  try {
    process.stdout.write(await readOpenRouterApiKey());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Unable to load OpenRouter credentials."}\n`);
    process.exitCode = 1;
  }
}
