import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PromptHistory } from "../../extensions/neovim-editor/history";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function historyFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-neovim-history-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "prompt-history.json");
}

describe("embedded Neovim prompt history", () => {
  test("persists de-duplicated newest-first entries and restores a draft", () => {
    const file = historyFile();
    const history = new PromptHistory(file);
    history.enablePersistence();
    history.add(" first ");
    history.add("second");
    history.add("first");

    expect(JSON.parse(fs.readFileSync(file, "utf8")).entries).toEqual(["first", "second"]);
    expect(history.navigate("previous", "draft text")).toBe("first");
    expect(history.navigate("previous", "first")).toBe("second");
    expect(history.navigate("next", "second")).toBe("first");
    expect(history.navigate("next", "first")).toBe("draft text");
  });

  test("tolerates malformed data and atomically replaces it on the next save", () => {
    const file = historyFile();
    fs.writeFileSync(file, "not json");
    const history = new PromptHistory(file);
    expect(history.navigate("previous", "draft")).toBeUndefined();

    history.enablePersistence();
    history.add("usable");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1, entries: ["usable"] });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["prompt-history.json"]);
  });

  test("does not persist session replay before persistence is enabled", () => {
    const file = historyFile();
    const history = new PromptHistory(file);
    history.add("replayed session message");
    expect(fs.existsSync(file)).toBe(false);
    expect(history.navigate("previous", "")).toBe("replayed session message");
  });
});
