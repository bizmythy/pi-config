/** Models matching any of these expressions are omitted from `/model`. */
export const MODEL_BLACKLIST = [
  /^gemini-/i,
  /^gemma-/i,
  /^deep-research-/i,
  /^grok-(?:[0-3](?:\.\d+)?|4(?:\.[0-4])?(?:$|-))/i,
  /^gpt-(?:[0-4](?:\.\d+)?|5(?:\.[0-5])?(?:$|-))/i,
  /^openrouter\/(?!z-ai\/glm-5\.3-flash$)/i,
] satisfies readonly RegExp[];
