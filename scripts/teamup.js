#!/usr/bin/env node
// team-up helper: loop state, the Stop / SessionStart(compact) hooks, and host-agnostic PR/MR operations.
//
// Loop state
//   init [--base <branch>] [--host github|gitlab|local] [--window <tokens>|0]   set up .team-up/ in the git root
//   set key=value ...                       update .team-up/state.json (refreshes the heartbeat)
//   status                                  print state
//   recall                                  print the tech lead's memory digest (SessionStart compact hook)
//   stop-hook                               Stop hook (reads hook JSON on stdin)
//
// Code host — GitHub (gh), GitLab (glab) or local git; <branch> defaults to state.branch
//   open [branch] --title <t> --body-file <f>        create the PR/MR (or report the existing one)
//   mr [branch]                                      normalized PR/MR status as JSON
//   wait [branch] [--for ci|merged] [--timeout s]    poll until CI finishes / the PR is merged (default 540s)
//   comment [branch] <file>                          post a file as a PR/MR comment
//   merge [branch] [--strategy squash|merge|rebase] [--message m] [--timeout s]
//                                                    make it ready, wait for CI, rebase if behind, merge,
//                                                    verify, sync the base branch, delete the step branch
//
// `merge` prints {"result": "merged" | "wait" | "rework" | "human" | "error", "message", "mr"} and
// exits 0 only when merged.
//
//   pick <path> ...                                  filter JSON on stdin to the given dot-paths (no jq needed)
//
// The Stop hook keeps the tech lead's session going while state.status == "running".
// It lets the session stop when status is anything else, when waiting=true (a background
// developer is running), or after MAX_NUDGES blocks without any state change (then marks "stalled").
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');

const DIR = '.team-up';
const MAX_NUDGES = Number(process.env.TEAMUP_MAX_NUDGES) || 3;
const DEFAULT_WINDOW = 600000;
const DEFAULT_WAIT = 540;     // a whole `wait`/`merge` call fits inside a 10-minute Bash tool call
const NO_CI_GRACE = 45;       // a pipeline may take a few seconds to appear after a push
const HOOK_BUDGET = 9500;     // Claude Code replaces hook output over 10,000 chars with a file path
const SCRIPT = __filename.replace(/\\/g, '/');

function now() { return new Date().toISOString(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function readText(file, max) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return max && s.length > max ? s.slice(0, max) + '\n…(truncated — read the file for the rest)' : s;
  } catch { return null; }
}

// Hooks get a short timeout (stdin may never close); `pick` waits for the whole pipe.
function readStdin(timeoutMs = 1500) {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve({});
    let data = '';
    const done = () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } };
    const timer = timeoutMs ? setTimeout(done, timeoutMs) : null;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve({}); });
  });
}

