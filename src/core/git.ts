import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GitInfo } from './types.js';

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
  code: number;
}

export function git(
  repoAbs: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
): GitResult {
  try {
    const out = execFileSync('git', ['-C', repoAbs, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, out, err: '', code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      ok: false,
      out: String(err.stdout ?? ''),
      err: String(err.stderr ?? ''),
      code: typeof err.status === 'number' ? err.status : -1,
    };
  }
}

export function gitInfo(repoAbs: string): GitInfo {
  if (!fs.existsSync(path.join(repoAbs, '.git'))) {
    return {
      available: false,
      branch: '',
      head: '',
      shortHead: '',
      dirty: false,
      changed: [],
      untracked: [],
      error: 'not a git repository',
    };
  }
  // One process instead of rev-parse x2 + status: porcelain v2 includes the
  // branch oid/name and every changed/untracked path.
  const status = git(repoAbs, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
  ]);
  if (!status.ok) {
    return {
      available: false,
      branch: '',
      head: '',
      shortHead: '',
      dirty: false,
      changed: [],
      untracked: [],
      error: status.err.trim() || 'git status failed',
    };
  }
  const entries = status.out.split('\0');
  let head = '';
  let branchName = '';
  const changed: string[] = [];
  const untracked: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.startsWith('# branch.oid ')) {
      const oid = e.slice('# branch.oid '.length).trim();
      if (oid !== '(initial)') head = oid;
      continue;
    }
    if (e.startsWith('# branch.head ')) {
      branchName = e.slice('# branch.head '.length).trim();
      continue;
    }
    if (e.startsWith('? ')) {
      untracked.push(e.slice(2));
      continue;
    }
    if (e.startsWith('1 ')) {
      const m = /^1 \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(e);
      if (m?.[1]) changed.push(m[1]);
      continue;
    }
    if (e.startsWith('2 ')) {
      const m = /^2 \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(e);
      if (m?.[1]) changed.push(m[1]);
      // Rename/copy: the next NUL record is the original path.
      if (i + 1 < entries.length) i++;
      continue;
    }
    if (e.startsWith('u ')) {
      const m = /^u \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(e);
      if (m?.[1]) changed.push(m[1]);
    }
  }
  const branch = branchName === '(detached)' ? 'HEAD' : branchName;
  return {
    available: Boolean(head),
    branch,
    head,
    shortHead: head.slice(0, 8),
    dirty: changed.length + untracked.length > 0,
    changed,
    untracked,
    error: head ? undefined : 'no commits yet',
  };
}

/** Files changed relative to HEAD (staged + unstaged + untracked). */
export function allChangedFiles(repoAbs: string): string[] {
  const info = gitInfo(repoAbs);
  return [...new Set([...info.changed, ...info.untracked])].sort();
}

export function stagedFiles(repoAbs: string, env?: NodeJS.ProcessEnv): string[] {
  // --no-renames reports both the deleted old path and the added new path, so
  // the pre-commit ACL/scope check sees the source of a rename too.
  const r = git(repoAbs, ['diff', '--cached', '--name-only', '-z', '--no-renames'], { env });
  return r.out.split('\0').filter(Boolean);
}

/** Exact tree oid of the index, or '' when the index has conflicts. */
export function stagedTreeOid(repoAbs: string, env?: NodeJS.ProcessEnv): string {
  const r = git(repoAbs, ['write-tree'], { env });
  return r.ok ? r.out.trim() : '';
}

/** Index entries as path -> "mode oid", for precise stale diagnostics. */
export function stagedFileHashes(repoAbs: string, env?: NodeJS.ProcessEnv): Record<string, string> {
  const r = git(repoAbs, ['ls-files', '-s', '-z'], { env });
  const out: Record<string, string> = {};
  for (const entry of r.out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const [mode, oid] = entry.slice(0, tab).split(' ');
    out[entry.slice(tab + 1)] = `${mode} ${oid}`;
  }
  return out;
}

/** Index paths whose mode is a gitlink (nested repository). */
export function stagedGitlinkPaths(repoAbs: string, env?: NodeJS.ProcessEnv): string[] {
  return Object.entries(stagedFileHashes(repoAbs, env))
    .filter(([, value]) => value.startsWith('160000 '))
    .map(([file]) => file);
}

/** Diff of exactly what a commit would record (index vs HEAD). */
export function diffUnifiedStaged(repoAbs: string, file?: string, env?: NodeJS.ProcessEnv): string {
  const args = ['diff', '--cached', 'HEAD'];
  if (file) args.push('--', file);
  const r = git(repoAbs, args, { env });
  return r.ok ? r.out : '';
}

export function diffStatStaged(repoAbs: string, env?: NodeJS.ProcessEnv): string {
  const r = git(repoAbs, ['diff', '--cached', 'HEAD', '--stat'], { env });
  return r.ok ? r.out.trim() : '';
}

/** Reset a temp index to a base tree. */
export function readTreeToIndex(repoAbs: string, tree: string, env: NodeJS.ProcessEnv): GitResult {
  return git(repoAbs, ['read-tree', tree], { env });
}

/** Stage selected paths into an index (usually a temp index). */
export function stagePaths(repoAbs: string, paths: string[], env?: NodeJS.ProcessEnv): GitResult {
  const spec = paths.length ? paths : ['.'];
  return git(repoAbs, ['add', '-A', '--', ...spec], { env });
}

