import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/core/config.js';
import { listTodoFiles, parsePlan, parseTodo } from '../src/core/docs.js';
import { parseQuestionsFile, questionsFile } from '../src/core/questions.js';

test('checked-in examples parse and point at real paths', () => {
  const examples = path.resolve('examples');
  const dirs = fs
    .readdirSync(examples, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(examples, d.name));

  assert.ok(dirs.length >= 3, 'at least three examples');
  for (const root of dirs) {
    const cfg = loadConfig(root);
    assert.ok(cfg, `${path.basename(root)} has .workflow/program.yaml`);
    assert.ok((cfg?.repos.length ?? 0) > 0, `${path.basename(root)} lists a repo`);

    for (const repo of cfg!.repos) {
      const abs = path.join(root, repo.path);
      assert.ok(fs.existsSync(abs), `${repo.id}: path exists`);
      assert.ok(parsePlan(abs), `${repo.id}: PLAN.md parses`);

      for (const name of listTodoFiles(abs)) {
        assert.ok(parseTodo(path.join(abs, name)), `${repo.id}/${name} parses`);
      }

      const qf = questionsFile(abs);
      if (fs.existsSync(qf)) {
        const qs = parseQuestionsFile(qf, repo.id);
        assert.ok(
          qs.every((q) => q.id.startsWith('Q-')),
          `${repo.id}: questions parse`,
        );
      }
    }
  }
});