function git(cmd, cwd) {
  try {
    return execSync(`git ${cmd}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return null; }
}

// Run an executable without a shell (no quoting issues); never throws.
function run(bin, args, cwd) {
  try {
    const out = execFileSync(bin, args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    const stdout = String(e.stdout || '').trim();
    return { ok: false, out: stdout, err: String(e.stderr || '').trim() || stdout || String(e.message || '') };
  }
}

// Walk up from each candidate dir until a .team-up/state.json is found.
function findRoot(candidates) {
  for (const start of candidates.filter(Boolean)) {
    let dir = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(dir, DIR, 'state.json'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

const statePath = root => path.join(root, DIR, 'state.json');
const guardPath = root => path.join(root, DIR, '.stop-guard.json');

function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function print(obj) { console.log(JSON.stringify(obj, null, 2)); }

function fail(msg) { console.error(`team-up: ${msg}`); process.exit(1); }

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '') return null;
  if (/^-?(0|[1-9]\d{0,14})$/.test(v)) return Number(v); // keeps "001" or long SHAs as strings
  return v;
}

// Split argv into positionals and --flags (a flag followed by another flag or nothing is boolean).
function parseArgs(args) {
  const pos = [], flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
      else { flags[a.slice(2)] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

function ensureLines(file, lines) {
  const existing = readText(file) || '';
  const have = new Set(existing.split(/\r?\n/).map(l => l.trim()));
  const missing = lines.filter(l => !have.has(l));
  if (!missing.length) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, sep + missing.join('\n') + '\n');
  return missing;
}

function detectHost(remote) {
  if (!remote) return 'local';
  if (/github\.com/i.test(remote)) return 'github';
  if (/gitlab/i.test(remote)) return 'gitlab';
  return 'other';
}

// ───────────────────────────── loop state ─────────────────────────────

function cmdInit(args) {
  const root = git('rev-parse --show-toplevel', process.cwd());
  if (!root) fail('not inside a git repository (run `git init` first).');

  const { flags } = parseArgs(args);
  const window = flags.window !== undefined ? Number(flags.window) : DEFAULT_WINDOW;

  const file = statePath(root);
  const existing = readJson(file);
  const remote = git('remote get-url origin', root) || '';
  const originHead = git('symbolic-ref --short refs/remotes/origin/HEAD', root);
  // A re-run keeps earlier choices (e.g. --host gitlab for a self-managed instance) unless overridden.
  const host = flags.host || (existing && existing.host) || detectHost(remote);
  const base = flags.base || (existing && existing.base)
    || (originHead ? originHead.replace(/^origin\//, '') : git('branch --show-current', root) || 'main');

  fs.mkdirSync(path.join(root, DIR, 'archive'), { recursive: true });

  // Keep loop files and local settings out of every commit without touching .gitignore.
  const excludeRel = git('rev-parse --git-path info/exclude', root);
  const excludeFile = path.resolve(root, excludeRel || '.git/info/exclude');
  const excluded = ensureLines(excludeFile, [`${DIR}/`, '.claude/settings.local.json']);

  // Compact the tech lead's context at `window` tokens (project-local setting).
  let windowMsg = 'autoCompactWindow: unchanged';
  if (window > 0) {
    const settingsFile = path.join(root, '.claude', 'settings.local.json');
    const raw = readText(settingsFile);
    const settings = raw === null ? {} : readJson(settingsFile);
    if (settings === null) {
      windowMsg = `autoCompactWindow: NOT set — ${settingsFile} is not valid JSON, fix it by hand`;
    } else {
      settings.autoCompactWindow = window;
      writeJson(settingsFile, settings);
      windowMsg = `autoCompactWindow: ${window} (in .claude/settings.local.json)`;
    }
  }

  const state = existing || {
    status: 'paused', phase: 'onboard', step: null, branch: null, pr: null,
    round: 0, waiting: false, merge: 'squash', started: now(),
  };
  Object.assign(state, { base, host, heartbeat: now() });
  writeJson(file, state);

  const cli = host === 'github' ? 'gh' : host === 'gitlab' ? 'glab' : null;
  const cliMsg = !cli ? '' : run(cli, ['--version']).ok ? `${cli}: installed` : `${cli}: NOT INSTALLED`;
  console.log([
    `team-up initialised in ${root}`,
    `host: ${host}${remote ? ` (${remote})` : ''} · base branch: ${base}${cliMsg ? ` · ${cliMsg}` : ''}`,
    host === 'other' ? 'host not recognised — re-run init with --host gitlab (self-managed GitLab) or --host github' : null,
    excluded.length ? `added to ${excludeFile}: ${excluded.join(', ')}` : 'git exclude: already set',
    windowMsg,
    `state: ${file}`,
  ].filter(Boolean).join('\n'));
}

function loadStateOrFail() {
  const root = findRoot([process.env.CLAUDE_PROJECT_DIR, process.cwd()]);
  if (!root) fail('no .team-up/state.json found — run `init` first.');
  return { root, state: readJson(statePath(root)) || {} };
}

function cmdSet(args) {
  const { root, state } = loadStateOrFail();
  const keys = new Set();
  for (const kv of args) {
    const i = kv.indexOf('=');
    if (i < 1) fail(`bad argument "${kv}" (expected key=value)`);
    keys.add(kv.slice(0, i));
    state[kv.slice(0, i)] = parseValue(kv.slice(i + 1));
  }
  // `waiting` only lasts until the tech lead's next state change, so a forgotten flag can't disarm the Stop hook.
  if (!keys.has('waiting')) state.waiting = false;
  state.heartbeat = now();
  writeJson(statePath(root), state);
  if (state.status === 'running') writeJson(guardPath(root), { heartbeat: state.heartbeat, blocks: 0 });
  console.log(JSON.stringify(state, null, 2));
}

function cmdStatus() {
  const { root, state } = loadStateOrFail();
  const has = f => (fs.existsSync(path.join(root, f)) ? 'yes' : 'no');
  console.log(JSON.stringify(state, null, 2));
  console.log(`progress.md: ${has('progress.md')} · lead-notes: ${has(`${DIR}/lead-notes.md`)} · task: ${has(`${DIR}/task.md`)} · BLOCKED: ${has(`${DIR}/BLOCKED.md`)}`);
}

// Skill hooks are not deduplicated: when the skill was invoked twice in a session ("resume team-up"),
// every hook runs twice, in parallel, with identical input. Exactly one twin claims the event
// (atomic exclusive create); the other does nothing.
function claimEvent(root, kind, input) {
  if (!input.transcript_path) return true; // not a real hook event (manual run): nothing to dedupe
  let size = 0;
  try { size = fs.statSync(input.transcript_path).size; } catch {}
  const id = crypto.createHash('sha1')
    .update([kind, input.session_id, size, input.last_assistant_message || '', input.source || ''].join('|'))
    .digest('hex').slice(0, 16);
  const dir = path.join(root, DIR, '.events');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.unlinkSync(p); } catch {}
    }
    fs.writeFileSync(path.join(dir, `${kind}-${id}`), now(), { flag: 'wx' });
    return true;
  } catch (e) {
    return e.code !== 'EEXIST'; // on unexpected FS errors, act rather than stay silent
  }
}

async function cmdRecall() {
  const input = await readStdin();
  const root = findRoot([process.env.CLAUDE_PROJECT_DIR, input.cwd, process.cwd()]);
  if (!root) return;
  const state = readJson(statePath(root));
  if (!state || state.status === 'done') return;
  if (!claimEvent(root, 'recall', input)) return;

  // Instructions first: Claude Code shows only a short preview if a hook prints more than 10,000 chars,
  // so the output is kept under budget and the notes are cut, never the instructions.
  const head = [
    '# team-up: context compacted. You are the TECH LEAD of this project\'s team-up loop.',
    'Your memory is on disk; trust it over your recollection. Before any other action:',
    '1. Read .team-up/lead-notes.md IN FULL (only its beginning is quoted below).',
    '2. Read progress.md and .team-up/task.md (the current step).',
    `3. Resume the loop at phase "${state.phase}" following the team-up skill (its instructions were reloaded).`,
    `State: ${JSON.stringify(state)}`,
    `Helper: node "${SCRIPT}" <command>`,
    '',
    '## Beginning of .team-up/lead-notes.md',
  ].join('\n');
  const room = HOOK_BUDGET - head.length - 80;
  let notes = readText(path.join(root, DIR, 'lead-notes.md')) || '(missing: rebuild it from progress.md, .team-up/archive/ and git log)';
  if (notes.length > room) notes = notes.slice(0, Math.max(0, room)) + '\n…(cut here; read the file for the rest)';
  console.log(`${head}\n${notes}`);
}

async function cmdStopHook() {
  const input = await readStdin();
  const root = findRoot([process.env.CLAUDE_PROJECT_DIR, input.cwd, process.cwd()]);
  if (!root) return;
  const state = readJson(statePath(root));
  if (!state || state.status !== 'running' || state.waiting) return;
  if (!claimEvent(root, 'stop', input)) return;

  const guard = readJson(guardPath(root)) || {};
  const blocks = guard.heartbeat === state.heartbeat ? (guard.blocks || 0) + 1 : 1;

  if (blocks > MAX_NUDGES) {
    state.status = 'stalled';
    state.stalled_at = now();
    writeJson(statePath(root), state);
    writeJson(guardPath(root), { heartbeat: state.heartbeat, blocks: 0 });
    out({ systemMessage: `team-up: loop stalled (${MAX_NUDGES} nudges without progress at phase "${state.phase}"). Say "resume team-up" to continue.` });
    return;
  }

  writeJson(guardPath(root), { heartbeat: state.heartbeat, blocks });
  const where = [`phase=${state.phase}`, state.step && `step=${state.step}`, state.round && `round=${state.round}`, state.pr && `pr=${state.pr}`]
    .filter(Boolean).join(', ');
  out({
    decision: 'block',
    reason: [
      `team-up loop is RUNNING (${where}) — do not stop; continue from this phase as the team-up skill describes.`,
      'If your context was compacted, re-read .team-up/state.json, .team-up/lead-notes.md, progress.md and .team-up/task.md first.',
      `Stop only legitimately: project finished → node "${SCRIPT}" set status=done ; human needed → write .team-up/BLOCKED.md then set status=blocked ;`,
      `developer running in background → set waiting=true and end your turn. (nudge ${blocks}/${MAX_NUDGES})`,
    ].join(' '),
  });
}

// ───────────────────────────── code host ─────────────────────────────
// Every host is reduced to one shape:
//   { host, id, url, state: open|merged|closed|missing, draft, sha,
//     ci: none|pending|success|failed|manual, failing|pipeline,
//     merge: yes|ci|behind|conflict|draft|blocked|unknown|merged|closed, reason }

const GH_FIELDS = 'number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid';
const GH_FAILED = ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'];

function ciFromGithub(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  const failing = [];
  let pending = 0;
  for (const c of checks) {
    const isStatus = c.__typename === 'StatusContext' || ('context' in c && !('conclusion' in c));
    if (isStatus) {
      const s = String(c.state || '').toUpperCase();
      if (s === 'PENDING' || s === 'EXPECTED') pending++;
      else if (GH_FAILED.includes(s)) failing.push({ name: c.context, url: c.targetUrl });
    } else if (String(c.status || '').toUpperCase() !== 'COMPLETED') pending++;
    else if (GH_FAILED.includes(String(c.conclusion || '').toUpperCase())) failing.push({ name: c.name, url: c.detailsUrl });
  }
  const ci = !checks.length ? 'none' : failing.length ? 'failed' : pending ? 'pending' : 'success';
  return { ci, failing };
}

function normalizeGithub(pr) {
  const { ci, failing } = ciFromGithub(pr.statusCheckRollup);
  const state = String(pr.state || '').toLowerCase();
  const mss = String(pr.mergeStateStatus || 'UNKNOWN').toUpperCase();
  let merge = 'unknown', reason = mss;
  if (state !== 'open') merge = state;
  else if (pr.isDraft || mss === 'DRAFT') merge = 'draft';
  else if (pr.mergeable === 'CONFLICTING' || mss === 'DIRTY') merge = 'conflict';
  else if (mss === 'BEHIND') merge = 'behind';
  else if (['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(mss)) merge = 'yes';
  else if (mss === 'BLOCKED') {
    if (ci === 'pending' || ci === 'failed') merge = 'ci';
    else {
      merge = 'blocked';
      reason = pr.reviewDecision ? `review decision: ${pr.reviewDecision}`
        : ci === 'none' ? 'required checks never reported (CI not triggered?) or other branch protection rules'
        : 'branch protection rules';
    }
  }
  return { host: 'github', id: pr.number, url: pr.url, state, draft: !!pr.isDraft, sha: pr.headRefOid, ci, failing, merge, reason };
}

const GL_PENDING = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'];
const GL_TRANSIENT = ['checking', 'unchecked', 'preparing', 'approvals_syncing'];

function normalizeGitlab(mr) {
  const p = mr.head_pipeline || mr.pipeline || null;
  const d = mr.detailed_merge_status || '';
  let ci = 'none';
  if (p) {
    const s = p.status;
    // Merged-results / merge-train pipelines run on a synthetic merge commit, so only branch pipelines can be
    // compared with the MR head to spot a pipeline that has not been created yet for the latest push.
    const synthetic = /^refs\/merge-requests\/\d+\/(merge|train)$/.test(p.ref || '');
    if (d === 'ci_still_running') ci = 'pending';
    else if (!synthetic && p.sha && mr.sha && p.sha !== mr.sha) ci = 'pending';
    else if (s === 'success') ci = 'success';
    else if (s === 'failed' || s === 'canceled' || s === 'canceling') ci = 'failed';
    else if (s === 'manual') ci = 'manual';
    else if (s === 'skipped') ci = 'none';
    else ci = 'pending';
  }
  const state = mr.state === 'opened' ? 'open' : mr.state === 'locked' ? 'open' : mr.state;
  const draft = !!(mr.draft || mr.work_in_progress);
  let merge, reason = d || mr.merge_status || '';
  if (state !== 'open') merge = state;
  else if (draft || d === 'draft_status') merge = 'draft';
  else if (mr.has_conflicts || d === 'conflict' || d === 'broken_status') merge = 'conflict';
  else if (d === 'need_rebase') merge = 'behind';
  else if (d === 'mergeable') merge = 'yes';
  else if (d === 'ci_still_running' || d === 'ci_must_pass') merge = 'ci';
  else if (!d) merge = mr.merge_status === 'can_be_merged' ? 'yes' : 'unknown';
  else if (GL_TRANSIENT.includes(d)) merge = 'unknown';
  else merge = 'blocked';
  return {
    host: 'gitlab', id: mr.iid, url: mr.web_url, state, draft, sha: mr.sha, ci,
    pipeline: (p && p.web_url) || null, pipeline_id: (p && p.id) || null, merge, reason,
  };
}

function fetchLocal(root, base, branch) {
  if (!git(`rev-parse --verify --quiet refs/heads/${branch}`, root)) return { host: 'local', state: 'missing', ci: 'none', merge: 'unknown', reason: 'branch not found' };
  const merged = run('git', ['merge-base', '--is-ancestor', branch, base], root).ok;
  return { host: 'local', id: branch, url: null, state: merged ? 'merged' : 'open', sha: git(`rev-parse ${branch}`, root), ci: 'none', merge: merged ? 'merged' : 'yes', reason: '' };
}

function fetchMr(ctx, branch) {
  const { host, root, base } = ctx;
  if (host === 'local') return fetchLocal(root, base, branch);
  const r = host === 'github'
    ? run('gh', ['pr', 'view', branch, '--json', GH_FIELDS], root)
    : run('glab', ['mr', 'view', branch, '-F', 'json'], root);
  if (!r.ok) {
    if (/ENOENT/.test(r.err)) {
      const cli = host === 'github' ? 'gh (winget install GitHub.cli)' : 'glab (winget install glab.glab)';
      return { host, state: 'error', error: `${cli} is not installed or not on PATH — install it, then run its "auth login"` };
    }
    const missing = /no (open )?(pull|merge) requests? (found|available)|not found|no merge request/i.test(r.err);
    return { host, state: missing ? 'missing' : 'error', error: r.err || r.out };
  }
  let data;
  try { data = JSON.parse(r.out); } catch { return { host, state: 'error', error: `unparseable ${host} output: ${r.out.slice(0, 300)}` }; }
  return host === 'github' ? normalizeGithub(data) : normalizeGitlab(data);
}

function hostContext(flags = {}) {
  const { root, state } = loadStateOrFail();
  const host = flags.host || state.host || detectHost(git('remote get-url origin', root) || '');
  if (!['github', 'gitlab', 'local'].includes(host)) fail(`unsupported host "${host}" — run init with --host github|gitlab|local`);
  return { root, state, host, base: state.base || 'main' };
}

function branchArg(pos, state) {
  const b = pos[0] || state.branch;
  if (!b) fail('no branch given and state.branch is empty');
  return b;
}

async function waitFor(ctx, branch, what, timeout, interval) {
  const start = Date.now();
  let errors = 0;
  for (;;) {
    const s = fetchMr(ctx, branch);
    const elapsed = (Date.now() - start) / 1000;
    let done;
    if (s.state === 'missing') return s;
    if (s.state === 'error') done = ++errors >= 3; // ride out a network / API hiccup
    else {
      errors = 0;
      done = what === 'merged'
        ? s.state !== 'open' || s.ci === 'failed'
        : s.state !== 'open' || (s.ci !== 'pending' && (s.ci !== 'none' || elapsed >= NO_CI_GRACE || ctx.host === 'local'));
    }
    if (done) return Object.assign(s, { waited: Math.round(elapsed) });
    if (elapsed + interval > timeout) return Object.assign(s, { waited: Math.round(elapsed), timeout: true });
    await sleep(interval * 1000);
  }
}

function cmdMr(args) {
  const { pos, flags } = parseArgs(args);
  const ctx = hostContext(flags);
  print(fetchMr(ctx, branchArg(pos, ctx.state)));
}

async function cmdWait(args) {
  const { pos, flags } = parseArgs(args);
  const ctx = hostContext(flags);
  const s = await waitFor(ctx, branchArg(pos, ctx.state), flags.for === 'merged' ? 'merged' : 'ci',
    Number(flags.timeout) || DEFAULT_WAIT, Number(flags.interval) || 20);
  print(s);
  if (s.timeout || s.state === 'error') process.exitCode = 2;
}

function cmdOpen(args) {
  const { pos, flags } = parseArgs(args);
  const ctx = hostContext(flags);
  const branch = branchArg(pos, ctx.state);
  if (ctx.host === 'local') return print({ result: 'local', message: `local mode: no PR — branch ${branch} is the deliverable` });
  if (!flags.title || !flags['body-file']) fail('open needs --title <t> --body-file <file>');
  const bodyFile = path.resolve(flags['body-file']); // the CLI runs from the repo root
  if (!fs.existsSync(bodyFile)) fail(`cannot read ${bodyFile}`);

  let s = fetchMr(ctx, branch);
  if (s.state === 'open') return print({ result: 'exists', mr: s });

  const r = ctx.host === 'github'
    ? run('gh', ['pr', 'create', '--base', ctx.base, '--head', branch, '--title', flags.title, '--body-file', bodyFile], ctx.root)
    : run('glab', ['mr', 'create', '--source-branch', branch, '--target-branch', ctx.base, '--title', flags.title,
      '--description-file', bodyFile, '--yes'], ctx.root);
  if (!r.ok) { print({ result: 'error', message: r.err || r.out }); process.exitCode = 1; return; }

  s = fetchMr(ctx, branch);
  if (s.url) {
    const st = readJson(statePath(ctx.root)) || {};
    st.pr = s.url;
    writeJson(statePath(ctx.root), st);
  }
  print({ result: 'created', mr: s, output: r.out.split('\n').slice(-3).join('\n') });
}

function cmdComment(args) {
  const { pos, flags } = parseArgs(args);
  const ctx = hostContext(flags);
  const [branch, rel] = pos.length >= 2 ? pos : [ctx.state.branch, pos[0]];
  if (!branch || !rel) fail('usage: comment [branch] <file>');
  if (ctx.host === 'local') return console.log('local mode: comment skipped');
  const file = path.resolve(rel); // the CLI runs from the repo root
  const body = readText(file);
  if (body === null) fail(`cannot read ${file}`);

  let r;
  if (ctx.host === 'github') r = run('gh', ['pr', 'comment', branch, '--body-file', file], ctx.root);
  else {
    const s = fetchMr(ctx, branch);
    if (!s.id) fail(`no merge request for ${branch}: ${s.error || s.state}`);
    r = run('glab', ['api', '-X', 'POST', `projects/:fullpath/merge_requests/${s.id}/notes`, '-f', `body=${body}`], ctx.root);
  }
  if (!r.ok) fail(`comment failed: ${r.err || r.out}`);
  console.log('comment posted');
}

// After a merge: put the working tree on the updated base branch and drop the step branch.
// Returns { synced, message }; synced=false means the tech lead must fix the working tree before planning.
function syncBase(ctx, branch) {
  const { root, base, host } = ctx;
  const steps = [];
  let synced = true;
  const step = (label, r, critical = true) => {
    if (!r.ok && critical) synced = false;
    steps.push(`${label}: ${r.ok ? 'ok' : `failed (${(r.err || '').split('\n')[0]})`}`);
  };
  step(`checkout ${base}`, run('git', ['checkout', base], root));
  if (host !== 'local') {
    step('pull', run('git', ['pull', '--ff-only', 'origin', base], root));
    run('git', ['push', 'origin', '--delete', branch], root); // may already be gone (auto-delete): fine
    run('git', ['fetch', 'origin', '--prune'], root);
  }
  if (synced) step(`delete local ${branch}`, run('git', ['branch', '-D', branch], root), false);
  return { synced, message: steps.join(' · ') };
}

function mergeLocal(ctx, branch, strategy, message) {
  const { root, base } = ctx;
  const msg = message || `Merge ${branch}`;
  if (!run('git', ['checkout', base], root).ok) return { result: 'error', message: `cannot checkout ${base} (uncommitted changes?)` };
  const r = strategy === 'squash'
    ? run('git', ['merge', '--squash', branch], root)
    : run('git', ['merge', '--no-ff', branch, '-m', msg], root);
  if (!r.ok) {
    run('git', ['merge', '--abort'], root);
    run('git', ['reset', '--merge'], root);
    return { result: 'rework', message: `merge conflicts with ${base} — developer must rebase ${branch} and resolve: ${r.err || r.out}` };
  }
  if (strategy === 'squash') {
    const c = run('git', ['commit', '-m', msg], root);
    if (!c.ok && !/nothing to commit/i.test(c.out + c.err)) return { result: 'error', message: c.err || c.out };
  }
  return { result: 'merged', ...syncBase(ctx, branch) };
}

async function cmdMerge(args) {
  const { pos, flags } = parseArgs(args);
  const ctx = hostContext(flags);
  const branch = branchArg(pos, ctx.state);
  const strategy = flags.strategy || ctx.state.merge || 'squash';
  // One overall budget, so the whole call (wait + merge + verify + sync) fits in a 10-minute Bash call.
  const deadline = Date.now() + (Number(flags.timeout) || DEFAULT_WAIT) * 1000;
  const left = () => Math.max(0, (deadline - Date.now()) / 1000);
  const finish = (result, message, mr, extra = {}) => {
    print({ result, message, ...extra, mr });
    process.exitCode = result === 'merged' ? 0 : 1;
  };
  const merged = (s, note) => {
    const sync = syncBase(ctx, branch);
    finish('merged', `${note ? `${note} · ` : ''}${sync.message}`, s, { synced: sync.synced });
  };

  if (ctx.host === 'local') {
    const r = mergeLocal(ctx, branch, strategy, flags.message);
    return finish(r.result, r.message, undefined, r.synced === undefined ? {} : { synced: r.synced });
  }

  const cli = ctx.host === 'github' ? 'gh' : 'glab';
  let s = fetchMr(ctx, branch);
  if (s.state === 'merged') return merged(s, 'already merged');
  if (s.state === 'error' || s.state === 'missing') return finish('error', s.error || 'no PR/MR for this branch', s);
  if (s.state !== 'open') return finish('human', `PR/MR is ${s.state}`, s);

  if (s.merge === 'draft') {
    const r = ctx.host === 'github' ? run('gh', ['pr', 'ready', branch], ctx.root) : run('glab', ['mr', 'update', branch, '--ready'], ctx.root);
    if (!r.ok) return finish('error', `could not mark ready: ${r.err}`, s);
    await sleep(3000);
    s = fetchMr(ctx, branch);
  }

  // Always pass through waitFor: right after a push the pipeline may not exist yet ("none" gets a grace period).
  // Keep ~80s in reserve for the merge itself, its verification and the sync.
  if (s.ci !== 'success' && s.ci !== 'failed') s = await waitFor(ctx, branch, 'ci', Math.max(5, left() - 80), 20);
  if (s.state === 'merged') return merged(s, 'merged meanwhile');
  if (s.state === 'error') return finish('error', s.error, s);
  if (s.timeout && s.ci === 'pending') return finish('wait', `CI still running after ${s.waited}s: run merge again`, s);
  if (s.ci === 'failed') return finish('rework', 'CI failed — send the failing jobs/checks to the developer', s);
  if (s.ci === 'manual' && s.merge === 'ci') return finish('human', 'pipeline is waiting on a manual job and the project requires a successful pipeline', s);

  if (s.merge === 'behind') {
    const r = ctx.host === 'github'
      ? run('gh', ['pr', 'update-branch', branch, '--rebase'], ctx.root)
      : run('glab', ['mr', 'rebase', branch], ctx.root);
    if (!r.ok && /in progress|already/i.test(r.err)) return finish('wait', 'a rebase is already in progress: run merge again', s);
    if (!r.ok) return finish('rework', `branch is behind ${ctx.base} and the server-side rebase failed, so the developer must rebase: ${r.err}`, s);
    // The rebase runs asynchronously on the server: wait until the head moves, so the next call
    // does not see "behind" again and trigger a second rebase.
    const oldSha = s.sha;
    for (let t = 0; t < Math.min(60, left() - 10) && s.sha === oldSha && s.merge === 'behind'; t += 5) {
      await sleep(5000);
      const n = fetchMr(ctx, branch);
      if (n.state !== 'error') s = n;
    }
    return finish('wait', `branch rebased onto ${ctx.base}; CI restarts, so run merge again (local branch is now behind its remote)`, s);
  }
  if (s.merge === 'conflict') return finish('rework', `conflicts with ${ctx.base} — developer must rebase and resolve`, s);
  if (s.merge === 'blocked' && ctx.host === 'gitlab' && /not_approved/.test(s.reason)) {
    run('glab', ['mr', 'approve', branch], ctx.root); // works only if author approval is allowed
    await sleep(3000);
    s = fetchMr(ctx, branch);
  }
  if (s.merge === 'blocked') return finish('human', `merge blocked by repository rules: ${s.reason}`, s);
  if (s.merge === 'ci' && s.ci !== 'success') return finish('wait', 'waiting for required checks — run merge again', s);

  // Merge exactly the head we just checked.
  const attempt = strat => {
    if (ctx.host === 'github') {
      const a = ['pr', 'merge', branch, `--${strat}`, '--match-head-commit', s.sha];
      if (flags.message) a.push('--subject', flags.message);
      return run('gh', a, ctx.root);
    }
    const a = ['mr', 'merge', branch, '--yes', '--sha', s.sha, '--auto-merge=false'];
    if (strat === 'squash') a.push('--squash');
    if (strat === 'rebase') a.push('--rebase');
    if (flags.message) a.push(strat === 'squash' ? '--squash-message' : '--message', flags.message);
    let r = run('glab', a, ctx.root);
    if (!r.ok && /auto-merge/i.test(r.err) && /unknown|flag/i.test(r.err)) r = run('glab', a.filter(x => x !== '--auto-merge=false'), ctx.root);
    return r;
  };
  let r = attempt(strategy);
  // The project may forbid the chosen strategy (e.g. squash disabled) — fall back to a merge commit.
  if (!r.ok && strategy !== 'merge' && /(squash|rebas)[^\n]*not allowed|not allowed[^\n]*(squash|rebas)|merge method/i.test(r.err)) r = attempt('merge');
  if (!r.ok) return finish('error', `${cli} merge failed: ${r.err || r.out}`, s);

  s = await waitFor(ctx, branch, 'merged', Math.max(10, Math.min(60, left())), 5);
  if (s.state !== 'merged') return finish('wait', 'merge accepted but not completed yet (auto-merge / merge train / queue): run `wait --for merged`, then merge again to sync', s);
  return merged(s);
}

// Keep only the given dot-paths of the JSON on stdin (per element for arrays), e.g.
//   glab api projects/:fullpath | teamup pick merge_method squash_option permissions.project_access.access_level
async function cmdPick(args) {
  const data = await readStdin(0);
  const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? null : v[k] === undefined ? null : v[k]), o);
  const pickOne = o => Object.fromEntries(args.map(p => [p, get(o, p)]));
  print(Array.isArray(data) ? data.map(pickOne) : pickOne(data));
}

// ───────────────────────────── main ─────────────────────────────

// The skill's hooks call main() through `node -e "require(<config dir>/skills/team-up/scripts/teamup.js).main([...])"`,
// which resolves the home directory the same way Claude Code does (no reliance on $HOME being set).
function main(argv) {
  const [cmd, ...rest] = argv;
  const commands = {
    init: () => cmdInit(rest),
    set: () => cmdSet(rest),
    status: cmdStatus,
    recall: cmdRecall,
    'stop-hook': cmdStopHook,
    open: () => cmdOpen(rest),
    mr: () => cmdMr(rest),
    wait: () => cmdWait(rest),
    comment: () => cmdComment(rest),
    merge: () => cmdMerge(rest),
    pick: () => cmdPick(rest),
  };
  if (!commands[cmd]) fail(`usage: teamup.js <${Object.keys(commands).join('|')}> ...`);
  return Promise.resolve(commands[cmd]()).catch(e => fail(e.message));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main, normalizeGithub, normalizeGitlab, ciFromGithub, parseArgs };
