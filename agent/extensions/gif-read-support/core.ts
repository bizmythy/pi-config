import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

const SAMPLE_COUNT = 5;
const FRAME_WIDTH_PX = 360;
const COMMAND_TIMEOUT_MS = 20_000;
const SCALE_FILTER = `scale=w='min(${FRAME_WIDTH_PX},iw)':h=-1`;

export type CommandExecutor = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export async function runCheckedCommand(
  exec: CommandExecutor,
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeout = COMMAND_TIMEOUT_MS,
): Promise<ExecResult> {
  const result = await exec(command, args, { signal, timeout });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `${command} exited with status ${result.code}`);
  return result;
}

async function getDurationSeconds(
  exec: CommandExecutor,
  path: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  try {
    const { stdout } = await runCheckedCommand(
      exec,
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
    const { stdout } = await runCheckedCommand(exec, "magick", ["identify", "-format", "%T\\n", path], signal, 8_000);
    const totalTicks = stdout
      .split(/\r?\n/)
      .map((line) => Number.parseFloat(line.trim()))
      .filter((delay) => Number.isFinite(delay) && delay > 0)
      .reduce((sum, delay) => sum + delay, 0);
    return totalTicks > 0 ? totalTicks / 100 : undefined;
  } catch {
    return undefined;
  }
}

function sampleTimestamps(durationSeconds: number | undefined): number[] {
  if (!durationSeconds || durationSeconds <= 0) return [0];
  const lastTimestamp = Math.max(0, durationSeconds - Math.min(0.05, durationSeconds / 10));
  if (lastTimestamp === 0) return [0];
  return Array.from({ length: SAMPLE_COUNT }, (_unused, index) => (lastTimestamp * index) / (SAMPLE_COUNT - 1));
}

async function extractFrame(
  exec: CommandExecutor,
  inputPath: string,
  outputPath: string,
  timestampSeconds: number,
  signal?: AbortSignal,
) {
  const args = ["-v", "error", "-y", "-i", inputPath];
  if (timestampSeconds > 0) args.push("-ss", timestampSeconds.toFixed(3));
  args.push("-frames:v", "1", "-vf", SCALE_FILTER, outputPath);
  await runCheckedCommand(exec, "ffmpeg", args, signal);
  const output = await stat(outputPath);
  if (output.size === 0) throw new Error(`ffmpeg created an empty frame at ${timestampSeconds.toFixed(3)}s`);
}

export async function generateContactSheet(exec: CommandExecutor, inputPath: string, signal?: AbortSignal) {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-gif-read-"));
  try {
    const durationSeconds = await getDurationSeconds(exec, inputPath, signal);
    const timestamps = sampleTimestamps(durationSeconds);
    const framePaths: string[] = [];
    const sampledTimestamps: number[] = [];

    for (let index = 0; index < timestamps.length; index++) {
      const framePath = join(tempDir, `frame-${index}.png`);
      try {
        await extractFrame(exec, inputPath, framePath, timestamps[index] ?? 0, signal);
        framePaths.push(framePath);
        sampledTimestamps.push(timestamps[index] ?? 0);
      } catch {
        // Some decoders fail near EOF for short GIFs. Keep successfully extracted frames.
      }
    }

    if (framePaths.length === 0) {
      const framePath = join(tempDir, "frame-fallback.png");
      await extractFrame(exec, inputPath, framePath, 0, signal);
      framePaths.push(framePath);
      sampledTimestamps.push(0);
    }

    const sheetPath = join(tempDir, "contact-sheet.png");
    await runCheckedCommand(
      exec,
      "magick",
      [...framePaths, "-bordercolor", "white", "-border", "8", "+append", sheetPath],
      signal,
    );
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
