import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type EditorTheme,
  SelectList,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import type { NeovimEditorState } from "./nvim-host";

const DEFAULT_TRIGGERS = ["@", "#"];
const ATTACHMENT_DEBOUNCE_MS = 20;

interface AutocompleteControllerOptions {
  tui: TUI;
  theme: EditorTheme;
  getState: () => NeovimEditorState;
  applyState: (lines: string[], cursorLine: number, cursorColumn: number) => void;
  submit: () => void;
}

type CompletionMode = "regular" | "force";

export class PiAutocompleteController {
  private provider?: AutocompleteProvider;
  private list?: SelectList;
  private prefix = "";
  private mode?: CompletionMode;
  private maxVisible = 5;
  private abort?: AbortController;
  private requestId = 0;
  private debounce?: ReturnType<typeof setTimeout>;
  private lastSnapshot = "";
  private suppressedText?: string;
  private triggerCharacters = [...DEFAULT_TRIGGERS];

  constructor(private readonly options: AutocompleteControllerOptions) {}

  get active(): boolean {
    return this.mode !== undefined && this.list !== undefined;
  }

  setProvider(provider: AutocompleteProvider): void {
    this.cancel();
    this.provider = provider;
    this.triggerCharacters = [...DEFAULT_TRIGGERS];
    for (const character of provider.triggerCharacters ?? []) {
      if (
        character.length === 1 &&
        character !== "/" &&
        !/\s/.test(character) &&
        !this.triggerCharacters.includes(character)
      ) {
        this.triggerCharacters.push(character);
      }
    }
  }

  setMaxVisible(value: number): void {
    this.maxVisible = Number.isFinite(value) ? Math.max(3, Math.min(20, Math.floor(value))) : 5;
  }

  render(width: number): string[] {
    return this.list?.render(width) ?? [];
  }

  stateChanged(): void {
    const state = this.options.getState();
    const snapshot = `${state.promptBufferActive}\0${state.cursorLine}\0${state.cursorColumn}\0${state.lines.join("\n")}`;
    if (snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;

    if (!state.promptBufferActive) {
      this.cancel();
      return;
    }
    if (this.active) {
      this.request(this.mode === "force", false);
      return;
    }
    const text = state.lines.join("\n");
    if (text === this.suppressedText) return;
    this.suppressedText = undefined;
    if (this.isNaturalTrigger(state)) this.request(false, false);
  }

  triggerExplicit(): void {
    this.suppressedText = undefined;
    const state = this.options.getState();
    const beforeCursor = state.lines[state.cursorLine]?.slice(0, state.cursorColumn) ?? "";
    const slashCommandName =
      state.cursorLine === 0 && beforeCursor.trimStart().startsWith("/") && !beforeCursor.trimStart().includes(" ");
    this.request(!slashCommandName, true);
  }

  cancel(): void {
    this.requestId += 1;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    this.abort?.abort();
    this.abort = undefined;
    this.mode = undefined;
    this.list = undefined;
    this.prefix = "";
    this.suppressedText = this.options.getState().lines.join("\n");
    this.options.tui.requestRender();
  }

  handleSelection(action: "up" | "down" | "pageUp" | "pageDown" | "confirm" | "tab" | "cancel"): boolean {
    if (!this.active || !this.list) return false;
    if (action === "cancel") {
      this.cancel();
      return true;
    }
    if (action === "up" || action === "down") {
      this.list.handleInput(action === "up" ? "\x1b[A" : "\x1b[B");
      this.options.tui.requestRender();
      return true;
    }
    if (action === "pageUp" || action === "pageDown") {
      const key = action === "pageUp" ? "\x1b[A" : "\x1b[B";
      for (let count = 0; count < this.maxVisible; count += 1) this.list.handleInput(key);
      this.options.tui.requestRender();
      return true;
    }

    const item = this.list.getSelectedItem();
    if (!item) return true;
    const submitSlashCommand = action === "confirm" && this.prefix.startsWith("/");
    this.apply(item);
    if (submitSlashCommand) this.options.submit();
    return true;
  }

  private isNaturalTrigger(state: NeovimEditorState): boolean {
    const beforeCursor = state.lines[state.cursorLine]?.slice(0, state.cursorColumn) ?? "";
    if (state.cursorLine === 0 && beforeCursor.startsWith("/") && !beforeCursor.includes("\n")) return true;
    return this.triggerCharacters.some((character) => {
      const index = beforeCursor.lastIndexOf(character);
      return (
        index >= 0 && (index === 0 || /\s/.test(beforeCursor[index - 1])) && !/\s/.test(beforeCursor.slice(index + 1))
      );
    });
  }

  private request(force: boolean, explicit: boolean): void {
    const provider = this.provider;
    const state = this.options.getState();
    if (!provider || !state.promptBufferActive) return;
    if (force && provider.shouldTriggerFileCompletion?.(state.lines, state.cursorLine, state.cursorColumn) === false)
      return;

    this.requestId += 1;
    const id = this.requestId;
    this.abort?.abort();
    this.abort = undefined;
    if (this.debounce) clearTimeout(this.debounce);

    const beforeCursor = state.lines[state.cursorLine]?.slice(0, state.cursorColumn) ?? "";
    const shouldDebounce =
      !explicit && !force && this.triggerCharacters.some((character) => beforeCursor.includes(character));
    if (shouldDebounce) {
      this.debounce = setTimeout(() => {
        this.debounce = undefined;
        void this.performRequest(id, force, explicit);
      }, ATTACHMENT_DEBOUNCE_MS);
    } else {
      void this.performRequest(id, force, explicit);
    }
  }

  private async performRequest(id: number, force: boolean, explicit: boolean): Promise<void> {
    const provider = this.provider;
    if (!provider || id !== this.requestId) return;
    const state = this.options.getState();
    const snapshot = `${state.cursorLine}\0${state.cursorColumn}\0${state.lines.join("\n")}`;
    const controller = new AbortController();
    this.abort = controller;

    try {
      const suggestions = await provider.getSuggestions(state.lines, state.cursorLine, state.cursorColumn, {
        signal: controller.signal,
        force,
      });
      const current = this.options.getState();
      const currentSnapshot = `${current.cursorLine}\0${current.cursorColumn}\0${current.lines.join("\n")}`;
      if (controller.signal.aborted || id !== this.requestId || snapshot !== currentSnapshot) return;
      this.abort = undefined;
      if (!suggestions?.items.length) {
        this.cancel();
        return;
      }
      if (force && explicit && suggestions.items.length === 1) {
        this.prefix = suggestions.prefix;
        this.apply(suggestions.items[0]);
        return;
      }
      this.prefix = suggestions.prefix;
      this.mode = force ? "force" : "regular";
      this.list = new SelectList(
        suggestions.items,
        this.maxVisible,
        this.options.theme.selectList as SelectListTheme,
        suggestions.prefix.startsWith("/") ? { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 } : undefined,
      );
      const best = suggestions.items.findIndex((item) => item.value === suggestions.prefix);
      const prefix =
        best >= 0 ? best : suggestions.items.findIndex((item) => item.value.startsWith(suggestions.prefix));
      if (prefix >= 0) this.list.setSelectedIndex(prefix);
      this.options.tui.requestRender();
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) this.cancel();
    }
  }

  private apply(item: AutocompleteItem): void {
    const provider = this.provider;
    if (!provider) return;
    const state = this.options.getState();
    const result = provider.applyCompletion(state.lines, state.cursorLine, state.cursorColumn, item, this.prefix);
    this.cancel();
    this.options.applyState(result.lines, result.cursorLine, result.cursorCol);
  }
}
