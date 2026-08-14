import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, parse, resolve } from "node:path";
import { type AudioProbe, getSupportedMediaType } from "./ffprobe.js";

export const MODEL = "gpt-transcribe";
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";

type PersonalSecrets = {
  openai?: {
    apiKey?: string;
  };
};

type TranscriptionResponse = {
  text?: unknown;
  languages?: unknown;
};

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type SaveOutput = (outputPath: string, outputDir: string, text: string) => Promise<void>;

type ProbeImplementation = (inputPath: string, signal?: AbortSignal) => Promise<AudioProbe>;

export type TranscriptionOptions = {
  cwd: string;
  path: string;
  prompt?: string;
  signal?: AbortSignal;
  secretsFile: string;
  outputDir: string;
  fetchImpl?: FetchImplementation;
  probeImpl: ProbeImplementation;
  saveOutput?: SaveOutput;
  now?: Date;
};

export type TranscriptionResult = {
  inputPath: string;
  outputPath: string;
  text: string;
  languages: string[];
  sizeBytes: number;
  probe: AudioProbe;
};

export function normalizeInputPath(cwd: string, path: string): string {
  const withoutAtPrefix = path.startsWith("@") ? path.slice(1) : path;
  if (!withoutAtPrefix.trim()) throw new Error("Audio path must not be empty.");
  return resolve(cwd, withoutAtPrefix);
}

export function readApiKey(contents: string, secretsFile: string): string {
  let secrets: PersonalSecrets;
  try {
    secrets = JSON.parse(contents) as PersonalSecrets;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse OpenAI credentials in ${secretsFile}: ${reason}`);
  }

  const apiKey = secrets.openai?.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      `Missing OpenAI API key at openai.apiKey in ${secretsFile}. Run ./scripts/install.nu to regenerate personal secrets.`,
    );
  }
  return apiKey;
}

export function normalizeLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((language) => {
    if (typeof language === "string" && language.trim()) return [language.trim()];
    if (!language || typeof language !== "object") return [];
    const code = (language as { code?: unknown }).code;
    return typeof code === "string" && code.trim() ? [code.trim()] : [];
  });
}

function transcriptFileName(inputPath: string, now: Date): string {
  const inputStem = parse(basename(inputPath)).name;
  const safeStem = inputStem.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "transcript";
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(".", "-");
  return `${safeStem}-${timestamp}-${randomUUID().slice(0, 8)}.txt`;
}

function getApiErrorMessage(status: number, body: string): string {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    if (typeof parsed.error?.message === "string") detail = parsed.error.message;
    else if (typeof parsed.message === "string") detail = parsed.message;
  } catch {
    // Preserve a non-JSON response body as the diagnostic.
  }

  const boundedDetail = detail.slice(0, 1_000);
  return `OpenAI transcription failed (HTTP ${status})${boundedDetail ? `: ${boundedDetail}` : "."}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function saveTranscript(outputPath: string, outputDir: string, text: string): Promise<void> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${text}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function transcribeAudio(options: TranscriptionOptions): Promise<TranscriptionResult> {
  const inputPath = normalizeInputPath(options.cwd, options.path);
  const mediaType = getSupportedMediaType(inputPath);
  const probe = await options.probeImpl(inputPath, options.signal);

  let audio: Buffer;
  try {
    audio = await readFile(inputPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read audio file ${inputPath}: ${reason}`);
  }

  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(
      `Audio file is ${formatBytes(audio.byteLength)}, exceeding the OpenAI transcription limit of ${formatBytes(MAX_AUDIO_BYTES)}. Compress or split it first.`,
    );
  }

  let secretsContents: string;
  try {
    secretsContents = await readFile(options.secretsFile, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read OpenAI credentials from ${options.secretsFile}: ${reason}`);
  }
  const apiKey = readApiKey(secretsContents, options.secretsFile);

  const form = new FormData();
  form.append("model", MODEL);
  form.append("file", new Blob([audio], { type: mediaType }), basename(inputPath));
  if (options.prompt?.trim()) form.append("prompt", options.prompt.trim());

  const response = await (options.fetchImpl ?? fetch)(TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: options.signal,
  });
  const responseBody = await response.text();
  if (!response.ok) throw new Error(getApiErrorMessage(response.status, responseBody));

  let payload: TranscriptionResponse;
  try {
    payload = JSON.parse(responseBody) as TranscriptionResponse;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI returned an invalid transcription response: ${reason}`);
  }
  if (typeof payload.text !== "string") {
    throw new Error("OpenAI transcription response did not contain text.");
  }

  const outputPath = join(options.outputDir, transcriptFileName(inputPath, options.now ?? new Date()));
  await (options.saveOutput ?? saveTranscript)(outputPath, options.outputDir, payload.text);

  return {
    inputPath,
    outputPath,
    text: payload.text,
    languages: normalizeLanguages(payload.languages),
    sizeBytes: audio.byteLength,
    probe,
  };
}
