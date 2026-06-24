#!/usr/bin/env nu

# Bootstrap this Pi configuration on a new machine.
#
# What this does:
# - installs the local npm workspace under ./npm
# - applies patch-package patches from ./patches via npm postinstall
# - applies patch-package patches from ./agent/patches to Pi-managed npm packages
# - updates/installs Pi-managed npm packages from agent/settings.json
# - verifies that the Linear CLI is authenticated
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

def linear-authenticated [] {
  let result = (do { ^linear auth whoami } | complete)
  $result.exit_code == 0
}

def apply-agent-npm-patches [npm_dir: string, agent_dir: string] {
  let patch_package = ($npm_dir | path join "node_modules" ".bin" "patch-package")
  let patch_dir = ($agent_dir | path join "patches")
  let patch_dir_relative = "../patches"
  let agent_npm_dir = ($agent_dir | path join "npm")

  if not ($patch_package | path exists) {
    error make {msg: $"Missing patch-package binary: ($patch_package)"}
  }

  if not ($patch_dir | path exists) {
    print $"==> No agent npm patches found: ($patch_dir)"
    return
  }

  print "==> Applying Pi-managed npm package patches"
  do { cd $agent_npm_dir; ^$patch_package --patch-dir $patch_dir_relative --error-on-fail }
}

def main [
  --pull(-p)             # Pull this repo before installing.
  --skip-pi-update       # Skip `pi update --extensions`.
  --skip-pi-list         # Skip final `pi list` verification.
] {
  let repo = ($env.FILE_PWD? | default $env.PWD)
  let npm_dir = ($repo | path join "npm")
  let agent_dir = ($repo | path join "agent")
  let cache_dir = ($repo | path join "npm-cache")

  print $"==> Pi config repo: ($repo)"

  if not (($repo | path join "agent" "settings.json") | path exists) {
    error make {msg: $"This does not look like the Pi config repo: missing ($repo | path join 'agent' 'settings.json')"}
  }

  if not ($npm_dir | path exists) {
    error make {msg: $"Missing npm workspace: ($npm_dir)"}
  }

  if not (($agent_dir | path join "package.json") | path exists) {
    error make {msg: $"Missing agent npm package manifest: ($agent_dir | path join 'package.json')"}
  }

  let required_commands = ["pi-npm", "pi", "linear"]
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

  if (linear-authenticated) {
    print "==> Linear CLI is authenticated"
  } else {
    if not (command-exists "op") {
      error make {msg: "Missing required command `op`; needed to fetch the Linear CLI credential from 1Password."}
    }

    print "==> Authenticating Linear CLI"
    let linear_credential = (^op --account PLU4HO2JCJF23NNQK2ERWIYIZI read "op://Employee/linear-cli-access/credential" | str trim)
    if ($linear_credential | is-empty) {
      error make {msg: "1Password returned an empty Linear CLI credential."}
    }

    $linear_credential | ^linear auth login --plaintext

    if not (linear-authenticated) {
      error make {msg: "Linear CLI authentication failed."}
    }
  }

  mkdir $cache_dir

  print "==> Installing local npm workspace and applying patches"
  with-env {npm_config_cache: $cache_dir} {
    do { cd $npm_dir; ^pi-npm install --include=dev }
  }

  print "==> Installing agent extension npm workspace"
  with-env {npm_config_cache: $cache_dir} {
    ^pi-npm --prefix $agent_dir install
  }

  let required_local_packages = [
    ($npm_dir | path join "node_modules" "pi-vim"),
    ($agent_dir | path join "node_modules" "qrcode"),
    ($agent_dir | path join "node_modules" "ws"),
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

  apply-agent-npm-patches $npm_dir $agent_dir

  if not $skip_pi_list {
    print "==> Verifying Pi package resolution"
    ^pi list
  }

  print "==> Done. Restart Pi to load any newly installed or patched extensions."
}
