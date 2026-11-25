import path from 'node:path';
import { relTo, within } from './fsutil.js';
import { matchGlob } from './glob.js';
import type { Role } from './types.js';

export interface AclRule {
  /** `repo` = relative to a repo root; `root` = relative to the umbrella root. */
  base: 'repo' | 'root';
  glob: string;
}

export interface RoleAcl {
  allow: AclRule[];
  deny: AclRule[];
  /** May write into repos other than the bound one (docs authority). */
  crossRepo?: boolean;
}

export const ACL: Record<Role, RoleAcl> = {
  user: {
    allow: [
      { base: 'root', glob: '**' },
      { base: 'repo', glob: '**' },
    ],
    deny: [],
    crossRepo: true,
  },

  main: {
    crossRepo: true,
    allow: [
      { base: 'root', glob: '**' },
      { base: 'repo', glob: 'PLAN.md' },
      { base: 'repo', glob: 'TODO-*.md' },
      { base: 'repo', glob: 'docs/**' },
      { base: 'repo', glob: 'MS-*/**' },
    ],
    deny: [
      // main plans and reviews; it does not write source in any repo.
      { base: 'repo', glob: 'src/**' },
      { base: 'repo', glob: 'tests/**' },
      { base: 'repo', glob: 'Cargo.toml' },
      { base: 'repo', glob: 'Cargo.lock' },
      { base: 'repo', glob: 'rust-toolchain.toml' },
      { base: 'repo', glob: '.cargo/**' },
    ],
  },

  plan: {
    allow: [
      { base: 'repo', glob: 'PLAN.md' },
      { base: 'repo', glob: 'TODO-*.md' },
      { base: 'repo', glob: 'docs/**' },
      { base: 'repo', glob: 'MS-*/**' },
    ],
    deny: [
      { base: 'repo', glob: 'src/**' },
      { base: 'repo', glob: 'tests/**' },
      { base: 'repo', glob: 'Cargo.toml' },
      { base: 'repo', glob: 'Cargo.lock' },
      { base: 'repo', glob: 'rust-toolchain.toml' },
      { base: 'repo', glob: 'config/**' },
      { base: 'root', glob: '**' },
    ],
  },

  todo: {
    allow: [{ base: 'repo', glob: '**' }],
    deny: [
      { base: 'repo', glob: 'PLAN.md' },
      { base: 'repo', glob: 'TODO-*.md' },
      { base: 'root', glob: '**' },
    ],
  },
};

export interface AclDecision {
  allowed: boolean;
  reason: string;
  role: Role;
  path: string;
  scope: 'repo' | 'root' | 'outside';
  normalized: string;
  /** Repo the path belongs to, when it lives inside one. */
  ownerRepo?: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Resolve a path to (scope, normalized form). Paths inside any configured repo
 * are normalized relative to that repo, so ACL globs are repo-relative for all
 * repos — not just the bound one.
 */
export function resolveScope(
  absPath: string,
  root: string,
  repoId: string,
  repoAbs: string,
  allRepos: { id: string; abs: string }[],
): { scope: AclDecision['scope']; normalized: string; ownerRepo?: string } {
  if (within(repoAbs, absPath)) {
    return { scope: 'repo', normalized: relTo(repoAbs, absPath), ownerRepo: repoId };
  }
  for (const r of allRepos) {
    if (r.id !== repoId && within(r.abs, absPath)) {
      return { scope: 'repo', normalized: relTo(r.abs, absPath), ownerRepo: r.id };
    }
  }
  if (within(root, absPath)) {
    return { scope: 'root', normalized: relTo(root, absPath) };
  }
  return { scope: 'outside', normalized: toPosix(absPath) };
}

export function checkAcl(
  role: Role,
  absPath: string,
  root: string,
  repoId: string,
  repoAbs: string,
  allRepos: { id: string; abs: string }[] = [],
): AclDecision {
  const acl = ACL[role];
  const { scope, normalized, ownerRepo } = resolveScope(absPath, root, repoId, repoAbs, allRepos);

  const base = { role, path: absPath, scope, normalized, ownerRepo };

  if (scope === 'outside') {
    return { ...base, allowed: false, reason: `路径不在工作区内：${absPath}` };
  }

  if (ownerRepo && ownerRepo !== repoId && !acl.crossRepo) {
    return {
      ...base,
      allowed: false,
      reason: `角色 ${role} 绑定在 ${repoId}，不能写 ${ownerRepo} 的文件（${normalized}）`,
    };
  }

  if (acl.deny.some((r) => r.base === scope && matchGlob(normalized, r.glob))) {
    return {
      ...base,
      allowed: false,
      reason: `ACL 明确禁止 ${role} 写 ${normalized}`,
    };
  }

  if (acl.allow.some((r) => r.base === scope && matchGlob(normalized, r.glob))) {
    return { ...base, allowed: true, reason: `允许写 ${normalized}` };
  }

  return {
    ...base,
    allowed: false,
    reason: `ACL allow 规则不包含 ${normalized}`,
  };
}

export function describeAcl(role: Role): string {
  const acl = ACL[role];
  const fmt = (r: AclRule) => (r.base === 'repo' ? `<repo>/${r.glob}` : `<root>/${r.glob}`);
  return [
    `角色 ${role} 可写:`,
    ...acl.allow.map((r) => `  + ${fmt(r)}`),
    `禁止:`,
    ...acl.deny.map((r) => `  - ${fmt(r)}`),
  ].join('\n');
}
