import YAML from 'yaml';
import { configPath } from './config.js';
import { exists, readText, writeAtomic } from './fsutil.js';

/** Supported `program.yaml` schema version. */
export const SCHEMA_VERSION = 1;

export interface ConfigMigration {
  changes: string[];
  before: string;
  after: string;
}

/**
 * Preview the 0.x → 1.0 configuration migration. Idempotent: a current file
 * returns no changes. Comments and unknown keys are preserved.
 */
export function previewConfigMigration(root: string): ConfigMigration {
  const p = configPath(root);
  if (!exists(p)) throw new Error(`缺少 ${p}`);
  const before = readText(p);
  const doc = YAML.parseDocument(before);
  if (doc.errors.length > 0) {
    throw new Error(`program.yaml 不是合法 YAML: ${doc.errors[0].message}`);
  }
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  const raw = data.schema_version;
  const version = Number(raw ?? SCHEMA_VERSION);
  if (Number.isFinite(version) && version > SCHEMA_VERSION) {
    throw new Error(
      `program.yaml schema_version=${version} 高于当前支持（${SCHEMA_VERSION}）；请升级 mpt-workflow`,
    );
  }

  const changes: string[] = [];
  if (raw === undefined) changes.push(`添加 schema_version: ${SCHEMA_VERSION}`);
  else if (!Number.isFinite(version) || version < 1) {
    changes.push(`修正非法 schema_version=${String(raw)} → ${SCHEMA_VERSION}`);
  }
  if ('root' in data) changes.push('删除机器相关的 root 字段');

  if (changes.length === 0) return { changes, before, after: before };
  doc.set('schema_version', SCHEMA_VERSION);
  doc.delete('root');
  return { changes, before, after: doc.toString({ lineWidth: 0 }) };
}

/** Apply the preview when `apply` is true; returns what happened. */
export function migrateConfig(
  root: string,
  apply: boolean,
): ConfigMigration & { applied: boolean } {
  const preview = previewConfigMigration(root);
  const applied = apply && preview.changes.length > 0;
  if (applied) writeAtomic(configPath(root), preview.after);
  return { ...preview, applied };
}
