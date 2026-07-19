import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECRETS_FILE = join(homedir(), ".pi", "secrets", "work.json");
const ENV_NAMES = ["GEMINI_API_KEY", "EXA_API_KEY"] as const;
const RELEVANT_TOOLS = new Set(["fetch_content", "web_search", "code_search"]);

type EnvName = (typeof ENV_NAMES)[number];
type Credentials = Record<EnvName, string>;
type EnvSnapshot = Partial<Record<EnvName, string | undefined>>;
type WorkSecrets = {
  webAccess: {
    geminiApiKey: string;
    exaApiKey: string;
  };
};

let cachedCredentials: Credentials | null = null;
let credentialsPromise: Promise<Credentials> | null = null;
let envSnapshot: EnvSnapshot | null = null;
let credentialsExposed = false;

async function readCredentials(): Promise<Credentials> {
  const secrets = JSON.parse(await readFile(SECRETS_FILE, "utf8")) as WorkSecrets;
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

async function getWebAccessCredentials(): Promise<Credentials> {
  if (cachedCredentials) return cachedCredentials;
  if (!credentialsPromise) {
    credentialsPromise = readCredentials()
      .then((credentials) => {
        cachedCredentials = credentials;
        return credentials;
      })
      .catch((err) => {
        credentialsPromise = null;
        throw err;
      });
  }
  return credentialsPromise;
}

function applyCredentialsToEnvironment(credentials: Credentials): void {
  if (!envSnapshot) {
    envSnapshot = {};
    for (const envName of ENV_NAMES) {
      envSnapshot[envName] = process.env[envName];
    }
  }

  for (const [envName, value] of Object.entries(credentials) as Array<[EnvName, string]>) {
    process.env[envName] = value;
  }
  credentialsExposed = true;
}

async function exposeCredentials(): Promise<void> {
  applyCredentialsToEnvironment(await getWebAccessCredentials());
}

function restoreEnvironment(): void {
  if (!credentialsExposed) return;

  for (const envName of ENV_NAMES) {
    const previous = envSnapshot?.[envName];
    if (previous === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previous;
    }
  }
  envSnapshot = null;
  credentialsExposed = false;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!RELEVANT_TOOLS.has(event.toolName)) return;

    try {
      await exposeCredentials();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Could not read web access API keys: ${message}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    restoreEnvironment();
  });

  pi.registerCommand("web-access-secrets", {
    description: "Expose the Gemini and Exa API keys to web access tools for this Pi session",
    handler: async (_args, ctx) => {
      try {
        await exposeCredentials();
        ctx.ui.notify("Gemini and Exa API keys are available to web access tools for this Pi session.", "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Web access API keys unavailable: ${message}`, "error");
      }
    },
  });
}
