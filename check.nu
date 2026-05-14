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
