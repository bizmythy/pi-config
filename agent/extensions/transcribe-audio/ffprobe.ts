import { extname } from "node:path";

const FFPROBE_TIMEOUT_MS = 15_000;

const MEDIA_TYPES = new Map([
  [".mp3", "audio/mpeg"],
  [".mp4", "audio/mp4"],
  [".mpeg", "audio/mpeg"],
  [".mpga", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".wav", "audio/wav"],
  [".webm", "audio/webm"],
]);

// ffprobe reports some supported containers using family names. For example,
// M4A and MP4 files commonly report "mov,mp4,m4a,3gp,3g2,mj2", while WebM
// commonly reports "matroska,webm".
const SUPPORTED_PROBE_FORMAT_NAMES = new Set(["m4a", "matroska", "mov", "mp3", "mp4", "mpeg", "wav", "webm"]);

export type AudioProbe = {
  formatNames: string[];
  audioCodecs: string[];
  durationSeconds?: number;
};

export type CommandExecutor = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeout: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

type FfprobeOutput = {
  format?: {
    duration?: unknown;
    format_name?: unknown;
  };
  streams?: Array<{
    codec_name?: unknown;
    codec_type?: unknown;
  }>;
};

export function getSupportedMediaType(inputPath: string): string {
  const extension = extname(inputPath).toLowerCase();
  const mediaType = MEDIA_TYPES.get(extension);
  if (!mediaType) {
    throw new Error(
      `Unsupported audio format ${extension || "(none)"}. Supported formats: ${[...MEDIA_TYPES.keys()].join(", ")}.`,
    );
  }
  return mediaType;
}

export function validateFfprobeOutput(output: unknown, inputPath: string): AudioProbe {
  if (!output || typeof output !== "object") {
    throw new Error(`ffprobe returned invalid metadata for ${inputPath}.`);
  }

  const probe = output as FfprobeOutput;
  const rawFormatName = probe.format?.format_name;
  if (typeof rawFormatName !== "string" || !rawFormatName.trim()) {
    throw new Error(`ffprobe could not identify the media format for ${inputPath}.`);
  }

  const formatNames = rawFormatName
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const audioStreams = (probe.streams ?? []).filter((stream) => stream.codec_type === "audio");
  if (audioStreams.length === 0) {
    throw new Error(`ffprobe found no audio stream in ${inputPath}.`);
  }

  if (!formatNames.some((name) => SUPPORTED_PROBE_FORMAT_NAMES.has(name))) {
    throw new Error(
      `ffprobe detected unsupported format ${rawFormatName} for ${inputPath}. Supported transcription formats: ${[...MEDIA_TYPES.keys()].join(", ")}.`,
    );
  }

  const audioCodecs = audioStreams.flatMap((stream) =>
    typeof stream.codec_name === "string" && stream.codec_name.trim() ? [stream.codec_name.trim()] : [],
  );
  const parsedDuration =
    typeof probe.format?.duration === "string" ? Number.parseFloat(probe.format.duration) : Number.NaN;

  return {
    formatNames,
    audioCodecs,
    durationSeconds: Number.isFinite(parsedDuration) && parsedDuration >= 0 ? parsedDuration : undefined,
  };
}

export async function probeAudioFile(
  exec: CommandExecutor,
  inputPath: string,
  signal?: AbortSignal,
): Promise<AudioProbe> {
  const result = await exec(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration",
      "-show_entries",
      "stream=codec_type,codec_name",
      "-of",
      "json",
      inputPath,
    ],
    { signal, timeout: FFPROBE_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `ffprobe exited with status ${result.code}`;
    throw new Error(`ffprobe could not validate ${inputPath}: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`ffprobe returned invalid JSON for ${inputPath}: ${reason}`);
  }
  return validateFfprobeOutput(parsed, inputPath);
}
