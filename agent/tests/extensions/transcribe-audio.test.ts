import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { transcribeAudio } from "../../extensions/transcribe-audio/core.js";

const VALID_PROBE = {
  formatNames: ["wav"],
  audioCodecs: ["pcm_s16le"],
  durationSeconds: 1,
};

test("transcription uploads the requested audio and context, then saves the complete transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-transcribe-audio-"));
  const project = join(root, "project");
  const outputDir = join(root, "transcriptions");
  const audioPath = join(project, "voice memo.wav");
  const secretsFile = join(root, "personal.json");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(project));
  await writeFile(audioPath, "mock wav bytes");
  await writeFile(secretsFile, JSON.stringify({ openai: { apiKey: "test-key" } }));

  let request: { input: string | URL | Request; init?: RequestInit } | undefined;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    request = { input, init };
    return new Response(
      JSON.stringify({
        text: "Today we are discussing ZyntriQix and the Dirac equation.",
        languages: [{ code: "en" }],
      }),
      { status: 200 },
    );
  };

  try {
    const result = await transcribeAudio({
      cwd: project,
      path: "@voice memo.wav",
      prompt: "Spell the proper nouns ZyntriQix and Dirac exactly.",
      secretsFile,
      outputDir,
      fetchImpl,
      probeImpl: async () => VALID_PROBE,
      now: new Date("2026-08-14T12:34:56.789Z"),
    });

    assert.equal(String(request?.input), "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(request?.init?.method, "POST");
    assert.deepEqual(request?.init?.headers, { Authorization: "Bearer test-key" });
    assert.ok(request?.init?.body instanceof FormData);
    const form = request.init.body;
    assert.equal(form.get("model"), "gpt-transcribe");
    assert.equal(form.get("prompt"), "Spell the proper nouns ZyntriQix and Dirac exactly.");
    const uploadedFile = form.get("file");
    assert.ok(uploadedFile instanceof Blob);
    assert.equal((uploadedFile as Blob & { name?: string }).name, basename(audioPath));
    assert.equal(await uploadedFile.text(), "mock wav bytes");

    assert.equal(result.inputPath, audioPath);
    assert.deepEqual(result.languages, ["en"]);
    assert.match(result.outputPath, /voice-memo-20260814T123456-789Z-[a-f0-9]{8}\.txt$/);
    assert.equal(
      await readFile(result.outputPath, "utf8"),
      "Today we are discussing ZyntriQix and the Dirac equation.\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transcription rejects unsupported input before sending credentials to the API", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-transcribe-audio-"));
  const inputPath = join(root, "notes.txt");
  await writeFile(inputPath, "not audio");
  let called = false;

  try {
    await assert.rejects(
      transcribeAudio({
        cwd: root,
        path: inputPath,
        secretsFile: join(root, "missing-personal.json"),
        outputDir: join(root, "output"),
        probeImpl: async () => VALID_PROBE,
        fetchImpl: async () => {
          called = true;
          return new Response();
        },
      }),
      /Unsupported audio format \.txt/,
    );
    assert.equal(called, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transcription stops before reading credentials or calling OpenAI when media validation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-transcribe-audio-"));
  const audioPath = join(root, "fake.wav");
  await writeFile(audioPath, "not actually audio");
  let called = false;

  try {
    await assert.rejects(
      transcribeAudio({
        cwd: root,
        path: audioPath,
        secretsFile: join(root, "missing-personal.json"),
        outputDir: join(root, "output"),
        probeImpl: async () => {
          throw new Error(`ffprobe found no audio stream in ${audioPath}.`);
        },
        fetchImpl: async () => {
          called = true;
          return new Response();
        },
      }),
      /ffprobe found no audio stream/,
    );
    assert.equal(called, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI API failures are actionable and do not create a transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-transcribe-audio-"));
  const audioPath = join(root, "memo.m4a");
  const secretsFile = join(root, "personal.json");
  const outputDir = join(root, "output");
  await writeFile(audioPath, "mock m4a bytes");
  await writeFile(secretsFile, JSON.stringify({ openai: { apiKey: "test-key" } }));

  try {
    await assert.rejects(
      transcribeAudio({
        cwd: root,
        path: audioPath,
        secretsFile,
        outputDir,
        probeImpl: async () => VALID_PROBE,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: "The uploaded file is invalid." } }), { status: 400 }),
      }),
      /OpenAI transcription failed \(HTTP 400\): The uploaded file is invalid\./,
    );
    await assert.rejects(readFile(outputDir), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
