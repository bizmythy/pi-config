import { Buffer as NodeBuffer } from "node:buffer";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { decodeMultiStream, encode } from "@msgpack/msgpack";
import { NeovimGrid } from "./grid";

export interface NeovimEditorState {
  lines: string[];
  cursorLine: number;
  cursorColumn: number;
  promptBufferActive: boolean;
}

export interface NeovimHostOptions {
  cwd: string;
  initialText?: string;
  args?: string[];
  onState: (state: NeovimEditorState) => void;
  onSubmit: () => void;
  onError: (message: string) => void;
  onExit: (unexpected: boolean, message?: string) => void;
  onRender: () => void;
}

function byteLength(text: string): number {
  return NodeBuffer.byteLength(text, "utf8");
}

export function byteColumnToStringColumn(text: string, byteColumn: number): number {
  const bytes = NodeBuffer.from(text, "utf8");
  return bytes.subarray(0, Math.max(0, Math.min(byteColumn, bytes.length))).toString("utf8").length;
}

export function stringColumnToByteColumn(text: string, stringColumn: number): number {
  return byteLength(text.slice(0, Math.max(0, Math.min(stringColumn, text.length))));
}

function errorMessage(error: unknown): string {
  if (Array.isArray(error)) return error.map(String).join(": ");
  return error instanceof Error ? error.message : String(error);
}

function resolveNeovim(): string {
  const result = spawnSync("nvim", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("Neovim 0.10 or newer was not found on PATH");
  const match = /^NVIM v(\d+)\.(\d+)/m.exec(result.stdout);
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 10)) {
    throw new Error(`Neovim 0.10 or newer is required; found ${match?.[0] ?? "an unknown version"}`);
  }
  return "nvim";
}

type RpcMessage = unknown[];
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Minimal MessagePack-RPC client for the stable Neovim API. */
class NeovimRpc {
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotification: (method: string, args: unknown[]) => void,
  ) {
    void this.readMessages();
  }

  request<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Neovim RPC channel is closed"));
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write([0, id, method, args]);
    });
  }

  notify(method: string, args: unknown[] = []): void {
    if (!this.closed) this.write([2, method, args]);
  }

  close(reason = "Neovim RPC channel closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }

  private write(message: RpcMessage): void {
    this.child.stdin.write(encode(message));
  }

  private async readMessages(): Promise<void> {
    try {
      for await (const value of decodeMultiStream(this.child.stdout)) {
        const message = value as RpcMessage;
        const type = Number(message[0]);
        if (type === 1) {
          const id = Number(message[1]);
          const pending = this.pending.get(id);
          if (!pending) continue;
          this.pending.delete(id);
          const error = message[2];
          if (error === null || error === undefined) pending.resolve(message[3]);
          else pending.reject(new Error(errorMessage(error)));
        } else if (type === 2) {
          this.onNotification(String(message[1]), Array.isArray(message[2]) ? message[2] : []);
        } else if (type === 0) {
          // The integration does not expose RPC request handlers. Reply instead
          // of leaving Neovim blocked if a user config requests one.
          this.write([1, Number(message[1]), [0, "Pi editor does not handle RPC requests"], null]);
        }
      }
    } catch (error) {
      this.close(`Neovim RPC decode failed: ${errorMessage(error)}`);
    } finally {
      this.close();
    }
  }
}

const SETUP_LUA = `
local channel, lines, row, byte_col = ...
local buffer = vim.api.nvim_create_buf(false, true)
vim.g.pi_prompt_buffer = buffer
vim.api.nvim_buf_set_name(buffer, '[Pi Prompt]')
vim.bo[buffer].bufhidden = 'hide'
vim.bo[buffer].swapfile = false
vim.bo[buffer].undofile = false
vim.bo[buffer].filetype = 'markdown'
vim.api.nvim_set_current_buf(buffer)
vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
vim.api.nvim_win_set_cursor(0, { row + 1, byte_col })
vim.api.nvim_buf_create_user_command(buffer, 'PiSubmit', function()
  vim.rpcnotify(channel, 'pi_submit')
end, { desc = 'Submit the current prompt to Pi' })
local group = vim.api.nvim_create_augroup('PiEmbeddedPrompt', { clear = true })
vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI', 'CursorMoved', 'CursorMovedI', 'ModeChanged', 'BufEnter' }, {
  group = group,
  callback = function() vim.rpcnotify(channel, 'pi_state_dirty') end,
})
return buffer
`;

const GET_STATE_LUA = `
local buffer = vim.g.pi_prompt_buffer
if not buffer or not vim.api.nvim_buf_is_valid(buffer) then return nil end
local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
local active = vim.api.nvim_get_current_buf() == buffer
local cursor = active and vim.api.nvim_win_get_cursor(0) or { 1, 0 }
return { lines, cursor[1] - 1, cursor[2], active }
`;

