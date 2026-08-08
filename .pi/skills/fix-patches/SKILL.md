---
name: fix-patches
description: Diagnose and repair this project's patch-package patches by evaluating only the patch-related steps from scripts/install.nu.
disable-model-invocation: true
---

# Fix Patches

Repair failing `patch-package` patches in this repository.

## Scope

Work **only** on the portion of `scripts/install.nu` that evaluates patch-package patches:

- The Bun workspace patches in `patches/`, applied to `bun/node_modules/`.
- The Pi-managed package patches in `agent/patches/`, applied to `agent/npm/node_modules/` by `apply-agent-npm-patches`.

Do not run the complete `scripts/install.nu`. Do not investigate or change authentication, secrets, profiles, Linear setup, Pi updates, package reconciliation, type declarations, or final package listing.

## Workflow

1. Read the patch-related portions of `scripts/install.nu`, plus `bun/package.json`, before acting. Treat those files as the source of truth for paths and commands.
2. Ensure the existing dependency trees needed by patch-package are present. Do not perform unrelated installation or update steps.
3. Evaluate the two patch sets directly, preserving the same working directories and patch directories used by the installer:

   ```bash
   cd bun
   bun ./node_modules/patch-package/index.js --patch-dir ../patches --error-on-fail
   ```

   ```bash
   cd agent/npm
   bun ../../bun/node_modules/.bin/patch-package --patch-dir ../patches --error-on-fail
   ```

4. For each failure, inspect the failing patch and the installed package version/content. Repair the patch so it preserves the intended project behavior against the currently installed package; do not merely delete a failing hunk or patch.
5. Keep changes limited to patch files unless a minimal patch-related manifest or installer correction is demonstrably required.
6. Re-run both direct patch-package commands after repairs, even if only one patch set changed.
7. Report which patch files changed and the results of both patch evaluations.

## Guardrails

- Never run all of `scripts/install.nu` from this skill.
- Do not run `pi update --extensions`; patch the package versions already installed.
- Do not upgrade, downgrade, add, or remove dependencies just to make a patch apply.
- Do not modify package files under `node_modules/` as the final fix; encode the repair in the corresponding patch file.
- Preserve the semantic intent of every existing patch. If that intent cannot be determined from the patch and repository context, stop and ask the user rather than discarding behavior.
