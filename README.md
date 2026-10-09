# team-up

A [Claude Code](https://code.claude.com) skill that turns a session into a small, autonomous dev team:

- **one tech lead** (your main session): knows the project, plans small steps, reviews, merges, keeps `progress.md` and its own notes up to date;
- **one developer** (a subagent): implements a step and ships it as a GitHub PR or GitLab merge request.

They loop until the project is finished. The loop only stops early when a human is really needed.

```
            ┌───────────────────── tech lead ─────────────────────┐
 progress.md│ plan step → brief (.team-up/task.md)                 │
            │        │                                             │
            │        ▼                                             │
            │   developer: implement → commit → audit errors → fix │
            │              → commit → review code → fix → test     │
            │              → push → open PR/MR                     │
            │        │                                             │
            │        ▼                                             │
            │ review PR/MR ── changes needed ──► back to developer │
            │        │ approved                                    │
            │        ▼                                             │
            │ update progress.md → wait CI → merge → revise notes  │
            └──────────────── next small step ◄────────────────────┘
```

## Install

The skill must live at `~/.claude/skills/team-up`, because its hooks load the helper from there. `CLAUDE_CONFIG_DIR` is respected.

```bash
git clone https://github.com/enimarix/team-up ~/.claude/skills/team-up
```

On Windows PowerShell:

```powershell
git clone https://github.com/enimarix/team-up "$HOME\.claude\skills\team-up"
```

Update later with `git -C ~/.claude/skills/team-up pull`.

### Requirements
- Claude Code with skill-frontmatter hooks (a recent version)
- Node.js 18+ and git
- GitHub: [`gh`](https://cli.github.com), logged in (`gh auth login`)
- GitLab: [`glab`](https://gitlab.com/gitlab-org/cli), logged in (`glab auth login`); on Windows `winget install glab.glab`
- No remote? It runs in **local mode** and merges branches locally.

## Use

Open Claude Code in your project (ideally one with a `progress.md`) and say:

> let's team up on this project

The tech lead reads the project, writes down what it understood, and asks you only what it can't figure out. It also checks whether the repo's merge rules (required approvals, protected branches, manual pipeline jobs) would force a human into every merge. Then it plans small steps and starts the loop.

| Say | Effect |
|---|---|
| `let's team up` / `/team-up` | onboard, then start the loop |
| `pause team-up` | stop after the current action |
| `resume team-up` | continue where it left off (also after answering a blocker) |
| `team-up status` | where things stand |

Press **Esc** anytime to interrupt.

**Permissions:** an unattended loop must not stop at permission prompts. Run Claude Code in a mode that doesn't ask before every command (for example auto mode), on a repo you trust.

**Cost:** the loop runs until the roadmap is done. Expect a lot of tokens on big projects.

## What it does in your repo

| Path | |
|---|---|
| `progress.md` | Roadmap of numbered small steps, done list (with PR/MR links), blocked items, follow-ups. Created if missing; an existing one keeps its structure. Committed through the step PRs, never pushed straight to the base branch. |
| `.team-up/` | Loop state, the tech lead's notes (`lead-notes.md`), the current task brief, the archive of finished tasks, and `BLOCKED.md` when it needs you. Added to `.git/info/exclude`, so it is never committed. |
| `.claude/settings.local.json` | Gets `"autoCompactWindow": 600000`, so the tech lead's context is compacted at 600k tokens (needs a 1M-context model; otherwise the model limit applies). Also git-excluded. |

## How it stays on track

- **Never-ending loop:** while the loop is running, a `Stop` hook won't let the tech lead end its turn. It can only stop by marking the project done, or by writing `BLOCKED.md` for a human. If it stalls 3 times in a row without progress, the hook lets it stop (`TEAMUP_MAX_NUDGES` changes the limit).
- **Memory across compaction:** the tech lead writes everything important to `.team-up/lead-notes.md` as it goes. After a compaction, a `SessionStart` hook re-injects the loop state and the notes' *Essentials* section, and tells it to re-read the files.
- **Quality gates:** the developer runs commit → audit for errors (fix only important ones) → commit → code review (fix only what's worth it) → tests → PR/MR. The tech lead reviews against the acceptance criteria. Only blocking findings go back to the developer; after 3 rounds it fixes, splits or escalates.
- **Merging without you:** the helper (`scripts/teamup.js merge`) takes the PR/MR out of draft, waits for CI, rebases when the branch is behind, and merges exactly the reviewed commit. It confirms the merge really happened (GitLab auto-merge, merge trains, merge queues), then syncs the base branch and deletes the step branch.
- **Stops only for real blockers:** missing credentials, production deploys or other irreversible actions, big product decisions, repository rules that require a human, a broken environment. Before stopping, it checks whether another step can go ahead first.

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | Tech lead playbook and hook registration |
| `developer.md` | Developer playbook (the ship pipeline) |
| `templates.md` | Templates for `progress.md`, lead notes, task brief, `BLOCKED.md` |
| `hosts.md` | GitHub/GitLab merge preflight, CI-log commands, manual fallbacks |
| `scripts/teamup.js` | Loop state, Stop/compaction hooks, PR/MR helper (`open`, `mr`, `wait`, `comment`, `merge`, `pick`) |
