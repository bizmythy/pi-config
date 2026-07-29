#!/usr/bin/env nu

# Bootstrap this Pi configuration on a new machine.
#
# What this does:
# - installs the local npm workspace under ./npm
# - applies patch-package patches from ./patches via npm postinstall
# - applies patch-package patches from ./agent/patches to Pi-managed npm packages
# - updates/installs Pi-managed npm packages from agent/settings.json
# - creates isolated work/personal Pi login profiles (existing logins become personal; work uses Azure)
# - generates local secret files from the committed 1Password templates
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

def setup-auth-profiles [agent_dir: string] {
  let auth_file = ($agent_dir | path join "auth.json")
  let backup_file = ($agent_dir | path join "auth.pre-profiles.json")
  let profiles_dir = ($agent_dir | path join "auth-profiles")
  let work_profile = ($profiles_dir | path join "work.json")
  let personal_profile = ($profiles_dir | path join "personal.json")
  let profile_config = ($agent_dir | path join "auth-profiles.json")

  print "==> Configuring independent work/personal Pi login profiles"
  mkdir $profiles_dir

  if not ($work_profile | path exists) {
    "{}\n" | save $work_profile
  }

  if not ($personal_profile | path exists) {
    if ($auth_file | path exists) {
      if not ($backup_file | path exists) {
        cp $auth_file $backup_file
      }
      cp $auth_file $personal_profile
      print $"    Imported existing Pi logins into ($personal_profile)"
    } else {
      "{}\n" | save $personal_profile
    }
  }

  if not ($profile_config | path exists) {
    {activeProfile: "work"} | to json --indent 2 | save $profile_config
  }

  ^chmod 700 $profiles_dir
  ^chmod 600 $work_profile $personal_profile $profile_config
  if ($backup_file | path exists) {
    ^chmod 600 $backup_file
  }
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

def npm-package-name [source: string] {
  let spec = ($source | str replace --regex '^npm:' '')
  let parts = ($spec | split row "@")

  if ($spec | str starts-with "@") {
    $"@($parts | get 1)"
  } else {
    $parts | first
  }
}

def ensure-agent-npm-packages [agent_dir: string] {
  let settings_file = ($agent_dir | path join "settings.json")
  let agent_npm_dir = ($agent_dir | path join "npm")
  let configured_packages = (open $settings_file | get -o packages | default [])

  print "==> Ensuring all configured Pi-managed npm packages are installed"
  for configured_package in $configured_packages {
    let source = if (($configured_package | describe) == "string") {
      $configured_package
    } else {
      $configured_package.source
    }

    if not ($source | str starts-with "npm:") {
      continue
    }

    let package_name = (npm-package-name $source)
    let package_json = ([$agent_npm_dir "node_modules" ...($package_name | split row "/") "package.json"] | path join)

    if not ($package_json | path exists) {
      print $"    Installing missing configured package ($source)"
      ^pi install $source
    }

    if not ($package_json | path exists) {
      error make {msg: $"Pi reported that ($source) was installed, but ($package_json) is still missing."}
    }
  }
}

def main [
  --pull(-p)             # Pull this repo before installing.
  --skip-pi-update       # Skip `pi update --extensions`.
  --skip-pi-list         # Skip final `pi list` verification.
] {
  let repo = ($env.FILE_PWD? | default $env.PWD)
  let npm_dir = ($repo | path join "npm")
  let typecheck_dir = ($npm_dir | path join "typecheck")
  let agent_dir = ($repo | path join "agent")
  let cache_dir = ($repo | path join "npm-cache")
  let secrets_dir = ($repo | path join "secrets")
  let personal_secrets = ($secrets_dir | path join "personal.json")
  let work_secrets = ($secrets_dir | path join "work.json")
  # Account UUIDs reported by `op account list --format=json`.
  let personal_account = "XH4EFF5WXBGXJOIXZG4PLGILIE"
  let work_account = "MHSAC4QES5HYTEKXKZQN27PFXQ"

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

  let required_commands = ["pi-npm", "pi", "linear", "op"]
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

  setup-auth-profiles $agent_dir

  print "==> Generating local secret files"
  ^op --account $personal_account inject --in-file ($secrets_dir | path join "personal.json.tpl") --out-file $personal_secrets --force
  ^op --account $work_account inject --in-file ($secrets_dir | path join "work.json.tpl") --out-file $work_secrets --force

  if (linear-authenticated) {
    print "==> Linear CLI is authenticated"
  } else {
    print "==> Authenticating Linear CLI"
    let linear_credential = (open $work_secrets | get linear.credential | into string | str trim)
    if ($linear_credential | is-empty) {
      error make {msg: "The generated work secret file contains an empty Linear CLI credential."}
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

  # Keep these separate from the locked workspace. Asking npm to replace a
  # locked package in-place triggers an npm 11 Arborist rollback bug on reruns.
  let active_pi_version = (^pi --version o+e>| str trim)
  print $"==> Installing type declarations for Pi ($active_pi_version)"
  with-env {npm_config_cache: $cache_dir} {
    ^pi-npm --prefix $typecheck_dir install --no-save $"@earendil-works/pi-coding-agent@($active_pi_version)"
  }

  let typecheck_pi_package = ($typecheck_dir | path join "node_modules" "@earendil-works" "pi-coding-agent" "package.json")
  if not ($typecheck_pi_package | path exists) {
    error make {msg: $"Pi type-check package was not installed: ($typecheck_pi_package)"}
  }
  let typecheck_pi_version = (open $typecheck_pi_package | get version)
  if $typecheck_pi_version != $active_pi_version {
    error make {msg: $"Installed Pi type-check package version (($typecheck_pi_version)) does not match active Pi (($active_pi_version))."}
  }

  print "==> Installing agent extension npm workspace"
  with-env {npm_config_cache: $cache_dir} {
    ^pi-npm --prefix $agent_dir install
  }

  let required_local_packages = [
    ($npm_dir | path join "node_modules" "pi-vim"),
    ($agent_dir | path join "node_modules" "qrcode"),
    ($agent_dir | path join "node_modules" "remark-parse"),
    ($agent_dir | path join "node_modules" "unified"),
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

  # `pi update --extensions` deliberately skips pinned npm specs, including
  # packages which have never been installed. Reconcile missing packages first
  # so every configured package exists before optional updates and patching.
  ensure-agent-npm-packages $agent_dir

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
