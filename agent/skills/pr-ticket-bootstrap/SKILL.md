---
name: pr-ticket-bootstrap
description: "Ensure the current git branch has a linked Linear ticket and GitHub PR. Use when the user wants to bootstrap, prepare, or clean up branch metadata for review, including checking whether the branch already has a PR, extracting or creating a BWEB-123 ticket, creating a draft PR, filling the repository PR template, and optionally marking the PR ready for review."
---

# PR Ticket Bootstrap

Ensure the current branch has the expected GitHub and Linear bookkeeping before review.

## Workflow

1. Determine the current branch with `git branch --show-current`.
2. Check for an existing PR for that branch with `gh`.
3. Check for an existing Linear ticket tied to the branch.
4. Create any missing ticket or draft PR.
5. Present the PR URL and handle ready-for-review status.

## Branch and PR Discovery

- Use `gh pr list --head <branch> --json number,url,isDraft,title,body,headRefName --limit 1` to find a PR for the current branch.
- Treat the branch as already having a PR only when the returned PR actually matches the current branch.
- If a PR exists, capture its URL, number, title, draft state, and body for later decisions.

## Ticket Discovery

- Search for a `BWEB-\d+` key in this order:
  1. Current branch name
  2. Existing PR title
  3. Existing PR body
  4. Recent commit subjects on the branch if still needed
- When a `BWEB-\d+` key is found, verify it exists in Linear instead of assuming the text is valid.
- Use team `BWEB` when creating a new Linear issue.
- If no valid ticket exists, inspect the diff and create one concise issue in Linear with:
  - A title that matches the actual work on the branch
  - A short description grounded in the diff, not speculation
  - Enough context that the issue and PR title can share the same subject line

## Diff Review Before Creating Anything

- Inspect the branch diff before creating or renaming a ticket or PR.
- Prefer the repository default branch as the merge base when comparing changes.
- Use the diff to derive:
  - The user-facing summary of the work
  - The most accurate Linear issue title
  - The most accurate PR title
  - A brief testing note if the diff or commit history makes one clear

## PR Creation and Updates

- If no PR exists, create a draft PR.
- Title format must be `BWEB-123: Concise title`.
- If a ticket already exists, reuse its key in the PR title.
- If a ticket was just created, use the new key in the PR title immediately.
- Before creating the PR, find and read the repository PR description template if one exists. Check common locations such as:
  - `.github/pull_request_template.md`
  - `.github/PULL_REQUEST_TEMPLATE.md`
  - `.github/pull_request_template/*.md`
- Fill the template with content that reflects the actual diff. Keep it concise and factual.
- If no template exists, write a short PR body with:
  - What changed
  - Why it changed
  - How it was validated, if known
- If a PR already exists and its title is clearly stale or missing the ticket prefix, update it to the `BWEB-123: Title` format when the correct title is clear from the diff.
- If a PR already exists and its body is empty or obviously template-placeholder content, update it using the repository template.

## Ready for Review

- Do not mark a PR ready for review by default.
- If the user explicitly asked to open it for review in the initial request, mark the PR ready without asking again.
- Otherwise, after the PR exists, present the PR URL and ask whether they want it set ready for review.
- If the PR is already ready, say so instead of trying to change it.

## Output

- Always give the user the PR URL once one exists.
- State whether the Linear issue was found or created, and include its identifier.
- State whether the PR was found, created, or updated.
- End with the ready-for-review question unless the user already answered it in the original request.

## Guardrails

- Do not invent ticket titles or PR descriptions without checking the diff.
- Do not create multiple Linear issues for the same branch.
- Do not create a second PR when one already exists for the branch.
- Prefer updating stale PR metadata over creating duplicates.
- Keep titles short and specific; avoid generic titles like `Fix stuff` or `Updates`.
