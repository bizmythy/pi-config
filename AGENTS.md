My github usernames are @drew-dirac, @bizmythy

# TypeScript checks and formatting

This repo uses `biome` for TypeScript linting/formatting and `tsgo` for TypeScript type checking.

Run `./scripts/check.nu` after TypeScript changes. It runs Biome with unsafe fixes, then runs `tsgo` over the repo's TypeScript files.

# Guidance

- Use the `github` skill for GitHub operations.
- When a change needs to be made to a pi npm extension/package, you can use `patch-package` to apply it.
- This pi installation is used on multiple machines; do not depend on gitignored files or directories being present everywhere.

