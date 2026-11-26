import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ensureDir, exists, isDir, readText, writeAtomic } from './fsutil.js';
import type { ProgramConfig, RepoConfig } from './types.js';

export const WORKFLOW_DIR = '.workflow';
export const CONFIG_FILE = 'program.yaml';
export const RUNTIME_DIR = 'runtime';
/**
 * Sentinel target for umbrella/root commits. It is never added to
 * `program.yaml.repos`, never appears in `repoRefs()`, and does not participate
 * in active_repo or milestone state.
 */
export const ROOT_REPO_ID = 'root';

/** Current `program.yaml` schema version. See docs/design-1.0-contract.md. */
export const SCHEMA_VERSION = 1;

export function workflowDir(root: string): string {
  return path.join(root, WORKFLOW_DIR);
}
export function configPath(root: string): string {
  return path.join(workflowDir(root), CONFIG_FILE);
}
export function runtimeDir(root: string): string {
  return path.join(workflowDir(root), RUNTIME_DIR);
}
export function eventsPath(root: string): string {
  return path.join(runtimeDir(root), 'events.jsonl');
}
export function approvalsDir(root: string): string {
  return path.join(runtimeDir(root), 'approvals');
}
export function evidenceDir(root: string): string {
  return path.join(runtimeDir(root), 'evidence');
}
export function locksDir(root: string): string {
  return path.join(runtimeDir(root), 'locks');
}

export function loadConfig(root: string): ProgramConfig | null {
  const p = configPath(root);
  if (!exists(p)) return null;
  try {
    const parsed = YAML.parse(readText(p)) as ProgramConfig;
    if (!parsed || typeof parsed !== 'object') return null;
    return normalizeConfig(parsed, root);
  } catch {
    return null;
  }
}

export function normalizeConfig(cfg: ProgramConfig, root: string): ProgramConfig {
  const version = Number(cfg.schema_version);
  return {
    schema_version: Number.isFinite(version) && version > 0 ? version : SCHEMA_VERSION,
    program: cfg.program || path.basename(root),
    root,
    repos: (cfg.repos || []).map((r) => ({ ...r })),
    phases: (cfg.phases || []).map((p) => ({
      ...p,
      id: p.id,
      title: p.title || p.id,
      status: p.status || 'planned',
      repos: p.repos || [],
      exit_criteria: p.exit_criteria || [],
    })),
    active_repo: cfg.active_repo ?? null,
    contracts: cfg.contracts || [],
  };
}

export function saveConfig(root: string, cfg: ProgramConfig): void {
  const version = cfg.schema_version ?? SCHEMA_VERSION;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `program.yaml schema_version=${version} 高于当前支持（${SCHEMA_VERSION}）；请升级 mpt-workflow`,
    );
  }
  ensureDir(workflowDir(root));
  const p = configPath(root);
  const data = {
    program: cfg.program,
    schema_version: version,
    active_repo: cfg.active_repo,
    repos: cfg.repos,
    phases: cfg.phases,
    contracts: cfg.contracts,
  };

  // Update only the keys that changed, so hand-written comments and unknown
  // keys survive a mutation. `root` is runtime state (the path this process
  // opened) and is deliberately not written back.
  if (exists(p)) {
    let doc: ReturnType<typeof YAML.parseDocument> | null = null;
    try {
      doc = YAML.parseDocument(readText(p));
    } catch {
      doc = null;
    }
    if (doc && doc.errors.length === 0) {
      const current = normalizeConfig((doc.toJS() ?? {}) as ProgramConfig, root);
      // The on-disk document is authoritative: a caller holding a stale cfg
      // must not downgrade a file written by a newer schema.
      if (current.schema_version && current.schema_version > SCHEMA_VERSION) {
        throw new Error(
          `program.yaml schema_version=${current.schema_version} 高于当前支持（${SCHEMA_VERSION}）；请升级 mpt-workflow`,
        );
      }
      for (const [key, value] of Object.entries(data)) {
        const before = (current as unknown as Record<string, unknown>)[key];
        if (JSON.stringify(before ?? null) !== JSON.stringify(value ?? null)) {
          doc.set(key, value);
        }
      }
      // Make the schema version explicit on the next write; a missing value
      // is otherwise indistinguishable from a legacy file.
      doc.set('schema_version', data.schema_version);
      doc.delete('root');
      writeAtomic(p, doc.toString({ lineWidth: 0 }));
      return;
    }
  }
  writeAtomic(p, YAML.stringify(data, { lineWidth: 0 }));
}

/** Find the umbrella root by walking up from `start` looking for .workflow/program.yaml. */
export function findRoot(start: string): string | null {
  let cur = path.resolve(start);
  for (;;) {
    if (exists(path.join(cur, WORKFLOW_DIR, CONFIG_FILE))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Best-effort detection of git repos directly under the root. */
export function detectRepos(root: string): RepoConfig[] {
  const out: RepoConfig[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const abs = path.join(root, entry.name);
    if (!isDir(abs)) continue;
    if (exists(path.join(abs, '.git'))) {
      out.push({ id: entry.name, path: entry.name });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
