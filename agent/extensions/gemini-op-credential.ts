import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECRET_REF = "op://Employee/pi-agent-gemini-key/credential";
const ENV_NAME = "GEMINI_API_KEY";
const RELEVANT_TOOLS = new Set(["fetch_content", "web_search", "code_search"]);

type EnvSnapshot = { hadValue: true; value: string } | { hadValue: false };

let cachedKey: string | null = null;
let keyPromise: Promise<string> | null = null;
let envSnapshot: EnvSnapshot | null = null;
const activeToolCalls = new Set<string>();

function readOnePasswordSecret(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("op", ["read", SECRET_REF, "--no-newline"], { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || String(err)).trim();
        reject(new Error(detail || "failed to read 1Password secret"));
        return;
      }

      const key = stdout.trim();
      if (!key) {
        reject(new Error("1Password returned an empty Gemini API key"));
        return;
      }

      resolve(key);
    });
  });
}

async function getGeminiKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  if (!keyPromise) {
    keyPromise = readOnePasswordSecret()
      .then((key) => {
        cachedKey = key;
        return key;
      })
      .catch((err) => {
        keyPromise = null;
        throw err;
      });
  }
  return keyPromise;
}

async function exposeKeyForToolCall(toolCallId: string): Promise<void> {
  const key = await getGeminiKey();
  if (activeToolCalls.size === 0) {
    envSnapshot =
      process.env[ENV_NAME] === undefined ? { hadValue: false } : { hadValue: true, value: process.env[ENV_NAME] };
  }
  activeToolCalls.add(toolCallId);
  process.env[ENV_NAME] = key;
}

function restoreEnvForToolCall(toolCallId: string): void {
  if (!activeToolCalls.delete(toolCallId)) return;
  if (activeToolCalls.size > 0) return;

  if (envSnapshot?.hadValue) {
    process.env[ENV_NAME] = envSnapshot.value;
  } else {
    delete process.env[ENV_NAME];
  }
  envSnapshot = null;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!RELEVANT_TOOLS.has(event.toolName)) return;

    try {
      await exposeKeyForToolCall(event.toolCallId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Could not read Gemini API key from 1Password: ${message}`, "error");
    }
  });

  pi.on("tool_execution_end", async (event) => {
    restoreEnvForToolCall(event.toolCallId);
  });

  pi.on("session_shutdown", async () => {
    for (const id of [...activeToolCalls]) restoreEnvForToolCall(id);
  });

  pi.registerCommand("gemini-op", {
    description: "Check/preload the Gemini API key from 1Password without writing it to disk",
    handler: async (_args, ctx) => {
      try {
        await getGeminiKey();
        ctx.ui.notify("Gemini API key loaded from 1Password into memory for this Pi process.", "info");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Gemini API key unavailable: ${message}`, "error");
      }
    },
  });
}
