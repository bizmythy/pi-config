import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SecretSpec } from "secretspec";

const SECRETSPEC_PATH = fileURLToPath(new URL("../../secretspec.toml", import.meta.url));
const ENV_NAMES = ["GEMINI_API_KEY", "EXA_API_KEY"] as const;
const RELEVANT_TOOLS = new Set(["fetch_content", "web_search", "code_search"]);

type EnvName = (typeof ENV_NAMES)[number];
type Credentials = Record<EnvName, string>;
type EnvSnapshot = Partial<Record<EnvName, string | undefined>>;

let cachedCredentials: Credentials | null = null;
let credentialsPromise: Promise<Credentials> | null = null;
let envSnapshot: EnvSnapshot | null = null;
let credentialsExposed = false;

async function readWebAccessSecrets(): Promise<Credentials> {
  const resolved = await SecretSpec.builder()
    .withPath(SECRETSPEC_PATH)
    .withProfile("web_access")
    .withReason("Expose API keys to Pi web access tools")
    .loadAsync();

  try {
    const credentials = {} as Credentials;
    for (const envName of ENV_NAMES) {
      const value = resolved.secrets[envName]?.get()?.trim();
      if (!value) throw new Error(`SecretSpec returned an empty ${envName}`);
      credentials[envName] = value;
    }
    return credentials;
  } finally {
    resolved.dispose();
  }
}

async function getWebAccessCredentials(): Promise<Credentials> {
  if (cachedCredentials) return cachedCredentials;
  if (!credentialsPromise) {
    credentialsPromise = readWebAccessSecrets()
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
    for (const envName of ENV_NAMES) envSnapshot[envName] = process.env[envName];
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
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
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
      ctx.ui.notify(`Could not resolve web access API keys through SecretSpec: ${message}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    restoreEnvironment();
  });

  pi.registerCommand("web-access-secrets", {
    description: "Expose web access API keys through SecretSpec for this Pi session",
    handler: async (_args, ctx) => {
      try {
        await exposeCredentials();
        ctx.ui.notify("Web access API keys are available for this Pi session.", "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Web access API keys unavailable: ${message}`, "error");
      }
    },
  });
}
