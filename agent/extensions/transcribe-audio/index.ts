import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MODEL, saveTranscript, type TranscriptionResult, transcribeAudio } from "./core.js";

const SECRETS_FILE = join(homedir(), ".pi", "secrets", "personal.json");
const OUTPUT_DIR = join(homedir(), ".pi", "agent", "transcriptions");
const TRANSCRIPT_PREVIEW_MAX_BYTES = DEFAULT_MAX_BYTES - 4 * 1024;
const TRANSCRIPT_PREVIEW_MAX_LINES = DEFAULT_MAX_LINES - 20;

const transcribeAudioSchema = Type.Object({
  path: Type.String({
    description: "Path to the audio file, absolute or relative to the current working directory.",
  }),
  prompt: Type.Optional(
    Type.String({
      description:
        "Optional context to improve transcription accuracy, such as expected proper nouns, acronyms, technical terms, topic, or preferred spelling.",
    }),
  ),
});

export type TranscribeAudioInput = {
  path: string;
  prompt?: string;
};

function resultMessage(result: TranscriptionResult): string {
  const preview = truncateHead(result.text, {
    maxBytes: TRANSCRIPT_PREVIEW_MAX_BYTES,
    maxLines: TRANSCRIPT_PREVIEW_MAX_LINES,
  });
  const lines = [
    "Audio transcription completed.",
    `Input: ${result.inputPath}`,
    `Output: ${result.outputPath}`,
    `Model: ${MODEL}`,
  ];
  if (result.languages.length > 0) lines.push(`Detected language(s): ${result.languages.join(", ")}`);
  lines.push("", "Transcript:", preview.content || "(No speech detected.)");
  if (preview.truncated) {
    lines.push(
      "",
      `[Transcript preview truncated to ${preview.outputLines} of ${preview.totalLines} lines (${formatSize(preview.outputBytes)} of ${formatSize(preview.totalBytes)}). Read the output file for the complete transcript.]`,
    );
  }
  return lines.join("\n");
}

export default function transcribeAudioExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "transcribe_audio",
    label: "Transcribe Audio",
    description:
      "Transcribe spoken-word audio with OpenAI gpt-transcribe. Accepts mp3, mp4, mpeg, mpga, m4a, wav, or webm files up to 25 MB, accepts optional recording context, and saves the complete transcript under ~/.pi/agent/transcriptions/.",
    promptSnippet: "Transcribe a spoken-word audio recording to a saved text file",
    promptGuidelines: [
      "Use transcribe_audio when the user asks to transcribe a voice memo or another spoken-word recording; include relevant proper nouns or specialized vocabulary in its prompt when available.",
    ],
    parameters: transcribeAudioSchema,
    async execute(_toolCallId, params: TranscribeAudioInput, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Transcribing ${params.path} with ${MODEL}...` }],
        details: {},
      });
      const result = await transcribeAudio({
        cwd: ctx.cwd,
        path: params.path,
        prompt: params.prompt,
        signal,
        secretsFile: SECRETS_FILE,
        outputDir: OUTPUT_DIR,
        saveOutput: (outputPath, outputDir, text) =>
          withFileMutationQueue(outputPath, () => saveTranscript(outputPath, outputDir, text)),
      });
      return {
        content: [{ type: "text", text: resultMessage(result) }],
        details: {
          inputPath: result.inputPath,
          outputPath: result.outputPath,
          model: MODEL,
          languages: result.languages,
          audioBytes: result.sizeBytes,
        },
      };
    },
  });
}
