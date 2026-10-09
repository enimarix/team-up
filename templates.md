# team-up templates

Adapt these to the project. If the project already has a `progress.md`, keep its structure and only add the missing sections (Roadmap with numbered steps, Done, Blocked, Follow-ups).

## progress.md

```markdown
# Progress: <project>

## Goal
<one paragraph: what the finished project does, and for whom>

## Definition of done
- [ ] <observable outcome>
- [ ] <observable outcome>

## Roadmap
<!-- small steps: one PR each, one concern, testable, leave the base branch green -->
- [ ] 001 — <title> — <one-line acceptance criterion>
- [ ] 002 — <title> — <…>

## Done
<!-- - [x] 000 — <title> — PR #<n> (<date>) — <one-line outcome> -->

## Blocked / needs human
<!-- - <step> — <what is needed> — see .team-up/BLOCKED.md -->

## Follow-ups (parked from reviews)
<!-- - <idea> (from step <id>) -->
```

## .team-up/lead-notes.md

```markdown
# Tech lead notes: <project>
> Durable memory of the team-up tech lead. It survives compaction and you trust it over recollection.
> Curated, not a log: revise and condense after every merge. Stay under ~300 lines.
Last revised: <date> after step <id>

## 0. Essentials (≤ 40 lines, the part re-injected after compaction)
- Mission: <one line>
- Host: github | gitlab | local · base: `…` · merge: squash · CI: <yes/no, what it runs>
- Commands: test `…` · build `…` · lint `…`
- Never alone: <autonomy limits from §6>
- Current focus: <roadmap phase / next 2–3 steps>
- Top gotchas: <the 3–5 things that bite most>

## 1. Mission
<what we build, for whom, and what "done" means; link the definition of done in progress.md>

## 2. Architecture map
| Area | Path | Responsibility / key facts |
|---|---|---|

## 3. Commands (verified)
- install: `…`
- build: `…`
- test: `…` (single test: `…`)
- lint / types: `…`
- run: `…`
- Host mode: github | gitlab | local · base branch: `…` · merge: squash

## 4. Conventions
<code style, naming, error handling, test layout, commit format, anything the developer must match>

## 5. Decisions (ADR-lite, newest first)
<!-- - <date> step <id>: <decision> because <reason>. [decided alone → user may review] -->

## 6. User answers & autonomy limits
<what the user said in onboarding or later; what we must never do alone>

## 7. Gotchas & lessons
<things that bit us and how to avoid them>

## 8. Developer notes
<recurring developer mistakes, to pre-empt in briefs>

## 9. History
<!-- - <id> <title> — PR #<n> — <date> — <one line> -->
```

## .team-up/task.md

```markdown
# Step <id>: <title>
Branch: `team-up/<id>-<slug>` · Base: `<base>` · Host: <mode>

## Goal
<1–3 sentences>

## Context
- Files: `<path>` (<why>), …
- Related decisions: lead-notes §5 <…>
- Commands: see lead-notes §3

## Acceptance criteria
- [ ] <testable criterion>
- [ ] <testable criterion>
- [ ] Tests cover the new behaviour (if the project has test infra)

## Out of scope
- <…>

## Tech lead notes
<pitfalls, hints, things the developer tends to miss (lead-notes §8)>

---
<!-- the developer appends "## Dev report: round N"; the tech lead appends "## Review round N: …" -->
```

## .team-up/BLOCKED.md

```markdown
# Blocked: <date>
Step: <id> <title> · PR: <url>

## What is needed
<one sentence>

## Why I can't decide / do it alone
<which Phase 2 case applies>

## What was tried
- <…>

## Question
<the exact question, with options A / B / C and your recommendation>

## To resume
Answer here or in chat, then say "resume team-up".
```
