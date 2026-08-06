export def repo-root [] {
  (($env.FILE_PWD? | default $env.PWD) | path dirname)
}

export def active-pi-version [] {
  ^pi --version o+e>| str trim
}

export def pi-typecheck-package-path [repo: string] {
  $repo | path join "bun" "typecheck" "node_modules" "@earendil-works" "pi-coding-agent" "package.json"
}

export def say [msg: string] {
  print $"(ansi cyan)==> ($msg)(ansi reset)"
}
