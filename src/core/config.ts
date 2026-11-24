import path from 'node:path';
import fs from 'node:fs';
import YAML from 'yaml';
import { exists, readText, writeAtomic, ensureDir, isDir } from './fsutil.js';
import type { ProgramConfig, RepoConfig } from './types.js';

export const WORKFLOW_DIR = '.workflow';
export const CONFIG_FILE = 'program.yaml';
export const RUNTIME_DIR = 'runtime';

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
  return {
    program: cfg.program || path.basename(root),
    root,
    repos: (cfg.repos || []).map((r) => ({ ...r })),
    phases: (cfg.phases || []).map((p) => ({
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
  ensureDir(workflowDir(root));
  const data = {
    program: cfg.program,
    root: cfg.root,
    active_repo: cfg.active_repo,
    repos: cfg.repos,
    phases: cfg.phases,
    contracts: cfg.contracts,
  };
  writeAtomic(configPath(root), YAML.stringify(data, { lineWidth: 0 }));
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
