import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init } from './init.js';
import { Workflow } from './workflow.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/**
 * Build a disposable workspace under $TMPDIR so `mpt-workflow demo` works for
 * someone who installed the package and has no checkout to run scripts/demo.sh.
 * Nothing outside the temp directory is touched.
 */
export function createDemoWorkspace(): { root: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpt-demo-'));
  const repo = 'demo-service';
  const abs = path.join(root, repo);
  fs.mkdirSync(path.join(abs, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(abs, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(abs, 'PLAN.md'),
    `# PLAN: ${repo}\n\n## 里程碑总览\n\n| M | 名称 | 目标 |\n|---|---|---|\n| M1 | 骨架 | 最小入口 |\n| M2 | 接口 | 暴露 /health |\n`,
  );
  fs.writeFileSync(
    path.join(abs, 'TODO-M1.md'),
    `# TODO-M1: 骨架\n\n> 状态：待实现　受验 SHA：实现完成后回填\n\n## 影响文件\n\n- **影响文件**：\n  - \`src/lib.rs\`\n\n## 验收标准\n\n- [ ] \`cargo test\` 通过\n`,
  );
  fs.writeFileSync(path.join(abs, 'src/lib.rs'), 'pub fn hello() -> &\'static str { "hi" }\n');

  try {
    git(abs, ['init', '-q']);
    git(abs, ['config', 'user.email', 'demo@example.com']);
    git(abs, ['config', 'user.name', 'demo']);
    git(abs, ['add', '-A']);
    git(abs, ['commit', '-qm', 'init']);
  } catch (e) {
    throw new Error(`demo 需要可用的 git：${(e as Error).message}`);
  }

  init({ root, program: 'mpt-workflow demo', repos: [repo], adopt: true });

  const wf = new Workflow(root);
  try {
    wf.msgs.send({
      from: { role: 'main' },
      to: { role: 'user' },
      kind: 'event',
      subject: 'M1 待实现',
      body: 'TODO-M1 已就绪。用 WF_ROLE=todo WF_REPO=demo-service 启动一个会话领取它。',
    });
  } catch {
    /* the demo stays useful even if messaging fails */
  }

  return { root, repo };
}
