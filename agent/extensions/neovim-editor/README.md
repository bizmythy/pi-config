# Embedded Neovim prompt editor

Pi's prompt area is backed by a real `nvim --embed` process connected through a small MessagePack-RPC client. Neovim owns buffer editing, modes, mappings, registers, macros, search, command-line behavior, undo, and rendering. Pi still owns prompt submission, application actions, global prompt history, image insertion, and its autocomplete providers.

## Requirements and startup

- Neovim 0.10 or newer must be available as `nvim` on `PATH`.
- The editor intentionally loads the normal user Neovim configuration. It does not silently retry with `--clean`.
- One Neovim child is started per interactive Pi session and stopped during `/reload` or shutdown.
- The prompt uses a scratch buffer named `[Pi Prompt]` with Markdown filetype.

If startup fails, fix the reported Neovim/configuration error and run `/reload`. `nvim --embed` can be run separately when diagnosing startup configuration. The integration retries one unexpected process exit, preserving the latest mirrored prompt.

## Submitting and editing

- **Ctrl+Enter** submits the prompt to Pi.
- **Ctrl+Shift+Enter** queues a follow-up prompt while Pi is working.
- `:PiSubmit` submits from Neovim command-line mode.
- Ordinary Enter is passed to Neovim, so it inserts a line in Insert mode and executes native command-line prompts normally.
- Pi autocomplete remains available for `/`, slash-command arguments, `@`, extension trigger characters such as `#`, and Tab-forced path completion. Its list is rendered below the Neovim grid.
- Ctrl+Up and Ctrl+Down navigate persistent prompt history. Plain arrows remain Neovim input when autocomplete is closed.
- Clipboard image insertion uses Ctrl+Shift+V. Native Ctrl+V remains available for Visual Block mode.

## Key ownership

`agent/keybindings.json` is the only repository source of raw Pi-owned key values. The embedded editor intercepts a built-in action only when that action appears explicitly in this file. All other input is sent to Neovim.

To return a key to Neovim, remove or empty its Pi action in `agent/keybindings.json`, then run `/reload`. Do not add matching Neovim mappings in this extension. Extension shortcuts, including resume-after-interrupt, also read their value from the same file.

Autocomplete selection keys are contextual: they belong to Pi while Pi's completion list is visible and otherwise go to Neovim.

## History and programmatic edits

Prompt history remains in `~/.pi/agent/prompt-history.json`; `/history-clear` clears it. Pi's external editor, queued-message restoration, extension text insertion, paste-to-editor, and clipboard image paths update the native prompt buffer through Neovim APIs.

## Current limitations

- Mouse events are not forwarded because Pi's component API does not expose the prompt grid's absolute screen origin.
- Neovim optional external widgets and multigrid are disabled. Command line, messages, popup menus, floating windows, and plugin UI are composed by Neovim into its normal line grid.
- Opening another Neovim buffer is allowed and displayed, but Pi autocomplete pauses until `[Pi Prompt]` is current again. Pi submission always reads the dedicated prompt buffer.
- The grid height is about 30% of the terminal, clamped to 3–16 rows.