/** Gitlinks present in a tree object. */
export function treeGitlinkPaths(repoAbs: string, tree: string): string[] {
  const r = git(repoAbs, ['ls-tree', '-r', '-z', tree]);
  const out: string[] = [];
  for (const entry of r.out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const [mode] = entry.slice(0, tab).split(' ');
    if (mode === '160000') out.push(entry.slice(tab + 1));
  }
  return out;
}

export function treeExists(repoAbs: string, tree: string): boolean {
  return git(repoAbs, ['cat-file', '-e', `${tree}^{tree}`]).ok;
}

/** Sync selected paths in the real index to the new HEAD after a snapshot commit. */
export function resetPaths(repoAbs: string, paths: string[]): GitResult {
  return git(repoAbs, ['reset', '-q', 'HEAD', '--', ...paths]);
}

/** Hash of everything the user would see: tracked diff + untracked file contents. */
export function workingTreeHash(repoAbs: string): string {
  const h = crypto.createHash('sha256');
  const diff = git(repoAbs, ['diff', 'HEAD']);
  h.update('diff:\n');
  h.update(diff.ok ? diff.out : '');
  const untracked = git(repoAbs, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = untracked.out
    .split('\0')
    .filter(Boolean)
    // Workflow runtime state is written by the tool itself (approvals, logs,
    // presence). If it is not gitignored, it must not invalidate an approval.
    .filter((f) => f !== '.workflow/runtime' && !f.startsWith('.workflow/runtime/'))
    .sort();
  for (const f of files) {
    h.update(`\nuntracked:${f}\n`);
    try {
      h.update(fs.readFileSync(path.join(repoAbs, f)));
    } catch {
      h.update('<unreadable>');
    }
  }
  return h.digest('hex').slice(0, 16);
}

/** Content hash of the staged tree (base HEAD + binary diff). */
export function stagedTreeHash(repoAbs: string): string {
  const h = crypto.createHash('sha256');
  const head = git(repoAbs, ['rev-parse', 'HEAD']);
  h.update(`head:${head.out.trim()}\nstaged:\n`);
  const diff = git(repoAbs, ['diff', '--cached', '--binary']);
  h.update(diff.ok ? diff.out : '');
  return h.digest('hex').slice(0, 16);
}

/** True when the worktree differs from the index (edits not in the snapshot). */
export function hasUnstagedChanges(repoAbs: string): boolean {
  return !git(repoAbs, ['diff', '--quiet']).ok;
}

/** Tree oid of the working tree (tracked changes), or empty string when clean. */
export function workingTreeOid(repoAbs: string): string {
  const stash = git(repoAbs, ['stash', 'create', 'wf-evidence']);
  const sha = stash.out.trim();
  if (!sha) return '';
  const tree = git(repoAbs, ['rev-parse', `${sha}^{tree}`]);
  return tree.out.trim();
}

/** Paths whose old or new index mode is a gitlink (nested repository). */
export function gitlinkPaths(repoAbs: string): string[] {
  const r = git(repoAbs, ['diff', '--raw', 'HEAD']);
  if (!r.ok) return [];
  const out: string[] = [];
  for (const line of r.out.split('\n')) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*\t(.+)$/.exec(line);
    if (m && (m[1] === '160000' || m[2] === '160000')) out.push(m[3]);
  }
  return out;
}

export function stageAll(repoAbs: string): GitResult {
  return git(repoAbs, ['add', '-A']);
}

export function unstageAll(repoAbs: string): GitResult {
  return git(repoAbs, ['reset']);
}

export function commit(repoAbs: string, message: string, env?: NodeJS.ProcessEnv): GitResult {
  return git(repoAbs, ['commit', '-m', message], { env });
}

export function diffStat(repoAbs: string): string {
  const r = git(repoAbs, ['diff', 'HEAD', '--stat']);
  return r.ok ? r.out.trim() : '';
}

export function diffUnified(repoAbs: string, file?: string): string {
  const args = ['diff', 'HEAD'];
  if (file) args.push('--', file);
  const r = git(repoAbs, args);
  let out = r.ok ? r.out : '';
  // `git diff HEAD` ignores untracked files. Include them so a dashboard diff
  // (or any caller that has not staged yet) never hides new files.
  const untracked = git(repoAbs, ['ls-files', '--others', '--exclude-standard', '-z'])
    .out.split('\0')
    .filter(Boolean);
  const targets = file ? untracked.filter((f) => f === file) : untracked;
  for (const f of targets) {
    if (out && !out.endsWith('\n')) out += '\n';
    out += untrackedDiff(repoAbs, f);
  }
  return out;
}

const UNTRACKED_DIFF_MAX = 256 * 1024;

/** Render one untracked file as a new-file diff, capped for browser review. */
function untrackedDiff(repoAbs: string, file: string): string {
  let size = 0;
  try {
    size = fs.statSync(path.join(repoAbs, file)).size;
  } catch {
    return '';
  }
  if (size > UNTRACKED_DIFF_MAX) {
    return [
      `diff --git a/${file} b/${file}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${file}`,
      `@@ 未跟踪文件 ${size} 字节，超过 diff 预览上限 ${UNTRACKED_DIFF_MAX} 字节 @@`,
      '',
    ].join('\n');
  }
  // `--no-index` produces a correct new-file diff (including binary detection);
  // its exit code is 1 for a difference, so read stdout regardless of `ok`.
  return git(repoAbs, ['diff', '--no-index', '--', '/dev/null', file]).out;
}

export function recentLog(repoAbs: string, n = 5): string[] {
  const r = git(repoAbs, ['log', `-${n}`, '--oneline']);
  return r.ok ? r.out.trim().split('\n').filter(Boolean) : [];
}
