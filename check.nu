#!/usr/bin/env nu

# Format/lint and type-check the TypeScript in this repo.
# Run from anywhere with:
#   ./check.nu

def main [] {
  let repo = ($env.FILE_PWD? | default $env.PWD)
  let npm_dir = ($repo | path join "npm")
  let typecheck_dir = ($npm_dir | path join "typecheck" "node_modules")
  let biome = ($npm_dir | path join "node_modules" ".bin" "biome")
  let tsgo = ($npm_dir | path join "node_modules" ".bin" "tsgo")

  if not ($biome | path exists) {
    error make {msg: $"Missing Biome binary: ($biome). Run ./install.nu first."}
  }

  if not ($tsgo | path exists) {
    error make {msg: $"Missing tsgo binary: ($tsgo). Run ./install.nu first."}
  }

  let typecheck_pi_package = ($typecheck_dir | path join "@earendil-works" "pi-coding-agent" "package.json")
  let typecheck_pi_types = ($typecheck_dir | path join "@earendil-works" "pi-coding-agent" "dist" "index.d.ts")
  let typecheck_tui_types = ($typecheck_dir | path join "@earendil-works" "pi-coding-agent" "node_modules" "@earendil-works" "pi-tui" "dist" "index.d.ts")

  for type_file in [$typecheck_pi_types $typecheck_tui_types] {
    if not ($type_file | path exists) {
      error make {msg: $"Missing Pi type declarations: ($type_file). Run ./install.nu first."}
    }
  }

  let active_pi_version = (^pi --version o+e>| str trim)
  let typecheck_pi_version = (open $typecheck_pi_package | get version)
  if $active_pi_version != $typecheck_pi_version {
    error make {msg: $"Active pi version (($active_pi_version)) does not match installed type-check package version (($typecheck_pi_version)). Run ./install.nu to synchronize it."}
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
