import assert from "node:assert/strict";
import test from "node:test";
import {
  type CommandExecutor,
  getSupportedMediaType,
  probeAudioFile,
  validateFfprobeOutput,
} from "../../extensions/transcribe-audio/ffprobe.js";

const ffprobeJson = (formatName: string, streams: Array<{ codec_type: string; codec_name?: string }>) =>
  JSON.stringify({
    format: { format_name: formatName, duration: "12.5" },
    streams,
  });

test("supported extensions map to upload media types", () => {
  assert.equal(getSupportedMediaType("memo.mp3"), "audio/mpeg");
  assert.equal(getSupportedMediaType("memo.M4A"), "audio/mp4");
  assert.equal(getSupportedMediaType("memo.webm"), "audio/webm");
  assert.throws(() => getSupportedMediaType("memo.flac"), /Unsupported audio format \.flac/);
});

test("ffprobe execution uses JSON output and returns validated audio metadata", async () => {
  const controller = new AbortController();
  let invocation: { command: string; args: string[]; options: { signal?: AbortSignal; timeout: number } } | undefined;
  const exec: CommandExecutor = async (command, args, options) => {
    invocation = { command, args, options };
    return {
      code: 0,
      stdout: ffprobeJson("mov,mp4,m4a,3gp,3g2,mj2", [{ codec_type: "audio", codec_name: "aac" }]),
      stderr: "",
    };
  };

  const result = await probeAudioFile(exec, "/tmp/voice memo.m4a", controller.signal);

  assert.equal(invocation?.command, "ffprobe");
  assert.deepEqual(invocation?.args.slice(0, 2), ["-v", "error"]);
  assert.deepEqual(invocation?.args.slice(-3), ["-of", "json", "/tmp/voice memo.m4a"]);
  assert.equal(invocation?.options.signal, controller.signal);
  assert.equal(invocation?.options.timeout, 15_000);
  assert.deepEqual(result, {
    formatNames: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    audioCodecs: ["aac"],
    durationSeconds: 12.5,
  });
});

test("ffprobe validation rejects media without audio and unsupported containers", () => {
  assert.throws(
    () =>
      validateFfprobeOutput(
        JSON.parse(ffprobeJson("mov,mp4", [{ codec_type: "video", codec_name: "h264" }])),
        "clip.mp4",
      ),
    /found no audio stream/,
  );
  assert.throws(
    () =>
      validateFfprobeOutput(JSON.parse(ffprobeJson("flac", [{ codec_type: "audio", codec_name: "flac" }])), "memo.wav"),
    /detected unsupported format flac/,
  );
});

test("ffprobe command failures include useful diagnostics", async () => {
  await assert.rejects(
    probeAudioFile(
      async () => ({ code: 1, stdout: "", stderr: "Invalid data found when processing input\n" }),
      "fake.wav",
    ),
    /ffprobe could not validate fake\.wav: Invalid data found when processing input/,
  );
});
