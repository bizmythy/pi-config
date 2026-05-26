import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ShellToken = { type: "word" | "control"; value: string };

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const flushWord = () => {
    if (current.length > 0) {
      tokens.push({ type: "word", value: current });
      current = "";
    }
  };

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      flushWord();
      if (char === "\n") tokens.push({ type: "control", value: char });
      continue;
    }

    if (";&|()<>".includes(char)) {
      flushWord();
      tokens.push({ type: "control", value: char });
      continue;
    }

    current += char;
  }

  if (escaped) current += "\\";
  flushWord();

  return tokens;
}

function isRmCommand(word: string): boolean {
  return word === "rm" || word.endsWith("/rm");
}

function isRecursiveRmFlag(arg: string): boolean {
  return arg === "--recursive" || (/^-[^-]/.test(arg) && /[rR]/.test(arg));
}

function getRecursiveRmTargets(command: string): string[][] {
  const tokens = tokenizeShell(command);
  const rmTargets: string[][] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "word" || !isRmCommand(token.value)) continue;

    const args: string[] = [];
    for (let j = i + 1; j < tokens.length && tokens[j]?.type === "word"; j++) {
      args.push(tokens[j].value);
    }

    if (!args.some(isRecursiveRmFlag)) continue;

    let afterOptions = false;
    const targets: string[] = [];
    for (const arg of args) {
      if (!afterOptions && arg === "--") {
        afterOptions = true;
        continue;
      }

      if (!afterOptions && arg.startsWith("-")) continue;
      targets.push(arg);
    }

    rmTargets.push(targets);
  }

  return rmTargets;
}

function isLiteralPathBelowTmp(target: string, cwd: string): boolean {
  if (target.length === 0) return false;

  // Shell expansions can resolve to paths outside /tmp, so keep them guarded.
  if (/[`$]/.test(target) || target.startsWith("~")) return false;

  const absoluteTarget = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
  return absoluteTarget !== "/tmp" && absoluteTarget !== "/tmp/" && absoluteTarget.startsWith("/tmp/");
}

function hasUnsafeRecursiveRm(command: string, cwd: string): boolean {
  return getRecursiveRmTargets(command).some((targets) => {
    if (targets.length === 0) return true;
    return !targets.every((target) => isLiteralPathBelowTmp(target, cwd));
  });
}

/**
 * Comprehensive security hook:
 * - Blocks dangerous bash commands (rm -rf, sudo, chmod 777, etc.)
 * - Protects sensitive paths from writes (.env, node_modules, .git, keys)
 */
export default function (pi: ExtensionAPI) {
  const dangerousCommands = [
    { pattern: /\bsudo\b/, desc: "sudo command" },
    { pattern: /\b(chmod|chown)\b.*777/, desc: "dangerous permissions" },
    { pattern: /\bmkfs\b/, desc: "filesystem format" },
    { pattern: /\bdd\b.*\bof=\/dev\//, desc: "raw device write" },
    { pattern: />\s*\/dev\/sd[a-z]/, desc: "raw device overwrite" },
    { pattern: /\bkill\s+-9\s+-1\b/, desc: "kill all processes" },
    { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, desc: "fork bomb" },
    {
      pattern: /\bgit\s+clean\s+[^;&|]*-[^;&|]*[df]/,
      desc: "destructive git clean",
    },
    { pattern: /\bgit\s+reset\s+--hard\b/, desc: "destructive git reset" },
    { pattern: /\bgit\s+push\b[^;&|]*\s(?:--force|-f)\b/, desc: "force push" },
  ];

  const protectedPaths = [
    { pattern: /(^|\/)\.env($|\.(?!example$))/, desc: "environment file" },
    { pattern: /(^|\/)\.dev\.vars($|\.[^/]+$)/, desc: "dev vars file" },
    { pattern: /(^|\/)node_modules\//, desc: "node_modules" },
    { pattern: /^\.git\/|\/\.git\//, desc: "git directory" },
    { pattern: /\.pem$|\.key$/, desc: "private key file" },
    {
      pattern: /(^|\/)id_rsa$|(^|\/)id_ed25519$|(^|\/)id_ecdsa$/,
      desc: "SSH key",
    },
    { pattern: /(^|\/)\.ssh\//, desc: ".ssh directory" },
    { pattern: /(^|\/)secrets?\.(json|ya?ml|toml)$/i, desc: "secrets file" },
    { pattern: /(^|\/)credentials/i, desc: "credentials file" },
  ];

  const softProtectedPaths = [
    { pattern: /package-lock\.json$/, desc: "package-lock.json" },
    { pattern: /yarn\.lock$/, desc: "yarn.lock" },
    { pattern: /pnpm-lock\.yaml$/, desc: "pnpm-lock.yaml" },
  ];

  const protectedShellPath = String.raw`(?:\.\/)?(?:[^\s;&|<>]*\/)?(?:\.env(?:\.(?!example\b)[^\s;&|<>]+)?|\.dev\.vars(?:\.[^\s;&|<>]+)?|[^\s;&|<>]+\.(?:pem|key))`;
  const dangerousBashWrites = [
    new RegExp(String.raw`(?:>|>>|1>|2>|&>|tee\s+(?:-[a-zA-Z]+\s+)*)\s*${protectedShellPath}`),
    new RegExp(String.raw`\b(?:cp|mv)\b[^;&|]*\s${protectedShellPath}(?:\s|$)`),
    new RegExp(String.raw`\bcat\b[^;&|]*(?:>|>>)\s*${protectedShellPath}`),
  ];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const command = event.input.command as string;

      if (hasUnsafeRecursiveRm(command, ctx.cwd)) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: "Blocked recursive delete (no UI to confirm)",
          };
        }

        const ok = await ctx.ui.confirm("Dangerous command: recursive delete", command);

        if (!ok) {
          return { block: true, reason: "Blocked recursive delete by user" };
        }
      }

      for (const { pattern, desc } of dangerousCommands) {
        if (pattern.test(command)) {
          if (!ctx.hasUI) {
            return {
              block: true,
              reason: `Blocked ${desc} (no UI to confirm)`,
            };
          }

          const ok = await ctx.ui.confirm(`Dangerous command: ${desc}`, command);

          if (!ok) {
            return { block: true, reason: `Blocked ${desc} by user` };
          }
          break;
        }
      }

      for (const pattern of dangerousBashWrites) {
        if (pattern.test(command)) {
          if (ctx.hasUI) ctx.ui.notify("Blocked bash write to protected path", "warning");
          return {
            block: true,
            reason: "Bash command writes to protected path",
          };
        }
      }

      return undefined;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const filePath = event.input.path as string;
      const normalizedPath = path.normalize(filePath);

      for (const { pattern, desc } of protectedPaths) {
        if (pattern.test(normalizedPath)) {
          if (ctx.hasUI) ctx.ui.notify(`Blocked write to ${desc}: ${filePath}`, "warning");
          return { block: true, reason: `Protected path: ${desc}` };
        }
      }

      for (const { pattern, desc } of softProtectedPaths) {
        if (pattern.test(normalizedPath)) {
          if (!ctx.hasUI) {
            return { block: true, reason: `Protected path (no UI): ${desc}` };
          }

          const ok = await ctx.ui.confirm(`Modifying ${desc}`, `Are you sure you want to modify ${filePath}?`);

          if (!ok) {
            return { block: true, reason: `User blocked write to ${desc}` };
          }
          break;
        }
      }

      return undefined;
    }

    return undefined;
  });
}
