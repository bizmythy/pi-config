import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECRET_REFS = {
  GEMINI_API_KEY: "op://Employee/pi-agent-gemini-key/credential",
  EXA_API_KEY: "op://Employee/exa-api-key/credential",
} as const;

const RELEVANT_TOOLS = new Set(["fetch_content", "web_search", "code_search"]);

type EnvName = keyof typeof SECRET_REFS;
type Credentials = Record<EnvName, string>;
type EnvSnapshot = Partial<Record<EnvName, string | undefined>>;

let cachedCredentials: Credentials | null = null;
let credentialsPromise: Promise<Credentials> | null = null;
let envSnapshot: EnvSnapshot | null = null;
const activeToolCalls = new Set<string>();

function readOnePasswordSecrets(): Promise<Credentials> {
  return new Promise((resolve, reject) => {
    const template = Object.entries(SECRET_REFS)
      .map(([envName, secretRef]) => `${envName}={{ ${secretRef} }}`)
      .join("\n");

    execFile(
      "sh",
      ["-c", 'printf %s "$1" | op inject', "op-inject", template],
      { timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || String(err)).trim();
          reject(new Error(detail || "failed to read 1Password secrets"));
          return;
        }

        const credentials = Object.fromEntries(
          stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const separator = line.indexOf("=");
              if (separator === -1) return [line, ""];
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        ) as Partial<Credentials>;

        for (const envName of Object.keys(SECRET_REFS) as EnvName[]) {
          const value = credentials[envName]?.trim();
          if (!value) {
            reject(new Error(`1Password returned an empty ${envName}`));
            return;
          }
          credentials[envName] = value;
        }

        resolve(credentials as Credentials);
      },
    );
  });
}

async function getWebAccessCredentials(): Promise<Credentials> {
  if (cachedCredentials) return cachedCredentials;
  if (!credentialsPromise) {
    credentialsPromise = readOnePasswordSecrets()
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

async function exposeCredentialsForToolCall(toolCallId: string): Promise<void> {
  const credentials = await getWebAccessCredentials();
  if (activeToolCalls.size === 0) {
    envSnapshot = {};
    for (const envName of Object.keys(SECRET_REFS) as EnvName[]) {
      envSnapshot[envName] = process.env[envName];
    }
  }
  activeToolCalls.add(toolCallId);
  for (const [envName, value] of Object.entries(credentials) as Array<[EnvName, string]>) {
    process.env[envName] = value;
  }
}

function restoreEnvForToolCall(toolCallId: string): void {
  if (!activeToolCalls.delete(toolCallId)) return;
  if (activeToolCalls.size > 0) return;

  for (const envName of Object.keys(SECRET_REFS) as EnvName[]) {
    const previous = envSnapshot?.[envName];
    if (previous === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previous;
    }
  }
  envSnapshot = null;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!RELEVANT_TOOLS.has(event.toolName)) return;

    try {
      await exposeCredentialsForToolCall(event.toolCallId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Could not read web access API keys from 1Password: ${message}`, "error");
    }
  });

  pi.on("tool_execution_end", async (event) => {
    restoreEnvForToolCall(event.toolCallId);
  });

  pi.on("session_shutdown", async () => {
    for (const id of [...activeToolCalls]) restoreEnvForToolCall(id);
  });

  pi.registerCommand("web-access-op", {
    description: "Check/preload the Gemini and Exa API keys from 1Password without writing them to disk",
    handler: async (_args, ctx) => {
      try {
        await getWebAccessCredentials();
        ctx.ui.notify("Gemini and Exa API keys loaded from 1Password into memory for this Pi process.", "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Web access API keys unavailable: ${message}`, "error");
      }
    },
  });
}
