import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TAUTOLOGICAL_TEST_WARNING =
  "When writing tests, avoid tautological tests that merely duplicate the implementation logic; assert externally observable behavior and meaningful edge cases instead.";

function isGptModel(ctx: ExtensionContext): boolean {
  const model = ctx.model as { id?: unknown; name?: unknown; provider?: unknown } | undefined;
  const values = [model?.id, model?.name].filter((value): value is string => typeof value === "string");

  return values.some((value) => /(^|[^a-z0-9])gpt([-.]|$)/i.test(value));
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!isGptModel(ctx) || event.systemPrompt.includes(TAUTOLOGICAL_TEST_WARNING)) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${TAUTOLOGICAL_TEST_WARNING}`,
    };
  });
}
