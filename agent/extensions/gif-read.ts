import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { type ExtensionAPI, isReadToolResult } from "@earendil-works/pi-coding-agent";

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };

const SAMPLE_COUNT = 5;
const FRAME_WIDTH_PX = 360;
const COMMAND_TIMEOUT_MS = 20_000;
const SCALE_FILTER = `scale=w='min(${FRAME_WIDTH_PX},iw)':h=-1`;

type CommandResult = {
  stdout: string;
  stderr: string;
};

function runCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolveCommand(result ?? { stdout: "", stderr: "" });
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("Operation aborted"));
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };

      if (code === 0) {
        finish(undefined, result);
      } else {
        const message = result.stderr.trim() || `${command} exited with status ${code}`;
        finish(new Error(message));
      }
    });
  });
}

function resolveToolPath(rawPath: string, cwd: string): string {
  const path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;

  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function looksLikeGif(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(6);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < header.length) return false;
    const signature = header.toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  } finally {
    await file.close();
  }
}

async function getDurationSeconds(path: string, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const { stdout } = await runCommand(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
      signal,
      8_000,
    );
    const duration = Number.parseFloat(stdout.trim());
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch {
    // Fall through to ImageMagick's per-frame delay metadata.
  }

  try {
    const { stdout } = await runCommand("magick", ["identify", "-format", "%T\\n", path], signal, 8_000);
    const totalTicks = stdout
      .split(/\r?\n/)
      .map((line) => Number.parseFloat(line.trim()))
      .filter((delay) => Number.isFinite(delay) && delay > 0)
      .reduce((sum, delay) => sum + delay, 0);

    // GIF frame delays are reported in 1/100-second ticks.
    return totalTicks > 0 ? totalTicks / 100 : undefined;
  } catch {
    return undefined;
  }
}

function sampleTimestamps(durationSeconds: number | undefined, sampleCount: number): number[] {
  if (!durationSeconds || durationSeconds <= 0) {
    return [0];
  }

  const endPadding = Math.min(0.05, durationSeconds / 10);
  const lastTimestamp = Math.max(0, durationSeconds - endPadding);
  if (sampleCount <= 1 || lastTimestamp === 0) {
    return [0];
  }

  return Array.from({ length: sampleCount }, (_unused, index) => (lastTimestamp * index) / (sampleCount - 1));
}

async function extractFrame(inputPath: string, outputPath: string, timestampSeconds: number, signal?: AbortSignal) {
  const args = ["-v", "error", "-y", "-i", inputPath];
  if (timestampSeconds > 0) {
    args.push("-ss", timestampSeconds.toFixed(3));
  }
  args.push("-frames:v", "1", "-vf", SCALE_FILTER, outputPath);

  await runCommand("ffmpeg", args, signal);
  const output = await stat(outputPath);
  if (output.size === 0) {
    throw new Error(`ffmpeg created an empty frame at ${timestampSeconds.toFixed(3)}s`);
  }
}

async function generateContactSheet(inputPath: string, signal?: AbortSignal) {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-gif-read-"));

  try {
    const durationSeconds = await getDurationSeconds(inputPath, signal);
    const timestamps = sampleTimestamps(durationSeconds, SAMPLE_COUNT);
    const framePaths: string[] = [];
    const sampledTimestamps: number[] = [];

    for (let index = 0; index < timestamps.length; index++) {
      const framePath = join(tempDir, `frame-${index}.png`);
      try {
        await extractFrame(inputPath, framePath, timestamps[index] ?? 0, signal);
        framePaths.push(framePath);
        sampledTimestamps.push(timestamps[index] ?? 0);
      } catch {
        // Some decoders fail near EOF for short GIFs. Keep any frames that were successfully extracted.
      }
    }

    if (framePaths.length === 0) {
      const framePath = join(tempDir, "frame-fallback.png");
      await extractFrame(inputPath, framePath, 0, signal);
      framePaths.push(framePath);
      sampledTimestamps.push(0);
    }

    const sheetPath = join(tempDir, "contact-sheet.png");
    await runCommand("magick", [...framePaths, "-bordercolor", "white", "-border", "8", "+append", sheetPath], signal);

    const sheet = await readFile(sheetPath);
    return {
      data: sheet.toString("base64"),
      durationSeconds,
      sampledTimestamps,
      sampleCount: framePaths.length,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function formatTimestampList(timestamps: number[]): string {
  return timestamps.map((timestamp) => `${timestamp.toFixed(2)}s`).join(", ");
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (!isReadToolResult(event) || event.isError) return;

    const rawPath = event.input.path;
    if (typeof rawPath !== "string" || extname(rawPath).toLowerCase() !== ".gif") return;

    const absolutePath = resolveToolPath(rawPath, ctx.cwd);
    if (!(await looksLikeGif(absolutePath))) return;

    try {
      const contactSheet = await generateContactSheet(absolutePath, ctx.signal);
      const durationNote =
        contactSheet.durationSeconds === undefined
          ? "duration unknown"
          : `${contactSheet.durationSeconds.toFixed(2)}s duration`;
      const imageNote =
        ctx.model && !ctx.model.input.includes("image")
          ? "\n[Current model does not support images. The contact sheet image will be omitted from this request.]"
          : "";
      const text =
        `Read animated GIF file [image/gif]\n` +
        `Generated contact sheet [image/png] with ${contactSheet.sampleCount} sampled frame(s) (${durationNote}).\n` +
        `Sample timestamps: ${formatTimestampList(contactSheet.sampledTimestamps)}${imageNote}`;

      return {
        content: [
          { type: "text", text } satisfies TextContent,
          { type: "image", data: contactSheet.data, mimeType: "image/png" } satisfies ImageContent,
        ],
        details: {
          ...(event.details ?? {}),
          gifRead: {
            contactSheet: true,
            sampleCount: contactSheet.sampleCount,
            durationSeconds: contactSheet.durationSeconds,
            sampledTimestamps: contactSheet.sampledTimestamps,
          },
        },
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const originalText = event.content.filter((part) => part.type === "text") as TextContent[];

      return {
        content: [
          ...originalText,
          {
            type: "text",
            text: `[gif-read] Could not generate a GIF contact sheet with ffmpeg/magick: ${message}`,
          } satisfies TextContent,
        ],
        details: { ...(event.details ?? {}), gifRead: { contactSheet: false, error: message } },
      };
    }
  });
}
