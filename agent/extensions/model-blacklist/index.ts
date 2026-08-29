import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installModelBlacklist } from "./filter.js";

export default function () {
  // Keep Pi's built-in /model command, autocomplete, and selector UI. They all
  // read this snapshot, so filtering it avoids a conflicting extension command.
  installModelBlacklist(ModelRuntime.prototype);
}
