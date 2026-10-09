# team-up: code hosts (GitHub · GitLab · local)

Use `teamup open | mr | wait | comment | merge` first. Everything below is for preflight, for reading CI logs, or for when the helper reports `error`.
`teamup` = `node "<this folder>/scripts/teamup.js"`. `<B>` = base branch, `<H>` = step branch, `<iid>` / `<n>` = the `id` from `teamup mr`.
Always keep command output short: `| tail -n 80`, `--jq` (gh), or `| teamup pick <fields>` (glab).
`glab` flags change between versions. On "unknown flag", check `glab <cmd> --help` and adapt.

## 1. Merge preflight (Phase 0): can the tech lead merge alone?

Goal: find every repository rule that would force a human to merge, and ask the user about it in onboarding.

### GitHub
```bash
gh repo view --json viewerPermission,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
gh api "repos/{owner}/{repo}/rules/branches/<B>"            # rulesets (readable with read access)
gh api "repos/{owner}/{repo}/branches/<B>/protection"       # classic protection (404 = none, 403 = needs admin)
```
- `viewerPermission` must be WRITE, MAINTAIN or ADMIN.
- **Blocks autonomy:** required approving reviews > 0 (`pull_request` rule or `required_pull_request_reviews`), because you cannot approve your own PR.
  Options for the user: set the count to 0 for this repo, add a bot or second account as reviewer, or accept a human approval on every PR.
- Fine: required status checks (we wait for them); "require branch up to date" (`teamup merge` rebases); merge queue (`teamup merge` returns `wait`, then use `teamup wait --for merged`).
- Squash not allowed: run `teamup set merge=merge` (or `rebase`).

### GitLab
```bash
glab api projects/:fullpath | teamup pick merge_method squash_option only_allow_merge_if_pipeline_succeeds allow_merge_on_skipped_pipeline only_allow_merge_if_all_discussions_are_resolved merge_trains_enabled permissions
glab api projects/:fullpath/approvals | teamup pick approvals_before_merge merge_requests_author_approval merge_requests_disable_committers_approval
glab api projects/:fullpath/approval_rules | teamup pick name approvals_required
glab api "projects/:fullpath/protected_branches/<B>" | teamup pick merge_access_levels
```
(`glab api` has no `--jq`. `teamup pick` keeps only the named dot-paths, applied to each element of an array. A protected-branch 404 means the base branch is not protected.)
- Your access level (`permissions.project_access` or `group_access`): 30 is Developer, 40 is Maintainer. If the protected base branch only lets Maintainers merge (`access_level` 40) and you are 30, **every merge needs a human.**
- **Blocks autonomy:** any `approvals_required` > 0 while `merge_requests_author_approval` is false. `teamup merge` tries `glab mr approve`, which only works when author approval is allowed.
  Options for the user: allow author approval, set required approvals to 0, or accept a human approval per MR.
- `only_allow_merge_if_pipeline_succeeds`: fine, as long as MR pipelines do not stop on `when: manual` jobs without `allow_failure: true` (check `.gitlab-ci.yml`).
- `merge_method: ff` or `rebase_merge`: fine (`teamup merge` triggers `glab mr rebase` when needed).
- `squash_option: never`: run `teamup set merge=merge`. `always`: squash happens anyway.
- `only_allow_merge_if_all_discussions_are_resolved`: fine for our own plain comments. Human threads must be addressed and resolved (§2).
- `merge_trains_enabled`: `teamup merge` returns `wait`, then use `teamup wait --for merged`.

## 2. CI logs and human comments

### GitHub
```bash
gh pr checks <H>                                            # failing checks with their links
gh run view <run-id> --log-failed | tail -n 80              # run-id is in the check URL: /actions/runs/<run-id>/
gh pr view <H> --comments | tail -n 60                      # conversation comments
gh api "repos/{owner}/{repo}/pulls/<n>/comments" --jq '.[] | {path, line, body, user: .user.login}'   # inline review comments
```

### GitLab
```bash
glab api "projects/:fullpath/pipelines/<pipeline_id>/jobs?scope[]=failed" | teamup pick id name stage web_url
glab api "projects/:fullpath/jobs/<job-id>/trace" | tail -n 80
glab api "projects/:fullpath/merge_requests/<iid>/discussions?per_page=100" | teamup pick id notes.0.resolvable notes.0.resolved notes.0.author.username notes.0.body notes.0.position.new_path
#   ↑ act on entries where resolvable=true and resolved=false
glab api -X PUT "projects/:fullpath/merge_requests/<iid>/discussions/<discussion-id>" -f resolved=true   # after it was addressed
```
`pipeline_id` comes from `teamup mr`.

Comments from a **human** on the PR/MR are review input. Put them in the next review round as MUST items, unless they ask a question only the user can answer. Resolve a thread only after its point has been addressed, and say how in a reply or in the round's comment.

## 3. Manual fallbacks (only when `teamup` reports `error`)

| Action | GitHub | GitLab |
|---|---|---|
| create | `gh pr create --base <B> --head <H> --title "<t>" --body-file <f>` | `glab mr create --source-branch <H> --target-branch <B> --title "<t>" --description-file <f> --yes` |
| status | `gh pr view <H> --json state,mergeStateStatus,statusCheckRollup,headRefOid` | `glab mr view <H> -F json` |
| ready | `gh pr ready <H>` | `glab mr update <H> --ready` |
| comment | `gh pr comment <H> --body-file <f>` | `glab api -X POST "projects/:fullpath/merge_requests/<iid>/notes" -f "body=<text>"` |
| update / rebase | `gh pr update-branch <H> --rebase` | `glab mr rebase <H>` |
| approve | (not possible on your own PR) | `glab mr approve <H>` |
| wait for CI | `gh pr checks <H> --watch --fail-fast` | `glab ci status --branch <H> --wait` |
| merge | `gh pr merge <H> --squash --match-head-commit <sha>` | `glab mr merge <H> --squash --sha <sha> --auto-merge=false --yes` |

- On GitLab, `glab mr merge` without `--auto-merge=false` turns on **auto-merge** while a pipeline is running. In that case the MR merges later, so confirm with `teamup wait --for merged` before you continue.
- After a manual merge, sync like the helper does: `git checkout <B> && git pull --ff-only origin <B> && git branch -D <H>`, then `git push origin --delete <H>` (it may already be gone).
- **Local mode** (no remote): `git checkout <B> && git merge --squash <H> && git commit -m "<id>: <title>" && git branch -D <H>`. On conflicts, run `git merge --abort` (or `git reset --merge`) and send the step back as rework.
- **Never** use `--admin`, bypass rules, push to `<B>` directly, or merge with failing checks.

## 4. Setup reminders for the user
- GitLab CLI on Windows: `winget install glab.glab` (or `scoop install glab`, or `choco install glab`), then `glab auth login`. For self-managed GitLab: `glab auth login --hostname <host>`, and `teamup init --host gitlab` if the remote URL does not contain "gitlab".
- GitHub CLI: `gh auth login`.
- Authentication is always the user's job. Never type or store tokens yourself.
