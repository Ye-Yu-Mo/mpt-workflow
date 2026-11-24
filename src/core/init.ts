import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  configPath,
  detectRepos,
  loadConfig,
  runtimeDir,
  saveConfig,
  workflowDir,
} from './config.js';
import { exists, ensureDir, writeAtomic, writeIfMissing, today } from './fsutil.js';
import { defaultQuestionsHeader, questionsFile } from './questions.js';
import { parsePlan, listTodoFiles, parseTodo } from './docs.js';
import type { ProgramConfig, RepoConfig } from './types.js';

export interface InitOptions {
  root: string;
  program?: string;
  repos?: string[];
  adopt?: boolean;
  installHooks?: boolean;
  phase?: string;
}

export interface InitResult {
  root: string;
  created: string[];
  existing: string[];
  repos: RepoConfig[];
  activeRepo: string | null;
  warnings: string[];
}

export function init(options: InitOptions): InitResult {
  const root = path.resolve(options.root);
  ensureDir(root);

  const created: string[] = [];
  const existing: string[] = [];
  const warnings: string[] = [];

  const wf = workflowDir(root);
  ensureDir(wf);
  ensureDir(runtimeDir(root));
  ensureDir(path.join(runtimeDir(root), 'approvals'));
  ensureDir(path.join(runtimeDir(root), 'evidence'));

  // Keep runtime state out of the umbrella's git index without touching .gitignore.
  const wfIgnore = path.join(wf, '.gitignore');
  if (writeIfMissing(wfIgnore, 'runtime/\n')) created.push(path.relative(root, wfIgnore));
  else existing.push(path.relative(root, wfIgnore));

  // Machine-specific config written by init: keep it out of git status so the
  // user's diff review stays clean. Uses .git/info/exclude (local, never committed).
  excludeFromGit(root, ['.mcp.json', '.claude/settings.json']);

  let cfg = loadConfig(root);
  if (!cfg) {
    const detected = options.repos?.length
      ? options.repos.map((id) => ({ id, path: id }))
      : detectRepos(root);
    if (detected.length === 0) {
      warnings.push('没有发现含 .git 的子目录；请用 --repo <name> 显式指定');
    }
    cfg = {
      program: options.program || path.basename(root),
      root,
      repos: detected,
      phases: [
        {
          id: options.phase || 'P1',
          title: options.phase === 'P1' || !options.phase ? '契约与基线冻结' : '程序阶段',
          status: 'active',
          repos: detected.map((r) => r.id),
          exit_criteria: [],
        },
      ],
      active_repo: null,
      contracts: [],
    };
    saveConfig(root, cfg);
    created.push(path.relative(root, configPath(root)));
  } else {
    existing.push(path.relative(root, configPath(root)));
    if (options.repos?.length) {
      for (const id of options.repos) {
        if (!cfg.repos.some((r) => r.id === id)) cfg.repos.push({ id, path: id });
      }
      saveConfig(root, cfg);
    }
  }

  // Adopt: fill in missing scaffolding, never overwrite.
  if (options.adopt !== false) {
    for (const r of cfg.repos) {
      const abs = path.join(root, r.path);
      if (!exists(abs)) {
        warnings.push(`仓库目录不存在: ${r.path}`);
        continue;
      }
      const qf = questionsFile(abs);
      if (writeIfMissing(qf, defaultQuestionsHeader())) {
        created.push(path.relative(root, qf));
      } else {
        existing.push(path.relative(root, qf));
      }
      const plan = parsePlan(abs);
      const todos = listTodoFiles(abs).map((f) => parseTodo(path.join(abs, f))).filter(Boolean);
      if (todos.some((t) => t && ['implementing', 'review', 'rejected'].includes(t.status))) {
        cfg.active_repo = r.id;
      }
      if (!plan && todos.length === 0) warnings.push(`${r.id}: 没有 PLAN.md 也没有 TODO-Mn.md`);
      // make sure the phase lists the repo
      if (!cfg.phases.some((p) => p.repos.includes(r.id))) {
        if (!cfg.phases[0]) {
          cfg.phases.push({
            id: 'P1',
            title: '程序阶段',
            status: 'active',
            repos: [],
            exit_criteria: [],
          });
        }
        cfg.phases[0].repos.push(r.id);
      }
    }
    for (const r of cfg.repos) {
      const abs = path.join(root, r.path);
      if (!exists(abs)) continue;
      excludeFromGit(abs, ['.mcp.json', '.claude/settings.json']);
    }
    if (!cfg.active_repo) cfg.active_repo = cfg.repos[0]?.id ?? null;
    saveConfig(root, cfg);
  }

  if (options.installHooks) {
    const res = installHooks(root, cfg);
    created.push(...res.created);
    existing.push(...res.existing);
    warnings.push(...res.warnings);
  }

  // Install an MCP entry where Claude Code will find it. Root + each repo,
  // because sessions are usually started inside a repo directory.
  const mcpTargets = [
    root,
    ...cfg.repos.map((r) => path.join(root, r.path)).filter((p) => exists(p)),
  ];
  for (const dir of mcpTargets) {
    const p = path.join(dir, '.mcp.json');
    let conf: { mcpServers?: Record<string, unknown> } = {};
    if (exists(p)) {
      try {
        conf = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        warnings.push(`${path.relative(root, p)} 不是合法 JSON，跳过 MCP 配置`);
        continue;
      }
      existing.push(path.relative(root, p));
    } else {
      created.push(path.relative(root, p));
    }
    conf.mcpServers = conf.mcpServers || {};
    if (!conf.mcpServers.workflow) {
      conf.mcpServers.workflow = {
        command: process.execPath,
        args: [resolveCliPath(), 'mcp', '--root', root],
      };
      writeAtomic(p, JSON.stringify(conf, null, 2) + '\n');
    }
  }

  return {
    root,
    created,
    existing,
    repos: cfg.repos,
    activeRepo: cfg.active_repo,
    warnings,
  };
}

function resolveCliPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  // dist/core/init.js -> dist/cli.js
  return path.resolve(here, '..', 'cli.js');
}

/** Append patterns to a repo's .git/info/exclude (local, never committed). */
function excludeFromGit(repoAbs: string, patterns: string[]): void {
  if (!exists(path.join(repoAbs, '.git'))) return;
  let excludePath = path.join(repoAbs, '.git', 'info', 'exclude');
  try {
    const p = execFileSync('git', ['-C', repoAbs, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
    }).trim();
    if (p) excludePath = path.isAbsolute(p) ? p : path.join(repoAbs, p);
  } catch {
    /* fall back to the default path */
  }
  ensureDir(path.dirname(excludePath));
  const current = exists(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const lines = current.split('\n');
  const missing = patterns.filter((p) => !lines.includes(p));
  if (!missing.length) return;
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  const block = `# workflow-mcp (machine-specific, not shared)\n${missing.join('\n')}\n`;
  fs.appendFileSync(excludePath, prefix + block);
}

/* ------------------------------- hooks -------------------------------- */

export const PRETOOL_HOOK = () => ({
  matcher: 'Edit|Write|NotebookEdit|Bash',
  hooks: [
    {
      type: 'command',
      command: hookCommand('pretool'),
    },
  ],
});

export const SESSION_HOOK = () => ({
  hooks: [
    {
      type: 'command',
      command: hookCommand('session-start'),
    },
  ],
});

function hookCommand(sub: string): string {
  const cli = resolveCliPath();
  // Quote both paths so spaces in the project location are safe.
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} hook ${sub}`;
}

export function installHooks(
  root: string,
  cfg: ProgramConfig,
): { created: string[]; existing: string[]; warnings: string[] } {
  const created: string[] = [];
  const existing: string[] = [];
  const warnings: string[] = [];

  const targets = [root, ...cfg.repos.map((r) => path.join(root, r.path))];
  for (const dir of targets) {
    if (!exists(dir)) continue;
    const claudeDir = path.join(dir, '.claude');
    ensureDir(claudeDir);
    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings: Record<string, unknown> = {};
    if (exists(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        warnings.push(`${path.relative(root, settingsPath)} 不是合法 JSON，跳过 hook 安装`);
        continue;
      }
      existing.push(path.relative(root, settingsPath));
    } else {
      created.push(path.relative(root, settingsPath));
    }
    const hooks = (settings.hooks || {}) as Record<string, unknown>;
    const pre = (hooks.PreToolUse || []) as unknown[];
    const session = (hooks.SessionStart || []) as unknown[];
    const hasPre = JSON.stringify(pre).includes('hook pretool');
    const hasSession = JSON.stringify(session).includes('hook session-start');
    if (!hasPre) pre.push(PRETOOL_HOOK());
    if (!hasSession) session.push(SESSION_HOOK());
    hooks.PreToolUse = pre;
    hooks.SessionStart = session;
    settings.hooks = hooks;
    writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  // git pre-commit scope check
  for (const r of cfg.repos) {
    const abs = path.join(root, r.path);
    if (!exists(path.join(abs, '.git'))) continue;
    try {
      const hooksPath = execFileSync('git', ['-C', abs, 'rev-parse', '--git-path', 'hooks'], {
        encoding: 'utf8',
      }).trim();
      const dir = path.isAbsolute(hooksPath) ? hooksPath : path.join(abs, hooksPath);
      ensureDir(dir);
      const file = path.join(dir, 'pre-commit');
      if (!writeIfMissing(file, preCommitScript())) existing.push(path.relative(root, file));
      else created.push(path.relative(root, file));
      fs.chmodSync(file, 0o755);    } catch (e) {
      warnings.push(`${r.id}: 安装 git hook 失败: ${(e as Error).message}`);
    }
  }

  return { created, existing, warnings };
}

function preCommitScript(): string {
  return `#!/usr/bin/env bash
# Installed by workflow-mcp. Scope check only; approval gating lives in the MCP commit tool.
set -euo pipefail
if [ "\${WF_ALLOW_COMMIT:-0}" = "1" ]; then exit 0; fi
${JSON.stringify(process.execPath)} ${JSON.stringify(resolveCliPath())} hook pre-commit || exit $?
exit 0
`;
}

/** Human-readable init report. */
export function formatInitResult(r: InitResult): string {
  const lines: string[] = [];
  lines.push(`程序根目录: ${r.root}`);
  lines.push(`仓库: ${r.repos.map((x) => x.id).join(', ') || '(none)'}`);
  lines.push(`active_repo: ${r.activeRepo ?? '(none)'}`);
  if (r.created.length) {
    lines.push('');
    lines.push('新建:');
    for (const f of r.created) lines.push(`  + ${f}`);
  }
  if (r.existing.length) {
    lines.push('');
    lines.push('已存在（未覆盖）:');
    for (const f of r.existing) lines.push(`  = ${f}`);
  }
  if (r.warnings.length) {
    lines.push('');
    lines.push('注意:');
    for (const w of r.warnings) lines.push(`  ! ${w}`);
  }
  lines.push('');
  lines.push('下一步:');
  lines.push(`  1. 在 Claude Code 里确认 MCP server "workflow" 已加载（.mcp.json 已写入）；`);
  lines.push(`  2. 会话开始先调用 bootstrap 声明角色，例如 bootstrap(role="plan", repo="<repo>")；`);
  lines.push(`  3. 或用环境变量固定：WF_ROLE=plan WF_REPO=<repo> claude`);
  lines.push(`  4. 看板: workflow-mcp web --root ${r.root}`);
  return lines.join('\n');
}

export function starterPlanTemplate(repo: string): string {
  return `# PLAN: ${repo} — <阶段>

> 版本：v0.1　日期：${today()}　作者：<PLAN agent>
> 所属程序阶段：<P1>
> 状态：草稿
> 事实基准：${today()}

## 0. 程序阶段与依赖

- 所属程序阶段：
- 前置依赖：
- 本仓不做：

## 1. 背景与目标

## 2. 范围与非目标

## 3. 关键约束（不可违反）

## 5. 里程碑总览

| M | 名称 | 目标 | 主要交付物 | 验收标准 | 依赖 |
|---|---|---|---|---|---|
| M1 | | | | | |

## 6. 里程碑详情

### M1 — <名称>

- **目标**：
- **交付物**：
- **验收标准（可执行）**：
  - [ ] ...
- **证据要求**：

## 8. 风险与未决问题
`;
}
