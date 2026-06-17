---
description: "Ensure the current git branch has a linked Linear ticket and GitHub PR."
argument-hint: "[--open|-o]"
---

# PR Ticket Bootstrap

Ensure the current branch has the expected GitHub and Linear bookkeeping before review.

Additional user details: $ARGUMENTS

## Workflow

1. Determine the current branch with `git branch --show-current`.
2. Inspect the branch diff before creating or renaming anything. Prefer the repository default branch as the merge base.
3. Find any existing PR and Linear ticket for the branch.
4. Create or update only the missing/stale bookkeeping.
5. Present the PR URL and handle draft/open status.

## Branch and PR Discovery

- Find an existing PR with `gh pr list --head <branch> --json number,url,isDraft,title,body,headRefName --limit 1`.
- Treat the branch as already having a PR only when the returned PR actually matches the current branch.

## Ticket Discovery

- Search for a `BWEB-\d+` key in this order:
  1. Current branch name
  2. Existing PR title
  3. Existing PR body
  4. Recent commit subjects on the branch if still needed
- When a `BWEB-\d+` key is found, verify it exists in Linear instead of assuming the text is valid.
- Use team `BWEB` when creating a new Linear issue.
- Set the Linear issue point estimate to `1` by default unless the user specifies a different point total.
- If no valid ticket exists, inspect the diff and create one concise issue in Linear with:
  - A title that matches the actual work on the branch
  - A short description grounded in the diff, not speculation
  - Enough context that the issue and PR title can share the same subject line

## Titles and Descriptions

- Use the diff to derive the Linear issue title, PR title, user-facing summary, and any testing notes.
- Title format must be `BWEB-123: Concise title`.
- Keep titles short and specific; avoid generic titles like `Fix stuff` or `Updates`.
- Descriptions should be concise, factual, grounded in the diff, and written as bulleted lists.
- Before creating or updating a PR body, read the repository PR description template if one exists. Check common locations such as:
  - `.github/pull_request_template.md`
  - `.github/PULL_REQUEST_TEMPLATE.md`
  - `.github/pull_request_template/*.md`
- If the template has a `## Testing` section, describe tests added or updated in code; do not list commands you ran.
- If `## Testing` or `## Screenshots/Videos` is not applicable, omit the section entirely instead of writing `N/A`.

## Creation and Updates

- If no valid ticket exists, create one concise Linear issue.
- If no PR exists, create a draft PR using the ticket key in the title unless the user passed `--open` or `-o` in the prompt arguments.
- If the user passed `--open` or `-o` and no PR exists, create the PR as ready for review instead of draft.
- If a PR already exists and its title is clearly stale or missing the ticket prefix, update it when the correct title is clear from the diff.
- If a PR already exists and its body is empty or obviously template-placeholder content, update it using the repository template.

## Draft/Open Status

- Treat PRs as draft by default.
- Only create or mark a PR ready for review when the prompt arguments include `--open` or `-o`.
- If `--open` or `-o` is present and the PR already exists as a draft, mark it ready for review without asking again.
- If `--open` or `-o` is absent and the PR already exists as ready for review, leave it ready and say so instead of trying to change it back to draft.
- Do not ask whether to set the PR ready for review.

## Output

- Always give the user the PR URL once one exists.
- State whether the Linear issue was found or created, and include its identifier.
- State whether the PR was found, created, or updated.
- State whether the PR is draft or ready for review.

## Guardrails

- Do not invent ticket titles or PR descriptions without checking the diff.
- Do not create multiple Linear issues for the same branch.
- Do not create a second PR when one already exists for the branch.
- Prefer updating stale PR metadata over creating duplicates.
