# Pi Global Prompt History Extension Plan

## Goal

Add persistent, global up-arrow prompt history across fresh pi sessions using a pi extension, without modifying pi core.

The intended behavior:

- Submitted prompts are saved to a user-level history file.
- New pi sessions preload that history into the editor.
- Existing pi editor behavior remains intact: up/down navigation, multiline editing, autocomplete, app shortcuts, etc.
- Session-specific history still works normally.

## Preferred Implementation

Use a custom editor extension based on `CustomEditor`.

Pi's interactive mode calls `this.editor.addToHistory?.(text)` whenever user input is submitted or queued. The built-in editor already implements history navigation internally. By subclassing `CustomEditor`, we can hook `addToHistory(text)` while preserving normal editor behavior.

High-level shape:

```ts
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

class GlobalHistoryEditor extends CustomEditor {
  addToHistory(text: string): void {
    super.addToHistory(text);
    // also persist to disk when enabled
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new GlobalHistoryEditor(tui, theme, keybindings)
    );
  });
}
```

## Storage

Use a global file under the pi agent config directory, for example:

```text
~/.pi/agent/prompt-history.json
```

Suggested format:

```json
{
  "version": 1,
  "entries": [
    "latest prompt",
    "older prompt"
  ]
}
```

Keep newest-first to match pi editor internals, where `history[0]` is the most recent entry.

Recommended limits:

- Default max entries: 500 or 1000.
- Ignore blank entries.
- Avoid consecutive duplicates.
- Optionally de-duplicate globally by moving repeat prompts to the front.

## Initialization Flow

1. On `session_start`, load persisted entries from disk.
2. Install the custom editor with `ctx.ui.setEditorComponent(...)`.
3. Inside the editor constructor, seed built-in history by calling `super.addToHistory(...)` for persisted entries.
   - Because `super.addToHistory()` unshifts entries, seed from oldest to newest so final order remains newest-first.
4. Do not persist during initial seeding.
5. Enable persistence after initialization.

## Important Startup Caveat

Pi also repopulates editor history from resumed session messages by calling `addToHistory()` during initial render.

If we persist immediately, simply opening/resuming an old session may import that whole session into global history.

Mitigation options:

### Option A: Delay writes briefly

After creating the custom editor, set a flag like `persistEnabled = false`, then enable it with `setTimeout(() => persistEnabled = true, 0)` or a slightly longer delay.

Pros:
- Simple.
- Likely sufficient because session rendering happens immediately after `session_start`.

Cons:
- Timing-based.

### Option B: Persist only from the `input` event

Use the editor only to preload history, but persist new prompts via `pi.on("input", ...)`.

Pros:
- Avoids accidentally persisting history populated during render.
- Captures real user input before agent processing.

Cons:
- Need to also consider bash commands (`!`, `!!`) and queued messages. Input events likely cover normal prompts, but built-in commands and bash handling may bypass it.

### Recommended

Start with Option A for simplicity, but implement it conservatively:

- `persistEnabled = false` while seeding.
- Enable after one macrotask with `setTimeout`.
- Add logging/notification only during development.

If this proves flaky, switch to a hybrid approach:

- editor subclass for preload/history navigation
- `input` event for persisted prompts
- explicit handling of bash/history cases if needed

## AddToHistory Override Details

The override should:

1. Trim input.
2. Return if empty.
3. Call `super.addToHistory(text)` first so normal behavior stays intact.
4. If persistence is enabled, update the persisted array.
5. Write file atomically if possible.

Pseudo-code:

```ts
addToHistory(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  super.addToHistory(trimmed);

  if (!this.persistEnabled) return;
  saveEntry(trimmed);
}
```

## Atomic Writes

Use Node built-ins:

- `node:fs`
- `node:path`
- `node:os`

Write to a temporary file first, then rename:

```text
prompt-history.json.tmp -> prompt-history.json
```

This reduces risk of corrupting history if pi exits mid-write.

## Concurrency

Multiple pi instances may run at once. A simple implementation can tolerate last-writer-wins, but better behavior is:

1. On each save, re-read the current file.
2. Merge the new entry into the latest on-disk entries.
3. Write back.

This avoids one pi process wiping out prompts saved by another process.

## Configuration

Initial version can hard-code defaults. Later, support a nearby JSON config:

```text
~/.pi/agent/global-history.json
```

Possible settings:

```json
{
  "enabled": true,
  "maxEntries": 1000,
  "historyFile": "~/.pi/agent/prompt-history.json",
  "dedupe": true
}
```

But avoid overbuilding at first.

## Placement

Place the extension at:

```text
~/.pi/agent/extensions/global-history.ts
```

or project-local for testing:

```text
.pi/extensions/global-history.ts
```

Because this pi installation is used across machines, prefer user-level placement only if the file is intentionally part of the synced/user config. Avoid relying on gitignored local files being available everywhere.

## Testing Plan

1. Start pi with the extension enabled.
2. Submit a unique prompt.
3. Quit pi.
4. Start a fresh pi session, not resumed.
5. Press Up; the unique prompt should appear.
6. Submit another prompt.
7. Verify both prompts are in `prompt-history.json` newest-first.
8. Resume an old session and confirm it does not unexpectedly bulk-import the whole session into global history.
9. Run two pi instances, submit prompts in both, and verify the file retains both after saves.

## Risks / Unknowns

- `Editor.history` is private, so the extension must seed via public `addToHistory()` rather than direct mutation.
- Timing around session render may affect whether resumed-session messages get persisted.
- There is no direct public API to distinguish `addToHistory()` caused by real new input vs history population from rendered sessions.
- A custom editor replaces the current editor component, so if another extension also calls `setEditorComponent()`, whichever runs last wins.

## Minimal MVP

- CustomEditor subclass.
- Load `~/.pi/agent/prompt-history.json`.
- Seed history from disk.
- Override `addToHistory` to save new prompts.
- Atomic write + max 1000 entries.
- Brief startup write suppression to avoid session render pollution.

## Future Enhancements

- `/history-clear` command.
- `/history-stats` command.
- Config file for max entries/path/deduping.
- Project-specific history mode.
- Import existing session prompts once intentionally.
- Better multi-instance file locking if needed.
