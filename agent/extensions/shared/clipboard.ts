export interface ClipboardExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Command runner shape; `pi.exec` satisfies it directly. */
export type ClipboardExec = (command: string, args: string[]) => Promise<ClipboardExecResult>;

export interface ClipboardReadCommand {
  command: string;
  args: string[];
  /** Human-readable label for the clipboard that was read, e.g. "macOS clipboard". */
  source: string;
}

export interface ClipboardReadOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface ClipboardText {
  text: string;
  source: string;
}

const WAYLAND: ClipboardReadCommand = {
  command: "wl-paste",
  args: ["--no-newline", "--type", "text"],
  source: "Wayland clipboard",
};
const XCLIP: ClipboardReadCommand = {
  command: "xclip",
  args: ["-selection", "clipboard", "-o"],
  source: "X11 clipboard",
};
const XSEL: ClipboardReadCommand = { command: "xsel", args: ["--clipboard", "--output"], source: "X11 clipboard" };

/** Candidate commands for reading clipboard text on the given platform, in preference order. */
export function clipboardReadCommands(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardReadCommand[] {
  switch (platform) {
    case "darwin":
      return [{ command: "pbpaste", args: [], source: "macOS clipboard" }];
    case "win32":
      return [
        {
          command: "powershell.exe",
          args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"],
          source: "Windows clipboard",
        },
      ];
    default: {
      if (env.TERMUX_VERSION) {
        return [{ command: "termux-clipboard-get", args: [], source: "Termux clipboard" }];
      }
      const wayland = Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
      return wayland ? [WAYLAND, XCLIP, XSEL] : [XCLIP, XSEL, WAYLAND];
    }
  }
}

/**
 * Read plain text from the system clipboard using platform CLI tools.
 * Throws when no tool succeeds; the message lists what was attempted.
 */
export async function readClipboardText(
  exec: ClipboardExec,
  options: ClipboardReadOptions = {},
): Promise<ClipboardText> {
  const candidates = clipboardReadCommands(options.platform, options.env);
  const failures: string[] = [];

  for (const candidate of candidates) {
    let result: ClipboardExecResult;
    try {
      result = await exec(candidate.command, candidate.args);
    } catch (error) {
      failures.push(`${candidate.command}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (result.code === 0) return { text: result.stdout, source: candidate.source };
    failures.push(`${candidate.command}: ${result.stderr.trim() || `exited with status ${result.code}`}`);
  }

  throw new Error(`Unable to read clipboard text. ${failures.join("; ")}`);
}
