import { randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalBashOperations,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  highlightCode,
  keyHint,
  type TruncationResult,
  truncateTail,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

const PYTHON_PREVIEW_LINES = 5;
const PYTHON_UPDATE_THROTTLE_MS = 100;

const pythonSchema = {
  type: "object",
  properties: {
    code: { type: "string", description: "Python code to execute via uv run python" },
    timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
  },
  required: ["code"],
  additionalProperties: false,
} as const;

type PythonParams = {
  code: string;
  timeout?: number;
};

type PythonToolDetails = {
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

type PythonRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
};

type OutputSnapshot = {
  content: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
};

function defaultTempFilePath(prefix: string) {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf-8");
}

class OutputAccumulator {
  private readonly maxLines = DEFAULT_MAX_LINES;
  private readonly maxBytes = DEFAULT_MAX_BYTES;
  private readonly maxRollingBytes = Math.max(DEFAULT_MAX_BYTES * 2, 1);
  private readonly decoder = new TextDecoder();
  private readonly rawChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;
  private tempFilePath?: string;
  private tempFileStream?: ReturnType<typeof createWriteStream>;

  append(data: Buffer) {
    if (this.finished) throw new Error("Cannot append to a finished output accumulator");

    this.totalRawBytes += data.length;
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));

    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(data);
    } else if (data.length > 0) {
      this.rawChunks.push(data);
    }
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
    if (this.shouldUseTempFile()) this.ensureTempFile();
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const tailTruncation = truncateTail(this.getSnapshotText(), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncation: TruncationResult = {
      ...tailTruncation,
      truncated,
      truncatedBy: truncated
        ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
        : null,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };

    if (options.persistIfTruncated && truncation.truncated) this.ensureTempFile();
    return { content: truncation.content, truncation, fullOutputPath: this.tempFilePath };
  }

  async closeTempFile() {
    if (!this.tempFileStream) return;

    const stream = this.tempFileStream;
    this.tempFileStream = undefined;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  }

  getLastLineBytes() {
    return this.currentLineBytes;
  }

  private appendDecodedText(text: string) {
    if (text.length === 0) return;

    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();

    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }

    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail() {
    const buffer = Buffer.from(this.tailText, "utf-8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }

    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  private getSnapshotText() {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  private shouldUseTempFile() {
    return (
      this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
    );
  }

  private ensureTempFile() {
    if (this.tempFilePath) return;

    this.tempFilePath = defaultTempFilePath("pi-python");
    this.tempFileStream = createWriteStream(this.tempFilePath);
    for (const chunk of this.rawChunks) this.tempFileStream.write(chunk);
    this.rawChunks.length = 0;
  }
}

class PythonResultRenderComponent extends Container {
  state: {
    cachedWidth?: number;
    cachedLines?: string[];
    cachedSkipped?: number;
  } = {};
}

function makeUvPythonCommand(code: string) {
  let delimiter = `PI_PYTHON_${randomBytes(8).toString("hex")}`;
  while (code.includes(delimiter)) delimiter = `PI_PYTHON_${randomBytes(8).toString("hex")}`;
  return `uv run python - <<'${delimiter}'\n${code}\n${delimiter}`;
}

function formatDuration(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatPythonCall(
  args: unknown,
  theme: Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>>[1],
) {
  const toolArgs = args as { code?: unknown; timeout?: unknown } | undefined;
  const code = typeof toolArgs?.code === "string" ? toolArgs.code : undefined;
  const timeout = typeof toolArgs?.timeout === "number" ? toolArgs.timeout : undefined;
  const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
  const header = theme.fg("toolTitle", theme.bold("python")) + timeoutSuffix;

  if (code === undefined) return `${header}\n${theme.fg("error", "invalid code")}`;
  if (code.length === 0) return `${header}\n${theme.fg("toolOutput", "...")}`;

  const highlightedLines = highlightCode(code.replace(/\t/g, "  "), "python");
  const styledCode = highlightedLines.length > 0 ? highlightedLines.join("\n") : theme.fg("toolOutput", code);
  return `${header}\n${styledCode}`;
}

function rebuildPythonResultRenderComponent(
  component: PythonResultRenderComponent,
  result: { content: Array<{ type: string; text?: string }>; details?: PythonToolDetails },
  options: { expanded?: boolean; isPartial?: boolean },
  _showImages: boolean,
  theme: Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>>[2],
  startedAt?: number,
  endedAt?: number,
) {
  const state = component.state;
  component.clear();

  let output = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
  const truncation = result.details?.truncation;
  const fullOutputPath = result.details?.fullOutputPath;

  if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
      output = output.slice(0, footerStart).trimEnd();
    }
  }

  if (output) {
    const styledOutput = output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");

    if (options.expanded) {
      component.addChild(new Text(`\n${styledOutput}`, 0, 0));
    } else {
      component.addChild({
        render: (width: number) => {
          if (state.cachedLines === undefined || state.cachedWidth !== width) {
            const preview = truncateToVisualLines(styledOutput, PYTHON_PREVIEW_LINES, width);
            state.cachedLines = preview.visualLines;
            state.cachedSkipped = preview.skippedCount;
            state.cachedWidth = width;
          }

          if (state.cachedSkipped && state.cachedSkipped > 0) {
            const hint =
              theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
            return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
          }

          return ["", ...(state.cachedLines ?? [])];
        },
        invalidate: () => {
          state.cachedWidth = undefined;
          state.cachedLines = undefined;
          state.cachedSkipped = undefined;
        },
      });
    }
  }

  if (truncation?.truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
    if (truncation?.truncated) {
      if (truncation.truncatedBy === "lines") {
        warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
      } else {
        warnings.push(
          `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
        );
      }
    }
    component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
  }

  if (startedAt !== undefined) {
    const label = options.isPartial ? "Elapsed" : "Took";
    const endTime = endedAt ?? Date.now();
    component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
  }
}

async function assertCwdExists(cwd: string) {
  try {
    await fsAccess(cwd, constants.F_OK);
  } catch {
    throw new Error(`Working directory does not exist: ${cwd}\nCannot execute python code.`);
  }
}

export default function (pi: ExtensionAPI) {
  const ops = createLocalBashOperations();

  pi.registerTool({
    name: "python",
    label: "python",
    description: `Execute Python code in the current working directory via \`uv run python -\`. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    promptSnippet: "Execute Python code via uv run python in the current project environment",
    promptGuidelines: [
      "Use python when Python code is clearer than shell commands; the python tool runs code with `uv run python -` in the current project directory so it uses the project's uv/pyproject environment.",
    ],
    parameters: pythonSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { code, timeout } = params as PythonParams;
      const cwd = ctx.cwd;
      await assertCwdExists(cwd);

      const command = makeUvPythonCommand(code);
      const output = new OutputAccumulator();
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty) return;

        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate({
          content: [{ type: "text", text: snapshot.content || "" }],
          details: {
            truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
            fullOutputPath: snapshot.fullOutputPath,
          } satisfies PythonToolDetails,
        });
      };

      const clearUpdateTimer = () => {
        if (!updateTimer) return;
        clearTimeout(updateTimer);
        updateTimer = undefined;
      };

      const scheduleOutputUpdate = () => {
        if (!onUpdate) return;

        updateDirty = true;
        const delay = PYTHON_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }

        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };

      if (onUpdate) onUpdate({ content: [], details: undefined });

      const handleData = (data: Buffer) => {
        output.append(data);
        scheduleOutputUpdate();
      };

      const finishOutput = async () => {
        output.finish();
        clearUpdateTimer();
        emitOutputUpdate();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        await output.closeTempFile();
        return snapshot;
      };

      const formatOutput = (snapshot: OutputSnapshot, emptyText = "(no output)") => {
        const truncation = snapshot.truncation;
        let text = snapshot.content || emptyText;
        let details: PythonToolDetails | undefined;

        if (truncation.truncated) {
          details = { truncation, fullOutputPath: snapshot.fullOutputPath };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes());
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
          }
        }

        return { text, details };
      };

      const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

      try {
        let exitCode: number | null;
        try {
          const result = await ops.exec(command, cwd, { onData: handleData, signal, timeout });
          exitCode = result.exitCode;
        } catch (error) {
          const snapshot = await finishOutput();
          const { text } = formatOutput(snapshot, "");
          if (error instanceof Error && error.message === "aborted") {
            throw new Error(appendStatus(text, "Python execution aborted"));
          }
          if (error instanceof Error && error.message.startsWith("timeout:")) {
            const timeoutSecs = error.message.split(":")[1];
            throw new Error(appendStatus(text, `Python execution timed out after ${timeoutSecs} seconds`));
          }
          throw error;
        }

        const snapshot = await finishOutput();
        const { text, details } = formatOutput(snapshot);
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(appendStatus(text, `Python exited with code ${exitCode}`));
        }

        return { content: [{ type: "text", text }], details };
      } finally {
        clearUpdateTimer();
      }
    },
    renderCall(args, theme, context) {
      const state = context.state as PythonRenderState;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }

      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(formatPythonCall(args, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as PythonRenderState;
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      const component =
        context.lastComponent instanceof PythonResultRenderComponent
          ? context.lastComponent
          : new PythonResultRenderComponent();
      rebuildPythonResultRenderComponent(
        component,
        result as { content: Array<{ type: string; text?: string }>; details?: PythonToolDetails },
        options,
        context.showImages,
        theme,
        state.startedAt,
        state.endedAt,
      );
      component.invalidate();
      return component;
    },
  });
}
