import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
  type CommandExecutor,
  generateContactSheet,
  runCheckedCommand,
} from "../../extensions/gif-read-support/core.js";

const result = (code = 0, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr, killed: false });

test("checked GIF commands propagate signal and timeout", async () => {
  const controller = new AbortController();
  let observed: Parameters<CommandExecutor>[2];
  const exec: CommandExecutor = async (_command, _args, options) => {
    observed = options;
    return result(0, "ok");
  };

  assert.equal((await runCheckedCommand(exec, "probe", ["file"], controller.signal, 1234)).stdout, "ok");
  assert.equal(observed?.signal, controller.signal);
  assert.equal(observed?.timeout, 1234);
});

test("checked GIF commands report stderr or exit status", async () => {
  await assert.rejects(
    runCheckedCommand(async () => result(2, "", "bad input\n"), "ffmpeg", []),
    /bad input/,
  );
  await assert.rejects(
    runCheckedCommand(async () => result(9), "magick", []),
    /magick exited with status 9/,
  );
});

test("contact-sheet generation removes its temporary directory after success", async () => {
  let tempDirectory = "";
  const exec: CommandExecutor = async (command, args) => {
    if (command === "ffprobe" || (command === "magick" && args[0] === "identify")) return result(1);
    const output = args.at(-1);
    assert.ok(output);
    tempDirectory = dirname(output);
    await writeFile(output, "image");
    return result();
  };

  const sheet = await generateContactSheet(exec, "/tmp/input.gif");
  assert.equal(sheet.sampleCount, 1);
  await assert.rejects(access(tempDirectory));
});

test("contact-sheet generation removes its temporary directory after failure", async () => {
  let tempDirectory = "";
  const exec: CommandExecutor = async (command, args) => {
    if (command === "ffprobe" || (command === "magick" && args[0] === "identify")) return result(1);
    const output = args.at(-1);
    if (output) tempDirectory = dirname(output);
    return result(1, "", "decoder failed");
  };

  await assert.rejects(generateContactSheet(exec, "/tmp/input.gif"), /decoder failed/);
  assert.ok(tempDirectory);
  await assert.rejects(access(tempDirectory));
});
