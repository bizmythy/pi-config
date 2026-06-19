import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GREP_IN_BASH_GUIDANCE = `AGENT DIRECTIVE: Avoid \`grep\` in bash commands. Use \`rg\` (ripgrep) instead unless the user explicitly requires GNU grep behavior.`;

const GUIDANCE_MESSAGE_TYPE = "grep-in-bash-guidance";

const grepCommandPattern =
  /(?:^|\n|[;|&]{1,2}|\()\s*(?:!+\s*)?(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+|sudo|command|time|nice|nohup)\s+)*(?:\S+\/)?grep\b/m;

function maskQuotedTextAndComments(command: string): string {
  let masked = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? "";

    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
        masked += char === "\n" ? "\n" : " ";
        continue;
      }

      if (quote === '"' && char === "\\") {
        escaped = true;
        masked += " ";
        continue;
      }

      if (char === quote) {
        quote = undefined;
      }

      masked += char === "\n" ? "\n" : " ";
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      masked += " ";
      continue;
    }

    if (char === "#" && (i === 0 || /\s/.test(command[i - 1] ?? ""))) {
      while (i < command.length && command[i] !== "\n") {
        masked += " ";
        i++;
      }
      if (i < command.length) masked += "\n";
      continue;
    }

    masked += char;
  }

  return masked;
}

function usesGrepCommand(command: string): boolean {
  return grepCommandPattern.test(maskQuotedTextAndComments(command));
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return undefined;

    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || !usesGrepCommand(command)) return undefined;

    pi.sendMessage(
      {
        customType: GUIDANCE_MESSAGE_TYPE,
        content: GREP_IN_BASH_GUIDANCE,
        display: false,
        details: { command, toolCallId: event.toolCallId },
      },
      { deliverAs: "steer" },
    );

    return undefined;
  });
}