const SET_STATE_LUA = `
local lines, row, byte_col = ...
local buffer = vim.g.pi_prompt_buffer
if not buffer or not vim.api.nvim_buf_is_valid(buffer) then return false end
vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
if vim.api.nvim_get_current_buf() == buffer then vim.api.nvim_win_set_cursor(0, { row + 1, byte_col }) end
return true
`;

const INSERT_TEXT_LUA = `
local row, byte_col, replacement, target_row, target_byte_col = ...
local buffer = vim.g.pi_prompt_buffer
if not buffer or not vim.api.nvim_buf_is_valid(buffer) then return false end
vim.api.nvim_buf_set_text(buffer, row, byte_col, row, byte_col, replacement)
if vim.api.nvim_get_current_buf() == buffer then vim.api.nvim_win_set_cursor(0, { target_row + 1, target_byte_col }) end
return true
`;

/** Owns one embedded Neovim process and its prompt buffer. */
export class NeovimHost {
  readonly grid = new NeovimGrid();

  private process?: ChildProcessWithoutNullStreams;
  private rpc?: NeovimRpc;
  private state: NeovimEditorState;
  private width = 1;
  private height = 1;
  private started = false;
  private ready = false;
  private disposing = false;
  private inputQueue: Array<{ kind: "keys" | "paste"; value: string }> = [];
  private operation = Promise.resolve();
  private syncScheduled = false;
  private stderrTail = "";

  constructor(private readonly options: NeovimHostOptions) {
    const lines = (options.initialText ?? "").split("\n");
    this.state = {
      lines,
      cursorLine: lines.length - 1,
      cursorColumn: lines.at(-1)?.length ?? 0,
      promptBufferActive: true,
    };
    this.grid.onFlush = () => {
      this.options.onRender();
      this.scheduleStateSync();
    };
  }

  get isReady(): boolean {
    return this.ready;
  }

  get text(): string {
    return this.state.lines.join("\n");
  }

  get editorState(): NeovimEditorState {
    return { ...this.state, lines: [...this.state.lines] };
  }

