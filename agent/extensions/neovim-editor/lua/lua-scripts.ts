import { readFileSync } from "node:fs";

function loadLuaScript(name: string): string {
  return readFileSync(new URL(`./${name}.lua`, import.meta.url), "utf8");
}

export const SETUP_LUA = loadLuaScript("setup");
export const GET_STATE_LUA = loadLuaScript("get-state");
export const SET_STATE_LUA = loadLuaScript("set-state");
export const INSERT_TEXT_LUA = loadLuaScript("insert-text");
