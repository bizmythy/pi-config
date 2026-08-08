import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HISTORY_VERSION = 1;
const MAX_PERSISTED_ENTRIES = 1000;
const MAX_ACTIVE_ENTRIES = 100;

interface HistoryFile {
  version: number;
  entries: string[];
}

function normalizeEntry(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEntries(entries: unknown, limit = MAX_PERSISTED_ENTRIES): string[] {
  if (!Array.isArray(entries)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of entries) {
    if (typeof value !== "string") continue;
    const entry = normalizeEntry(value);
    if (!entry || seen.has(entry)) continue;
    result.push(entry);
    seen.add(entry);
    if (result.length >= limit) break;
  }
  return result;
}

export class PromptHistory {
  private entries: string[];
  private index = -1;
  private draft = "";
  private persistenceEnabled = false;

  constructor(private readonly file = path.join(os.homedir(), ".pi", "agent", "prompt-history.json")) {
    this.entries = this.read().slice(0, MAX_ACTIVE_ENTRIES);
  }

  enablePersistence(): void {
    this.persistenceEnabled = true;
  }

  add(text: string): void {
    const entry = normalizeEntry(text);
    if (!entry) return;
    this.entries = [entry, ...this.entries.filter((existing) => existing !== entry)].slice(0, MAX_ACTIVE_ENTRIES);
    this.resetNavigation();
    if (this.persistenceEnabled) this.saveEntry(entry);
  }

  navigate(direction: "previous" | "next", currentText: string): string | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.index === -1 && direction === "previous") this.draft = currentText;
    const nextIndex = direction === "previous" ? this.index + 1 : this.index - 1;
    if (nextIndex < -1 || nextIndex >= this.entries.length) return undefined;
    this.index = nextIndex;
    return this.index === -1 ? this.draft : this.entries[this.index];
  }

  resetNavigation(): void {
    this.index = -1;
    this.draft = "";
  }

  clear(): void {
    this.entries = [];
    this.resetNavigation();
    this.write([]);
  }

  private read(): string[] {
    try {
      if (!fs.existsSync(this.file)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<HistoryFile>;
      return normalizeEntries(parsed.entries);
    } catch {
      return [];
    }
  }

  private saveEntry(entry: string): void {
    try {
      const current = this.read();
      this.write([entry, ...current.filter((existing) => existing !== entry)]);
    } catch {
      // Prompt history must never prevent submission.
    }
  }

  private write(entries: string[]): void {
    const payload: HistoryFile = { version: HISTORY_VERSION, entries: normalizeEntries(entries) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.file);
  }
}