  async start(width: number, height: number): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);

    try {
      const child = spawn(resolveNeovim(), this.options.args ?? ["--embed"], {
        cwd: this.options.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
      });
      child.once("error", (error) => this.fail(`Failed to start Neovim: ${errorMessage(error)}`));
      child.once("exit", (code, signal) => {
        this.ready = false;
        this.rpc?.close();
        const detail = this.stderrTail.trim() || `Neovim exited (${signal ?? code ?? "unknown status"})`;
        this.options.onExit(!this.disposing, detail);
      });

      const rpc = new NeovimRpc(child, (method, args) => this.handleNotification(method, args));
      this.rpc = rpc;
      const apiInfo = await rpc.request<unknown[]>("nvim_get_api_info");
      const channel = Number(apiInfo[0]);
      await rpc.request("nvim_ui_attach", [this.width, this.height, { rgb: true, ext_linegrid: true }]);
      const line = this.state.lines[this.state.cursorLine] ?? "";
      await rpc.request("nvim_exec_lua", [
        SETUP_LUA,
        [channel, this.state.lines, this.state.cursorLine, stringColumnToByteColumn(line, this.state.cursorColumn)],
      ]);
      this.ready = true;
      await this.syncState();
      await this.flushInputQueue();
      this.options.onRender();
    } catch (error) {
      this.fail(`Unable to initialize embedded Neovim: ${errorMessage(error)}`);
      await this.dispose();
    }
  }

  private handleNotification(method: string, args: unknown[]): void {
    if (method === "redraw") {
      this.grid.handleRedraw(args);
      return;
    }
    if (method === "pi_submit") this.options.onSubmit();
    if (method === "pi_state_dirty") this.scheduleStateSync();
  }

  private fail(message: string): void {
    this.options.onError(message);
    this.options.onRender();
  }

  sendKeys(keys: string): void {
    if (!keys) return;
    if (!this.ready || !this.rpc) {
      if (this.inputQueue.length < 256) this.inputQueue.push({ kind: "keys", value: keys });
      return;
    }
    void this.rpc
      .request("nvim_input", [keys])
      .then(() => this.scheduleStateSync())
      .catch((error) => this.fail(errorMessage(error)));
  }

  paste(text: string): void {
    if (!this.ready || !this.rpc) {
      if (this.inputQueue.length < 256) this.inputQueue.push({ kind: "paste", value: text });
      return;
    }
    void this.rpc
      .request("nvim_paste", [text, true, -1])
      .then(() => this.scheduleStateSync())
      .catch((error) => this.fail(errorMessage(error)));
  }

  private async flushInputQueue(): Promise<void> {
    const queued = this.inputQueue;
    this.inputQueue = [];
    for (const input of queued) {
      if (input.kind === "paste") await this.rpc?.request("nvim_paste", [input.value, true, -1]);
      else await this.rpc?.request("nvim_input", [input.value]);
    }
  }

  setText(text: string, cursor: "start" | "end" = "end"): Promise<void> {
    const lines = text.split("\n");
    const cursorLine = cursor === "start" ? 0 : lines.length - 1;
    const cursorColumn = cursor === "start" ? 0 : (lines[cursorLine]?.length ?? 0);
    return this.setState(lines, cursorLine, cursorColumn);
  }

  setState(lines: string[], cursorLine: number, cursorColumn: number): Promise<void> {
    const normalized = lines.length > 0 ? lines : [""];
    const targetLine = Math.max(0, Math.min(cursorLine, normalized.length - 1));
    const targetColumn = Math.max(0, cursorColumn);
    this.state = {
      lines: [...normalized],
      cursorLine: targetLine,
      cursorColumn: targetColumn,
      promptBufferActive: true,
    };
    this.options.onState(this.editorState);

    return this.enqueue(async () => {
      if (!this.ready || !this.rpc) return;
      const line = normalized[targetLine] ?? "";
      await this.rpc.request("nvim_exec_lua", [
        SET_STATE_LUA,
        [normalized, targetLine, stringColumnToByteColumn(line, targetColumn)],
      ]);
      this.scheduleStateSync();
    });
  }

  insertText(text: string): Promise<void> {
    if (!this.ready || !this.rpc) {
      const line = this.state.lines[this.state.cursorLine] ?? "";
      const before = line.slice(0, this.state.cursorColumn);
      const after = line.slice(this.state.cursorColumn);
      const inserted = text.split("\n");
      const replacement = [...this.state.lines];
      replacement.splice(
        this.state.cursorLine,
        1,
        ...(inserted.length === 1
          ? [`${before}${inserted[0]}${after}`]
          : [`${before}${inserted[0]}`, ...inserted.slice(1, -1), `${inserted.at(-1)}${after}`]),
      );
      const row = this.state.cursorLine + inserted.length - 1;
      const column = inserted.length === 1 ? before.length + inserted[0].length : (inserted.at(-1)?.length ?? 0);
      return this.setState(replacement, row, column);
    }

    return this.enqueue(async () => {
      if (!this.rpc) return;
      const line = this.state.lines[this.state.cursorLine] ?? "";
      const byteColumn = stringColumnToByteColumn(line, this.state.cursorColumn);
      const replacement = text.split("\n");
      const targetLine = this.state.cursorLine + replacement.length - 1;
      const targetColumn =
        replacement.length === 1 ? this.state.cursorColumn + replacement[0].length : (replacement.at(-1)?.length ?? 0);
      const targetText =
        replacement.length === 1
          ? `${line.slice(0, this.state.cursorColumn)}${replacement[0]}`
          : (replacement.at(-1) ?? "");
      await this.rpc.request("nvim_exec_lua", [
        INSERT_TEXT_LUA,
        [
          this.state.cursorLine,
          byteColumn,
          replacement,
          targetLine,
          stringColumnToByteColumn(targetText, targetColumn),
        ],
      ]);
      this.scheduleStateSync();
    });
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    if (this.ready && this.rpc) {
      void this.rpc
        .request("nvim_ui_try_resize", [nextWidth, nextHeight])
        .catch((error) => this.fail(errorMessage(error)));
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.operation = this.operation.then(operation, operation);
    return this.operation;
  }

  private scheduleStateSync(): void {
    if (this.syncScheduled || !this.ready) return;
    this.syncScheduled = true;
    setTimeout(() => {
      this.syncScheduled = false;
      void this.syncState();
    }, 0);
  }

  private async syncState(): Promise<void> {
    if (!this.rpc || !this.ready) return;
    try {
      const result = await this.rpc.request<[string[], number, number, boolean] | null>("nvim_exec_lua", [
        GET_STATE_LUA,
        [],
      ]);
      if (!result) throw new Error("the [Pi Prompt] buffer no longer exists");
      const [lines, cursorLine, byteColumn, active] = result;
      const normalized = lines.length > 0 ? lines : [""];
      const line = normalized[cursorLine] ?? "";
      this.state = {
        lines: normalized,
        cursorLine: active ? Math.max(0, cursorLine) : this.state.cursorLine,
        cursorColumn: active ? byteColumnToStringColumn(line, byteColumn) : this.state.cursorColumn,
        promptBufferActive: active,
      };
      this.options.onState(this.editorState);
    } catch (error) {
      const message = errorMessage(error);
      if (!this.disposing && !message.includes("Neovim RPC channel")) {
        this.fail(`Could not synchronize Neovim prompt: ${message}`);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    this.ready = false;
    const child = this.process;
    const rpc = this.rpc;
    if (!child) return;

    try {
      await rpc?.request("nvim_ui_detach");
    } catch {
      // Neovim may already be gone.
    }
    rpc?.notify("nvim_command", ["qa!"]);

    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          }, 250).unref();
          resolve();
        }, 750);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rpc?.close();
  }
}
