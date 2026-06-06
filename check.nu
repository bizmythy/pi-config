#!/usr/bin/env nu

# Format/lint and type-check the TypeScript in this repo.
# Run from anywhere with:
#   ./check.nu

def main [] {
  let repo = ($env.FILE_PWD? | default $env.PWD)
  let npm_dir = ($repo | path join "npm")
  let biome = ($npm_dir | path join "node_modules" ".bin" "biome")
  let tsgo = ($npm_dir | path join "node_modules" ".bin" "tsgo")

  if not ($biome | path exists) {
    error make {msg: $"Missing Biome binary: ($biome). Run ./install.nu first."}
  }

  if not ($tsgo | path exists) {
    error make {msg: $"Missing tsgo binary: ($tsgo). Run ./install.nu first."}
  }

  let pi_bin = (^which pi | str trim)
  let pi_root = ($pi_bin | path dirname | path dirname)
  let active_pi_package = ($pi_root | path join "lib" "node_modules" "@earendil-works" "pi-coding-agent" "package.json")
  let active_pi_types = ($pi_root | path join "lib" "node_modules" "@earendil-works" "pi-coding-agent" "dist" "index.d.ts")
  let active_tui_types = ($pi_root | path join "lib" "node_modules" "@earendil-works" "pi-coding-agent" "node_modules" "@earendil-works" "pi-tui" "dist" "index.d.ts")

  if not ($active_pi_package | path exists) {
    error make {msg: $"Could not find active pi package metadata next to ($pi_bin): ($active_pi_package)"}
  }

  let active_pi_version = (^pi --version o+e>| str trim)
  let typecheck_pi_version = (open $active_pi_package | get version)
  if $active_pi_version != $typecheck_pi_version {
    error make {msg: $"Active pi version (($active_pi_version)) does not match type-check package version (($typecheck_pi_version)) at ($active_pi_package)."}
  }

  let tsconfig = (open ($repo | path join "tsconfig.json"))
  let configured_pi_types = ($tsconfig.compilerOptions.paths."@earendil-works/pi-coding-agent" | first)
  let configured_tui_types = ($tsconfig.compilerOptions.paths."@earendil-works/pi-tui" | first)
  if $configured_pi_types != $active_pi_types {
    error make {msg: $"tsconfig maps @earendil-works/pi-coding-agent to ($configured_pi_types), but active pi exposes ($active_pi_types)."}
  }
  if $configured_tui_types != $active_tui_types {
    error make {msg: $"tsconfig maps @earendil-works/pi-tui to ($configured_tui_types), but active pi exposes ($active_tui_types)."}
  }

  let ts_files = (do { cd $repo; glob "**/*.ts" --exclude ["npm/**" "npm-cache/**" ".git/**" ".pi/**" "agent/git/**" "agent/sessions/**"] | sort })

  if ($ts_files | is-empty) {
    print "==> No TypeScript files found."
    return
  }

  print "==> Running Biome with unsafe fixes"
  do { cd $repo; ^$biome check --write --unsafe ...$ts_files }

  print "==> Running tsgo"
  do { cd $repo; ^$tsgo -p ($repo | path join "tsconfig.json") }
}
