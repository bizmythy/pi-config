import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BEDROCK_PROVIDER = "amazon-bedrock";

// Environment variables that make pi consider Amazon Bedrock authenticated/available.
const AWS_AUTH_ENV_VARS = [
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
] as const;

function disableBedrockAuth() {
  for (const name of AWS_AUTH_ENV_VARS) {
    delete process.env[name];
  }
}

function removeBedrockModels(ctx: ExtensionContext) {
  const registry = ctx.modelRegistry as unknown as {
    models?: Array<{ provider?: string }>;
  };
  if (Array.isArray(registry.models)) {
    registry.models = registry.models.filter((model) => model.provider !== BEDROCK_PROVIDER);
  }
}

export default function (pi: ExtensionAPI) {
  // Run during extension load, before pi picks the initial available model.
  disableBedrockAuth();

  // Also remove Bedrock entries from the in-memory registry before users open /model,
  // and repeat on reload/new session in case the registry was refreshed.
  pi.on("session_start", async (_event, ctx) => {
    disableBedrockAuth();
    removeBedrockModels(ctx);
  });
}
