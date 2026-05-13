#!/usr/bin/env nu

# Bootstrap this Pi configuration on a new machine.
#
# What this does:
# - installs the local npm workspace under ./npm
# - applies patch-package patches from ./patches via npm postinstall
# - updates/installs Pi-managed npm packages from agent/settings.json
# - verifies that Pi can resolve the configured packages
#
# Usage:
#   ./install.nu
#   ./install.nu --pull              # also git pull --ff-only --autostash first
#   ./install.nu --skip-pi-update    # do not run `pi update --extensions`
#   ./install.nu --skip-pi-list      # do not run final `pi list`

def command-exists [cmd: string] {
  not ((which $cmd) | is-empty)
}

def main [
  --pull(-p)             # Pull this repo before installing.
  --skip-pi-update       # Skip `pi update --extensions`.
  --skip-pi-list         # Skip final `pi list` verification.
] {
  let repo = ($env.FILE_PWD? | default $env.PWD)
  let npm_dir = ($repo | path join "npm")
  let cache_dir = ($repo | path join "npm-cache")

  print $"==> Pi config repo: ($repo)"

  if not (($repo | path join "agent" "settings.json") | path exists) {
    error make {msg: $"This does not look like the Pi config repo: missing ($repo | path join 'agent' 'settings.json')"}
  }

  if not ($npm_dir | path exists) {
    error make {msg: $"Missing npm workspace: ($npm_dir)"}
  }

  let required_commands = ["pi-npm", "pi"]
  for cmd in $required_commands {
    if not (command-exists $cmd) {
      error make {msg: $"Missing required command `($cmd)`. Install/start Pi first so its commands are available."}
    }
  }

  if $pull {
    if not (command-exists "git") {
      error make {msg: "Missing required command `git`."}
    }

    if not (($repo | path join ".git") | path exists) {
      error make {msg: $"Cannot --pull because this is not a git checkout: ($repo)"}
    }

    print "==> Updating git checkout"
    do { cd $repo; ^git pull --ff-only --autostash }
  }

  mkdir $cache_dir

  print "==> Installing local npm workspace and applying patches"
  with-env {npm_config_cache: $cache_dir} {
    do { cd $npm_dir; ^pi-npm install --include=dev }
  }

  let required_local_packages = [
    ($npm_dir | path join "node_modules" "pi-vim"),
    ($npm_dir | path join "node_modules" "pi-mcp-adapter"),
  ]

  for pkg in $required_local_packages {
    if not ($pkg | path exists) {
      error make {msg: $"Expected local package was not installed: ($pkg)"}
    }
  }

  if (($npm_dir | path join "node_modules" "pi-vim" "clipboard-policy.ts") | path exists) {
    print "==> Verified patched pi-vim files are present"
  } else {
    error make {msg: "pi-vim installed, but patched file clipboard-policy.ts is missing; patch-package did not apply as expected."}
  }

  if not $skip_pi_update {
    print "==> Updating/installing Pi-managed packages from settings"
    ^pi update --extensions
  }

  if not $skip_pi_list {
    print "==> Verifying Pi package resolution"
    ^pi list
  }

  print "==> Done. Restart Pi to load any newly installed or patched extensions."
}
